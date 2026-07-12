// Multi-range ANN fan-out demonstration.
//
//   npm run db:schema     # once, to create the VECTOR(1024) table + vector index
//   npm run fanout:demo   # load a corpus, split the index across ranges, prove fan-out
//
// WHY THIS EXISTS
//   docs/BENCHMARK.md Result 3 claims CockroachDB's native vector index splits into
//   multiple KV ranges and a recall query fans out across them. At tiny scale that was
//   ASSERTED (one range), never demonstrated. This makes it EVIDENCE: it loads a seeded
//   corpus large enough that the vector index auto-splits into >=2 ranges (no zone
//   hacking — CockroachDB's minimum range_max_bytes is 64 MiB; the split is driven by the
//   C-SPANN partition tree), then shows:
//     1. SHOW RANGES FROM INDEX  → the vector index genuinely occupies >=2 KV ranges.
//     2. one ANN recall query    → returns the correct top-k (recall@k vs brute-force
//                                   ground truth) WHILE the index spans those ranges — i.e.
//                                   the distributed scan fans out across ranges and merges.
//     3. EXPLAIN                 → the plan is a `vector search` node (index-accelerated
//                                   ANN, not a full scan).
//
// The core is exported as `runFanoutDemo()` so tests/fanout.test.ts asserts on exactly
// what this script prints — one source of truth, one corpus load in CI.
//
// Runs fully OFFLINE for embeddings (seeded unit vectors, no AWS) but REQUIRES a real
// CockroachDB (SHOW RANGES / EXPLAIN are not meaningful against the offline mock). CI
// stands one up; locally point DATABASE_URL at `docker compose up` + `npm run db:schema`.
//
// NON-DESTRUCTIVE: it only manages rows tagged company='_fanout' (delete-before, delete-
// after). It does not TRUNCATE, so it is safe to run against a shared benchmark DB.

import { pathToFileURL } from "node:url";
import { unitGaussianVector, normalize, EMBED_DIM } from "../src/memory/embeddings.js";
import { query, closePool, withClient, toVectorLiteral } from "../src/db/client.js";

const DIM = EMBED_DIM;
const TAG = "_fanout";
const IDX = "agent_memory@idx_agent_memory_embedding";

export interface FanoutOptions {
  n?: number; // corpus size (3k→1 range, 8k→2, 10k→3 measured on v26.2.3)
  queries?: number;
  k?: number;
  minRanges?: number;
  splitTimeoutMs?: number;
  log?: (line: string) => void;
}

export interface FanoutResult {
  corpus: number;
  indexRanges: number;
  recallAtKMean: number;
  recallAtKMin: number;
  usesVectorSearch: boolean;
  k: number;
}

