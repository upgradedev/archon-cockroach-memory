import { createHash } from "node:crypto";
import type { QueryResultRow } from "pg";
import {
  query,
  toVectorLiteral,
  withSerializableRetry,
} from "../db/client.js";
import type { Embedder } from "./embeddings.js";
import type { MemoryKind, RecallHit } from "./memory.js";

export const SANDBOX_TTL_SECONDS = 3600;
export const SANDBOX_MAX_MEMORIES = 20;
export const SANDBOX_MAX_ACTIVE_SESSIONS = 200;

export class SandboxCapacityError extends Error {
  constructor() {
    super("sandbox session capacity reached");
    this.name = "SandboxCapacityError";
  }
}

export class SandboxExpiredError extends Error {
  constructor() {
    super("sandbox session expired");
    this.name = "SandboxExpiredError";
  }
}

export class SandboxServiceCapacityError extends Error {
  constructor() {
    super("sandbox service capacity reached");
    this.name = "SandboxServiceCapacityError";
  }
}

interface SandboxMemoryRow extends QueryResultRow {
  id: string;
  kind: MemoryKind;
  company: string;
  period: string | null;
  source_ref: string | null;
  content: string;
  metadata: Record<string, unknown> | null;
  content_hash: string;
  created_at: string | Date;
  distance: string;
}

export interface SandboxMemoryInput {
  tokenHash: string;
  kind: MemoryKind;
  company: string;
  period: string | null;
  sourceRef: string;
  content: string;
  subject?: string | null;
  attribute?: string | null;
  numericValue?: number | null;
}

export interface SandboxWriteResult {
  id: string;
  expiresAt: string;
  reused: boolean;
}

function assertTokenHash(tokenHash: string): void {
  if (!/^[a-f0-9]{64}$/u.test(tokenHash)) {
    throw new Error("invalid sandbox capability");
  }
}

function assertEmbeddingContract(
  embedding: readonly number[],
  embedder: Embedder
): void {
  if (
    embedding.length !== embedder.dim ||
    embedding.some((value) => !Number.isFinite(value))
  ) {
    throw new Error("sandbox embedding contract failed");
  }
}

async function assertActiveSandboxSession(tokenHash: string): Promise<void> {
  const active = await query<{ active: boolean }>(
    `SELECT true AS active
       FROM judge_sandbox_sessions
      WHERE token_hash = $1
        AND expires_at > now()
      LIMIT 1`,
    [tokenHash]
  );
  if (!active[0]?.active) {
    throw new SandboxExpiredError();
  }
}

async function assertNewSessionCapacity(tokenHash: string): Promise<void> {
  const rows = await query<{ session_exists: boolean; active_sessions: string }>(
    `SELECT EXISTS (
              SELECT 1
                FROM judge_sandbox_sessions
               WHERE token_hash = $1
                 AND expires_at > now()
            ) AS session_exists,
            count(*)::STRING AS active_sessions
       FROM judge_sandbox_sessions
      WHERE expires_at > now()`,
    [tokenHash]
  );
  const state = rows[0];
  if (
    state &&
    !state.session_exists &&
    Number(state.active_sessions) >= SANDBOX_MAX_ACTIVE_SESSIONS
  ) {
    throw new SandboxServiceCapacityError();
  }
}

function sandboxContentHash(input: SandboxMemoryInput): string {
  return createHash("sha256")
    .update(
      [
        input.kind,
        input.company,
        input.period ?? "",
        input.sourceRef,
        input.content,
        input.subject ?? "",
        input.attribute ?? "",
        input.numericValue == null ? "" : String(input.numericValue),
      ].join("\u0000"),
      "utf8"
    )
    .digest("hex");
}

