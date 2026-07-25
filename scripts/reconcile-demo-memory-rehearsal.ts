import {
  closePool,
  withClient,
  withSerializableRetry,
} from "../src/db/client.js";
import { FakeEmbedder } from "../src/memory/embeddings.js";
import {
  LEGACY_EVENT_CANONICAL_KEYS,
  reconcileLegacyPublicDemoMemory,
} from "../src/memory/demo-reconciliation.js";
import { applySchema } from "./apply-schema.js";
import { seedDemo } from "./seed-demo.js";

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required.");
const databaseName = decodeURIComponent(
  new URL(databaseUrl).pathname.replace(/^\//u, "")
);
if (!/^archon_reconciliation(?:_ci)?$/u.test(databaseName)) {
  throw new Error(
    "Reconciliation rehearsal refuses a database not named archon_reconciliation[_ci]."
  );
}

const REHEARSAL_SHA = "0000000000000000000000000000000000000000";
const ROLLBACK_SENTINEL =
  "intentional post-mutation reconciliation rollback sentinel";

async function cloneLegacyBatch(embedModel: string): Promise<number> {
  return withClient(async (client) => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO agent_memory
         (tenant_id, kind, company, period, source_ref, content, metadata,
          embedding, embed_model, status, created_at, updated_at)
       SELECT tenant_id, kind, company, period, source_ref, content, metadata,
              embedding, embed_model, 'active',
              '2026-07-13T06:00:00.000Z'::TIMESTAMPTZ,
              '2026-07-13T06:00:00.000Z'::TIMESTAMPTZ
         FROM agent_memory
        WHERE tenant_id = 'public-demo'
          AND company = 'Helios SA'
          AND embed_model = $1
          AND status = 'active'
          AND idempotency_key = ANY($2::STRING[])
        ORDER BY idempotency_key
      RETURNING id`,
      [embedModel, LEGACY_EVENT_CANONICAL_KEYS]
    );
    if (result.rowCount !== LEGACY_EVENT_CANONICAL_KEYS.length) {
      throw new Error("Could not construct the exact six-row legacy rehearsal batch.");
    }
    return result.rowCount;
  });
}

async function insertAlteredCandidate(embedModel: string): Promise<string> {
  return withClient(async (client) => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO agent_memory
         (tenant_id, kind, company, period, source_ref, content, metadata,
          embedding, embed_model, status, created_at, updated_at)
       SELECT tenant_id, kind, company, period, source_ref,
              content || ' altered', metadata, embedding, embed_model, 'active',
              '2026-07-13T07:00:00.000Z'::TIMESTAMPTZ,
              '2026-07-13T07:00:00.000Z'::TIMESTAMPTZ
         FROM agent_memory
        WHERE tenant_id = 'public-demo'
          AND company = 'Helios SA'
          AND embed_model = $1
          AND status = 'active'
          AND idempotency_key = $2
      RETURNING id`,
      [embedModel, LEGACY_EVENT_CANONICAL_KEYS[0]]
    );
    const id = result.rows[0]?.id;
    if (result.rowCount !== 1 || !id) {
      throw new Error("Could not construct the altered rollback canary.");
    }
    return id;
  });
}

async function activeLegacyCount(embedModel: string): Promise<number> {
  return withClient(async (client) => {
    const result = await client.query<{ total: string }>(
      `SELECT count(*) AS total
         FROM agent_memory
        WHERE tenant_id = 'public-demo'
          AND company = 'Helios SA'
          AND embed_model = $1
          AND status = 'active'
          AND idempotency_key IS NULL
          AND created_at >= '2026-07-13T00:00:00.000Z'::TIMESTAMPTZ
          AND created_at < '2026-07-14T00:00:00.000Z'::TIMESTAMPTZ`,
      [embedModel]
    );
    return Number(result.rows[0]?.total ?? 0);
  });
}

