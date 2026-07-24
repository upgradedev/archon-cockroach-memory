// Shared recall HTTP core — the one place the "ask the memory a question" request
// is turned into a grounded, cited answer. Both the AWS API Gateway Lambda adapter
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
import { memoryCount } from "../memory/memory.js";
import {
  PUBLIC_DEMO_COMPANY,
  publicDemoScope,
} from "../config/scope.js";
import { query } from "../db/client.js";
import {
  EXPECTED_VECTOR_INDEX_NAME,
  indexDefinitionFingerprint,
  isExpectedVectorIndexDefinition,
} from "../db/proof.js";

function finiteConfiguration(
  name: string,
  fallback: number,
  min: number,
  max: number,
  integer = false
): number {
  const raw = process.env[name]?.trim();
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isInteger(value))
  ) {
    throw new Error(
      `${name} must be ${integer ? "an integer" : "a number"} between ${min} and ${max}.`
    );
  }
  return value;
}

// Money-safety / abuse guards for a PUBLIC demo URL: bound the work a single
// request can trigger (a long question => a large Bedrock bill; a huge limit =>
// a large recall). Invalid deployment configuration fails the cold start rather
// than silently weakening or disabling a guard.
export const MAX_QUESTION_CHARS = finiteConfiguration(
  "RECALL_MAX_QUESTION_CHARS",
  500,
  1,
  2_000,
  true
);
export const MAX_LIMIT = 20;
export const MAX_AUDIT_MEMORIES = 100;
export const MIN_RECALL_SCORE = finiteConfiguration(
  "RECALL_MIN_SCORE",
  0.15,
  -1,
  1
);
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

export interface AuditRequest {
  company?: unknown;
  period?: unknown;
  kind?: unknown;
  limit?: unknown;
}

// A tiny, reusable agent factory so both adapters share the same env auto-detection
// and callers/tests can inject fakes.
export function buildAgent(embedder: Embedder = defaultEmbedder(), narrator: Narrator = defaultNarrator()): MemoryAgent {
  return new MemoryAgent(embedder, narrator);
}

// Validate + normalize an untrusted request payload. Never throws on bad input —
// returns a 400 body instead, so the public handler can't be crashed by junk.
export function parseRecallRequest(
  raw: unknown
): { ok: true; question: string; company: string; kind?: MemoryKind; limit: number } | { ok: false; status: number; error: string } {
  const request =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as RecallRequest)
      : {};
  const question =
    typeof request.question === "string" ? request.question.trim() : "";
  if (!question) return { ok: false, status: 400, error: "`question` (non-empty string) is required." };
  if (question.length > MAX_QUESTION_CHARS)
    return { ok: false, status: 400, error: `\`question\` exceeds ${MAX_QUESTION_CHARS} characters.` };

  if (
    request.company !== undefined &&
    request.company !== null &&
    request.company !== "" &&
    (typeof request.company !== "string" ||
      request.company.trim() !== PUBLIC_DEMO_COMPANY)
  ) {
    return {
      ok: false,
      status: 400,
      error: `Public demo scope is fixed to ${PUBLIC_DEMO_COMPANY}; \`company\` is not caller-selectable.`,
    };
  }

  let kind: MemoryKind | undefined;
  if (request.kind !== undefined && request.kind !== null && request.kind !== "") {
    if (typeof request.kind !== "string" || !ALLOWED_KINDS.has(request.kind as MemoryKind))
      return { ok: false, status: 400, error: `\`kind\` must be one of ${[...ALLOWED_KINDS].join(", ")}.` };
    kind = request.kind as MemoryKind;
  }

  let limit = 5;
  if (request.limit !== undefined && request.limit !== null && request.limit !== "") {
    if (
      typeof request.limit !== "number" ||
      !Number.isInteger(request.limit) ||
      request.limit < 1
    ) {
      return {
        ok: false,
        status: 400,
        error: "`limit` must be a positive integer.",
      };
    }
    limit = Math.min(request.limit, MAX_LIMIT);
  }
  return {
    ok: true,
    question,
    company: PUBLIC_DEMO_COMPANY,
    kind,
    limit,
  };
}

