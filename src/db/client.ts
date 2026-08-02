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
import {
  assertCockroachEndpointBinding,
  parseDatabaseSecret,
} from "./secret.js";

let secretsClient: SecretsManagerClient | null = null;

export interface DatabaseCredential {
  connectionString: string;
  expectedPrincipal?: string;
  version: string;
  source: "direct" | "secrets-manager";
}

export interface RotatablePool {
  end(): Promise<void>;
}

export interface CredentialPoolControllerDependencies<P extends RotatablePool> {
  createPool(connectionString: string): P;
  now(): number;
  proveCandidate(pool: P, credential: DatabaseCredential): Promise<void>;
  refreshMs(): number;
  resolveCredential(): Promise<DatabaseCredential>;
}

export interface CredentialPoolController<P extends RotatablePool> {
  close(): Promise<void>;
  current(): P | null;
  get(): Promise<P>;
  installDirect(value: P): P;
}

// The controller is deliberately dependency-injected. Production supplies the
// AWS Secrets Manager reader and pg Pool below; CI supplies deterministic fake
// readers and pools to exercise concurrent refresh, failed probes, and atomic
// swaps without any live cloud or database mutation.
export function createCredentialPoolController<P extends RotatablePool>(
  dependencies: CredentialPoolControllerDependencies<P>
): CredentialPoolController<P> {
  let currentPool: P | null = null;
  let credentialVersion: string | null = null;
  let nextCredentialCheckAt = 0;
  let refreshPromise: Promise<P> | null = null;

  const refresh = async (): Promise<P> => {
    const credential = await dependencies.resolveCredential();
    if (
      currentPool &&
      credential.source === "secrets-manager" &&
      credential.version === credentialVersion
    ) {
      nextCredentialCheckAt = dependencies.now() + dependencies.refreshMs();
      return currentPool;
    }

    const candidate = dependencies.createPool(credential.connectionString);
    try {
      await dependencies.proveCandidate(candidate, credential);
    } catch {
      await candidate.end().catch(() => undefined);
      throw new Error("CockroachDB runtime credential probe failed.");
    }

    const previous = currentPool;
    currentPool = candidate;
    credentialVersion = credential.version;
    nextCredentialCheckAt =
      credential.source === "secrets-manager"
        ? dependencies.now() + dependencies.refreshMs()
        : Number.POSITIVE_INFINITY;

    if (previous && previous !== candidate) {
      // The pointer is already swapped, so no new acquisition can use the
      // retiring pool. Pool.end() waits for checked-out clients asynchronously.
      void previous.end().catch(() => undefined);
    }
    return candidate;
  };

  return {
    async get(): Promise<P> {
      if (
        currentPool &&
        dependencies.now() < nextCredentialCheckAt
      ) {
        return currentPool;
      }
      if (!refreshPromise) {
        const provenFallback = currentPool;
        refreshPromise = refresh()
          .catch((error: unknown) => {
            if (provenFallback && currentPool === provenFallback) {
              // Keep the last authenticated pool on a transient provider or
              // candidate failure, then retry on the shortest allowed cadence.
              nextCredentialCheckAt = dependencies.now() + 15_000;
              return provenFallback;
            }
            throw error;
          })
          .finally(() => {
            refreshPromise = null;
          });
      }
      return refreshPromise;
    },

    current(): P | null {
      return currentPool;
    },

    installDirect(value: P): P {
      if (currentPool) return currentPool;
      currentPool = value;
      credentialVersion = "direct-environment";
      nextCredentialCheckAt = Number.POSITIVE_INFINITY;
      return value;
    },

    async close(): Promise<void> {
      if (refreshPromise) {
        await refreshPromise.catch(() => undefined);
      }
      const closing = currentPool;
      currentPool = null;
      credentialVersion = null;
      nextCredentialCheckAt = 0;
      refreshPromise = null;
      if (closing) await closing.end();
    },
  };
}

export function databaseSecretRefreshMs(
  value = process.env.DATABASE_SECRET_REFRESH_SECONDS
): number {
  const normalized = value?.trim();
  if (normalized && !/^(?:0|[1-9][0-9]*)$/u.test(normalized)) {
    throw new Error(
      "DATABASE_SECRET_REFRESH_SECONDS must be an integer from 15 through 300."
    );
  }
  const parsed = normalized ? Number(normalized) : 30;
  if (!Number.isInteger(parsed) || parsed < 15 || parsed > 300) {
    throw new Error(
      "DATABASE_SECRET_REFRESH_SECONDS must be an integer from 15 through 300."
    );
  }
  return parsed * 1_000;
}

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

export interface DatabaseSecretValue {
  SecretBinary?: Uint8Array;
  SecretString?: string;
  VersionId?: string;
  VersionStages?: string[];
}

export interface DatabaseCredentialResolutionOptions {
  environment?: NodeJS.ProcessEnv;
  readSecret?: (
    secretId: string,
    region: string | undefined
  ) => Promise<DatabaseSecretValue>;
}

