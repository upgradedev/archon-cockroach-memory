// Multi-range ANN fan-out demonstration.
//
//   npm run db:schema     # once, to create the VECTOR(1024) table + vector index
//   npm run fanout:demo   # split the memory across ranges, prove the ANN recall fans out
//
// WHY THIS EXISTS
//   docs/BENCHMARK.md claims one ANN recall query fans out across multiple KV ranges of the
//   memory and still returns the correct top-k. That was previously ASSERTED (at demo scale
//   the data sits in one range), never demonstrated. This makes it EVIDENCE, deterministically
//   and with a tiny dataset (no need to load tens of GB to hit a natural split):
//
//     1. Force the `agent_memory` table into several KV ranges with enforced primary-key
//        splits — `ALTER TABLE agent_memory SPLIT AT VALUES (…)`. CockroachDB splits a table
//        into N ranges regardless of size; the split is ENFORCED (won't merge back). The rows
//        (random UUID PKs) scatter across the ranges. `SHOW RANGES FROM TABLE` proves >=2.
//     2. Run ONE benchmark-only unscoped ANN recall (`ORDER BY embedding <=> q LIMIT k`). It is
//        served by the GLOBAL vector index (the production fixed-scope query uses the dedicated
//        company-prefix C-SPANN index), and its plan is `vector search → lookup join`: the lookup FANS OUT across
//        the primary ranges to fetch the semantic top-k, whose PKs are spread over the ranges.
//        We prove the fan-out concretely: the returned neighbours come from >=2 distinct ranges.
//     3. It stays CORRECT under that distributed execution: recall@k vs brute-force ground
//        truth clears the floor, and EXPLAIN confirms a `vector search` node (ANN, not a scan).
//
//   This is stronger evidence of the *existing* distinguishing feature (CockroachDB's native
//   distributed vector index), not a new feature — the feature count stays "2 of 4". At
//   production scale the vector index ITSELF auto-splits into ranges too (documented in
//   docs/BENCHMARK.md Result 3, reproducible on the multi-node cluster); we report that
//   range count transparently here but do not gate CI on loading enough data to force it.
//
//   The core is exported as `runFanoutDemo()` so tests/fanout.test.ts asserts on exactly what
//   this script prints — one source of truth.
//
// Runs fully OFFLINE for embeddings (seeded unit vectors, no AWS) but REQUIRES a real
// CockroachDB (SPLIT AT / SHOW RANGES / EXPLAIN are not meaningful against the offline mock).
// CI stands one up; locally point DATABASE_URL at `docker compose up` + `npm run db:schema`.
//
// DESTRUCTIVE: the unscoped recall is scored against this corpus, so the table must hold only
// it. The demo uses bounded primary-key cleanup transactions before/after and releases only
// its three exact split points. Cleanup errors fail closed. Like the benchmark, it refuses a
// DB whose name does not look ephemeral (or ALLOW_DESTRUCTIVE_FANOUT=1).

import { pathToFileURL } from "node:url";
import type { PoolClient } from "pg";
import { unitGaussianVector, normalize, EMBED_DIM } from "../src/memory/embeddings.js";
import {
  query,
  closePool,
  withClient,
  toVectorLiteral,
  isRetryableSerializationError,
} from "../src/db/client.js";

const DIM = EMBED_DIM;
const IDX = "agent_memory@idx_agent_memory_embedding";

// Three enforced split points at the quarter boundaries of the UUID space → 4 primary ranges.
// A returned row's range is identified by the first hex nibble of its UUID (0–3 / 4–7 / 8–b / c–f).
export const FANOUT_SPLIT_POINTS = [
  "40000000-0000-0000-0000-000000000000",
  "80000000-0000-0000-0000-000000000000",
  "c0000000-0000-0000-0000-000000000000",
] as const;
export const FANOUT_CLEANUP_BATCH_SIZE = 100;
export const FANOUT_CLEANUP_STATEMENT_TIMEOUT_MS = 30_000;
export const FANOUT_CLEANUP_DEADLINE_MS = 240_000;
export const FANOUT_CLEANUP_MAX_SERIALIZATION_ATTEMPTS = 8;

function uuidBucket(uuid: string): number {
  const v = parseInt(uuid[0]!, 16);
  return v < 4 ? 0 : v < 8 ? 1 : v < 12 ? 2 : 3;
}

