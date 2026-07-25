import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg, { type QueryResult, type QueryResultRow } from "pg";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import {
  auditConsistency,
  type AuditMemory,
} from "../src/memory/consistency.js";
import {
  EXPECTED_KIND_VECTOR_INDEX_NAME,
  EXPECTED_VECTOR_INDEX_NAME,
  PUBLIC_KIND_RECALL_VIEW_NAME,
  PUBLIC_RECALL_VIEW_NAME,
  PUBLIC_RECALL_VIEW_OWNER,
  indexDefinitionFingerprint,
  isExpectedKindVectorIndexDefinition,
  isExpectedPublicRecallViewDefinition,
  isExpectedVectorIndexDefinition,
} from "../src/db/proof.js";
import {
  buildRecallQuery,
  type MemoryKind,
  type RecallQuery,
  type RecallQueryRow,
} from "../src/memory/memory.js";
import {
  affirmativeSystemGrants,
  type SystemGrant,
} from "../src/db/system-grants.js";
import { parseDatabaseSecret } from "../src/db/secret.js";

const { Client } = pg;
type PgClient = InstanceType<typeof Client>;

class ReleaseGateError extends Error {
  override readonly name = "ReleaseGateError";
}

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

interface RuntimeCspannPathProof {
  servingPath: RecallQuery["servingPath"];
  view: string;
  index: string;
  kind?: MemoryKind;
  vectorSearchPlanned: true;
  executed: true;
  scopeVerified: true;
  probeReturned: true;
  scopedServingQueryVerified: true;
  isolationCanariesRejected: number;
  returnedRows: number;
  queryTemplateSha256: string;
}

interface RuntimeCspannProof {
  noKind: RuntimeCspannPathProof;
  kind: RuntimeCspannPathProof;
}

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

interface IsolationCanaryVector {
  idempotencyKey: string;
  kind: MemoryKind;
  embedding: string;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new ReleaseGateError(`${name} is required.`);
  return value;
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{2,62}$/iu.test(value)) {
    throw new ReleaseGateError(
      "Database principal has an invalid identifier."
    );
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
    throw new ReleaseGateError(
      `Canonical fixture metadata ${key} is missing.`
    );
  }
  return value;
}

async function getDatabaseUrl(secretId: string): Promise<string> {
  const result = await secrets.send(
    new GetSecretValueCommand({ SecretId: secretId })
  );
  if (!result.SecretString) {
    throw new ReleaseGateError("Binary database secrets are unsupported.");
  }
  return parseDatabaseSecret(result.SecretString, { requireTls: true });
}

async function verifyExactIndexes(
  client: PgClient,
  databaseName = expectedDatabase
): Promise<{
  company: string;
  kind: string;
}> {
  const index = await client.query<{
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
  const byName = new Map(
    index.rows.map((row) => [row.indexname, row.indexdef])
  );
  const company = byName.get(EXPECTED_VECTOR_INDEX_NAME);
  const kind = byName.get(EXPECTED_KIND_VECTOR_INDEX_NAME);
  if (
    index.rowCount !== 2 ||
    !company ||
    !kind ||
    !isExpectedVectorIndexDefinition(company, databaseName) ||
    !isExpectedKindVectorIndexDefinition(kind, databaseName)
  ) {
    throw new ReleaseGateError(
      "Exact public-serving C-SPANN index proof failed."
    );
  }
  return {
    company: indexDefinitionFingerprint(company),
    kind: indexDefinitionFingerprint(kind),
  };
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
  const applicationGrants = tableGrants.rows;
  const grantedRelations = new Set(
    applicationGrants.map((grant) => grant.table_name)
  );
  const expectedRelations = new Set([
    "agent_memory",
    PUBLIC_RECALL_VIEW_NAME,
    PUBLIC_KIND_RECALL_VIEW_NAME,
  ]);
  if (
    applicationGrants.length !== expectedRelations.size ||
    grantedRelations.size !== expectedRelations.size ||
    [...expectedRelations].some(
      (relation) => !grantedRelations.has(relation)
    ) ||
    applicationGrants.some(
      (grant) =>
        grant.schema_name !== "public" ||
        grant.privilege_type !== "SELECT" ||
        grant.is_grantable
    )
  ) {
    throw new ReleaseGateError(
      "Runtime relation privilege matrix is not exact read-only memory."
    );
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
    throw new ReleaseGateError(
      "Runtime public-schema privilege matrix is unsafe."
    );
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
    throw new ReleaseGateError(
      "Runtime database privileges exceed CONNECT."
    );
  }

  const systemGrants = await client.query<SystemGrant>(
    `SHOW SYSTEM GRANTS FOR ${principalSql}`
  );
  const affirmativeGrants = affirmativeSystemGrants(systemGrants.rows);
  if (affirmativeGrants.length !== 0) {
    const privilegeTypes = [
      ...new Set(
        affirmativeGrants.map((grant) => grant.privilege_type.toUpperCase())
      ),
    ].sort();
    throw new ReleaseGateError(
      `Runtime principal has affirmative system privileges: ${privilegeTypes.join(", ")}.`
    );
  }
}

function safeSqlState(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[0-9A-Z]{5}$/u.test(error.code)
  ) {
    return error.code;
  }
  return "unavailable";
}

