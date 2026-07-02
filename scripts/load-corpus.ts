// Load N clustered unit vectors into agent_memory and LEAVE them in place — used
// by scripts/show-distribution.sh to give the distributed vector index enough data
// to split into multiple ranges across a multi-node cluster. Deterministic, offline
// (no AWS). Not destructive beyond the '_dist' company tag it manages.
//
//   LOAD_N=5000 npm run load:corpus

import { unitGaussianVector, normalize, EMBED_DIM } from "../src/memory/embeddings.js";
import { query, closePool, toVectorLiteral } from "../src/db/client.js";

const N = Number(process.env.LOAD_N ?? 5000);
const DIM = EMBED_DIM;
const CLUSTERS = Number(process.env.LOAD_CLUSTERS ?? Math.max(8, Math.round(N / 200)));
const NOISE = Number(process.env.LOAD_NOISE ?? 0.35);
const BATCH = 500;

async function main() {
  const centroids = Array.from({ length: CLUSTERS }, (_, c) => unitGaussianVector(7_000 + c, DIM));
  const vec = (i: number) => {
    const noise = unitGaussianVector(3_000_000 + i, DIM);
    return normalize(centroids[i % CLUSTERS].map((x, d) => x + NOISE * noise[d]));
  };

  await query(`DELETE FROM agent_memory WHERE company = '_dist'`);
  const t0 = performance.now();
  for (let start = 0; start < N; start += BATCH) {
    const end = Math.min(start + BATCH, N);
    const values: string[] = [];
    const params: unknown[] = [];
    for (let i = start; i < end; i++) {
      const b = params.length;
      params.push("insight", "_dist", null, String(i), `distribution corpus ${i}`, null, toVectorLiteral(vec(i)), "dist");
      values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7}::VECTOR,$${b + 8})`);
    }
    await query(
      `INSERT INTO agent_memory (kind, company, period, source_ref, content, metadata, embedding, embed_model)
       VALUES ${values.join(",")}`,
      params
    );
  }
  const rows = Number((await query<{ n: string }>(`SELECT count(*) AS n FROM agent_memory WHERE company='_dist'`))[0].n);
  console.log(`Loaded ${rows} '_dist' memories in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  await closePool();
}

main().catch((e) => {
  console.error("load-corpus failed:", e);
  process.exit(1);
});