export interface FanoutOptions {
  n?: number; // corpus size — small is fine; the split is deterministic, not size-driven
  queries?: number;
  k?: number;
  log?: (line: string) => void;
}

export interface FanoutResult {
  corpus: number;
  tableRanges: number; // KV ranges the memory table spans (forced via SPLIT AT)
  indexRanges: number; // KV ranges the vector index spans (1 at demo scale; auto-splits at scale)
  rangesTouchedByRecall: number; // distinct primary ranges the returned top-k neighbours came from
  recallAtKMean: number;
  recallAtKMin: number;
  usesVectorSearch: boolean;
  k: number;
  preCleanup: FanoutCleanupStats;
  postCleanup: FanoutCleanupStats;
  unsplitPoints: number;
}

export interface FanoutCleanupOptions {
  phase?: string;
  statementTimeoutMs?: number;
  deadlineMs?: number;
  log?: (line: string) => void;
}

export interface FanoutCleanupStats {
  deletedRows: number;
  batches: number;
  maxBatchRows: number;
  remainingRows: number;
  elapsedMs: number;
}

export class FanoutCleanupDeadlineError extends Error {
  override name = "FanoutCleanupDeadlineError";
}

// A seeded clustered corpus (centroid + noise) — mirrors the manifold structure of real
// sentence embeddings, and lets us recompute exact ground-truth neighbours in JS. PRECOMPUTED
// once (the noise draw is O(dim); drawing it per dimension/query would be O(dim²)·O(n)).
function makeCorpus(n: number, queriesN: number) {
  const clusters = Math.max(8, Math.round(n / 200));
  const centroids = Array.from({ length: clusters }, (_, c) => unitGaussianVector(7_000 + c, DIM));
  const build = (count: number, seedBase: number) =>
    Array.from({ length: count }, (_, i) => {
      const noise = unitGaussianVector(seedBase + i, DIM);
      return normalize(centroids[i % clusters].map((x, d) => x + 0.35 * noise[d]));
    });
  return { clusters, corpus: build(n, 3_000_000), queries: build(queriesN, 5_000_000) };
}

function exactTopK(corpus: number[][], q: number[], k: number): Set<number> {
  const scored: { i: number; dist: number }[] = [];
  for (let i = 0; i < corpus.length; i++) {
    const v = corpus[i];
    let dot = 0;
    for (let d = 0; d < DIM; d++) dot += v[d] * q[d];
    scored.push({ i, dist: 1 - dot });
  }
  scored.sort((a, b) => a.dist - b.dist);
  return new Set(scored.slice(0, k).map((s) => s.i));
}

async function rangeCount(target: string): Promise<number> {
  const rows = await query<{ n: string }>(`SELECT count(*) AS n FROM [SHOW RANGES FROM ${target}]`);
  return Number(rows[0].n);
}

// Refuse to wipe a DB that does not look ephemeral (mirrors scripts/benchmark.ts).
function guardDestructive() {
  const url = process.env.DATABASE_URL ?? "";
  const dbName = decodeURIComponent(url.split("/").pop()?.split("?")[0] ?? "");
  const looksEphemeral =
    dbName === "archon_memory" ||
    /(?:^|[_-])(?:bench|test|ci)(?:$|[_-])/iu.test(dbName);
  if (!looksEphemeral && process.env.ALLOW_DESTRUCTIVE_FANOUT !== "1") {
    throw new Error(
      `Refusing to run the destructive fan-out demo against database "${dbName}". ` +
        `Point DATABASE_URL at an ephemeral benchmark DB, or set ALLOW_DESTRUCTIVE_FANOUT=1.`
    );
  }
}

function cleanupLimit(value: number | undefined, maximum: number): number {
  return Math.max(
    1,
    Math.min(
      Number.isFinite(value) ? Math.floor(value!) : maximum,
      maximum
    )
  );
}

