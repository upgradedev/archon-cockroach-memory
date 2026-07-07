// Unit tests that need NO database and NO AWS — they cover the pure pieces of
// the memory layer so `npm test` is green in CI. The live write/recall round
// trip is exercised by `npm run memory:demo` against a running CockroachDB.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FakeEmbedder,
  RandomEmbedder,
  EMBED_DIM,
  unitGaussianVector,
  normalize,
} from "../src/memory/embeddings.js";
import { toVectorLiteral } from "../src/db/client.js";

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // both vectors are L2-normalized, so dot == cosine similarity
}

test("FakeEmbedder produces vectors of the configured dimension", async () => {
  const e = new FakeEmbedder();
  const v = await e.embed("employer social-security contribution");
  assert.equal(v.length, EMBED_DIM);
});

test("FakeEmbedder is deterministic", async () => {
  const e = new FakeEmbedder();
  const a = await e.embed("off-bank employment cost");
  const b = await e.embed("off-bank employment cost");
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
  const q = await e.embed("off-bank employer payroll cost social security");
  const near = await e.embed("the off-bank employer cost from social security");
  const far = await e.embed("quarterly sales invoice for office furniture");
  assert.ok(
    cosine(q, near) > cosine(q, far),
    `expected near (${cosine(q, near)}) > far (${cosine(q, far)})`
  );
});

test("toVectorLiteral renders the pgvector text form", () => {
  assert.equal(toVectorLiteral([0.1, 0.2, 0.3]), "[0.1,0.2,0.3]");
});

// ── benchmark vector helpers (RandomEmbedder + clustered corpus generator) ──────

test("unitGaussianVector is deterministic in its seed and unit length", () => {
  const a = unitGaussianVector(42, 256);
  const b = unitGaussianVector(42, 256);
  const c = unitGaussianVector(43, 256);
  assert.deepEqual(a, b, "same seed must give the same vector (ground truth relies on this)");
  assert.notDeepEqual(a, c, "different seed must give a different vector");
  const norm = Math.sqrt(a.reduce((s, x) => s + x * x, 0));
  assert.ok(Math.abs(norm - 1) < 1e-9, `expected unit length, got ${norm}`);
});

test("RandomEmbedder yields dense, well-separated unit vectors (valid recall@k)", async () => {
  const e = new RandomEmbedder(512);
  const v = await e.embed("bench-mem-1");
  assert.equal(v.length, 512);
  // Dense: essentially every component is non-zero (unlike the sparse FakeEmbedder),
  // which is what makes the top-k well defined rather than a mass of exact ties.
  assert.ok(v.filter((x) => x !== 0).length > 500);
  // Two distinct texts are NOT near-duplicates and NOT tied at cosine 1.
  const a = await e.embed("bench-mem-1");
  const b = await e.embed("bench-mem-2");
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  assert.ok(Math.abs(dot) < 0.9, `unrelated vectors should not be near-identical (dot=${dot})`);
});

test("normalize returns a unit vector", () => {
  const v = normalize([3, 4]);
  assert.ok(Math.abs(Math.sqrt(v[0] * v[0] + v[1] * v[1]) - 1) < 1e-12);
  assert.ok(Math.abs(v[0] - 0.6) < 1e-12 && Math.abs(v[1] - 0.8) < 1e-12);
});
