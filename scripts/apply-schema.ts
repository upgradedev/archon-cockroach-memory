// Apply src/db/schema.sql to the CockroachDB pointed at by DATABASE_URL.
//
//   npm run db:schema
//
// Forward-only and idempotent. CockroachDB DDL runs as ordered implicit
// transactions; schema.sql installs restrictive replacement policies before
// removing legacy policies so any interruption fails closed.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { PoolClient } from "pg";
import { getPool, closePool } from "../src/db/client.js";
import {
  EXPECTED_KIND_VECTOR_INDEX_NAME,
  EXPECTED_VECTOR_INDEX_NAME,
  PUBLIC_KIND_RECALL_VIEW_NAME,
  PUBLIC_RECALL_VIEW_NAME,
  PUBLIC_RECALL_VIEW_OWNER,
  isExpectedKindVectorIndexDefinition,
  isExpectedPublicRecallViewDefinition,
  isExpectedVectorIndexDefinition,
} from "../src/db/proof.js";
import {
  affirmativeSystemGrants,
  type SystemGrant,
} from "../src/db/system-grants.js";
import {
  isExpectedResolutionRoutineCreateStatement,
  resolutionRoutineRuntimeEvidence,
  resolutionRoutineSourceEvidence,
} from "../src/db/routine-proof.js";
import { verifyClusterWideResolutionGrants } from "../src/db/cluster-grant-proof.js";

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(here, "..", "src", "db", "schema.sql");
const schemaSource = readFileSync(schemaPath, "utf8");
const RESOLUTION_TABLES = [
  "memory_demo_sessions",
  "memory_resolution_observations",
  "memory_resolution_proposals",
  "memory_resolution_decisions",
  "memory_resolution_consolidations",
] as const;
const RESOLUTION_TTL_CRON = "0 */4 * * *";
const JUDGE_SANDBOX_TABLES = [
  "judge_sandbox_sessions",
  "judge_sandbox_memory",
] as const;
const JUDGE_SANDBOX_TTL_CRONS = new Map<string, string>([
  ["judge_sandbox_sessions", "17 * * * *"],
  ["judge_sandbox_memory", "13 * * * *"],
]);
const RESOLUTION_WRITER_GRANTS = new Map<string, readonly string[]>([
  ["judge_sandbox_sessions", ["INSERT", "SELECT", "UPDATE"]],
  ["judge_sandbox_memory", ["INSERT", "SELECT"]],
  ["memory_demo_sessions", ["SELECT"]],
  ["memory_resolution_observations", ["SELECT"]],
  ["memory_resolution_proposals", ["SELECT"]],
  ["memory_resolution_decisions", ["SELECT"]],
  ["memory_resolution_consolidations", ["SELECT"]],
]);
const RESOLUTION_TRANSITION_OWNER =
  "archon_resolution_transition_owner";
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