// CockroachDB may surface a SERIALIZABLE restart at COMMIT even for this
// primary-key-bounded DELETE. Replaying the whole batch is safe because the
// cursor advances only after a successful COMMIT. Retry only SQLSTATE 40001;
// every other statement/transport/rollback failure remains fail-closed.
async function cleanupTransaction<T>(
  deadlineAt: number,
  statementTimeoutMs: number,
  work: (client: PoolClient) => Promise<T>
): Promise<T> {
  let serializationError: unknown;
  for (
    let attempt = 1;
    attempt <= FANOUT_CLEANUP_MAX_SERIALIZATION_ATTEMPTS;
    attempt++
  ) {
    try {
      return await withClient(async (client) => {
        const remainingMs = Math.floor(deadlineAt - performance.now());
        if (remainingMs <= 0) {
          throw new FanoutCleanupDeadlineError(
            "Fan-out cleanup deadline exceeded."
          );
        }
        const timeoutMs = Math.max(
          1,
          Math.min(statementTimeoutMs, remainingMs)
        );
        let transactionStarted = false;
        try {
          await client.query("BEGIN");
          transactionStarted = true;
          await client.query(
            `SET LOCAL statement_timeout = '${timeoutMs}ms'`
          );
          const result = await work(client);
          await client.query("COMMIT");
          transactionStarted = false;
          return result;
        } catch (error) {
          if (!transactionStarted) throw error;
          try {
            await client.query("ROLLBACK");
          } catch (rollbackError) {
            throw new AggregateError(
              [error, rollbackError],
              "Fan-out cleanup statement and rollback both failed."
            );
          }
          throw error;
        }
      });
    } catch (error) {
      if (
        !isRetryableSerializationError(error) ||
        attempt === FANOUT_CLEANUP_MAX_SERIALIZATION_ATTEMPTS
      ) {
        throw error;
      }
      serializationError = error;
      const remainingMs = Math.floor(deadlineAt - performance.now());
      if (remainingMs <= 0) {
        throw new FanoutCleanupDeadlineError(
          "Fan-out cleanup deadline exceeded while retrying a serialization conflict.",
          { cause: serializationError }
        );
      }
      const backoffMs = Math.min(
        25 * 2 ** (attempt - 1),
        500
      );
      if (remainingMs <= backoffMs) {
        throw new FanoutCleanupDeadlineError(
          "Fan-out cleanup deadline cannot accommodate the next serialization retry.",
          { cause: serializationError }
        );
      }
      await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));
    }
  }
  throw serializationError;
}

export async function deleteFanoutRowsInBatches(
  options: FanoutCleanupOptions = {}
): Promise<FanoutCleanupStats> {
  guardDestructive();
  const phase = options.phase?.trim() || "cleanup";
  const log = options.log ?? (() => {});
  const statementTimeoutMs = cleanupLimit(
    options.statementTimeoutMs,
    FANOUT_CLEANUP_STATEMENT_TIMEOUT_MS
  );
  const deadlineMs = cleanupLimit(
    options.deadlineMs,
    FANOUT_CLEANUP_DEADLINE_MS
  );
  const startedAt = performance.now();
  const deadlineAt = startedAt + deadlineMs;
  let cursor: string | undefined;
  let deletedRows = 0;
  let batches = 0;
  let maxBatchRows = 0;

  while (true) {
    const rows = await cleanupTransaction(
      deadlineAt,
      statementTimeoutMs,
      async (client) => {
        const predicate = cursor ? "WHERE id > $1::UUID" : "";
        const params = cursor ? [cursor] : [];
        const result = await client.query<{ id: string }>(
          `WITH deleted AS (
             DELETE FROM agent_memory@primary
             ${predicate}
             ORDER BY id
             LIMIT ${FANOUT_CLEANUP_BATCH_SIZE}
             RETURNING id
           )
           SELECT id FROM deleted ORDER BY id`,
          params
        );
        return result.rows;
      }
    );
    if (rows.length === 0) break;
    if (rows.length > FANOUT_CLEANUP_BATCH_SIZE) {
      throw new Error("Fan-out cleanup exceeded its fixed batch bound.");
    }
    cursor = rows.at(-1)?.id;
    if (!cursor) {
      throw new Error("Fan-out cleanup returned a row without a UUID.");
    }
    batches += 1;
    deletedRows += rows.length;
    maxBatchRows = Math.max(maxBatchRows, rows.length);
    log(
      `cleanup[${phase}] batch=${batches} deleted=${rows.length} ` +
        `total=${deletedRows} elapsedMs=${Math.round(
          performance.now() - startedAt
        )}`
    );
  }

  const remainingRows = await cleanupTransaction(
    deadlineAt,
    statementTimeoutMs,
    async (client) => {
      const result = await client.query<{ n: string }>(
        "SELECT count(*) AS n FROM agent_memory"
      );
      const count = Number(result.rows[0]?.n);
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new Error("Fan-out cleanup returned an invalid final count.");
      }
      return count;
    }
  );
  if (remainingRows !== 0) {
    throw new Error(
      `Fan-out cleanup left ${remainingRows} row(s) in agent_memory.`
    );
  }

  return {
    deletedRows,
    batches,
    maxBatchRows,
    remainingRows,
    elapsedMs: Math.round(performance.now() - startedAt),
  };
}

