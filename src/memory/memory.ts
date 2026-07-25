// Agent memory — the heart of the entry.
//
// This module turns CockroachDB into the agents' persistent, semantic memory:
//   remember() : embed a natural-language fact and durably store it + metadata
//   recall()   : ANN vector search (cosine) over the distributed VECTOR index
//
// Every durable thing an Archon agent learns (an extracted document, a fused
// payroll event, a validation finding, a narrated insight) becomes a memory.
// On the next run — even a different upload, a different session — agents recall
// the relevant prior facts by MEANING and reason with continuity instead of
// starting cold. That is "CockroachDB as the agents' memory layer".

import { createHash } from "node:crypto";
import {
  PUBLIC_DEMO_COMPANY,
  PUBLIC_DEMO_TENANT_ID,
} from "../config/scope.js";
import { query, toVectorLiteral } from "../db/client.js";
import {
  EXPECTED_KIND_VECTOR_INDEX_NAME,
  EXPECTED_VECTOR_INDEX_NAME,
  PUBLIC_KIND_RECALL_VIEW_NAME,
  PUBLIC_RECALL_VIEW_NAME,
} from "../db/proof.js";
import type { Embedder } from "./embeddings.js";
import type { AuditMemory } from "./consistency.js";

export type MemoryKind = "document" | "payroll_event" | "validation" | "insight";

export interface MemoryInput {
  kind: MemoryKind;
  company?: string; // defaults to '_global'
  period?: string | null;
  sourceRef?: string | null; // originating row id
  content: string; // the recallable natural-language fact
  metadata?: Record<string, unknown> | null;
  // An upstream event/request key. If omitted, a deterministic key is derived
  // from the immutable memory payload, making retries safe by default.
  idempotencyKey?: string;
}