export async function applySchema(): Promise<void> {
  assertResolutionRoutineSourceContracts();
  const sql = schemaSource;
  const pool = getPool();
  const client = await pool.connect();
  console.log(`Applying schema → ${redactUrl(process.env.DATABASE_URL!)}`);
  // Run statements individually: `SET CLUSTER SETTING` cannot execute inside the
  // implicit multi-statement transaction the driver would otherwise wrap the
  // whole script in. The splitter is quote-aware because PL/pgSQL transition
  // functions contain internal semicolons inside dollar-quoted bodies.
  const statements = splitSqlStatements(stripComments(sql));
  try {
    const identity = await client.query<{ database_name: string }>(
      "SELECT current_database() AS database_name"
    );
    const databaseName = identity.rows[0]?.database_name;
    if (!databaseName) {
      throw new Error("Could not resolve the target database name.");
    }
    // This application owns a dedicated database. Remove ambient PUBLIC
    // CONNECT/TEMPORARY privileges; runtime principals receive explicit CONNECT
    // and cannot create temporary resource-consuming objects.
    await client.query(
      `REVOKE CONNECT, TEMPORARY ON DATABASE ${quoteIdentifier(databaseName)} FROM PUBLIC`
    );
    for (const stmt of statements) {
      await client.query(stmt);
    }
    const { rows } = await client.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' ORDER BY table_name`
    );
    console.log("Tables:", rows.map((r) => r.table_name).join(", "));
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
    const companyIndex = indexByName.get(EXPECTED_VECTOR_INDEX_NAME);
    const kindIndex = indexByName.get(EXPECTED_KIND_VECTOR_INDEX_NAME);
    if (
      indexes.rowCount !== 2 ||
      !companyIndex ||
      !kindIndex ||
      !isExpectedVectorIndexDefinition(companyIndex, databaseName) ||
      !isExpectedKindVectorIndexDefinition(kindIndex, databaseName)
    ) {
      throw new Error(
        "Exact public-serving CockroachDB C-SPANN index definitions are missing."
      );
    }

    const policies = await client.query<{
      policyname: string;
      permissive: string;
      cmd: string;
      roles: string[] | string;
      qual: string | null;
    }>(
      `SELECT policyname, permissive, cmd, roles, qual
         FROM pg_catalog.pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'agent_memory'`
    );
    const policyByName = new Map(
      policies.rows.map((policy) => [policy.policyname, policy])
    );
    const permit = policyByName.get("agent_memory_public_demo_permit_v1");
    const guard = policyByName.get("agent_memory_public_demo_guard_v1");
    if (
      policyByName.size !== 3 ||
      permit?.permissive.toLowerCase() !== "permissive" ||
      guard?.permissive.toLowerCase() !== "restrictive" ||
      permit?.cmd.toLowerCase() !== "select" ||
      guard?.cmd.toLowerCase() !== "select" ||
      !isFixedPublicPolicy(permit) ||
      !isFixedPublicPolicy(guard)
    ) {
      throw new Error("Exact fail-closed public RLS policy set is missing.");
    }

    const rls = await client.query<{
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relrowsecurity, relforcerowsecurity
         FROM pg_catalog.pg_class
        WHERE oid = 'public.agent_memory'::REGCLASS`
    );
    if (
      rls.rowCount !== 1 ||
      rls.rows[0]?.relrowsecurity !== true ||
      rls.rows[0]?.relforcerowsecurity !== true
    ) {
      throw new Error("agent_memory RLS is not both enabled and forced.");
    }
    await verifyJudgeSandbox(client);
    await verifyResolutionSandbox(client, databaseName);
    await verifyPublicRecallViews(client, databaseName);
    console.log(
      "✓ exact C-SPANN views, canonical read boundary, judge sandbox, and resolution sandbox verified"
    );
  } finally {
    // The schema grants CREATE only for ownership-transfer statements. Always
    // reset any temporary role and remove CREATE even when DDL/assertions fail.
    try {
      await client.query("RESET ROLE");
      const owner = await client.query(
        `SELECT username
           FROM [SHOW USERS]
          WHERE username = ANY($1::STRING[])`,
        [[PUBLIC_RECALL_VIEW_OWNER, RESOLUTION_TRANSITION_OWNER]]
      );
      for (const row of owner.rows) {
        await client.query(
          `REVOKE CREATE ON SCHEMA public
             FROM ${quoteIdentifier(String(row.username))}`
        );
      }
    } finally {
      client.release();
      await closePool();
    }
  }
}

async function verifyJudgeSandbox(client: PoolClient): Promise<void> {
  const tables = await client.query<{ table_name: string }>(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY($1::STRING[])
      ORDER BY table_name`,
    [JUDGE_SANDBOX_TABLES]
  );
  if (
    JSON.stringify(tables.rows.map((row) => row.table_name)) !==
    JSON.stringify([...JUDGE_SANDBOX_TABLES].sort())
  ) {
    throw new Error("Exact two-table judge sandbox is missing.");
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
    [JUDGE_SANDBOX_TABLES]
  );
  if (
    rls.rows.length !== JUDGE_SANDBOX_TABLES.length ||
    rls.rows.some(
      (row) => !row.relrowsecurity || !row.relforcerowsecurity
    )
  ) {
    throw new Error("Judge sandbox RLS is not enabled and forced.");
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
    [JUDGE_SANDBOX_TABLES]
  );
  if (policies.rows.length !== JUDGE_SANDBOX_TABLES.length * 3) {
    throw new Error("Judge sandbox RLS policy count drifted.");
  }
  for (const table of JUDGE_SANDBOX_TABLES) {
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
      const using = normalizePolicyExpression(policy?.qual ?? null);
      const check = normalizePolicyExpression(policy?.with_check ?? null);
      if (
        !policy ||
        policy.permissive.toLowerCase() !== mode ||
        policy.cmd.toLowerCase() !== "all" ||
        JSON.stringify(stringArray(policy.roles).sort()) !==
          JSON.stringify(["archon_resolution_writer"]) ||
        using.includes(" or ") ||
        check.includes(" or ") ||
        !using.includes("tenant_id = 'public-demo'") ||
        !using.includes("expires_at >") ||
        !check.includes("tenant_id = 'public-demo'") ||
        !check.includes("expires_at >") ||
        (!check.includes("61") && !check.includes("01:01:00")) ||
        (table === "judge_sandbox_sessions" &&
          !check.includes("memory_count"))
      ) {
        throw new Error(`Judge sandbox RLS policy drifted on ${table}.`);
      }
    }
    if (
      tablePolicies.length !== 3 ||
      operator?.permissive.toLowerCase() !== "permissive" ||
      operator.cmd.toLowerCase() !== "all" ||
      normalizePolicyExpression(operator.qual) !== "true" ||
      normalizePolicyExpression(operator.with_check) !== "true"
    ) {
      throw new Error(`Judge sandbox operator policy drifted on ${table}.`);
    }
  }

  for (const table of JUDGE_SANDBOX_TABLES) {
    const cron = JUDGE_SANDBOX_TTL_CRONS.get(table)!;
    const created = await client.query<{ create_statement: string }>(
      `SELECT create_statement FROM [SHOW CREATE TABLE ${table}]`
    );
    const statement = created.rows[0]?.create_statement ?? "";
    if (
      created.rows.length !== 1 ||
      !/\bttl\s*=\s*'on'/iu.test(statement) ||
      !/ttl_expiration_expression\s*=\s*'expires_at'/iu.test(statement) ||
      !statement.includes(`ttl_job_cron = '${cron}'`) ||
      /\bttl_pause\s*=/iu.test(statement)
    ) {
      throw new Error(`Judge sandbox TTL contract drifted on ${table}.`);
    }
    const descriptor = await client.query<{ table_id: string }>(
      `SELECT oid::STRING AS table_id
         FROM pg_catalog.pg_class
        WHERE oid = 'public.${table}'::REGCLASS`
    );
    const tableId = descriptor.rows[0]?.table_id;
    const schedules = tableId
      ? await client.query<{
          schedule_status: string;
          recurrence: string;
          table_id: string | null;
        }>(
          `SELECT schedule_status,
                  recurrence,
                  (command::JSONB)->>'tableId' AS table_id
             FROM [SHOW SCHEDULES]
            WHERE label = $1`,
          [`row-level-ttl: ${table} [${tableId}]`]
        )
      : { rows: [] };
    if (
      !tableId ||
      schedules.rows.length !== 1 ||
      schedules.rows[0]?.schedule_status.toUpperCase() !== "ACTIVE" ||
      schedules.rows[0].recurrence !== cron ||
      schedules.rows[0].table_id !== tableId
    ) {
      throw new Error(`Judge sandbox TTL schedule drifted on ${table}.`);
    }
  }

  const vectorIndex = await client.query<{ indexdef: string }>(
    `SELECT indexdef
       FROM pg_catalog.pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'judge_sandbox_memory'
        AND indexname = 'idx_judge_sandbox_session_embedding'`
  );
  const definition = (vectorIndex.rows[0]?.indexdef ?? "")
    .toLowerCase()
    .replace(/\s+/gu, " ");
  if (
    vectorIndex.rows.length !== 1 ||
    !definition.includes("create vector index") ||
    !definition.includes("session_token_hash") ||
    !definition.includes("embed_model") ||
    !definition.includes("embedding vector_cosine_ops")
  ) {
    throw new Error("Judge sandbox session-scoped C-SPANN index drifted.");
  }
}

