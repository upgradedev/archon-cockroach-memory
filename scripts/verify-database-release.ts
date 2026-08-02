import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
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
  memoryContentDigest,
  type MemoryKind,
  type RecallQuery,
  type RecallQueryRow,
} from "../src/memory/memory.js";
import {
  PUBLIC_DEMO_CANONICAL_KEYS,
} from "../src/memory/demo-reconciliation.js";
import {
  affirmativeSystemGrants,
  type SystemGrant,
} from "../src/db/system-grants.js";
import {
  isExpectedResolutionRoutineCreateStatement,
  resolutionRoutineRuntimeEvidence,
  resolutionRoutineSourceEvidence,
} from "../src/db/routine-proof.js";
import {
  assertCockroachEndpointBinding,
  parseDatabaseSecret,
} from "../src/db/secret.js";
import { closePool } from "../src/db/client.js";
import {
  handleCreateResolutionSession,
  handleGetResolutionSession,
  handleResolutionDecision,
} from "../src/http/resolution-handler.js";
import { CockroachResolutionStore } from "../src/memory/resolution-store.js";
import type { ResolutionSnapshot } from "../src/memory/resolution.js";

const { Client } = pg;
type PgClient = InstanceType<typeof Client>;
const schemaSource = readFileSync(
  new URL("../src/db/schema.sql", import.meta.url),
  "utf8"
);

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

const PUBLIC_FIXTURE_KEYS = PUBLIC_DEMO_CANONICAL_KEYS;

const ISOLATION_CANARY_KEYS = [
  "archon-demo/v1/rls-hidden-company-canary",
  "archon-demo/v1/rls-wrong-tenant-canary",
  "archon-demo/v1/rls-retracted-status-canary",
] as const;

const RESOLUTION_TABLES = [
  "memory_demo_sessions",
  "memory_resolution_observations",
  "memory_resolution_proposals",
  "memory_resolution_decisions",
  "memory_resolution_consolidations",
] as const;
const RESOLUTION_TTL_CRON = "0 */4 * * *";
const RESOLUTION_TRANSITION_OWNER =
  "archon_resolution_transition_owner";

const RUNTIME_RELATION_GRANTS = new Map<string, readonly string[]>([
  ["agent_memory", ["SELECT"]],
  [PUBLIC_RECALL_VIEW_NAME, ["SELECT"]],
  [PUBLIC_KIND_RECALL_VIEW_NAME, ["SELECT"]],
  ["memory_demo_sessions", ["SELECT"]],
  ["memory_resolution_observations", ["SELECT"]],
  ["memory_resolution_proposals", ["SELECT"]],
  ["memory_resolution_decisions", ["SELECT"]],
  ["memory_resolution_consolidations", ["SELECT"]],
]);
const RESOLUTION_WRITER_GRANTS = new Map<string, readonly string[]>(
  [...RUNTIME_RELATION_GRANTS].filter(([relation]) =>
    RESOLUTION_TABLES.includes(
      relation as (typeof RESOLUTION_TABLES)[number]
    )
  )
);
const RESOLUTION_TRANSITION_OWNER_GRANTS = new Map<
  string,
  readonly string[]
>([
  ["memory_demo_sessions", ["INSERT", "SELECT", "UPDATE"]],
  ["memory_resolution_observations", ["INSERT", "SELECT", "UPDATE"]],
  ["memory_resolution_proposals", ["INSERT", "SELECT", "UPDATE"]],
  ["memory_resolution_decisions", ["INSERT", "SELECT"]],
  ["memory_resolution_consolidations", ["INSERT", "SELECT"]],
]);
const RESOLUTION_FUNCTIONS = [
  {
    name: "archon_resolution_create_session",
    signature:
      "public.archon_resolution_create_session(STRING, UUID, UUID, UUID, UUID, TIMESTAMPTZ, INT8)",
  },
  {
    name: "archon_resolution_decide",
    signature:
      "public.archon_resolution_decide(STRING, STRING, UUID, UUID, UUID, TIMESTAMPTZ)",
  },
] as const;

function assertResolutionRoutineSourceContracts(): void {
  const evidence = RESOLUTION_FUNCTIONS.map((routine) => {
    const source = resolutionRoutineSourceEvidence(
      schemaSource,
      routine.name
    );
    return {
      name: routine.name,
      sourceContractMatches: source.matches,
      sourceContractMissingRuleIds: source.missingRuleIds,
    };
  });
  if (evidence.some((routine) => !routine.sourceContractMatches)) {
    throw new ReleaseGateError(
      `Resolution routine source qualification contract drifted: ${JSON.stringify(
        evidence
      )}`
    );
  }
}

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

interface RuntimeResolutionProof {
  fixedSyntheticScenario: true;
  serializableTransactions: true;
  databaseEnforcedTransitions: true;
  exactTransitionFunctionExecute: true;
  directResolutionDmlDenied: true;
  approvePath: true;
  rejectPath: true;
  idempotentReplay: true;
  conflictingFinalDecisionRejected: true;
  receiptVerified: true;
  receiptDatabaseDerived: true;
  consolidationVerified: true;
  canonicalMemoryUnchanged: true;
  immutableDecisionTables: true;
  deletePrivilegeAbsent: true;
  externalSideEffects: "none";
  sessionIsolationBoundary: "trusted-lambda-bearer-token";
  retention: "cockroach-row-level-ttl";
  approvedReceiptSha256: string;
  rejectedReceiptSha256: string;
}

interface FixtureRow {
  id: string;
  tenant_id: string;
  kind: MemoryKind;
  company: string;
  period: string | null;
  source_ref: string | null;
  content: string;
  metadata: Record<string, unknown> | null;
  idempotency_key: string;
  content_hash: string | null;
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
  const expectedGrantKeys = new Set(
    [...RUNTIME_RELATION_GRANTS].flatMap(([relation, privileges]) =>
      privileges.map((privilege) => `${relation}:${privilege}`)
    )
  );
  const actualGrantKeys = new Set(
    applicationGrants.map(
      (grant) => `${grant.table_name}:${grant.privilege_type}`
    )
  );
  if (
    applicationGrants.length !== expectedGrantKeys.size ||
    actualGrantKeys.size !== expectedGrantKeys.size ||
    [...expectedGrantKeys].some((key) => !actualGrantKeys.has(key)) ||
    applicationGrants.some(
      (grant) =>
        grant.schema_name !== "public" ||
        grant.is_grantable
    )
  ) {
    throw new ReleaseGateError(
      "Runtime relation privilege matrix exceeds canonical and synthetic SELECT-only access."
    );
  }

