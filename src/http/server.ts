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
//   GET  /recall?q=…&company=…&limit=…
//   POST /recall   {"question":"…","company":"…","limit":5}

import { createServer } from "node:http";
import { handleRecall, type RecallRequest } from "./handler.js";
import { closePool } from "../db/client.js";

const PORT = Number(process.env.PORT ?? 8787);

async function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > 64 * 1024) throw new Error("payload too large"); // bound the read
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const server = createServer(async (req, res) => {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  try {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    if (url.pathname === "/health") return send(200, { ok: true, service: "archon-cockroach-memory" });
    if (url.pathname !== "/recall") return send(404, { error: "not found" });

    let raw: RecallRequest;
    if (req.method === "POST") {
      const text = await readBody(req);
      raw = text ? (JSON.parse(text) as RecallRequest) : {};
    } else {
      raw = {
        question: url.searchParams.get("q") ?? url.searchParams.get("question") ?? undefined,
        company: url.searchParams.get("company") ?? undefined,
        kind: url.searchParams.get("kind") ?? undefined,
        limit: url.searchParams.get("limit") ?? undefined,
      };
    }
    const { status, body } = await handleRecall(raw);
    send(status, body);
  } catch (err) {
    console.error("server error:", err);
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
