// Exhaustive Integration Tests for CockroachDB Memory Agent.
// Verifies interactions between the DB client, CockroachDB vector operations, memory store,
// and contradiction consistency auditing.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  query,
  closePool,
  toVectorLiteral,
  withClient,
} from "../src/db/client.js";
import { FakeEmbedder } from "../src/memory/embeddings.js";
import type { Embedder } from "../src/memory/embeddings.js";
import { FakeNarrator } from "../src/agents/narrator.js";
import { MemoryAgent } from "../src/agents/memory-agent.js";
import {
  buildRecallQuery,
  remember,
  recall,
  listForAudit,
  memoryCount,
  memoryStoreProof,
  type RecallQueryRow,
} from "../src/memory/memory.js";
import { handleProof } from "../src/http/handler.js";
import {
  EXPECTED_KIND_VECTOR_INDEX_NAME,
  EXPECTED_VECTOR_INDEX_NAME,
  PUBLIC_KIND_RECALL_VIEW_NAME,
  PUBLIC_RECALL_VIEW_NAME,
} from "../src/db/proof.js";

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

test("3b. Integration: store proof verifies durable idempotency and digest coverage", async () => {
  const proof = await memoryStoreProof(COMPANY, new FakeEmbedder().modelId);
  assert.ok(proof.persisted >= 1);
  assert.equal(proof.idempotencyKeys, proof.persisted);
  assert.equal(proof.contentDigests, proof.persisted);
  assert.equal(proof.storeVerified, true);
  assert.equal(
    proof.evidence,
    "live bounded fixed-scope payload-digest verification"
  );
});

test(
  "3c. Integration: store proof rejects a syntactically valid but stale payload digest",
  { skip: !REAL_DB },
  async () => {
    const embedder = new FakeEmbedder();
    const id = await remember(embedder, {
      company: "TamperProofCorp",
      kind: "validation",
      content: "The live proof must bind this payload to its digest.",
      idempotencyKey: "tamper-proof-v1",
    });
    await query(
      `UPDATE agent_memory
          SET content_hash = repeat('0', 64)
        WHERE id = $1`,
      [id]
    );

    const proof = await memoryStoreProof(
      "TamperProofCorp",
      embedder.modelId
    );
    assert.equal(proof.persisted, 1);
    assert.equal(proof.idempotencyKeys, 1);
    assert.equal(proof.contentDigests, 0);
    assert.equal(proof.storeVerified, false);
  }
);

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
    const embedder = new FakeEmbedder();
    await remember(embedder, {
      kind: "validation",
      company: "Helios SA",
      content: "Durable-store proof integration fixture.",
      idempotencyKey: "integration-store-proof-v1",
    });
    const proof = await handleProof(
      new MemoryAgent(embedder, new FakeNarrator())
    );
    assert.equal(proof.status, 200);
    const vector = proof.body.vectorIndex as Record<string, unknown>;
    const database = proof.body.database as Record<string, unknown>;
    const memory = proof.body.memory as Record<string, unknown>;
    assert.equal(vector.enabled, true);
    assert.equal(vector.name, EXPECTED_VECTOR_INDEX_NAME);
    assert.equal(
      vector.evidence,
      "live pg_catalog.pg_indexes definition"
    );
    assert.match(String(vector.definitionFingerprint), /^[a-f0-9]{64}$/u);
    assert.match(String(database.version), /CockroachDB/iu);
    assert.ok(String(database.runtimePrincipal).length > 0);
    assert.equal(memory.storeVerified, true);
    assert.equal(memory.persisted, memory.idempotencyKeys);
    assert.equal(memory.persisted, memory.contentDigests);
    assert.equal(
      memory.evidence,
      "live bounded fixed-scope payload-digest verification"
    );
  }
);

test(
  "21. Integration: runtime role plans and executes both public C-SPANN paths",
  { skip: !REAL_DB },
  async () => {
    const embedder = new FakeEmbedder();
    const probeKey = "integration-runtime-cspann-v1";
    await remember(embedder, {
      kind: "validation",
      company: "Helios SA",
      content: "Runtime C-SPANN integration probe.",
      idempotencyKey: probeKey,
    });

    await withClient(async (client) => {
      await client.query("SET ROLE archon_public_reader");
      try {
        const vector = await client.query<{ embedding: string }>(
          `SELECT embedding::STRING AS embedding
             FROM agent_memory
            WHERE idempotency_key = $1
            LIMIT 1`,
          [probeKey]
        );
        assert.ok(vector.rows[0]?.embedding);

        for (const path of [
          {
            kind: undefined,
            servingPath: "public-no-kind-cspann",
            view: PUBLIC_RECALL_VIEW_NAME,
            index: EXPECTED_VECTOR_INDEX_NAME,
          },
          {
            kind: "validation" as const,
            servingPath: "public-kind-cspann",
            view: PUBLIC_KIND_RECALL_VIEW_NAME,
            index: EXPECTED_KIND_VECTOR_INDEX_NAME,
          },
        ] as const) {
          const statement = buildRecallQuery(
            vector.rows[0]!.embedding,
            embedder.modelId,
            {
              company: "Helios SA",
              kind: path.kind,
              limit: 5,
            }
          );
          assert.equal(statement.fixedPublicScope, true);
          assert.equal(statement.servingPath, path.servingPath);
          assert.equal(statement.relation, path.view);
          assert.equal(statement.expectedIndexName, path.index);
          const explain = await client.query<Record<string, unknown>>(
            `EXPLAIN ${statement.text}`,
            statement.params
          );
          const plan = explain.rows
            .flatMap((row) => Object.values(row))
            .map(String)
            .join("\n");
          assert.match(plan, /vector search/iu);
          assert.match(plan, new RegExp(path.index, "u"));

          const result = await client.query<RecallQueryRow>(
            statement.text,
            statement.params
          );
          assert.ok(result.rows.length >= 1);
          assert.ok(result.rows.length <= 5);
          assert.ok(
            result.rows.some(
              (row) =>
                row.idempotency_key === probeKey &&
                Math.abs(Number(row.distance)) <= 0.00001
            )
          );
          assert.ok(
            result.rows.every(
              (row) =>
                row.tenant_id === "public-demo" &&
                row.company === "Helios SA" &&
                row.status === "active" &&
                row.embed_model === embedder.modelId &&
                (path.kind === undefined || row.kind === path.kind) &&
                Number.isFinite(Number(row.distance))
            )
          );
        }
      } finally {
        await client.query("RESET ROLE");
      }
    });
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
