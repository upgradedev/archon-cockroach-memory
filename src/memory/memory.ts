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

import { query, toVectorLiteral } from "../db/client.js";
import type { Embedder } from "./embeddings.js";

export type MemoryKind = "document" | "payroll_event" | "validation" | "insight";

export interface MemoryInput {
  kind: MemoryKind;
  company?: string; // defaults to '_global'
  period?: string | null;
  sourceRef?: string | null; // originating row id
  content: string; // the recallable natural-language fact
  metadata?: Record<string, unknown> | null;
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
  kind?: MemoryKind; // pre-filter (also a vector-index prefix column)
  company?: string; // pre-filter (also a vector-index prefix column)
  limit?: number; // top-k, default 5
}

// ── write ────────────────────────────────────────────────────────────────────
// Embed `content` and persist the memory. Returns the new row id.
export async function remember(embedder: Embedder, input: MemoryInput): Promise<string> {
  const embedding = await embedder.embed(input.content);
  const rows = await query<{ id: string }>(
    `INSERT INTO agent_memory
       (kind, company, period, source_ref, content, metadata, embedding, embed_model)
     VALUES ($1, $2, $3, $4, $5, $6, $7::VECTOR, $8)
     RETURNING id`,
    [
      input.kind,
      input.company ?? "_global",
      input.period ?? null,
      input.sourceRef ?? null,
      input.content,
      input.metadata ? JSON.stringify(input.metadata) : null,
      toVectorLiteral(embedding),
      embedder.modelId,
    ]
  );
  return rows[0].id;
}

// ── read ─────────────────────────────────────────────────────────────────────
// Recall the top-k memories most semantically similar to `queryText`, optionally
// pre-filtered by kind/company. Unscoped recall (no filters) is accelerated by
// the global distributed vector index (EXPLAIN → `vector search`). A scoped
// recall additionally constrains kind/company via their btree indexes; at scale,
// per-tenant prefix vector indexes are the planned optimization (BUILD_PLAN).
export async function recall(
  embedder: Embedder,
  queryText: string,
  opts: RecallOptions = {}
): Promise<RecallHit[]> {
  const qvec = toVectorLiteral(await embedder.embed(queryText));
  const filters: string[] = [];
  const params: unknown[] = [qvec];
  if (opts.kind) {
    params.push(opts.kind);
    filters.push(`kind = $${params.length}`);
  }
  if (opts.company) {
    params.push(opts.company);
    filters.push(`company = $${params.length}`);
  }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  params.push(Math.max(1, Math.min(opts.limit ?? 5, 50)));
  const limitParam = `$${params.length}`;

  const rows = await query<{
    id: string;
    kind: MemoryKind;
    company: string;
    period: string | null;
    source_ref: string | null;
    content: string;
    metadata: Record<string, unknown> | null;
    created_at: string;
    distance: string;
  }>(
    `SELECT id, kind, company, period, source_ref, content, metadata, created_at,
            (embedding <=> $1::VECTOR) AS distance
       FROM agent_memory
       ${where}
     ORDER BY embedding <=> $1::VECTOR
     LIMIT ${limitParam}`,
    params
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
      createdAt: r.created_at,
      distance,
      score: 1 - distance,
    };
  });
}

// Count stored memories, optionally by company — a cheap observability probe.
export async function memoryCount(company?: string): Promise<number> {
  const rows = company
    ? await query<{ n: string }>(
        `SELECT count(*) AS n FROM agent_memory WHERE company = $1`,
        [company]
      )
    : await query<{ n: string }>(`SELECT count(*) AS n FROM agent_memory`);
  return Number(rows[0].n);
}