function safeReleaseFailureMessage(error: unknown): string {
  const sqlState = safeSqlState(error);
  if (sqlState !== "unavailable") {
    return `database operation failed (SQLSTATE ${sqlState})`;
  }
  if (error instanceof ReleaseGateError) {
    return error.message;
  }
  return "external dependency failure (details redacted)";
}

async function safeRuntimeQuery<T extends QueryResultRow>(
  client: PgClient,
  sql: string,
  params: unknown[],
  label: string
): Promise<QueryResult<T>> {
  try {
    return await client.query<T>(sql, params);
  } catch (error) {
    throw new ReleaseGateError(
      `${label} failed (SQLSTATE ${safeSqlState(error)}).`
    );
  }
}

async function verifyScopedServingQueryCanaries(
  client: PgClient,
  environment: "staging" | "production",
  input: {
    label: "no-kind" | "kind";
    probeKey: string;
    probeEmbedding: string;
    kind?: MemoryKind;
    expectedView: string;
    expectedIndex: string;
  },
  canaryVectors: IsolationCanaryVector[]
): Promise<number> {
  const label =
    `${environment} runtime ${input.label} scoped serving-query canaries`;
  if (canaryVectors.length !== ISOLATION_CANARY_KEYS.length) {
    throw new ReleaseGateError(`${label} canary manifest is incomplete.`);
  }
  await safeRuntimeQuery<Record<string, unknown>>(
    client,
    "SET vector_search_beam_size = 600",
    [],
    `${label} high-recall beam`
  );
  const statement = (embedding: string): RecallQuery => {
    // Reuse the production builder: CockroachDB v26.2.1 requires every
    // C-SPANN prefix equality and rejects residual non-prefix filters on the
    // accelerated path. Inspect canary keys in TypeScript rather than adding
    // an idempotency_key SQL predicate that would invalidate FORCE_INDEX.
    const query = buildRecallQuery(embedding, expectedModel, {
      company: "Helios SA",
      kind: input.kind,
      limit: 50,
    });
    if (
      !query.fixedPublicScope ||
      query.relation !== input.expectedView ||
      query.expectedIndexName !== input.expectedIndex ||
      /idempotency_key\s*=/u.test(query.text)
    ) {
      throw new ReleaseGateError(`${label} shared query routing drifted.`);
    }
    return query;
  };

  // Exact catalog/owner/grant checks prove the definer-view boundary. These
  // runtime probes separately prove the fully scoped production query returns
  // only public rows and rejects all three sentinel keys under a high beam.
  try {
    const publicProbe = statement(input.probeEmbedding);
    const visible = await safeRuntimeQuery<RecallQueryRow>(
      client,
      publicProbe.text,
      publicProbe.params,
      `${label} public control`
    );
    const control = visible.rows.find(
      (row) => row.idempotency_key === input.probeKey
    );
    const visibleScopeValid = visible.rows.every(
      (row) =>
        row.tenant_id === "public-demo" &&
        row.company === "Helios SA" &&
        row.status === "active" &&
        row.embed_model === expectedModel &&
        (input.kind === undefined || row.kind === input.kind) &&
        Number.isFinite(Number(row.distance))
    );
    if (
      visible.rows.length < 1 ||
      visible.rows.length > 50 ||
      !visibleScopeValid ||
      !control ||
      Math.abs(Number(control.distance)) > 0.00001
    ) {
      throw new ReleaseGateError(`${label} public control failed.`);
    }

    for (const canary of canaryVectors) {
      if (input.kind !== undefined && canary.kind !== input.kind) {
        throw new ReleaseGateError(`${label} canary kind drifted.`);
      }
      const canaryStatement = statement(canary.embedding);
      const scopedRows = await safeRuntimeQuery<RecallQueryRow>(
        client,
        canaryStatement.text,
        canaryStatement.params,
        `${label} isolation canary`
      );
      const leaked = scopedRows.rows.some(
        (row) => row.idempotency_key === canary.idempotencyKey
      );
      const publicControlMissing = !scopedRows.rows.some(
        (row) => row.idempotency_key === input.probeKey
      );
      const scopeDrifted = scopedRows.rows.some(
        (row) =>
          row.tenant_id !== "public-demo" ||
          row.company !== "Helios SA" ||
          row.status !== "active" ||
          row.embed_model !== expectedModel ||
          (input.kind !== undefined && row.kind !== input.kind) ||
          !Number.isFinite(Number(row.distance))
      );
      if (
        leaked ||
        publicControlMissing ||
        scopeDrifted ||
        scopedRows.rows.length < 1 ||
        scopedRows.rows.length > 50
      ) {
        throw new ReleaseGateError(
          `${label} exposed an isolation canary or scope drift.`
        );
      }
    }
    return canaryVectors.length;
  } finally {
    await safeRuntimeQuery<Record<string, unknown>>(
      client,
      "RESET vector_search_beam_size",
      [],
      `${label} beam reset`
    );
  }
}

