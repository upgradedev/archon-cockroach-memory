// Approval-gated two-principal CockroachDB runtime credential rotation.
//
// The script prints only a sanitized receipt. Passwords, connection URLs,
// secret identifiers, AWS account data, version IDs, and principal names are
// never printed. The owning GitHub workflow binds all external inputs to an
// exact green and deployed main SHA before invoking this mutation.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  GetSecretValueCommand,
  ListSecretVersionIdsCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
  UpdateSecretVersionStageCommand,
} from "@aws-sdk/client-secrets-manager";
import pg, { type Client as PgClient } from "pg";
import { DATABASE_APPLICATION_NAME } from "../src/config/scope.js";
import {
  PUBLIC_KIND_RECALL_VIEW_NAME,
  PUBLIC_RECALL_VIEW_NAME,
} from "../src/db/proof.js";
import {
  assertCockroachEndpointBinding,
  parseDatabaseSecret,
} from "../src/db/secret.js";
import {
  affirmativeSystemGrants,
  type SystemGrant,
} from "../src/db/system-grants.js";

const { Client } = pg;

const EXPECTED_RUNTIME_RELATION_GRANTS = new Map<
  string,
  readonly string[]
>([
  ["agent_memory", ["SELECT"]],
  [PUBLIC_RECALL_VIEW_NAME, ["SELECT"]],
  [PUBLIC_KIND_RECALL_VIEW_NAME, ["SELECT"]],
  ["memory_demo_sessions", ["SELECT"]],
  ["memory_resolution_observations", ["SELECT"]],
  ["memory_resolution_proposals", ["SELECT"]],
  ["memory_resolution_decisions", ["SELECT"]],
  ["memory_resolution_consolidations", ["SELECT"]],
]);
const EXPECTED_RUNTIME_FUNCTIONS = new Set([
  "archon_resolution_create_session",
  "archon_resolution_decide",
]);
const PRIVILEGED_ROLE_OPTIONS = new Set([
  "ADMIN",
  "BYPASSRLS",
  "CANCELQUERY",
  "CONTROLCHANGEFEED",
  "CONTROLJOB",
  "CREATEDB",
  "CREATELOGIN",
  "CREATEROLE",
  "MODIFYCLUSTERSETTING",
  "VIEWACTIVITY",
  "VIEWACTIVITYREDACTED",
  "VIEWCLUSTERSETTING",
]);

interface SecretVersion {
  connectionString: string;
  versionId: string;
}

interface HostedProof {
  database?: {
    engine?: unknown;
    runtimePrincipal?: unknown;
    region?: unknown;
    regionEvidence?: unknown;
  };
  vectorIndex?: {
    engine?: unknown;
    enabled?: unknown;
  };
  release?: {
    commitSha?: unknown;
    evidence?: unknown;
  };
}

interface HostedRecall {
  answer?: unknown;
  consistencyOk?: unknown;
  grounding?: {
    status?: unknown;
    checks?: {
      citations?: unknown;
      numerics?: unknown;
      claims?: unknown;
    };
  };
  modelId?: unknown;
  recalled?: unknown;
  citations?: Array<{
    company?: unknown;
    content?: unknown;
    kind?: unknown;
    marker?: unknown;
    memoryId?: unknown;
    period?: unknown;
    score?: unknown;
    sourceRef?: unknown;
  }>;
  trace?: {
    scope?: {
      access?: unknown;
      company?: unknown;
      dataClassification?: unknown;
      mode?: unknown;
      source?: unknown;
      tenantId?: unknown;
    };
    retrieval?: {
      database?: unknown;
      index?: unknown;
      metric?: unknown;
      recalled?: unknown;
      requestedKind?: unknown;
      requestedTopK?: unknown;
    };
  };
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function boundedInteger(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const raw = process.env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} is outside its bounded integer contract.`);
  }
  return value;
}

function identifier(value: string, label: string): string {
  if (!/^[a-z][a-z0-9_]{2,62}$/u.test(value)) {
    throw new Error(`${label} has an invalid identifier shape.`);
  }
  return `"${value.replaceAll('"', '""')}"`;
}

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function rotationConfirmation(environment: string): string {
  if (environment !== "staging" && environment !== "production") {
    throw new Error("Rotation environment must be staging or production.");
  }
  return `ROTATE-${environment.toUpperCase()}-RUNTIME-CREDENTIAL`;
}

export function redactedDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function secretValue(response: {
  SecretString?: string;
  SecretBinary?: Uint8Array;
  VersionId?: string;
  VersionStages?: string[];
}, expectedStage: "AWSCURRENT" | "AWSPENDING" | "AWSPREVIOUS"): SecretVersion {
  const value =
    response.SecretString ??
    (response.SecretBinary
      ? new TextDecoder().decode(response.SecretBinary)
      : undefined);
  if (
    !value ||
    typeof response.VersionId !== "string" ||
    !/^[A-Za-z0-9_-]{32,64}$/u.test(response.VersionId) ||
    !response.VersionStages?.includes(expectedStage)
  ) {
    throw new Error("Secret version response is outside the rotation contract.");
  }
  return {
    connectionString: parseDatabaseSecret(value, { requireTls: true }),
    versionId: response.VersionId,
  };
}

async function readSecretStage(
  secrets: SecretsManagerClient,
  secretId: string,
  stage: "AWSCURRENT" | "AWSPENDING" | "AWSPREVIOUS"
): Promise<SecretVersion> {
  return secretValue(
    await secrets.send(
      new GetSecretValueCommand({
        SecretId: secretId,
        VersionStage: stage,
      })
    ),
    stage
  );
}

