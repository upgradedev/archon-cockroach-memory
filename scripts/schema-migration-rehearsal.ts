// CI-only real-CockroachDB rehearsal for the forward migration path.
// It starts from the legacy agent_memory shape, injects a same-named wrong
// index, proves catalog verification fails closed, repairs the drift, applies
// the current schema twice, and verifies preserved data + exact RLS behavior.

import pg from "pg";
import { applySchema } from "./apply-schema.js";
import {
  EXPECTED_VECTOR_INDEX_NAME,
  isExpectedVectorIndexDefinition,
} from "../src/db/proof.js";

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const parsed = new URL(databaseUrl);
const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//u, ""));
if (!/^archon_migration(?:_ci)?$/u.test(databaseName)) {
  throw new Error(
    "Migration rehearsal refuses a database not named archon_migration[_ci]."
  );
}

const zeroVector = `[${new Array(1024).fill("0").join(",")}]`;

async function setupLegacy(): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    const existing = await client.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = 'agent_memory'`
    );
    if (existing.rowCount) {
      throw new Error("Migration rehearsal database must start empty.");
    }
    await client.query(`
      CREATE TABLE agent_memory (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        kind TEXT NOT NULL,
        company TEXT NOT NULL DEFAULT '_global',
        period TEXT,
        source_ref TEXT,
        content TEXT NOT NULL,
        metadata JSONB,
        embedding VECTOR(1024) NOT NULL,
        embed_model TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now()
      )
    `);
    await client.query(
      `INSERT INTO agent_memory
         (kind, company, period, source_ref, content, metadata,
          embedding, embed_model)
       VALUES
         ('insight', 'Helios SA', '2026-04', 'LEGACY-1',
          'Legacy Helios evidence survives migration.',
          '{"record":"LEGACY-1"}', $1::VECTOR, 'fake-embed-v1'),
         ('insight', 'Legacy Hidden Co', '2026-04', 'LEGACY-2',
          'Legacy wrong-company evidence remains isolated.',
          '{"record":"LEGACY-2"}', $1::VECTOR, 'fake-embed-v1')`,
      [zeroVector]
    );
    await client.query(
      `CREATE INDEX ${EXPECTED_VECTOR_INDEX_NAME}
         ON agent_memory (company)`
    );
    await client.query("ALTER TABLE agent_memory ENABLE ROW LEVEL SECURITY");
    await client.query(`
      CREATE POLICY agent_memory_tenant_permissive
        ON agent_memory
        AS PERMISSIVE
        FOR SELECT
        TO PUBLIC
        USING (true)
    `);
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function proveFailedClosedDrift(): Promise<void> {
  let rejected = false;
  try {
    await applySchema();
  } catch (error) {
    rejected =
      error instanceof Error &&
      /exact company-scoped CockroachDB C-SPANN index/iu.test(error.message);
  }
  if (!rejected) {
    throw new Error("Same-named non-vector index drift was not rejected.");
  }

  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    const policies = await client.query<{ policyname: string }>(
      `SELECT policyname
         FROM pg_catalog.pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'agent_memory'`
    );
    const names = new Set(policies.rows.map((row) => row.policyname));
    if (
      !names.has("agent_memory_public_demo_permit_v1") ||
      !names.has("agent_memory_public_demo_guard_v1") ||
      names.has("agent_memory_tenant_permissive")
    ) {
      throw new Error("Interrupted migration did not leave fail-closed policies.");
    }
    await client.query(`DROP INDEX ${EXPECTED_VECTOR_INDEX_NAME}`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function verifyFinalState(): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    const rows = await client.query<{
      source_ref: string;
      tenant_id: string;
      status: string;
      content_hash: string | null;
    }>(
      `SELECT source_ref, tenant_id, status, content_hash
         FROM agent_memory
        ORDER BY source_ref`
    );
    if (
      rows.rowCount !== 2 ||
      rows.rows.some(
        (row) =>
          row.tenant_id !== "public-demo" ||
          row.status !== "active" ||
          row.content_hash !== null
      )
    ) {
      throw new Error("Legacy rows/default backfills were not preserved.");
    }

    const index = await client.query<{ indexdef: string }>(
      `SELECT indexdef
         FROM pg_catalog.pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'agent_memory'
          AND indexname = $1`,
      [EXPECTED_VECTOR_INDEX_NAME]
    );
    if (
      index.rowCount !== 1 ||
      !index.rows[0] ||
      !isExpectedVectorIndexDefinition(index.rows[0].indexdef)
    ) {
      throw new Error("Final exact C-SPANN index is missing.");
    }

    await client.query(`
      INSERT INTO agent_memory
        (tenant_id, kind, company, period, source_ref, content, metadata,
         embedding, embed_model, idempotency_key, status)
      VALUES
        ('wrong-tenant', 'validation', 'Helios SA', '2026-04',
         'MIG-CANARY-TENANT', 'Wrong tenant.', '{}',
         $1::VECTOR, 'fake-embed-v1', 'migration-wrong-tenant', 'active'),
        ('public-demo', 'validation', 'Helios SA', '2026-04',
         'MIG-CANARY-STATUS', 'Retracted.', '{}',
         $1::VECTOR, 'fake-embed-v1', 'migration-retracted', 'retracted')
    `, [zeroVector]);
    await client.query("CREATE USER IF NOT EXISTS archon_migration_ci");
    await client.query(
      "GRANT archon_public_reader TO archon_migration_ci"
    );
    await client.query("SET ROLE archon_migration_ci");
    await client.query(
      "SET application_name = 'archon.attacker-selected-scope'"
    );
    const visible = await client.query<{
      total: string;
      correctly_scoped: string;
    }>(
      `SELECT count(*) AS total,
              count(*) FILTER (
                WHERE tenant_id = 'public-demo'
                  AND company = 'Helios SA'
                  AND status = 'active'
              ) AS correctly_scoped
         FROM agent_memory`
    );
    if (
      Number(visible.rows[0]?.total) !== 1 ||
      visible.rows[0]?.total !== visible.rows[0]?.correctly_scoped
    ) {
      throw new Error("Final three-axis RLS behavior is not fail closed.");
    }
    await client.query("RESET ROLE");
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  await setupLegacy();
  await proveFailedClosedDrift();
  await applySchema();
  await applySchema();
  await verifyFinalState();
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      database: databaseName,
      legacyRowsPreserved: 2,
      sameNamedIndexDriftRejected: true,
      failedStateRemainedRestrictive: true,
      idempotentSecondApply: true,
      exactCspannDefinition: true,
      roleBoundThreeAxisRls: true,
    })}\n`
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "unknown failure";
  process.stderr.write(`Schema migration rehearsal failed: ${message}\n`);
  process.exitCode = 1;
});
