import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import {
  auditConsistency,
  type AuditMemory,
} from "../src/memory/consistency.js";
import {
  EXPECTED_VECTOR_INDEX_NAME,
  indexDefinitionFingerprint,
  isExpectedVectorIndexDefinition,
} from "../src/db/proof.js";
import { parseDatabaseSecret } from "../src/db/secret.js";

const { Client } = pg;
type PgClient = InstanceType<typeof Client>;

const region = process.env.AWS_REGION?.trim() || "eu-west-1";
const expectedModel =
  process.env.BEDROCK_EMBED_MODEL_ID?.trim() ||
  "amazon.titan-embed-text-v2:0";
const expectedDatabase =
  process.env.COCKROACH_DATABASE?.trim() || "archon";
const secrets = new SecretsManagerClient({ region });

const PUBLIC_FIXTURE_KEYS = [
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

const ISOLATION_CANARY_KEYS = [
  "archon-demo/v1/rls-hidden-company-canary",
  "archon-demo/v1/rls-wrong-tenant-canary",
  "archon-demo/v1/rls-retracted-status-canary",
] as const;

const CANONICAL_MANIFEST = {
  schemaVersion: 1,
  company: "Helios SA",
  period: "2026-04",
  eventId: "EVT-HELIOS-2604",
  employeeCount: 4,
  grossTotal: 12_300,
  bankNetTotal: 8_600,
  employerCostTotal: 15_375,
  employerSocialSecurityTotal: 3_075,
  offBankCost: 6_775,
  contradiction: {
    record: "INV-2043",
    confirmed: 18_400,
    conflicting: 18_900,
    recommended: 18_400,
    rule: "importance",
  },
  absence: "PAY-118",
  publicFixtureKeys: PUBLIC_FIXTURE_KEYS,
  isolationCanaryKeys: ISOLATION_CANARY_KEYS,
} as const;

const PUBLIC_TABLES = [
  "agent_memory",
  "documents",
  "employees",
  "employee_payroll",
  "payroll_events",
  "payroll_event_payslips",
  "validation_results",
] as const;

interface FixtureRow {
  id: string;
  tenant_id: string;
  kind: string;
  company: string;
  period: string | null;
  source_ref: string | null;
  content: string;
  metadata: Record<string, unknown> | null;
  idempotency_key: string;
  status: string;
  created_at: Date | string;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{2,62}$/iu.test(value)) {
    throw new Error("Database principal has an invalid identifier.");
  }
  return `"${value.replaceAll('"', '""')}"`;
}