async function proveRollbackAfterMutation(embedModel: string): Promise<void> {
  let sentinelObserved = false;
  try {
    await withSerializableRetry(async (client) => {
      const legacy = await client.query<{ id: string }>(
        `SELECT id
           FROM agent_memory
          WHERE tenant_id = 'public-demo'
            AND company = 'Helios SA'
            AND embed_model = $1
            AND status = 'active'
            AND idempotency_key IS NULL
            AND content_hash IS NULL
            AND superseded_by IS NULL
            AND created_at >= '2026-07-13T00:00:00.000Z'::TIMESTAMPTZ
            AND created_at < '2026-07-14T00:00:00.000Z'::TIMESTAMPTZ
          ORDER BY id
          LIMIT 1
          FOR UPDATE`,
        [embedModel]
      );
      const canonical = await client.query<{
        id: string;
        content_hash: string;
      }>(
        `SELECT id, content_hash
           FROM agent_memory
          WHERE tenant_id = 'public-demo'
            AND company = 'Helios SA'
            AND embed_model = $1
            AND status = 'active'
            AND idempotency_key = $2
          FOR UPDATE`,
        [embedModel, LEGACY_EVENT_CANONICAL_KEYS[0]]
      );
      const legacyId = legacy.rows[0]?.id;
      const replacement = canonical.rows[0];
      if (!legacyId || !replacement?.id || !replacement.content_hash) {
        throw new Error("Could not construct the post-mutation rollback proof.");
      }
      const updated = await client.query(
        `UPDATE agent_memory
            SET status = 'superseded',
                superseded_by = $2,
                content_hash = $3,
                updated_at = now()
          WHERE id = $1
            AND status = 'active'
            AND idempotency_key IS NULL
            AND content_hash IS NULL
            AND superseded_by IS NULL`,
        [legacyId, replacement.id, replacement.content_hash]
      );
      if (updated.rowCount !== 1) {
        throw new Error("Could not mutate the rollback proof row.");
      }
      throw new Error(ROLLBACK_SENTINEL);
    });
  } catch (error) {
    sentinelObserved =
      error instanceof Error && error.message === ROLLBACK_SENTINEL;
  }
  if (!sentinelObserved) {
    throw new Error("The post-mutation rollback sentinel was not observed.");
  }

  const state = await withClient(async (client) => {
    const result = await client.query<{
      total: string;
      pristine: string;
    }>(
      `SELECT count(*) AS total,
              count(*) FILTER (
                WHERE status = 'active'
                  AND content_hash IS NULL
                  AND superseded_by IS NULL
              ) AS pristine
         FROM agent_memory
        WHERE tenant_id = 'public-demo'
          AND company = 'Helios SA'
          AND embed_model = $1
          AND idempotency_key IS NULL
          AND created_at >= '2026-07-13T00:00:00.000Z'::TIMESTAMPTZ
          AND created_at < '2026-07-14T00:00:00.000Z'::TIMESTAMPTZ`,
      [embedModel]
    );
    return {
      total: Number(result.rows[0]?.total ?? 0),
      pristine: Number(result.rows[0]?.pristine ?? 0),
    };
  });
  if (
    state.total !== LEGACY_EVENT_CANONICAL_KEYS.length ||
    state.pristine !== LEGACY_EVENT_CANONICAL_KEYS.length
  ) {
    throw new Error("Post-mutation transaction rollback did not restore all rows.");
  }
}

async function main(): Promise<void> {
  await applySchema();
  const embedder = new FakeEmbedder();
  await seedDemo(embedder);

  const clean = await reconcileLegacyPublicDemoMemory(
    embedder.modelId,
    REHEARSAL_SHA
  );
  if (
    clean.mode !== "clean" ||
    clean.linkedAfter !== 0 ||
    clean.canonicalActive !== 9
  ) {
    throw new Error("Clean-database reconciliation did not prove a safe no-op.");
  }

  await cloneLegacyBatch(embedder.modelId);
  await proveRollbackAfterMutation(embedder.modelId);
  const alteredId = await insertAlteredCandidate(embedder.modelId);
  let rejected = false;
  try {
    await reconcileLegacyPublicDemoMemory(embedder.modelId, REHEARSAL_SHA);
  } catch (error) {
    rejected =
      error instanceof Error &&
      /extra candidate rows|exact manifest/iu.test(error.message);
  }
  if (!rejected || (await activeLegacyCount(embedder.modelId)) !== 7) {
    throw new Error("Altered candidate did not fail closed without mutation.");
  }
  await withClient(async (client) => {
    const deleted = await client.query(
      `DELETE FROM agent_memory
        WHERE id = $1
          AND status = 'active'
          AND idempotency_key IS NULL
          AND content_hash IS NULL
          AND created_at = '2026-07-13T07:00:00.000Z'::TIMESTAMPTZ`,
      [alteredId]
    );
    if (deleted.rowCount !== 1) {
      throw new Error("Could not remove the exact ephemeral rollback canary.");
    }
  });

  const migrated = await reconcileLegacyPublicDemoMemory(
    embedder.modelId,
    REHEARSAL_SHA
  );
  const rerun = await reconcileLegacyPublicDemoMemory(
    embedder.modelId,
    REHEARSAL_SHA
  );
  if (
    migrated.mode !== "migrated" ||
    migrated.supersededThisRun !== 6 ||
    migrated.linkedAfter !== 6 ||
    migrated.canonicalActive !== 9 ||
    migrated.activeIntegrityGapsAfter !== 0 ||
    rerun.mode !== "already-reconciled" ||
    rerun.supersededThisRun !== 0 ||
    rerun.linkedAfter !== 6 ||
    rerun.targetRowSetSha256 !== migrated.targetRowSetSha256 ||
    (await activeLegacyCount(embedder.modelId)) !== 0
  ) {
    throw new Error("Legacy reconciliation first-run or rerun proof failed.");
  }

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      database: databaseName,
      cleanNoOp: true,
      alteredCandidateRejected: true,
      transactionRollbackAfterMutation: true,
      supersededOnFirstRun: migrated.supersededThisRun,
      linkedHistoricalRows: migrated.linkedAfter,
      idempotentRerun: true,
      canonicalActive: migrated.canonicalActive,
      activeIntegrityGaps: migrated.activeIntegrityGapsAfter,
      targetSetStable: true,
    })}\n`
  );
}

main()
  .catch((error) => {
    const message =
      error instanceof Error ? error.message : "unknown reconciliation error";
    process.stderr.write(`Reconciliation rehearsal failed: ${message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool().catch(() => undefined);
  });
