// Embedding provider for agent memory.
//
// Production path: AWS Bedrock Titan Text Embeddings V2 (`amazon.titan-embed-
// text-v2:0`) → 1024-dim vectors, matching the VECTOR(1024) memory column.
// Runs on the same AWS account + SDK the H0 Archon build already uses.
//
// Everything is INJECTABLE via the `Embedder` interface so the memory layer,
// the demo script, and unit tests can run with NO AWS credentials against a
// deterministic local fake. Same contract, same dimensionality.

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  type InvokeModelCommandOutput,
} from "@aws-sdk/client-bedrock-runtime";

export const EMBED_DIM = Number(process.env.EMBED_DIM ?? 1024);
export const DEFAULT_EMBED_MODEL =
  process.env.BEDROCK_EMBED_MODEL_ID || "amazon.titan-embed-text-v2:0";
const EMBED_REGION =
  process.env.BEDROCK_REGION || process.env.AWS_REGION || "eu-west-1";

export interface Embedder {
  readonly modelId: string;
  readonly dim: number;
  embed(text: string): Promise<number[]>;
}

// Minimal surface the Bedrock embedder needs — the real client satisfies it, a
// one-line fake satisfies it in tests.
export interface InvokeClientLike {
  send(command: InvokeModelCommand): Promise<InvokeModelCommandOutput>;
}

export function createBedrockInvokeClient(region: string = EMBED_REGION): InvokeClientLike {
  return new BedrockRuntimeClient({ region });
}

// Bedrock Titan V2 embedder. `normalize: true` asks Titan for unit-length
// vectors, which is what cosine distance expects.
export class BedrockEmbedder implements Embedder {
  readonly modelId: string;
  readonly dim: number;
  constructor(
    private client: InvokeClientLike = createBedrockInvokeClient(),
    modelId: string = DEFAULT_EMBED_MODEL,
    dim: number = EMBED_DIM
  ) {
    this.modelId = modelId;
    this.dim = dim;
  }

  async embed(text: string): Promise<number[]> {
    const body = JSON.stringify({
      inputText: text,
      dimensions: this.dim,
      normalize: true,
    });
    const out = await this.client.send(
      new InvokeModelCommand({
        modelId: this.modelId,
        contentType: "application/json",
        accept: "application/json",
        body,
      })
    );
    const parsed = JSON.parse(new TextDecoder().decode(out.body));
    const vec = parsed.embedding as number[];
    if (!Array.isArray(vec) || vec.length !== this.dim) {
      throw new Error(
        `Titan returned ${vec?.length ?? "no"} dims, expected ${this.dim}`
      );
    }
    return vec;
  }
}

// Deterministic, dependency-free embedder for AWS-free dev + CI. Hashes tokens
// into a bag-of-words vector and L2-normalizes it, so semantically overlapping
// text lands in a similar direction under cosine distance. NOT for production
// recall quality — it exists so the full memory round trip runs offline.
export class FakeEmbedder implements Embedder {
  readonly modelId = "fake-hash-embedder";
  readonly dim: number;
  constructor(dim: number = EMBED_DIM) {
    this.dim = dim;
  }

  async embed(text: string): Promise<number[]> {
    const v = new Array<number>(this.dim).fill(0);
    const tokens = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    for (const tok of tokens) {
      let h = 2166136261;
      for (let i = 0; i < tok.length; i++) {
        h ^= tok.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      const idx = Math.abs(h) % this.dim;
      v[idx] += 1;
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  }
}

// Deterministic DENSE unit-vector embedder for benchmarking the vector index.
//
// Unlike FakeEmbedder (a sparse hashed bag-of-words with ~15 non-zero dims, where
// most unrelated strings collapse to an exact cosine tie of 1.0 — fine for a smoke
// test, useless for recall@k), this produces a *dense* vector: every component is
// an independent N(0,1) draw from a text-seeded PRNG, then L2-normalized. The
// distance distribution is smooth, so the true top-k is well defined and recall@k
// is a meaningful number. Deterministic in `text`, so the benchmark can recompute
// the exact ground-truth neighbours in JS and compare them to the index's ANN
// results. Not for production recall quality — it carries no semantics; it exists
// purely to stress and measure the CockroachDB distributed vector index.
export class RandomEmbedder implements Embedder {
  readonly modelId = "random-unit-embedder";
  readonly dim: number;
  constructor(dim: number = EMBED_DIM) {
    this.dim = dim;
  }

  async embed(text: string): Promise<number[]> {
    return unitGaussianVector(fnv1a(text), this.dim);
  }
}

// FNV-1a 32-bit string hash → PRNG seed. Deterministic and dependency-free.
export function fnv1a(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Small, fast, deterministic PRNG (mulberry32) — good enough to spray N(0,1) draws
// for benchmark vectors; not cryptographic and not used for anything security-facing.
export function mulberry32(a: number): () => number {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A deterministic L2-normalized vector of independent N(0,1) draws (Box-Muller),
// seeded by `seed`. Reused by RandomEmbedder and by the benchmark's clustered
// corpus generator. Uniform on the unit hypersphere.
export function unitGaussianVector(seed: number, dim: number): number[] {
  const rand = mulberry32(seed >>> 0);
  const v = new Array<number>(dim);
  for (let i = 0; i < dim; i++) {
    const u1 = Math.max(rand(), 1e-12);
    const u2 = rand();
    v[i] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
  return normalize(v);
}

// L2-normalize in place-style (returns a new array). Cosine distance assumes unit vectors.
export function normalize(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

// Pick the provider by environment: real Bedrock when AWS creds are present,
// the deterministic fake otherwise. Callers can always inject their own.
export function defaultEmbedder(): Embedder {
  const hasAws =
    Boolean(process.env.AWS_ACCESS_KEY_ID) || Boolean(process.env.AWS_PROFILE);
  return hasAws ? new BedrockEmbedder() : new FakeEmbedder();
}