async function verifyResolutionSandbox(
  client: PoolClient,
  databaseName: string
): Promise<void> {
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
  const actualTables = tables.rows.map((row) => row.table_name);
  const expectedTables = [...RESOLUTION_TABLES].sort();
  if (
    actualTables.length !== expectedTables.length ||
    JSON.stringify(actualTables) !== JSON.stringify(expectedTables)
  ) {
    throw new Error("Exact five-table memory resolution sandbox is missing.");
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
    throw new Error(
      "Every memory resolution relation must enable and force RLS."
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
    throw new Error("Resolution sandbox RLS policy count drifted.");
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
    if (
      tablePolicies.length !== 3 ||
      operator?.permissive.toLowerCase() !== "permissive" ||
      operator.cmd.toLowerCase() !== "all" ||
      normalizePolicyExpression(operator.qual) !== "true" ||
      normalizePolicyExpression(operator.with_check) !== "true" ||
      !isFixedResolutionWriterPolicy(permit, "permissive") ||
      !isFixedResolutionWriterPolicy(guard, "restrictive")
    ) {
      throw new Error(`Resolution sandbox RLS policy drifted on ${table}.`);
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
    throw new Error(
      "Resolution session row-level TTL is not exactly expires_at/four-hourly."
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
    throw new Error("CockroachDB row-level TTL jobs are disabled.");
  }
  const ttlTable = await client.query<{ table_id: string }>(
    `SELECT oid::STRING AS table_id
       FROM pg_catalog.pg_class
      WHERE oid = 'public.memory_demo_sessions'::REGCLASS`
  );
  const ttlTableId = ttlTable.rows[0]?.table_id;
  if (ttlTable.rows.length !== 1 || !ttlTableId) {
    throw new Error(
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
    throw new Error(
      "Resolution session TTL schedule is not exactly one active four-hour job bound to the target table."
    );
  }

  await verifyExactRelationGrants(
    client,
    "archon_resolution_writer",
    RESOLUTION_WRITER_GRANTS
  );
  await verifyExactRelationGrants(
    client,
    RESOLUTION_TRANSITION_OWNER,
    RESOLUTION_TRANSITION_OWNER_GRANTS
  );
  const canonicalReader = await client.query<{
    table_name: string;
    privilege_type: string;
    is_grantable: boolean;
  }>(
    `SHOW GRANTS ON TABLE agent_memory
       FOR archon_public_reader`
  );
  if (
    canonicalReader.rows.length !== 1 ||
    canonicalReader.rows[0]?.table_name !== "agent_memory" ||
    canonicalReader.rows[0].privilege_type !== "SELECT" ||
    canonicalReader.rows[0].is_grantable
  ) {
    throw new Error("Canonical agent_memory reader grant is not SELECT-only.");
  }

  const users = await client.query<{
    username: string;
    options: string[] | string;
    member_of: string[] | string;
  }>("SELECT username, options, member_of FROM [SHOW USERS]");
  const writer = users.rows.find(
    (user) => user.username === "archon_resolution_writer"
  );
  const writerOptions = stringArray(writer?.options ?? null).map(
    (option) => option.toUpperCase()
  );
  if (
    !writer ||
    !writerOptions.includes("NOLOGIN") ||
    writerOptions.includes("LOGIN") ||
    writerOptions.includes("BYPASSRLS") ||
    stringArray(writer.member_of ?? null).length !== 0
  ) {
    throw new Error(
      "Resolution writer must be an isolated NOLOGIN/NOBYPASSRLS role."
    );
  }
  const systemGrants = await client.query<SystemGrant>(
    `SHOW SYSTEM GRANTS FOR archon_resolution_writer`
  );
  if (affirmativeSystemGrants(systemGrants.rows).length !== 0) {
    throw new Error(
      "Resolution writer has unexpected affirmative system privileges."
    );
  }

  const transitionOwner = users.rows.find(
    (user) => user.username === RESOLUTION_TRANSITION_OWNER
  );
  const transitionOwnerOptions = stringArray(
    transitionOwner?.options ?? null
  ).map((option) => option.toUpperCase());
  const transitionOwnerMembers = users.rows.filter((user) =>
    stringArray(user.member_of).includes(RESOLUTION_TRANSITION_OWNER)
  );
  if (
    !transitionOwner ||
    !transitionOwnerOptions.includes("NOLOGIN") ||
    transitionOwnerOptions.includes("LOGIN") ||
    transitionOwnerOptions.includes("BYPASSRLS") ||
    stringArray(transitionOwner.member_of).length !== 0 ||
    transitionOwnerMembers.length !== 0
  ) {
    throw new Error(
      "Resolution transition owner must be NOLOGIN/NOBYPASSRLS with no memberships or members."
    );
  }

  const transitionOwnerSystemGrants = await client.query<SystemGrant>(
    `SHOW SYSTEM GRANTS FOR ${RESOLUTION_TRANSITION_OWNER}`
  );
  if (
    affirmativeSystemGrants(transitionOwnerSystemGrants.rows).length !== 0
  ) {
    throw new Error(
      "Resolution transition owner has unexpected affirmative system privileges."
    );
  }

  const transitionOwnerSchemaGrants = await client.query<{
    grantee: string;
    privilege_type: string;
    is_grantable: boolean;
  }>(`SHOW GRANTS ON SCHEMA public`);
  const directOwnerSchemaGrants = transitionOwnerSchemaGrants.rows.filter(
    (grant) => grant.grantee === RESOLUTION_TRANSITION_OWNER
  );
  if (
    directOwnerSchemaGrants.length !== 1 ||
    directOwnerSchemaGrants[0]?.privilege_type !== "USAGE" ||
    directOwnerSchemaGrants[0].is_grantable
  ) {
    throw new Error(
      "Resolution transition owner must retain USAGE but no CREATE on public."
    );
  }

  const transitionOwnerDefaults = await client.query<{
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
    transitionOwnerDefaults.rows.length !== 1 ||
    transitionOwnerDefaults.rows[0]?.default_values
      .replace(/\s+/gu, "")
      .toLowerCase() !== "pg_catalog" ||
    transitionOwnerDefaults.rows[0].database !== null ||
    !transitionOwnerDefaults.rows[0].inherited_globally
  ) {
    throw new Error(
      "Resolution transition owner search_path is not pinned to pg_catalog."
    );
  }

  const ownerRoleGrants = await client.query<{
    role_name: string;
    member: string;
    is_admin: boolean;
  }>(`SHOW GRANTS ON ROLE ${RESOLUTION_TRANSITION_OWNER}`);
  if (ownerRoleGrants.rows.length !== 0) {
    throw new Error("Resolution transition owner must have no role members.");
  }

  const writerRoleGrants = await client.query<{
    role_name: string;
    member: string;
    is_admin: boolean;
  }>("SHOW GRANTS ON ROLE archon_resolution_writer");
  if (writerRoleGrants.rows.some((grant) => grant.is_admin)) {
    throw new Error(
      "Resolution writer membership must never include WITH ADMIN OPTION."
    );
  }

  // CockroachDB canonicalizes pg_catalog-qualified built-ins to unqualified
  // calls in pg_proc.prosrc. Prove the SECURITY DEFINER owner's fixed
  // pg_catalog search_path before accepting that descriptor-backed form.
  await verifyResolutionFunctions(
    client,
    databaseName,
    process.env.DATABASE_URL!
  );
}

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
    throw new Error(
      `Resolution routine source qualification contract drifted: ${JSON.stringify(
        evidence
      )}`
    );
  }
}

async function verifyExactRelationGrants(
  client: PoolClient,
  role: string,
  expected: ReadonlyMap<string, readonly string[]>
): Promise<void> {
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
        !expected.has(grant.table_name)
    )
  ) {
    throw new Error(`${role} relation privilege matrix drifted.`);
  }
}