export async function rememberSandbox(
  embedder: Embedder,
  input: SandboxMemoryInput
): Promise<SandboxWriteResult> {
  assertTokenHash(input.tokenHash);
  const contentHash = sandboxContentHash(input);
  const existing = await query<{ id: string; expires_at: string | Date }>(
    `SELECT id, expires_at
       FROM judge_sandbox_memory
      WHERE session_token_hash = $1
        AND embed_model = $2
        AND content_hash = $3
        AND expires_at > now()
      LIMIT 1`,
    [input.tokenHash, embedder.modelId, contentHash]
  );
  if (existing[0]) {
    return {
      id: existing[0].id,
      expiresAt: new Date(existing[0].expires_at).toISOString(),
      reused: true,
    };
  }

  await assertNewSessionCapacity(input.tokenHash);
  const embedding = await embedder.embed(input.content);
  assertEmbeddingContract(embedding, embedder);

  return withSerializableRetry(async (client) => {
    const knownSession = await client.query<{ token_hash: string }>(
      `SELECT token_hash
         FROM judge_sandbox_sessions
        WHERE token_hash = $1
        FOR UPDATE`,
      [input.tokenHash]
    );
    if (!knownSession.rows[0]) {
      // This predicate read and the insert below intentionally share one
      // explicit SERIALIZABLE transaction. Concurrent creators at the ceiling
      // cannot both commit a view with fewer than 200 active sessions; one is
      // retried and observes the committed winner.
      const activeSessions = await client.query<{ count: string }>(
        `SELECT count(*)::STRING AS count
           FROM judge_sandbox_sessions
          WHERE expires_at > now()`
      );
      if (
        Number(activeSessions.rows[0]?.count ?? 0) >=
        SANDBOX_MAX_ACTIVE_SESSIONS
      ) {
        throw new SandboxServiceCapacityError();
      }
    }
    await client.query(
      `INSERT INTO judge_sandbox_sessions
         (token_hash, expires_at)
       VALUES ($1, now() + $2::INT8 * INTERVAL '1 second')
       ON CONFLICT (token_hash) DO NOTHING`,
      [input.tokenHash, SANDBOX_TTL_SECONDS]
    );
    const session = await client.query<{
      expires_at: string | Date;
      memory_count: string;
    }>(
      `SELECT expires_at, memory_count::STRING AS memory_count
         FROM judge_sandbox_sessions
        WHERE token_hash = $1
        FOR UPDATE`,
      [input.tokenHash]
    );
    const current = session.rows[0];
    if (!current || new Date(current.expires_at).getTime() <= Date.now()) {
      throw new SandboxExpiredError();
    }

    const winner = await client.query<{ id: string }>(
      `SELECT id
         FROM judge_sandbox_memory
        WHERE session_token_hash = $1
          AND embed_model = $2
          AND content_hash = $3
        LIMIT 1`,
      [input.tokenHash, embedder.modelId, contentHash]
    );
    if (winner.rows[0]) {
      return {
        id: winner.rows[0].id,
        expiresAt: new Date(current.expires_at).toISOString(),
        reused: true,
      };
    }
    if (Number(current.memory_count) >= SANDBOX_MAX_MEMORIES) {
      throw new SandboxCapacityError();
    }

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO judge_sandbox_memory
         (session_token_hash, kind, company, period, source_ref, content,
          metadata, embedding, embed_model, content_hash, subject,
          attribute, numeric_value, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::JSONB, $8::VECTOR, $9, $10,
               $11, $12, $13, $14::TIMESTAMPTZ)
       RETURNING id`,
      [
        input.tokenHash,
        input.kind,
        input.company,
        input.period,
        input.sourceRef,
        input.content,
        JSON.stringify({ submitted_by: "judge_sandbox" }),
        toVectorLiteral(embedding),
        embedder.modelId,
        contentHash,
        input.subject ?? null,
        input.attribute ?? null,
        input.numericValue ?? null,
        new Date(current.expires_at).toISOString(),
      ]
    );
    await client.query(
      `UPDATE judge_sandbox_sessions
          SET memory_count = memory_count + 1,
              updated_at = now()
        WHERE token_hash = $1`,
      [input.tokenHash]
    );
    return {
      id: inserted.rows[0]!.id,
      expiresAt: new Date(current.expires_at).toISOString(),
      reused: false,
    };
  });
}

export async function recallSandbox(
  embedder: Embedder,
  tokenHash: string,
  question: string,
  limit = 10
): Promise<RecallHit[]> {
  assertTokenHash(tokenHash);
  await assertActiveSandboxSession(tokenHash);
  const embedding = await embedder.embed(question);
  assertEmbeddingContract(embedding, embedder);
  const normalizedLimit = Number.isFinite(limit) ? Math.trunc(limit) : 10;
  const boundedLimit = Math.max(1, Math.min(normalizedLimit, 20));
  const rows = await query<SandboxMemoryRow>(
    `SELECT id, kind, company, period, source_ref, content, metadata,
            content_hash, created_at,
            (embedding <=> $1::VECTOR)::STRING AS distance
       FROM judge_sandbox_memory
      WHERE session_token_hash = $2
        AND embed_model = $3
        AND expires_at > now()
      ORDER BY embedding <=> $1::VECTOR
      LIMIT $4`,
    [toVectorLiteral(embedding), tokenHash, embedder.modelId, boundedLimit]
  );
  // The embedding call can outlive a session that was active at entry. Recheck
  // after the bounded read so expiry is reported as 410 instead of a misleading
  // successful no-evidence response.
  await assertActiveSandboxSession(tokenHash);
  return rows.map((row) => {
    const distance = Number(row.distance);
    return {
      id: row.id,
      kind: row.kind,
      company: row.company,
      period: row.period,
      sourceRef: row.source_ref,
      content: row.content,
      metadata: row.metadata,
      createdAt: new Date(row.created_at).toISOString(),
      distance,
      score: 1 - distance,
    };
  });
}

export interface SandboxContradiction {
  subject: string;
  attribute: string;
  values: Array<{ value: number; sourceRef: string; memoryId: string }>;
}

export async function auditSandbox(
  tokenHash: string
): Promise<SandboxContradiction[]> {
  assertTokenHash(tokenHash);
  await assertActiveSandboxSession(tokenHash);
  const rows = await query<{
    id: string;
    subject: string;
    attribute: string;
    numeric_value: string;
    source_ref: string;
  }>(
    `SELECT id, subject, attribute, numeric_value::STRING AS numeric_value,
            source_ref
       FROM judge_sandbox_memory
      WHERE session_token_hash = $1
        AND expires_at > now()
        AND subject IS NOT NULL
        AND attribute IS NOT NULL
        AND numeric_value IS NOT NULL
      ORDER BY subject, attribute, created_at, id`,
    [tokenHash]
  );
  await assertActiveSandboxSession(tokenHash);
  const groups = new Map<string, SandboxContradiction>();
  for (const row of rows) {
    const key = `${row.subject}\u0000${row.attribute}`;
    const group = groups.get(key) ?? {
      subject: row.subject,
      attribute: row.attribute,
      values: [],
    };
    group.values.push({
      value: Number(row.numeric_value),
      sourceRef: row.source_ref,
      memoryId: row.id,
    });
    groups.set(key, group);
  }
  return [...groups.values()].filter(
    (group) => new Set(group.values.map((item) => item.value)).size > 1
  );
}
