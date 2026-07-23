// AWS Lambda HTTP API adapter for the public Archon Memory demo.
//
// The whole demo is one thing: ask a question, get an answer grounded in the
// agent's CockroachDB memory. This adapter translates an API Gateway HTTP API
// request into a `handleRecall` call (the shared core in src/http/handler.ts) and
// back. On Lambda the execution role injects AWS creds, so defaultEmbedder/
// defaultNarrator select real Bedrock Titan + Claude; a Lambda environment
// secret points DATABASE_URL at CockroachDB Cloud. Recall accepts JSON POST so
// financial questions never leak into URLs, browser history, or access logs.

import {
  handleAudit,
  handleHealth,
  handleProof,
  handleRecall,
  type AuditRequest,
} from "./http/handler.js";
import type { MemoryAgent } from "./agents/memory-agent.js";

// Minimal API Gateway HTTP API v2 event/result shapes (only the fields we read),
// so we need no @types/aws-lambda dependency.
interface HttpApiEvent {
  requestContext?: { http?: { method?: string } };
  rawPath?: string;
  queryStringParameters?: Record<string, string | undefined>;
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
}
interface HttpApiResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export function createHandler(
  dependencies: { agent?: MemoryAgent } = {}
): (event: HttpApiEvent) => Promise<HttpApiResult> {
  return async (event: HttpApiEvent): Promise<HttpApiResult> => {
    const maxBodyBytes = 4 * 1024;
    const json = (status: number, body: unknown): HttpApiResult => ({
      statusCode: status,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "strict-transport-security": "max-age=31536000; includeSubDomains",
      },
      body: JSON.stringify(body),
    });

    try {
      const method = event.requestContext?.http?.method ?? "GET";
      const rawPath = event.rawPath ?? "/";
      const pathname = rawPath.startsWith("/api/")
        ? rawPath.slice(4)
        : rawPath;
      const query = event.queryStringParameters ?? {};
      if (method === "GET" && pathname === "/") {
        const result = handleHealth();
        return json(result.status, result.body);
      }
      if (method === "GET" && pathname === "/health") {
        const result = handleHealth();
        return json(result.status, result.body);
      }
      if (method === "GET" && pathname === "/audit") {
        const request: AuditRequest = {
          company: query.company,
          period: query.period,
          kind: query.kind,
          limit: query.limit,
        };
        const result = dependencies.agent
          ? await handleAudit(request, dependencies.agent)
          : await handleAudit(request);
        return json(result.status, result.body);
      }
      if (method === "GET" && pathname === "/proof") {
        const result = dependencies.agent
          ? await handleProof(dependencies.agent)
          : await handleProof();
        return json(result.status, result.body);
      }
      if (pathname !== "/recall") {
        return json(404, { error: "not found" });
      }
      if (method !== "POST") {
        return json(405, { error: "method not allowed" });
      }

      const contentType =
        event.headers?.["content-type"] ??
        event.headers?.["Content-Type"] ??
        "";
      if (!contentType.toLowerCase().startsWith("application/json")) {
        return json(415, { error: "content-type must be application/json" });
      }
      if (typeof event.body !== "string") {
        return json(400, { error: "JSON request body is required" });
      }
      const bodyBytes = event.isBase64Encoded
        ? Buffer.from(event.body, "base64")
        : Buffer.from(event.body, "utf8");
      if (bodyBytes.byteLength > maxBodyBytes) {
        return json(413, { error: "request body exceeds 4096 bytes" });
      }
      let req: unknown;
      try {
        req = JSON.parse(bodyBytes.toString("utf8")) as unknown;
      } catch {
        return json(400, { error: "request body must be valid JSON" });
      }
      const { status, body } = dependencies.agent
        ? await handleRecall(req, dependencies.agent)
        : await handleRecall(req);
      return json(status, body);
    } catch (err) {
      // Never leak an internal error (stack / connection string) publicly.
      console.error("request failed", {
        errorType: err instanceof Error ? err.name : "UnknownError",
      });
      // Re-throw a sanitized error so Lambda's native Errors metric and the SAM
      // canary alarm can stop or roll back a bad production deployment.
      throw new Error("request failed");
    }
  };
}

export const handler = createHandler();