/** @internal Exported only so the fail-closed error semantics stay regression-tested. */
export async function withFanoutFinalCleanup<T>(
  work: () => Promise<T>,
  cleanup: () => Promise<void>
): Promise<T> {
  let primaryFailed = false;
  let primaryError: unknown;
  let cleanupFailed = false;
  let cleanupError: unknown;
  let result: T | undefined;

  try {
    try {
      result = await work();
    } catch (error) {
      primaryFailed = true;
      primaryError = error;
    }
  } finally {
    try {
      await cleanup();
    } catch (error) {
      cleanupFailed = true;
      cleanupError = error;
    }
  }

  if (primaryFailed && cleanupFailed) {
    throw new AggregateError(
      [primaryError, cleanupError],
      "Fan-out workload and final cleanup both failed."
    );
  }
  if (primaryFailed) throw primaryError;
  if (cleanupFailed) throw cleanupError;
  return result as T;
}

async function exactUnsplit(log: (line: string) => void): Promise<number> {
  const rows = await query<{ pretty: string }>(
    `ALTER TABLE agent_memory UNSPLIT AT VALUES ${FANOUT_SPLIT_POINTS.map(
      (_, index) => `($${index + 1}::UUID)`
    ).join(", ")}`,
    [...FANOUT_SPLIT_POINTS]
  );
  const prettyKeys = rows
    .map((row) => row.pretty)
    .filter((value): value is string => Boolean(value));
  if (
    rows.length !== FANOUT_SPLIT_POINTS.length ||
    new Set(prettyKeys).size !== FANOUT_SPLIT_POINTS.length
  ) {
    throw new Error("Exact fan-out UNSPLIT did not return all three points.");
  }
  const enforced = await query<{ n: string }>(
    `SELECT count(*) AS n
       FROM [SHOW RANGES FROM TABLE agent_memory]
      WHERE split_enforced_until IS NOT NULL`
  );
  if (Number(enforced[0]?.n) !== 0) {
    throw new Error(
      "An enforced agent_memory split remains after exact UNSPLIT."
    );
  }
  log(`cleanup[unsplit] released=${rows.length} exact-owned-points`);
  return rows.length;
}