async function verifyRuntimeCspannPath(
  client: PgClient,
  environment: "staging" | "production",
  input: {
    label: "no-kind" | "kind";
    probeKey: string;
    kind?: MemoryKind;
    expectedServingPath:
      | "public-no-kind-cspann"
      | "public-kind-cspann";
    expectedView: string;
    expectedIndex: string;
  },
  canaryVectors: IsolationCanaryVector[]
): Promise<RuntimeCspannPathProof> {
  const label = `${environment} runtime ${input.label} C-SPANN`;
  const vector = await safeRuntimeQuery<{ embedding: string }>(
    client,
    `SELECT embedding::STRING AS embedding
       FROM agent_memory
      WHERE tenant_id = 'public-demo'
        AND company = 'Helios SA'
        AND status = 'active'
        AND embed_model = $1
        AND idempotency_key = $2
      LIMIT 1`,
    [expectedModel, input.probeKey],
    `${label} probe`
  );
  const embedding = vector.rows[0]?.embedding;
  if (vector.rowCount !== 1 || !embedding) {
    throw new ReleaseGateError(
      `${label} probe is not uniquely visible.`
    );
  }

  const statement = buildRecallQuery(embedding, expectedModel, {
    company: "Helios SA",
    kind: input.kind,
    limit: 5,
  });
  if (
    !statement.fixedPublicScope ||
    statement.servingPath !== input.expectedServingPath ||
    statement.relation !== input.expectedView ||
    statement.expectedIndexName !== input.expectedIndex
  ) {
    throw new ReleaseGateError(`${label} shared query routing drifted.`);
  }

  const explain = await safeRuntimeQuery<Record<string, unknown>>(
    client,
    `EXPLAIN ${statement.text}`,
    statement.params,
    `${label} EXPLAIN`
  );
  const plan = explain.rows
    .flatMap((row) => Object.values(row))
    .map(String)
    .join("\n");
  if (
    !/vector search/iu.test(plan) ||
    !plan.includes(input.expectedIndex)
  ) {
    throw new ReleaseGateError(
      `${label} did not plan the exact vector index.`
    );
  }

  const execution = await safeRuntimeQuery<RecallQueryRow>(
    client,
    statement.text,
    statement.params,
    `${label} execution`
  );
  const returnedRows = execution.rowCount ?? execution.rows.length;
  if (returnedRows < 1 || returnedRows > 5) {
    throw new ReleaseGateError(
      `${label} returned an invalid bounded result set.`
    );
  }
  const scopeVerified = execution.rows.every(
    (row) =>
      row.tenant_id === "public-demo" &&
      row.company === "Helios SA" &&
      row.status === "active" &&
      row.embed_model === expectedModel &&
      (input.kind === undefined || row.kind === input.kind)
  );
  const distancesValid = execution.rows.every((row) => {
    const distance = Number(row.distance);
    return (
      Number.isFinite(distance) &&
      distance >= -0.000001 &&
      distance <= 2.000001
    );
  });
  const probe = execution.rows.find(
    (row) => row.idempotency_key === input.probeKey
  );
  if (
    !scopeVerified ||
    !distancesValid ||
    !probe ||
    Math.abs(Number(probe.distance)) > 0.00001
  ) {
    throw new ReleaseGateError(`${label} execution proof failed.`);
  }
  const isolationCanariesRejected =
    await verifyScopedServingQueryCanaries(
      client,
      environment,
      {
        label: input.label,
        probeKey: input.probeKey,
        probeEmbedding: embedding,
        kind: input.kind,
        expectedView: input.expectedView,
        expectedIndex: input.expectedIndex,
      },
      canaryVectors
    );

  return {
    servingPath: statement.servingPath,
    view: input.expectedView,
    index: input.expectedIndex,
    ...(input.kind ? { kind: input.kind } : {}),
    vectorSearchPlanned: true,
    executed: true,
    scopeVerified: true,
    probeReturned: true,
    scopedServingQueryVerified: true,
    isolationCanariesRejected,
    returnedRows,
    queryTemplateSha256: createHash("sha256")
      .update(statement.text, "utf8")
      .digest("hex"),
  };
}