  // CockroachDB v26.2.3 reports UDF rows from principal-focused SHOW GRANTS
  // with object_type = 'routine'; object-focused SHOW GRANTS uses FUNCTION.
  const functionGrants = await client.query<{
    schema_name: string | null;
    object_name: string | null;
    object_type: string;
    grantee: string;
    privilege_type: string;
    is_grantable: boolean;
  }>(
    `SELECT schema_name, object_name, object_type, grantee,
            privilege_type, is_grantable
       FROM [SHOW GRANTS FOR ${principalSql}]
      WHERE object_type = 'routine'`
  );
  const functionNames = functionGrants.rows.map((grant) =>
    String(grant.object_name ?? "")
      .replace(/\(.*/u, "")
      .split(".")
      .at(-1)
  );
  const expectedFunctionNames = RESOLUTION_FUNCTIONS.map(
    (routine) => routine.name
  );
  if (
    functionGrants.rows.length !== RESOLUTION_FUNCTIONS.length ||
    new Set(functionNames).size !== RESOLUTION_FUNCTIONS.length ||
    expectedFunctionNames.some((name) => !functionNames.includes(name)) ||
    functionGrants.rows.some(
      (grant) =>
        grant.schema_name !== "public" ||
        grant.object_type !== "routine" ||
        grant.grantee !== "archon_resolution_writer" ||
        grant.privilege_type !== "EXECUTE" ||
        grant.is_grantable
    )
  ) {
    throw new ReleaseGateError(
      "Runtime function privileges exceed the exact two-routine transition API."
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

function requireResolutionSnapshot(
  body: Record<string, unknown>,
  label: string
): ResolutionSnapshot {
  const snapshot = body.snapshot;
  if (typeof snapshot !== "object" || snapshot === null) {
    throw new ReleaseGateError(`${label} did not return a resolution snapshot.`);
  }
  return snapshot as ResolutionSnapshot;
}

function verifyPendingResolutionSnapshot(snapshot: ResolutionSnapshot): void {
  if (
    snapshot.scenarioId !==
      "helios-payroll-2026-06-correction-v1" ||
    snapshot.company !== "Helios SA" ||
    snapshot.period !== "2026-06" ||
    snapshot.state !== "pending" ||
    snapshot.receipt !== null ||
    snapshot.proposal.status !== "pending" ||
    snapshot.proposal.requiresHumanRole !== "financial-controller" ||
    snapshot.policy.canonicalMemoryMutable !== false ||
    snapshot.policy.mutationScope !==
      "ephemeral-synthetic-session-only" ||
    snapshot.policy.retention !== "row-level-ttl" ||
    snapshot.lifecycle.externalSideEffects !== "none" ||
    snapshot.observations.length !== 2 ||
    snapshot.observations[0]?.label !== "prior" ||
    snapshot.observations[0].status !== "current" ||
    snapshot.observations[1]?.label !== "corrected" ||
    snapshot.observations[1].status !== "candidate"
  ) {
    throw new ReleaseGateError(
      "Initial resolution snapshot violated the fixed synthetic policy."
    );
  }
}

async function exerciseResolutionDecision(
  store: CockroachResolutionStore,
  decision: "approve" | "reject"
): Promise<{
  receiptSha256: string;
  conflictingFinalDecisionRejected: true;
}> {
  const created = await handleCreateResolutionSession({}, store);
  if (
    created.status !== 201 ||
    created.body.tokenType !== "Bearer" ||
    typeof created.body.sessionToken !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(created.body.sessionToken)
  ) {
    throw new ReleaseGateError(
      "Resolution session creation did not issue the bounded bearer contract."
    );
  }
  const token = created.body.sessionToken;
  verifyPendingResolutionSnapshot(
    requireResolutionSnapshot(created.body, "Resolution session creation")
  );

  const idempotencyKey = randomUUID();
  const decided = await handleResolutionDecision(
    `Bearer ${token}`,
    { decision, idempotencyKey },
    store
  );
  if (decided.status !== 200 || decided.body.idempotent !== true) {
    throw new ReleaseGateError(
      `${decision} resolution decision did not complete.`
    );
  }
  const snapshot = requireResolutionSnapshot(
    decided.body,
    `${decision} resolution decision`
  );
  const expectedState = decision === "approve" ? "approved" : "rejected";
  const expectedStatuses =
    decision === "approve"
      ? [
          ["prior", "superseded"],
          ["corrected", "current"],
        ]
      : [
          ["prior", "current"],
          ["corrected", "rejected"],
        ];
  const receipt = snapshot.receipt;
  if (
    snapshot.state !== expectedState ||
    snapshot.proposal.status !== expectedState ||
    snapshot.lifecycle.externalSideEffects !== "none" ||
    snapshot.lifecycle.consolidation !==
      (decision === "approve"
        ? "approved-observation-is-current"
        : "prior-observation-remains-current") ||
    JSON.stringify(
      snapshot.observations.map((observation) => [
        observation.label,
        observation.status,
      ])
    ) !== JSON.stringify(expectedStatuses) ||
    !receipt ||
    receipt.actorRole !== "financial-controller" ||
    receipt.policyVersion !== "resolution-policy-v1" ||
    !/^[a-f0-9]{64}$/u.test(receipt.digest)
  ) {
    throw new ReleaseGateError(
      `${decision} resolution lifecycle or receipt drifted.`
    );
  }

  const replay = await handleResolutionDecision(
    `Bearer ${token}`,
    { decision, idempotencyKey },
    store
  );
  const replaySnapshot = requireResolutionSnapshot(
    replay.body,
    `${decision} idempotent replay`
  );
  const replayReceipt = replaySnapshot.receipt;
  if (
    replay.status !== 200 ||
    replaySnapshot.sessionId !== snapshot.sessionId ||
    !replayReceipt ||
    replayReceipt.digest !== receipt.digest ||
    replayReceipt.decisionId !== receipt.decisionId
  ) {
    throw new ReleaseGateError(
      `${decision} resolution replay was not exactly idempotent.`
    );
  }

  const fetched = await handleGetResolutionSession(
    `Bearer ${token}`,
    store
  );
  const fetchedSnapshot = requireResolutionSnapshot(
    fetched.body,
    `${decision} resolution read-after-write`
  );
  if (
    fetched.status !== 200 ||
    fetchedSnapshot.state !== expectedState ||
    fetchedSnapshot.receipt?.digest !== receipt.digest
  ) {
    throw new ReleaseGateError(
      `${decision} resolution read-after-write proof failed.`
    );
  }

  const conflict = await handleResolutionDecision(
    `Bearer ${token}`,
    {
      decision: decision === "approve" ? "reject" : "approve",
      idempotencyKey: randomUUID(),
    },
    store
  );
  if (conflict.status !== 409) {
    throw new ReleaseGateError(
      `${decision} resolution allowed a second final decision.`
    );
  }
  return {
    receiptSha256: receipt.digest,
    conflictingFinalDecisionRejected: true,
  };
}

async function verifyRuntimeResolutionLoop(
  connectionString: string
): Promise<RuntimeResolutionProof> {
  const previousUrl = process.env.DATABASE_URL;
  const previousSecret = process.env.DATABASE_SECRET_ID;
  await closePool();
  process.env.DATABASE_URL = connectionString;
  delete process.env.DATABASE_SECRET_ID;
  try {
    const store = new CockroachResolutionStore();
    const approved = await exerciseResolutionDecision(store, "approve");
    const rejected = await exerciseResolutionDecision(store, "reject");
    return {
      fixedSyntheticScenario: true,
      serializableTransactions: true,
      databaseEnforcedTransitions: true,
      exactTransitionFunctionExecute: true,
      directResolutionDmlDenied: true,
      approvePath: true,
      rejectPath: true,
      idempotentReplay: true,
      conflictingFinalDecisionRejected: true,
      receiptVerified: true,
      receiptDatabaseDerived: true,
      consolidationVerified: true,
      canonicalMemoryUnchanged: true,
      immutableDecisionTables: true,
      deletePrivilegeAbsent: true,
      externalSideEffects: "none",
      sessionIsolationBoundary: "trusted-lambda-bearer-token",
      retention: "cockroach-row-level-ttl",
      approvedReceiptSha256: approved.receiptSha256,
      rejectedReceiptSha256: rejected.receiptSha256,
    };
  } finally {
    await closePool();
    if (previousUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousUrl;
    }
    if (previousSecret === undefined) {
      delete process.env.DATABASE_SECRET_ID;
    } else {
      process.env.DATABASE_SECRET_ID = previousSecret;
    }
  }
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
  distinctIdempotencyKeys: number;
  distinctContentDigests: number;
  cspannRecall: RuntimeCspannProof;
  resolutionLoop: RuntimeResolutionProof;
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
    const isolation = await client.query<Record<string, unknown>>(
      "SHOW transaction_isolation"
    );
    const isolationValue = String(
      Object.values(isolation.rows[0] ?? {})[0] ?? ""
    ).toLowerCase();
    if (isolationValue !== "serializable") {
      throw new ReleaseGateError(
        `${environment} runtime transactions are not serializable.`
      );
    }

    // application_name is attacker-controlled telemetry, never authorization.
    await client.query(
      "SET application_name = 'archon.attacker-selected-scope'"
    );
    const scope = await client.query<{
      visible: string;
      correctly_scoped: string;
      canonical_visible: string;
      isolation_canaries_visible: string;
      idempotency_keys: string;
      content_digests: string;
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
              ) AS isolation_canaries_visible,
              count(DISTINCT idempotency_key) FILTER (
                WHERE length(idempotency_key) BETWEEN 1 AND 256
              ) AS idempotency_keys,
              count(DISTINCT content_hash) FILTER (
                WHERE content_hash ~ '^[a-f0-9]{64}$'
              ) AS content_digests
         FROM agent_memory`,
      [PUBLIC_FIXTURE_KEYS, ISOLATION_CANARY_KEYS]
    );
    const scopeRow = scope.rows[0];
    const visible = Number(scopeRow?.visible ?? 0);
    const canonicalVisible = Number(scopeRow?.canonical_visible ?? 0);
    const distinctIdempotencyKeys = Number(
      scopeRow?.idempotency_keys ?? 0
    );
    const distinctContentDigests = Number(
      scopeRow?.content_digests ?? 0
    );
    if (
      visible !== PUBLIC_FIXTURE_KEYS.length ||
      visible !== Number(scopeRow?.correctly_scoped ?? -1) ||
      canonicalVisible !== PUBLIC_FIXTURE_KEYS.length ||
      distinctIdempotencyKeys !== PUBLIC_FIXTURE_KEYS.length ||
      distinctContentDigests !== PUBLIC_FIXTURE_KEYS.length ||
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
    for (const table of RESOLUTION_TABLES) {
      await expectDenied(
        client,
        `INSERT INTO public.${table}
         SELECT * FROM public.${table} WHERE false`,
        `${environment} direct ${table} INSERT`
      );
      await expectDenied(
        client,
        `UPDATE public.${table}
            SET expires_at = expires_at
          WHERE false`,
        `${environment} direct ${table} UPDATE`
      );
      await expectDenied(
        client,
        `DELETE FROM public.${table} WHERE false`,
        `${environment} direct ${table} DELETE`
      );
    }
    const resolutionLoop = await verifyRuntimeResolutionLoop(
      connectionString
    );
    const canonicalAfter = await client.query<{
      visible: string;
      canonical_visible: string;
      idempotency_keys: string;
      content_digests: string;
    }>(
      `SELECT count(*) AS visible,
              count(*) FILTER (
                WHERE idempotency_key = ANY($1::STRING[])
              ) AS canonical_visible,
              count(DISTINCT idempotency_key) AS idempotency_keys,
              count(DISTINCT content_hash) AS content_digests
         FROM agent_memory`,
      [PUBLIC_FIXTURE_KEYS]
    );
    const after = canonicalAfter.rows[0];
    if (
      Number(after?.visible ?? -1) !== visible ||
      Number(after?.canonical_visible ?? -1) !== canonicalVisible ||
      Number(after?.idempotency_keys ?? -1) !== distinctIdempotencyKeys ||
      Number(after?.content_digests ?? -1) !== distinctContentDigests
    ) {
      throw new ReleaseGateError(
        `${environment} resolution loop mutated canonical agent_memory.`
      );
    }
    return {
      environment,
      principal: expectedPrincipal,
      visibleMemories: visible,
      canonicalMemories: canonicalVisible,
      distinctIdempotencyKeys,
      distinctContentDigests,
      cspannRecall: { noKind, kind },
      resolutionLoop,
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
    "archon_resolution_writer",
    RESOLUTION_TRANSITION_OWNER,
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
    if (
      user.username === "archon_public_reader" ||
      user.username === "archon_resolution_writer"
    ) {
      if (
        memberships.length !== 0 ||
        hasDangerousOption ||
        !options.includes("NOLOGIN") ||
        options.includes("LOGIN")
      ) {
        throw new ReleaseGateError(
          `${user.username} is not a bounded base role.`
        );
      }
      continue;
    }
    if (user.username === RESOLUTION_TRANSITION_OWNER) {
      if (
        memberships.length !== 0 ||
        hasDangerousOption ||
        !options.includes("NOLOGIN") ||
        options.includes("LOGIN")
      ) {
        throw new ReleaseGateError(
          "Resolution transition owner is not an isolated NOLOGIN/NOBYPASSRLS role."
        );
      }
      continue;
    }
    const exactRuntimeMemberships = [...memberships].sort();
    if (
      JSON.stringify(exactRuntimeMemberships) !==
        JSON.stringify([
          "archon_public_reader",
          "archon_resolution_writer",
        ]) ||
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
      stringArray(user.member_of).some((membership) =>
        [PUBLIC_RECALL_VIEW_OWNER, RESOLUTION_TRANSITION_OWNER].includes(
          membership
        )
      )
    )
  ) {
    throw new ReleaseGateError(
      "An isolated object owner unexpectedly has role members."
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
  const resolutionSystemGrants = await client.query<SystemGrant>(
    `SHOW SYSTEM GRANTS FOR archon_resolution_writer`
  );
  if (
    affirmativeSystemGrants(resolutionSystemGrants.rows).length !== 0
  ) {
    throw new ReleaseGateError(
      "Resolution writer has unexpected system privileges."
    );
  }
  const transitionOwnerSystemGrants = await client.query<SystemGrant>(
    `SHOW SYSTEM GRANTS FOR ${RESOLUTION_TRANSITION_OWNER}`
  );
  if (
    affirmativeSystemGrants(transitionOwnerSystemGrants.rows).length !== 0
  ) {
    throw new ReleaseGateError(
      "Resolution transition owner has unexpected system privileges."
    );
  }

  const ownerSchemaGrants = await client.query<{
    grantee: string;
    privilege_type: string;
    is_grantable: boolean;
  }>("SHOW GRANTS ON SCHEMA public");
  const directOwnerSchemaGrants = ownerSchemaGrants.rows.filter(
    (grant) => grant.grantee === RESOLUTION_TRANSITION_OWNER
  );
  if (
    directOwnerSchemaGrants.length !== 1 ||
    directOwnerSchemaGrants[0]?.privilege_type !== "USAGE" ||
    directOwnerSchemaGrants[0].is_grantable
  ) {
    throw new ReleaseGateError(
      "Resolution transition owner must retain USAGE but no CREATE on public."
    );
  }

  const ownerDefaults = await client.query<{
    session_variables: string;
    default_values: string;
    database: string | null;
    inherited_globally: boolean;
  }>(
    `SELECT session_variables, default_values, database, inherited_globally
       FROM [SHOW DEFAULT SESSION VARIABLES
             FOR ROLE ${RESOLUTION_TRANSITION_OWNER}]
      WHERE session_variables = 'search_path'`
  );
  if (
    ownerDefaults.rows.length !== 1 ||
    ownerDefaults.rows[0]?.default_values
      .replace(/\s+/gu, "")
      .toLowerCase() !== "pg_catalog" ||
    ownerDefaults.rows[0].database !== null ||
    !ownerDefaults.rows[0].inherited_globally
  ) {
    throw new ReleaseGateError(
      "Resolution transition owner search_path is not pinned to pg_catalog."
    );
  }

  const ownerRoleGrants = await client.query<{
    role_name: string;
    member: string;
    is_admin: boolean;
  }>(`SHOW GRANTS ON ROLE ${RESOLUTION_TRANSITION_OWNER}`);
  if (ownerRoleGrants.rows.length !== 0) {
    throw new ReleaseGateError(
      "Resolution transition owner must have no role members."
    );
  }

  const runtimeMemberships = await client.query<{
    role_name: string;
    member: string;
    is_admin: boolean;
  }>(
    `SELECT role_name, member, is_admin
       FROM [SHOW GRANTS ON ROLE
             archon_public_reader, archon_resolution_writer]
      WHERE member = ANY($1::STRING[])`,
    [principals]
  );
  const expectedMemberships = new Set(
    principals.flatMap((principal) => [
      `archon_public_reader:${principal}`,
      `archon_resolution_writer:${principal}`,
    ])
  );
  const actualMemberships = new Set(
    runtimeMemberships.rows.map(
      (membership) => `${membership.role_name}:${membership.member}`
    )
  );
  const allBaseRoleMemberships = new Set(
    allUsers.rows.flatMap((user) =>
      stringArray(user.member_of)
        .filter((membership) =>
          ["archon_public_reader", "archon_resolution_writer"].includes(
            membership
          )
        )
        .map((membership) => `${membership}:${user.username}`)
    )
  );
  if (
    runtimeMemberships.rows.length !== expectedMemberships.size ||
    actualMemberships.size !== expectedMemberships.size ||
    allBaseRoleMemberships.size !== expectedMemberships.size ||
    [...expectedMemberships].some(
      (membership) =>
        !actualMemberships.has(membership) ||
        !allBaseRoleMemberships.has(membership)
    ) ||
    runtimeMemberships.rows.some((membership) => membership.is_admin)
  ) {
    throw new ReleaseGateError(
      "Runtime role memberships are not exact or include WITH ADMIN OPTION."
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

function normalizedCatalogExpression(value: string | null): string {
  return (value ?? "")
    .toLowerCase()
    .replaceAll('"', "")
    .replace(/:{2,3}(?:string|text)\b/gu, "")
    .replace(/[()]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

async function verifyExactResolutionRelationGrants(
  client: PgClient,
  role: string,
  expected: ReadonlyMap<string, readonly string[]>
): Promise<number> {
  const grants = await client.query<{
    schema_name: string;
    table_name: string;
    privilege_type: string;
    is_grantable: boolean;
  }>(`SHOW GRANTS ON TABLE * FOR ${quoteIdentifier(role)}`);
  const expectedKeys = new Set(
    [...expected].flatMap(([table, privileges]) =>
      privileges.map((privilege) => `${table}:${privilege}`)
    )
  );
  const actualKeys = new Set(
    grants.rows.map(
      (grant) => `${grant.table_name}:${grant.privilege_type}`
    )
  );
  if (
    grants.rows.length !== expectedKeys.size ||
    actualKeys.size !== expectedKeys.size ||
    [...expectedKeys].some((key) => !actualKeys.has(key)) ||
    grants.rows.some(
      (grant) =>
        grant.schema_name !== "public" ||
        grant.is_grantable ||
        !RESOLUTION_TABLES.includes(
          grant.table_name as (typeof RESOLUTION_TABLES)[number]
        )
    )
  ) {
    throw new ReleaseGateError(`${role} relation privilege matrix drifted.`);
  }
  return grants.rows.length;
}

async function verifyResolutionTransitionFunctions(
  client: PgClient,
  databaseName: string
): Promise<{
  transitionFunctionCount: 2;
  writerFunctionExecuteCount: 2;
}> {
  const routineNames = RESOLUTION_FUNCTIONS.map((routine) => routine.name);
  const routines = await client.query<{
    proname: string;
    owner: string;
    provolatile: string;
    lanname: string;
    prosrc: string;
  }>(
    `SELECT procedures.proname,
            roles.rolname AS owner,
            procedures.provolatile,
            languages.lanname,
            procedures.prosrc
       FROM pg_catalog.pg_proc AS procedures
       JOIN pg_catalog.pg_namespace AS namespaces
         ON namespaces.oid = procedures.pronamespace
       JOIN pg_catalog.pg_roles AS roles
         ON roles.oid = procedures.proowner
       JOIN pg_catalog.pg_language AS languages
         ON languages.oid = procedures.prolang
      WHERE namespaces.nspname = 'public'
        AND procedures.proname = ANY($1::STRING[])`,
    [routineNames]
  );

  // CockroachDB v26.2.3 reports prosecdef=false for user-defined routines in
  // pg_proc even when their descriptor is SECURITY DEFINER. SHOW CREATE is
  // descriptor-backed and therefore the authoritative security-mode proof.
  const createStatements = new Map<string, string>();
  const showCreateCounts = new Map<string, number>();
  for (const routine of RESOLUTION_FUNCTIONS) {
    const shown = await client.query<{
      function_name: string;
      create_statement: string;
    }>(
      `SHOW CREATE FUNCTION public.${quoteIdentifier(routine.name)}`
    );
    showCreateCounts.set(routine.name, shown.rows.length);
    if (
      shown.rows.length === 1 &&
      shown.rows[0]?.function_name === routine.name
    ) {
      createStatements.set(
        routine.name,
        shown.rows[0].create_statement
      );
    }
  }

  const routineEvidence = RESOLUTION_FUNCTIONS.map((expected) => {
    const matchingRows = routines.rows.filter(
      (routine) => routine.proname === expected.name
    );
    const routine = matchingRows[0];
    const createStatement = createStatements.get(expected.name);
    const bodyEvidence =
      routine === undefined
        ? {
            matches: false,
            missingRuleIds: ["catalog.body.available"],
          }
        : resolutionRoutineRuntimeEvidence(
            routine.prosrc,
            schemaSource,
            expected.name,
            databaseName
          );
    return {
      name: expected.name,
      catalogRows: matchingRows.length,
      showCreateRows: showCreateCounts.get(expected.name) ?? 0,
      ownerMatches:
        routine?.owner === RESOLUTION_TRANSITION_OWNER,
      securityDefinerMatches:
        createStatement !== undefined &&
        isExpectedResolutionRoutineCreateStatement(
          createStatement,
          expected.name
        ),
      volatileMatches: routine?.provolatile === "v",
      languageMatches:
        routine?.lanname.toLowerCase() === "plpgsql",
      bodyContractMatches: bodyEvidence.matches,
      bodyContractMissingRuleIds: bodyEvidence.missingRuleIds,
      bodyContractDiagnostics:
        "diagnostics" in bodyEvidence ? bodyEvidence.diagnostics : null,
      // The routine body is checked-in, non-secret source. Emit the exact
      // CockroachDB descriptor rendering only when the fail-closed body gate
      // rejects it, so CI can prove formatter compatibility without local
      // database execution or persistent diagnostic artifacts.
      runtimeBodyForDiagnostics:
        bodyEvidence.matches ? null : (routine?.prosrc ?? null),
    };
  });
  if (
    routines.rows.length !== RESOLUTION_FUNCTIONS.length ||
    routineEvidence.some(
      (evidence) =>
        evidence.catalogRows !== 1 ||
        evidence.showCreateRows !== 1 ||
        !evidence.ownerMatches ||
        !evidence.securityDefinerMatches ||
        !evidence.volatileMatches ||
        !evidence.languageMatches ||
        !evidence.bodyContractMatches
    )
  ) {
    throw new ReleaseGateError(
      `Resolution SECURITY DEFINER routine ownership or body contract drifted: ${JSON.stringify(
        routineEvidence
      )}`
    );
  }

  for (const routine of RESOLUTION_FUNCTIONS) {
    const grants = await client.query<{
      schema_name: string;
      routine_signature: string;
      grantee: string;
      privilege_type: string;
      is_grantable: boolean;
    }>(`SHOW GRANTS ON FUNCTION ${routine.signature}`);
    const writerGrants = grants.rows.filter(
      (grant) => grant.grantee === "archon_resolution_writer"
    );
    if (
      writerGrants.length !== 1 ||
      writerGrants[0]?.privilege_type !== "EXECUTE" ||
      writerGrants[0].is_grantable ||
      grants.rows.some(
        (grant) =>
          grant.grantee === "public" ||
          grant.schema_name !== "public" ||
          ![
            "admin",
            "root",
            RESOLUTION_TRANSITION_OWNER,
            "archon_resolution_writer",
          ].includes(grant.grantee)
      )
    ) {
      throw new ReleaseGateError(
        `Resolution routine ${routine.name} EXECUTE grants drifted.`
      );
    }
  }

  // Keep the principal-focused routine discriminator exact and fail closed.
  const effectiveFunctions = await client.query<{
    schema_name: string | null;
    object_name: string | null;
    object_type: string;
    grantee: string;
    privilege_type: string;
    is_grantable: boolean;
  }>(
    `SELECT schema_name, object_name, object_type, grantee,
            privilege_type, is_grantable
       FROM [SHOW GRANTS FOR archon_resolution_writer]
      WHERE object_type = 'routine'`
  );
  const effectiveNames = effectiveFunctions.rows.map((grant) =>
    String(grant.object_name ?? "")
      .replace(/\(.*/u, "")
      .split(".")
      .at(-1)
  );
  if (
    effectiveFunctions.rows.length !== RESOLUTION_FUNCTIONS.length ||
    new Set(effectiveNames).size !== RESOLUTION_FUNCTIONS.length ||
    routineNames.some((name) => !effectiveNames.includes(name)) ||
    effectiveFunctions.rows.some(
      (grant) =>
        grant.schema_name !== "public" ||
        grant.object_type !== "routine" ||
        grant.grantee !== "archon_resolution_writer" ||
        grant.privilege_type !== "EXECUTE" ||
        grant.is_grantable
    )
  ) {
    throw new ReleaseGateError(
      "Resolution writer can execute functions outside the exact transition API."
    );
  }
  return {
    transitionFunctionCount: 2,
    writerFunctionExecuteCount: 2,
  };
}

async function verifyResolutionSandboxSecurity(
  client: PgClient,
  databaseName: string
): Promise<{
  tables: 5;
  rlsPolicies: 15;
  ttlExpirationExpression: "expires_at";
  ttlSchedule: typeof RESOLUTION_TTL_CRON;
  ttlClusterEnabled: true;
  ttlScheduleStatus: "ACTIVE";
  ttlPaused: false;
  writerRelationGrantCount: 5;
  transitionOwnerRelationGrantCount: 13;
  transitionFunctionCount: 2;
  writerFunctionExecuteCount: 2;
  directRuntimeDml: "none";
}> {
  const tables = await client.query<{ table_name: string }>(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = 'public'
        AND (
          table_name = 'memory_demo_sessions'
          OR table_name LIKE 'memory_resolution_%'
        )
      ORDER BY table_name`
  );
  const expectedTables = [...RESOLUTION_TABLES].sort();
  const actualTables = tables.rows.map((row) => row.table_name);
  if (
    actualTables.length !== expectedTables.length ||
    JSON.stringify(actualTables) !== JSON.stringify(expectedTables)
  ) {
    throw new ReleaseGateError(
      "Exact five-table resolution sandbox proof failed."
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
        AND classes.relname = ANY($1::STRING[])`,
    [RESOLUTION_TABLES]
  );
  if (
    rls.rows.length !== RESOLUTION_TABLES.length ||
    rls.rows.some(
      (row) =>
        row.relrowsecurity !== true || row.relforcerowsecurity !== true
    )
  ) {
    throw new ReleaseGateError(
      "Resolution sandbox RLS is not enabled and forced on every table."
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
    `SELECT tablename, policyname, permissive, cmd, roles, qual, with_check
       FROM pg_catalog.pg_policies
      WHERE schemaname = 'public'
        AND tablename = ANY($1::STRING[])`,
    [RESOLUTION_TABLES]
  );
  if (policies.rows.length !== RESOLUTION_TABLES.length * 3) {
    throw new ReleaseGateError(
      "Resolution sandbox RLS policy count drifted."
    );
  }
  for (const table of RESOLUTION_TABLES) {
    const tablePolicies = policies.rows.filter(
      (policy) => policy.tablename === table
    );
    const operator = tablePolicies.find(
      (policy) => policy.policyname === `${table}_operator_v1`
    );
    const permit = tablePolicies.find(
      (policy) => policy.policyname === `${table}_writer_permit_v1`
    );
    const guard = tablePolicies.find(
      (policy) => policy.policyname === `${table}_writer_guard_v1`
    );
    for (const [policy, mode] of [
      [permit, "permissive"],
      [guard, "restrictive"],
    ] as const) {
      const using = normalizedCatalogExpression(policy?.qual ?? null);
      const check = normalizedCatalogExpression(
        policy?.with_check ?? null
      );
      if (
        !policy ||
        policy.permissive.toLowerCase() !== mode ||
        policy.cmd.toLowerCase() !== "all" ||
        JSON.stringify(stringArray(policy.roles).sort()) !==
          JSON.stringify(
            [
              RESOLUTION_TRANSITION_OWNER,
              "archon_resolution_writer",
            ].sort()
          ) ||
        using.includes(" or ") ||
        check.includes(" or ") ||
        !using.includes("tenant_id = 'public-demo'") ||
        !using.includes("company = 'helios sa'") ||
        !using.includes("expires_at >") ||
        (!using.includes("now") &&
          !using.includes("current_timestamp")) ||
        !check.includes("tenant_id = 'public-demo'") ||
        !check.includes("company = 'helios sa'") ||
        !check.includes("expires_at >") ||
        (!check.includes("now") &&
          !check.includes("current_timestamp")) ||
        (!check.includes("61") && !check.includes("01:01:00"))
      ) {
        throw new ReleaseGateError(
          `Resolution writer RLS policy drifted on ${table}.`
        );
      }
    }
    if (
      tablePolicies.length !== 3 ||
      operator?.permissive.toLowerCase() !== "permissive" ||
      operator.cmd.toLowerCase() !== "all" ||
      normalizedCatalogExpression(operator.qual) !== "true" ||
      normalizedCatalogExpression(operator.with_check) !== "true"
    ) {
      throw new ReleaseGateError(
        `Resolution operator RLS policy drifted on ${table}.`
      );
    }
  }

  const ttl = await client.query<{ create_statement: string }>(
    `SELECT create_statement
       FROM [SHOW CREATE TABLE memory_demo_sessions]`
  );
  const createStatement = ttl.rows[0]?.create_statement ?? "";
  if (
    ttl.rows.length !== 1 ||
    !/\bttl\s*=\s*'on'/iu.test(createStatement) ||
    !/ttl_expiration_expression\s*=\s*'expires_at'/iu.test(
      createStatement
    ) ||
    !/ttl_job_cron\s*=\s*'0 \*\/4 \* \* \*'/iu.test(
      createStatement
    ) ||
    /\bttl_pause\s*=/iu.test(createStatement)
  ) {
    throw new ReleaseGateError(
      "Resolution sandbox row-level TTL contract drifted."
    );
  }
  const ttlSetting = await client.query<{
    variable: string;
    value: string;
  }>(
    `SELECT variable, value
       FROM [SHOW ALL CLUSTER SETTINGS]
      WHERE variable = 'sql.ttl.job.enabled'`
  );
  if (
    ttlSetting.rows.length !== 1 ||
    String(ttlSetting.rows[0]?.value).toLowerCase() !== "true"
  ) {
    throw new ReleaseGateError(
      "CockroachDB row-level TTL jobs are disabled."
    );
  }
  const ttlTable = await client.query<{ table_id: string }>(
    `SELECT oid::STRING AS table_id
       FROM pg_catalog.pg_class
      WHERE oid = 'public.memory_demo_sessions'::REGCLASS`
  );
  const ttlTableId = ttlTable.rows[0]?.table_id;
  if (ttlTable.rows.length !== 1 || !ttlTableId) {
    throw new ReleaseGateError(
      "Could not bind the resolution TTL schedule to its table descriptor."
    );
  }
  const ttlSchedules = await client.query<{
    label: string;
    schedule_status: string;
    recurrence: string;
    table_id: string | null;
  }>(
    `SELECT label,
            schedule_status,
            recurrence,
            (command::JSONB)->>'tableId' AS table_id
       FROM [SHOW SCHEDULES]
      WHERE label = $1`,
    [`row-level-ttl: memory_demo_sessions [${ttlTableId}]`]
  );
  if (
    ttlSchedules.rows.length !== 1 ||
    ttlSchedules.rows[0]?.schedule_status.toUpperCase() !== "ACTIVE" ||
    ttlSchedules.rows[0].recurrence !== RESOLUTION_TTL_CRON ||
    ttlSchedules.rows[0].table_id !== ttlTableId
  ) {
    throw new ReleaseGateError(
      "Resolution TTL schedule is not exactly one active four-hour job bound to the target table."
    );
  }

  const writerRelationGrantCount =
    await verifyExactResolutionRelationGrants(
      client,
      "archon_resolution_writer",
      RESOLUTION_WRITER_GRANTS
    );
  const transitionOwnerRelationGrantCount =
    await verifyExactResolutionRelationGrants(
      client,
      RESOLUTION_TRANSITION_OWNER,
      RESOLUTION_TRANSITION_OWNER_GRANTS
    );
  const transitionFunctions =
    await verifyResolutionTransitionFunctions(client, databaseName);

  return {
    tables: 5,
    rlsPolicies: 15,
    ttlExpirationExpression: "expires_at",
    ttlSchedule: RESOLUTION_TTL_CRON,
    ttlClusterEnabled: true,
    ttlScheduleStatus: "ACTIVE",
    ttlPaused: false,
    writerRelationGrantCount:
      writerRelationGrantCount as 5,
    transitionOwnerRelationGrantCount:
      transitionOwnerRelationGrantCount as 13,
    ...transitionFunctions,
    directRuntimeDml: "none",
  };
}

async function verifyAdmin(
  adminUrl: string,
  runtimePrincipals: string[]
): Promise<{
  version: string;
  databaseName: string;
  fixtureRows: number;
  storeIntegrity: {
    activeMemories: number;
    canonicalMemories: number;
    distinctIdempotencyKeys: number;
    distinctContentDigests: number;
  };
  indexDefinitionFingerprints: {
    company: string;
    kind: string;
  };
  isolationCanaryVectors: IsolationCanaryVector[];
  resolutionSandbox: {
    tables: 5;
    rlsPolicies: 15;
    ttlExpirationExpression: "expires_at";
    ttlSchedule: typeof RESOLUTION_TTL_CRON;
    ttlClusterEnabled: true;
    ttlScheduleStatus: "ACTIVE";
    ttlPaused: false;
    writerRelationGrantCount: 5;
    transitionOwnerRelationGrantCount: 13;
    transitionFunctionCount: 2;
    writerFunctionExecuteCount: 2;
    directRuntimeDml: "none";
  };
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
              metadata, idempotency_key, content_hash, status, created_at
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
    const canonicalPublicRows = PUBLIC_FIXTURE_KEYS.map((key) =>
      byKey.get(key)
    );
    if (
      canonicalPublicRows.some(
        (row) => {
          if (
            !row ||
            row.tenant_id !== "public-demo" ||
            row.company !== "Helios SA" ||
            row.status !== "active" ||
            typeof row.content_hash !== "string"
          ) {
            return true;
          }
          const expectedDigest = memoryContentDigest({
            tenantId: row.tenant_id,
            kind: row.kind,
            company: row.company,
            period: row.period,
            sourceRef: row.source_ref,
            content: row.content,
            metadata: row.metadata,
          });
          return (
            row.content_hash !== expectedDigest ||
            !/^[a-f0-9]{64}$/u.test(row.content_hash)
          );
        }
      )
    ) {
      throw new ReleaseGateError(
        "Canonical public memory content-digest proof failed."
      );
    }

    const activeStore = await client.query<{
      active_memories: string;
      canonical_memories: string;
      idempotency_keys: string;
      content_digests: string;
    }>(
      `SELECT count(*) AS active_memories,
              count(*) FILTER (
                WHERE idempotency_key = ANY($2::STRING[])
              ) AS canonical_memories,
              count(DISTINCT idempotency_key) FILTER (
                WHERE length(idempotency_key) BETWEEN 1 AND 256
              ) AS idempotency_keys,
              count(DISTINCT content_hash) FILTER (
                WHERE content_hash ~ '^[a-f0-9]{64}$'
              ) AS content_digests
         FROM agent_memory
        WHERE tenant_id = 'public-demo'
          AND company = 'Helios SA'
          AND status = 'active'
          AND embed_model = $1`,
      [expectedModel, PUBLIC_FIXTURE_KEYS]
    );
    const storeRow = activeStore.rows[0];
    const storeIntegrity = {
      activeMemories: Number(storeRow?.active_memories ?? 0),
      canonicalMemories: Number(storeRow?.canonical_memories ?? 0),
      distinctIdempotencyKeys: Number(storeRow?.idempotency_keys ?? 0),
      distinctContentDigests: Number(storeRow?.content_digests ?? 0),
    };
    if (
      Object.values(storeIntegrity).some(
        (value) => value !== PUBLIC_FIXTURE_KEYS.length
      )
    ) {
      throw new ReleaseGateError(
        "Canonical active memory store is not exactly reconciled."
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
    // The runtime body proof accepts CockroachDB's canonical unqualified
    // built-ins only after the SECURITY DEFINER owner's pg_catalog-only
    // search_path and isolation have been proven.
    const resolutionSandbox = await verifyResolutionSandboxSecurity(
      client,
      databaseRow.database_name
    );
    return {
      version: databaseRow.version.split(" ").slice(0, 3).join(" "),
      databaseName: databaseRow.database_name,
      fixtureRows: fixtureCount,
      storeIntegrity,
      indexDefinitionFingerprints: indexFingerprints,
      isolationCanaryVectors,
      resolutionSandbox,
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

function releaseDigests(): {
  schemaSha256: string;
  fixtureManifestSha256: string;
} {
  return {
    schemaSha256: createHash("sha256")
      .update(schemaSource, "utf8")
      .digest("hex"),
    fixtureManifestSha256: createHash("sha256")
      .update(JSON.stringify(CANONICAL_MANIFEST), "utf8")
      .digest("hex"),
  };
}

async function main(): Promise<void> {
  assertResolutionRoutineSourceContracts();
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

  const expectedSqlDns = required("COCKROACH_SQL_DNS");
  const [stagingUrl, productionUrl] = await Promise.all([
    getDatabaseUrl(required("STAGING_DATABASE_SECRET_ID")),
    getDatabaseUrl(required("PRODUCTION_DATABASE_SECRET_ID")),
  ]);
  const adminUrl = parseDatabaseSecret(required("DATABASE_URL"), {
    requireTls: true,
  });
  const endpointBindings = [adminUrl, stagingUrl, productionUrl].map(
    (url) => assertCockroachEndpointBinding(url, expectedSqlDns)
  );
  const endpointHostnameSha256 = createHash("sha256")
    .update(endpointBindings[0]!.hostname, "utf8")
    .digest("hex");
  if (
    endpointBindings.some(
      (binding) =>
        binding.hostname !== endpointBindings[0]!.hostname ||
        binding.port !== 26257 ||
        binding.database !== expectedDatabase ||
        binding.tlsMode !== "verify-full" ||
        binding.routingOverrides !== "none"
    )
  ) {
    throw new ReleaseGateError(
      "Admin and runtime URLs are not bound to one Cockroach Cloud endpoint."
    );
  }
  const runtimePrincipals = [stagingUrl, productionUrl].map((url) =>
    decodeURIComponent(new URL(url).username)
  );
  const admin = await verifyAdmin(adminUrl, runtimePrincipals);
  // Resolution verification temporarily binds the application's singleton
  // pool to each real runtime URL, so environments are exercised sequentially
  // and can never share a connection or credential cache.
  const staging = await verifyRuntime(
    "staging",
    stagingUrl,
    admin.isolationCanaryVectors
  );
  const production = await verifyRuntime(
    "production",
    productionUrl,
    admin.isolationCanaryVectors
  );
  const digests = releaseDigests();

  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 5,
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
          sqlEndpointBinding: {
            source: "exact primary eu-west-1 regions[].sql_dns",
            endpointHostnameSha256,
            port: 26257,
            database: expectedDatabase,
            tlsMode: "verify-full",
            routingOverrides: "none",
            boundUrlCount: endpointBindings.length,
          },
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
          durableStoreIntegrity: true,
          canonicalActiveMemories:
            admin.storeIntegrity.canonicalMemories,
          distinctIdempotencyKeys:
            admin.storeIntegrity.distinctIdempotencyKeys,
          distinctContentDigests:
            admin.storeIntegrity.distinctContentDigests,
          scopedServingQueriesRejectCanaries: true,
          isolationCanaryCount: ISOLATION_CANARY_KEYS.length,
          isolatedNonLoginServingViewOwner: true,
          servingViewOwnerPrivilegeBoundary:
            "direct non-inheritable BYPASSRLS role option; SELECT agent_memory only; no system privileges",
          runtimePrincipalCspannPlanAndExecute: true,
          runtimePrincipalNoKindCspann: true,
          runtimePrincipalKindCspann: true,
          runtimeCspannEnvironmentCount: 2,
          memoryResolutionLoop: true,
          runtimeResolutionEnvironmentCount: 2,
          resolutionSandbox: admin.resolutionSandbox,
          resolutionIsolationBoundary:
            "trusted Lambda validates opaque bearer tokens; CockroachDB SECURITY DEFINER transition API confines mutation to fixed synthetic TTL rows",
          transitionOwnerPrivilegeBoundary:
            "NOLOGIN/NOBYPASSRLS; no members or parent roles; schema USAGE without CREATE; 13 bounded relation grants; owns exactly two SECURITY DEFINER routines",
          indexDefinitionFingerprints:
            admin.indexDefinitionFingerprints,
          roleBoundRls: true,
          attackerSelectedApplicationNameIgnored: true,
          wrongCompanyInvisible: true,
          wrongTenantInvisible: true,
          retractedStatusInvisible: true,
          runtimeRelationPrivilegeMatrix:
            "canonical and fixed synthetic SELECT only; zero direct INSERT/UPDATE/DELETE",
          runtimeFunctionPrivilegeMatrix:
            "EXECUTE only on archon_resolution_create_session and archon_resolution_decide",
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
