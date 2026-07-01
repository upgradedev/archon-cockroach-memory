// Bedrock narrator — the RAG answer over recalled CockroachDB memories.
//
// Given a recall query and the top-k memories recalled from the distributed
// vector index, the narrator writes a CFO-level answer that is GROUNDED in and
// CITES those memories. This is the "R" (retrieve) → "AG" (augmented generation)
// seam of the agentic memory loop: recall pulls the evidence, the narrator turns
// it into a trustworthy, sourced answer.
//
// Two implementations behind one `Narrator` interface, mirroring the Embedder
// pattern in ../memory/embeddings.ts:
//   BedrockNarrator — real RAG via Claude Sonnet on AWS Bedrock (Converse).
//   FakeNarrator    — deterministic, dependency-free, no AWS. Composes a cited
//                     answer straight from the hits so the recall→narrate path
//                     runs offline in CI and local dev.
// `defaultNarrator()` auto-selects Bedrock when AWS creds are present, the fake
// otherwise — same auto-detection as `defaultEmbedder()`.

import { converse, createBedrockClient, DEFAULT_MODEL_ID, type ConverseClientLike } from "../extraction/bedrock.js";
import type { RecallHit } from "../memory/memory.js";

// A single grounding source surfaced to the caller alongside the answer, so a UI
// (or a test) can render/verify the exact memories the answer was built from.
export interface Citation {
  marker: string; // "[1]", "[2]", … — appears verbatim in the answer text
  kind: RecallHit["kind"];
  score: number; // similarity (1 - cosine distance)
  sourceRef: string | null;
  content: string;
}

export interface NarratedAnswer {
  answer: string; // grounded prose citing [n] markers
  citations: Citation[]; // the memories the answer is grounded in
  modelId: string; // which narrator produced it (real model id or the fake tag)
}

export interface Narrator {
  readonly modelId: string;
  narrate(question: string, hits: RecallHit[]): Promise<NarratedAnswer>;
}

const NO_MEMORY = "No relevant memories found in the agent's CockroachDB memory.";

// Render the recalled memories as a numbered context block the model (or the
// fake) cites by [n]. Kept identical across both narrators so citations line up.
function toCitations(hits: RecallHit[]): Citation[] {
  return hits.map((h, i) => ({
    marker: `[${i + 1}]`,
    kind: h.kind,
    score: h.score,
    sourceRef: h.sourceRef,
    content: h.content,
  }));
}

function contextBlock(citations: Citation[]): string {
  return citations
    .map((c) => `${c.marker} (${c.kind}, similarity ${c.score.toFixed(3)}) ${c.content}`)
    .join("\n");
}

const SYSTEM_PROMPT =
  "You are Archon, a CFO-level financial analyst with a persistent memory of a " +
  "small business's fused financial events. Answer the user's question using ONLY " +
  "the numbered MEMORY items provided. Ground every claim in that memory and cite " +
  "the item(s) you used with their bracketed markers, e.g. [1] or [2]. Quote the " +
  "exact euro figures from the memory. If the memory does not contain the answer, " +
  "say so plainly. Be concise (2-4 sentences), in plain English, no bullet lists. " +
  "Highlight the hidden employer-cost wedge (the gap between the bank salary " +
  "transfer and the true employer cost) whenever the memory reveals it.";

// Real RAG narrator: retrieved memories → Claude Sonnet on Bedrock → cited answer.
// Reuses the injectable Converse wrapper (same client, same model default the H0
// Archon AWS build uses), so it stays entirely on AWS and is unit-testable with a
// canned client.
export class BedrockNarrator implements Narrator {
  readonly modelId: string;
  constructor(
    private client: ConverseClientLike = createBedrockClient(),
    modelId: string = DEFAULT_MODEL_ID
  ) {
    this.modelId = modelId;
  }

  async narrate(question: string, hits: RecallHit[]): Promise<NarratedAnswer> {
    const citations = toCitations(hits);
    // No evidence → answer deterministically without spending a model call.
    if (citations.length === 0) {
      return { answer: NO_MEMORY, citations, modelId: this.modelId };
    }
    const userText =
      `MEMORY (recalled from CockroachDB by semantic similarity):\n` +
      `${contextBlock(citations)}\n\n` +
      `QUESTION: ${question}\n\n` +
      `Write the grounded, cited answer now.`;
    const result = await converse(this.client, {
      system: SYSTEM_PROMPT,
      parts: [{ type: "text", text: userText }],
      modelId: this.modelId,
      maxTokens: 512,
      temperature: 0.2,
    });
    const answer = result.text.trim() || NO_MEMORY;
    return { answer, citations, modelId: result.modelId };
  }
}

// Deterministic offline narrator — no AWS. Composes a grounded, cited answer
// directly from the recalled memories so the full recall→narrate path executes
// in CI and local dev with FakeEmbedder. Intentionally domain-agnostic: it
// summarizes and cites whatever memories recall returned, rather than
// pattern-matching the question (which would be brittle and untestable).
export class FakeNarrator implements Narrator {
  readonly modelId = "fake-narrator";

  async narrate(question: string, hits: RecallHit[]): Promise<NarratedAnswer> {
    const citations = toCitations(hits);
    if (citations.length === 0) {
      return { answer: NO_MEMORY, citations, modelId: this.modelId };
    }
    const grounded = citations
      .map((c) => `${c.marker} ${c.content}`)
      .join(" ");
    const answer =
      `Based on ${citations.length} recalled memory item(s), grounded in the ` +
      `agent's CockroachDB memory: ${grounded} ` +
      `(In answer to: "${question}".)`;
    return { answer, citations, modelId: this.modelId };
  }
}

// Pick the narrator by environment: real Bedrock Claude when AWS creds are
// present, the deterministic fake otherwise. Same contract either way; callers
// can always inject their own.
export function defaultNarrator(): Narrator {
  const hasAws =
    Boolean(process.env.AWS_ACCESS_KEY_ID) || Boolean(process.env.AWS_PROFILE);
  return hasAws ? new BedrockNarrator() : new FakeNarrator();
}