// Turn a validated recall request into a grounded answer. This is the ~one call
// the whole demo is about: recall over CockroachDB + narrate. `agent` is injectable
// so tests drive it with fakes; production passes the env-selected default.
export async function handleRecall(raw: unknown, agent: MemoryAgent = buildAgent()): Promise<RecallResponse> {
  const parsed = parseRecallRequest(raw);
  if (!parsed.ok) return { status: parsed.status, body: { error: parsed.error } };

  const {
    answer,
    hits,
    citations,
    modelId,
    grounding,
    consistency,
  } = await agent.recallAnswer(parsed.question, {
    company: parsed.company,
    kind: parsed.kind,
    limit: parsed.limit,
    minScore: MIN_RECALL_SCORE,
  });

  return {
    status: 200,
    body: {
      question: parsed.question,
      answer,
      modelId, // real Bedrock Claude id in prod, "fake-narrator" offline
      grounding,
      recalled: hits.length,
      // Surface the cited memories (content + similarity) so a UI/test can render
      // exactly what the answer was grounded in — the RAG audit trail.
      citations: citations.map((c) => ({
        marker: c.marker,
        memoryId: c.memoryId,
        kind: c.kind,
        company: c.company,
        period: c.period,
        sourceRef: c.sourceRef,
        score: c.score,
        content: c.content,
      })),
      consistencyOk: consistency.ok,
      consistency,
      trace: {
        scope: publicDemoScope(),
        retrieval: {
          database: "CockroachDB",
          index: "native C-SPANN vector index",
          metric: "cosine",
          embeddingModel: agent.embeddingModelId,
          requestedTopK: parsed.limit,
          recalled: hits.length,
          minScore: MIN_RECALL_SCORE,
        },
        narration: {
          model: modelId,
          grounding,
        },
      },
    },
  };
}

export function handleHealth(): RecallResponse {
  return {
    status: 200,
    body: {
      ok: true,
      status: "reachable",
      service: "archon-cockroach-memory",
      access: "public-read-only",
      dependencies: "unchecked",
      scope: publicDemoScope(),
    },
  };
}

export async function handleAudit(
  raw: AuditRequest = {},
  agent: MemoryAgent = buildAgent()
): Promise<RecallResponse> {
  const parsed = parseAuditRequest(raw);
  if (!parsed.ok) {
    return { status: parsed.status, body: { error: parsed.error } };
  }
  const auditScope = {
    company: PUBLIC_DEMO_COMPANY,
    period: parsed.period,
    kind: parsed.kind,
    limit: parsed.limit,
  };
  const { report, memories, coverage } =
    await agent.auditSnapshot(auditScope);
  return {
    status: 200,
    body: {
      report,
      memories,
      coverage,
      generatedAt: new Date().toISOString(),
      scope: publicDemoScope(),
    },
  };
}