async function verifyRuntime(
  environment: "staging" | "production",
  connectionString: string,
  canaryVectors: IsolationCanaryVector[]
): Promise<{
  environment: string;
  principal: string;
  visibleMemories: number;
  canonicalMemories: number;
  cspannRecall: RuntimeCspannProof;
}> {
  const expectedPrincipal = decodeURIComponent(
    new URL(connectionString).username
  );
  if (
    !new RegExp(`^archon_${environment}_[a-z0-9]{6,40}$`, "u").test(
      expectedPrincipal
    )
  ) {
    throw new ReleaseGateError(
      `${environment} secret has an unexpected principal.`
    );
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
      throw new ReleaseGateError(
        `${environment} runtime database identity is wrong.`
      );
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
      throw new ReleaseGateError(
        `${environment} three-axis RLS proof failed.`
      );
    }

    await verifyExactIndexes(client, identityRow.database_name);
    const noKind = await verifyRuntimeCspannPath(
      client,
      environment,
      {
        label: "no-kind",
        probeKey: PUBLIC_FIXTURE_KEYS[0],
        expectedServingPath: "public-no-kind-cspann",
        expectedView: PUBLIC_RECALL_VIEW_NAME,
        expectedIndex: EXPECTED_VECTOR_INDEX_NAME,
      },
      canaryVectors
    );
    const kind = await verifyRuntimeCspannPath(
      client,
      environment,
      {
        label: "kind",
        probeKey: "archon-demo/v1/recon-2043-missing-pay-118",
        kind: "validation",
        expectedServingPath: "public-kind-cspann",
        expectedView: PUBLIC_KIND_RECALL_VIEW_NAME,
        expectedIndex: EXPECTED_KIND_VECTOR_INDEX_NAME,
      },
      canaryVectors
    );
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
      cspannRecall: { noKind, kind },
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
    throw new ReleaseGateError(
      `${label} failed for an unexpected reason.`
    );
  }
  throw new ReleaseGateError(`${label} was unexpectedly permitted.`);
}

