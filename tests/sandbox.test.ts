// Unit tests for Sandboxed Judge Ingestion (Workstream W6)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

const REAL_DB = !!process.env.DATABASE_URL;
if (!REAL_DB) await import("./db_mock.js");

import { handleSandboxIngest, handleSandboxRecall } from "../src/http/sandbox-handler.ts";
import { FakeEmbedder } from "../src/memory/embeddings.js";
import { FakeNarrator } from "../src/agents/narrator.js";
import { MemoryAgent } from "../src/agents/memory-agent.js";
import { createHandler } from "../src/lambda.js";
import { closePool } from "../src/db/client.js";

after(async () => {
  await closePool();
});

test("Sandbox Ingest: validates request body shape", async () => {
  assert.equal((await handleSandboxIngest(null)).status, 400);
  assert.equal((await handleSandboxIngest({})).status, 400);
  assert.equal((await handleSandboxIngest({ fact: "short" })).status, 400);
});

test("Sandbox Ingest: ingests custom fact and returns session ID, memory ID and TTL info", async () => {
  const emb = new FakeEmbedder();
  const res = await handleSandboxIngest(
    {
      company: "Acme Legal Corp",
      fact: "Invoice INV-9901 for legal services was paid on 2026-08-01 for €45,000.",
      period: "2026-Q3",
      sourceRef: "DOC-9901",
    },
    emb
  );

  assert.equal(res.status, 201);
  assert.equal(res.body.ok, true);
  assert.ok(res.body.sandbox_session_id?.startsWith("sbox_"));
  assert.ok(res.body.memory_id);
  assert.equal(res.body.embedding_dim, 1024);
  assert.equal(res.body.ttl_seconds, 3600);
  assert.ok(res.body.expires_at);
});

test("Sandbox Recall: recalls custom ingested fact through Lambda handler", async () => {
  const emb = new FakeEmbedder();
  const narrator = new FakeNarrator();
  const agent = new MemoryAgent(emb, narrator);
  const handler = createHandler({ agent });

  const ingestRes = await handleSandboxIngest(
    {
      company: "Custom Test Corp",
      fact: "Custom Audit Fact: Acme acquired WidgetCo for €12,000,000 on 2026-07-15.",
      period: "2026-Q3",
      sourceRef: "M&A-DOC-01",
    },
    emb
  );
  assert.equal(ingestRes.status, 201);

  const lambdaRes = await handler({
    requestContext: { http: { method: "POST" } },
    rawPath: "/api/sandbox/recall",
    headers: {
      "content-type": "application/json",
      "x-archon-origin-verify": process.env.ORIGIN_VERIFY_TOKEN,
    },
    body: JSON.stringify({
      sandbox_session_id: ingestRes.body.sandbox_session_id,
      question: "What was the acquisition price of WidgetCo?",
    }),
  });

  assert.equal(lambdaRes.statusCode, 200);
  const body = JSON.parse(lambdaRes.body);
  assert.equal(body.ok, true);
  assert.ok(typeof body.answer === "string");
  assert.ok(body.grounding);
});
