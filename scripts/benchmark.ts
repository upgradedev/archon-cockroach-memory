// Benchmark the CockroachDB distributed vector index that backs agent memory.
//
//   npm run db:schema        # once, to create the VECTOR(1024) table + vector index
//   npm run benchmark        # measure write throughput, recall@k, and query latency
//
// What it measures, and why the measurement is VALID:
//   • Write throughput  — batched multi-row INSERTs of unit vectors (each write also
//                         maintains the ANN partition tree, so this is the real,
//                         index-maintained write rate, not a bulk-import shortcut).
//   • Recall@k          — CockroachDB's vector index (C-SPANN) is APPROXIMATE: a
//                         hierarchical k-means partition tree searched with a beam,
//                         not an exhaustive scan. We compute the EXACT top-k in JS
//                         (brute-force cosine over the same vectors we generated) as
//                         ground truth, then compare it to what the index returns.
//                         recall@k = |ANN ∩ exact| / k, averaged over the queries.
//   • Latency           — p50 / p95 / p99 of the ANN `ORDER BY embedding <=> q` query.
//   • Recall/latency tradeoff — we sweep `vector_search_beam_size` (the number of
//                         partitions the search visits) to show the knob that trades
//                         latency for accuracy, and report the whole curve.
//
// CORPUS (BENCH_CORPUS):
//   • clustered (default) — dense unit vectors drawn around a set of random centroids
//     with additive noise. This mirrors the manifold/cluster structure of real
//     sentence embeddings (Titan, etc.), which is what determines ANN recall in
//     production. It is the representative case, exactly as ANN-Benchmarks datasets
//     (SIFT/GloVe/DEEP) are — never uniform noise.
//   • uniform — dense vectors uniform on the unit hypersphere (no cluster structure).
//     This is the pathological WORST case for any ANN index (curse of dimensionality:
//     all pairwise distances concentrate), reported as a stress lower bound.
// Both are deterministic and seeded, so ground truth is recomputed in JS exactly.
// Runs fully OFFLINE — no AWS/Bedrock; the vectors carry no semantics, they exist
// purely to stress and measure the index (Titan supplies real semantics in prod).
//
// SAFETY: DESTRUCTIVE — it TRUNCATEs agent_memory so the unscoped ANN query is
// measured against exactly the benchmark corpus (the pure `vector search` plan, no
// post-filtering). Point DATABASE_URL at an EPHEMERAL benchmark DB (CI runner, local
// docker, throwaway cluster), never at a cluster holding real memories. It refuses
// unless the DB name looks ephemeral or ALLOW_DESTRUCTIVE_BENCHMARK=1 is set.

import { unitGaussianVector, normalize, EMBED_DIM } from "../src/memory/embeddings.js";
import { query, withClient, closePool, toVectorLiteral } from "../src/db/client.js";

// ── config (env-overridable: CI runs a small smoke, dispatch runs the full set) ──
const N = Number(process.env.BENCH_N ?? 2000);
const QUERIES = Number(process.env.BENCH_QUERIES ?? 100);
const K = Number(process.env.BENCH_K ?? 10);
const BATCH = Math.min(Number(process.env.BENCH_BATCH ?? 500), 500); // 500 stays under the pg wire message limit
const DIM = EMBED_DIM;
const CORPUS = (process.env.BENCH_CORPUS ?? "clustered").toLowerCase(); // clustered | uniform
const CLUSTERS = Number(process.env.BENCH_CLUSTERS ?? Math.max(8, Math.round(N / 200)));
const NOISE = Number(process.env.BENCH_NOISE ?? 0.35); // tightness of each cluster
const BEAMS = (process.env.BENCH_BEAMS ?? "").trim()
  ? process.env.BENCH_BEAMS!.split(",").map((s) => Number(s.trim())).filter((n) => n > 0)
  : []; // empty → use the cluster default beam only
const SETTLE_MS = Number(process.env.BENCH_SETTLE_MS ?? 0); // wait for index maintenance before measuring

