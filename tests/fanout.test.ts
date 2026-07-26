// Multi-range ANN fan-out tests.
//
// Two levels, so the suite is meaningful on BOTH the offline mock and a real CockroachDB
// (the same DATABASE_URL-gated pattern the rest of the suite uses):
//   • Test 1 (both paths)  — an ANN recall query returns the correct top-k vs brute-force
//     ground truth. Runs under the in-memory mock (exact) and real CockroachDB (ANN).
//   • Test 2 (real DB only) — forces the memory table into >=2 KV ranges with enforced
//     primary-key `SPLIT AT` (deterministic, size-independent — not a natural size-driven
//     auto-split), then proves ONE recall query fans out across those ranges and still
//     returns the correct top-k, and that EXPLAIN plans a `vector search` node. Skipped
//     under the mock (SHOW RANGES / EXPLAIN are not modelled there).
//
// This turns docs/BENCHMARK.md Result 3b (multi-range fan-out) from asserted into
// tested. The heavy path shares one code path + one corpus load with scripts/fanout-demo.ts.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { query, closePool, toVectorLiteral } from "../src/db/client.js";
import { unitGaussianVector, normalize, EMBED_DIM } from "../src/memory/embeddings.js";
import {
  FANOUT_CLEANUP_BATCH_SIZE,
  FANOUT_CLEANUP_DEADLINE_MS,
  FANOUT_CLEANUP_STATEMENT_TIMEOUT_MS,
  FANOUT_SPLIT_POINTS,
  deleteFanoutRowsInBatches,
  runFanoutDemo,
  withFanoutFinalCleanup,
} from "../scripts/fanout-demo.js";

// Whether a real DB is configured — captured before importing the mock (which sets a
// dummy DATABASE_URL). Same signal integration.test.ts uses to pick the path.
const REAL_DB = !!process.env.DATABASE_URL;
if (!REAL_DB) await import("./db_mock.js");

const DIM = EMBED_DIM;

before(async () => {
  if (REAL_DB) {
    await deleteFanoutRowsInBatches({ phase: "suite-setup" });
  } else {
    await query(`DELETE FROM agent_memory`);
  }
});

after(async () => {
  await closePool();
});

test("0. fan-out final cleanup preserves and aggregates exact failures", async () => {
  const primary = new Error("primary");
  const cleanup = new Error("cleanup");
  let caught: unknown;
  try {
    await withFanoutFinalCleanup(
      async () => {
        throw primary;
      },
      async () => {}
    );
  } catch (error) {
    caught = error;
  }
  assert.equal(caught, primary);

  caught = undefined;
  try {
    await withFanoutFinalCleanup(
      async () => {
        throw primary;
      },
      async () => {
        throw cleanup;
      }
    );
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof AggregateError);
  assert.deepEqual(caught.errors, [primary, cleanup]);

  let rejectedUndefined = false;
  try {
    await withFanoutFinalCleanup(
      async () => {
        throw undefined;
      },
      async () => {}
    );
  } catch (error) {
    rejectedUndefined = true;
    assert.equal(error, undefined);
  }
  assert.equal(rejectedUndefined, true);
});

test("0b. exported cleanup refuses a non-ephemeral database", async () => {
  const previousUrl = process.env.DATABASE_URL;
  const previousOverride = process.env.ALLOW_DESTRUCTIVE_FANOUT;
  process.env.DATABASE_URL =
    "postgresql://operator@example.invalid:26257/archon?sslmode=verify-full";
  delete process.env.ALLOW_DESTRUCTIVE_FANOUT;
  try {
    await assert.rejects(
      () => deleteFanoutRowsInBatches({ phase: "guard-proof" }),
      /Refusing to run the destructive fan-out demo/u
    );
  } finally {
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    if (previousOverride === undefined) {
      delete process.env.ALLOW_DESTRUCTIVE_FANOUT;
    } else {
      process.env.ALLOW_DESTRUCTIVE_FANOUT = previousOverride;
    }
  }
});

