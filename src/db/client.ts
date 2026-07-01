// CockroachDB connection — the agent memory store.
//
// CockroachDB speaks the PostgreSQL wire protocol, so the standard `pg` driver
// connects unchanged. That is the whole portability thesis of this entry: the
// Archon Postgres schema and every query below run against CockroachDB as-is,
// and gain distributed scale + the native VECTOR index for free.
//
// One pool per process, lazily created. `DATABASE_URL` selects the target:
//   local  : postgresql://root@localhost:26257/archon_memory?sslmode=disable
//   ccloud : postgresql://<user>:<pass>@<host>:26257/archon_memory?sslmode=verify-full

import { Pool, type PoolClient, type QueryResultRow } from "pg";

let pool: Pool | null = null;

export function getPool(): Pool {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set (point it at your CockroachDB cluster).");
  }
  pool = new Pool({
    connectionString,
    // CockroachDB Cloud requires TLS; the driver honors sslmode in the URL.
    // Keep a small pool — serverless/edge callers should not hoard connections.
    max: Number(process.env.PGPOOL_MAX ?? 5),
    application_name: "archon-memory",
  });
  return pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  const res = await getPool().query<T>(text, params);
  return res.rows;
}

export async function withClient<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// CockroachDB's VECTOR type is sent/received as the pgvector text form:
//   [0.1,0.2,0.3]
// The `pg` driver has no VECTOR type parser, so we bind the literal as text and
// let the column type coerce it. This helper renders a JS number[] to that form.
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}
