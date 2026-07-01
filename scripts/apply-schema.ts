// Apply src/db/schema.sql to the CockroachDB pointed at by DATABASE_URL.
//
//   npm run db:schema
//
// Idempotent: every statement is IF NOT EXISTS / CREATE OR REPLACE-safe, so it
// is safe to re-run against an existing cluster (local or CockroachDB Cloud).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getPool, closePool } from "../src/db/client.js";

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(here, "..", "src", "db", "schema.sql");

async function main() {
  const sql = readFileSync(schemaPath, "utf8");
  const pool = getPool();
  console.log(`Applying schema → ${redactUrl(process.env.DATABASE_URL!)}`);
  // Run statements individually: `SET CLUSTER SETTING` cannot execute inside the
  // implicit multi-statement transaction the driver would otherwise wrap the
  // whole script in. Strip `--` comment lines FIRST (a comment may contain a
  // semicolon), then split; this schema has no semicolons inside literals.
  const statements = stripComments(sql)
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    await pool.query(stmt);
  }
  const { rows } = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name`
  );
  console.log("Tables:", rows.map((r) => r.table_name).join(", "));
  const idx = await pool.query(
    `SELECT index_name FROM information_schema.statistics
      WHERE table_name = 'agent_memory' AND index_name = 'idx_agent_memory_embedding' LIMIT 1`
  );
  console.log(
    idx.rowCount ? "✓ vector index idx_agent_memory_embedding present" : "⚠ vector index missing"
  );
  await closePool();
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

main().catch((err) => {
  console.error("Schema apply failed:", err);
  process.exit(1);
});
