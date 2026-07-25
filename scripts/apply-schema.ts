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

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(here, "..", "src", "db", "schema.sql");

export async function applySchema(): Promise<void> {
  const sql = readFileSync(schemaPath, "utf8");
  const pool = getPool();
  const client = await pool.connect();
  console.log(`Applying schema → ${redactUrl(process.env.DATABASE_URL!)}`);
  // Run statements individually: `SET CLUSTER SETTING` cannot execute inside the
  // implicit multi-statement transaction the driver would otherwise wrap the
  // whole script in. Strip `--` comment lines FIRST (a comment may contain a
  // semicolon), then split; this schema has no semicolons inside literals.
  const statements = stripComments(sql)
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
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
    await verifyPublicRecallViews(client, databaseName);
    console.log(
      "✓ exact C-SPANN serving views, owner role, and fail-closed RLS verified"
    );
  } finally {
    // The schema grants CREATE only for the two ownership-transfer statements.
    // Always remove it even when either statement or a later assertion fails.
    try {
      const owner = await client.query(
        "SELECT username FROM [SHOW USERS] WHERE username = $1",
        [PUBLIC_RECALL_VIEW_OWNER]
      );
      if (owner.rowCount === 1) {
        await client.query(
          `REVOKE CREATE ON SCHEMA public
             FROM ${PUBLIC_RECALL_VIEW_OWNER}`
        );
      }
    } finally {
      client.release();
      await closePool();
    }
  }
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

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  applySchema().catch((err) => {
    console.error("Schema apply failed:", err);
    process.exit(1);
  });
}
