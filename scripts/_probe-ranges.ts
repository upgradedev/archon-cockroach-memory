// TEMPORARY probe round 2 (to be removed before PR). Goal: find a DETERMINISTIC
// way to force the vector index into >=2 KV ranges at CI scale, and confirm timing.

import { unitGaussianVector, normalize, EMBED_DIM } from "../src/memory/embeddings.js";
import { query, closePool, toVectorLiteral } from "../src/db/client.js";

const DIM = EMBED_DIM;

async function tryQ(label: string, sql: string) {
  try {
    const rows = await query(sql);
    console.log(`### ${label} OK — ${rows.length} row(s) :: ${JSON.stringify(rows).slice(0, 300)}`);
    return rows;
  } catch (e) {
    console.log(`### ${label} FAILED: ${(e as Error).message}`);
    return null;
  }
}

async function idxRanges(): Promise<number> {
  const rows = await query<{ n: string }>(
    `SELECT count(*) AS n FROM [SHOW RANGES FROM INDEX agent_memory@idx_agent_memory_embedding]`
  );
  return Number(rows[0].n);
}

async function loadN(n: number, tag: string) {
  const CLUSTERS = Math.max(8, Math.round(n / 200));
  const centroids = Array.from({ length: CLUSTERS }, (_, c) => unitGaussianVector(7_000 + c, DIM));
  const vec = (i: number) => {
    const noise = unitGaussianVector(3_000_000 + i, DIM);
    return normalize(centroids[i % CLUSTERS].map((x, d) => x + 0.35 * noise[d]));
  };
  const BATCH = 500;
  for (let start = 0; start < n; start += BATCH) {
    const end = Math.min(start + BATCH, n);
    const values: string[] = [];
    const params: unknown[] = [];
    for (let i = start; i < end; i++) {
      const b = params.length;
      params.push("insight", tag, null, String(i), `probe ${i}`, null, toVectorLiteral(vec(i)), "probe");
      values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7}::VECTOR,$${b + 8})`);
    }
    await query(
      `INSERT INTO agent_memory (kind, company, period, source_ref, content, metadata, embedding, embed_model)
       VALUES ${values.join(",")}`,
      params
    );
  }
}

async function main() {
  await query(`DELETE FROM agent_memory`);

  // A) Manual vector SPLIT AT on an EMPTY index — the deterministic lever.
  console.log("\n===== A: manual vector SPLIT AT (deterministic forcing) =====");
  const splitVec1 = toVectorLiteral(normalize(unitGaussianVector(111, DIM)));
  const splitVec2 = toVectorLiteral(normalize(unitGaussianVector(222, DIM)));
  await tryQ(
    "SPLIT AT single vector",
    `ALTER INDEX agent_memory@idx_agent_memory_embedding SPLIT AT VALUES ('${splitVec1}'::VECTOR)`
  );
  console.log(`idx ranges after 1 split (empty table): ${await idxRanges().catch(() => -1)}`);
  await tryQ(
    "SPLIT AT second vector",
    `ALTER INDEX agent_memory@idx_agent_memory_embedding SPLIT AT VALUES ('${splitVec2}'::VECTOR)`
  );
  console.log(`idx ranges after 2 splits (empty table): ${await idxRanges().catch(() => -1)}`);

  // B) Does the split survive after we load data + does recall still work?
  console.log("\n===== B: load 2000 rows over the split index, recheck =====");
  await loadN(2000, "_probe");
  console.log(`idx ranges after load: ${await idxRanges().catch(() => -1)}`);

  // C) Fallback path — natural split by data volume. Poll timing.
  console.log("\n===== C: reset, load 10000, POLL idx ranges over 30s =====");
  await query(`DELETE FROM agent_memory`);
  // reset any manual splits
  await tryQ("UNSPLIT ALL", `ALTER INDEX agent_memory@idx_agent_memory_embedding UNSPLIT ALL`);
  await loadN(10000, "_probe");
  for (let t = 0; t < 16; t++) {
    const n = await idxRanges().catch(() => -1);
    console.log(`  t=${t * 2}s idx_ranges=${n}`);
    if (n >= 2 && t >= 2) break;
    await new Promise((r) => setTimeout(r, 2000));
  }

  await query(`DELETE FROM agent_memory`);
  await tryQ("UNSPLIT ALL (cleanup)", `ALTER INDEX agent_memory@idx_agent_memory_embedding UNSPLIT ALL`);
  await closePool();
}

main().catch((e) => {
  console.error("probe crashed:", e);
  process.exit(0);
});