async function verifyRuntimeRoles(
  client: PgClient,
  principals: string[]
): Promise<void> {
  const expectedUsers = [
    ...principals,
    "archon_public_reader",
    PUBLIC_RECALL_VIEW_OWNER,
  ];
  const users = await client.query<{
    username: string;
    options: string[] | string;
    member_of: string[] | string;
  }>(
    "SELECT username, options, member_of FROM [SHOW USERS] WHERE username = ANY($1::STRING[])",
    [expectedUsers]
  );
  if (users.rows.length !== expectedUsers.length) {
    throw new ReleaseGateError("Runtime role catalog is incomplete.");
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
    if (user.username === PUBLIC_RECALL_VIEW_OWNER) {
      const exactOptions = [...options].sort();
      if (
        memberships.length !== 0 ||
        JSON.stringify(exactOptions) !==
          JSON.stringify(["BYPASSRLS", "NOLOGIN"])
      ) {
        throw new ReleaseGateError(
          "Public recall view owner role drifted."
        );
      }
      continue;
    }
    if (user.username === "archon_public_reader") {
      if (
        memberships.length !== 0 ||
        hasDangerousOption ||
        !options.includes("NOLOGIN") ||
        options.includes("LOGIN")
      ) {
        throw new ReleaseGateError(
          "archon_public_reader is not a bounded base role."
        );
      }
      continue;
    }
    if (
      memberships.length !== 1 ||
      memberships[0] !== "archon_public_reader" ||
      hasDangerousOption
    ) {
      throw new ReleaseGateError(
        `Runtime role ${user.username} is not least privilege.`
      );
    }
  }

  const allUsers = await client.query<{
    username: string;
    member_of: string[] | string;
  }>("SELECT username, member_of FROM [SHOW USERS]");
  if (
    allUsers.rows.some((user) =>
      stringArray(user.member_of).includes(PUBLIC_RECALL_VIEW_OWNER)
    )
  ) {
    throw new ReleaseGateError(
      "Public recall view owner unexpectedly has members."
    );
  }
  const ownerSystemGrants = await client.query<SystemGrant>(
    `SHOW SYSTEM GRANTS FOR ${PUBLIC_RECALL_VIEW_OWNER}`
  );
  const ownerAffirmative = affirmativeSystemGrants(
    ownerSystemGrants.rows
  );
  if (ownerAffirmative.length !== 0) {
    throw new ReleaseGateError(
      "Public recall view owner has unexpected system privileges."
    );
  }
}