async function waitForSecretStageVersion(
  secrets: SecretsManagerClient,
  secretId: string,
  stage: "AWSCURRENT" | "AWSPENDING" | "AWSPREVIOUS",
  expectedVersionId: string,
  timeoutSeconds = 60
): Promise<SecretVersion> {
  const deadline = Date.now() + timeoutSeconds * 1_000;
  do {
    try {
      const observed = await readSecretStage(secrets, secretId, stage);
      if (observed.versionId === expectedVersionId) return observed;
    } catch {
      // Secrets Manager label changes are eventually consistent. Provider
      // errors and stale observations stay private and are retried within the
      // same fixed bound; the caller never infers success from a different ID.
    }
    if (Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
    }
  } while (Date.now() < deadline);
  throw new Error("Secret version labels did not converge within the bound.");
}

function runtimePrincipal(
  connectionString: string,
  environment: "staging" | "production",
  expectedSqlDns: string
): string {
  assertCockroachEndpointBinding(connectionString, expectedSqlDns);
  const principal = decodeURIComponent(new URL(connectionString).username);
  if (
    !new RegExp(`^archon_${environment}_[a-z0-9]{6,40}$`, "u").test(
      principal
    )
  ) {
    throw new Error("Runtime secret principal is outside the rotation contract.");
  }
  return principal;
}