// Split the memory table across ranges, run one ANN recall per query, score it against
// brute-force ground truth, prove the neighbours span multiple ranges, and EXPLAIN the plan.
// Returns the measured facts; the CLI wrapper and the test both consume them.
export async function runFanoutDemo(opts: FanoutOptions = {}): Promise<FanoutResult> {
  const n = opts.n ?? 3000;
  const queries = opts.queries ?? 40;
  const k = opts.k ?? 10;
  const log = opts.log ?? (() => {});
  const { clusters, corpus, queries: queryVecs } = makeCorpus(n, queries);

  guardDestructive();
  log(`Multi-range fan-out demo: N=${n} · ${queries} queries · top-${k} · dim=${DIM} · ${clusters} clusters`);
  let ownsSplits = false;
  let cleanupAuthorized = false;
  let preCleanupDeadlineExceeded = false;
  const cleanupReceipt: {
    pre?: FanoutCleanupStats;
    post?: FanoutCleanupStats;
    unsplitPoints: number;
  } = { unsplitPoints: 0 };

  const measured = await withFanoutFinalCleanup(async () => {
    // Establish the same exact split points first. This makes a rerun recover a
    // prior interrupted demo while leaving every unrelated split untouched.
    const splitRows = await query<{ pretty: string }>(
      `ALTER TABLE agent_memory SPLIT AT VALUES ${FANOUT_SPLIT_POINTS.map(
        (_, index) => `($${index + 1}::UUID)`
      ).join(", ")}`,
      [...FANOUT_SPLIT_POINTS]
    );
    ownsSplits = true;
    const ownedPrettyKeys = splitRows
      .map((row) => row.pretty)
      .filter((value): value is string => Boolean(value));
    if (
      splitRows.length !== FANOUT_SPLIT_POINTS.length ||
      new Set(ownedPrettyKeys).size !== FANOUT_SPLIT_POINTS.length
    ) {
      throw new Error("Exact fan-out SPLIT did not return all three points.");
    }
    const unowned = await query<{ n: string }>(
      `SELECT count(*) AS n
         FROM crdb_internal.ranges
        WHERE table_name = 'agent_memory'
          AND split_enforced_until IS NOT NULL
          AND NOT (start_pretty = ANY($1::STRING[]))`,
      [ownedPrettyKeys]
    );
    if (Number(unowned[0]?.n) !== 0) {
      throw new Error(
        "Refusing fan-out work while an unrelated enforced split exists."
      );
    }

    cleanupAuthorized = true;
    try {
      cleanupReceipt.pre = await deleteFanoutRowsInBatches({
        phase: "pre",
        log,
      });
    } catch (error) {
      preCleanupDeadlineExceeded =
        error instanceof FanoutCleanupDeadlineError;
      throw error;
    }

  // 1. Load the corpus (batched, index-maintained). PKs default to gen_random_uuid().
  const BATCH = 500;
  const t0 = performance.now();
  for (let start = 0; start < n; start += BATCH) {
    const end = Math.min(start + BATCH, n);
    const values: string[] = [];
    const params: unknown[] = [];
    for (let i = start; i < end; i++) {
      const b = params.length;
      params.push("insight", "_fanout", null, String(i), `fanout memory ${i}`, null, toVectorLiteral(corpus[i]), "fanout");
      values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7}::VECTOR,$${b + 8})`);
    }
    await query(
      `INSERT INTO agent_memory (kind, company, period, source_ref, content, metadata, embedding, embed_model)
       VALUES ${values.join(",")}`,
      params
    );
  }
  log(`Loaded ${n} memories in ${((performance.now() - t0) / 1000).toFixed(1)}s`);

  // 2. Prove the exact enforced split points created multiple table ranges.
  const tableRanges = await rangeCount("TABLE agent_memory");
  const indexRanges = await rangeCount(`INDEX ${IDX}`);
  const detail = await query<{ range_id: string; lease_holder: string; replicas: number[] }>(
    `SELECT range_id, lease_holder, replicas
       FROM [SHOW RANGES FROM TABLE agent_memory WITH DETAILS] ORDER BY range_id`
  );
  log(`\nMemory table spans ${tableRanges} KV range(s) (vector index: ${indexRanges} range(s) at this scale):`);
  log("  range_id | lease_holder | replicas");
  log("  ---------+--------------+----------");
  for (const r of detail) {
    log(`  ${String(r.range_id).padStart(8)} | ${String(r.lease_holder).padStart(12)} | {${r.replicas.join(",")}}`);
  }
  log(`\n→ One ANN recall must gather + merge candidates across these ${tableRanges} ranges.`);

  // 3. Unscoped ANN recall: correctness vs ground truth + which ranges the neighbours came from.
  let recallSum = 0;
  let recallMin = 1;
  const bucketsTouched = new Set<number>();
  await withClient(async (client) => {
    for (let qi = 0; qi < queries; qi++) {
      const truth = exactTopK(corpus, queryVecs[qi], k);
      // No company filter → served by the GLOBAL vector index (vector search → lookup join).
      const res = await client.query<{ id: string; source_ref: string }>(
        `SELECT id, source_ref FROM agent_memory
          ORDER BY embedding <=> $1::VECTOR LIMIT ${k}`,
        [toVectorLiteral(queryVecs[qi])]
      );
      let hit = 0;
      for (const row of res.rows) {
        if (truth.has(Number(row.source_ref))) hit++;
        bucketsTouched.add(uuidBucket(row.id)); // the primary range this neighbour lives in
      }
      const recall = hit / k;
      recallSum += recall;
      recallMin = Math.min(recallMin, recall);
    }
  });
  const recallMean = recallSum / queries;
  const rangesTouchedByRecall = bucketsTouched.size;
  log(
    `\nrecall@${k}: mean ${(recallMean * 100).toFixed(1)}% · min ${(recallMin * 100).toFixed(0)}% · ` +
      `top-k neighbours drawn from ${rangesTouchedByRecall} distinct primary range(s)`
  );

  // 4. EXPLAIN (unscoped) proves it is index-accelerated ANN, not a scan.
  const q = toVectorLiteral(queryVecs[0]);
  const plan = await query<{ info: string }>(
    `EXPLAIN SELECT id FROM agent_memory ORDER BY embedding <=> '${q}'::VECTOR LIMIT ${k}`
  );
  const usesVectorSearch = plan.some((p) => /vector search/i.test(p.info));
  log("\nEXPLAIN plan:");
  for (const p of plan) log("  " + p.info);
  log(`\n→ plan uses a 'vector search' node: ${usesVectorSearch}`);

  return {
    corpus: n,
    tableRanges,
    indexRanges,
    rangesTouchedByRecall,
    recallAtKMean: Number(recallMean.toFixed(4)),
    recallAtKMin: Number(recallMin.toFixed(4)),
    usesVectorSearch,
    k,
  };
  }, async () => {
    const cleanupErrors: unknown[] = [];
    if (cleanupAuthorized && !preCleanupDeadlineExceeded) {
      try {
        cleanupReceipt.post = await deleteFanoutRowsInBatches({
          phase: "final",
          log,
        });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (ownsSplits) {
      try {
        cleanupReceipt.unsplitPoints = await exactUnsplit(log);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    if (cleanupErrors.length > 1) {
      throw new AggregateError(
        cleanupErrors,
        "Fan-out row cleanup and exact UNSPLIT both failed."
      );
    }
  });

  if (
    !cleanupReceipt.pre ||
    !cleanupReceipt.post ||
    cleanupReceipt.unsplitPoints !== 3
  ) {
    throw new Error("Fan-out cleanup receipt is incomplete.");
  }
  return {
    ...measured,
    preCleanup: cleanupReceipt.pre,
    postCleanup: cleanupReceipt.post,
    unsplitPoints: cleanupReceipt.unsplitPoints,
  };
}

// ── CLI wrapper ────────────────────────────────────────────────────────────────
async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("fanout:demo requires a real CockroachDB — set DATABASE_URL (docker compose up + npm run db:schema).");
    process.exit(1);
  }
  const recallFloor = Number(process.env.FANOUT_RECALL_FLOOR ?? 0.9);
  let result: FanoutResult;
  try {
    result = await runFanoutDemo({
      n: Number(process.env.FANOUT_N ?? 3000),
      queries: Number(process.env.FANOUT_QUERIES ?? 40),
      k: Number(process.env.FANOUT_K ?? 10),
      log: (line) => console.log(line),
    });
  } finally {
    await closePool();
  }

  console.log(`\nJSON ${JSON.stringify(result)}`);
  const ok =
    result.tableRanges >= 2 &&
    result.rangesTouchedByRecall >= 2 &&
    result.recallAtKMean >= recallFloor &&
    result.usesVectorSearch;
  if (!ok) {
    throw new Error(
      `fan-out demonstration FAILED (tableRanges=${result.tableRanges}>=2? ` +
        `rangesTouched=${result.rangesTouchedByRecall}>=2? recall=${result.recallAtKMean}>=${recallFloor}? ` +
        `vectorSearch=${result.usesVectorSearch}?)`
    );
  }
  console.log(
    `\n✓ Multi-range ANN fan-out DEMONSTRATED: the memory spans ${result.tableRanges} ranges, one recall ` +
      `query fans out across them (top-k drawn from ${result.rangesTouchedByRecall} ranges) and returns the correct ` +
      `top-k (recall@${result.k} ${(result.recallAtKMean * 100).toFixed(1)}%).`
  );
}

// Run the CLI ONLY when this file is the process entry point (`tsx scripts/fanout-demo.ts`),
// never when imported (e.g. by tests/fanout.test.ts). pathToFileURL normalizes the argv path.
const invokedDirectly = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error("fanout demo failed:", err);
    process.exit(1);
  });
}
