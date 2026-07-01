// Unit tests that need NO database and NO AWS — they cover the pure pieces of
// the memory layer so `npm test` is green in CI. The live write/recall round
// trip is exercised by `npm run memory:demo` against a running CockroachDB.

import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeEmbedder, EMBED_DIM } from "../src/memory/embeddings.js";
import { toVectorLiteral } from "../src/db/client.js";

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // both vectors are L2-normalized, so dot == cosine similarity
}

test("FakeEmbedder produces vectors of the configured dimension", async () => {
  const e = new FakeEmbedder();
  const v = await e.embed("employer social security IKA");
  assert.equal(v.length, EMBED_DIM);
});

test("FakeEmbedder is deterministic", async () => {
  const e = new FakeEmbedder();
  const a = await e.embed("hidden payroll cost");
  const b = await e.embed("hidden payroll cost");
  assert.deepEqual(a, b);
});

test("FakeEmbedder output is L2-normalized (unit length)", async () => {
  const e = new FakeEmbedder();
  const v = await e.embed("Maria net pay gross employer cost");
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  assert.ok(Math.abs(norm - 1) < 1e-9, `norm was ${norm}`);
});

test("overlapping text is more similar than disjoint text", async () => {
  const e = new FakeEmbedder();
  const q = await e.embed("hidden employer payroll cost social security");
  const near = await e.embed("the hidden employer cost from social security");
  const far = await e.embed("quarterly sales invoice for office furniture");
  assert.ok(
    cosine(q, near) > cosine(q, far),
    `expected near (${cosine(q, near)}) > far (${cosine(q, far)})`
  );
});

test("toVectorLiteral renders the pgvector text form", () => {
  assert.equal(toVectorLiteral([0.1, 0.2, 0.3]), "[0.1,0.2,0.3]");
});
