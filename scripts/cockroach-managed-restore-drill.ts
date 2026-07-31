import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import pg, { type QueryResultRow } from "pg";
import {
  EXPECTED_KIND_VECTOR_INDEX_NAME,
  EXPECTED_VECTOR_INDEX_NAME,
  indexDefinitionFingerprint,
  isExpectedKindVectorIndexDefinition,
  isExpectedVectorIndexDefinition,
} from "../src/db/proof.js";
import { parseDatabaseSecret } from "../src/db/secret.js";
import { PUBLIC_DEMO_CANONICAL_KEYS } from "../src/memory/demo-reconciliation.js";

const { Client } = pg;
type PgClient = InstanceType<typeof Client>;

const API_BASE = "https://cockroachlabs.cloud";
const EXPECTED_API_VERSION = "2024-09-16";
const EXPECTED_PROVIDER = "AWS";
const EXPECTED_PLAN = "BASIC";
const EXPECTED_REGION = "eu-west-1";
const BASIC_BACKUP_INTERVAL_MINUTES = 1_440;
const POST_RESTORE_SQL_WAIT_MS = 10 * 60 * 1_000;
const API_TIMEOUT_MS = 30_000;
const API_MAX_ATTEMPTS = 4;
const RESTORE_POLL_INTERVAL_MS = 15_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const REQUIRED_RESOLUTION_TABLES = [
  "memory_demo_sessions",
  "memory_resolution_observations",
  "memory_resolution_proposals",
  "memory_resolution_decisions",
  "memory_resolution_consolidations",
] as const;

interface ClusterRegion {
  name: string;
  sql_dns: string;
  primary?: boolean;
}

interface CloudCluster {
  id: string;
  name: string;
  cloud_provider: string;
  plan: string;
  state: string;
  cockroach_version: string;
  regions: ClusterRegion[];
}

interface BackupSummary {
  id: string;
  as_of_time: string;
}

interface RestoreRecord {
  id: string;
  backup_id: string;
  backup_end_time?: string;
  status: "PENDING" | "SUCCESS" | "FAILED";
  created_at: string;
  completed_at?: string;
  type: "CLUSTER" | "DATABASE" | "TABLE";
  completion_percent: number;
  source_cluster_name?: string;
  destination_cluster_name?: string;
  client_error_code?: number;
}

interface DatabaseEvidence {
  sqlClusterId: string;
  sqlVersionSha256: string;
  tableSetSha256: string;
  schemaSha256: string;
  viewsSha256: string;
  indexesSha256: string;
  grantsSha256: string;
  rolesSha256: string;
  rlsSha256: string;
  canonicalSha256: string;
  canonicalRows: number;
  canonicalKeysSha256: string;
  resolutionRlsTables: number;
  resolutionPolicies: number;
  vectorIndexFingerprints: {
    company: string;
    companyKind: string;
  };
}

interface DrillState {
  targetSha?: string;
  repository?: string;
  runId?: string;
  runAttempt?: string;
  runUrl?: string;
  approvalReference?: string;
  sourceClusterId?: string;
  destinationClusterId?: string;
  backupId?: string;
  organizationId?: string;
  sourceSqlDns?: string;
  destinationSqlDns?: string;
  backupAsOfTime?: string;
  restoreId?: string;
  restoreRequestedAt?: string;
  restoreApiCompletedAt?: string;
  verificationCompletedAt?: string;
  sourceEvidence?: DatabaseEvidence;
  destinationEvidence?: DatabaseEvidence;
  emptyDestinationSqlClusterId?: string;
  restoreStatus?: RestoreRecord["status"];
  rtoSeconds?: number;
  rpoSeconds?: number;
  rtoObjectiveMinutes?: number;
  rpoObjectiveMinutes?: number;
  rtoObjectiveMet?: boolean;
  rpoObjectiveMet?: boolean;
  maxPollMinutes?: number;
  checks: Record<string, boolean | null>;
}

class DrillError extends Error {
  override readonly name = "DrillError";

  constructor(
    readonly stage: string,
    readonly code: string
  ) {
    super(`${stage}:${code}`);
  }
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new DrillError("configuration", `MISSING_${name}`);
  }
  return value;
}

function requiredUuid(name: string): string {
  const value = required(name);
  if (!UUID_PATTERN.test(value)) {
    throw new DrillError("configuration", `INVALID_${name}`);
  }
  return value.toLowerCase();
}

function requiredOpaqueId(name: string): string {
  const value = required(name);
  if (!OPAQUE_ID_PATTERN.test(value)) {
    throw new DrillError("configuration", `INVALID_${name}`);
  }
  return value;
}

function positiveInteger(name: string): number {
  const value = required(name);
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new DrillError("configuration", `INVALID_${name}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new DrillError("configuration", `INVALID_${name}`);
  }
  return parsed;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalValue(child)])
    );
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function sha256Object(value: unknown): string {
  return sha256(canonicalJson(value));
}

function dateMillis(value: string, stage: string, code: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new DrillError(stage, code);
  }
  return parsed;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function databaseNameFromUrl(databaseUrl: string): string {
  return decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\/+/u, ""));
}

function normalizedHostname(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/u, "");
}

function urlForDatabase(databaseUrl: string, database: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${encodeURIComponent(database)}`;
  return url.toString();
}

function assertSqlEndpoint(
  databaseUrl: string,
  cluster: CloudCluster,
  allowedDatabases: ReadonlySet<string>,
  label: string
): { hostname: string; database: string } {
  const url = new URL(databaseUrl);
  const database = databaseNameFromUrl(databaseUrl);
  const hostname = normalizedHostname(url.hostname);
  const queryEntries = [...url.searchParams.entries()];
  const queryKeys = queryEntries.map(([key]) => key).sort();
  const expectedQueryKeys = ["sslmode"];
  const primarySqlDns = normalizedHostname(
    cluster.regions[0]?.sql_dns ?? ""
  );
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    url.port !== "26257" ||
    url.searchParams.get("sslmode") !== "verify-full" ||
    canonicalJson(queryKeys) !== canonicalJson(expectedQueryKeys) ||
    !url.username ||
    !url.password ||
    Boolean(url.hash) ||
    !allowedDatabases.has(database) ||
    !primarySqlDns ||
    hostname !== primarySqlDns
  ) {
    throw new DrillError(
      "sql-endpoint-binding",
      `INVALID_${label.toUpperCase()}_ENDPOINT`
    );
  }
  return { hostname, database };
}

