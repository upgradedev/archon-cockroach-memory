// Plain node:http server around the shared recall core (src/http/handler.ts).
//
// This is the k6 load-test target (load/recall.js) and a zero-dependency local
// dev server. It is the SAME `handleRecall` the AWS Lambda uses, so the load test
// exercises the real recall→narrate path against CockroachDB. In CI it runs with
// no AWS creds, so the env auto-selects FakeEmbedder + FakeNarrator (the recall
// vector query still hits the real CockroachDB the CI job stands up).
//
//   PORT=8787 DATABASE_URL=… npm run serve
//   GET  /health
//   POST /recall   {"question":"…","limit":5}

import { createServer } from "node:http";
import {
  handleAudit,
  handleHealth,
  handleProof,
  handleRecall,
  type AuditRequest,
  type RecallRequest,
} from "./handler.js";
import { closePool } from "../db/client.js";

const PORT = Number(process.env.PORT ?? 8787);

async function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > 4 * 1024) throw new Error("payload too large"); // match Lambda bound
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const server = createServer(async (req, res) => {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(JSON.stringify(body));
  };
  try {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    const pathname = url.pathname.startsWith("/api/")
      ? url.pathname.slice(4)
      : url.pathname;
    if (pathname === "/health" && req.method === "GET") {
      const result = handleHealth();
      return send(result.status, result.body);
    }
    if (pathname === "/audit" && req.method === "GET") {
      const raw: AuditRequest = {
        company: url.searchParams.get("company") ?? undefined,
        period: url.searchParams.get("period") ?? undefined,
        kind: url.searchParams.get("kind") ?? undefined,
        limit: url.searchParams.get("limit") ?? undefined,
      };
      const result = await handleAudit(raw);
      return send(result.status, result.body);
    }
    if (pathname === "/proof" && req.method === "GET") {
      const result = await handleProof();
      return send(result.status, result.body);
    }
    if (pathname !== "/recall") return send(404, { error: "not found" });
    if (req.method !== "POST") {
      return send(405, { error: "method not allowed" });
    }

    if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      return send(415, { error: "content-type must be application/json" });
    }
    const text = await readBody(req);
    const raw: RecallRequest = text ? (JSON.parse(text) as RecallRequest) : {};
    const { status, body } = await handleRecall(raw);
    send(status, body);
  } catch (err) {
    console.error("server request failed", {
      errorType: err instanceof Error ? err.name : "UnknownError",
    });
    send(400, { error: "bad request" });
  }
});

server.listen(PORT, () => console.log(`archon recall server listening on :${PORT}`));

async function shutdown() {
  server.close();
  await closePool();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
