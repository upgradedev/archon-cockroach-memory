import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  ABLATION_VARIANTS,
  BASELINE_VARIANTS,
  deriveVectorEvidenceGates,
  evaluateMemoryPolicy,
  evaluateVariant,
  parseVectorBenchmarkSummary,
  validateEvaluationFixture,
  type EvaluationFixture,
  type VectorBenchmarkProvenance,
} from "../src/evaluation/memory-policy.js";

const fixtureUrl = new URL("../evals/longitudinal-cases.json", import.meta.url);
const fixtureRaw = JSON.parse(await readFile(fixtureUrl, "utf8")) as unknown;

function cloneFixture(): EvaluationFixture {
  return structuredClone(
    validateEvaluationFixture(structuredClone(fixtureRaw))
  );
}

function resultById<T extends { id: string }>(items: readonly T[], id: string): T {
  const result = items.find((item) => item.id === id);
  assert.ok(result, `missing result ${id}`);
  return result;
}

test("canonical policy fixture passes with explicit action denominators", () => {
  const evaluated = evaluateMemoryPolicy(structuredClone(fixtureRaw));
  assert.equal(evaluated.fixture.cases.length, 15);
  assert.ok(Object.values(evaluated.gates).every(Boolean));

  const b4 = resultById(evaluated.baselines, "B4_FULL_LIFECYCLE").metrics;
  assert.equal(b4.proposalDecisionCases, 5);
  assert.equal(b4.proposalDecisionCorrect, 5);
  assert.equal(b4.proposalDecisionAccuracy, 1);
  assert.equal(b4.safeNoActionCases, 3);
  assert.equal(b4.safeNoActionCorrect, 3);
  assert.equal(b4.safeNoActionRate, 1);
  assert.equal(b4.exactActionCases, 2);
  assert.equal(b4.exactActionCorrect, 2);
  assert.equal(b4.exactActionMatch, 1);

  const noHuman = resultById(
    evaluated.ablations,
    "A_NO_HUMAN_GATE"
  ).metrics;
  assert.equal(noHuman.proposalDecisionCases, 5);
  assert.equal(noHuman.proposalDecisionCorrect, 3);
  assert.equal(noHuman.proposalDecisionAccuracy, 0.6);
  assert.equal(noHuman.safeNoActionCases, 3);
  assert.equal(noHuman.safeNoActionCorrect, 1);
  assert.equal(noHuman.safeNoActionRate, 0.333333);
  assert.ok(noHuman.unauthorizedActions > 0);
});

test("unrelated no-action cases cannot inflate proposal action metrics", () => {
  const fixture = cloneFixture();
  const unrelated = structuredClone(fixture.cases[0]);
  unrelated.id = `${unrelated.id}-unrelated-control`;
  fixture.cases.push(unrelated);

  const b4Config = resultById(BASELINE_VARIANTS, "B4_FULL_LIFECYCLE");
  const metrics = evaluateVariant(fixture, b4Config).metrics;
  assert.equal(metrics.cases, 16);
  assert.equal(metrics.proposalDecisionCases, 5);
  assert.equal(metrics.safeNoActionCases, 3);
  assert.equal(metrics.exactActionCases, 2);
});

test("each ablation removes exactly one B4 control and trips its target", () => {
  const evaluated = evaluateMemoryPolicy(structuredClone(fixtureRaw));
  const b4Config = resultById(BASELINE_VARIANTS, "B4_FULL_LIFECYCLE");
  const booleanControls = [
    "useScope",
    "useTemporal",
    "useContradiction",
    "useAuthority",
    "useAbstention",
    "useConsolidation",
    "useForgetting",
    "useHumanGate",
  ] as const;
  const ids = new Set<string>();
  for (const config of [...BASELINE_VARIANTS, ...ABLATION_VARIANTS]) {
    assert.equal(ids.has(config.id), false, `duplicate variant ${config.id}`);
    ids.add(config.id);
  }
  for (const ablation of ABLATION_VARIANTS) {
    const changed = booleanControls.filter(
      (control) => ablation[control] !== b4Config[control]
    );
    assert.equal(
      changed.length,
      1,
      `${ablation.id} must mutate exactly one control`
    );
    assert.equal(ablation[changed[0]], false);
  }

  const b4 = resultById(evaluated.baselines, "B4_FULL_LIFECYCLE").metrics;
  const ablation = (id: string) => resultById(evaluated.ablations, id).metrics;
  assert.ok(ablation("A_NO_SCOPE").answerAccuracy < b4.answerAccuracy);
  assert.ok(
    ablation("A_NO_TEMPORAL").temporalUpdateAccuracy <
      b4.temporalUpdateAccuracy
  );
  assert.ok(
    ablation("A_NO_CONTRADICTION").contradictionF1 < b4.contradictionF1
  );
  assert.ok(ablation("A_NO_AUTHORITY").answerAccuracy < b4.answerAccuracy);
  assert.ok(
    ablation("A_NO_ABSTENTION").abstentionRecall < b4.abstentionRecall
  );
  assert.ok(
    ablation("A_NO_CONSOLIDATION").longitudinalAccuracy <
      b4.longitudinalAccuracy
  );
  assert.ok(ablation("A_NO_FORGETTING").answerAccuracy < b4.answerAccuracy);
  assert.ok(ablation("A_NO_HUMAN_GATE").unauthorizedActions > 0);
});

