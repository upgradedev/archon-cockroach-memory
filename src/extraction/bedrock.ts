// Thin, injectable wrapper around AWS Bedrock's Converse API.
//
// The H0 submission story is "Vercel + AWS", and the app already depends on the
// AWS SDK (DynamoDB), so the real multimodal extraction layer talks to Claude
// through `@aws-sdk/client-bedrock-runtime` (ConverseCommand) rather than a
// first-party Anthropic client. That keeps the whole runtime on AWS.
//
// Everything here is INJECTABLE: `converse()` takes a client that only needs a
// `.send()` method, so unit tests pass a fake that returns a canned
// ConverseCommandOutput — no network, no credentials, no AWS in CI.

import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandInput,
  type ConverseCommandOutput,
  type ContentBlock,
} from "@aws-sdk/client-bedrock-runtime";

// `us.anthropic.claude-sonnet-4-6` is a cross-region inference profile.
// Verified invokable on account 308857099262 in us-west-2 (us-east-1 is gated
// behind the Anthropic use-case form on this account). Both overridable by env.
export const DEFAULT_MODEL_ID = process.env.BEDROCK_MODEL_ID || "us.anthropic.claude-sonnet-4-6";
export const DEFAULT_REGION =
  process.env.BEDROCK_REGION || process.env.AWS_REGION || "us-west-2";

// The only surface `converse()` needs from a Bedrock client. The real
// BedrockRuntimeClient satisfies it; so does a one-line test fake.
export interface ConverseClientLike {
  send(command: ConverseCommand): Promise<ConverseCommandOutput>;
}

// Content the model sees, before translation to Bedrock content blocks.
// Rasterized PDF pages and images go in as `image`; `document` is kept as a
// fallback for passing a PDF straight through.
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; format: "png" | "jpeg" | "gif" | "webp"; bytes: Uint8Array }
  | { type: "document"; format: "pdf"; name: string; bytes: Uint8Array };

export interface ConverseRequest {
  system: string;
  parts: ContentPart[];
  modelId?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface ConverseResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  modelId: string;
}

export function createBedrockClient(region: string = DEFAULT_REGION): ConverseClientLike {
  return new BedrockRuntimeClient({ region });
}

function toContentBlock(part: ContentPart): ContentBlock {
  switch (part.type) {
    case "text":
      return { text: part.text };
    case "image":
      return { image: { format: part.format, source: { bytes: part.bytes } } };
    case "document":
      return {
        document: { format: part.format, name: part.name, source: { bytes: part.bytes } },
      };
  }
}

// Exported so tests can assert the request was assembled correctly (system
// prompt placement, content-block order, inference config) without sending it.
export function buildConverseInput(req: ConverseRequest): ConverseCommandInput {
  return {
    modelId: req.modelId ?? DEFAULT_MODEL_ID,
    system: [{ text: req.system }],
    messages: [{ role: "user", content: req.parts.map(toContentBlock) }],
    inferenceConfig: {
      maxTokens: req.maxTokens ?? 2048,
      temperature: req.temperature ?? 0.1,
    },
  };
}

function extractText(out: ConverseCommandOutput): string {
  const blocks = out.output?.message?.content ?? [];
  return blocks
    .map((b) => ("text" in b && typeof b.text === "string" ? b.text : ""))
    .join("")
    .trim();
}

// Send one Converse turn and normalize the response. May throw on transport /
// throttling errors — callers that must never fail (extract.ts) wrap this.
export async function converse(
  client: ConverseClientLike,
  req: ConverseRequest
): Promise<ConverseResult> {
  const input = buildConverseInput(req);
  const out = await client.send(new ConverseCommand(input));
  return {
    text: extractText(out),
    inputTokens: out.usage?.inputTokens ?? 0,
    outputTokens: out.usage?.outputTokens ?? 0,
    modelId: input.modelId as string,
  };
}