async function verifyResolutionFunctions(
  client: PoolClient,
  databaseName: string,
  adminConnectionString: string
): Promise<void> {
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

  // CockroachDB v26.2.3's PostgreSQL-compatibility pg_proc currently exposes
  // prosecdef=false for user-defined routines regardless of their descriptor.
  // SHOW CREATE FUNCTION is generated from that descriptor and preserves the
  // actual SECURITY DEFINER mode, so it is the authoritative fail-closed check.
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
    throw new Error(
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
      throw new Error(
        `Resolution routine ${routine.name} EXECUTE grants drifted.`
      );
    }
  }

  await verifyClusterWideResolutionGrants({
    adminConnectionString,
    principal: "archon_resolution_writer",
    applicationDatabase: databaseName,
  });
}

function isFixedResolutionWriterPolicy(
  policy:
    | {
        permissive: string;
        cmd: string;
        roles: string[] | string;
        qual: string | null;
        with_check: string | null;
      }
    | undefined,
  expectedPermissive: "permissive" | "restrictive"
): boolean {
  if (
    !policy ||
    policy.permissive.toLowerCase() !== expectedPermissive ||
    policy.cmd.toLowerCase() !== "all" ||
    JSON.stringify(stringArray(policy.roles).sort()) !==
      JSON.stringify(
        [
          "archon_resolution_transition_owner",
          "archon_resolution_writer",
        ].sort()
      )
  ) {
    return false;
  }
  const using = normalizePolicyExpression(policy.qual);
  const check = normalizePolicyExpression(policy.with_check);
  return (
    !using.includes(" or ") &&
    !check.includes(" or ") &&
    using.includes("tenant_id = 'public-demo'") &&
    using.includes("company = 'helios sa'") &&
    using.includes("expires_at >") &&
    (using.includes("now") || using.includes("current_timestamp")) &&
    check.includes("tenant_id = 'public-demo'") &&
    check.includes("company = 'helios sa'") &&
    check.includes("expires_at >") &&
    (check.includes("now") || check.includes("current_timestamp")) &&
    (check.includes("61") || check.includes("01:01:00"))
  );
}

