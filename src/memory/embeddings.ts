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
  process.env.BEDROCK_REGION || process.env.AWS_REGION || "us-west-2";

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

// Pick the provider by environment: real Bedrock when AWS creds are present,
// the deterministic fake otherwise. Callers can always inject their own.
export function defaultEmbedder(): Embedder {
  const hasAws =
    Boolean(process.env.AWS_ACCESS_KEY_ID) || Boolean(process.env.AWS_PROFILE);
  return hasAws ? new BedrockEmbedder() : new FakeEmbedder();
}
