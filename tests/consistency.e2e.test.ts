// End-to-end self-audit over a LIVE CockroachDB — write conflicting memories,
// then have the agent audit its OWN stored memory for the contradiction and
// recommend which value to trust, WITHOUT mutating anything. Fully offline
// (FakeEmbedder — no AWS). Gated on DATABASE_URL: skipped on a laptop without a
// DB, RUN in CI (which stands CockroachDB up, applies the schema, and sets
// DATABASE_URL before `npm test`). This proves the "agentic memory that audits
// itself at distributed-vector scale" claim against the engine that ships.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { FakeEmbedder } from "../src/memory/embeddings.js";
import { FakeNarrator } from "../src/agents/narrator.js";
import { MemoryAgent } from "../src/agents/memory-agent.js";
import { memoryCount } from "../src/memory/memory.js";
import { query, closePool } from "../src/db/client.js";

const HAS_DB = Boolean(process.env.DATABASE_URL);
const COMPANY = "Northwind Traders";

before(async () => {
  if (!HAS_DB) return;
  await query(`DELETE FROM agent_memory`);
});

after(async () => {
  // Always release the pg pool, or `node --test` never exits (CI would hang).
  await closePool();
});

test(
  "audit() flags a cross-session contradiction stored in CockroachDB and recommends a value — read-only",
  { skip: !HAS_DB },
  async () => {
    const agent = new MemoryAgent(new FakeEmbedder(), new FakeNarrator());

    // Two "sessions" store DIFFERENT totals for the same invoice record. The
    // earlier write is flagged important (0.9); the later one is a casual write.
    await agent.remember(
      "document",
      "Invoice INV-2043 for Northwind Traders totalled €18,400 (confirmed).",
      {
        company: COMPANY,
        period: "2026-05",
        sourceRef: "INV-2043",
        metadata: { record: "INV-2043", total: 18400, importance: 0.9 },
      }
    );
    await agent.remember(
      "document",
      "Invoice INV-2043 for Northwind Traders totalled €18,900 (later note).",
      {
        company: COMPANY,
        period: "2026-05",
        sourceRef: "INV-2043",
        metadata: { record: "INV-2043", total: 18900 },
      }
    );
    // A dangling reference: a reconciliation memory points at a payment record
    // no session ever stored.
    await agent.remember(
      "validation",
      "Reconciliation for INV-2043 references payment PAY-118.",
      {
        company: COMPANY,
        period: "2026-05",
        sourceRef: "RECON-2043",
        metadata: { record: "RECON-2043", refs: ["INV-2043", "PAY-118"] },
      }
    );

    const countBefore = await memoryCount(COMPANY);
    assert.equal(countBefore, 3, "three memories were written");

    // ── the self-audit ──────────────────────────────────────────────────────
    const report = await agent.audit({ company: COMPANY });

    // It examined every stored memory in scope (not a top-k recall slice).
    assert.equal(report.audited, 3);
    assert.equal(report.ok, false);

    // Contradiction on INV-2043.total is flagged, with both stored values.
    assert.equal(report.contradictions.length, 1);
    const c = report.contradictions[0]!;
    assert.equal(c.subject, "INV-2043");
    assert.equal(c.attribute, "total");
    assert.deepEqual(c.values.map((v) => v.value).sort(), [18400, 18900]);

    // The resolver recommends trusting the important (older) value via the
    // importance rule — read from metadata, no schema change.
    assert.equal(c.resolution.rule, "importance");
    assert.equal(c.resolution.recommendedValue, 18400);
    assert.ok(
      c.resolution.confidence >= 0 && c.resolution.confidence <= 1,
      "confidence in [0,1]"
    );
    assert.ok(c.resolution.rationale.length > 0);

    // The dangling reference PAY-118 is flagged absent.
    assert.deepEqual(report.absences.map((a) => a.subject), ["PAY-118"]);

    // ── READ-ONLY guarantee: the audit mutated nothing ──────────────────────
    const countAfter = await memoryCount(COMPANY);
    assert.equal(countAfter, countBefore, "audit() must not add/delete/modify any memory");
  }
);