function guardDestructive() {
  const url = process.env.DATABASE_URL ?? "";
  const dbName = decodeURIComponent(url.split("/").pop()?.split("?")[0] ?? "");
  const looksEphemeral = /(bench|test|ci|_memory|archon_memory|defaultdb)/i.test(dbName);
  if (!looksEphemeral && process.env.ALLOW_DESTRUCTIVE_BENCHMARK !== "1") {
    throw new Error(
      `Refusing to run a destructive benchmark against database "${dbName}". ` +
        `Point DATABASE_URL at an ephemeral benchmark DB, or set ALLOW_DESTRUCTIVE_BENCHMARK=1.`
    );
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

// Exact top-k neighbours (cosine distance) over the in-memory corpus — ground truth.
// Unit vectors ⇒ cosine distance = 1 - dot; smaller dot ⇒ larger distance.
function exactTopK(corpus: number[][], q: number[], k: number): number[] {
  const scored = corpus.map((v, i) => {
    let dot = 0;
    for (let d = 0; d < v.length; d++) dot += v[d] * q[d];
    return { i, dist: 1 - dot };
  });
  scored.sort((a, b) => a.dist - b.dist);
  return scored.slice(0, k).map((s) => s.i);
}

// Build the corpus + queries. Clustered: pick a centroid, add gaussian noise,
// renormalize. Uniform: a fresh point on the sphere. All deterministic via seeds.
function generate(): { corpus: number[][]; queries: number[][] } {
  if (CORPUS === "uniform") {
    const corpus = Array.from({ length: N }, (_, i) => unitGaussianVector(1_000 + i, DIM));
    const queries = Array.from({ length: QUERIES }, (_, i) => unitGaussianVector(9_000_000 + i, DIM));
    return { corpus, queries };
  }
  const centroids = Array.from({ length: CLUSTERS }, (_, c) => unitGaussianVector(7_000 + c, DIM));
  const mix = (base: number[], noiseSeed: number): number[] => {
    const noise = unitGaussianVector(noiseSeed, DIM);
    return normalize(base.map((x, d) => x + NOISE * noise[d]));
  };
  const corpus = Array.from({ length: N }, (_, i) => mix(centroids[i % CLUSTERS], 2_000_000 + i));
  const queries = Array.from({ length: QUERIES }, (_, i) =>
    mix(centroids[i % CLUSTERS], 5_000_000 + i)
  );
  return { corpus, queries };
}

async function main() {
  guardDestructive();
  console.log(
    `Benchmark: N=${N} · ${QUERIES} queries · top-${K} · dim=${DIM} · corpus=${CORPUS}` +
      (CORPUS === "clustered" ? ` (${CLUSTERS} clusters, noise ${NOISE})` : "")
  );

  await query(`TRUNCATE agent_memory`);
  const { corpus, queries } = generate();

  // ── 1. Write throughput — batched multi-row INSERTs ─────────────────────────
  const tWrite0 = performance.now();
  for (let start = 0; start < N; start += BATCH) {
    const end = Math.min(start + BATCH, N);
    const values: string[] = [];
    const params: unknown[] = [];
    for (let i = start; i < end; i++) {
      const b = params.length;
      params.push("insight", "_bench", null, String(i), `benchmark memory ${i}`, null, toVectorLiteral(corpus[i]), "bench");
      values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7}::VECTOR,$${b + 8})`);
    }
    await query(
      `INSERT INTO agent_memory (kind, company, period, source_ref, content, metadata, embedding, embed_model)
       VALUES ${values.join(",")}`,
      params
    );
  }
  const writeSec = (performance.now() - tWrite0) / 1000;
  const rows = Number((await query<{ n: string }>(`SELECT count(*) AS n FROM agent_memory`))[0].n);
  console.log(`Wrote ${rows} memories in ${writeSec.toFixed(2)}s = ${Math.round(rows / writeSec)} rows/s`);

  if (SETTLE_MS > 0) {
    console.log(`Settling ${SETTLE_MS}ms for index maintenance…`);
    await new Promise((r) => setTimeout(r, SETTLE_MS));
  }

  // ── 2. Recall@k + latency, swept over vector_search_beam_size ────────────────
  const beams = BEAMS.length ? BEAMS : [null]; // null → cluster default (100)
  const results: Array<{
    beam: number | null;
    recall_at_k_mean: number;
    recall_at_k_min: number;
    latency_ms_p50: number;
    latency_ms_p95: number;
    latency_ms_p99: number;
    latency_ms_mean: number;
  }> = [];

  await withClient(async (client) => {
    // Ground truth once (independent of beam).
    const truths = queries.map((q) => new Set(exactTopK(corpus, q, K)));
    // Warm up with a FULL query pass (at the largest beam) so ranges/caches are hot
    // and the per-beam latency curve reflects beam cost, not first-touch cold cache.
    const warmBeam = beams.filter((b) => b !== null).sort((a, b) => (b as number) - (a as number))[0];
    if (warmBeam) await client.query(`SET vector_search_beam_size = ${warmBeam}`);
    for (const q of queries) {
      await client.query(`SELECT id FROM agent_memory ORDER BY embedding <=> $1::VECTOR LIMIT ${K}`, [
        toVectorLiteral(q),
      ]);
    }

    for (const beam of beams) {
      if (beam !== null) await client.query(`SET vector_search_beam_size = ${beam}`);
      const lat: number[] = [];
      let recallSum = 0;
      let recallMin = 1;
      for (let qi = 0; qi < QUERIES; qi++) {
        const t0 = performance.now();
        const res = await client.query<{ source_ref: string }>(
          `SELECT source_ref FROM agent_memory ORDER BY embedding <=> $1::VECTOR LIMIT ${K}`,
          [toVectorLiteral(queries[qi])]
        );
        lat.push(performance.now() - t0);
        let hit = 0;
        for (const r of res.rows) if (truths[qi].has(Number(r.source_ref))) hit++;
        const recall = hit / K;
        recallSum += recall;
        recallMin = Math.min(recallMin, recall);
      }
      lat.sort((a, b) => a - b);
      results.push({
        beam,
        recall_at_k_mean: Number((recallSum / QUERIES).toFixed(4)),
        recall_at_k_min: Number(recallMin.toFixed(4)),
        latency_ms_p50: Number(percentile(lat, 50).toFixed(2)),
        latency_ms_p95: Number(percentile(lat, 95).toFixed(2)),
        latency_ms_p99: Number(percentile(lat, 99).toFixed(2)),
        latency_ms_mean: Number((lat.reduce((s, x) => s + x, 0) / lat.length).toFixed(2)),
      });
    }
  });

  // ── 3. Report ───────────────────────────────────────────────────────────────
  const writeRps = Math.round(rows / writeSec);
  console.log("\n=== Vector-index benchmark ===");
  console.log(`corpus           : ${N} memories (VECTOR(${DIM}), ${CORPUS})`);
  console.log(`write throughput : ${writeRps} rows/s (batched, index-maintained)`);
  console.log("\nbeam_size  recall@" + K + "   min      p50(ms)  p95(ms)  p99(ms)");
  for (const r of results) {
    const beam = r.beam === null ? "default" : String(r.beam);
    console.log(
      `${beam.padEnd(10)} ${(r.recall_at_k_mean * 100).toFixed(1).padStart(6)}%  ` +
        `${(r.recall_at_k_min * 100).toFixed(0).padStart(4)}%   ` +
        `${String(r.latency_ms_p50).padStart(7)}  ${String(r.latency_ms_p95).padStart(7)}  ${String(r.latency_ms_p99).padStart(7)}`
    );
  }
  const summary = { corpus_size: N, queries: QUERIES, top_k: K, dim: DIM, corpus: CORPUS, write_rows_per_sec: writeRps, beams: results };
  console.log("\nJSON " + JSON.stringify(summary));

  // CI floor: best recall achieved across the swept beams must clear the floor.
  const floor = Number(process.env.BENCH_RECALL_FLOOR ?? 0);
  if (floor > 0) {
    const best = Math.max(...results.map((r) => r.recall_at_k_mean));
    if (best < floor) throw new Error(`best recall@${K} ${best.toFixed(3)} below floor ${floor}`);
  }

  await query(`TRUNCATE agent_memory`);
  await closePool();
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