// ── Test 1 — ANN recall returns the correct top-k (mock: exact, real: ANN) ──────
test("1. ANN recall over the vector index returns the correct top-k", async () => {
  const N = 120;
  const CLUSTERS = 8;
  const K = 10;
  const COMPANY = "FanoutRecall";
  const centroids = Array.from({ length: CLUSTERS }, (_, c) => unitGaussianVector(7_000 + c, DIM));
  // Precompute the vectors once — draw the noise per index (O(dim)), not per dimension
  // (which would be O(dim²) and dominate the test).
  const build = (count: number, seedBase: number) =>
    Array.from({ length: count }, (_, i) => {
      const noise = unitGaussianVector(seedBase + i, DIM);
      return normalize(centroids[i % CLUSTERS].map((x, d) => x + 0.35 * noise[d]));
    });
  const QUERIES = 20;
  const corpus = build(N, 11_000);
  const queryVecs = build(QUERIES, 22_000);

  // Load row-by-row (the mock records one row per INSERT call, so a multi-row batch would
  // only store its first row — single-row inserts keep the offline path faithful).
  for (let i = 0; i < N; i++) {
    await query(
      `INSERT INTO agent_memory (kind, company, period, source_ref, content, metadata, embedding, embed_model)
       VALUES ($1, $2, $3, $4, $5, $6, $7::VECTOR, $8)`,
      ["insight", COMPANY, null, String(i), `recall memory ${i}`, null, toVectorLiteral(corpus[i]), "test"]
    );
  }

  const exactTopK = (q: number[]): Set<number> => {
    const scored: { i: number; dist: number }[] = [];
    for (let i = 0; i < N; i++) {
      const v = corpus[i];
      let dot = 0;
      for (let d = 0; d < DIM; d++) dot += v[d] * q[d];
      scored.push({ i, dist: 1 - dot });
    }
    scored.sort((a, b) => a.dist - b.dist);
    return new Set(scored.slice(0, K).map((s) => s.i));
  };

  let recallSum = 0;
  for (let qi = 0; qi < QUERIES; qi++) {
    const q = queryVecs[qi];
    const truth = exactTopK(q);
    // Full-column SELECT so it exercises the same recall shape the mock models.
    const rows = await query<{ source_ref: string }>(
      `SELECT id, kind, company, period, source_ref, content, metadata, created_at,
              (embedding <=> $1::VECTOR) AS distance
         FROM agent_memory
        WHERE company = $2
        ORDER BY embedding <=> $1::VECTOR
        LIMIT $3`,
      [toVectorLiteral(q), COMPANY, K]
    );
    assert.ok(rows.length <= K);
    let hit = 0;
    for (const r of rows) if (truth.has(Number(r.source_ref))) hit++;
    recallSum += hit / K;
  }
  const recallMean = recallSum / QUERIES;
  // Mock is exact (→1.0); a real ANN index over a well-separated 120-vector corpus is
  // effectively exact too. 0.85 is a comfortable floor for both without flaking.
  assert.ok(recallMean >= 0.85, `recall@${K} ${(recallMean * 100).toFixed(1)}% below 85% floor`);
});

test(
  "2. real cleanup is primary-key bounded and commits one transaction per batch",
  { skip: REAL_DB ? false : "requires a real CockroachDB" },
  async () => {
    assert.deepEqual(FANOUT_SPLIT_POINTS, [
      "40000000-0000-0000-0000-000000000000",
      "80000000-0000-0000-0000-000000000000",
      "c0000000-0000-0000-0000-000000000000",
    ]);
    assert.equal(FANOUT_CLEANUP_BATCH_SIZE, 100);
    assert.equal(FANOUT_CLEANUP_STATEMENT_TIMEOUT_MS, 30_000);
    assert.equal(FANOUT_CLEANUP_DEADLINE_MS, 240_000);

    await deleteFanoutRowsInBatches({ phase: "test-reset" });
    const vector = toVectorLiteral(unitGaussianVector(88_001, DIM));
    const params: unknown[] = [vector];
    const values: string[] = [];
    for (let index = 0; index < 205; index++) {
      params.push(`cleanup-${index}`);
      const ref = params.length;
      values.push(
        `('insight', '_fanout-cleanup', $${ref}, ` +
          `'cleanup row ' || $${ref}, $1::VECTOR, 'fanout-cleanup')`
      );
    }
    await query(
      `INSERT INTO agent_memory
         (kind, company, source_ref, content, embedding, embed_model)
       VALUES ${values.join(", ")}`,
      params
    );

    const stats = await deleteFanoutRowsInBatches({
      phase: "batch-contract",
    });
    assert.equal(stats.deletedRows, 205);
    assert.equal(stats.batches, 3);
    assert.equal(stats.maxBatchRows, 100);
    assert.equal(stats.remainingRows, 0);
    const remaining = await query<{ n: string }>(
      "SELECT count(*) AS n FROM agent_memory"
    );
    assert.equal(Number(remaining[0]?.n), 0);
  }
);

