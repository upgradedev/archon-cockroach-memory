// CI-only real-CockroachDB rehearsal for the forward migration path.
// It starts from the legacy agent_memory shape, injects a same-named wrong
// index, proves catalog verification fails closed, repairs the drift, applies
// the current schema twice, and verifies preserved data + exact RLS behavior.

import pg from "pg";
import { applySchema } from "./apply-schema.js";
import {
  EXPECTED_KIND_VECTOR_INDEX_NAME,
  EXPECTED_VECTOR_INDEX_NAME,
  PUBLIC_KIND_RECALL_VIEW_NAME,
  PUBLIC_RECALL_VIEW_NAME,
  isExpectedKindVectorIndexDefinition,
  isExpectedVectorIndexDefinition,
} from "../src/db/proof.js";
import {
  buildRecallQuery,
  type RecallQueryRow,
} from "../src/memory/memory.js";
import {
  expectedRuntimeDatabaseGrants,
  verifyClusterWideResolutionGrants,
  type ClusterGrantProof,
} from "../src/db/cluster-grant-proof.js";

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

const unitVector = `[1,${new Array(1023).fill("0").join(",")}]`;
const expectedRuntimeRelationGrants = new Set([
  "agent_memory:SELECT",
  `${PUBLIC_RECALL_VIEW_NAME}:SELECT`,
  `${PUBLIC_KIND_RECALL_VIEW_NAME}:SELECT`,
  "memory_demo_sessions:SELECT",
  "memory_resolution_observations:SELECT",
  "memory_resolution_proposals:SELECT",
  "memory_resolution_decisions:SELECT",
  "memory_resolution_consolidations:SELECT",
]);

function assertExactMigrationGrantProof(
  proof: ClusterGrantProof
): void {
  const expectedInventory = [
    databaseName,
    "defaultdb",
    "postgres",
    "system",
  ].sort();
  if (
    proof.routineGrantCount !== 2 ||
    proof.databaseGrantCount !== 5 ||
    JSON.stringify([...proof.databaseInventory].sort()) !==
      JSON.stringify(expectedInventory) ||
    !/^[a-f0-9]{64}$/u.test(proof.databaseMatrixSha256)
  ) {
    throw new Error(
      "Migration runtime grant proof did not bind the exact five-row matrix."
    );
  }
}

