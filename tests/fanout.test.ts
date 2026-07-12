// Multi-range ANN fan-out tests.
//
// Two levels, so the suite is meaningful on BOTH the offline mock and a real CockroachDB
// (the same DATABASE_URL-gated pattern the rest of the suite uses):
//   • Test 1 (both paths)  — an ANN recall query returns the correct top-k vs brute-force
//     ground truth. Runs under the in-memory mock (exact) and real CockroachDB (ANN).
//   • Test 2 (real DB only) — loads a corpus large enough that the native vector index
//     auto-splits into >=2 KV ranges, then proves ONE recall query fans out across those
//     ranges and still returns the correct top-k, and that EXPLAIN plans a `vector search`
//     node. Skipped under the mock (SHOW RANGES / EXPLAIN are not modelled there).
//
// This turns docs/BENCHMARK.md Result 3 (multi-range distribution) from asserted into
// tested. The heavy path shares one code path + one corpus load with scripts/fanout-demo.ts.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { query, closePool, toVectorLiteral } from "../src/db/client.js";
import { unitGaussianVector, normalize, EMBED_DIM } from "../src/memory/embeddings.js";
import { runFanoutDemo } from "../scripts/fanout-demo.js";

// Whether a real DB is configured — captured before importing the mock (which sets a
// dummy DATABASE_URL). Same signal integration.test.ts uses to pick the path.
const REAL_DB = !!process.env.DATABASE_URL;
if (!REAL_DB) await import("./db_mock.js");

const DIM = EMBED_DIM;

before(async () => {
  await query(`DELETE FROM agent_memory`);
});

after(async () => {
  await closePool();
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

// ── Test 2 — the vector index fans out across >=2 KV ranges (real DB only) ───────
test(
  "2. the native vector index splits into >=2 KV ranges and one recall query fans out correctly",
  { skip: REAL_DB ? false : "requires a real CockroachDB (SHOW RANGES / EXPLAIN not modelled by the mock)" },
  async () => {
    const result = await runFanoutDemo({
      n: Number(process.env.FANOUT_N ?? 10000),
      queries: 40,
      k: 10,
      minRanges: 2,
      splitTimeoutMs: 60000,
      log: (line) => console.log(line),
    });

    // The distinguishing claim: the vector index genuinely occupies MULTIPLE KV ranges.
    assert.ok(
      result.indexRanges >= 2,
      `vector index has ${result.indexRanges} range(s), expected >=2 — fan-out not demonstrated`
    );
    // One ANN query fanned out across those ranges and merged the correct neighbours.
    assert.ok(
      result.recallAtKMean >= 0.9,
      `recall@${result.k} ${(result.recallAtKMean * 100).toFixed(1)}% across ${result.indexRanges} ranges below 90% floor`
    );
    // Index-accelerated ANN, not a full scan.
    assert.equal(result.usesVectorSearch, true, "EXPLAIN did not plan a `vector search` node");
  }
);