test(
  "3. real cleanup does not retry a lock-induced statement timeout",
  { skip: REAL_DB ? false : "requires a real CockroachDB" },
  async () => {
    await deleteFanoutRowsInBatches({ phase: "lock-test-reset" });
    const lockedId = "00000000-0000-0000-0000-000000000001";
    const vector = toVectorLiteral(unitGaussianVector(88_002, DIM));
    const inserted = await query<{ id: string }>(
      `INSERT INTO agent_memory
         (id, kind, company, source_ref, content, embedding, embed_model)
       VALUES ($1::UUID, 'insight', '_fanout-lock', 'lock-row', 'lock row',
               $2::VECTOR, 'fanout-lock')
       RETURNING id`,
      [lockedId, vector]
    );
    const id = inserted[0]?.id;
    assert.equal(id, lockedId);

    const locker = new Client({
      connectionString: process.env.DATABASE_URL,
    });
    await locker.connect();
    try {
      await locker.query("BEGIN");
      const locked = await locker.query(
        "SELECT id FROM agent_memory WHERE id = $1::UUID FOR UPDATE",
        [id]
      );
      assert.equal(locked.rowCount, 1);
      await assert.rejects(
        () =>
          deleteFanoutRowsInBatches({
            phase: "lock-timeout",
            statementTimeoutMs: 250,
            deadlineMs: 2_000,
          }),
        (error: unknown) => {
          const code =
            typeof error === "object" && error !== null && "code" in error
              ? (error as { code?: unknown }).code
              : undefined;
          assert.notEqual(code, "40001");
          assert.match(
            error instanceof Error ? error.message : String(error),
            /statement timeout|canceling statement|query execution canceled/iu
          );
          return true;
        }
      );
    } finally {
      try {
        await locker.query("ROLLBACK");
      } finally {
        await locker.end();
      }
    }

    const recovered = await deleteFanoutRowsInBatches({
      phase: "lock-recovery",
    });
    assert.equal(recovered.deletedRows, 1);
    assert.equal(recovered.batches, 1);
    assert.equal(recovered.remainingRows, 0);
  }
);

// ── Test 4 — one ANN recall fans out across a multi-range memory (real DB only) ──
test(
  "4. the memory splits into >=2 KV ranges and one ANN recall fans out across them correctly",
  { skip: REAL_DB ? false : "requires a real CockroachDB (SPLIT AT / SHOW RANGES / EXPLAIN not modelled by the mock)" },
  async () => {
    const result = await runFanoutDemo({
      n: Number(process.env.FANOUT_N ?? 3000),
      queries: 40,
      k: 10,
      log: (line) => console.log(line),
    });

    // The memory table genuinely occupies MULTIPLE KV ranges (forced deterministically).
    assert.ok(
      result.tableRanges >= 2,
      `memory table has ${result.tableRanges} range(s), expected >=2 — fan-out not demonstrated`
    );
    // The single ANN recall's top-k neighbours came from >=2 distinct ranges — it fanned out.
    assert.ok(
      result.rangesTouchedByRecall >= 2,
      `top-k neighbours came from only ${result.rangesTouchedByRecall} range(s), expected >=2 — no fan-out`
    );
    // And stayed correct under that distributed execution.
    assert.ok(
      result.recallAtKMean >= 0.9,
      `recall@${result.k} ${(result.recallAtKMean * 100).toFixed(1)}% across ${result.tableRanges} ranges below 90% floor`
    );
    // Index-accelerated ANN, not a full scan.
    assert.equal(result.usesVectorSearch, true, "EXPLAIN did not plan a `vector search` node");
    assert.equal(result.postCleanup.deletedRows, result.corpus);
    assert.equal(
      result.postCleanup.batches,
      Math.ceil(result.corpus / FANOUT_CLEANUP_BATCH_SIZE)
    );
    assert.equal(
      result.postCleanup.maxBatchRows,
      Math.min(result.corpus, FANOUT_CLEANUP_BATCH_SIZE)
    );
    assert.equal(result.postCleanup.remainingRows, 0);
    assert.equal(result.unsplitPoints, 3);

    const remaining = await query<{ n: string }>(
      "SELECT count(*) AS n FROM agent_memory"
    );
    assert.equal(Number(remaining[0]?.n), 0);
    const enforced = await query<{ n: string }>(
      `SELECT count(*) AS n
         FROM [SHOW RANGES FROM TABLE agent_memory]
        WHERE split_enforced_until IS NOT NULL`
    );
    assert.equal(Number(enforced[0]?.n), 0);
  }
);
