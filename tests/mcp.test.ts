// MCP round-trip test — an agent connects to the Archon Memory MCP server and
// exercises the memory tools over an in-process linked transport.
//
// This proves the CockroachDB-backed memory is a real, agent-callable MCP surface:
// a genuine MCP `Client` lists the tools and calls remember/recall/audit through the
// protocol (JSON-RPC over InMemoryTransport — deterministic, no subprocess), and the
// CockroachDB memory layer answers. Same DATABASE_URL gating as the rest of the suite:
// with no DATABASE_URL (a laptop, or `npm test` alone) it runs against the in-memory pg
// mock; in CI's build-test job — which sets DATABASE_URL to the live CockroachDB it
// stands up — the SAME round trip runs against the real distributed vector index. Either
// way it needs no AWS (the FakeEmbedder stands in for Bedrock Titan).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";

// Offline path: install the in-memory CockroachDB mock (sets a dummy DATABASE_URL)
// before anything touches the pool. Mirrors the rest of the suite's gating.
const REAL_DB = !!process.env.DATABASE_URL;
if (!REAL_DB) await import("./db_mock.js");

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMemoryMcpServer } from "../src/mcp/server.js";
import { FakeEmbedder } from "../src/memory/embeddings.js";
import { query, closePool } from "../src/db/client.js";

let client: Client;

before(async () => {
  await query(`DELETE FROM agent_memory`);

  // Build the server with the deterministic offline embedder and connect a real
  // MCP client to it through a linked in-memory transport pair.
  const server = createMemoryMcpServer(new FakeEmbedder());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test-agent", version: "0.0.1" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
});

after(async () => {
  await client.close();
  await closePool();
});

test("the memory MCP server advertises the recall/audit/remember tools", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["audit_memory", "recall_memory", "remember_memory"]);
  // recall + audit are advertised read-only; remember is a write.
  const recall = tools.find((t) => t.name === "recall_memory");
  assert.equal(recall?.annotations?.readOnlyHint, true);
});

test("an agent can remember → recall a fact through MCP", async () => {
  const wrote = await client.callTool({
    name: "remember_memory",
    arguments: {
      kind: "insight",
      content:
        "Off-bank employment cost at Acme for 2026-03: the bank transfer understates true " +
        "employer cost by ~35% — the employer social-security wedge.",
      company: "Acme",
      period: "2026-03",
      metadata: { importance: 0.9 },
    },
  });
  const wroteStruct = wrote.structuredContent as { id?: string } | undefined;
  assert.ok(wroteStruct?.id, "remember_memory returned a memory id");

  const recalled = await client.callTool({
    name: "recall_memory",
    arguments: { question: "employer social-security wedge", company: "Acme", limit: 5 },
  });
  const recStruct = recalled.structuredContent as
    | { count: number; hits: Array<{ content: string }> }
    | undefined;
  assert.ok(recStruct && recStruct.count >= 1, "recall_memory returned at least one hit");
  assert.match(recStruct!.hits[0]!.content, /employer social-security/i);
  // The human-readable content block is populated too.
  const first = recalled.content as Array<{ type: string; text: string }>;
  assert.equal(first[0]!.type, "text");
  assert.match(first[0]!.text, /Acme/);
});

test("an agent can audit memory for a cross-session contradiction through MCP", async () => {
  // Two writes give the same invoice different totals; the important (earlier) one
  // should be the recommended value.
  await client.callTool({
    name: "remember_memory",
    arguments: {
      kind: "document",
      content: "Invoice INV-9001 for Acme totalled €12,000 (confirmed).",
      company: "Acme",
      period: "2026-03",
      sourceRef: "INV-9001",
      metadata: { record: "INV-9001", total: 12000, importance: 0.9 },
    },
  });
  await client.callTool({
    name: "remember_memory",
    arguments: {
      kind: "document",
      content: "Invoice INV-9001 for Acme totalled €12,500 (later note).",
      company: "Acme",
      period: "2026-03",
      sourceRef: "INV-9001",
      metadata: { record: "INV-9001", total: 12500 },
    },
  });

  const audited = await client.callTool({
    name: "audit_memory",
    arguments: { company: "Acme" },
  });
  const report = audited.structuredContent as
    | {
        ok: boolean;
        contradictions: Array<{
          subject: string;
          attribute: string;
          resolution: { recommendedValue: unknown; rule: string };
        }>;
      }
    | undefined;
  assert.ok(report, "audit_memory returned a structured report");
  assert.equal(report!.ok, false, "a contradiction should be found");
  const c = report!.contradictions.find((x) => x.subject === "INV-9001");
  assert.ok(c, "the INV-9001 contradiction is flagged");
  assert.equal(c!.attribute, "total");
  assert.equal(c!.resolution.recommendedValue, 12000);
  assert.equal(c!.resolution.rule, "importance");
});