function assertCloudCluster(
  value: unknown,
  expectedId: string,
  label: string
): CloudCluster {
  if (!value || typeof value !== "object") {
    throw new DrillError("cloud-preflight", `INVALID_${label}_CLUSTER`);
  }
  const cluster = value as Partial<CloudCluster>;
  const regions = Array.isArray(cluster.regions) ? cluster.regions : [];
  if (
    cluster.id?.toLowerCase() !== expectedId ||
    typeof cluster.name !== "string" ||
    !cluster.name ||
    cluster.cloud_provider !== EXPECTED_PROVIDER ||
    cluster.plan !== EXPECTED_PLAN ||
    cluster.state !== "CREATED" ||
    typeof cluster.cockroach_version !== "string" ||
    !cluster.cockroach_version ||
    regions.length !== 1 ||
    regions[0]?.name !== EXPECTED_REGION ||
    regions[0]?.primary !== true ||
    typeof regions[0]?.sql_dns !== "string" ||
    !regions[0].sql_dns ||
    regions.some((region) => region.name === "us-west-2")
  ) {
    throw new DrillError(
      "cloud-preflight",
      `UNSAFE_${label}_CLUSTER`
    );
  }
  return cluster as CloudCluster;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function cloudApiJson(
  apiKey: string,
  apiVersion: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown
): Promise<unknown> {
  // The Cloud restore endpoint exposes no idempotency key. Retrying its POST
  // after an ambiguous transport failure could start a second destructive
  // restore, so only read-only GETs receive automatic transport retries.
  const maxAttempts = method === "GET" ? API_MAX_ATTEMPTS : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(`${API_BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Cc-Version": apiVersion,
          ...(body === undefined
            ? {}
            : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
    } catch {
      if (method === "POST") {
        throw new DrillError(
          "cloud-api",
          "RESTORE_POST_OUTCOME_UNKNOWN"
        );
      }
      if (attempt === maxAttempts) {
        throw new DrillError("cloud-api", "NETWORK_RETRY_EXHAUSTED");
      }
      await delay(attempt * 1_000);
      continue;
    }

    if (response.ok) {
      try {
        return (await response.json()) as unknown;
      } catch {
        throw new DrillError("cloud-api", "INVALID_JSON_RESPONSE");
      }
    }

    if (
      (response.status === 429 || response.status >= 500) &&
      attempt < maxAttempts
    ) {
      const retryAfter = Number(response.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter)
        ? Math.min(Math.max(retryAfter * 1_000, 1_000), 10_000)
        : attempt * 1_000;
      await response.arrayBuffer().catch(() => undefined);
      await delay(waitMs);
      continue;
    }
    await response.arrayBuffer().catch(() => undefined);
    throw new DrillError("cloud-api", `HTTP_${response.status}`);
  }
  throw new DrillError("cloud-api", "UNREACHABLE_RETRY_STATE");
}

async function databaseSecret(
  client: SecretsManagerClient,
  secretId: string
): Promise<string> {
  const result = await client.send(
    new GetSecretValueCommand({ SecretId: secretId })
  );
  if (!result.SecretString) {
    throw new DrillError("secret-read", "BINARY_SECRET_UNSUPPORTED");
  }
  try {
    return parseDatabaseSecret(result.SecretString, { requireTls: true });
  } catch {
    throw new DrillError("secret-read", "INVALID_DATABASE_SECRET");
  }
}

async function connect(databaseUrl: string): Promise<PgClient> {
  const client = new Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 15_000,
    query_timeout: 30_000,
    application_name: "archon-managed-restore-drill",
  });
  await client.connect();
  return client;
}

async function sqlClusterId(client: PgClient): Promise<string> {
  const result = await client.query<{ cluster_id: string }>(
    "SELECT crdb_internal.cluster_id()::STRING AS cluster_id"
  );
  const value = result.rows[0]?.cluster_id;
  if (result.rows.length !== 1 || !value || !UUID_PATTERN.test(value)) {
    throw new DrillError("sql-identity", "INVALID_SQL_CLUSTER_ID");
  }
  return value.toLowerCase();
}

async function assertEmptyDestination(
  databaseUrl: string
): Promise<string> {
  const allowedDatabases = new Set(["defaultdb", "postgres", "system"]);
  const root = await connect(databaseUrl);
  let clusterId: string;
  let databases: string[];
  try {
    clusterId = await sqlClusterId(root);
    const result = await root.query<{ database_name: string }>(
      "SELECT database_name FROM [SHOW DATABASES] ORDER BY database_name"
    );
    databases = result.rows.map((row) => row.database_name);
  } finally {
    await root.end().catch(() => undefined);
  }

  if (
    databases.length === 0 ||
    databases.some((database) => !allowedDatabases.has(database))
  ) {
    throw new DrillError("empty-target-preflight", "USER_DATABASE_EXISTS");
  }

  for (const database of databases.filter(
    (candidate) => candidate !== "system"
  )) {
    const client = await connect(urlForDatabase(databaseUrl, database));
    try {
      const schemas = await client.query<{ schema_name: string }>(
        `SELECT schema_name
           FROM information_schema.schemata
          WHERE schema_name NOT IN (
            'crdb_internal',
            'information_schema',
            'pg_catalog',
            'public'
          )`
      );
      const publicRelations = await client.query<{ relation_count: string }>(
        `SELECT count(*)::STRING AS relation_count
           FROM pg_catalog.pg_class AS classes
           JOIN pg_catalog.pg_namespace AS namespaces
             ON namespaces.oid = classes.relnamespace
          WHERE namespaces.nspname = 'public'`
      );
      if (
        schemas.rows.length !== 0 ||
        Number(publicRelations.rows[0]?.relation_count ?? -1) !== 0
      ) {
        throw new DrillError(
          "empty-target-preflight",
          "USER_SCHEMA_OR_RELATION_EXISTS"
        );
      }
    } finally {
      await client.end().catch(() => undefined);
    }
  }
  return clusterId;
}

function sortedRows<T extends QueryResultRow>(
  rows: T[],
  fields: readonly string[]
): Record<string, unknown>[] {
  return rows
    .map((row) =>
      Object.fromEntries(fields.map((field) => [field, row[field]]))
    )
    .sort((left, right) =>
      canonicalJson(left).localeCompare(canonicalJson(right))
    );
}

async function databaseEvidence(
  databaseUrl: string,
  expectedDatabase: string
): Promise<DatabaseEvidence> {
  const client = await connect(databaseUrl);
  try {
    const identity = await client.query<{
      database_name: string;
      version: string;
    }>("SELECT current_database() AS database_name, version() AS version");
    if (
      identity.rows.length !== 1 ||
      identity.rows[0]?.database_name !== expectedDatabase
    ) {
      throw new DrillError(
        "post-restore-verification",
        "DATABASE_IDENTITY_MISMATCH"
      );
    }
    const clusterId = await sqlClusterId(client);

    const tables = await client.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_type = 'BASE TABLE'
        ORDER BY table_name`
    );
    const tableNames = tables.rows.map((row) => row.table_name);
    const requiredTables = new Set([
      "agent_memory",
      ...REQUIRED_RESOLUTION_TABLES,
    ]);
    if (
      [...requiredTables].some((table) => !tableNames.includes(table))
    ) {
      throw new DrillError(
        "post-restore-verification",
        "REQUIRED_TABLE_MISSING"
      );
    }

    const createStatements: { table: string; createStatement: string }[] = [];
    for (const table of tableNames) {
      const result = await client.query<{ create_statement: string }>(
        `SELECT create_statement
           FROM [SHOW CREATE TABLE public.${quoteIdentifier(table)}]`
      );
      if (result.rows.length !== 1 || !result.rows[0]?.create_statement) {
        throw new DrillError(
          "post-restore-verification",
          "SHOW_CREATE_TABLE_FAILED"
        );
      }
      createStatements.push({
        table,
        createStatement: result.rows[0].create_statement,
      });
    }

    const views = await client.query<{
      table_name: string;
      view_definition: string;
    }>(
      `SELECT table_name, view_definition
         FROM information_schema.views
        WHERE table_schema = 'public'
        ORDER BY table_name`
    );
    const indexes = await client.query<{
      tablename: string;
      indexname: string;
      indexdef: string;
    }>(
      `SELECT tablename, indexname, indexdef
         FROM pg_catalog.pg_indexes
        WHERE schemaname = 'public'
        ORDER BY tablename, indexname`
    );
    const vectorIndexes = new Map(
      indexes.rows
        .filter((row) => row.tablename === "agent_memory")
        .map((row) => [row.indexname, row.indexdef])
    );
    const companyVector = vectorIndexes.get(EXPECTED_VECTOR_INDEX_NAME);
    const companyKindVector = vectorIndexes.get(
      EXPECTED_KIND_VECTOR_INDEX_NAME
    );
    if (
      !companyVector ||
      !companyKindVector ||
      !isExpectedVectorIndexDefinition(companyVector, expectedDatabase) ||
      !isExpectedKindVectorIndexDefinition(
        companyKindVector,
        expectedDatabase
      )
    ) {
      throw new DrillError(
        "post-restore-verification",
        "CSPANN_INDEX_MISMATCH"
      );
    }

    const rls = await client.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT classes.relname,
              classes.relrowsecurity,
              classes.relforcerowsecurity
         FROM pg_catalog.pg_class AS classes
         JOIN pg_catalog.pg_namespace AS namespaces
           ON namespaces.oid = classes.relnamespace
        WHERE namespaces.nspname = 'public'
          AND classes.relname = ANY($1::STRING[])
        ORDER BY classes.relname`,
      [REQUIRED_RESOLUTION_TABLES]
    );
    if (
      rls.rows.length !== REQUIRED_RESOLUTION_TABLES.length ||
      rls.rows.some(
        (row) => !row.relrowsecurity || !row.relforcerowsecurity
      )
    ) {
      throw new DrillError(
        "post-restore-verification",
        "RLS_NOT_FORCED"
      );
    }
    const policies = await client.query<{
      tablename: string;
      policyname: string;
      permissive: string;
      cmd: string;
      roles: string[] | string;
      qual: string | null;
      with_check: string | null;
    }>(
      `SELECT tablename,
              policyname,
              permissive,
              cmd,
              roles,
              qual,
              with_check
         FROM pg_catalog.pg_policies
        WHERE schemaname = 'public'
          AND tablename = ANY($1::STRING[])
        ORDER BY tablename, policyname`,
      [REQUIRED_RESOLUTION_TABLES]
    );
    if (policies.rows.length < REQUIRED_RESOLUTION_TABLES.length * 3) {
      throw new DrillError(
        "post-restore-verification",
        "RLS_POLICY_SET_INCOMPLETE"
      );
    }

    const tableGrants = await client.query(
      "SHOW GRANTS ON TABLE *"
    );
    const schemaGrants = await client.query(
      "SHOW GRANTS ON SCHEMA public"
    );
    const databaseGrants = await client.query(
      `SHOW GRANTS ON DATABASE ${quoteIdentifier(expectedDatabase)}`
    );
    const roles = await client.query<{
      rolname: string;
      rolsuper: boolean;
      rolinherit: boolean;
      rolcreaterole: boolean;
      rolcreatedb: boolean;
      rolcanlogin: boolean;
      rolbypassrls: boolean;
    }>(
      `SELECT rolname,
              rolsuper,
              rolinherit,
              rolcreaterole,
              rolcreatedb,
              rolcanlogin,
              rolbypassrls
         FROM pg_catalog.pg_roles
        WHERE rolname LIKE 'archon_%'
        ORDER BY rolname`
    );
    const memberships = await client.query<{
      role_name: string;
      member_name: string;
      admin_option: boolean;
    }>(
      `SELECT role.rolname AS role_name,
              member.rolname AS member_name,
              membership.admin_option
         FROM pg_catalog.pg_auth_members AS membership
         JOIN pg_catalog.pg_roles AS role
           ON role.oid = membership.roleid
         JOIN pg_catalog.pg_roles AS member
           ON member.oid = membership.member
        WHERE role.rolname LIKE 'archon_%'
           OR member.rolname LIKE 'archon_%'
        ORDER BY role_name, member_name`
    );
    const systemGrants: Record<string, unknown>[] = [];
    for (const role of roles.rows) {
      const grants = await client.query(
        `SHOW SYSTEM GRANTS FOR ${quoteIdentifier(role.rolname)}`
      );
      systemGrants.push(
        ...grants.rows.map((grant) => ({
          role: role.rolname,
          ...grant,
        }))
      );
    }
    systemGrants.sort((left, right) =>
      canonicalJson(left).localeCompare(canonicalJson(right))
    );

    const canonical = await client.query<{
      idempotency_key: string;
      tenant_id: string;
      kind: string;
      company: string;
      period: string | null;
      source_ref: string | null;
      content: string;
      metadata: Record<string, unknown> | null;
      content_hash: string | null;
      status: string;
      embed_model: string;
      embedding: string;
    }>(
      `SELECT idempotency_key,
              tenant_id,
              kind,
              company,
              period,
              source_ref,
              content,
              metadata,
              content_hash,
              status,
              embed_model,
              embedding::STRING AS embedding
         FROM agent_memory
        WHERE tenant_id = 'public-demo'
          AND company = 'Helios SA'
          AND status = 'active'
        ORDER BY idempotency_key`
    );
    const expectedKeys = [...PUBLIC_DEMO_CANONICAL_KEYS].sort();
    const actualKeys = canonical.rows
      .map((row) => row.idempotency_key)
      .sort();
    if (
      canonical.rows.length !== expectedKeys.length ||
      canonical.rows.some(
        (row) =>
          row.tenant_id !== "public-demo" ||
          row.company !== "Helios SA" ||
          row.status !== "active" ||
          !row.embedding.startsWith("[") ||
          !row.embedding.endsWith("]")
      ) ||
      canonicalJson(actualKeys) !== canonicalJson(expectedKeys)
    ) {
      throw new DrillError(
        "post-restore-verification",
        "CANONICAL_MEMORY_SET_MISMATCH"
      );
    }

    const tableGrantRows = sortedRows(tableGrants.rows, [
      "database_name",
      "schema_name",
      "table_name",
      "grantee",
      "privilege_type",
      "is_grantable",
    ]);
    const schemaGrantRows = sortedRows(schemaGrants.rows, [
      "database_name",
      "schema_name",
      "grantee",
      "privilege_type",
      "is_grantable",
    ]);
    const databaseGrantRows = sortedRows(databaseGrants.rows, [
      "database_name",
      "grantee",
      "privilege_type",
      "is_grantable",
    ]);

    return {
      sqlClusterId: clusterId,
      sqlVersionSha256: sha256(identity.rows[0]?.version ?? ""),
      tableSetSha256: sha256Object(tableNames),
      schemaSha256: sha256Object(createStatements),
      viewsSha256: sha256Object(views.rows),
      indexesSha256: sha256Object(indexes.rows),
      grantsSha256: sha256Object({
        tables: tableGrantRows,
        schemas: schemaGrantRows,
        databases: databaseGrantRows,
        system: systemGrants,
      }),
      rolesSha256: sha256Object({
        roles: roles.rows,
        memberships: memberships.rows,
      }),
      rlsSha256: sha256Object({
        tableFlags: rls.rows,
        policies: policies.rows,
      }),
      canonicalSha256: sha256Object(canonical.rows),
      canonicalRows: canonical.rows.length,
      canonicalKeysSha256: sha256Object(actualKeys),
      resolutionRlsTables: rls.rows.length,
      resolutionPolicies: policies.rows.length,
      vectorIndexFingerprints: {
        company: indexDefinitionFingerprint(companyVector),
        companyKind: indexDefinitionFingerprint(companyKindVector),
      },
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

function comparableEvidence(evidence: DatabaseEvidence): unknown {
  return {
    tableSetSha256: evidence.tableSetSha256,
    schemaSha256: evidence.schemaSha256,
    viewsSha256: evidence.viewsSha256,
    indexesSha256: evidence.indexesSha256,
    grantsSha256: evidence.grantsSha256,
    rolesSha256: evidence.rolesSha256,
    rlsSha256: evidence.rlsSha256,
    canonicalSha256: evidence.canonicalSha256,
    canonicalRows: evidence.canonicalRows,
    canonicalKeysSha256: evidence.canonicalKeysSha256,
    resolutionRlsTables: evidence.resolutionRlsTables,
    resolutionPolicies: evidence.resolutionPolicies,
    vectorIndexFingerprints: evidence.vectorIndexFingerprints,
  };
}

function assertEvidenceMatches(
  source: DatabaseEvidence,
  destination: DatabaseEvidence
): void {
  const fields: Array<keyof ReturnType<typeof evidenceBooleans>> = [
    "schema",
    "grants",
    "roles",
    "rls",
    "vectorIndexes",
    "canonicalChecksum",
  ];
  const comparisons = evidenceBooleans(source, destination);
  if (fields.some((field) => !comparisons[field])) {
    throw new DrillError(
      "post-restore-verification",
      "RESTORED_EVIDENCE_MISMATCH"
    );
  }
  if (
    canonicalJson(comparableEvidence(source)) !==
    canonicalJson(comparableEvidence(destination))
  ) {
    throw new DrillError(
      "post-restore-verification",
      "RESTORED_SNAPSHOT_MISMATCH"
    );
  }
}

function evidenceBooleans(
  source?: DatabaseEvidence,
  destination?: DatabaseEvidence
): {
  schema: boolean | null;
  grants: boolean | null;
  roles: boolean | null;
  rls: boolean | null;
  vectorIndexes: boolean | null;
  canonicalChecksum: boolean | null;
} {
  if (!source || !destination) {
    return {
      schema: null,
      grants: null,
      roles: null,
      rls: null,
      vectorIndexes: null,
      canonicalChecksum: null,
    };
  }
  return {
    schema:
      source.tableSetSha256 === destination.tableSetSha256 &&
      source.schemaSha256 === destination.schemaSha256 &&
      source.viewsSha256 === destination.viewsSha256 &&
      source.indexesSha256 === destination.indexesSha256,
    grants: source.grantsSha256 === destination.grantsSha256,
    roles: source.rolesSha256 === destination.rolesSha256,
    rls:
      source.rlsSha256 === destination.rlsSha256 &&
      destination.resolutionRlsTables === REQUIRED_RESOLUTION_TABLES.length &&
      destination.resolutionPolicies >=
        REQUIRED_RESOLUTION_TABLES.length * 3,
    vectorIndexes:
      canonicalJson(source.vectorIndexFingerprints) ===
      canonicalJson(destination.vectorIndexFingerprints),
    canonicalChecksum:
      source.canonicalSha256 === destination.canonicalSha256 &&
      source.canonicalRows === destination.canonicalRows &&
      source.canonicalKeysSha256 === destination.canonicalKeysSha256,
  };
}

function assertBackupList(
  value: unknown,
  backupId: string
): BackupSummary {
  if (!value || typeof value !== "object") {
    throw new DrillError("backup-selection", "INVALID_BACKUP_LIST");
  }
  const backups = (value as { backups?: unknown }).backups;
  if (!Array.isArray(backups)) {
    throw new DrillError("backup-selection", "INVALID_BACKUP_LIST");
  }
  const matches = backups.filter(
    (backup): backup is BackupSummary =>
      Boolean(
        backup &&
          typeof backup === "object" &&
          typeof (backup as BackupSummary).id === "string" &&
          (backup as BackupSummary).id === backupId &&
          typeof (backup as BackupSummary).as_of_time === "string"
      )
  );
  if (matches.length !== 1) {
    throw new DrillError(
      "backup-selection",
      "EXACT_BACKUP_NOT_UNIQUE"
    );
  }
  const backup = matches[0] as BackupSummary;
  const asOf = dateMillis(
    backup.as_of_time,
    "backup-selection",
    "INVALID_BACKUP_TIMESTAMP"
  );
  const age = Date.now() - asOf;
  if (age < 0 || age > 31 * 24 * 60 * 60 * 1_000) {
    throw new DrillError(
      "backup-selection",
      "BACKUP_OUTSIDE_BASIC_RETENTION_BOUNDARY"
    );
  }
  return backup;
}

function assertUnusedDestination(value: unknown): void {
  if (!value || typeof value !== "object") {
    throw new DrillError(
      "empty-target-preflight",
      "INVALID_RESTORE_HISTORY"
    );
  }
  const restores = (value as { restores?: unknown }).restores;
  if (!Array.isArray(restores) || restores.length !== 0) {
    throw new DrillError(
      "empty-target-preflight",
      "DESTINATION_HAS_RESTORE_HISTORY"
    );
  }
}

function assertRestoreRecord(
  value: unknown,
  expected: {
    backupId: string;
    backupAsOfTime: string;
    sourceClusterName: string;
    destinationClusterName: string;
    restoreId?: string;
  }
): RestoreRecord {
  if (!value || typeof value !== "object") {
    throw new DrillError("restore-status", "INVALID_RESTORE_RECORD");
  }
  const record = value as Partial<RestoreRecord>;
  const backupEndTimeMatches =
    record.backup_end_time === undefined ||
    dateMillis(
      record.backup_end_time,
      "restore-status",
      "INVALID_BACKUP_END_TIME"
    ) ===
      dateMillis(
        expected.backupAsOfTime,
        "restore-status",
        "INVALID_SELECTED_BACKUP_TIME"
      );
  const optionalNamesMatch =
    (record.source_cluster_name === undefined ||
      record.source_cluster_name === expected.sourceClusterName) &&
    (record.destination_cluster_name === undefined ||
      record.destination_cluster_name ===
        expected.destinationClusterName);
  if (
    typeof record.id !== "string" ||
    !OPAQUE_ID_PATTERN.test(record.id) ||
    record.backup_id !== expected.backupId ||
    record.type !== "CLUSTER" ||
    !["PENDING", "SUCCESS", "FAILED"].includes(record.status ?? "") ||
    typeof record.completion_percent !== "number" ||
    record.completion_percent < 0 ||
    record.completion_percent > 1 ||
    !backupEndTimeMatches ||
    !optionalNamesMatch ||
    (expected.restoreId !== undefined &&
      record.id !== expected.restoreId)
  ) {
    throw new DrillError("restore-status", "RESTORE_RECORD_MISMATCH");
  }
  dateMillis(
    record.created_at ?? "",
    "restore-status",
    "INVALID_RESTORE_CREATED_TIME"
  );
  if (record.completed_at !== undefined) {
    dateMillis(
      record.completed_at,
      "restore-status",
      "INVALID_RESTORE_COMPLETION_TIME"
    );
  }
  return {
    ...(record as RestoreRecord),
    id: record.id,
    backup_id: record.backup_id ?? "",
  };
}

async function pollRestore(
  apiKey: string,
  apiVersion: string,
  destinationClusterId: string,
  initial: RestoreRecord,
  expected: Parameters<typeof assertRestoreRecord>[1],
  maxPollMinutes: number
): Promise<RestoreRecord> {
  const deadline = Date.now() + maxPollMinutes * 60 * 1_000;
  let record = initial;
  while (record.status === "PENDING" && Date.now() < deadline) {
    await delay(
      Math.min(RESTORE_POLL_INTERVAL_MS, Math.max(deadline - Date.now(), 0))
    );
    const response = await cloudApiJson(
      apiKey,
      apiVersion,
      "GET",
      `/api/v1/clusters/${encodeURIComponent(
        destinationClusterId
      )}/restores/${encodeURIComponent(initial.id)}`
    );
    record = assertRestoreRecord(response, {
      ...expected,
      restoreId: initial.id,
    });
  }
  if (record.status === "PENDING") {
    throw new DrillError("restore-status", "BOUNDED_POLL_TIMEOUT");
  }
  if (record.status !== "SUCCESS" || record.completion_percent !== 1) {
    throw new DrillError("restore-status", "RESTORE_FAILED");
  }
  return record;
}

async function retryDestinationEvidence(
  databaseUrl: string,
  expectedDatabase: string
): Promise<DatabaseEvidence> {
  const deadline = Date.now() + POST_RESTORE_SQL_WAIT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await databaseEvidence(databaseUrl, expectedDatabase);
    } catch (error) {
      lastError = error;
      await delay(Math.min(10_000, Math.max(deadline - Date.now(), 0)));
    }
  }
  if (lastError instanceof DrillError) {
    throw lastError;
  }
  throw new DrillError(
    "post-restore-verification",
    "SQL_RETRY_EXHAUSTED"
  );
}

function receipt(
  state: DrillState,
  status: "passed" | "failed",
  failure?: DrillError
): Record<string, unknown> {
  const evidence = evidenceBooleans(
    state.sourceEvidence,
    state.destinationEvidence
  );
  return {
    schema: "archon.cockroach.managed-backup-restore-drill",
    version: 1,
    ok: status === "passed",
    status,
    generatedAt: new Date().toISOString(),
    repository: state.repository ?? null,
    targetSha: state.targetSha ?? null,
    workflow: {
      runId: state.runId ?? null,
      runAttempt: state.runAttempt ?? null,
      runUrl: state.runUrl ?? null,
      protectedEnvironment: "production-db",
      manualDispatchOnly: true,
    },
    approval: {
      referenceSha256: state.approvalReference
        ? sha256(state.approvalReference)
        : null,
      destructiveConfirmationBoundToExactIds:
        state.checks.destructiveConfirmation ?? null,
    },
    operation: {
      type: "cockroachdb-cloud-managed-backup-cross-cluster-restore",
      apiVersion: EXPECTED_API_VERSION,
      restoreType: "CLUSTER",
      pointInTimeRestore: false,
      cutoverPerformed: false,
      deletionPerformed: false,
      provisioningPerformed: false,
    },
    placement: {
      provider: EXPECTED_PROVIDER,
      plan: EXPECTED_PLAN,
      region: EXPECTED_REGION,
      forbiddenRegion: "us-west-2",
      sourceDestinationDifferent:
        state.checks.sourceDestinationDifferent ?? null,
      samePlanProviderRegion:
        state.checks.samePlanProviderRegion ?? null,
      sameOrganizationApiBoundary:
        state.checks.sameOrganization ?? null,
    },
    identities: {
      organizationIdSha256: state.organizationId
        ? sha256(state.organizationId)
        : null,
      sourceClusterIdSha256: state.sourceClusterId
        ? sha256(state.sourceClusterId)
        : null,
      destinationClusterIdSha256: state.destinationClusterId
        ? sha256(state.destinationClusterId)
        : null,
      sourceSqlDnsSha256: state.sourceSqlDns
        ? sha256(state.sourceSqlDns)
        : null,
      destinationSqlDnsSha256: state.destinationSqlDns
        ? sha256(state.destinationSqlDns)
        : null,
      sourceSqlClusterIdSha256: state.sourceEvidence
        ? sha256(state.sourceEvidence.sqlClusterId)
        : null,
      destinationSqlClusterIdSha256:
        state.emptyDestinationSqlClusterId
          ? sha256(state.emptyDestinationSqlClusterId)
          : null,
      restoreIdSha256: state.restoreId ? sha256(state.restoreId) : null,
    },
    backup: {
      backupIdSha256: state.backupId ? sha256(state.backupId) : null,
      asOfTime: state.backupAsOfTime ?? null,
      scheduleIntervalMinutes: BASIC_BACKUP_INTERVAL_MINUTES,
      retentionDays: 30,
      defaultWorstCaseRpoMinutes: BASIC_BACKUP_INTERVAL_MINUTES,
      exactBackupSelected: state.checks.exactBackupSelected ?? null,
    },
    measurements: {
      restoreRequestedAt: state.restoreRequestedAt ?? null,
      restoreApiCompletedAt: state.restoreApiCompletedAt ?? null,
      verificationCompletedAt: state.verificationCompletedAt ?? null,
      rtoSeconds: state.rtoSeconds ?? null,
      rpoSeconds: state.rpoSeconds ?? null,
      rtoObjectiveMinutes: state.rtoObjectiveMinutes ?? null,
      rpoObjectiveMinutes: state.rpoObjectiveMinutes ?? null,
      rtoObjectiveMet: state.rtoObjectiveMet ?? null,
      rpoObjectiveMet: state.rpoObjectiveMet ?? null,
      maxPollMinutes: state.maxPollMinutes ?? null,
    },
    checks: {
      exactMainSha: state.checks.exactMainSha ?? null,
      sqlEndpointsBoundToCloudMetadata:
        state.checks.sqlEndpointBinding ?? null,
      destinationWasEmpty:
        state.checks.destinationWasEmpty ?? null,
      destinationHadNoRestoreHistory:
        state.checks.noRestoreHistory ?? null,
      restoreApiSucceeded: state.checks.restoreApiSucceeded ?? null,
      destinationSqlIdentityPreserved:
        state.checks.destinationSqlIdentityPreserved ?? null,
      sourceAndDestinationSqlClustersDifferent:
        state.checks.sqlClustersDifferent ?? null,
      schemaMatchesSource: evidence.schema,
      grantsMatchSource: evidence.grants,
      roleSecurityMatchesSource: evidence.roles,
      rlsMatchesSourceAndRemainsForced: evidence.rls,
      cspannIndexesMatchSource: evidence.vectorIndexes,
      canonicalChecksumMatchesSource: evidence.canonicalChecksum,
    },
    evidence: {
      source: state.sourceEvidence
        ? {
            schemaSha256: state.sourceEvidence.schemaSha256,
            grantsSha256: state.sourceEvidence.grantsSha256,
            rolesSha256: state.sourceEvidence.rolesSha256,
            rlsSha256: state.sourceEvidence.rlsSha256,
            indexesSha256: state.sourceEvidence.indexesSha256,
            canonicalSha256: state.sourceEvidence.canonicalSha256,
            canonicalRows: state.sourceEvidence.canonicalRows,
            vectorIndexFingerprints:
              state.sourceEvidence.vectorIndexFingerprints,
          }
        : null,
      restoredDestination: state.destinationEvidence
        ? {
            schemaSha256: state.destinationEvidence.schemaSha256,
            grantsSha256: state.destinationEvidence.grantsSha256,
            rolesSha256: state.destinationEvidence.rolesSha256,
            rlsSha256: state.destinationEvidence.rlsSha256,
            indexesSha256: state.destinationEvidence.indexesSha256,
            canonicalSha256:
              state.destinationEvidence.canonicalSha256,
            canonicalRows: state.destinationEvidence.canonicalRows,
            vectorIndexFingerprints:
              state.destinationEvidence.vectorIndexFingerprints,
          }
        : null,
    },
    limitations: [
      "This is an exact CockroachDB Cloud managed-backup restore, not point-in-time recovery.",
      "CockroachDB Basic managed backups run every 24 hours with 30-day retention; the default worst-case RPO is up to 24 hours absent backup failure.",
      "RTO is unknown until this protected live drill completes successfully.",
      "The drill does not provision, cut over traffic, delete, or clean up the isolated destination cluster.",
      "A separate approval is required for any cutover or destination deletion.",
    ],
    failure:
      failure === undefined
        ? null
        : {
            stage: failure.stage,
            code: failure.code,
          },
  };
}

function writeReceipt(
  path: string,
  value: Record<string, unknown>
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function execute(state: DrillState): Promise<void> {
  const receiptPath = required("RECEIPT_PATH");
  state.repository = required("GITHUB_REPOSITORY");
  state.runId = required("GITHUB_RUN_ID");
  state.runAttempt = required("GITHUB_RUN_ATTEMPT");
  state.runUrl = required("GITHUB_RUN_URL");
  state.targetSha = required("TARGET_SHA");
  state.approvalReference = required("APPROVAL_REFERENCE");
  state.sourceClusterId = requiredUuid("SOURCE_CLUSTER_ID");
  state.destinationClusterId = requiredUuid("DESTINATION_CLUSTER_ID");
  state.backupId = requiredOpaqueId("BACKUP_ID");
  state.rtoObjectiveMinutes = positiveInteger("RTO_OBJECTIVE_MINUTES");
  state.rpoObjectiveMinutes = positiveInteger("RPO_OBJECTIVE_MINUTES");
  state.maxPollMinutes = positiveInteger("MAX_POLL_MINUTES");
  const region = required("AWS_REGION");
  const apiVersion = required("COCKROACH_API_VERSION");
  const apiKey = required("CCLOUD_API_KEY");
  const expectedDatabase = required("COCKROACH_DATABASE");

  if (
    state.repository !== "upgradedev/archon-cockroach-memory" ||
    !SHA_PATTERN.test(state.targetSha) ||
    required("GITHUB_SHA") !== state.targetSha
  ) {
    throw new DrillError("source-gate", "NOT_EXACT_MAIN_SHA");
  }
  state.checks.exactMainSha = true;

  if (state.sourceClusterId === state.destinationClusterId) {
    throw new DrillError(
      "configuration",
      "SOURCE_EQUALS_DESTINATION"
    );
  }
  state.checks.sourceDestinationDifferent = true;

  if (
    required("DESTRUCTIVE_CONFIRMATION") !==
    `RESTORE ${required("DESTINATION_CLUSTER_ID")} FROM ${required(
      "BACKUP_ID"
    )}`
  ) {
    throw new DrillError(
      "approval-gate",
      "DESTRUCTIVE_CONFIRMATION_MISMATCH"
    );
  }
  state.checks.destructiveConfirmation = true;

  if (
    region !== EXPECTED_REGION ||
    apiVersion !== EXPECTED_API_VERSION ||
    ![30, 60, 90].includes(state.maxPollMinutes) ||
    state.rpoObjectiveMinutes < BASIC_BACKUP_INTERVAL_MINUTES
  ) {
    throw new DrillError(
      "configuration",
      "REGION_API_POLL_OR_RPO_CONTRACT_INVALID"
    );
  }

  const [sourceValue, destinationValue, organizationValue] =
    await Promise.all([
      cloudApiJson(
        apiKey,
        apiVersion,
        "GET",
        `/api/v1/clusters/${encodeURIComponent(state.sourceClusterId)}`
      ),
      cloudApiJson(
        apiKey,
        apiVersion,
        "GET",
        `/api/v1/clusters/${encodeURIComponent(
          state.destinationClusterId
        )}`
      ),
      cloudApiJson(
        apiKey,
        apiVersion,
        "GET",
        "/api/v1/organization"
      ),
    ]);
  const sourceCluster = assertCloudCluster(
    sourceValue,
    state.sourceClusterId,
    "SOURCE"
  );
  const destinationCluster = assertCloudCluster(
    destinationValue,
    state.destinationClusterId,
    "DESTINATION"
  );
  const organization =
    organizationValue &&
    typeof organizationValue === "object" &&
    "id" in organizationValue &&
    typeof (organizationValue as { id: unknown }).id === "string"
      ? (organizationValue as { id: string }).id
      : "";
  if (!UUID_PATTERN.test(organization)) {
    throw new DrillError(
      "cloud-preflight",
      "ORGANIZATION_BOUNDARY_UNPROVED"
    );
  }
  state.organizationId = organization.toLowerCase();
  state.checks.sameOrganization = true;
  state.sourceSqlDns = normalizedHostname(
    sourceCluster.regions[0]?.sql_dns ?? ""
  );
  state.destinationSqlDns = normalizedHostname(
    destinationCluster.regions[0]?.sql_dns ?? ""
  );

  if (
    sourceCluster.cloud_provider !== destinationCluster.cloud_provider ||
    sourceCluster.plan !== destinationCluster.plan ||
    canonicalJson(sourceCluster.regions.map((item) => item.name)) !==
      canonicalJson(destinationCluster.regions.map((item) => item.name)) ||
    normalizedHostname(sourceCluster.regions[0]?.sql_dns ?? "") ===
      normalizedHostname(
        destinationCluster.regions[0]?.sql_dns ?? ""
      )
  ) {
    throw new DrillError(
      "cloud-preflight",
      "PLACEMENT_OR_IDENTITY_MISMATCH"
    );
  }
  state.checks.samePlanProviderRegion = true;

  const [backupsValue, restoresValue] = await Promise.all([
    cloudApiJson(
      apiKey,
      apiVersion,
      "GET",
      `/api/v1/clusters/${encodeURIComponent(
        state.sourceClusterId
      )}/backups?pagination.limit=100&pagination.sort_order=DESC`
    ),
    cloudApiJson(
      apiKey,
      apiVersion,
      "GET",
      `/api/v1/clusters/${encodeURIComponent(
        state.destinationClusterId
      )}/restores?pagination.limit=100&pagination.sort_order=DESC`
    ),
  ]);
  const backup = assertBackupList(backupsValue, state.backupId);
  state.backupAsOfTime = new Date(
    dateMillis(
      backup.as_of_time,
      "backup-selection",
      "INVALID_BACKUP_TIME"
    )
  ).toISOString();
  state.checks.exactBackupSelected = true;
  assertUnusedDestination(restoresValue);
  state.checks.noRestoreHistory = true;

  const secrets = new SecretsManagerClient({ region });
  const [sourceDatabaseUrl, emptyDatabaseUrl, restoredDatabaseUrl] =
    await Promise.all([
      databaseSecret(secrets, required("SOURCE_DATABASE_SECRET_ID")),
      databaseSecret(
        secrets,
        required("DESTINATION_EMPTY_DATABASE_SECRET_ID")
      ),
      databaseSecret(
        secrets,
        required("DESTINATION_RESTORED_DATABASE_SECRET_ID")
      ),
    ]);
  const sourceEndpoint = assertSqlEndpoint(
    sourceDatabaseUrl,
    sourceCluster,
    new Set([expectedDatabase]),
    "SOURCE"
  );
  const emptyEndpoint = assertSqlEndpoint(
    emptyDatabaseUrl,
    destinationCluster,
    new Set(["defaultdb", "postgres"]),
    "DESTINATION_EMPTY"
  );
  const restoredEndpoint = assertSqlEndpoint(
    restoredDatabaseUrl,
    destinationCluster,
    new Set([expectedDatabase]),
    "DESTINATION_RESTORED"
  );
  if (
    sourceEndpoint.hostname === emptyEndpoint.hostname ||
    emptyEndpoint.hostname !== restoredEndpoint.hostname
  ) {
    throw new DrillError(
      "sql-endpoint-binding",
      "SOURCE_OR_DESTINATION_ENDPOINT_COLLISION"
    );
  }
  state.checks.sqlEndpointBinding = true;

  state.sourceEvidence = await databaseEvidence(
    sourceDatabaseUrl,
    expectedDatabase
  );
  state.emptyDestinationSqlClusterId =
    await assertEmptyDestination(emptyDatabaseUrl);
  state.checks.destinationWasEmpty = true;
  if (
    state.sourceEvidence.sqlClusterId ===
    state.emptyDestinationSqlClusterId
  ) {
    throw new DrillError(
      "sql-identity",
      "SOURCE_AND_DESTINATION_SQL_CLUSTER_COLLISION"
    );
  }
  state.checks.sqlClustersDifferent = true;

  state.restoreRequestedAt = new Date().toISOString();
  state.rpoSeconds = Math.max(
    0,
    Math.round(
      (dateMillis(
        state.restoreRequestedAt,
        "measurement",
        "INVALID_RESTORE_START"
      ) -
        dateMillis(
          state.backupAsOfTime,
          "measurement",
          "INVALID_BACKUP_AS_OF"
        )) /
        1_000
    )
  );

  const createValue = await cloudApiJson(
    apiKey,
    apiVersion,
    "POST",
    `/api/v1/clusters/${encodeURIComponent(
      state.destinationClusterId
    )}/restores`,
    {
      source_cluster_id: state.sourceClusterId,
      backup_id: state.backupId,
      type: "CLUSTER",
    }
  );
  const expectedRestore = {
    backupId: state.backupId,
    backupAsOfTime: state.backupAsOfTime,
    sourceClusterName: sourceCluster.name,
    destinationClusterName: destinationCluster.name,
  };
  const initialRestore = assertRestoreRecord(
    createValue,
    expectedRestore
  );
  state.restoreId = initialRestore.id;
  const finalRestore = await pollRestore(
    apiKey,
    apiVersion,
    state.destinationClusterId,
    initialRestore,
    expectedRestore,
    state.maxPollMinutes
  );
  state.restoreStatus = finalRestore.status;
  state.restoreApiCompletedAt = new Date().toISOString();
  state.checks.restoreApiSucceeded = true;

  state.destinationEvidence = await retryDestinationEvidence(
    restoredDatabaseUrl,
    expectedDatabase
  );
  if (
    state.destinationEvidence.sqlClusterId !==
      state.emptyDestinationSqlClusterId ||
    state.destinationEvidence.sqlClusterId ===
      state.sourceEvidence.sqlClusterId
  ) {
    throw new DrillError(
      "post-restore-verification",
      "DESTINATION_SQL_IDENTITY_CHANGED"
    );
  }
  state.checks.destinationSqlIdentityPreserved = true;
  assertEvidenceMatches(
    state.sourceEvidence,
    state.destinationEvidence
  );

  state.verificationCompletedAt = new Date().toISOString();
  state.rtoSeconds = Math.max(
    0,
    Math.round(
      (dateMillis(
        state.verificationCompletedAt,
        "measurement",
        "INVALID_VERIFICATION_TIME"
      ) -
        dateMillis(
          state.restoreRequestedAt,
          "measurement",
          "INVALID_RESTORE_REQUEST_TIME"
        )) /
        1_000
    )
  );
  state.rtoObjectiveMet =
    state.rtoSeconds <= state.rtoObjectiveMinutes * 60;
  state.rpoObjectiveMet =
    state.rpoSeconds <= state.rpoObjectiveMinutes * 60;
  if (!state.rtoObjectiveMet || !state.rpoObjectiveMet) {
    throw new DrillError("objectives", "RTO_OR_RPO_OBJECTIVE_MISSED");
  }

  writeReceipt(receiptPath, receipt(state, "passed"));
}

async function main(): Promise<void> {
  const receiptPath =
    process.env.RECEIPT_PATH?.trim() ||
    `${process.env.RUNNER_TEMP?.trim() || "/tmp"}/cockroach-managed-restore/receipt.json`;
  const state: DrillState = { checks: {} };
  try {
    await execute(state);
  } catch (error) {
    const failure =
      error instanceof DrillError
        ? error
        : new DrillError("unexpected", "UNCLASSIFIED_FAILURE");
    writeReceipt(receiptPath, receipt(state, "failed", failure));
    process.stderr.write(
      `Managed-backup restore drill failed closed at ${failure.stage} (${failure.code}).\n`
    );
    process.exitCode = 1;
  }
}

await main();