async function verifyServingViewSecurity(
  client: PgClient,
  databaseName = expectedDatabase
): Promise<void> {
  const expectedViews = [
    PUBLIC_RECALL_VIEW_NAME,
    PUBLIC_KIND_RECALL_VIEW_NAME,
  ];
  const views = await client.query<{
    table_name: string;
    view_definition: string;
    owner: string;
    reloptions: string[] | string | null;
  }>(
    `SELECT views.table_name, views.view_definition,
            roles.rolname AS owner, classes.reloptions
       FROM information_schema.views AS views
       JOIN pg_catalog.pg_class AS classes
         ON classes.relname = views.table_name
       JOIN pg_catalog.pg_namespace AS namespaces
         ON namespaces.oid = classes.relnamespace
        AND namespaces.nspname = views.table_schema
       JOIN pg_catalog.pg_roles AS roles
         ON roles.oid = classes.relowner
      WHERE views.table_schema = 'public'
        AND views.table_name = ANY($1::STRING[])`,
    [expectedViews]
  );
  const byName = new Map(
    views.rows.map((view) => [view.table_name, view])
  );
  const companyView = byName.get(PUBLIC_RECALL_VIEW_NAME);
  const kindView = byName.get(PUBLIC_KIND_RECALL_VIEW_NAME);
  if (
    views.rowCount !== 2 ||
    !companyView ||
    !kindView ||
    !isExpectedPublicRecallViewDefinition(
      companyView.view_definition,
      false,
      databaseName
    ) ||
    !isExpectedPublicRecallViewDefinition(
      kindView.view_definition,
      true,
      databaseName
    ) ||
    views.rows.some(
      (view) =>
        view.owner !== PUBLIC_RECALL_VIEW_OWNER ||
        stringArray(view.reloptions).length !== 1 ||
        stringArray(view.reloptions)[0]?.toLowerCase() !==
          "security_invoker=false"
    )
  ) {
    throw new ReleaseGateError(
      "Fixed-scope serving view security proof failed."
    );
  }

  for (const viewName of expectedViews) {
    const grants = await client.query<{
      grantee: string;
      privilege_type: string;
      is_grantable: boolean;
    }>(`SHOW GRANTS ON TABLE ${viewName}`);
    const reader = grants.rows.filter(
      (grant) => grant.grantee === "archon_public_reader"
    );
    if (
      reader.length !== 1 ||
      reader[0]?.privilege_type !== "SELECT" ||
      reader[0].is_grantable ||
      grants.rows.some(
        (grant) =>
          ![
            "admin",
            "root",
            PUBLIC_RECALL_VIEW_OWNER,
            "archon_public_reader",
          ].includes(grant.grantee)
      )
    ) {
      throw new ReleaseGateError(
        `Serving view ${viewName} grants drifted.`
      );
    }
  }

  const ownerBaseGrants = await client.query<{
    table_name: string;
    privilege_type: string;
    is_grantable: boolean;
  }>(
    `SELECT table_name, privilege_type, is_grantable
       FROM [SHOW GRANTS ON TABLE agent_memory
             FOR archon_public_memory_view_owner]`
  );
  const ownerRelationGrants = await client.query<{
    schema_name: string;
    table_name: string;
    privilege_type: string;
    is_grantable: boolean;
  }>(
    `SHOW GRANTS ON TABLE *
       FOR archon_public_memory_view_owner`
  );
  const ownerRelationNames = new Set(
    ownerRelationGrants.rows.map((grant) => grant.table_name)
  );
  const expectedOwnerRelations = new Set([
    "agent_memory",
    PUBLIC_RECALL_VIEW_NAME,
    PUBLIC_KIND_RECALL_VIEW_NAME,
  ]);
  const ownerSchemaGrants = await client.query<{
    privilege_type: string;
    is_grantable: boolean;
  }>(
    `SELECT privilege_type, is_grantable
       FROM [SHOW GRANTS ON SCHEMA public
             FOR archon_public_memory_view_owner]`
  );
  if (
    ownerRelationNames.size !== expectedOwnerRelations.size ||
    [...expectedOwnerRelations].some(
      (relation) => !ownerRelationNames.has(relation)
    ) ||
    ownerRelationGrants.rows.some(
      (grant) =>
        grant.schema_name !== "public" ||
        !expectedOwnerRelations.has(grant.table_name)
    ) ||
    ownerBaseGrants.rows.length !== 1 ||
    ownerBaseGrants.rows[0]?.table_name !== "agent_memory" ||
    ownerBaseGrants.rows[0].privilege_type !== "SELECT" ||
    ownerBaseGrants.rows[0].is_grantable ||
    ownerSchemaGrants.rows.length < 1 ||
    ownerSchemaGrants.rows.some(
      (grant) =>
        grant.privilege_type !== "USAGE" || grant.is_grantable
    )
  ) {
    throw new ReleaseGateError(
      "Serving view owner object grants drifted."
    );
  }

  const ownedRelations = await client.query<{
    schema_name: string;
    relation_name: string;
    relation_kind: string;
  }>(
    `SELECT namespaces.nspname AS schema_name,
            classes.relname AS relation_name,
            classes.relkind AS relation_kind
       FROM pg_catalog.pg_class AS classes
       JOIN pg_catalog.pg_namespace AS namespaces
         ON namespaces.oid = classes.relnamespace
       JOIN pg_catalog.pg_roles AS roles
         ON roles.oid = classes.relowner
      WHERE roles.rolname = $1
        AND namespaces.nspname NOT IN (
          'pg_catalog',
          'information_schema',
          'crdb_internal'
        )`,
    [PUBLIC_RECALL_VIEW_OWNER]
  );
  if (
    ownedRelations.rows.length !== 2 ||
    ownedRelations.rows.some(
      (relation) =>
        relation.schema_name !== "public" ||
        relation.relation_kind !== "v" ||
        !expectedViews.includes(relation.relation_name)
    )
  ) {
    throw new ReleaseGateError(
      "Serving view owner owns unexpected relations."
    );
  }

  const tableOwner = await client.query<{ owner: string }>(
    `SELECT roles.rolname AS owner
       FROM pg_catalog.pg_class AS classes
       JOIN pg_catalog.pg_namespace AS namespaces
         ON namespaces.oid = classes.relnamespace
       JOIN pg_catalog.pg_roles AS roles
         ON roles.oid = classes.relowner
      WHERE namespaces.nspname = 'public'
        AND classes.relname = 'agent_memory'`
  );
  if (
    tableOwner.rowCount !== 1 ||
    tableOwner.rows[0]?.owner === PUBLIC_RECALL_VIEW_OWNER
  ) {
    throw new ReleaseGateError(
      "Serving view owner unexpectedly owns the base table."
    );
  }

  const settingsResult = await client.query<{
    variable: string;
    value: string;
  }>(
    `SELECT variable, value
       FROM [SHOW ALL CLUSTER SETTINGS]
      WHERE variable IN (
        'version',
        'sql.auth.skip_underlying_view_privilege_checks.enabled'
      )`
  );
  const settings = new Map(
    settingsResult.rows.map((setting) => [
      setting.variable,
      String(setting.value),
    ])
  );
  if (
    !/^26\.2(?:[.-]|$)/u.test(settings.get("version") ?? "") ||
    settings.get(
      "sql.auth.skip_underlying_view_privilege_checks.enabled"
    ) !== "false"
  ) {
    throw new ReleaseGateError(
      "CockroachDB v26.2 view-owner semantics are not active."
    );
  }
}