export interface MemoryRecord {
  id: string;
  kind: MemoryKind;
  company: string;
  period: string | null;
  sourceRef: string | null;
  content: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface RecallHit extends MemoryRecord {
  distance: number; // cosine distance (0 = identical direction, 2 = opposite)
  score: number; // 1 - distance, convenience similarity
}

export interface RecallOptions {
  kind?: MemoryKind;
  company?: string;
  limit?: number; // top-k, default 5
}

export interface RecallQuery {
  text: string;
  params: unknown[];
  relation: string;
  expectedIndexName: string | null;
  fixedPublicScope: boolean;
  servingPath:
    | "public-no-kind-cspann"
    | "public-kind-cspann"
    | "internal-cspann"
    | "bounded-scan";
}

export interface RecallQueryRow {
  id: string;
  tenant_id: string;
  kind: MemoryKind;
  company: string;
  period: string | null;
  source_ref: string | null;
  content: string;
  metadata: Record<string, unknown> | null;
  embed_model: string;
  idempotency_key: string | null;
  status: string;
  created_at: string | Date;
  distance: string;
}

// ── write ────────────────────────────────────────────────────────────────────
// Embed `content` and persist the memory. Sequential and concurrent retries with
// the same immutable payload return the existing id and do not create duplicate
// evidence. A preflight lookup also avoids paying for a second Bedrock embedding
// on the common retry path.
export async function remember(embedder: Embedder, input: MemoryInput): Promise<string> {
  const company = input.company ?? "_global";
  const period = input.period ?? null;
  const sourceRef = input.sourceRef ?? null;
  const metadataJson =
    input.metadata == null ? null : canonicalJson(input.metadata);
  const contentHash = sha256(
    canonicalJson({
      tenantId: PUBLIC_DEMO_TENANT_ID,
      kind: input.kind,
      company,
      period,
      sourceRef,
      content: input.content,
      metadata: input.metadata ?? null,
    })
  );
  const idempotencyKey =
    input.idempotencyKey?.trim() || `sha256:${contentHash}`;
  if (idempotencyKey.length > 256) {
    throw new Error("idempotencyKey must be at most 256 characters.");
  }

  const existing = await findIdempotentMemory(
    embedder.modelId,
    idempotencyKey
  );
  if (existing) {
    assertIdempotencyMatch(existing, contentHash);
    return existing.id;
  }

  const embedding = await embedder.embed(input.content);
  assertEmbedding(embedding, embedder.dim);
  const rows = await query<{ id: string }>(
    `INSERT INTO agent_memory
       (tenant_id, kind, company, period, source_ref, content, metadata,
        embedding, embed_model, idempotency_key, content_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::VECTOR, $9, $10, $11)
     ON CONFLICT (tenant_id, embed_model, idempotency_key) DO NOTHING
     RETURNING id`,
    [
      PUBLIC_DEMO_TENANT_ID,
      input.kind,
      company,
      period,
      sourceRef,
      input.content,
      metadataJson,
      toVectorLiteral(embedding),
      embedder.modelId,
      idempotencyKey,
      contentHash,
    ]
  );
  if (rows[0]) return rows[0].id;

  // A concurrent writer won the unique-key race. Read and verify its immutable
  // payload before returning the shared id.
  const winner = await findIdempotentMemory(
    embedder.modelId,
    idempotencyKey
  );
  if (!winner) {
    throw new Error("Idempotent memory insert conflicted but no row was found.");
  }
  assertIdempotencyMatch(winner, contentHash);
  return winner.id;
}

// ── read ─────────────────────────────────────────────────────────────────────
// Recall the top-k memories most semantically similar to `queryText`, optionally
// pre-filtered by kind/company. The public production shape equality-constrains
// tenant/model/status/company and is served by the matching prefix C-SPANN index.
// Benchmark-only unscoped recall is served by the separate global vector index.
export async function recall(
  embedder: Embedder,
  queryText: string,
  opts: RecallOptions = {}
): Promise<RecallHit[]> {
  const queryEmbedding = await embedder.embed(queryText);
  assertEmbedding(queryEmbedding, embedder.dim);
  const qvec = toVectorLiteral(queryEmbedding);
  const statement = buildRecallQuery(qvec, embedder.modelId, opts);

  const rows = await query<RecallQueryRow>(
    statement.text,
    statement.params
  );

  return rows.map((r) => {
    const distance = Number(r.distance);
    return {
      id: r.id,
      kind: r.kind,
      company: r.company,
      period: r.period,
      sourceRef: r.source_ref,
      content: r.content,
      metadata: r.metadata,
      // pg returns a TIMESTAMP column as a Date; normalize to an ISO string so
      // downstream consumers (the consistency resolver's date arithmetic /
      // createdAt.slice) get the string they expect — mirrors listForAudit.
      createdAt:
        r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      distance,
      score: 1 - distance,
    };
  });
}

// One production query constructor is shared by the application and the
// database-release verifier. The fixed public serving views are intentionally
// selected only for the immutable challenge scope; development/benchmark
// companies retain the ordinary table path.
export function buildRecallQuery(
  qvec: string,
  embedModel: string,
  opts: RecallOptions = {}
): RecallQuery {
  const canonicalPublicDeployment =
    PUBLIC_DEMO_TENANT_ID === "public-demo" &&
    PUBLIC_DEMO_COMPANY === "Helios SA";
  const fixedPublicScope =
    canonicalPublicDeployment &&
    (opts.company === undefined || opts.company === "Helios SA");
  const company = fixedPublicScope ? "Helios SA" : opts.company;
  // All vector-index prefix columns are equality constrained. tenant_id is
  // process configuration (never request input), embed_model prevents vectors
  // from incompatible model spaces being compared, and superseded/retracted
  // evidence is excluded from current-state recall.
  const filters: string[] = [
    "tenant_id = $2",
    "embed_model = $3",
    "status = $4",
  ];
  const params: unknown[] = [
    qvec,
    PUBLIC_DEMO_TENANT_ID,
    embedModel,
    "active",
  ];
  if (opts.kind) {
    params.push(opts.kind);
    filters.push(`kind = $${params.length}`);
  }
  if (company) {
    params.push(company);
    filters.push(`company = $${params.length}`);
  }
  const where = `WHERE ${filters.join(" AND ")}`;
  let relation: string;
  let expectedIndexName: string | null;
  let servingPath: RecallQuery["servingPath"];
  if (fixedPublicScope) {
    relation = opts.kind
      ? PUBLIC_KIND_RECALL_VIEW_NAME
      : PUBLIC_RECALL_VIEW_NAME;
    expectedIndexName = opts.kind
      ? EXPECTED_KIND_VECTOR_INDEX_NAME
      : EXPECTED_VECTOR_INDEX_NAME;
    servingPath = opts.kind
      ? "public-kind-cspann"
      : "public-no-kind-cspann";
  } else if (canonicalPublicDeployment || opts.kind) {
    // A canonical public runtime never forces a base-table vector index below
    // FORCE RLS. Wrong-company internal calls fail closed as an empty bounded
    // scan; non-production kind filters likewise avoid an ineligible hint.
    relation = "agent_memory";
    expectedIndexName = null;
    servingPath = "bounded-scan";
  } else {
    expectedIndexName = company
      ? EXPECTED_VECTOR_INDEX_NAME
      : "idx_agent_memory_scope_embedding";
    relation = `agent_memory@${expectedIndexName}`;
    servingPath = "internal-cspann";
  }
  const requestedLimit =
    opts.limit !== undefined && Number.isFinite(opts.limit)
      ? Math.trunc(opts.limit)
      : 5;
  const limit = Math.max(1, Math.min(requestedLimit, 50));

  return {
    text:
      `SELECT id, tenant_id, kind, company, period, source_ref, content, ` +
      `metadata, embed_model, idempotency_key, status, created_at,
            (embedding <=> $1::VECTOR) AS distance
       FROM ${relation}
       ${where}
     ORDER BY embedding <=> $1::VECTOR
     LIMIT ${limit}`,
    params,
    relation,
    expectedIndexName,
    fixedPublicScope,
    servingPath,
  };
}

// ── self-audit (consistency) read ─────────────────────────────────────────────
// Read-only projection of the stored memories a consistency audit needs, scoped
// by company / period / kind. This is a bounded plain SELECT — no vector search.
// `auditMemoryCount` applies the identical filters so callers can prove whether
// the scan was complete and must withhold an all-clear on a truncated slice.
//
// `importance` is not a column; when a memory carries explicit salience it lives
// in `metadata`
// (e.g. the off-bank-cost insight's `importance: 0.9`), and the audit's resolver
// reads it from there — so no schema change is needed to make the importance rule
// fire on real ingested memories.
export interface MemoryAuditScope {
  company?: string;
  period?: string;
  kind?: MemoryKind;
  limit?: number;
}

function auditWhere(
  scope: MemoryAuditScope,
  embedModel: string
): { where: string; params: unknown[] } {
  const filters: string[] = [
    "tenant_id = $1",
    "embed_model = $2",
    "status = $3",
  ];
  const params: unknown[] = [PUBLIC_DEMO_TENANT_ID, embedModel, "active"];
  if (scope.company) {
    params.push(scope.company);
    filters.push(`company = $${params.length}`);
  }
  if (scope.period) {
    params.push(scope.period);
    filters.push(`period = $${params.length}`);
  }
  if (scope.kind) {
    params.push(scope.kind);
    filters.push(`kind = $${params.length}`);
  }
  return { where: `WHERE ${filters.join(" AND ")}`, params };
}

export async function listForAudit(
  scope: MemoryAuditScope,
  embedModel: string
): Promise<AuditMemory[]> {
  const { where, params } = auditWhere(scope, embedModel);
  params.push(Math.max(1, Math.min(scope.limit ?? 500, 500)));
  const limitParam = `$${params.length}`;

  const rows = await query<{
    id: string;
    kind: MemoryKind;
    company: string;
    period: string | null;
    source_ref: string | null;
    content: string;
    metadata: Record<string, unknown> | null;
    created_at: string | Date;
  }>(
    `SELECT id, kind, company, period, source_ref, content, metadata, created_at
       FROM agent_memory
       ${where}
      ORDER BY created_at DESC
      LIMIT ${limitParam}`,
    params
  );

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    company: r.company,
    period: r.period,
    sourceRef: r.source_ref,
    content: r.content,
    metadata: r.metadata,
    createdAt:
      r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  }));
}