// A seeded clustered corpus (centroid + noise) — mirrors the manifold structure of real
// sentence embeddings, and lets us recompute exact ground-truth neighbours in JS. The
// vectors are PRECOMPUTED once (the noise draw is O(dim); doing it per dimension or per
// query would be O(dim²)·O(n) and dominate the run).
function makeCorpus(n: number, queriesN: number) {
  const clusters = Math.max(8, Math.round(n / 200));
  const centroids = Array.from({ length: clusters }, (_, c) => unitGaussianVector(7_000 + c, DIM));
  const build = (count: number, seedBase: number) =>
    Array.from({ length: count }, (_, i) => {
      const noise = unitGaussianVector(seedBase + i, DIM);
      return normalize(centroids[i % clusters].map((x, d) => x + 0.35 * noise[d]));
    });
  const corpus = build(n, 3_000_000);
  const queries = build(queriesN, 5_000_000);
  return { clusters, corpus, queries };
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

async function indexRangeCount(): Promise<number> {
  const rows = await query<{ n: string }>(`SELECT count(*) AS n FROM [SHOW RANGES FROM INDEX ${IDX}]`);
  return Number(rows[0].n);
}

// Load the corpus, wait for the vector index to split into >=minRanges KV ranges, run
// one ANN recall per query and score it against brute-force ground truth, and EXPLAIN the
// plan. Returns the measured facts; the CLI wrapper and the test both consume them.
export async function runFanoutDemo(opts: FanoutOptions = {}): Promise<FanoutResult> {
  const n = opts.n ?? 10000;
  const queries = opts.queries ?? 50;
  const k = opts.k ?? 10;
  const minRanges = opts.minRanges ?? 2;
  const splitTimeoutMs = opts.splitTimeoutMs ?? 60000;
  const log = opts.log ?? (() => {});
  const { clusters, corpus, queries: queryVecs } = makeCorpus(n, queries);

  log(`Multi-range fan-out demo: N=${n} · ${queries} queries · top-${k} · dim=${DIM} · ${clusters} clusters`);
  await query(`DELETE FROM agent_memory WHERE company = $1`, [TAG]);

  // 1. Load the corpus (batched, index-maintained).
  const BATCH = 500;
  const t0 = performance.now();
  for (let start = 0; start < n; start += BATCH) {
    const end = Math.min(start + BATCH, n);
    const values: string[] = [];
    const params: unknown[] = [];
    for (let i = start; i < end; i++) {
      const b = params.length;
      params.push("insight", TAG, null, String(i), `fanout memory ${i}`, null, toVectorLiteral(corpus[i]), "fanout");
      values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7}::VECTOR,$${b + 8})`);
    }
    await query(
      `INSERT INTO agent_memory (kind, company, period, source_ref, content, metadata, embedding, embed_model)
       VALUES ${values.join(",")}`,
      params
    );
  }
  log(`Loaded ${n} memories in ${((performance.now() - t0) / 1000).toFixed(1)}s`);

  // 2. Wait for the vector index to split into >=minRanges KV ranges.
  const tSplit = performance.now();
  let ranges = await indexRangeCount();
  while (ranges < minRanges && performance.now() - tSplit < splitTimeoutMs) {
    await new Promise((r) => setTimeout(r, 2000));
    ranges = await indexRangeCount();
  }
  const detail = await query<{ range_id: string; lease_holder: string; replicas: number[] }>(
    `SELECT range_id, lease_holder, replicas
       FROM [SHOW RANGES FROM INDEX ${IDX} WITH DETAILS] ORDER BY range_id`
  );
  log(`\nVector index (${IDX}) occupies ${ranges} KV range(s):`);
  log("  range_id | lease_holder | replicas");
  log("  ---------+--------------+----------");
  for (const r of detail) {
    log(`  ${String(r.range_id).padStart(8)} | ${String(r.lease_holder).padStart(12)} | {${r.replicas.join(",")}}`);
  }
  log(`\n→ The single ANN recall query below must gather candidates from all ${ranges} range(s) and merge them.`);

  // 3. Recall@k across the multi-range index vs brute-force ground truth.
  let recallSum = 0;
  let recallMin = 1;
  await withClient(async (client) => {
    for (let qi = 0; qi < queries; qi++) {
      const truth = exactTopK(corpus, queryVecs[qi], k);
      const res = await client.query<{ source_ref: string }>(
        `SELECT source_ref FROM agent_memory
          WHERE company = $2
          ORDER BY embedding <=> $1::VECTOR LIMIT ${k}`,
        [toVectorLiteral(queryVecs[qi]), TAG]
      );
      let hit = 0;
      for (const row of res.rows) if (truth.has(Number(row.source_ref))) hit++;
      const recall = hit / k;
      recallSum += recall;
      recallMin = Math.min(recallMin, recall);
    }
  });
  const recallMean = recallSum / queries;
  log(`\nrecall@${k} across ${ranges} range(s): mean ${(recallMean * 100).toFixed(1)}% · min ${(recallMin * 100).toFixed(0)}%`);

  // 4. EXPLAIN proves it is index-accelerated ANN, not a scan.
  const q = toVectorLiteral(queryVecs[0]);
  const plan = await query<{ info: string }>(
    `EXPLAIN SELECT id FROM agent_memory WHERE company = '${TAG}' ORDER BY embedding <=> '${q}'::VECTOR LIMIT ${k}`
  );
  const usesVectorSearch = plan.some((p) => /vector search/i.test(p.info));
  log("\nEXPLAIN plan:");
  for (const p of plan) log("  " + p.info);
  log(`\n→ plan uses a 'vector search' node: ${usesVectorSearch}`);

  await query(`DELETE FROM agent_memory WHERE company = $1`, [TAG]);

  return {
    corpus: n,
    indexRanges: ranges,
    recallAtKMean: Number(recallMean.toFixed(4)),
    recallAtKMin: Number(recallMin.toFixed(4)),
    usesVectorSearch,
    k,
  };
}

// ── CLI wrapper ────────────────────────────────────────────────────────────────
async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("fanout:demo requires a real CockroachDB — set DATABASE_URL (docker compose up + npm run db:schema).");
    process.exit(1);
  }
  const recallFloor = Number(process.env.FANOUT_RECALL_FLOOR ?? 0.9);
  const minRanges = Number(process.env.FANOUT_MIN_RANGES ?? 2);
  const result = await runFanoutDemo({
    n: Number(process.env.FANOUT_N ?? 10000),
    queries: Number(process.env.FANOUT_QUERIES ?? 50),
    k: Number(process.env.FANOUT_K ?? 10),
    minRanges,
    splitTimeoutMs: Number(process.env.FANOUT_SPLIT_TIMEOUT_MS ?? 60000),
    log: (line) => console.log(line),
  });
  await closePool();

  console.log(`\nJSON ${JSON.stringify(result)}`);
  const ok = result.indexRanges >= minRanges && result.recallAtKMean >= recallFloor && result.usesVectorSearch;
  if (!ok) {
    throw new Error(
      `fan-out demonstration FAILED (ranges=${result.indexRanges}>=${minRanges}? ` +
        `recall=${result.recallAtKMean}>=${recallFloor}? vectorSearch=${result.usesVectorSearch}?)`
    );
  }
  console.log(
    `\n✓ Multi-range ANN fan-out DEMONSTRATED: the index spans ${result.indexRanges} ranges, ` +
      `one recall query fans out across them and returns the correct top-k (recall@${result.k} ${(result.recallAtKMean * 100).toFixed(1)}%).`
  );
}

// Run the CLI ONLY when this file is the process entry point (`tsx scripts/fanout-demo.ts`),
// never when it is imported (e.g. by tests/fanout.test.ts). pathToFileURL normalizes the
// argv path so the comparison is correct on both Windows and POSIX.
const invokedDirectly = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error("fanout demo failed:", err);
    process.exit(1);
  });
}
