// TEMPORARY probe (to be removed before PR). Answers, in ONE CI run:
//   1. the real range_max_bytes floor CockroachDB accepts,
//   2. whether we can force the VECTOR INDEX into >1 KV range at CI corpus scale,
//   3. the exact output shape of SHOW RANGES FROM INDEX ... WITH DETAILS + EXPLAIN.
// Never fails the build — every step is wrapped so all findings print.

import { unitGaussianVector, normalize, EMBED_DIM } from "../src/memory/embeddings.js";
import { query, closePool, toVectorLiteral } from "../src/db/client.js";

const DIM = EMBED_DIM;

async function tryQ(label: string, sql: string, params: unknown[] = []) {
  try {
    const rows = await query(sql, params);
    console.log(`\n### ${label} OK — ${rows.length} row(s)`);
    console.log(JSON.stringify(rows, null, 2).slice(0, 4000));
    return rows;
  } catch (e) {
    console.log(`\n### ${label} FAILED: ${(e as Error).message}`);
    return null;
  }
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

async function rangeCounts() {
  await tryQ(
    "SHOW RANGES FROM TABLE agent_memory (count)",
    `SELECT count(*) AS n FROM [SHOW RANGES FROM TABLE agent_memory]`
  );
  await tryQ(
    "SHOW RANGES FROM INDEX @idx_agent_memory_embedding (count)",
    `SELECT count(*) AS n FROM [SHOW RANGES FROM INDEX agent_memory@idx_agent_memory_embedding]`
  );
  await tryQ(
    "SHOW RANGES FROM INDEX @idx (WITH DETAILS, shape sample)",
    `SELECT range_id, lease_holder, replicas FROM [SHOW RANGES FROM INDEX agent_memory@idx_agent_memory_embedding WITH DETAILS] ORDER BY range_id LIMIT 20`
  );
}

async function main() {
  await tryQ("version", `SELECT version() AS v`);
  await query(`DELETE FROM agent_memory`);

  // Baseline: how many ranges at CI benchmark scale, default zone.
  console.log("\n===== PHASE 1: 3000 rows, DEFAULT zone =====");
  await loadN(3000, "_probe");
  await rangeCounts();

  // Try to lower range_max_bytes. Sweep candidate floors to find the minimum accepted.
  console.log("\n===== PHASE 2: sweep range_max_bytes floor =====");
  for (const [minB, maxB] of [
    [1 << 20, 8 << 20],   // 1MiB / 8MiB
    [1 << 20, 2 << 20],   // 1MiB / 2MiB
    [65536, 1 << 20],     // 64KiB / 1MiB
    [65536, 131072],      // 64KiB / 128KiB
  ] as const) {
    await tryQ(
      `CONFIGURE ZONE range_min_bytes=${minB} range_max_bytes=${maxB}`,
      `ALTER TABLE agent_memory CONFIGURE ZONE USING range_min_bytes = ${minB}, range_max_bytes = ${maxB}`
    );
  }

  // With the smallest accepted zone applied, add more data + nudge a split, re-check.
  console.log("\n===== PHASE 3: reload 8000 rows under small zone, wait, re-check ranges =====");
  await query(`DELETE FROM agent_memory`);
  await loadN(8000, "_probe");
  await tryQ("ALTER TABLE ... SCATTER", `ALTER TABLE agent_memory SCATTER`);
  await new Promise((r) => setTimeout(r, 8000));
  await rangeCounts();

  // Does manual SPLIT AT work on the vector index? (size-independent forcing)
  console.log("\n===== PHASE 4: manual SPLIT AT on table + vector index =====");
  await tryQ(
    "ALTER TABLE agent_memory SPLIT AT (uuid)",
    `ALTER TABLE agent_memory SPLIT AT VALUES ('80000000-0000-0000-0000-000000000000'::UUID)`
  );
  await tryQ(
    "ALTER INDEX @idx SPLIT AT (probe if supported)",
    `ALTER INDEX agent_memory@idx_agent_memory_embedding SPLIT AT VALUES (1)`
  );
  await rangeCounts();

  // EXPLAIN shape (plain — used by the real test to string-match `vector search`).
  console.log("\n===== PHASE 5: EXPLAIN shape =====");
  const q = toVectorLiteral(normalize(unitGaussianVector(42, DIM)));
  await tryQ(
    "EXPLAIN recall",
    `EXPLAIN SELECT id FROM agent_memory ORDER BY embedding <=> '${q}'::VECTOR LIMIT 10`
  );

  await query(`DELETE FROM agent_memory`);
  await closePool();
}

main().catch((e) => {
  console.error("probe crashed:", e);
  process.exit(0); // never fail the build
});