async function proveExactPrincipal(
  admin: PgClient,
  principal: string,
  databaseName: string
): Promise<void> {
  const principalSql = identifier(principal, "runtime principal");
  const databaseSql = identifier(databaseName, "application database");
  const user = await admin.query<{
    username: string;
    options: string[] | string;
    member_of: string[] | string;
  }>("SELECT username, options, member_of FROM [SHOW USERS] WHERE username = $1", [
    principal,
  ]);
  const list = (value: string[] | string): string[] =>
    (Array.isArray(value) ? value : value.replace(/[{}\"]/gu, "").split(","))
      .map((item) => item.trim())
      .filter(Boolean);
  const roles = list(user.rows[0]?.member_of ?? []).sort();
  const options = list(user.rows[0]?.options ?? []).map((item) =>
    item.toUpperCase()
  );
  const privilegedOption = options.some((option) =>
    PRIVILEGED_ROLE_OPTIONS.has(option.split(/[=\s]/u, 1)[0] ?? option)
  );
  if (
    user.rows.length !== 1 ||
    JSON.stringify(roles) !==
      JSON.stringify(
        ["archon_public_reader", "archon_resolution_writer"].sort()
      ) ||
    privilegedOption ||
    options.includes("NOLOGIN")
  ) {
    throw new Error("Runtime principal proof did not converge.");
  }
  const memberships = await admin.query<{
    role_name: string;
    member: string;
    is_admin: boolean;
  }>(
    `SELECT role_name, member, is_admin
       FROM [SHOW GRANTS ON ROLE
             archon_public_reader, archon_resolution_writer]
      WHERE member = $1`,
    [principal]
  );
  if (
    memberships.rows.length !== 2 ||
    memberships.rows.some((membership) => membership.is_admin)
  ) {
    throw new Error("Runtime principal memberships are not exact non-admin grants.");
  }

  const tableGrants = await admin.query<{
    schema_name: string;
    table_name: string;
    privilege_type: string;
    is_grantable: boolean;
  }>(`SHOW GRANTS ON TABLE * FOR ${principalSql}`);
  const expectedTableGrants = new Set(
    [...EXPECTED_RUNTIME_RELATION_GRANTS].flatMap(([relation, privileges]) =>
      privileges.map((privilege) => `${relation}:${privilege}`)
    )
  );
  const actualTableGrants = new Set(
    tableGrants.rows.map(
      (grant) => `${grant.table_name}:${grant.privilege_type}`
    )
  );
  if (
    tableGrants.rows.length !== expectedTableGrants.size ||
    actualTableGrants.size !== expectedTableGrants.size ||
    [...expectedTableGrants].some((grant) => !actualTableGrants.has(grant)) ||
    tableGrants.rows.some(
      (grant) => grant.schema_name !== "public" || grant.is_grantable
    )
  ) {
    throw new Error("Runtime principal relation grants are not exact.");
  }

  // Principal-focused SHOW GRANTS classifies UDF rows as routines in v26.2.3.
  const functionGrants = await admin.query<{
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
  if (
    functionGrants.rows.length !== EXPECTED_RUNTIME_FUNCTIONS.size ||
    new Set(functionNames).size !== EXPECTED_RUNTIME_FUNCTIONS.size ||
    [...EXPECTED_RUNTIME_FUNCTIONS].some(
      (name) => !functionNames.includes(name)
    ) ||
    functionGrants.rows.some(
      (grant) =>
        grant.schema_name !== "public" ||
        grant.object_type !== "routine" ||
        grant.grantee !== "archon_resolution_writer" ||
        grant.privilege_type !== "EXECUTE" ||
        grant.is_grantable
    )
  ) {
    throw new Error("Runtime principal function grants are not exact.");
  }

  const schemaGrants = await admin.query<{
    privilege_type: string;
    is_grantable: boolean;
  }>(`SHOW GRANTS ON SCHEMA public FOR ${principalSql}`);
  if (
    schemaGrants.rows.length < 1 ||
    schemaGrants.rows.some(
      (grant) => grant.privilege_type !== "USAGE" || grant.is_grantable
    )
  ) {
    throw new Error("Runtime principal schema grants exceed USAGE.");
  }

  const databaseGrants = await admin.query<{
    privilege_type: string;
    is_grantable: boolean;
  }>(`SHOW GRANTS ON DATABASE ${databaseSql} FOR ${principalSql}`);
  if (
    databaseGrants.rows.length < 1 ||
    databaseGrants.rows.some(
      (grant) => grant.privilege_type !== "CONNECT" || grant.is_grantable
    )
  ) {
    throw new Error("Runtime principal database grants exceed CONNECT.");
  }

  const systemGrants = await admin.query<SystemGrant>(
    `SHOW SYSTEM GRANTS FOR ${principalSql}`
  );
  if (affirmativeSystemGrants(systemGrants.rows).length !== 0) {
    throw new Error("Runtime principal has affirmative system privileges.");
  }
}

async function createRuntimePrincipal(
  admin: PgClient,
  input: {
    principal: string;
    password: string;
    database: string;
  }
): Promise<void> {
  const user = identifier(input.principal, "new runtime principal");
  const database = identifier(input.database, "application database");
  const existing = await admin.query(
    "SELECT username FROM [SHOW USERS] WHERE username = $1",
    [input.principal]
  );
  if (existing.rowCount !== 0) {
    throw new Error("Generated runtime principal already exists.");
  }
  // CockroachDB role DDL is an autocommitted schema change. Do not present a
  // transaction-shaped atomicity claim: every following statement is
  // independently idempotent, the exact final catalog is reconciled below,
  // and the outer state machine removes a partially prepared principal before
  // any secret cutover is attempted.
  await admin.query(`CREATE USER ${user}`);
  await admin.query(
    `ALTER USER ${user} WITH PASSWORD ${literal(input.password)}`
  );
  await admin.query(`ALTER ROLE ${user} WITH NOBYPASSRLS`);
  await admin.query(
    `REVOKE CONNECT, TEMPORARY ON DATABASE ${database} FROM ${user}`
  );
  await admin.query(`REVOKE USAGE, CREATE ON SCHEMA public FROM ${user}`);
  await admin.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${user}`);
  await admin.query(
    `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM ${user}`
  );
  await admin.query(`GRANT CONNECT ON DATABASE ${database} TO ${user}`);
  await admin.query(`GRANT USAGE ON SCHEMA public TO ${user}`);
  await admin.query(`GRANT archon_public_reader TO ${user}`);
  await admin.query(`GRANT archon_resolution_writer TO ${user}`);
  await proveExactPrincipal(admin, input.principal, input.database);
}

async function testPendingCredential(
  connectionString: string,
  expectedPrincipal: string
): Promise<void> {
  const pending = new Client({
    connectionString,
    application_name: `${DATABASE_APPLICATION_NAME}.rotation-probe`,
    connectionTimeoutMillis: 10_000,
  });
  try {
    await pending.connect();
    const identity = await pending.query<{ current_user: string }>(
      "SELECT current_user"
    );
    const visible = await pending.query<{ visible: string | number }>(
      "SELECT count(*) AS visible FROM archon_public_memory_recall"
    );
    const count = Number(visible.rows[0]?.visible ?? -1);
    if (
      identity.rows.length !== 1 ||
      identity.rows[0]?.current_user !== expectedPrincipal ||
      !Number.isSafeInteger(count) ||
      count !== 9
    ) {
      throw new Error("Pending runtime credential SQL proof failed.");
    }
  } finally {
    await pending.end().catch(() => undefined);
  }
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: {
      ...(init?.headers ?? {}),
      "User-Agent": "archon-runtime-rotation/1",
    },
  });
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  if (
    response.status !== 200 ||
    !contentType.toLowerCase().startsWith("application/json") ||
    text.length === 0 ||
    text.length > 1_000_000
  ) {
    throw new Error("Hosted rotation proof returned an invalid response.");
  }
  return JSON.parse(text) as T;
}

function exactHostedProof(
  proof: HostedProof,
  principal: string,
  releaseSha: string
): boolean {
  return (
    proof.database?.engine === "CockroachDB" &&
    proof.database.runtimePrincipal === principal &&
    proof.database.region === "eu-west-1" &&
    proof.database.regionEvidence === "cockroach-cloud-api-release-gate" &&
    proof.vectorIndex?.engine === "native CockroachDB C-SPANN" &&
    proof.vectorIndex.enabled === true &&
    proof.release?.commitSha === releaseSha &&
    proof.release.evidence === "server-configured Lambda environment"
  );
}

async function waitForHostedPrincipal(input: {
  applicationUrl: string;
  principal: string;
  releaseSha: string;
  timeoutSeconds: number;
}): Promise<number> {
  const started = Date.now();
  const deadline = started + input.timeoutSeconds * 1_000;
  while (Date.now() < deadline) {
    try {
      // The bounded burst reaches the small reserved-concurrency fleet without
      // invoking Bedrock and forces warm runtimes to observe the secret cadence.
      const proofs = await Promise.all(
        Array.from({ length: 5 }, () =>
          fetchJson<HostedProof>(`${input.applicationUrl}/api/proof`)
        )
      );
      if (
        proofs.every((proof) =>
          exactHostedProof(proof, input.principal, input.releaseSha)
        )
      ) {
        const recall = await fetchJson<HostedRecall>(
          `${input.applicationUrl}/api/recall`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              question:
                "What was the true employer cost and the off-bank payroll wedge for April 2026?",
              kind: "payroll_event",
              limit: 5,
            }),
          }
        );
        const citations = Array.isArray(recall.citations)
          ? recall.citations
          : [];
        const answer =
          typeof recall.answer === "string" ? recall.answer : "";
        const grounding = recall.grounding;
        const groundingChecks = grounding?.checks;
        const scope = recall.trace?.scope;
        if (
          (grounding?.status === "verified" ||
            grounding?.status === "extractive") &&
          groundingChecks?.citations === true &&
          groundingChecks?.numerics === true &&
          groundingChecks?.claims === true &&
          recall.consistencyOk === true &&
          recall.modelId === "eu.anthropic.claude-sonnet-4-6" &&
          answer.includes("€15,375") &&
          answer.includes("€6,775") &&
          Number.isInteger(recall.recalled) &&
          Number(recall.recalled) >= 1 &&
          Number(recall.recalled) === citations.length &&
          citations.every(
            (citation, index) =>
              citation.marker === `[${index + 1}]` &&
              answer.includes(citation.marker) &&
              citation.company === "Helios SA" &&
              citation.kind === "payroll_event" &&
              citation.period === "2026-04" &&
              typeof citation.content === "string" &&
              citation.content.length > 0 &&
              typeof citation.memoryId === "string" &&
              /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
                citation.memoryId
              ) &&
              typeof citation.sourceRef === "string" &&
              citation.sourceRef.length > 0 &&
              typeof citation.score === "number" &&
              citation.score >= 0.15 &&
              citation.score <= 1
          ) &&
          scope &&
          Object.keys(scope).sort().join(",") ===
            "access,company,dataClassification,mode,source,tenantId" &&
          scope.tenantId === "public-demo" &&
          scope.company === "Helios SA" &&
          scope.mode === "fixed-synthetic-demo" &&
          scope.access === "read-only" &&
          scope.dataClassification === "synthetic-public-demo" &&
          scope.source === "server-configured" &&
          recall.trace?.retrieval?.database === "CockroachDB" &&
          recall.trace.retrieval.index === "native C-SPANN vector index" &&
          recall.trace.retrieval.metric === "cosine" &&
          recall.trace.retrieval.requestedKind === "payroll_event" &&
          recall.trace.retrieval.requestedTopK === 5 &&
          recall.trace.retrieval.recalled === recall.recalled
        ) {
          return Math.ceil((Date.now() - started) / 1_000);
        }
      }
    } catch {
      // The next bounded poll may observe the newly active secret. Raw network
      // or provider errors are deliberately not copied into the receipt.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10_000));
  }
  throw new Error("Hosted runtime did not converge to the expected credential.");
}

async function oldRuntimeSessions(
  admin: PgClient,
  principal: string
): Promise<string[]> {
  const result = await admin.query<{ session_id: string }>(
    `SELECT session_id
       FROM [SHOW CLUSTER SESSIONS]
      WHERE user_name = $1`,
    [principal]
  );
  if (
    result.rows.some(
      (row) =>
        typeof row.session_id !== "string" ||
        !/^[a-z0-9]{16,64}$/u.test(row.session_id)
    )
  ) {
    throw new Error("CockroachDB returned an invalid session identifier.");
  }
  return result.rows.map((row) => row.session_id);
}

async function disableAndDrainPrincipal(
  admin: PgClient,
  principal: string,
  graceSeconds: number
): Promise<{ drainSeconds: number; cancelledSessions: number }> {
  const user = identifier(principal, "retiring runtime principal");
  await admin.query(`ALTER USER ${user} NOLOGIN`);
  const disabled = await admin.query<{ options: string[] | string }>(
    "SELECT options FROM [SHOW USERS] WHERE username = $1",
    [principal]
  );
  const disabledOptions = (
    Array.isArray(disabled.rows[0]?.options)
      ? disabled.rows[0].options
      : String(disabled.rows[0]?.options ?? "")
          .replace(/[{}\"]/gu, "")
          .split(",")
  ).map((option) => option.trim().toUpperCase());
  if (disabled.rows.length !== 1 || !disabledOptions.includes("NOLOGIN")) {
    throw new Error("Retiring runtime principal did not become NOLOGIN.");
  }
  const started = Date.now();
  const deadline = started + graceSeconds * 1_000;
  let sessions = await oldRuntimeSessions(admin, principal);
  while (sessions.length > 0 && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5_000));
    sessions = await oldRuntimeSessions(admin, principal);
  }
  const cancelledSessions = sessions.length;
  for (const sessionId of sessions) {
    await admin.query(`CANCEL SESSION ${literal(sessionId)}`);
  }
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    sessions = await oldRuntimeSessions(admin, principal);
    if (sessions.length === 0) break;
    if (attempt < 12) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5_000));
    }
  }
  if (sessions.length !== 0) {
    throw new Error("Retiring runtime sessions did not drain.");
  }
  return {
    drainSeconds: Math.ceil((Date.now() - started) / 1_000),
    cancelledSessions,
  };
}

async function proveCredentialRejected(connectionString: string): Promise<void> {
  const retired = new Client({
    connectionString,
    application_name: `${DATABASE_APPLICATION_NAME}.retired-probe`,
    connectionTimeoutMillis: 10_000,
  });
  let connected = false;
  try {
    await retired.connect();
    connected = true;
  } catch (error) {
    const sqlState =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : "";
    if (sqlState === "28000" || sqlState === "28P01") return;
    throw new Error(
      "Retired runtime credential failed for a non-authentication reason."
    );
  } finally {
    await retired.end().catch(() => undefined);
  }
  if (connected) {
    throw new Error("Retired runtime credential still authenticates.");
  }
}

async function dropRuntimePrincipal(
  admin: PgClient,
  principal: string,
  databaseName: string
): Promise<void> {
  const user = identifier(principal, "retiring runtime principal");
  const database = identifier(databaseName, "application database");
  // These revocations are safe to repeat. As with creation, Cockroach role DDL
  // is not wrapped in a misleading multi-statement transaction; catalog
  // absence is the terminal proof.
  await admin.query(`REVOKE archon_resolution_writer FROM ${user}`);
  await admin.query(`REVOKE archon_public_reader FROM ${user}`);
  await admin.query(
    `REVOKE CONNECT, TEMPORARY ON DATABASE ${database} FROM ${user}`
  );
  await admin.query(`REVOKE USAGE, CREATE ON SCHEMA public FROM ${user}`);
  await admin.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${user}`);
  await admin.query(
    `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM ${user}`
  );
  try {
    await admin.query(`DROP USER ${user}`);
  } catch {
    const reconciled = await admin.query(
      "SELECT username FROM [SHOW USERS] WHERE username = $1",
      [principal]
    );
    if (reconciled.rowCount !== 0) {
      throw new Error("Retired runtime principal drop requires operator review.");
    }
  }
  const remaining = await admin.query(
    "SELECT username FROM [SHOW USERS] WHERE username = $1",
    [principal]
  );
  if (remaining.rowCount !== 0) {
    throw new Error("Retired runtime principal still exists.");
  }
}

async function removeVersionLabel(
  secrets: SecretsManagerClient,
  secretId: string,
  stage: "AWSPENDING" | "AWSPREVIOUS",
  versionId: string
): Promise<void> {
  await secrets.send(
    new UpdateSecretVersionStageCommand({
      SecretId: secretId,
      VersionStage: stage,
      RemoveFromVersionId: versionId,
    })
  );
}

async function waitForVersionStageAbsent(
  secrets: SecretsManagerClient,
  secretId: string,
  stage: "AWSPENDING" | "AWSPREVIOUS",
  versionId: string,
  timeoutSeconds = 60
): Promise<void> {
  const deadline = Date.now() + timeoutSeconds * 1_000;
  do {
    try {
      let nextToken: string | undefined;
      let observedStages: string[] | undefined;
      let pages = 0;
      do {
        const response = await secrets.send(
          new ListSecretVersionIdsCommand({
            SecretId: secretId,
            IncludeDeprecated: true,
            MaxResults: 100,
            NextToken: nextToken,
          })
        );
        const matching = (response.Versions ?? []).filter(
          (version) => version.VersionId === versionId
        );
        if (matching.length > 1 || (observedStages && matching.length > 0)) {
          throw new Error("Secret version inventory is not unique.");
        }
        if (matching.length === 1) {
          observedStages = matching[0]?.VersionStages ?? [];
        }
        nextToken = response.NextToken;
        pages += 1;
        if (pages > 10) {
          throw new Error("Secret version inventory exceeded the page bound.");
        }
      } while (nextToken);
      if (!observedStages?.includes(stage)) return;
    } catch {
      // Provider errors and eventually consistent stage inventories are retried
      // inside one fixed bound; absence is never inferred from a failed call.
    }
    if (Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
    }
  } while (Date.now() < deadline);
  throw new Error("Secret version stage removal did not converge.");
}

export type RotationPhase =
  | "preflight"
  | "admin-connected"
  | "current-principal-proved"
  | "candidate-principal-preparing"
  | "candidate-principal-created"
  | "pending-version-put-attempted"
  | "pending-credential-proved"
  | "cutover-attempted"
  | "cutover-proved"
  | "hosted-convergence-proved"
  | "retirement-started"
  | "old-principal-disabled-and-drained"
  | "old-credential-rejected"
  | "old-principal-dropped"
  | "finalized";

export interface RotationRecoveryState {
  candidateNamed: boolean;
  cutoverAcknowledged: boolean;
  cutoverAttempted: boolean;
  cutoverProved: boolean;
  newPrincipalCreated: boolean;
  retirementStarted: boolean;
}

export interface RotationRecoveryActions {
  cleanupPreparedPrincipal(): Promise<void>;
  observeCandidateAsCurrent(): Promise<void>;
  reconcilePreparedPrincipal(): Promise<boolean>;
  rollbackToPrevious(): Promise<void>;
}

export interface RotationRecoveryOutcome {
  cleanup: "complete" | "not-required" | "operator-review";
  errorCode:
    | "ROTATION_RECOVERED"
    | "ROTATION_CANDIDATE_STATE_AMBIGUOUS"
    | "ROTATION_CLEANUP_REQUIRES_REVIEW"
    | "ROTATION_CUTOVER_STATE_AMBIGUOUS"
    | "ROTATION_RETIREMENT_REQUIRES_REVIEW"
    | "ROTATION_ROLLBACK_REQUIRES_REVIEW";
  operatorReviewRequired: boolean;
  result:
    | "cleaned-prepared-principal"
    | "no-mutation-to-recover"
    | "operator-review-required"
    | "rolled-back-and-cleaned";
  rollback: "complete" | "not-required" | "operator-review";
}

// Failure recovery is an explicit, dependency-injected state machine. CI can
// inject lost provider responses, stale observations, and partial CockroachDB
// DDL, while production supplies only exact-version and exact-principal probes.
export async function recoverFailedRotation(
  state: RotationRecoveryState,
  actions: RotationRecoveryActions
): Promise<RotationRecoveryOutcome> {
  let preparedPrincipal = state.newPrincipalCreated;
  let cutoverProved = state.cutoverProved;
  let rollback: RotationRecoveryOutcome["rollback"] = "not-required";

  if (state.candidateNamed && !preparedPrincipal) {
    try {
      preparedPrincipal = await actions.reconcilePreparedPrincipal();
    } catch {
      return {
        cleanup: "operator-review",
        errorCode: "ROTATION_CANDIDATE_STATE_AMBIGUOUS",
        operatorReviewRequired: true,
        result: "operator-review-required",
        rollback,
      };
    }
  }

  if (state.retirementStarted) {
    return {
      cleanup: "operator-review",
      errorCode: "ROTATION_RETIREMENT_REQUIRES_REVIEW",
      operatorReviewRequired: true,
      result: "operator-review-required",
      rollback: cutoverProved ? "operator-review" : rollback,
    };
  }

  if (state.cutoverAttempted && !cutoverProved) {
    try {
      // A response or read can be stale. Only the exact candidate observed as
      // AWSCURRENT authorizes rollback or subsequent candidate cleanup.
      await actions.observeCandidateAsCurrent();
      cutoverProved = true;
    } catch {
      return {
        cleanup: preparedPrincipal ? "operator-review" : "not-required",
        errorCode: "ROTATION_CUTOVER_STATE_AMBIGUOUS",
        operatorReviewRequired: true,
        result: "operator-review-required",
        rollback: "operator-review",
      };
    }
  }

  if (cutoverProved) {
    try {
      await actions.rollbackToPrevious();
      rollback = "complete";
      cutoverProved = false;
    } catch {
      return {
        cleanup: preparedPrincipal ? "operator-review" : "not-required",
        errorCode: "ROTATION_ROLLBACK_REQUIRES_REVIEW",
        operatorReviewRequired: true,
        result: "operator-review-required",
        rollback: "operator-review",
      };
    }
  }

  if (preparedPrincipal) {
    try {
      await actions.cleanupPreparedPrincipal();
    } catch {
      return {
        cleanup: "operator-review",
        errorCode: "ROTATION_CLEANUP_REQUIRES_REVIEW",
        operatorReviewRequired: true,
        result: "operator-review-required",
        rollback,
      };
    }
    return {
      cleanup: "complete",
      errorCode: "ROTATION_RECOVERED",
      operatorReviewRequired: false,
      result:
        rollback === "complete"
          ? "rolled-back-and-cleaned"
          : "cleaned-prepared-principal",
      rollback,
    };
  }

  return {
    cleanup: "not-required",
    errorCode: "ROTATION_RECOVERED",
    operatorReviewRequired: false,
    result: "no-mutation-to-recover",
    rollback,
  };
}

export class RuntimeCredentialRotationFailure extends Error {
  constructor(readonly receipt: Record<string, unknown>) {
    super("Runtime credential rotation failed (details redacted).");
    this.name = "RuntimeCredentialRotationFailure";
  }
}

export async function rotateRuntimeCredential(): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  const environmentRaw = required("APP_ENV");
  if (environmentRaw !== "staging" && environmentRaw !== "production") {
    throw new Error("APP_ENV must be staging or production.");
  }
  const environment = environmentRaw;
  const appName = process.env.APP_NAME?.trim() || "archon-memory";
  if (!/^[a-z][a-z0-9-]{2,16}$/u.test(appName)) {
    throw new Error("APP_NAME is outside the naming contract.");
  }
  if (required("ROTATION_CONFIRMATION") !== rotationConfirmation(environment)) {
    throw new Error("Rotation confirmation does not match the environment.");
  }
  const region = process.env.AWS_REGION?.trim() || "eu-west-1";
  if (region !== "eu-west-1") {
    throw new Error("Runtime credential rotation is fixed to eu-west-1.");
  }
  const releaseSha = required("RELEASE_SHA");
  if (!/^[0-9a-f]{40}$/u.test(releaseSha)) {
    throw new Error("RELEASE_SHA must be an exact lowercase commit SHA.");
  }
  const secretId = required("DATABASE_SECRET_ID");
  if (secretId !== `${appName}/${environment}/database`) {
    throw new Error("DATABASE_SECRET_ID does not match the environment.");
  }
  const applicationUrl = required("APPLICATION_URL");
  if (!/^https:\/\/[a-z0-9-]+\.cloudfront\.net$/u.test(applicationUrl)) {
    throw new Error("APPLICATION_URL must be one bare HTTPS CloudFront origin.");
  }
  const expectedSqlDns = required("COCKROACH_SQL_DNS");
  const adminUrl = parseDatabaseSecret(required("DATABASE_URL"), {
    requireTls: true,
  });
  assertCockroachEndpointBinding(adminUrl, expectedSqlDns);
  const propagationTimeoutSeconds = boundedInteger(
    "ROTATION_PROPAGATION_TIMEOUT_SECONDS",
    240,
    90,
    600
  );
  const drainGraceSeconds = boundedInteger(
    "ROTATION_DRAIN_GRACE_SECONDS",
    60,
    30,
    180
  );

  const secrets = new SecretsManagerClient({ region });
  const admin = new Client({
    connectionString: adminUrl,
    application_name: `${DATABASE_APPLICATION_NAME}.rotation-admin`,
    connectionTimeoutMillis: 10_000,
  });
  let oldVersion: SecretVersion | undefined;
  let oldPrincipal = "";
  let newVersionId = "";
  let newPrincipal = "";
  let candidateSecretString = "";
  let newPrincipalCreated = false;
  let phase: RotationPhase = "preflight";
  let cutoverAttempted = false;
  let cutoverAcknowledged = false;
  let cutoverProved = false;
  let retirementStarted = false;

  try {
    await admin.connect();
    phase = "admin-connected";
    oldVersion = await readSecretStage(secrets, secretId, "AWSCURRENT");
    oldPrincipal = runtimePrincipal(
      oldVersion.connectionString,
      environment,
      expectedSqlDns
    );
    const oldUrl = new URL(oldVersion.connectionString);
    const databaseName = decodeURIComponent(oldUrl.pathname.replace(/^\//u, ""));
    if (databaseName !== "archon") {
      throw new Error("Runtime secret does not target the application database.");
    }
    await proveExactPrincipal(admin, oldPrincipal, databaseName);
    phase = "current-principal-proved";
    const rotationId = randomBytes(5).toString("hex");
    newPrincipal = `archon_${environment}_${rotationId}`;
    const password = randomBytes(36).toString("base64url");
    phase = "candidate-principal-preparing";
    await createRuntimePrincipal(admin, {
      principal: newPrincipal,
      password,
      database: databaseName,
    });
    newPrincipalCreated = true;
    phase = "candidate-principal-created";

    const newUrl = new URL(oldVersion.connectionString);
    newUrl.username = newPrincipal;
    newUrl.password = password;
    const newConnectionString = newUrl.toString();
    assertCockroachEndpointBinding(newConnectionString, expectedSqlDns);
    candidateSecretString = JSON.stringify({
      DATABASE_URL: newConnectionString,
    });
    const clientRequestToken = randomUUID();
    // Record the idempotency token before the network call. If the response is
    // lost after AWS commits the version, recovery can still reconcile labels.
    newVersionId = clientRequestToken;
    phase = "pending-version-put-attempted";
    const put = await secrets.send(
      new PutSecretValueCommand({
        SecretId: secretId,
        ClientRequestToken: clientRequestToken,
        SecretString: candidateSecretString,
        VersionStages: ["AWSPENDING"],
      })
    );
    if (put.VersionId !== clientRequestToken) {
      throw new Error("Pending secret version identity is not idempotently bound.");
    }
    const pending = await waitForSecretStageVersion(
      secrets,
      secretId,
      "AWSPENDING",
      newVersionId
    );
    runtimePrincipal(pending.connectionString, environment, expectedSqlDns);
    await testPendingCredential(pending.connectionString, newPrincipal);
    phase = "pending-credential-proved";

    cutoverAttempted = true;
    phase = "cutover-attempted";
    await secrets.send(
      new UpdateSecretVersionStageCommand({
        SecretId: secretId,
        VersionStage: "AWSCURRENT",
        MoveToVersionId: newVersionId,
        RemoveFromVersionId: oldVersion.versionId,
      })
    );
    cutoverAcknowledged = true;
    const current = await waitForSecretStageVersion(
      secrets,
      secretId,
      "AWSCURRENT",
      newVersionId
    );
    if (
      runtimePrincipal(current.connectionString, environment, expectedSqlDns) !==
      newPrincipal
    ) {
      throw new Error("Current secret principal did not converge after cutover.");
    }
    cutoverProved = true;
    phase = "cutover-proved";
    const previous = await waitForSecretStageVersion(
      secrets,
      secretId,
      "AWSPREVIOUS",
      oldVersion.versionId
    );
    if (
      current.versionId !== newVersionId ||
      previous.versionId !== oldVersion.versionId ||
      runtimePrincipal(current.connectionString, environment, expectedSqlDns) !==
        newPrincipal ||
      runtimePrincipal(previous.connectionString, environment, expectedSqlDns) !==
        oldPrincipal
    ) {
      throw new Error("Secret staging labels did not converge after cutover.");
    }

    const propagationSeconds = await waitForHostedPrincipal({
      applicationUrl,
      principal: newPrincipal,
      releaseSha,
      timeoutSeconds: propagationTimeoutSeconds,
    });
    phase = "hosted-convergence-proved";

    retirementStarted = true;
    phase = "retirement-started";
    const drain = await disableAndDrainPrincipal(
      admin,
      oldPrincipal,
      drainGraceSeconds
    );
    phase = "old-principal-disabled-and-drained";
    await proveCredentialRejected(oldVersion.connectionString);
    phase = "old-credential-rejected";
    await dropRuntimePrincipal(admin, oldPrincipal, databaseName);
    phase = "old-principal-dropped";
    await removeVersionLabel(secrets, secretId, "AWSPENDING", newVersionId);
    const finalCurrent = await waitForSecretStageVersion(
      secrets,
      secretId,
      "AWSCURRENT",
      newVersionId
    );
    const finalPrevious = await waitForSecretStageVersion(
      secrets,
      secretId,
      "AWSPREVIOUS",
      oldVersion.versionId
    );
    if (
      finalCurrent.versionId !== newVersionId ||
      finalPrevious.versionId !== oldVersion.versionId
    ) {
      throw new Error("Final secret staging labels are invalid.");
    }
    await proveExactPrincipal(admin, newPrincipal, databaseName);
    await waitForHostedPrincipal({
      applicationUrl,
      principal: newPrincipal,
      releaseSha,
      timeoutSeconds: 90,
    });
    phase = "finalized";

    return {
      schema: "archon.cockroach-runtime-credential-rotation",
      schemaVersion: 1,
      ok: true,
      result: "cutover-and-retirement-complete",
      generatedAt: new Date().toISOString(),
      releaseSha,
      environment,
      region,
      application: {
        scheme: "https",
        host: new URL(applicationUrl).hostname,
        exactReleaseProved: true,
      },
      principals: {
        oldPrincipalSha256: redactedDigest(oldPrincipal),
        newPrincipalSha256: redactedDigest(newPrincipal),
        exactLeastPrivilegeMemberships: true,
        pendingCredentialSqlProved: true,
        oldLoginRejected: true,
        oldSessionsDrained: true,
        cancelledOldSessions: drain.cancelledSessions,
        oldPrincipalDropped: true,
      },
      secret: {
        currentVersionSha256: redactedDigest(newVersionId),
        previousVersionSha256: redactedDigest(oldVersion.versionId),
        awspendingRemoved: true,
        identifiersRedacted: true,
        materialPrinted: false,
      },
      measurements: {
        propagationSeconds,
        drainSeconds: drain.drainSeconds,
        totalSeconds: Math.ceil((Date.now() - startedAt) / 1_000),
      },
      safety: {
        canonicalMemoryMutated: false,
        applicationDataMutated: false,
        crossRegionWorkloadCreated: false,
        rollbackAvailableBeforeRetirement: true,
        endpointBinding:
          "authenticated Cockroach Cloud API primary eu-west-1 sql_dns",
      },
      limitations: [
        "The retained AWSPREVIOUS material references a dropped principal and is evidence, not a working rollback credential.",
        "This receipt proves one approved rotation event; it does not claim automatic scheduled rotation.",
      ],
    };
  } catch {
    const recovery = await recoverFailedRotation(
      {
        candidateNamed: newPrincipal.length > 0,
        cutoverAcknowledged,
        cutoverAttempted,
        cutoverProved,
        newPrincipalCreated,
        retirementStarted,
      },
      {
        async reconcilePreparedPrincipal(): Promise<boolean> {
          const observed = await admin.query(
            "SELECT username FROM [SHOW USERS] WHERE username = $1",
            [newPrincipal]
          );
          return observed.rowCount === 1;
        },

        async observeCandidateAsCurrent(): Promise<void> {
          if (!newVersionId) {
            throw new Error("Candidate version was never allocated.");
          }
          await waitForSecretStageVersion(
            secrets,
            secretId,
            "AWSCURRENT",
            newVersionId
          );
        },

        async rollbackToPrevious(): Promise<void> {
          if (!oldVersion || !newVersionId || !oldPrincipal) {
            throw new Error("Rollback prerequisites are incomplete.");
          }
          await secrets.send(
            new UpdateSecretVersionStageCommand({
              SecretId: secretId,
              VersionStage: "AWSCURRENT",
              MoveToVersionId: oldVersion.versionId,
              RemoveFromVersionId: newVersionId,
            })
          );
          await waitForSecretStageVersion(
            secrets,
            secretId,
            "AWSCURRENT",
            oldVersion.versionId
          );
          await waitForHostedPrincipal({
            applicationUrl,
            principal: oldPrincipal,
            releaseSha,
            timeoutSeconds: propagationTimeoutSeconds,
          });
        },

        async cleanupPreparedPrincipal(): Promise<void> {
          if (!newPrincipal) {
            throw new Error("Prepared principal identity is unavailable.");
          }
          // Re-submit the exact idempotent Put after a lost response. This
          // proves whether the known token became AWSPENDING before any label
          // is removed or its corresponding CockroachDB principal is dropped.
          if (!cutoverAttempted && newVersionId && candidateSecretString) {
            const reconciledPut = await secrets.send(
              new PutSecretValueCommand({
                SecretId: secretId,
                ClientRequestToken: newVersionId,
                SecretString: candidateSecretString,
                VersionStages: ["AWSPENDING"],
              })
            );
            if (reconciledPut.VersionId !== newVersionId) {
              throw new Error("Pending version reconciliation was not exact.");
            }
            await waitForSecretStageVersion(
              secrets,
              secretId,
              "AWSPENDING",
              newVersionId
            );
          }
          if (newVersionId) {
            await removeVersionLabel(
              secrets,
              secretId,
              "AWSPREVIOUS",
              newVersionId
            ).catch(() => undefined);
            await waitForVersionStageAbsent(
              secrets,
              secretId,
              "AWSPREVIOUS",
              newVersionId
            );
            await removeVersionLabel(
              secrets,
              secretId,
              "AWSPENDING",
              newVersionId
            ).catch(() => undefined);
            await waitForVersionStageAbsent(
              secrets,
              secretId,
              "AWSPENDING",
              newVersionId
            );
          }
          const databaseName = decodeURIComponent(
            new URL(oldVersion?.connectionString ?? adminUrl).pathname.replace(
              /^\//u,
              ""
            )
          );
          await disableAndDrainPrincipal(admin, newPrincipal, 30);
          await dropRuntimePrincipal(admin, newPrincipal, databaseName);
        },
      }
    );
    throw new RuntimeCredentialRotationFailure({
      schema: "archon.cockroach-runtime-credential-rotation",
      schemaVersion: 1,
      ok: false,
      result: "failed",
      generatedAt: new Date().toISOString(),
      releaseSha,
      environment,
      region,
      failure: {
        phase,
        errorCode: recovery.errorCode,
        providerDetailsRedacted: true,
        state: {
          candidateNamed: newPrincipal.length > 0,
          newPrincipalCreationAcknowledged: newPrincipalCreated,
          cutoverAttempted,
          cutoverAcknowledged,
          cutoverProved,
          retirementStarted,
        },
        recovery: {
          result: recovery.result,
          rollback: recovery.rollback,
          cleanup: recovery.cleanup,
          operatorReviewRequired: recovery.operatorReviewRequired,
        },
      },
      secret: {
        identifiersRedacted: true,
        materialPrinted: false,
      },
      safety: {
        canonicalMemoryMutated: false,
        applicationDataMutated: false,
        crossRegionWorkloadCreated: false,
      },
    });
  } finally {
    await admin.end().catch(() => undefined);
    secrets.destroy();
  }
}

const invoked = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : "";
if (invoked === import.meta.url) {
  rotateRuntimeCredential()
    .then((receipt) => {
      process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    })
    .catch((error: unknown) => {
      const environment = process.env.APP_ENV?.trim();
      const releaseSha = process.env.RELEASE_SHA?.trim();
      const receipt =
        error instanceof RuntimeCredentialRotationFailure
          ? error.receipt
          : {
              schema: "archon.cockroach-runtime-credential-rotation",
              schemaVersion: 1,
              ok: false,
              result: "failed",
              generatedAt: new Date().toISOString(),
              releaseSha:
                releaseSha && /^[0-9a-f]{40}$/u.test(releaseSha)
                  ? releaseSha
                  : "unbound",
              environment:
                environment === "staging" || environment === "production"
                  ? environment
                  : "unbound",
              region:
                process.env.AWS_REGION?.trim() === "eu-west-1"
                  ? "eu-west-1"
                  : "unbound",
              failure: {
                phase: "preflight",
                errorCode: "ROTATION_PREFLIGHT_FAILED",
                providerDetailsRedacted: true,
                recovery: {
                  result: "no-mutation-to-recover",
                  rollback: "not-required",
                  cleanup: "not-required",
                  operatorReviewRequired: false,
                },
              },
              secret: {
                identifiersRedacted: true,
                materialPrinted: false,
              },
              safety: {
                canonicalMemoryMutated: false,
                applicationDataMutated: false,
                crossRegionWorkloadCreated: false,
              },
            };
      process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
      process.stderr.write("Runtime credential rotation failed (details redacted).\n");
      process.exitCode = 1;
    });
}