export async function handleProof(
  agent: MemoryAgent = buildAgent()
): Promise<RecallResponse> {
  const [activeMemories, databaseRows, indexRows] = await Promise.all([
    memoryCount(PUBLIC_DEMO_COMPANY, agent.embeddingModelId),
    query<{
      version: string;
      database_name: string;
      database_user: string;
    }>(
      `SELECT version() AS version,
              current_database() AS database_name,
              current_user AS database_user`
    ),
    query<{ index_name: string; index_definition: string }>(
      `SELECT DISTINCT indexname AS index_name,
                       indexdef AS index_definition
         FROM pg_catalog.pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'agent_memory'
          AND indexname = $1`,
      [EXPECTED_VECTOR_INDEX_NAME]
    ),
  ]);
  const database = databaseRows[0];
  const index = indexRows.find(
    (row) =>
      row.index_name === EXPECTED_VECTOR_INDEX_NAME &&
      isExpectedVectorIndexDefinition(row.index_definition)
  );
  const verifiedIndex = Boolean(index);
  const cockroachRegion = process.env.COCKROACH_REGION?.trim() || null;
  const regionEvidence =
    cockroachRegion &&
    process.env.COCKROACH_REGION_EVIDENCE ===
      "cockroach-cloud-api-release-gate"
      ? "cockroach-cloud-api-release-gate"
      : "not-verified";
  return {
    status: 200,
    body: {
      database: {
        engine: "CockroachDB",
        deployment: "CockroachDB Cloud on AWS",
        role: "persistent agent memory",
        transactionIsolation: "SERIALIZABLE",
        version: database?.version ?? null,
        database: database?.database_name ?? null,
        runtimePrincipal: database?.database_user ?? null,
        region: cockroachRegion,
        regionEvidence,
        activeMemories,
      },
      vectorIndex: {
        engine: "native CockroachDB C-SPANN",
        enabled: verifiedIndex,
        name: verifiedIndex ? EXPECTED_VECTOR_INDEX_NAME : null,
        metric: "cosine",
        dimensions: agent.embeddingDimension,
        prefixes: ["tenant_id", "embed_model", "status", "company"],
        lifecycleState: verifiedIndex ? "active" : "not-verified",
        evidence: "live pg_catalog.pg_indexes definition",
        definitionFingerprint: index
          ? indexDefinitionFingerprint(index.index_definition)
          : null,
      },
      embeddingModel: agent.embeddingModelId,
      narrationModel: agent.narrationModelId,
      scope: publicDemoScope(),
      features: [
        "role-bound fixed synthetic scope",
        "CockroachDB row-level security",
        "idempotent memory writes",
        "embedding-model isolation",
        "contradiction and absence audit",
        "citation and numeric grounding guard",
        "read-only public API",
      ],
      generatedAt: new Date().toISOString(),
    },
  };
}

function parseAuditRequest(
  raw: AuditRequest
):
  | {
      ok: true;
      period?: string;
      kind?: MemoryKind;
      limit: number;
    }
  | { ok: false; status: number; error: string } {
  if (
    raw.company !== undefined &&
    raw.company !== null &&
    raw.company !== "" &&
    (typeof raw.company !== "string" ||
      raw.company.trim() !== PUBLIC_DEMO_COMPANY)
  ) {
    return {
      ok: false,
      status: 400,
      error: `Public demo scope is fixed to ${PUBLIC_DEMO_COMPANY}; \`company\` is not caller-selectable.`,
    };
  }

  let period: string | undefined;
  if (raw.period !== undefined && raw.period !== null && raw.period !== "") {
    if (typeof raw.period !== "string" || raw.period.length > 32) {
      return {
        ok: false,
        status: 400,
        error: "`period` must be a string of at most 32 characters.",
      };
    }
    period = raw.period;
  }

  let kind: MemoryKind | undefined;
  if (raw.kind !== undefined && raw.kind !== null && raw.kind !== "") {
    if (
      typeof raw.kind !== "string" ||
      !ALLOWED_KINDS.has(raw.kind as MemoryKind)
    ) {
      return {
        ok: false,
        status: 400,
        error: `\`kind\` must be one of ${[...ALLOWED_KINDS].join(", ")}.`,
      };
    }
    kind = raw.kind as MemoryKind;
  }

  let limit = MAX_AUDIT_MEMORIES;
  if (raw.limit !== undefined && raw.limit !== null && raw.limit !== "") {
    const requested =
      typeof raw.limit === "number"
        ? raw.limit
        : typeof raw.limit === "string" && /^[1-9]\d*$/u.test(raw.limit)
          ? Number(raw.limit)
          : Number.NaN;
    if (!Number.isSafeInteger(requested) || requested < 1) {
      return {
        ok: false,
        status: 400,
        error: "`limit` must be a positive integer.",
      };
    }
    limit = Math.min(requested, MAX_AUDIT_MEMORIES);
  }
  return { ok: true, period, kind, limit };
}