function normalizePolicyExpression(value: string | null): string {
  return (value ?? "")
    .toLowerCase()
    .replaceAll('"', "")
    .replace(/:{2,3}(?:string|text)\b/gu, "")
    .replace(/[()]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

async function verifyPublicRecallViews(
  client: PoolClient,
  databaseName: string
): Promise<void> {
  const expectedViews = [
    PUBLIC_RECALL_VIEW_NAME,
    PUBLIC_KIND_RECALL_VIEW_NAME,
  ];
  const views = await client.query<{
    table_name: string;
    view_definition: string;
  }>(
    `SELECT table_name, view_definition
       FROM information_schema.views
      WHERE table_schema = 'public'
        AND table_name = ANY($1::STRING[])`,
    [expectedViews]
  );
  const viewByName = new Map(
    views.rows.map((view) => [view.table_name, view.view_definition])
  );
  const companyView = viewByName.get(PUBLIC_RECALL_VIEW_NAME);
  const kindView = viewByName.get(PUBLIC_KIND_RECALL_VIEW_NAME);
  if (
    views.rowCount !== 2 ||
    !companyView ||
    !kindView ||
    !isExpectedPublicRecallViewDefinition(
      companyView,
      false,
      databaseName
    ) ||
    !isExpectedPublicRecallViewDefinition(kindView, true, databaseName)
  ) {
    throw new Error("Fixed-scope public recall view definitions drifted.");
  }

  const objects = await client.query<{
    table_name: string;
    type: string;
    owner: string;
    reloptions: string[] | string | null;
  }>(
    `SELECT objects.table_name, objects.type, objects.owner, classes.reloptions
       FROM [SHOW TABLES] AS objects
       JOIN pg_catalog.pg_class AS classes
         ON classes.relname = objects.table_name
       JOIN pg_catalog.pg_namespace AS namespaces
         ON namespaces.oid = classes.relnamespace
        AND namespaces.nspname = objects.schema_name
      WHERE objects.schema_name = 'public'
        AND objects.table_name = ANY($1::STRING[])`,
    [expectedViews]
  );
  if (
    objects.rowCount !== 2 ||
    objects.rows.some(
      (object) =>
        object.type.toLowerCase() !== "view" ||
        object.owner !== PUBLIC_RECALL_VIEW_OWNER ||
        stringArray(object.reloptions).length !== 1 ||
        stringArray(object.reloptions)[0]?.toLowerCase() !==
          "security_invoker=false"
    )
  ) {
    throw new Error("Public recall views do not have the isolated owner.");
  }

  const users = await client.query<{
    username: string;
    options: string[] | string;
    member_of: string[] | string;
  }>("SELECT username, options, member_of FROM [SHOW USERS]");
  const owner = users.rows.find(
    (user) => user.username === PUBLIC_RECALL_VIEW_OWNER
  );
  const ownerOptions = stringArray(owner?.options ?? null).map((option) =>
    option.toUpperCase()
  );
  const ownerMembers = users.rows.filter((user) =>
    stringArray(user.member_of).includes(PUBLIC_RECALL_VIEW_OWNER)
  );
  if (
    !owner ||
    stringArray(owner.member_of).length !== 0 ||
    ownerMembers.length !== 0 ||
    JSON.stringify([...ownerOptions].sort()) !==
      JSON.stringify(["BYPASSRLS", "NOLOGIN"])
  ) {
    throw new Error("Public recall view owner is not isolated and non-login.");
  }

  for (const viewName of expectedViews) {
    const grants = await client.query<{
      grantee: string;
      privilege_type: string;
      is_grantable: boolean;
    }>(`SHOW GRANTS ON TABLE ${viewName}`);
    const readerGrants = grants.rows.filter(
      (grant) => grant.grantee === "archon_public_reader"
    );
    if (
      readerGrants.length !== 1 ||
      readerGrants[0]?.privilege_type !== "SELECT" ||
      readerGrants[0].is_grantable ||
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
      throw new Error(`Public recall view ${viewName} grants drifted.`);
    }
  }

  const ownerTableGrants = await client.query<{
    table_name: string;
    privilege_type: string;
    is_grantable: boolean;
  }>(
    `SELECT table_name, privilege_type, is_grantable
       FROM [SHOW GRANTS ON TABLE agent_memory
             FOR archon_public_memory_view_owner]`
  );
  if (
    ownerTableGrants.rows.length !== 1 ||
    ownerTableGrants.rows[0]?.table_name !== "agent_memory" ||
    ownerTableGrants.rows[0].privilege_type !== "SELECT" ||
    ownerTableGrants.rows[0].is_grantable
  ) {
    throw new Error("Public recall view owner base-table grants drifted.");
  }

  const ownerSchemaGrants = await client.query<{
    privilege_type: string;
    is_grantable: boolean;
  }>(
    `SELECT privilege_type, is_grantable
       FROM [SHOW GRANTS ON SCHEMA public
             FOR archon_public_memory_view_owner]`
  );
  if (
    ownerSchemaGrants.rows.length < 1 ||
    ownerSchemaGrants.rows.some(
      (grant) =>
        grant.privilege_type !== "USAGE" || grant.is_grantable
    )
  ) {
    throw new Error("Public recall view owner schema grants drifted.");
  }

  const ownerSystemGrants = await client.query<SystemGrant>(
    `SHOW SYSTEM GRANTS FOR archon_public_memory_view_owner`
  );
  const ownerAffirmative = affirmativeSystemGrants(
    ownerSystemGrants.rows
  );
  if (ownerAffirmative.length !== 0) {
    throw new Error(
      "Public recall view owner has unexpected system privileges."
    );
  }

  const clusterSettings = await client.query<{
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
    clusterSettings.rows.map((setting) => [
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
    throw new Error(
      "CockroachDB v26.2 view-owner privilege behavior is not active."
    );
  }
}

function isFixedPublicPolicy(
  policy:
    | {
        roles: string[] | string;
        qual: string | null;
      }
    | undefined
): boolean {
  if (!policy?.qual) return false;
  const roles = Array.isArray(policy.roles)
    ? policy.roles
    : policy.roles.replace(/[{}"]/gu, "").split(",");
  const normalized = policy.qual
    .toLowerCase()
    .replaceAll('"', "")
    .replace(/:{2,3}(?:string|text)\b/gu, "")
    .replace(/[()]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return (
    roles.length === 1 &&
    roles[0]?.trim() === "archon_public_reader" &&
    normalized ===
      "tenant_id = 'public-demo' and company = 'helios sa' and status = 'active'"
  );
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

function quoteIdentifier(value: string): string {
  if (!value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("Database identifier contains invalid characters.");
  }
  return `"${value.replaceAll('"', '""')}"`;
}

function redactUrl(url: string): string {
  return url.replace(/\/\/([^:]+):[^@]+@/, "//$1:***@");
}

// Drop full-line SQL comments so a comment-only fragment before a `;` doesn't
// become an empty (or comment-only) statement.
function stripComments(fragment: string): string {
  return fragment
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

export function splitSqlStatements(fragment: string): string[] {
  const statements: string[] = [];
  let statement = "";
  let singleQuoted = false;
  let doubleQuoted = false;
  let dollarTag: string | null = null;

  for (let index = 0; index < fragment.length; index += 1) {
    const character = fragment[index]!;
    const next = fragment[index + 1];

    if (dollarTag) {
      if (fragment.startsWith(dollarTag, index)) {
        statement += dollarTag;
        index += dollarTag.length - 1;
        dollarTag = null;
      } else {
        statement += character;
      }
      continue;
    }

    if (singleQuoted) {
      statement += character;
      if (character === "'" && next === "'") {
        statement += next;
        index += 1;
      } else if (character === "'") {
        singleQuoted = false;
      }
      continue;
    }

    if (doubleQuoted) {
      statement += character;
      if (character === '"' && next === '"') {
        statement += next;
        index += 1;
      } else if (character === '"') {
        doubleQuoted = false;
      }
      continue;
    }

    if (character === "'") {
      singleQuoted = true;
      statement += character;
      continue;
    }
    if (character === '"') {
      doubleQuoted = true;
      statement += character;
      continue;
    }
    if (character === "$") {
      const tag = fragment.slice(index).match(/^\$[A-Za-z_0-9]*\$/u)?.[0];
      if (tag) {
        dollarTag = tag;
        statement += tag;
        index += tag.length - 1;
        continue;
      }
    }
    if (character === ";") {
      const trimmed = statement.trim();
      if (trimmed) statements.push(trimmed);
      statement = "";
      continue;
    }
    statement += character;
  }

  if (singleQuoted || doubleQuoted || dollarTag) {
    throw new Error("Schema contains an unterminated quoted SQL fragment.");
  }
  const trailing = statement.trim();
  if (trailing) statements.push(trailing);
  return statements;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  applySchema().catch((err) => {
    console.error("Schema apply failed:", err);
    process.exit(1);
  });
}