export async function resolveDatabaseCredential(
  options: DatabaseCredentialResolutionOptions = {}
): Promise<DatabaseCredential> {
  const environmentVariables = options.environment ?? process.env;
  const direct = environmentVariables.DATABASE_URL?.trim();
  if (direct) {
    return {
      connectionString: direct,
      version: "direct-environment",
      source: "direct",
    };
  }

  const secretId = environmentVariables.DATABASE_SECRET_ID?.trim();
  if (!secretId) {
    throw new Error(
      "DATABASE_URL or DATABASE_SECRET_ID is required to connect to CockroachDB."
    );
  }

  const region =
    environmentVariables.AWS_REGION || environmentVariables.BEDROCK_REGION;
  const secret = options.readSecret
    ? await options.readSecret(secretId, region)
    : await (async (): Promise<DatabaseSecretValue> => {
        secretsClient ??= new SecretsManagerClient({ region });
        return secretsClient.send(
          new GetSecretValueCommand({
            SecretId: secretId,
            VersionStage: "AWSCURRENT",
          })
        );
      })();
  if (
    typeof secret.VersionId !== "string" ||
    !/^[A-Za-z0-9_-]{32,64}$/u.test(secret.VersionId) ||
    !secret.VersionStages?.includes("AWSCURRENT")
  ) {
    throw new Error(
      "CockroachDB secret did not return one canonical AWSCURRENT version."
    );
  }
  const value =
    secret.SecretString ??
    (secret.SecretBinary
      ? new TextDecoder().decode(secret.SecretBinary)
      : undefined);
  if (!value) {
    throw new Error("CockroachDB secret has no SecretString or SecretBinary value.");
  }

  try {
    const connectionString = parseDatabaseSecret(value, { requireTls: true });
    const expectedSqlDns = environmentVariables.COCKROACH_SQL_DNS?.trim();
    const environment = environmentVariables.APP_ENV?.trim();
    if (!expectedSqlDns || (environment !== "staging" && environment !== "production")) {
      throw new Error("Secret-backed runtime endpoint identity is not configured.");
    }
    assertCockroachEndpointBinding(connectionString, expectedSqlDns);
    const expectedPrincipal = decodeURIComponent(
      new URL(connectionString).username
    );
    if (
      !new RegExp(`^archon_${environment}_[a-z0-9]{6,40}$`, "u").test(
        expectedPrincipal
      )
    ) {
      throw new Error("Runtime secret principal is outside the environment boundary.");
    }
    return {
      connectionString,
      expectedPrincipal,
      version: secret.VersionId,
      source: "secrets-manager",
    };
  } catch {
    throw new Error(
      "CockroachDB secret must be a TLS-verified PostgreSQL URI or canonical JSON with DATABASE_URL."
    );
  }
}

async function proveCandidatePool(
  candidate: Pool,
  credential: DatabaseCredential
): Promise<void> {
  // A staged credential is never made active in this process merely because
  // Secrets Manager returned it. Prove authentication, exact identity,
  // database, and the RLS-filtered canonical view before the atomic swap.
  if (credential.source === "secrets-manager") {
    const probe = await candidate.query<{
      current_database: string;
      current_user: string;
      visible_memories: string;
    }>(
      `SELECT current_user,
              current_database(),
              (SELECT count(*)::STRING
                 FROM archon_public_memory_recall) AS visible_memories`
    );
    if (
      probe.rows.length !== 1 ||
      probe.rows[0]?.current_user !== credential.expectedPrincipal ||
      probe.rows[0]?.current_database !== "archon" ||
      Number(probe.rows[0]?.visible_memories ?? -1) !== 9
    ) {
      throw new Error("CockroachDB runtime credential identity probe failed.");
    }
    return;
  }
  await candidate.query("SELECT 1 AS credential_probe");
}

const poolController = createCredentialPoolController<Pool>({
  createPool,
  now: Date.now,
  proveCandidate: proveCandidatePool,
  refreshMs: databaseSecretRefreshMs,
  resolveCredential: () => resolveDatabaseCredential(),
});

// Async pool access is the production path. Secret-backed runtimes re-read the
// AWSCURRENT version on a short bounded cadence. A changed version is connected
// and probed before an atomic pool swap, allowing a blue/green credential
// rotation without printing material or waiting for a Lambda redeployment.
export async function getPoolAsync(): Promise<Pool> {
  return poolController.get();
}

export function getPool(): Pool {
  const existing = poolController.current();
  if (existing) return existing;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "Synchronous getPool() requires DATABASE_URL; use query()/getPoolAsync() when DATABASE_SECRET_ID is configured."
    );
  }
  return poolController.installDirect(createPool(connectionString));
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
  await poolController.close();
  secretsClient?.destroy();
  secretsClient = null;
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
