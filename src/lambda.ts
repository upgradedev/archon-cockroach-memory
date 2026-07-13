// AWS Lambda Function URL adapter for the public Archon Memory demo.
//
// The whole demo is one thing: ask a question, get an answer grounded in the
// agent's CockroachDB memory. This adapter just translates a Lambda Function URL
// request into a `handleRecall` call (the shared core in src/http/handler.ts) and
// back. On Lambda the execution role injects AWS creds, so defaultEmbedder/
// defaultNarrator select real Bedrock Titan + Claude; DATABASE_URL (a Lambda env
// var) points at CockroachDB Cloud. GET /?q=… or POST {"question":"…"} both work.

import { handleRecall, type RecallRequest } from "./http/handler.js";

// Minimal Lambda Function URL event/result shapes (only the fields we read), so we
// need no @types/aws-lambda dependency.
interface FunctionUrlEvent {
  requestContext?: { http?: { method?: string } };
  queryStringParameters?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
}
interface FunctionUrlResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export async function handler(event: FunctionUrlEvent): Promise<FunctionUrlResult> {
  const json = (status: number, body: unknown): FunctionUrlResult => ({
    statusCode: status,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  try {
    const method = event.requestContext?.http?.method ?? "GET";
    // Lightweight health probe so the URL is trivially checkable.
    if (method === "GET" && !event.queryStringParameters?.q && !event.queryStringParameters?.question) {
      return json(200, { service: "archon-cockroach-memory", ok: true, usage: "GET /?q=… or POST {question}" });
    }
    let req: RecallRequest;
    if (method === "POST" && event.body) {
      const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
      req = JSON.parse(raw) as RecallRequest;
    } else {
      const q = event.queryStringParameters ?? {};
      req = { question: q.q ?? q.question, company: q.company, kind: q.kind, limit: q.limit };
    }
    const { status, body } = await handleRecall(req);
    return json(status, body);
  } catch (err) {
    // Never leak an internal error (stack / connection string) to a public caller.
    console.error("recall handler error:", err);
    return json(500, { error: "internal error" });
  }
}
