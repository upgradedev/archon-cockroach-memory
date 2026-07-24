// Real AWS Bedrock integration test — the ONLY test that spends money and hits
// the network. It exercises the exact production classes the app auto-selects
// when AWS creds are present: the Titan V2 embedder (src/memory/embeddings.ts)
// and the Claude-Sonnet RAG narrator (src/agents/narrator.ts) over Bedrock's
// Converse API (src/extraction/bedrock.ts).
//
// GATING — mirrors the DATABASE_URL-gated pattern in tests/integration.test.ts:
// it runs ONLY when RUN_BEDROCK_IT is set (opt-in), and SKIPS cleanly otherwise.
// CI has no creds and does not set the flag, so it is reported skipped, never
// failed — the pipeline stays green offline. Run it locally with real creds via:
//
//   RUN_BEDROCK_IT=1 AWS_PROFILE=default BEDROCK_REGION=eu-west-1 \
//     node --import tsx --test tests/bedrock.integration.test.ts
//
// Money-safe: one Titan embed plus one short Converse turn; a second Converse
// turn is allowed only when the deterministic grounding guard requests repair.
// Verified-good evidence (models, region, real response) is in docs/BEDROCK_SMOKE.md.

import { test } from "node:test";
import assert from "node:assert/strict";
import { BedrockEmbedder, EMBED_DIM } from "../src/memory/embeddings.js";
import { BedrockNarrator } from "../src/agents/narrator.js";
import type { RecallHit } from "../src/memory/memory.js";

const RUN = Boolean(process.env.RUN_BEDROCK_IT);

// Two synthetic recalled memories — the RAG evidence the narrator must ground in.
const HITS: RecallHit[] = [
  {
    id: "m1",
    kind: "payroll_event",
    company: "Acme Foods",
    period: "2026-03",
    sourceRef: "evt-acme-2026-03",
    content:
      "Payroll for Acme Foods in 2026-03: 3 employees, true employer cost EUR 63,800, " +
      "net paid from bank EUR 41,000.",
    metadata: null,
    createdAt: "2026-03-31T00:00:00Z",
    distance: 0.1,
    score: 0.9,
  },
  {
    id: "m2",
    kind: "insight",
    company: "Acme Foods",
    period: "2026-03",
    sourceRef: "evt-acme-2026-03",
    content:
      "The bank salary transfer of EUR 41,000 understates the true employer cost by EUR 22,800.",
    metadata: null,
    createdAt: "2026-03-31T00:00:00Z",
    distance: 0.2,
    score: 0.8,
  },
];

test(
  "REAL Bedrock: Titan V2 returns a unit-length embedding of the expected dimensionality",
  { skip: RUN ? false : "set RUN_BEDROCK_IT=1 (with AWS creds) to run the real Bedrock integration test" },
  async () => {
    const embedder = new BedrockEmbedder();
    assert.equal(embedder.modelId, "amazon.titan-embed-text-v2:0");
    const vec = await embedder.embed(
      "What was our true employer payroll cost in March 2026?"
    );
    // Real Titan output must match the VECTOR(1024) memory column.
    assert.equal(vec.length, EMBED_DIM, `expected ${EMBED_DIM} dims`);
    assert.ok(
      vec.every((x) => typeof x === "number" && Number.isFinite(x)),
      "every component must be a finite number"
    );
    // normalize:true was requested — the vector must be (numerically) unit length.
    const l2 = Math.sqrt(vec.reduce((s, x) => s + x * x, 0));
    assert.ok(Math.abs(l2 - 1) < 1e-3, `expected unit L2 norm, got ${l2}`);
    // A real embedding is not the all-zeros/degenerate vector the fake could not produce.
    assert.ok(vec.some((x) => x !== 0), "embedding must be non-degenerate");
  }
);

test(
  "REAL Bedrock: Claude Sonnet Converse writes a non-empty answer grounded in the recalled memories",
  { skip: RUN ? false : "set RUN_BEDROCK_IT=1 (with AWS creds) to run the real Bedrock integration test" },
  async () => {
    const narrator = new BedrockNarrator();
    const { answer, citations, modelId, grounding } = await narrator.narrate(
      "What was our real employer payroll cost last month, and how much of it was off the bank transfer?",
      HITS
    );
    // Answer came from the real Claude Sonnet model, not the fake narrator.
    assert.notEqual(modelId, "fake-narrator");
    assert.match(modelId, /anthropic|claude/i, `unexpected model id ${modelId}`);
    assert.equal(
      grounding.status,
      "verified",
      `golden judge question must pass all grounding checks: ${JSON.stringify(grounding)}`
    );
    // Non-empty, substantive grounded answer.
    assert.ok(answer.length > 40, "answer must be a substantive non-empty string");
    assert.ok(!/No relevant memories/i.test(answer), "must not be the empty-recall fallback");
    // Grounded in the supplied evidence: both memories surfaced as citations, and
    // the load-bearing euro figure from the memory appears in the generated prose.
    assert.equal(citations.length, 2);
    assert.ok(
      answer.includes("63,800") || answer.includes("63800"),
      "answer must quote the true employer cost from the recalled memory"
    );
  }
);
