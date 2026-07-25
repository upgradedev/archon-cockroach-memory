import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { PUBLIC_DEMO_COMPANY, PUBLIC_DEMO_TENANT_ID } from "../config/scope.js";
import { withSerializableRetry } from "../db/client.js";
import {
  canonicalMemoryPayload,
  memoryContentDigest,
  type MemoryIntegrityInput,
  type MemoryKind,
} from "./memory.js";

export const PUBLIC_DEMO_CANONICAL_KEYS = [
  "archon-event/v1/EVT-HELIOS-2604/summary",
  "archon-event/v1/EVT-HELIOS-2604/off-bank-cost",
  "archon-event/v1/EVT-HELIOS-2604/employee/E-01",
  "archon-event/v1/EVT-HELIOS-2604/employee/E-02",
  "archon-event/v1/EVT-HELIOS-2604/employee/E-03",
  "archon-event/v1/EVT-HELIOS-2604/employee/E-04",
  "archon-demo/v1/inv-2043-confirmed",
  "archon-demo/v1/inv-2043-later-note",
  "archon-demo/v1/recon-2043-missing-pay-118",
] as const;

export const LEGACY_EVENT_CANONICAL_KEYS =
  PUBLIC_DEMO_CANONICAL_KEYS.slice(0, 6);

const LEGACY_CREATED_AT_FROM = "2026-07-13T00:00:00.000Z";
const LEGACY_CREATED_AT_TO = "2026-07-14T00:00:00.000Z";
const MIGRATION_ID = "legacy-helios-event-v1";
const MEMORY_KINDS = new Set<MemoryKind>([
  "document",
  "payroll_event",
  "validation",
  "insight",
]);

interface StoredMemoryRow {
  id: string;
  tenant_id: string;
  kind: string;
  company: string;
  period: string | null;
  source_ref: string | null;
  content: string;
  metadata: Record<string, unknown> | null;
  embed_model: string;
  idempotency_key: string | null;
  content_hash: string | null;
  status: string;
  superseded_by: string | null;
  created_at: Date | string;
}

interface CanonicalRow extends StoredMemoryRow {
  idempotency_key: string;
  content_hash: string;
  status: "active";
}

interface LegacyMatch {
  legacy: StoredMemoryRow;
  canonical: CanonicalRow;
}

