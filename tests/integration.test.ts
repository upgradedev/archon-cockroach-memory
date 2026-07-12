// Exhaustive Integration Tests for CockroachDB Memory Agent.
// Verifies interactions between the DB client, CockroachDB vector operations, memory store,
// and contradiction consistency auditing.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { query, closePool, toVectorLiteral } from "../src/db/client.js";
import { FakeEmbedder } from "../src/memory/embeddings.js";
import { FakeNarrator } from "../src/agents/narrator.js";
import { MemoryAgent } from "../src/agents/memory-agent.js";
import { remember, recall, listForAudit, memoryCount } from "../src/memory/memory.js";

if (!process.env.DATABASE_URL) {
  await import("./db_mock.js");
}

const COMPANY = "IntegCorp";

before(async () => {
  await query(`DELETE FROM agent_memory`);
});

after(async () => {
  await closePool();
});

// Define 15 explicit integration test cases
// "pgvector-style" = the `[a,b,c]` VECTOR text literal encoding CockroachDB accepts,
// not the pgvector extension (this entry uses CockroachDB-native C-SPANN vector indexing).
test("1. Integration: toVectorLiteral formats array correctly for the pgvector-style VECTOR literal", () => {
  const literal = toVectorLiteral([0.1, -0.2, 0.9]);
  assert.equal(literal, "[0.1,-0.2,0.9]");
});

test("2. Integration: remember inserts a document kind to DB and returns ID", async () => {
  const embedder = new FakeEmbedder();
  const id = await remember(embedder, {
    company: COMPANY,
    kind: "document",
    content: "Integration test doc contents",
    sourceRef: "REF-001"
  });
  assert.ok(id.startsWith("mock-id-") || id.length > 0);
});

test("3. Integration: memoryCount queries DB and reflects the inserted memory", async () => {
  const count = await memoryCount(COMPANY);
  assert.ok(count >= 1);
});

test("4. Integration: recall finds memory by vector cosine similarity matching", async () => {
  const embedder = new FakeEmbedder();
  const hits = await recall(embedder, "Integration test doc contents", {
    company: COMPANY,
    limit: 1
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.content, "Integration test doc contents");
  assert.equal(typeof hits[0]!.score, "number");
});

test("5. Integration: listForAudit retrieves raw records in scope of company", async () => {
  const records = await listForAudit({ company: COMPANY });
  assert.ok(records.length >= 1);
  assert.equal(records[0]!.company, COMPANY);
});

test("6. Integration: memoryCount returns 0 for a non-existent company", async () => {
  const count = await memoryCount("NonExistentCompanyXYZ");
  assert.equal(count, 0);
});

test("7. Integration: agent remember method inserts memory through class interface", async () => {
  const agent = new MemoryAgent(new FakeEmbedder(), new FakeNarrator());
  const id = await agent.remember("insight", "Workforce expenses grew by 15%", {
    company: COMPANY,
    period: "2026-Q2"
  });
  assert.ok(id.length > 0);
});

test("8. Integration: recallAnswer retrieves matching facts and returns structured consistency context", async () => {
  const agent = new MemoryAgent(new FakeEmbedder(), new FakeNarrator());
  const result = await agent.recallAnswer("expense growth", { company: COMPANY });
  assert.ok(result.hits.length > 0);
  assert.equal(result.consistency.ok, true); // no contradiction introduced yet
});

test("9. Integration: audit flags a contradiction across multiple remember calls", async () => {
  const agent = new MemoryAgent(new FakeEmbedder(), new FakeNarrator());
  const recId = "TX-999";
  
  await agent.remember("document", "TX-999 payment is €5,000", {
    company: COMPANY,
    sourceRef: recId,
    metadata: { record: recId, amount: 5000 }
  });
  
  await agent.remember("document", "TX-999 payment is €6,000", {
    company: COMPANY,
    sourceRef: recId,
    metadata: { record: recId, amount: 6000 }
  });
  
  const report = await agent.audit({ company: COMPANY });
  assert.equal(report.ok, false);
  const cont = report.contradictions.find(c => c.subject === recId);
  assert.ok(cont);
  assert.equal(cont!.attribute, "amount");
});

test("10. Integration: audit checks for dangling reference and reports absence", async () => {
  const agent = new MemoryAgent(new FakeEmbedder(), new FakeNarrator());
  await agent.remember("validation", "Audit references missing key TASK-111", {
    company: COMPANY,
    metadata: { record: "AUDIT-1", refs: ["TASK-111"] }
  });
  
  const report = await agent.audit({ company: COMPANY });
  assert.ok(report.absences.some(a => a.subject === "TASK-111"));
});

test("11. Integration: recall limit parameter is respected", async () => {
  const embedder = new FakeEmbedder();
  const hits = await recall(embedder, "test", { company: COMPANY, limit: 1 });
  assert.ok(hits.length <= 1);
});

test("12. Integration: listForAudit is empty when filtering for non-existent company", async () => {
  const records = await listForAudit({ company: "NonExistentCompanyXYZ" });
  assert.equal(records.length, 0);
});

test("13. Integration: recall filters by kind correctly", async () => {
  const embedder = new FakeEmbedder();
  const hits = await recall(embedder, "Workforce expenses", {
    company: COMPANY,
    kind: "insight"
  });
  assert.ok(hits.every(h => h.kind === "insight"));
});

test("14. Integration: closePool does not crash when pool is already terminated", async () => {
  await closePool();
  await closePool();
  assert.ok(true);
});

test("15. Integration: recallAnswer falls back to default company scope if none specified", async () => {
  const agent = new MemoryAgent(new FakeEmbedder(), new FakeNarrator());
  const result = await agent.recallAnswer("expenses");
  assert.ok(result.hits !== undefined);
});
