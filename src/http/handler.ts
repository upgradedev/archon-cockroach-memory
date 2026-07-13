// Shared recall HTTP core — the one place the "ask the memory a question" request
// is turned into a grounded, cited answer. Both the AWS Lambda Function URL adapter
// (src/lambda.ts) and the plain node:http server (src/http/server.ts, the k6 load
// target) call THIS, so the demo URL and the load test exercise the identical path
// the rest of Archon uses:
//
//   question → MemoryAgent.recallAnswer → ANN recall over the CockroachDB
//   distributed vector index → narrator (real Bedrock Claude when AWS creds are
//   present, deterministic FakeNarrator offline) → cited answer.
//
// The embedder/narrator are auto-selected by environment exactly like everywhere
// else (defaultEmbedder / defaultNarrator), so on Lambda it is real Titan + real
// Claude, and in CI (no AWS) it is the deterministic fakes — same recall path.

import { MemoryAgent } from "../agents/memory-agent.js";
import { defaultEmbedder, type Embedder } from "../memory/embeddings.js";
import { defaultNarrator, type Narrator } from "../agents/narrator.js";
import type { MemoryKind } from "../memory/memory.js";

// Money-safety / abuse guards for a PUBLIC demo URL: bound the work a single
// request can trigger (a long question => a large Bedrock bill; a huge limit =>
// a large recall). These are deliberately small.
export const MAX_QUESTION_CHARS = Number(process.env.RECALL_MAX_QUESTION_CHARS ?? 500);
export const MAX_LIMIT = 20;
const ALLOWED_KINDS = new Set<MemoryKind>(["document", "payroll_event", "validation", "insight"]);

export interface RecallRequest {
  question?: unknown;
  company?: unknown;
  kind?: unknown;
  limit?: unknown;
}

export interface RecallResponse {
  status: number;
  body: Record<string, unknown>;
}

// A tiny, reusable agent factory so both adapters share the same env auto-detection
// and callers/tests can inject fakes.
export function buildAgent(embedder: Embedder = defaultEmbedder(), narrator: Narrator = defaultNarrator()): MemoryAgent {
  return new MemoryAgent(embedder, narrator);
}

// Validate + normalize an untrusted request payload. Never throws on bad input —
// returns a 400 body instead, so the public handler can't be crashed by junk.
export function parseRecallRequest(
  raw: RecallRequest
): { ok: true; question: string; company?: string; kind?: MemoryKind; limit: number } | { ok: false; status: number; error: string } {
  const question = typeof raw.question === "string" ? raw.question.trim() : "";
  if (!question) return { ok: false, status: 400, error: "`question` (non-empty string) is required." };
  if (question.length > MAX_QUESTION_CHARS)
    return { ok: false, status: 400, error: `\`question\` exceeds ${MAX_QUESTION_CHARS} characters.` };

  const company = typeof raw.company === "string" && raw.company.length > 0 ? raw.company : undefined;

  let kind: MemoryKind | undefined;
  if (raw.kind !== undefined && raw.kind !== null && raw.kind !== "") {
    if (typeof raw.kind !== "string" || !ALLOWED_KINDS.has(raw.kind as MemoryKind))
      return { ok: false, status: 400, error: `\`kind\` must be one of ${[...ALLOWED_KINDS].join(", ")}.` };
    kind = raw.kind as MemoryKind;
  }

  let limit = 5;
  if (raw.limit !== undefined && raw.limit !== null && raw.limit !== "") {
    const n = Number(raw.limit);
    if (!Number.isFinite(n) || n < 1) return { ok: false, status: 400, error: "`limit` must be a positive number." };
    limit = Math.min(Math.floor(n), MAX_LIMIT);
  }
  return { ok: true, question, company, kind, limit };
}

// Turn a validated recall request into a grounded answer. This is the ~one call
// the whole demo is about: recall over CockroachDB + narrate. `agent` is injectable
// so tests drive it with fakes; production passes the env-selected default.
export async function handleRecall(raw: RecallRequest, agent: MemoryAgent = buildAgent()): Promise<RecallResponse> {
  const parsed = parseRecallRequest(raw);
  if (!parsed.ok) return { status: parsed.status, body: { error: parsed.error } };

  const { answer, hits, citations, modelId, consistency } = await agent.recallAnswer(parsed.question, {
    company: parsed.company,
    kind: parsed.kind,
    limit: parsed.limit,
  });

  return {
    status: 200,
    body: {
      question: parsed.question,
      answer,
      modelId, // real Bedrock Claude id in prod, "fake-narrator" offline
      recalled: hits.length,
      // Surface the cited memories (content + similarity) so a UI/test can render
      // exactly what the answer was grounded in — the RAG audit trail.
      citations: citations.map((c) => ({ marker: c.marker, kind: c.kind, score: c.score, content: c.content })),
      consistencyOk: consistency.ok,
    },
  };
}
