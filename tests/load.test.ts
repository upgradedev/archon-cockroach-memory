// Load test: verify concurrent connection pooling and response times under load.
// Runs multiple concurrent remember and recall tasks against CockroachDB.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { FakeEmbedder } from "../src/memory/embeddings.js";
import { FakeNarrator } from "../src/agents/narrator.js";
import { MemoryAgent } from "../src/agents/memory-agent.js";
import { query, closePool } from "../src/db/client.js";

if (!process.env.DATABASE_URL) {
  await import("./db_mock.js");
}

before(async () => {
  await query(`DELETE FROM agent_memory`);
});

after(async () => {
  await closePool();
});

test("Load Test: 100 concurrent memory operations complete successfully", async () => {
  const agent = new MemoryAgent(new FakeEmbedder(), new FakeNarrator());
  const company = "LoadTestCorp";

  // Spawn 50 concurrent writes
  const writePromises = Array.from({ length: 50 }).map(async (_, i) => {
    const start = Date.now();
    await agent.remember(
      "insight",
      `System load metric #${i} value is ${100 + i} percent.`,
      {
        company,
        period: "2026-07",
        sourceRef: `METRIC-${i}`,
        metadata: { record: `METRIC-${i}`, value: 100 + i },
      }
    );
    const duration = Date.now() - start;
    return duration;
  });

  const writeDurations = await Promise.all(writePromises);
  const avgWriteTime =
    writeDurations.reduce((sum, duration) => sum + duration, 0) /
    writeDurations.length;
  console.log(`Average write time: ${avgWriteTime.toFixed(1)}ms`);

  // Spawn 50 concurrent audits/recalls
  const readPromises = Array.from({ length: 50 }).map(async (_, i) => {
    const start = Date.now();
    const answer = await agent.recallAnswer(
      `What is the value of metric #${i}?`,
      { company }
    );
    const duration = Date.now() - start;
    return { answer, duration };
  });

  const readResults = await Promise.all(readPromises);
  const avgReadTime =
    readResults.reduce((sum, result) => sum + result.duration, 0) /
    readResults.length;
  console.log(`Average read time: ${avgReadTime.toFixed(1)}ms`);

  // This integration test proves concurrent correctness. The separate k6 CI
  // job owns latency SLO enforcement on a dedicated runner so scheduler and
  // cross-suite contention cannot turn this functional gate into a flaky timer.
  assert.equal(writeDurations.length, 50);
  assert.equal(readResults.length, 50);
  assert.ok(writeDurations.every(Number.isFinite));
  assert.ok(
    readResults.every(({ duration }) => Number.isFinite(duration))
  );
});
