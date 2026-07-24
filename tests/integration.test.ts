// Exhaustive Integration Tests for CockroachDB Memory Agent.
// Verifies interactions between the DB client, CockroachDB vector operations, memory store,
// and contradiction consistency auditing.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { query, closePool, toVectorLiteral } from "../src/db/client.js";
import { FakeEmbedder } from "../src/memory/embeddings.js";
import type { Embedder } from "../src/memory/embeddings.js";
import { FakeNarrator } from "../src/agents/narrator.js";
import { MemoryAgent } from "../src/agents/memory-agent.js";
import { remember, recall, listForAudit, memoryCount } from "../src/memory/memory.js";
import { handleProof } from "../src/http/handler.js";
import { EXPECTED_VECTOR_INDEX_NAME } from "../src/db/proof.js";

const REAL_DB = Boolean(process.env.DATABASE_URL);
if (!REAL_DB) {
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
  const records = await listForAudit(
    { company: COMPANY },
    new FakeEmbedder().modelId
  );
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
  const records = await listForAudit(
    { company: "NonExistentCompanyXYZ" },
    new FakeEmbedder().modelId
  );
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

class CountingEmbedder implements Embedder {
  readonly dim = 1024;
  calls = 0;

  constructor(
    readonly modelId: string,
    private readonly delegate = new FakeEmbedder()
  ) {}

  async embed(text: string): Promise<number[]> {
    this.calls++;
    return this.delegate.embed(text);
  }
}

test("16. Integration: identical remember retries are idempotent before re-embedding", async () => {
  const embedder = new CountingEmbedder("idempotency-model");
  const input = {
    kind: "insight" as const,
    company: "IdempotencyCorp",
    sourceRef: "EVT-IDEM-1",
    content: "Retry-safe durable fact.",
    metadata: { amount: 42, source: "verified" },
  };
  const first = await remember(embedder, input);
  const second = await remember(embedder, {
    ...input,
    // Canonical JSON means object insertion order cannot defeat deduplication.
    metadata: { source: "verified", amount: 42 },
  });
  assert.equal(second, first);
  assert.equal(embedder.calls, 1, "retry should not purchase a second embedding");
  assert.equal(await memoryCount("IdempotencyCorp"), 1);
});

test("17. Integration: reusing an explicit idempotency key for changed evidence fails closed", async () => {
  const embedder = new CountingEmbedder("explicit-key-model");
  await remember(embedder, {
    kind: "document",
    company: "ExplicitKeyCorp",
    content: "Invoice total is €10.",
    idempotencyKey: "invoice-10-v1",
  });
  await assert.rejects(
    remember(embedder, {
      kind: "document",
      company: "ExplicitKeyCorp",
      content: "Invoice total is €999.",
      idempotencyKey: "invoice-10-v1",
    }),
    /different immutable memory payload/iu
  );
});

test("18. Integration: recall never compares vectors from a different embedding model space", async () => {
  const modelA = new CountingEmbedder("model-space-a");
  const modelB = new CountingEmbedder("model-space-b");
  await remember(modelA, {
    kind: "insight",
    company: "ModelSpaceCorp",
    content: "MODEL-A evidence about payroll.",
  });
  await remember(modelB, {
    kind: "insight",
    company: "ModelSpaceCorp",
    content: "MODEL-B evidence about payroll.",
  });

  const hits = await recall(modelA, "payroll evidence", {
    company: "ModelSpaceCorp",
    limit: 10,
  });
  assert.equal(hits.length, 1);
  assert.match(hits[0]!.content, /MODEL-A/u);
});

test("19. Integration: exhaustive audit reads are still hard-bounded", async () => {
  const records = await listForAudit(
    { company: COMPANY, limit: 1 },
    new FakeEmbedder().modelId
  );
  assert.ok(records.length <= 1);
});

test(
  "20. Integration: live proof verifies the exact C-SPANN definition",
  { skip: !REAL_DB },
  async () => {
    const proof = await handleProof(
      new MemoryAgent(new FakeEmbedder(), new FakeNarrator())
    );
    assert.equal(proof.status, 200);
    const vector = proof.body.vectorIndex as Record<string, unknown>;
    const database = proof.body.database as Record<string, unknown>;
    assert.equal(vector.enabled, true);
    assert.equal(vector.name, EXPECTED_VECTOR_INDEX_NAME);
    assert.equal(
      vector.evidence,
      "live pg_catalog.pg_indexes definition"
    );
    assert.match(String(vector.definitionFingerprint), /^[a-f0-9]{64}$/u);
    assert.match(String(database.version), /CockroachDB/iu);
    assert.ok(String(database.runtimePrincipal).length > 0);
  }
);

test(
  "21. Integration: production-shaped scoped recall plans the exact vector index",
  { skip: !REAL_DB },
  async () => {
    const vector = await query<{ embedding: string }>(
      `SELECT embedding::STRING AS embedding
         FROM agent_memory
        WHERE company = $1
          AND embed_model = $2
        LIMIT 1`,
      [COMPANY, new FakeEmbedder().modelId]
    );
    assert.ok(vector[0]?.embedding);
    const planRows = await query<Record<string, unknown>>(
      `EXPLAIN SELECT id
         FROM agent_memory@${EXPECTED_VECTOR_INDEX_NAME}
        WHERE tenant_id = 'public-demo'
          AND embed_model = $2
          AND status = 'active'
          AND company = $3
        ORDER BY embedding <=> $1::VECTOR
        LIMIT 5`,
      [vector[0]!.embedding, new FakeEmbedder().modelId, COMPANY]
    );
    const plan = planRows
      .flatMap((row) => Object.values(row))
      .map(String)
      .join("\n");
    assert.match(plan, /vector search/iu);
    assert.match(plan, new RegExp(EXPECTED_VECTOR_INDEX_NAME, "u"));
  }
);

test("22. Integration: concurrent retries converge on one durable memory", async () => {
  const embedder = new CountingEmbedder("concurrent-idempotency-model");
  const input = {
    kind: "insight" as const,
    company: "ConcurrentIdempotencyCorp",
    content: "Concurrent delivery has one durable effect.",
    idempotencyKey: "concurrent-delivery-v1",
  };
  const ids = await Promise.all(
    Array.from({ length: 8 }, () => remember(embedder, input))
  );
  assert.equal(new Set(ids).size, 1);
  assert.equal(await memoryCount("ConcurrentIdempotencyCorp"), 1);
});

test(
  "23. Integration: retracted evidence is excluded from recall",
  { skip: !REAL_DB },
  async () => {
    const embedder = new FakeEmbedder();
    const id = await remember(embedder, {
      kind: "insight",
      company: "LifecycleCorp",
      content: "This evidence has been retracted.",
      idempotencyKey: "lifecycle-retracted-v1",
    });
    await query(
      "UPDATE agent_memory SET status = 'retracted' WHERE id = $1",
      [id]
    );
    const hits = await recall(embedder, "retracted evidence", {
      company: "LifecycleCorp",
      limit: 10,
    });
    assert.ok(hits.every((hit) => hit.id !== id));
  }
);

test("24. Integration: malformed embedding dimensions fail before SQL", async () => {
  const malformed: Embedder = {
    modelId: "malformed-dimension-model",
    dim: 1024,
    async embed() {
      return [1, 2];
    },
  };
  await assert.rejects(
    remember(malformed, {
      kind: "insight",
      company: "DimensionCorp",
      content: "This embedding shape is invalid.",
    }),
    /exactly 1024 finite dimensions/u
  );
});