async function expectClusterGrantProofRejected(
  expectedMessage =
    "Cluster-wide database privileges do not match the exact principal matrix."
): Promise<void> {
  try {
    await verifyClusterWideResolutionGrants({
      adminConnectionString: databaseUrl,
      principal: "archon_migration_ci",
      applicationDatabase: databaseName,
      expectedDatabaseGrants: expectedRuntimeDatabaseGrants(
        databaseName,
        "archon_migration_ci"
      ),
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === expectedMessage
    ) {
      return;
    }
    throw error;
  }
  throw new Error("Cluster-wide runtime database-grant drift was accepted.");
}
async function expectInsufficientPrivilege(
  operation: () => Promise<unknown>
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "42501"
    ) {
      return;
    }
    throw error;
  }
  throw new Error("Runtime direct DML unexpectedly succeeded.");
}

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
      [unitVector]
    );
    await client.query(
      `CREATE INDEX ${EXPECTED_VECTOR_INDEX_NAME}
         ON agent_memory (company)`
    );
    await client.query(
      `CREATE INDEX ${EXPECTED_KIND_VECTOR_INDEX_NAME}
         ON agent_memory (kind)`
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
      /exact public-serving CockroachDB C-SPANN index/iu.test(error.message);
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
    await client.query(`DROP VIEW IF EXISTS ${PUBLIC_RECALL_VIEW_NAME}`);
    await client.query(
      `DROP VIEW IF EXISTS ${PUBLIC_KIND_RECALL_VIEW_NAME}`
    );
    await client.query(`DROP INDEX ${EXPECTED_VECTOR_INDEX_NAME}`);
    await client.query(`DROP INDEX ${EXPECTED_KIND_VECTOR_INDEX_NAME}`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function verifyFinalState(): Promise<ClusterGrantProof> {
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

    const indexes = await client.query<{
      indexname: string;
      indexdef: string;
    }>(
      `SELECT indexname, indexdef
         FROM pg_catalog.pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'agent_memory'
          AND indexname = ANY($1::STRING[])`,
      [[EXPECTED_VECTOR_INDEX_NAME, EXPECTED_KIND_VECTOR_INDEX_NAME]]
    );
    const indexByName = new Map(
      indexes.rows.map((index) => [index.indexname, index.indexdef])
    );
    if (
      indexes.rowCount !== 2 ||
      !isExpectedVectorIndexDefinition(
        indexByName.get(EXPECTED_VECTOR_INDEX_NAME) ?? "",
        databaseName
      ) ||
      !isExpectedKindVectorIndexDefinition(
        indexByName.get(EXPECTED_KIND_VECTOR_INDEX_NAME) ?? "",
        databaseName
      )
    ) {
      throw new Error("Final exact C-SPANN indexes are missing.");
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
    `, [unitVector]);
    await client.query("CREATE USER IF NOT EXISTS archon_migration_ci");
    await client.query(
      `GRANT CONNECT ON DATABASE "${databaseName}" TO archon_migration_ci`
    );
    await client.query(
      "GRANT archon_public_reader TO archon_migration_ci"
    );
    await client.query(
      "GRANT archon_resolution_writer TO archon_migration_ci"
    );
    const runtimeGrants = await client.query<{
      table_name: string;
      privilege_type: string;
      is_grantable: boolean;
    }>(
      `SHOW GRANTS ON TABLE *
         FOR archon_migration_ci`
    );
    const grantKeys = new Set(
      runtimeGrants.rows.map(
        (grant) => `${grant.table_name}:${grant.privilege_type}`
      )
    );
    if (
      runtimeGrants.rows.length !== expectedRuntimeRelationGrants.size ||
      grantKeys.size !== expectedRuntimeRelationGrants.size ||
      runtimeGrants.rows.some((grant) => grant.is_grantable) ||
      [...expectedRuntimeRelationGrants].some(
        (grant) => !grantKeys.has(grant)
      ) ||
      [...grantKeys].some((grant) => !grant.endsWith(":SELECT"))
    ) {
      throw new Error(
        "Migrated runtime relation grants are not exact SELECT-only access."
      );
    }
    const grantProofInput = {
      adminConnectionString: databaseUrl,
      principal: "archon_migration_ci",
      applicationDatabase: databaseName,
      expectedDatabaseGrants: expectedRuntimeDatabaseGrants(
        databaseName,
        "archon_migration_ci"
      ),
    } as const;
    assertExactMigrationGrantProof(
      await verifyClusterWideResolutionGrants(grantProofInput)
    );

    let temporaryGranted = false;
    try {
      await client.query(
        `GRANT TEMPORARY ON DATABASE "${databaseName}" TO archon_migration_ci`
      );
      temporaryGranted = true;
      await expectClusterGrantProofRejected();
    } finally {
      if (temporaryGranted) {
        await client.query(
          `REVOKE TEMPORARY ON DATABASE "${databaseName}" FROM archon_migration_ci`
        );
      }
    }
    assertExactMigrationGrantProof(
      await verifyClusterWideResolutionGrants(grantProofInput)
    );

    let grantOptionElevated = false;
    try {
      await client.query(
        `GRANT CONNECT ON DATABASE "${databaseName}" TO archon_migration_ci WITH GRANT OPTION`
      );
      grantOptionElevated = true;
      await expectClusterGrantProofRejected();
    } finally {
      if (grantOptionElevated) {
        await client.query(
          `REVOKE CONNECT ON DATABASE "${databaseName}" FROM archon_migration_ci`
        );
        await client.query(
          `GRANT CONNECT ON DATABASE "${databaseName}" TO archon_migration_ci`
        );
      }
    }
    assertExactMigrationGrantProof(
      await verifyClusterWideResolutionGrants(grantProofInput)
    );

    let unexpectedDatabaseCreated = false;
    try {
      await client.query("CREATE DATABASE archon_unexpected_grants_ci");
      unexpectedDatabaseCreated = true;
      await client.query(
        "REVOKE CONNECT, TEMPORARY ON DATABASE archon_unexpected_grants_ci FROM public"
      );
      await expectClusterGrantProofRejected(
        "Cluster-wide grant proof could not bind the exact database inventory."
      );
    } finally {
      if (unexpectedDatabaseCreated) {
        await client.query(
          "DROP DATABASE archon_unexpected_grants_ci CASCADE"
        );
      }
    }
    const finalClusterGrantProof =
      await verifyClusterWideResolutionGrants(grantProofInput);
    assertExactMigrationGrantProof(finalClusterGrantProof);
    await client.query("SET ROLE archon_migration_ci");
    await client.query(
      "SET application_name = 'archon.attacker-selected-scope'"
    );
    await expectInsufficientPrivilege(() =>
      client.query(
        "UPDATE public.memory_demo_sessions SET state = state WHERE false"
      )
    );
    await expectInsufficientPrivilege(() =>
      client.query(
        "INSERT INTO public.memory_resolution_decisions DEFAULT VALUES"
      )
    );
    await expectInsufficientPrivilege(() =>
      client.query(
        "DELETE FROM public.memory_resolution_consolidations WHERE false"
      )
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

    const probe = await client.query<{ embedding: string }>(
      `SELECT embedding::STRING AS embedding
         FROM agent_memory
        WHERE source_ref = 'LEGACY-1'
        LIMIT 1`
    );
    const embedding = probe.rows[0]?.embedding;
    if (!embedding) {
      throw new Error("Runtime migration probe is not visible.");
    }
    for (const path of [
      {
        kind: undefined,
        expectedIndex: EXPECTED_VECTOR_INDEX_NAME,
      },
      {
        kind: "insight" as const,
        expectedIndex: EXPECTED_KIND_VECTOR_INDEX_NAME,
      },
    ]) {
      const statement = buildRecallQuery(embedding, "fake-embed-v1", {
        company: "Helios SA",
        kind: path.kind,
        limit: 5,
      });
      const explain = await client.query<Record<string, unknown>>(
        `EXPLAIN ${statement.text}`,
        statement.params
      );
      const plan = explain.rows
        .flatMap((row) => Object.values(row))
        .map(String)
        .join("\n");
      const result = await client.query<RecallQueryRow>(
        statement.text,
        statement.params
      );
      if (
        !/vector search/iu.test(plan) ||
        !plan.includes(path.expectedIndex) ||
        statement.expectedIndexName !== path.expectedIndex ||
        result.rows.length < 1 ||
        !result.rows.some((row) => row.source_ref === "LEGACY-1") ||
        result.rows.some(
          (row) =>
            row.tenant_id !== "public-demo" ||
            row.company !== "Helios SA" ||
            row.status !== "active" ||
            row.embed_model !== "fake-embed-v1" ||
            !Number.isFinite(Number(row.distance))
        )
      ) {
        throw new Error("Runtime-principal C-SPANN migration proof failed.");
      }
    }
    await client.query("RESET ROLE");
    return finalClusterGrantProof;
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  await setupLegacy();
  await proveFailedClosedDrift();
  await applySchema();
  await applySchema();
  const clusterGrantProof = await verifyFinalState();
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      database: databaseName,
      legacyRowsPreserved: 2,
      sameNamedIndexDriftRejected: true,
      failedStateRemainedRestrictive: true,
      idempotentSecondApply: true,
      exactCspannDefinition: true,
      exactKindCspannDefinition: true,
      roleBoundThreeAxisRls: true,
      runtimePrincipalCspannPlanAndExecute: true,
      exactFiveTableResolutionSandbox: true,
      resolutionWriterMembership: true,
      exactTransitionFunctionExecute: true,
      directResolutionDmlDenied: true,
      canonicalMemoryRemainsReadOnly: true,
      appTemporaryGrantDriftRejected: true,
      databaseGrantOptionDriftRejected: true,
      extraDatabaseGrantDriftRejected: true,
      clusterGrantProof,
    })}\n`
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "unknown failure";
  process.stderr.write(`Schema migration rehearsal failed: ${message}\n`);
  process.exitCode = 1;
});
