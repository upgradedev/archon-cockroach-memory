// AWS Lambda HTTP API adapter for the public Archon Memory demo.
//
// The whole demo is one thing: ask a question, get an answer grounded in the
// agent's CockroachDB memory. This adapter translates an API Gateway HTTP API
// request into a `handleRecall` call (the shared core in src/http/handler.ts) and
// back. On Lambda the execution role injects AWS creds, so defaultEmbedder/
// defaultNarrator select real Bedrock Titan + Claude; a Lambda environment
// secret points DATABASE_URL at CockroachDB Cloud. Recall accepts JSON POST so
// financial questions never leak into URLs, browser history, or access logs.

import { createHash, timingSafeEqual } from "node:crypto";
import {
  handleAudit,
  handleHealth,
  handleProof,
  handleRecall,
  type AuditRequest,
} from "./http/handler.js";
import {
  handleCreateResolutionSession,
  handleGetResolutionSession,
  handleResolutionDecision,
} from "./http/resolution-handler.js";
import {
  handleSandboxAudit,
  handleSandboxIngest,
  handleSandboxRecall,
} from "./http/sandbox-handler.js";
import type { MemoryAgent } from "./agents/memory-agent.js";
import type { Narrator } from "./agents/narrator.js";
import type { Embedder } from "./memory/embeddings.js";
import type { ResolutionStore } from "./memory/resolution.js";

// Minimal API Gateway HTTP API v2 event/result shapes (only the fields we read),
// so we need no @types/aws-lambda dependency.
interface HttpApiEvent {
  requestContext?: {
    stage?: string;
    http?: { method?: string };
  };
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

function originCapabilityMatches(provided: string | undefined): boolean {
  const expected = process.env.ORIGIN_VERIFY_TOKEN?.trim() ?? "";
  const environment = process.env.APP_ENV?.trim();
  if (!expected) {
    // A missing deployment secret is configuration drift, not permission to
    // expose the execute-api origin. Only explicit local/test runtimes may run
    // without the CloudFront-to-origin capability.
    return environment !== "staging" && environment !== "production";
  }
  if (!/^[A-Za-z0-9_-]{43,128}$/u.test(expected) || !provided) {
    return false;
  }
  const expectedDigest = createHash("sha256")
    .update(expected, "utf8")
    .digest();
  const providedDigest = createHash("sha256")
    .update(provided, "utf8")
    .digest();
  return timingSafeEqual(expectedDigest, providedDigest);
}

export function createHandler(
  dependencies: {
    agent?: MemoryAgent;
    resolutionStore?: ResolutionStore;
    sandboxEmbedder?: Embedder;
    sandboxNarrator?: Narrator;
  } = {}
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
      const stage = event.requestContext?.stage;
      // Execute-api URLs for a named HTTP API stage can expose that trusted
      // stage prefix in rawPath. Strip only the exact request-context stage;
      // never treat an arbitrary first path segment as a routing prefix.
      const stagePrefix =
        stage && stage !== "$default" ? `/${stage}` : "";
      const routePath =
        stagePrefix &&
        (rawPath === stagePrefix ||
          rawPath.startsWith(`${stagePrefix}/`))
          ? rawPath.slice(stagePrefix.length) || "/"
          : rawPath;
      const pathname = routePath.startsWith("/api/")
        ? routePath.slice(4)
        : routePath;
      const query = event.queryStringParameters ?? {};
      const header = (name: string): string | undefined =>
        Object.entries(event.headers ?? {}).find(
          ([key]) => key.toLowerCase() === name.toLowerCase()
        )?.[1];
      if (!originCapabilityMatches(header("x-archon-origin-verify"))) {
        return json(403, { error: "forbidden" });
      }
      if (method === "GET" && pathname === "/") {
        const result = await handleHealth();
        return json(result.status, result.body);
      }
      if (method === "GET" && pathname === "/health") {
        const result = await handleHealth();
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
      if (method === "GET" && pathname === "/resolution/session") {
        const result = await handleGetResolutionSession(
          header("authorization"),
          dependencies.resolutionStore
        );
        return json(result.status, result.body);
      }
      const postPaths = new Set([
        "/recall",
        "/resolution/session",
        "/resolution/decision",
        "/sandbox/ingest",
        "/sandbox/recall",
        "/sandbox/audit",
      ]);
      if (!postPaths.has(pathname)) {
        return json(404, { error: "not found" });
      }
      if (method !== "POST") {
        return json(405, { error: "method not allowed" });
      }

      const contentType = header("content-type") ?? "";
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
      if (pathname === "/sandbox/ingest") {
        const result = dependencies.sandboxEmbedder
          ? await handleSandboxIngest(req, dependencies.sandboxEmbedder)
          : await handleSandboxIngest(req);
        return json(result.status, result.body);
      }
      if (pathname === "/sandbox/recall") {
        const result =
          dependencies.sandboxEmbedder && dependencies.sandboxNarrator
            ? await handleSandboxRecall(
                req,
                dependencies.sandboxEmbedder,
                dependencies.sandboxNarrator
              )
            : await handleSandboxRecall(req);
        return json(result.status, result.body);
      }
      if (pathname === "/sandbox/audit") {
        const result = await handleSandboxAudit(req);
        return json(result.status, result.body);
      }
      if (pathname === "/resolution/session") {
        const result = await handleCreateResolutionSession(
          req,
          dependencies.resolutionStore
        );
        return json(result.status, result.body);
      }
      if (pathname === "/resolution/decision") {
        const result = await handleResolutionDecision(
          header("authorization"),
          req,
          dependencies.resolutionStore
        );
        return json(result.status, result.body);
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