test("fixture validation rejects vacuous cohorts and malformed controls", () => {
  const duplicate = cloneFixture();
  duplicate.cases[1].id = duplicate.cases[0].id;
  assert.throws(
    () => validateEvaluationFixture(duplicate),
    /Duplicate case id/u
  );

  const noTemporal = cloneFixture();
  noTemporal.cases = noTemporal.cases.filter(
    (item) => !item.tags.includes("temporal")
  );
  assert.throws(
    () => validateEvaluationFixture(noTemporal),
    /no temporal coverage/u
  );

  const noSafeNoAction = cloneFixture();
  noSafeNoAction.cases = noSafeNoAction.cases.filter(
    (item) => !(item.action && item.expected.action === null)
  );
  assert.throws(
    () => validateEvaluationFixture(noSafeNoAction),
    /no safeNoActionProposals coverage/u
  );

  const mismatchedAction = cloneFixture();
  const positive = mismatchedAction.cases.find(
    (item) => item.expected.action !== null
  );
  if (!positive?.expected.action) {
    assert.fail("canonical fixture must contain a positive action case");
  }
  positive.expected.action.target = "fabricated-target";
  assert.throws(
    () => validateEvaluationFixture(mismatchedAction),
    /expected action does not match/u
  );

  const futureIngested = cloneFixture();
  futureIngested.cases[0].evidence[0].observedAt =
    "2099-01-01T00:00:00.000Z";
  assert.throws(
    () => validateEvaluationFixture(futureIngested),
    /future-ingested evidence is forbidden/u
  );
});

test("corrupt expected labels fail deterministic policy gates", () => {
  const corrupted = cloneFixture();
  corrupted.cases[0].expected.answerEvidenceId = null;
  corrupted.cases[0].expected.evidenceIds = [];
  corrupted.cases[0].expected.abstain = true;
  const evaluated = evaluateMemoryPolicy(corrupted);
  assert.equal(evaluated.gates.b4PerfectDeterministicAnswerAccuracy, false);
  assert.ok(
    resultById(evaluated.baselines, "B4_FULL_LIFECYCLE").metrics
      .answerAccuracy < 1
  );
});

const vectorSummary = {
  corpus_size: 2_000,
  queries: 75,
  top_k: 10,
  dim: 1_024,
  corpus: "clustered",
  write_rows_per_sec: 500,
  beams: [
    {
      beam: 100,
      recall_at_k_mean: 0.92,
      recall_at_k_min: 0.8,
      latency_ms_p50: 10,
      latency_ms_p95: 15,
      latency_ms_p99: 18,
      latency_ms_mean: 11,
    },
  ],
};

function validVectorLog(): string {
  return [
    "Benchmark: N=2000",
    "=== Vector-index benchmark ===",
    `JSON ${JSON.stringify(vectorSummary)}`,
    "",
  ].join("\n");
}

function validProvenance(): VectorBenchmarkProvenance {
  return {
    schemaVersion: "1.0.0",
    evidenceClass: "exact-sha-vector-benchmark-provenance",
    sourceSha: "a".repeat(40),
    benchmark: {
      sourcePath: "scripts/benchmark.ts",
      sourceSha256: "b".repeat(64),
      logSha256: "c".repeat(64),
      completed: true,
      sourceContract: {
        exactTopKDefined: true,
        truthSetUsesExactTopK: true,
        cspannDistanceQueryPresent: true,
      },
    },
    database: {
      product: "CockroachDB",
      version: "CockroachDB CCL v26.2.3",
      querySucceeded: true,
    },
    exactGroundTruth: {
      method: "deterministic-seeded-brute-force-cosine-js",
      corpusSize: 2_000,
      queries: 75,
      topK: 10,
    },
    approximateSearch: {
      method: "cockroachdb-cspann-cosine",
      distanceOperator: "<=>",
      queries: 75,
      topK: 10,
    },
  };
}

test("vector evidence gates are derived from parsed provenance", () => {
  const summary = parseVectorBenchmarkSummary(validVectorLog());
  const provenance = validProvenance();
  const derived = deriveVectorEvidenceGates(provenance, summary, {
    sourceSha: "a".repeat(40),
    vectorLogSha256: "c".repeat(64),
  });
  assert.ok(Object.values(derived.gates).every(Boolean));

  const wrongEngine = structuredClone(provenance);
  wrongEngine.database.version = "PostgreSQL 17";
  assert.equal(
    deriveVectorEvidenceGates(wrongEngine, summary, {
      sourceSha: "a".repeat(40),
      vectorLogSha256: "c".repeat(64),
    }).gates.realCockroachDbRun,
    false
  );

  const missingExactContract = structuredClone(provenance);
  missingExactContract.benchmark.sourceContract.truthSetUsesExactTopK = false;
  const missingExact = deriveVectorEvidenceGates(
    missingExactContract,
    summary,
    {
      sourceSha: "a".repeat(40),
      vectorLogSha256: "c".repeat(64),
    }
  ).gates;
  assert.equal(missingExact.exactGroundTruthPresent, false);
  assert.equal(missingExact.benchmarkSourceBound, false);

  assert.equal(
    deriveVectorEvidenceGates(provenance, summary, {
      sourceSha: "d".repeat(40),
      vectorLogSha256: "c".repeat(64),
    }).gates.benchmarkLogBound,
    false
  );
  assert.equal(
    deriveVectorEvidenceGates(provenance, summary, {
      sourceSha: "a".repeat(40),
      vectorLogSha256: "e".repeat(64),
    }).gates.benchmarkLogBound,
    false
  );
});

test("vector parser rejects ambiguous summaries and invalid beam metrics", () => {
  const line = `JSON ${JSON.stringify(vectorSummary)}`;
  assert.throws(
    () => parseVectorBenchmarkSummary(`${line}\n${line}\n`),
    /Expected exactly one/u
  );
  const invalid = structuredClone(vectorSummary);
  invalid.beams[0].latency_ms_p95 = -1;
  assert.throws(
    () =>
      parseVectorBenchmarkSummary(`JSON ${JSON.stringify(invalid)}\n`),
    /beam metrics are invalid/u
  );
});