function stringArray(value: string[] | string | null): string[] {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  return value
    .replace(/[{}"]/gu, "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function numeric(
  metadata: Record<string, unknown> | null,
  key: string
): number {
  const value = metadata?.[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Canonical fixture metadata ${key} is missing.`);
  }
  return value;
}

async function getDatabaseUrl(secretId: string): Promise<string> {
  const result = await secrets.send(
    new GetSecretValueCommand({ SecretId: secretId })
  );
  if (!result.SecretString) {
    throw new Error("Binary database secrets are unsupported.");
  }
  return parseDatabaseSecret(result.SecretString, { requireTls: true });
}

async function verifyExactIndex(client: PgClient): Promise<string> {
  const index = await client.query<{
    indexname: string;
    indexdef: string;
  }>(
    `SELECT indexname, indexdef
       FROM pg_catalog.pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'agent_memory'
        AND indexname = $1`,
    [EXPECTED_VECTOR_INDEX_NAME]
  );
  const row = index.rows[0];
  if (
    index.rowCount !== 1 ||
    !row ||
    !isExpectedVectorIndexDefinition(row.indexdef)
  ) {
    throw new Error("Exact company-scoped C-SPANN index proof failed.");
  }
  return indexDefinitionFingerprint(row.indexdef);
}

async function verifyRuntimeGrants(
  client: PgClient,
  principal: string,
  databaseName: string
): Promise<void> {
  const principalSql = quoteIdentifier(principal);
  const databaseSql = quoteIdentifier(databaseName);
  const tableGrants = await client.query<{
    schema_name: string;
    table_name: string;
    privilege_type: string;
    is_grantable: boolean;
  }>(`SHOW GRANTS ON TABLE * FOR ${principalSql}`);
  const applicationGrants = tableGrants.rows.filter(
    (grant) =>
      grant.schema_name === "public" &&
      PUBLIC_TABLES.includes(
        grant.table_name as (typeof PUBLIC_TABLES)[number]
      )
  );
  if (
    applicationGrants.length < 1 ||
    applicationGrants.some(
      (grant) =>
        grant.table_name !== "agent_memory" ||
        grant.privilege_type !== "SELECT" ||
        grant.is_grantable
    )
  ) {
    throw new Error("Runtime table privilege matrix is not read-only memory.");
  }

  const schemaGrants = await client.query<{
    privilege_type: string;
    is_grantable: boolean;
  }>(`SHOW GRANTS ON SCHEMA public FOR ${principalSql}`);
  if (
    schemaGrants.rows.length < 1 ||
    schemaGrants.rows.some(
      (grant) =>
        grant.privilege_type !== "USAGE" || grant.is_grantable
    )
  ) {
    throw new Error("Runtime public-schema privilege matrix is unsafe.");
  }

  const databaseGrants = await client.query<{
    privilege_type: string;
    is_grantable: boolean;
  }>(`SHOW GRANTS ON DATABASE ${databaseSql} FOR ${principalSql}`);
  if (
    databaseGrants.rows.length < 1 ||
    databaseGrants.rows.some(
      (grant) =>
        grant.privilege_type !== "CONNECT" || grant.is_grantable
    )
  ) {
    throw new Error("Runtime database privileges exceed CONNECT.");
  }

  const systemGrants = await client.query(
    `SHOW SYSTEM GRANTS FOR ${principalSql}`
  );
  if (systemGrants.rowCount !== 0) {
    throw new Error("Runtime principal unexpectedly has system privileges.");
  }
}

async function verifyRuntime(
  environment: "staging" | "production",
  connectionString: string
): Promise<{
  environment: string;
  principal: string;
  visibleMemories: number;
  canonicalMemories: number;
}> {
  const expectedPrincipal = decodeURIComponent(
    new URL(connectionString).username
  );
  if (
    !new RegExp(`^archon_${environment}_[a-z0-9]{6,40}$`, "u").test(
      expectedPrincipal
    )
  ) {
    throw new Error(`${environment} secret has an unexpected principal.`);
  }

  const client = new Client({ connectionString });
  try {
    await client.connect();
    const identity = await client.query<{
      database_user: string;
      database_name: string;
    }>(
      `SELECT current_user AS database_user,
              current_database() AS database_name`
    );
    const identityRow = identity.rows[0];
    if (
      identityRow?.database_user !== expectedPrincipal ||
      identityRow.database_name !== expectedDatabase
    ) {
      throw new Error(`${environment} runtime database identity is wrong.`);
    }
    await verifyRuntimeGrants(
      client,
      expectedPrincipal,
      identityRow.database_name
    );

    // application_name is attacker-controlled telemetry, never authorization.
    await client.query(
      "SET application_name = 'archon.attacker-selected-scope'"
    );
    const scope = await client.query<{
      visible: string;
      correctly_scoped: string;
      canonical_visible: string;
      isolation_canaries_visible: string;
    }>(
      `SELECT count(*) AS visible,
              count(*) FILTER (
                WHERE tenant_id = 'public-demo'
                  AND company = 'Helios SA'
                  AND status = 'active'
              ) AS correctly_scoped,
              count(*) FILTER (
                WHERE idempotency_key = ANY($1::STRING[])
              ) AS canonical_visible,
              count(*) FILTER (
                WHERE idempotency_key = ANY($2::STRING[])
              ) AS isolation_canaries_visible
         FROM agent_memory`,
      [PUBLIC_FIXTURE_KEYS, ISOLATION_CANARY_KEYS]
    );
    const scopeRow = scope.rows[0];
    const visible = Number(scopeRow?.visible ?? 0);
    const canonicalVisible = Number(scopeRow?.canonical_visible ?? 0);
    if (
      visible < PUBLIC_FIXTURE_KEYS.length ||
      visible !== Number(scopeRow?.correctly_scoped ?? -1) ||
      canonicalVisible !== PUBLIC_FIXTURE_KEYS.length ||
      Number(scopeRow?.isolation_canaries_visible ?? -1) !== 0
    ) {
      throw new Error(`${environment} three-axis RLS proof failed.`);
    }

    await verifyExactIndex(client);
    await expectDenied(
      client,
      `INSERT INTO agent_memory (kind, company, content, embedding, embed_model)
       SELECT kind, company, content, embedding, embed_model
         FROM agent_memory
        WHERE false`,
      `${environment} INSERT`
    );
    await expectDenied(
      client,
      "UPDATE agent_memory SET content = content WHERE id IS NULL",
      `${environment} UPDATE`
    );
    await expectDenied(
      client,
      "DELETE FROM agent_memory WHERE id IS NULL",
      `${environment} DELETE`
    );
    await expectDenied(
      client,
      "SELECT count(*) FROM documents",
      `${environment} non-memory SELECT`
    );
    return {
      environment,
      principal: expectedPrincipal,
      visibleMemories: visible,
      canonicalMemories: canonicalVisible,
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function expectDenied(
  client: PgClient,
  sql: string,
  label: string
): Promise<void> {
  try {
    await client.query(sql);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "42501"
    ) {
      return;
    }
    throw new Error(`${label} failed for an unexpected reason.`);
  }
  throw new Error(`${label} was unexpectedly permitted.`);
}

async function verifyRuntimeRoles(
  client: PgClient,
  principals: string[]
): Promise<void> {
  const expectedUsers = [...principals, "archon_public_reader"];
  const users = await client.query<{
    username: string;
    options: string[] | string;
    member_of: string[] | string;
  }>(
    "SELECT username, options, member_of FROM [SHOW USERS] WHERE username = ANY($1::STRING[])",
    [expectedUsers]
  );
  if (users.rows.length !== expectedUsers.length) {
    throw new Error("Runtime role catalog is incomplete.");
  }
  for (const user of users.rows) {
    const memberships = stringArray(user.member_of);
    const options = stringArray(user.options).map((option) =>
      option.toUpperCase()
    );
    const dangerousOptions = new Set([
      "ADMIN",
      "BYPASSRLS",
      "CANCELQUERY",
      "CONTROLJOB",
      "CREATEROLE",
      "MODIFYCLUSTERSETTING",
      "VIEWACTIVITY",
      "VIEWACTIVITYREDACTED",
      "VIEWCLUSTERSETTING",
    ]);
    const hasDangerousOption = options.some((option) =>
      dangerousOptions.has(option.split(/[=\s]/u, 1)[0] ?? option)
    );
    if (user.username === "archon_public_reader") {
      if (
        memberships.length !== 0 ||
        hasDangerousOption ||
        !options.includes("NOLOGIN") ||
        options.includes("LOGIN")
      ) {
        throw new Error("archon_public_reader is not a bounded base role.");
      }
      continue;
    }
    if (
      memberships.length !== 1 ||
      memberships[0] !== "archon_public_reader" ||
      hasDangerousOption
    ) {
      throw new Error(`Runtime role ${user.username} is not least privilege.`);
    }
  }
}

async function verifyAdmin(
  adminUrl: string,
  runtimePrincipals: string[]
): Promise<{
  version: string;
  databaseName: string;
  fixtureRows: number;
  indexDefinitionFingerprint: string;
}> {
  const client = new Client({ connectionString: adminUrl });
  try {
    await client.connect();
    const database = await client.query<{
      version: string;
      database_name: string;
    }>(
      "SELECT version() AS version, current_database() AS database_name"
    );
    const databaseRow = database.rows[0];
    if (
      !databaseRow?.version.includes("CockroachDB") ||
      databaseRow.database_name !== expectedDatabase
    ) {
      throw new Error("Database engine/name proof failed.");
    }

    const allKeys = [
      ...PUBLIC_FIXTURE_KEYS,
      ...ISOLATION_CANARY_KEYS,
    ];
    const fixtures = await client.query<FixtureRow>(
      `SELECT id, tenant_id, kind, company, period, source_ref, content,
              metadata, idempotency_key, status, created_at
         FROM agent_memory
        WHERE embed_model = $1
          AND idempotency_key = ANY($2::STRING[])`,
      [expectedModel, allKeys]
    );
    const fixtureCount = fixtures.rows.length;
    if (fixtureCount !== allKeys.length) {
      throw new Error("Canonical synthetic fixture manifest is incomplete.");
    }
    const byKey = new Map(
      fixtures.rows.map((row) => [row.idempotency_key, row])
    );
    if (byKey.size !== allKeys.length) {
      throw new Error("Canonical fixture keys are not unique.");
    }

    const summary = byKey.get(
      "archon-event/v1/EVT-HELIOS-2604/summary"
    );
    const insight = byKey.get(
      "archon-event/v1/EVT-HELIOS-2604/off-bank-cost"
    );
    if (
      !summary ||
      summary.tenant_id !== "public-demo" ||
      summary.company !== "Helios SA" ||
      summary.period !== "2026-04" ||
      summary.source_ref !== "EVT-HELIOS-2604" ||
      summary.status !== "active" ||
      numeric(summary.metadata, "employee_count") !== 4 ||
      numeric(summary.metadata, "gross_total") !== 12_300 ||
      numeric(summary.metadata, "bank_net_total") !== 8_600 ||
      numeric(summary.metadata, "employer_cost_total") !== 15_375 ||
      !insight ||
      insight.tenant_id !== "public-demo" ||
      insight.company !== "Helios SA" ||
      insight.period !== "2026-04" ||
      insight.status !== "active" ||
      numeric(insight.metadata, "off_bank_cost") !== 6_775 ||
      numeric(insight.metadata, "employer_social_security_total") !== 3_075 ||
      numeric(insight.metadata, "importance") !== 0.9
    ) {
      throw new Error("Canonical headline financial evidence drifted.");
    }

    const wrongCompany = byKey.get(
      "archon-demo/v1/rls-hidden-company-canary"
    );
    const wrongTenant = byKey.get(
      "archon-demo/v1/rls-wrong-tenant-canary"
    );
    const retracted = byKey.get(
      "archon-demo/v1/rls-retracted-status-canary"
    );
    if (
      wrongCompany?.tenant_id !== "public-demo" ||
      wrongCompany.company !== "Isolation Canary Ltd" ||
      wrongCompany.status !== "active" ||
      wrongTenant?.tenant_id !== "isolation-canary" ||
      wrongTenant.company !== "Helios SA" ||
      wrongTenant.status !== "active" ||
      retracted?.tenant_id !== "public-demo" ||
      retracted.company !== "Helios SA" ||
      retracted.status !== "retracted"
    ) {
      throw new Error("Three-axis RLS canary manifest drifted.");
    }

    const auditRows = fixtures.rows.filter(
      (row) =>
        row.tenant_id === "public-demo" &&
        row.company === "Helios SA" &&
        row.status === "active"
    );
    const memories: AuditMemory[] = auditRows.map((row) => ({
      id: row.id,
      kind: row.kind,
      company: row.company,
      period: row.period,
      sourceRef: row.source_ref,
      content: row.content,
      metadata: row.metadata,
      createdAt:
        row.created_at instanceof Date
          ? row.created_at.toISOString()
          : String(row.created_at),
    }));
    const audit = auditConsistency(memories);
    const contradiction = audit.contradictions.find(
      (item) => item.subject === "INV-2043" && item.attribute === "total"
    );
    if (
      !contradiction ||
      contradiction.resolution.recommendedValue !== 18_400 ||
      contradiction.resolution.rule !== "importance" ||
      !audit.absences.some((item) => item.subject === "PAY-118")
    ) {
      throw new Error("Canonical contradiction/absence proof failed.");
    }

    const indexFingerprint = await verifyExactIndex(client);
    const vector = await client.query<{ embedding: string }>(
      `SELECT embedding::STRING AS embedding
         FROM agent_memory
        WHERE idempotency_key = $1
          AND embed_model = $2`,
      [PUBLIC_FIXTURE_KEYS[0], expectedModel]
    );
    const explain = await client.query(
      `EXPLAIN SELECT id
         FROM agent_memory@${EXPECTED_VECTOR_INDEX_NAME}
        WHERE tenant_id = 'public-demo'
          AND embed_model = $2
          AND status = 'active'
          AND company = 'Helios SA'
        ORDER BY embedding <=> $1::VECTOR
        LIMIT 5`,
      [vector.rows[0]?.embedding, expectedModel]
    );
    const plan = explain.rows
      .flatMap((row) => Object.values(row))
      .map(String)
      .join("\n");
    if (
      !/vector search/iu.test(plan) ||
      !plan.includes(EXPECTED_VECTOR_INDEX_NAME)
    ) {
      throw new Error("Production-shaped recall did not plan exact C-SPANN search.");
    }

    await verifyRuntimeRoles(client, runtimePrincipals);
    return {
      version: databaseRow.version.split(" ").slice(0, 3).join(" "),
      databaseName: databaseRow.database_name,
      fixtureRows: fixtureCount,
      indexDefinitionFingerprint: indexFingerprint,
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

function releaseDigests(): {
  schemaSha256: string;
  fixtureManifestSha256: string;
} {
  const here = dirname(fileURLToPath(import.meta.url));
  const schema = readFileSync(
    join(here, "..", "src", "db", "schema.sql"),
    "utf8"
  );
  return {
    schemaSha256: createHash("sha256").update(schema, "utf8").digest("hex"),
    fixtureManifestSha256: createHash("sha256")
      .update(JSON.stringify(CANONICAL_MANIFEST), "utf8")
      .digest("hex"),
  };
}

async function main(): Promise<void> {
  if (region !== "eu-west-1") {
    throw new Error("Database release is restricted to eu-west-1.");
  }
  const targetSha = required("TARGET_SHA");
  if (!/^[a-f0-9]{40}$/u.test(targetSha)) {
    throw new Error("TARGET_SHA must be a full lowercase Git commit SHA.");
  }
  const clusterId = required("COCKROACH_CLUSTER_ID");
  const cloudProvider = required("COCKROACH_CLOUD_PROVIDER");
  const cloudPlan = required("COCKROACH_CLOUD_PLAN");
  const cloudRegion = required("COCKROACH_CLOUD_REGION");
  const cloudVersion = required("COCKROACH_CLOUD_VERSION");
  if (
    cloudProvider !== "AWS" ||
    cloudPlan !== "BASIC" ||
    cloudRegion !== "eu-west-1" ||
    !/^v26\./u.test(cloudVersion)
  ) {
    throw new Error("Cockroach Cloud API release-gate metadata is invalid.");
  }

  const [stagingUrl, productionUrl] = await Promise.all([
    getDatabaseUrl(required("STAGING_DATABASE_SECRET_ID")),
    getDatabaseUrl(required("PRODUCTION_DATABASE_SECRET_ID")),
  ]);
  const runtimePrincipals = [stagingUrl, productionUrl].map((url) =>
    decodeURIComponent(new URL(url).username)
  );
  const admin = await verifyAdmin(
    required("DATABASE_URL"),
    runtimePrincipals
  );
  const [staging, production] = await Promise.all([
    verifyRuntime("staging", stagingUrl),
    verifyRuntime("production", productionUrl),
  ]);
  const digests = releaseDigests();

  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 2,
        ok: true,
        targetSha,
        region,
        cockroachCloud: {
          clusterId,
          provider: cloudProvider,
          plan: cloudPlan,
          region: cloudRegion,
          version: cloudVersion,
          evidence: "Cockroach Cloud API v1 2024-09-16 release gate",
        },
        database: {
          engine: "CockroachDB",
          name: admin.databaseName,
          sqlVersion: admin.version,
        },
        embeddingModel: expectedModel,
        fixtureRows: admin.fixtureRows,
        releaseDigests: digests,
        proofs: {
          companyScopedVectorIndex: true,
          productionShapedVectorSearchPlan: true,
          indexDefinitionFingerprint: admin.indexDefinitionFingerprint,
          roleBoundRls: true,
          attackerSelectedApplicationNameIgnored: true,
          wrongCompanyInvisible: true,
          wrongTenantInvisible: true,
          retractedStatusInvisible: true,
          runtimeTablePrivilegeMatrix: "SELECT agent_memory only",
          runtimeSchemaPrivilegeMatrix: "USAGE only",
          runtimeDatabasePrivilegeMatrix: "CONNECT only",
          runtimeSystemPrivileges: "none",
          contradiction: "INV-2043.total",
          recommendedValue: 18_400,
          absence: "PAY-118",
          headlineEmployerCost: 15_375,
          headlineBankNet: 8_600,
          headlineOffBankCost: 6_775,
          headlineEmployerSocialSecurity: 3_075,
        },
        runtimes: [staging, production],
        secretMaterialPrinted: false,
        generatedAt: new Date().toISOString(),
      },
      null,
      2
    )}\n`
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "unknown failure";
  process.stderr.write(`Database release verification failed: ${message}\n`);
  process.exitCode = 1;
});
