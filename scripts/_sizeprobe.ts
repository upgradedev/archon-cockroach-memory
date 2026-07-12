// TEMP size probe (remove before PR). Brackets the corpus size at which the native vector
// index splits into >=2 KV ranges, on a CLEAN single-node DB, WITHOUT SCATTER (so the
// attribution is pure size). Also checks the UNSCOPED EXPLAIN + clustered recall@10.

import { unitGaussianVector, normalize, EMBED_DIM } from "../src/memory/embeddings.js";
import { query, closePool, toVectorLiteral } from "../src/db/client.js";

const DIM = EMBED_DIM;
const IDX = "agent_memory@idx_agent_memory_embedding";

async function idxRanges(): Promise<number> {
  const r = await query<{ n: string }>(`SELECT count(*) AS n FROM [SHOW RANGES FROM INDEX ${IDX}]`);
  return Number(r[0].n);
}

function buildVecs(count: number, seedBase: number, clusters: number, centroids: number[][]) {
  return Array.from({ length: count }, (_, i) => {
    const noise = unitGaussianVector(seedBase + i, DIM);
    return normalize(centroids[i % clusters].map((x, d) => x + 0.35 * noise[d]));
  });
}

async function insertRange(vecs: number[][], from: number, to: number) {
  const BATCH = 500;
  for (let start = from; start < to; start += BATCH) {
    const end = Math.min(start + BATCH, to);
    const values: string[] = [];
    const params: unknown[] = [];
    for (let i = start; i < end; i++) {
      const b = params.length;
      params.push("insight", "_size", null, String(i), `s${i}`, null, toVectorLiteral(vecs[i]), "sz");
      values.push(`($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7}::VECTOR,$${b+8})`);
    }
    await query(`INSERT INTO agent_memory (kind,company,period,source_ref,content,metadata,embedding,embed_model) VALUES ${values.join(",")}`, params);
  }
}

async function pollRanges(label: string, seconds = 24) {
  const t0 = Date.now();
  let n = await idxRanges();
  let max = n;
  while (Date.now() - t0 < seconds * 1000) {
    await new Promise((r) => setTimeout(r, 3000));
    n = await idxRanges();
    max = Math.max(max, n);
  }
  console.log(`### ${label}: idx_ranges settled=${n} max_seen=${max}`);
  return max;
}

async function main() {
  await query(`DELETE FROM agent_memory`);
  const TOTAL = 40000;
  const clusters = Math.max(8, Math.round(TOTAL / 200));
  const centroids = Array.from({ length: clusters }, (_, c) => unitGaussianVector(7000 + c, DIM));
  console.log(`Building ${TOTAL} vectors…`);
  const vecs = buildVecs(TOTAL, 3_000_000, clusters, centroids);

  for (const milestone of [10000, 20000, 30000, 40000]) {
    const from = (await query<{ n: string }>(`SELECT count(*) AS n FROM agent_memory`))[0].n;
    await insertRange(vecs, Number(from), milestone);
    await pollRanges(`after ${milestone} rows`);
  }

  // Unscoped EXPLAIN (should plan vector search) + WITH DETAILS shape.
  const q = toVectorLiteral(vecs[0]);
  const plan = await query<{ info: string }>(`EXPLAIN SELECT id FROM agent_memory ORDER BY embedding <=> '${q}'::VECTOR LIMIT 10`);
  console.log("EXPLAIN (unscoped):");
  for (const p of plan) console.log("  " + p.info);
  const detail = await query(`SELECT range_id, lease_holder, replicas FROM [SHOW RANGES FROM INDEX ${IDX} WITH DETAILS] ORDER BY range_id`);
  console.log("RANGES WITH DETAILS: " + JSON.stringify(detail));

  await query(`DELETE FROM agent_memory`);
  await closePool();
}

main().catch((e) => { console.error("sizeprobe crashed:", e); process.exit(0); });
