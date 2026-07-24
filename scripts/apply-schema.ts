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
import { getPool, closePool } from "../src/db/client.js";
import {
  EXPECTED_VECTOR_INDEX_NAME,
  isExpectedVectorIndexDefinition,
} from "../src/db/proof.js";

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
    const idx = await client.query<{
      indexname: string;
      indexdef: string;
    }>(
      `SELECT indexname, indexdef
         FROM pg_catalog.pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'agent_memory'
          AND indexname = $1
        LIMIT 1`,
      [EXPECTED_VECTOR_INDEX_NAME]
    );
    if (
      idx.rowCount !== 1 ||
      !idx.rows[0] ||
      !isExpectedVectorIndexDefinition(idx.rows[0].indexdef)
    ) {
      throw new Error(
        "Exact company-scoped CockroachDB C-SPANN index definition is missing."
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
    console.log("✓ exact C-SPANN index and fail-closed RLS policy set verified");
  } finally {
    client.release();
    await closePool();
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
