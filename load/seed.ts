// Seed a deterministic corpus for the k6 load test (load/recall.js).
//
// Writes LOAD_N memories into CockroachDB with the offline FakeEmbedder (no AWS).
// Each memory's content is UNIQUE and deterministic, so the load script can pose a
// question that is the EXACT text of a seeded memory: under the FakeEmbedder that
// yields an identical vector (cosine distance 0), making recall@1 deterministic —
// the top hit MUST be that exact memory. That lets k6 assert BOTH latency (p95)
// AND recall correctness under concurrency.
//
//   LOAD_N=2000 DATABASE_URL=… npm run load:seed

import { remember } from "../src/memory/memory.js";
import { FakeEmbedder } from "../src/memory/embeddings.js";
import { query, closePool } from "../src/db/client.js";

export const LOAD_COMPANY = "LoadCorp";
export const LOAD_N = Number(process.env.LOAD_N ?? 2000);

// The exact content string for record i — must match load/recall.js::memoryText.
export function memoryText(i: number): string {
  return `Load-test memory ${i}: unique-token load${i}tok covering topic ${i % 11} for LoadCorp.`;
}

async function main() {
  const emb = new FakeEmbedder();
  await query(`DELETE FROM agent_memory WHERE company = $1`, [LOAD_COMPANY]);
  const BATCH = 200;
  for (let start = 0; start < LOAD_N; start += BATCH) {
    const end = Math.min(start + BATCH, LOAD_N);
    await Promise.all(
      Array.from({ length: end - start }, (_, k) => {
        const i = start + k;
        return remember(emb, {
          kind: "insight",
          company: LOAD_COMPANY,
          period: "2026-07",
          sourceRef: `LOAD-${i}`,
          content: memoryText(i),
          metadata: { record: `LOAD-${i}`, i },
        });
      })
    );
  }
  console.log(`seeded ${LOAD_N} memories for ${LOAD_COMPANY}`);
  await closePool();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
