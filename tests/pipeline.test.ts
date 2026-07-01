// End-to-end agentic memory path — ingest → embed+remember → vector recall →
// narrate — against a live CockroachDB, fully OFFLINE (FakeEmbedder + FakeNarrator,
// no AWS). Gated on DATABASE_URL: skipped on a laptop without a DB, RUN in CI
// (which stands CockroachDB up, applies the schema, and sets DATABASE_URL before
// `npm test`). This is the test that proves the memory→narrate loop actually
// works over the distributed vector index, not just the pure narrator composition.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { FakeEmbedder } from "../src/memory/embeddings.js";
import { FakeNarrator } from "../src/agents/narrator.js";
import { MemoryAgent } from "../src/agents/memory-agent.js";
import { memoryCount } from "../src/memory/memory.js";
import { query, closePool } from "../src/db/client.js";
import type { PayrollEvent } from "../src/extraction/types.js";

const HAS_DB = Boolean(process.env.DATABASE_URL);

const EVENT: PayrollEvent = {
  event_id: "evt-acme-2026-03",
  company: "Acme Foods AE",
  period: "2026-03",
  employee_count: 3,
  bank_net_total: 41000,
  gross_total: 52000,
  employer_ika_total: 11800,
  employee_ika_total: 4200,
  tax_withheld_total: 6800,
  employer_cost_total: 63800,
  cost_gap_amount: 11800,
  cost_gap_pct: 28.8,
  hidden_total: 22800,
  employees: [
    { employee_id: "E-01", name: "Maria Papadopoulou", gross: 22000, employee_ika: 1800, tax: 3000, net: 17200, employer_ika: 5000, employer_cost: 27000 },
    { employee_id: "E-02", name: "Nikos Georgiou", gross: 18000, employee_ika: 1500, tax: 2400, net: 14100, employer_ika: 4100, employer_cost: 22100 },
  ],
  linked_docs: ["doc-bank-1", "doc-reg-1"],
};

before(async () => {
  if (!HAS_DB) return;
  await query(`DELETE FROM agent_memory`);
});

after(async () => {
  // Always release the pg pool, or `node --test` never exits (CI would hang).
  await closePool();
});

test("ingestEvent writes recallable memories to CockroachDB", { skip: !HAS_DB }, async () => {
  const agent = new MemoryAgent(new FakeEmbedder(), new FakeNarrator());
  const ids = await agent.ingestEvent(EVENT);
  // event summary + insight + 2 per-employee lines = 4 memories.
  assert.equal(ids.length, 4);
  assert.equal(await memoryCount("Acme Foods AE"), 4);
});

test("recallAnswer recalls by meaning over the vector index and narrates a grounded, cited answer", { skip: !HAS_DB }, async () => {
  const agent = new MemoryAgent(new FakeEmbedder(), new FakeNarrator());
  await agent.ingestEvent(EVENT);

  const { answer, hits, citations, modelId } = await agent.recallAnswer(
    "What was our real employer payroll cost last month?",
    { company: "Acme Foods AE", limit: 3 }
  );

  // Recall returned evidence from the distributed vector index.
  assert.ok(hits.length > 0, "vector recall returned no memories");
  assert.ok(citations.length > 0, "answer has no citations");
  assert.equal(modelId, "fake-narrator");

  // The answer is grounded: every citation marker appears in it, and a
  // load-bearing figure from the ingested event is surfaced. We assert grounding,
  // not exact vector rank (FakeEmbedder is a hash bag-of-words — ordering is not
  // a meaningful signal to assert on).
  for (const c of citations) {
    assert.ok(answer.includes(c.marker), `answer missing citation marker ${c.marker}`);
  }
  const allContent = citations.map((c) => c.content).join(" ");
  assert.ok(
    allContent.includes("€63,800") || allContent.includes("€22,800"),
    "recalled memories must include the employer-cost figures"
  );
});