async function verifyAdmin(
  adminUrl: string,
  runtimePrincipals: string[]
): Promise<{
  version: string;
  databaseName: string;
  fixtureRows: number;
  indexDefinitionFingerprints: {
    company: string;
    kind: string;
  };
  isolationCanaryVectors: IsolationCanaryVector[];
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
      throw new ReleaseGateError("Database engine/name proof failed.");
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
      throw new ReleaseGateError(
        "Canonical synthetic fixture manifest is incomplete."
      );
    }
    const byKey = new Map(
      fixtures.rows.map((row) => [row.idempotency_key, row])
    );
    if (byKey.size !== allKeys.length) {
      throw new ReleaseGateError(
        "Canonical fixture keys are not unique."
      );
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
      throw new ReleaseGateError(
        "Canonical headline financial evidence drifted."
      );
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
      throw new ReleaseGateError(
        "Three-axis RLS canary manifest drifted."
      );
    }
    const canaryEmbeddingRows = await client.query<{
      idempotency_key: string;
      kind: string;
      embedding: string;
    }>(
      `SELECT idempotency_key, kind, embedding::STRING AS embedding
         FROM agent_memory
        WHERE embed_model = $1
          AND idempotency_key = ANY($2::STRING[])`,
      [expectedModel, ISOLATION_CANARY_KEYS]
    );
    if (
      canaryEmbeddingRows.rows.length !== ISOLATION_CANARY_KEYS.length ||
      new Set(
        canaryEmbeddingRows.rows.map((row) => row.idempotency_key)
      ).size !== ISOLATION_CANARY_KEYS.length ||
      canaryEmbeddingRows.rows.some(
        (row) =>
          !ISOLATION_CANARY_KEYS.includes(
            row.idempotency_key as (typeof ISOLATION_CANARY_KEYS)[number]
          ) ||
          row.kind !== "validation" ||
          !row.embedding.startsWith("[") ||
          !row.embedding.endsWith("]")
      )
    ) {
      throw new ReleaseGateError(
        "Isolation canary vector manifest drifted."
      );
    }
    const isolationCanaryVectors: IsolationCanaryVector[] =
      canaryEmbeddingRows.rows.map((row) => ({
        idempotencyKey: row.idempotency_key,
        kind: "validation",
        embedding: row.embedding,
      }));

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
      throw new ReleaseGateError(
        "Canonical contradiction/absence proof failed."
      );
    }

    const indexFingerprints = await verifyExactIndexes(
      client,
      databaseRow.database_name
    );
    await verifyServingViewSecurity(client, databaseRow.database_name);
    await verifyRuntimeRoles(client, runtimePrincipals);
    return {
      version: databaseRow.version.split(" ").slice(0, 3).join(" "),
      databaseName: databaseRow.database_name,
      fixtureRows: fixtureCount,
      indexDefinitionFingerprints: indexFingerprints,
      isolationCanaryVectors,
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
    throw new ReleaseGateError(
      "Database release is restricted to eu-west-1."
    );
  }
  const targetSha = required("TARGET_SHA");
  if (!/^[a-f0-9]{40}$/u.test(targetSha)) {
    throw new ReleaseGateError(
      "TARGET_SHA must be a full lowercase Git commit SHA."
    );
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
    !/^v26\.2(?:\.|$)/u.test(cloudVersion)
  ) {
    throw new ReleaseGateError(
      "Cockroach Cloud API release-gate metadata is invalid."
    );
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
    verifyRuntime(
      "staging",
      stagingUrl,
      admin.isolationCanaryVectors
    ),
    verifyRuntime(
      "production",
      productionUrl,
      admin.isolationCanaryVectors
    ),
  ]);
  const digests = releaseDigests();

  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 4,
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
          companyKindScopedVectorIndex: true,
          fixedScopeServingViews: true,
          scopedServingQueriesRejectCanaries: true,
          isolationCanaryCount: ISOLATION_CANARY_KEYS.length,
          isolatedNonLoginServingViewOwner: true,
          servingViewOwnerPrivilegeBoundary:
            "direct non-inheritable BYPASSRLS role option; SELECT agent_memory only; no system privileges",
          runtimePrincipalCspannPlanAndExecute: true,
          runtimePrincipalNoKindCspann: true,
          runtimePrincipalKindCspann: true,
          runtimeCspannEnvironmentCount: 2,
          indexDefinitionFingerprints:
            admin.indexDefinitionFingerprints,
          roleBoundRls: true,
          attackerSelectedApplicationNameIgnored: true,
          wrongCompanyInvisible: true,
          wrongTenantInvisible: true,
          retractedStatusInvisible: true,
          runtimeRelationPrivilegeMatrix:
            "SELECT agent_memory and fixed-scope recall views only",
          runtimeSchemaPrivilegeMatrix: "USAGE only",
          runtimeDatabasePrivilegeMatrix: "CONNECT only",
          runtimeSystemPrivileges:
            "no affirmative grants; restrictive role options only",
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
  const message = safeReleaseFailureMessage(error);
  process.stderr.write(`Database release verification failed: ${message}\n`);
  process.exitCode = 1;
});