export async function auditMemoryCount(
  scope: MemoryAuditScope,
  embedModel: string
): Promise<number> {
  const { where, params } = auditWhere(scope, embedModel);
  const rows = await query<{ n: string }>(
    `SELECT count(*) AS n
       FROM agent_memory
       ${where}`,
    params
  );
  return Number(rows[0]?.n ?? 0);
}

// Count stored memories, optionally by company — a cheap observability probe.
export async function memoryCount(
  company?: string,
  embedModel?: string
): Promise<number> {
  const params: unknown[] = [PUBLIC_DEMO_TENANT_ID, "active"];
  const filters = ["tenant_id = $1", "status = $2"];
  if (company) {
    params.push(company);
    filters.push(`company = $${params.length}`);
  }
  if (embedModel) {
    params.push(embedModel);
    filters.push(`embed_model = $${params.length}`);
  }
  const rows = await query<{ n: string }>(
    `SELECT count(*) AS n
       FROM agent_memory
      WHERE ${filters.join(" AND ")}`,
    params
  );
  return Number(rows[0]?.n ?? 0);
}

interface IdempotentRow {
  id: string;
  content_hash: string | null;
}

async function findIdempotentMemory(
  embedModel: string,
  idempotencyKey: string
): Promise<IdempotentRow | undefined> {
  const rows = await query<IdempotentRow>(
    `SELECT id, content_hash
       FROM agent_memory
      WHERE tenant_id = $1
        AND embed_model = $2
        AND idempotency_key = $3
      LIMIT 1`,
    [PUBLIC_DEMO_TENANT_ID, embedModel, idempotencyKey]
  );
  return rows[0];
}

function assertIdempotencyMatch(
  existing: IdempotentRow,
  expectedHash: string
): void {
  if (
    existing.content_hash !== null &&
    existing.content_hash !== expectedHash
  ) {
    throw new Error(
      "idempotencyKey was already used for a different immutable memory payload."
    );
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertEmbedding(embedding: number[], expectedDimension: number): void {
  if (
    embedding.length !== expectedDimension ||
    embedding.some((value) => !Number.isFinite(value))
  ) {
    throw new Error(
      `Embedding must contain exactly ${expectedDimension} finite dimensions.`
    );
  }
}

// Deterministic JSON makes content hashes stable even when callers construct
// metadata objects with a different key insertion order.
function canonicalJson(value: unknown, stack = new Set<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Memory metadata must contain finite numbers.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (stack.has(value)) throw new Error("Memory metadata must not be cyclic.");
    stack.add(value);
    const rendered = `[${value.map((item) => canonicalJson(item, stack)).join(",")}]`;
    stack.delete(value);
    return rendered;
  }
  if (typeof value === "object") {
    if (stack.has(value)) throw new Error("Memory metadata must not be cyclic.");
    stack.add(value);
    const rendered = `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(
            (value as Record<string, unknown>)[key],
            stack
          )}`
      )
      .join(",")}}`;
    stack.delete(value);
    return rendered;
  }
  throw new Error("Memory metadata must be JSON-serializable.");
}
