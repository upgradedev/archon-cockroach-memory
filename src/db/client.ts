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

import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { DATABASE_APPLICATION_NAME } from "../config/scope.js";
import { parseDatabaseSecret } from "./secret.js";

let pool: Pool | null = null;
let poolPromise: Promise<Pool> | null = null;
let databaseUrlPromise: Promise<string> | null = null;

function createPool(connectionString: string): Pool {
  return new Pool({
    connectionString,
    // CockroachDB Cloud requires TLS; the driver honors sslmode in the URL.
    // Lambda execution environments reuse this single, deliberately tiny pool.
    max: Math.max(1, Number(process.env.PGPOOL_MAX ?? 1)),
    idleTimeoutMillis: Math.max(
      1_000,
      Number(process.env.PGPOOL_IDLE_TIMEOUT_MS ?? 30_000)
    ),
    connectionTimeoutMillis: Math.max(
      1_000,
      Number(process.env.PGPOOL_CONNECT_TIMEOUT_MS ?? 10_000)
    ),
    maxLifetimeSeconds: Math.max(
      30,
      Number(process.env.PGPOOL_MAX_LIFETIME_SECONDS ?? 300)
    ),
    keepAlive: true,
    // Stable telemetry only. Authorization is role-bound in CockroachDB RLS;
    // application_name is intentionally not a security identity.
    application_name: DATABASE_APPLICATION_NAME,
  });
}

async function resolveDatabaseUrl(): Promise<string> {
  const direct = process.env.DATABASE_URL?.trim();
  if (direct) return direct;

  const secretId = process.env.DATABASE_SECRET_ID?.trim();
  if (!secretId) {
    throw new Error(
      "DATABASE_URL or DATABASE_SECRET_ID is required to connect to CockroachDB."
    );
  }

  const client = new SecretsManagerClient({
    region: process.env.AWS_REGION || process.env.BEDROCK_REGION,
  });
  const secret = await client.send(
    new GetSecretValueCommand({ SecretId: secretId })
  );
  const value =
    secret.SecretString ??
    (secret.SecretBinary
      ? new TextDecoder().decode(secret.SecretBinary)
      : undefined);
  if (!value) {
    throw new Error("CockroachDB secret has no SecretString or SecretBinary value.");
  }

  try {
    return parseDatabaseSecret(value, { requireTls: true });
  } catch {
    throw new Error(
      "CockroachDB secret must be a TLS-verified PostgreSQL URI or canonical JSON with DATABASE_URL."
    );
  }
}

// Async pool access is the production path: it can resolve a Secrets Manager
// ARN once per warm runtime and caches both the in-flight promise and the pool.
export async function getPoolAsync(): Promise<Pool> {
  if (pool) return pool;
  if (!poolPromise) {
    databaseUrlPromise ??= resolveDatabaseUrl();
    poolPromise = databaseUrlPromise
      .then((connectionString) => {
        pool = createPool(connectionString);
        return pool;
      })
      .catch((error: unknown) => {
        poolPromise = null;
        databaseUrlPromise = null;
        throw error;
      });
  }
  return poolPromise;
}

export function getPool(): Pool {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "Synchronous getPool() requires DATABASE_URL; use query()/getPoolAsync() when DATABASE_SECRET_ID is configured."
    );
  }
  pool = createPool(connectionString);
  poolPromise = Promise.resolve(pool);
  return pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  const res = await (await getPoolAsync()).query<T>(text, params);
  return res.rows;
}

export async function withClient<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await (await getPoolAsync()).connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  const current = pool;
  pool = null;
  poolPromise = null;
  databaseUrlPromise = null;
  if (current) await current.end();
}

export interface SerializableRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
}

// CockroachDB reports a retryable serialization conflict as SQLSTATE 40001.
// Re-run the entire transaction on a fresh attempt; never retry arbitrary
// transport/authorization failures that may need operator attention.
export async function withSerializableRetry<T>(
  fn: (client: PoolClient, attempt: number) => Promise<T>,
  options: SerializableRetryOptions = {}
): Promise<T> {
  const maxAttempts = Math.max(
    1,
    Math.min(options.maxAttempts ?? 4, 10)
  );
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? 20);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const client = await (await getPoolAsync()).connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client, attempt);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original error; a failed rollback is not actionable here.
      }
      if (!isRetryableSerializationError(error) || attempt === maxAttempts) {
        throw error;
      }
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), 500);
      if (delay > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }
    } finally {
      client.release();
    }
  }
  throw new Error("Serializable transaction retry loop exhausted.");
}

export function isRetryableSerializationError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "40001"
  );
}

// CockroachDB's VECTOR type is sent/received as the pgvector text form:
//   [0.1,0.2,0.3]
// The `pg` driver has no VECTOR type parser, so we bind the literal as text and
// let the column type coerce it. This helper renders a JS number[] to that form.
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}