export interface LegacyDemoReconciliationReceipt {
  schemaVersion: 1;
  ok: true;
  migrationId: typeof MIGRATION_ID;
  targetSha: string;
  mode: "clean" | "migrated" | "already-reconciled";
  manifestSha256: string;
  targetRowSetSha256: string;
  expectedLegacyDuplicates: number;
  activeBefore: number;
  alreadySuperseded: number;
  supersededThisRun: number;
  linkedAfter: number;
  canonicalActive: number;
  activeIntegrityGapsAfter: number;
  activeDistinctIdempotencyKeys: number;
  activeDistinctContentDigests: number;
  historicalRowsPreserved: true;
  secretMaterialPrinted: false;
  generatedAt: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function asIntegrityInput(row: StoredMemoryRow): MemoryIntegrityInput {
  if (!MEMORY_KINDS.has(row.kind as MemoryKind)) {
    throw new Error("Legacy memory reconciliation found an invalid memory kind.");
  }
  return {
    tenantId: row.tenant_id,
    kind: row.kind as MemoryKind,
    company: row.company,
    period: row.period,
    sourceRef: row.source_ref,
    content: row.content,
    metadata: row.metadata,
  };
}

function exactPayloadMatch(
  legacy: StoredMemoryRow,
  canonical: CanonicalRow
): boolean {
  return (
    legacy.tenant_id === canonical.tenant_id &&
    legacy.kind === canonical.kind &&
    legacy.company === canonical.company &&
    legacy.period === canonical.period &&
    legacy.source_ref === canonical.source_ref &&
    legacy.content === canonical.content &&
    legacy.embed_model === canonical.embed_model &&
    canonicalMemoryPayload(asIntegrityInput(legacy)) ===
      canonicalMemoryPayload(asIntegrityInput(canonical))
  );
}

async function canonicalRows(
  client: PoolClient,
  embedModel: string
): Promise<CanonicalRow[]> {
  const result = await client.query<StoredMemoryRow>(
    `SELECT id, tenant_id, kind, company, period, source_ref, content, metadata,
            embed_model, idempotency_key, content_hash, status, superseded_by,
            created_at
       FROM agent_memory
      WHERE tenant_id = $1
        AND company = $2
        AND embed_model = $3
        AND status = 'active'
        AND idempotency_key = ANY($4::STRING[])
      ORDER BY idempotency_key
      FOR UPDATE`,
    [
      PUBLIC_DEMO_TENANT_ID,
      PUBLIC_DEMO_COMPANY,
      embedModel,
      LEGACY_EVENT_CANONICAL_KEYS,
    ]
  );
  if (
    result.rows.length !== LEGACY_EVENT_CANONICAL_KEYS.length ||
    new Set(result.rows.map((row) => row.idempotency_key)).size !==
      LEGACY_EVENT_CANONICAL_KEYS.length
  ) {
    throw new Error("Canonical legacy-replacement manifest is incomplete.");
  }
  const allowed = new Set<string>(LEGACY_EVENT_CANONICAL_KEYS);
  return result.rows.map((row) => {
    const expectedDigest = memoryContentDigest(asIntegrityInput(row));
    if (
      row.status !== "active" ||
      !row.idempotency_key ||
      !allowed.has(row.idempotency_key) ||
      row.content_hash !== expectedDigest ||
      !/^[a-f0-9]{64}$/u.test(row.content_hash)
    ) {
      throw new Error("Canonical legacy replacement failed its integrity proof.");
    }
    return row as CanonicalRow;
  });
}

async function legacyCandidates(
  client: PoolClient,
  embedModel: string
): Promise<StoredMemoryRow[]> {
  const result = await client.query<StoredMemoryRow>(
    `SELECT id, tenant_id, kind, company, period, source_ref, content, metadata,
            embed_model, idempotency_key, content_hash, status, superseded_by,
            created_at
       FROM agent_memory
      WHERE tenant_id = $1
        AND company = $2
        AND embed_model = $3
        AND idempotency_key IS NULL
        AND created_at >= $4::TIMESTAMPTZ
        AND created_at < $5::TIMESTAMPTZ
        AND status IN ('active', 'superseded', 'retracted')
      ORDER BY id
      LIMIT 7
      FOR UPDATE`,
    [
      PUBLIC_DEMO_TENANT_ID,
      PUBLIC_DEMO_COMPANY,
      embedModel,
      LEGACY_CREATED_AT_FROM,
      LEGACY_CREATED_AT_TO,
    ]
  );
  if (result.rows.length > LEGACY_EVENT_CANONICAL_KEYS.length) {
    throw new Error("Legacy memory reconciliation found extra candidate rows.");
  }
  return result.rows;
}

function matchLegacyRows(
  candidates: StoredMemoryRow[],
  canonical: CanonicalRow[]
): LegacyMatch[] {
  const canonicalByDigest = new Map(
    canonical.map((row) => [
      memoryContentDigest(asIntegrityInput(row)),
      row,
    ])
  );
  if (canonicalByDigest.size !== canonical.length) {
    throw new Error("Canonical replacement payload digests are not unique.");
  }
  const matches = candidates.map((legacy) => {
    const digest = memoryContentDigest(asIntegrityInput(legacy));
    const replacement = canonicalByDigest.get(digest);
    if (!replacement || !exactPayloadMatch(legacy, replacement)) {
      throw new Error("Legacy memory candidate did not match the exact manifest.");
    }
    return { legacy, canonical: replacement };
  });
  if (
    new Set(matches.map((match) => match.legacy.id)).size !== matches.length ||
    new Set(matches.map((match) => match.canonical.id)).size !== matches.length
  ) {
    throw new Error("Legacy memory reconciliation is not one-to-one.");
  }
  return matches;
}

async function verifyActiveStore(
  client: PoolClient,
  embedModel: string
): Promise<{
  canonicalActive: number;
  integrityGaps: number;
  distinctIdempotencyKeys: number;
  distinctContentDigests: number;
}> {
  const result = await client.query<{
    active_records: string;
    canonical_active: string;
    integrity_gaps: string;
    idempotency_keys: string;
    content_digests: string;
  }>(
    `SELECT count(*) AS active_records,
            count(*) FILTER (
              WHERE idempotency_key = ANY($4::STRING[])
            ) AS canonical_active,
            count(*) FILTER (
              WHERE idempotency_key IS NULL
                 OR length(idempotency_key) NOT BETWEEN 1 AND 256
                 OR content_hash IS NULL
                 OR content_hash !~ '^[a-f0-9]{64}$'
            ) AS integrity_gaps,
            count(DISTINCT idempotency_key) FILTER (
              WHERE length(idempotency_key) BETWEEN 1 AND 256
            ) AS idempotency_keys,
            count(DISTINCT content_hash) FILTER (
              WHERE content_hash ~ '^[a-f0-9]{64}$'
            ) AS content_digests
       FROM agent_memory
      WHERE tenant_id = $1
        AND company = $2
        AND embed_model = $3
        AND status = 'active'`,
    [
      PUBLIC_DEMO_TENANT_ID,
      PUBLIC_DEMO_COMPANY,
      embedModel,
      PUBLIC_DEMO_CANONICAL_KEYS,
    ]
  );
  const row = result.rows[0];
  const activeRecords = Number(row?.active_records ?? 0);
  const canonicalActive = Number(row?.canonical_active ?? 0);
  const integrityGaps = Number(row?.integrity_gaps ?? 0);
  const distinctIdempotencyKeys = Number(row?.idempotency_keys ?? 0);
  const distinctContentDigests = Number(row?.content_digests ?? 0);
  if (
    activeRecords !== PUBLIC_DEMO_CANONICAL_KEYS.length ||
    canonicalActive !== PUBLIC_DEMO_CANONICAL_KEYS.length ||
    integrityGaps !== 0 ||
    distinctIdempotencyKeys !== PUBLIC_DEMO_CANONICAL_KEYS.length ||
    distinctContentDigests !== PUBLIC_DEMO_CANONICAL_KEYS.length
  ) {
    throw new Error("Canonical active memory store postcondition failed.");
  }
  return {
    canonicalActive,
    integrityGaps,
    distinctIdempotencyKeys,
    distinctContentDigests,
  };
}

export async function reconcileLegacyPublicDemoMemory(
  embedModel: string,
  targetSha: string
): Promise<LegacyDemoReconciliationReceipt> {
  if (!embedModel.trim()) {
    throw new Error("Embedding model is required for legacy reconciliation.");
  }
  if (!/^[a-f0-9]{40}$/u.test(targetSha)) {
    throw new Error("Exact 40-character release SHA is required.");
  }

  return withSerializableRetry(async (client) => {
    const canonical = await canonicalRows(client, embedModel);
    const candidates = await legacyCandidates(client, embedModel);
    const matches = matchLegacyRows(candidates, canonical);
    const active = matches.filter(
      (match) => match.legacy.status === "active"
    );
    const alreadySuperseded = matches.filter(
      (match) =>
        match.legacy.status === "superseded" &&
        match.legacy.superseded_by === match.canonical.id &&
        match.legacy.content_hash === match.canonical.content_hash
    );

    const clean = matches.length === 0;
    const migratable =
      active.length === LEGACY_EVENT_CANONICAL_KEYS.length &&
      alreadySuperseded.length === 0 &&
      active.every(
        (match) =>
          match.legacy.content_hash === null &&
          match.legacy.superseded_by === null
      );
    const reconciled =
      active.length === 0 &&
      alreadySuperseded.length === LEGACY_EVENT_CANONICAL_KEYS.length;
    if (!clean && !migratable && !reconciled) {
      throw new Error("Legacy memory reconciliation state is partial or drifted.");
    }

    for (const match of active) {
      const updated = await client.query<{ id: string }>(
        `UPDATE agent_memory
            SET status = 'superseded',
                superseded_by = $2,
                content_hash = $3,
                updated_at = now()
          WHERE id = $1
            AND tenant_id = $4
            AND company = $5
            AND embed_model = $6
            AND status = 'active'
            AND idempotency_key IS NULL
            AND content_hash IS NULL
            AND superseded_by IS NULL
            AND created_at >= $7::TIMESTAMPTZ
            AND created_at < $8::TIMESTAMPTZ
          RETURNING id`,
        [
          match.legacy.id,
          match.canonical.id,
          match.canonical.content_hash,
          PUBLIC_DEMO_TENANT_ID,
          PUBLIC_DEMO_COMPANY,
          embedModel,
          LEGACY_CREATED_AT_FROM,
          LEGACY_CREATED_AT_TO,
        ]
      );
      if (updated.rowCount !== 1) {
        throw new Error("Legacy memory reconciliation lost its row lock.");
      }
    }

    const postCandidates = await legacyCandidates(client, embedModel);
    const postMatches = matchLegacyRows(postCandidates, canonical);
    const linkedAfter = postMatches.filter(
      (match) =>
        match.legacy.status === "superseded" &&
        match.legacy.superseded_by === match.canonical.id &&
        match.legacy.content_hash === match.canonical.content_hash
    );
    if (
      postMatches.length !== matches.length ||
      linkedAfter.length !== matches.length
    ) {
      throw new Error("Legacy memory reconciliation postcondition failed.");
    }
    const store = await verifyActiveStore(client, embedModel);
    const targetIds = postMatches
      .map((match) => match.legacy.id)
      .sort();
    const manifestSha256 = sha256(
      JSON.stringify({
        migrationId: MIGRATION_ID,
        tenantId: PUBLIC_DEMO_TENANT_ID,
        company: PUBLIC_DEMO_COMPANY,
        embedModel,
        createdAt: [LEGACY_CREATED_AT_FROM, LEGACY_CREATED_AT_TO],
        canonicalKeys: LEGACY_EVENT_CANONICAL_KEYS,
      })
    );

    return {
      schemaVersion: 1,
      ok: true,
      migrationId: MIGRATION_ID,
      targetSha,
      mode: clean
        ? "clean"
        : migratable
          ? "migrated"
          : "already-reconciled",
      manifestSha256,
      targetRowSetSha256: sha256(targetIds.join("\n")),
      expectedLegacyDuplicates: LEGACY_EVENT_CANONICAL_KEYS.length,
      activeBefore: active.length,
      alreadySuperseded: alreadySuperseded.length,
      supersededThisRun: active.length,
      linkedAfter: linkedAfter.length,
      canonicalActive: store.canonicalActive,
      activeIntegrityGapsAfter: store.integrityGaps,
      activeDistinctIdempotencyKeys: store.distinctIdempotencyKeys,
      activeDistinctContentDigests: store.distinctContentDigests,
      historicalRowsPreserved: true,
      secretMaterialPrinted: false,
      generatedAt: new Date().toISOString(),
    };
  });
}
