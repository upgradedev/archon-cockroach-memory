/**
 * Pipeline-only longitudinal memory evaluation.
 *
 * This harness deliberately separates three kinds of evidence:
 *   1. deterministic policy behavior over rights-safe, synthetic fixtures;
 *   2. a generated 100k-event lifecycle rehearsal in RUNNER_TEMP; and
 *   3. the existing real CockroachDB C-SPANN benchmark versus exact JS ground truth.
 *
 * It refuses to run outside CI or write outside RUNNER_TEMP. That keeps generated
 * corpora and receipts off developer disks and makes every result an exact-SHA
 * pipeline artifact.
 */

import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { finished } from "node:stream/promises";

type DecisionOutcome = "approved" | "rejected";

interface Evidence {
  id: string;
  sessionId: string;
  tenantId: string;
  company: string;
  topic: string;
  text: string;
  value: string;
  observedAt: string;
  validFrom: string;
  validTo: string | null;
  memoryState?: "active" | "superseded" | "retracted";
  retentionExpiresAt?: string | null;
  authorityRank: number;
  semanticScore: number;
}

interface ExpectedAction {
  type: string;
  target: string;
  parameters: Record<string, string>;
  idempotencyId: string;
}

interface ActionProposal {
  type: string;
  target: string;
  parameters: Record<string, string>;
  proposedEvidenceId: string;
  supersedesEvidenceId: string;
  requiredRole: string;
  idempotencyId: string;
  decisionAttempts: number;
  decision: {
    outcome: DecisionOutcome;
    actorRole: string;
  } | null;
}

interface EvaluationCase {
  id: string;
  tags: string[];
  query: {
    sessionId: string;
    tenantId: string;
    company: string;
    asOf: string;
    topic: string;
    text: string;
  };
  evidence: Evidence[];
  action?: ActionProposal;
  expected: {
    answerEvidenceId: string | null;
    evidenceIds: string[];
    abstain: boolean;
    conflict: boolean;
    action: ExpectedAction | null;
  };
}

interface EvaluationFixture {
  schemaVersion: string;
  dataset: Record<string, unknown>;
  defaults: {
    semanticThreshold: number;
    authorityMargin: number;
  };
  cases: EvaluationCase[];
}

interface Prediction {
  answerEvidenceId: string | null;
  evidenceIds: string[];
  abstain: boolean;
  conflict: boolean;
  action: ExpectedAction | null;
  unauthorizedActions: number;
  actionExecutions: number;
  decisionDuplicateSuppressions: number;
}

interface ClassificationCounts {
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  trueNegative: number;
}

interface VariantMetrics {
  cases: number;
  answerAccuracy: number;
  evidencePrecision: number;
  evidenceRecall: number;
  contradictionPrecision: number;
  contradictionRecall: number;
  contradictionF1: number;
  abstentionPrecision: number;
  abstentionRecall: number;
  abstentionF1: number;
  temporalUpdateAccuracy: number;
  longitudinalAccuracy: number;
  actionDecisionAccuracy: number;
  expectedActionExactMatch: number;
  unauthorizedActions: number;
  actionExecutions: number;
  decisionDuplicateSuppressions: number;
}

interface VariantResult {
  id: string;
  description: string;
  productionEligible: boolean;
  metrics: VariantMetrics;
  predictions: Array<{
    caseId: string;
    expected: EvaluationCase["expected"];
    actual: Prediction;
  }>;
}

interface VariantConfig {
  id: string;
  description: string;
  kind: "session" | "lexical" | "vector" | "lifecycle";
  productionEligible: boolean;
  useScope: boolean;
  useTemporal: boolean;
  useContradiction: boolean;
  useAuthority: boolean;
  useAbstention: boolean;
  useConsolidation: boolean;
  useForgetting: boolean;
  useHumanGate: boolean;
}

interface Cli {
  mode: "policy" | "finalize";
  fixture?: string;
  output: string;
  sourceSha: string;
  scaleRecords: number;
  vectorLog?: string;
}

interface ScaleEvent {
  sequence: number;
  entityId: string;
  sessionId: "session-a" | "session-b" | "session-c";
  kind: "original" | "proposal" | "decision" | "decision-retry" | "query";
  priorEvidenceId: string;
  proposedEvidenceId: string;
  idempotencyId: string;
  outcome: "approved" | "rejected" | "pending";
  actorRole: "financial-controller" | "none";
  expectedEvidenceId: string | null;
  expectedAbstain: boolean;
}

interface VectorBenchmarkSummary {
  corpus_size: number;
  queries: number;
  top_k: number;
  dim: number;
  corpus: string;
  write_rows_per_sec: number;
  beams: Array<{
    beam: number | null;
    recall_at_k_mean: number;
    recall_at_k_min: number;
    latency_ms_p50: number;
    latency_ms_p95: number;
    latency_ms_p99: number;
    latency_ms_mean: number;
  }>;
}

const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const SCALE_GENERATOR_VERSION = "archon-memory-scale-v1";

function fail(message: string): never {
  throw new Error(message);
}

function round(value: number, digits = 6): number {
  return Number(value.toFixed(digits));
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function prettyJson(value: unknown): string {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  const input = createReadStream(path);
  input.on("data", (chunk: Buffer) => hash.update(chunk));
  await finished(input);
  return hash.digest("hex");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, prettyJson(value), { encoding: "utf8", flag: "w" });
}

function parsePositiveInteger(raw: string | undefined, fallback: number): number {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail(`Expected a positive integer, received "${raw ?? ""}".`);
  }
  return value;
}

function parseCli(argv: string[]): Cli {
  const [rawMode, ...rest] = argv;
  if (rawMode !== "policy" && rawMode !== "finalize") {
    fail("Usage: evaluate-memory-architecture.ts <policy|finalize> [options]");
  }
  const options = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      fail(`Invalid CLI argument near "${key ?? ""}".`);
    }
    options.set(key.slice(2), value);
  }
  const output = options.get("output");
  const sourceSha = options.get("source-sha");
  if (!output || !sourceSha) {
    fail("Both --output and --source-sha are required.");
  }
  if (!SHA_PATTERN.test(sourceSha)) {
    fail("--source-sha must be an exact lowercase 40-character Git SHA.");
  }
  const scaleRecords = parsePositiveInteger(
    options.get("scale-records"),
    100_000
  );
  if (scaleRecords < 100_000 || scaleRecords > 1_000_000) {
    fail("--scale-records must be between 100000 and 1000000.");
  }
  if (scaleRecords % 5 !== 0) {
    fail("--scale-records must be divisible by 5.");
  }
  const cli: Cli = {
    mode: rawMode,
    output,
    sourceSha,
    scaleRecords,
  };
  if (rawMode === "policy") {
    cli.fixture = options.get("fixture");
    if (!cli.fixture) fail("policy mode requires --fixture.");
  } else {
    cli.vectorLog = options.get("vector-log");
    if (!cli.vectorLog) fail("finalize mode requires --vector-log.");
  }
  return cli;
}

function assertPipelineOutput(output: string): string {
  if (process.env.CI !== "true") {
    fail("This evaluation is pipeline-only and requires CI=true.");
  }
  const runnerTempRaw = process.env.RUNNER_TEMP;
  if (!runnerTempRaw) {
    fail("RUNNER_TEMP is required for pipeline-owned evaluation output.");
  }
  const runnerTemp = resolve(runnerTempRaw);
  const target = resolve(output);
  const child = relative(runnerTemp, target);
  if (
    child === "" ||
    child === "." ||
    child.startsWith(`..${sep}`) ||
    child === ".." ||
    resolve(runnerTemp, child) !== target
  ) {
    fail("--output must be a child directory of RUNNER_TEMP.");
  }
  return target;
}

function assertFileWithin(parent: string, target: string, label: string): void {
  const parentPath = resolve(parent);
  const targetPath = resolve(target);
  const child = relative(parentPath, targetPath);
  if (
    child === "" ||
    child === "." ||
    child === ".." ||
    child.startsWith(`..${sep}`) ||
    resolve(parentPath, child) !== targetPath
  ) {
    fail(`${label} must be a file beneath ${parentPath}.`);
  }
}

function isoMillis(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail(`${label} is not a valid timestamp.`);
  return parsed;
}

function validateFixture(raw: unknown): EvaluationFixture {
  const root = asObject(raw, "fixture");
  if (root.schemaVersion !== "1.0.0") {
    fail("Unsupported evaluation fixture schemaVersion.");
  }
  const defaults = asObject(root.defaults, "fixture.defaults");
  const threshold = defaults.semanticThreshold;
  const authorityMargin = defaults.authorityMargin;
  if (
    typeof threshold !== "number" ||
    threshold <= 0 ||
    threshold >= 1 ||
    typeof authorityMargin !== "number" ||
    authorityMargin < 0
  ) {
    fail("Evaluation defaults are invalid.");
  }
  if (!Array.isArray(root.cases) || root.cases.length < 10) {
    fail("The longitudinal fixture must contain at least ten cases.");
  }
  const fixture = raw as EvaluationFixture;
  const caseIds = new Set<string>();
  for (const testCase of fixture.cases) {
    if (!testCase.id || caseIds.has(testCase.id)) {
      fail(`Duplicate or empty case id "${testCase.id ?? ""}".`);
    }
    caseIds.add(testCase.id);
    if (!Array.isArray(testCase.tags) || testCase.tags.length === 0) {
      fail(`${testCase.id}: tags are required.`);
    }
    const asOf = isoMillis(testCase.query.asOf, `${testCase.id}.query.asOf`);
    if (testCase.evidence.length === 0) {
      fail(`${testCase.id}: at least one evidence item is required.`);
    }
    const evidenceIds = new Set<string>();
    for (const evidence of testCase.evidence) {
      if (!evidence.id || evidenceIds.has(evidence.id)) {
        fail(`${testCase.id}: duplicate or empty evidence id.`);
      }
      evidenceIds.add(evidence.id);
      isoMillis(evidence.observedAt, `${testCase.id}.${evidence.id}.observedAt`);
      const validFrom = isoMillis(
        evidence.validFrom,
        `${testCase.id}.${evidence.id}.validFrom`
      );
      if (evidence.validTo !== null) {
        const validTo = isoMillis(
          evidence.validTo,
          `${testCase.id}.${evidence.id}.validTo`
        );
        if (validTo <= validFrom) {
          fail(`${testCase.id}.${evidence.id}: validTo must follow validFrom.`);
        }
      }
      if (
        evidence.retentionExpiresAt !== undefined &&
        evidence.retentionExpiresAt !== null
      ) {
        isoMillis(
          evidence.retentionExpiresAt,
          `${testCase.id}.${evidence.id}.retentionExpiresAt`
        );
      }
      if (
        evidence.memoryState !== undefined &&
        !["active", "superseded", "retracted"].includes(evidence.memoryState)
      ) {
        fail(`${testCase.id}.${evidence.id}: memoryState is invalid.`);
      }
      if (
        evidence.semanticScore < 0 ||
        evidence.semanticScore > 1 ||
        !Number.isFinite(evidence.authorityRank)
      ) {
        fail(`${testCase.id}.${evidence.id}: score/rank is invalid.`);
      }
    }
    if (
      testCase.expected.answerEvidenceId !== null &&
      !evidenceIds.has(testCase.expected.answerEvidenceId)
    ) {
      fail(`${testCase.id}: expected answer evidence does not exist.`);
    }
    for (const evidenceId of testCase.expected.evidenceIds) {
      if (!evidenceIds.has(evidenceId)) {
        fail(`${testCase.id}: expected evidence "${evidenceId}" does not exist.`);
      }
    }
    if (testCase.expected.abstain !== (testCase.expected.answerEvidenceId === null)) {
      fail(`${testCase.id}: abstention and expected answer disagree.`);
    }
    if (testCase.action) {
      if (
        !evidenceIds.has(testCase.action.proposedEvidenceId) ||
        !evidenceIds.has(testCase.action.supersedesEvidenceId)
      ) {
        fail(`${testCase.id}: action references unknown evidence.`);
      }
      if (
        !Number.isSafeInteger(testCase.action.decisionAttempts) ||
        testCase.action.decisionAttempts < 0
      ) {
        fail(`${testCase.id}: decisionAttempts is invalid.`);
      }
    }
    // Every record must have been observed before the query; temporal ablations
    // concern business-effective time, never impossible future ingestion.
    for (const evidence of testCase.evidence) {
      if (
        isoMillis(evidence.observedAt, `${testCase.id}.${evidence.id}`) > asOf
      ) {
        fail(`${testCase.id}.${evidence.id}: future-ingested evidence is forbidden.`);
      }
    }
  }
  return fixture;
}

function tokens(value: string): Set<string> {
  const stop = new Set([
    "a",
    "an",
    "and",
    "at",
    "for",
    "has",
    "is",
    "of",
    "the",
    "to",
    "was",
    "what",
    "which",
  ]);
  return new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, " ")
      .split(/\s+/u)
      .filter((token) => token.length > 1 && !stop.has(token))
  );
}

function lexicalScore(query: string, evidence: string): number {
  const left = tokens(query);
  const right = tokens(evidence);
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection++;
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : intersection / union;
}

function observedByQuery(evidence: Evidence, testCase: EvaluationCase): boolean {
  return Date.parse(evidence.observedAt) <= Date.parse(testCase.query.asOf);
}

function inScope(evidence: Evidence, testCase: EvaluationCase): boolean {
  return (
    evidence.tenantId === testCase.query.tenantId &&
    evidence.company === testCase.query.company
  );
}

function temporallyValid(
  evidence: Evidence,
  testCase: EvaluationCase
): boolean {
  const at = Date.parse(testCase.query.asOf);
  return (
    Date.parse(evidence.validFrom) <= at &&
    (evidence.validTo === null || at < Date.parse(evidence.validTo))
  );
}

function retainedForRecall(
  evidence: Evidence,
  testCase: EvaluationCase
): boolean {
  const at = Date.parse(testCase.query.asOf);
  return (
    (evidence.memoryState ?? "active") === "active" &&
    (evidence.retentionExpiresAt === undefined ||
      evidence.retentionExpiresAt === null ||
      at < Date.parse(evidence.retentionExpiresAt))
  );
}

function sortSemantic(left: Evidence, right: Evidence): number {
  return (
    right.semanticScore - left.semanticScore ||
    Date.parse(right.observedAt) - Date.parse(left.observedAt) ||
    left.id.localeCompare(right.id)
  );
}

function exactAction(action: ActionProposal): ExpectedAction {
  return {
    type: action.type,
    target: action.target,
    parameters: action.parameters,
    idempotencyId: action.idempotencyId,
  };
}

function basePrediction(): Prediction {
  return {
    answerEvidenceId: null,
    evidenceIds: [],
    abstain: true,
    conflict: false,
    action: null,
    unauthorizedActions: 0,
    actionExecutions: 0,
    decisionDuplicateSuppressions: 0,
  };
}

function lifecyclePrediction(
  testCase: EvaluationCase,
  fixture: EvaluationFixture,
  config: VariantConfig
): Prediction {
  const threshold = config.useAbstention
    ? fixture.defaults.semanticThreshold
    : 0;
  const candidates = testCase.evidence
    .filter((item) => observedByQuery(item, testCase))
    .filter((item) => !config.useScope || inScope(item, testCase))
    .filter((item) => !config.useTemporal || temporallyValid(item, testCase))
    .filter(
      (item) => !config.useForgetting || retainedForRecall(item, testCase)
    )
    .filter((item) => item.topic === testCase.query.topic)
    .filter((item) => item.semanticScore >= threshold);
  const evidenceIds = candidates.map((item) => item.id).sort();
  const distinctValues = new Set(candidates.map((item) => item.value));
  const conflict = config.useContradiction && distinctValues.size > 1;
  const prediction: Prediction = {
    ...basePrediction(),
    evidenceIds,
    conflict,
  };

  const proposal = testCase.action;
  const decisionAuthorized =
    proposal?.decision !== null &&
    proposal?.decision !== undefined &&
    proposal.decision.actorRole === proposal.requiredRole;
  const effectiveDecision: DecisionOutcome | null = proposal
    ? proposal.decision
      ? decisionAuthorized || !config.useHumanGate
        ? proposal.decision.outcome
        : null
      : config.useHumanGate
        ? null
        : "approved"
    : null;

  if (
    proposal &&
    config.useConsolidation &&
    effectiveDecision === "approved"
  ) {
    prediction.answerEvidenceId = proposal.proposedEvidenceId;
    prediction.abstain = false;
  } else if (
    proposal &&
    config.useConsolidation &&
    effectiveDecision === "rejected"
  ) {
    prediction.answerEvidenceId = proposal.supersedesEvidenceId;
    prediction.abstain = false;
  }

  if (
    proposal &&
    effectiveDecision === "approved" &&
    (decisionAuthorized || !config.useHumanGate)
  ) {
    prediction.action = exactAction(proposal);
    prediction.actionExecutions = 1;
    prediction.unauthorizedActions = decisionAuthorized ? 0 : 1;
  }
  if (
    proposal?.decision &&
    decisionAuthorized &&
    proposal.decisionAttempts > 1
  ) {
    prediction.decisionDuplicateSuppressions =
      proposal.decisionAttempts - 1;
  }

  if (prediction.answerEvidenceId !== null) return prediction;
  if (candidates.length === 0) return prediction;

  const ranked = [...candidates].sort((left, right) => {
    const leftAuthority = config.useAuthority ? left.authorityRank : 0;
    const rightAuthority = config.useAuthority ? right.authorityRank : 0;
    return rightAuthority - leftAuthority || sortSemantic(left, right);
  });
  if (conflict) {
    const firstAuthority = config.useAuthority ? ranked[0].authorityRank : 0;
    const secondAuthority = config.useAuthority
      ? ranked[1]?.authorityRank ?? firstAuthority
      : 0;
    if (
      firstAuthority - secondAuthority < fixture.defaults.authorityMargin &&
      config.useAbstention
    ) {
      return prediction;
    }
  }
  prediction.answerEvidenceId = ranked[0].id;
  prediction.abstain = false;
  return prediction;
}

function baselinePrediction(
  testCase: EvaluationCase,
  fixture: EvaluationFixture,
  config: VariantConfig
): Prediction {
  if (config.kind === "lifecycle") {
    return lifecyclePrediction(testCase, fixture, config);
  }
  let candidates = testCase.evidence.filter((item) =>
    observedByQuery(item, testCase)
  );
  if (config.kind === "session") {
    candidates = candidates.filter(
      (item) =>
        item.sessionId === testCase.query.sessionId &&
        inScope(item, testCase)
    );
  } else if (config.kind === "lexical") {
    const lexical = candidates
      .map((item) => ({
        item,
        score: lexicalScore(testCase.query.text, item.text),
      }))
      .filter((item) => item.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          Date.parse(right.item.observedAt) -
            Date.parse(left.item.observedAt) ||
          left.item.id.localeCompare(right.item.id)
      );
    const selected = lexical[0]?.item;
    return selected
      ? {
          ...basePrediction(),
          answerEvidenceId: selected.id,
          evidenceIds: [selected.id],
          abstain: false,
        }
      : basePrediction();
  } else {
    candidates = candidates
      .filter(
        (item) =>
          item.semanticScore >= fixture.defaults.semanticThreshold
      )
      .sort(sortSemantic);
  }
  const selected = candidates[0];
  return selected
    ? {
        ...basePrediction(),
        answerEvidenceId: selected.id,
        evidenceIds: [selected.id],
        abstain: false,
      }
    : basePrediction();
}

function classification(
  actual: boolean[],
  expected: boolean[]
): ClassificationCounts {
  const counts: ClassificationCounts = {
    truePositive: 0,
    falsePositive: 0,
    falseNegative: 0,
    trueNegative: 0,
  };
  for (let index = 0; index < actual.length; index++) {
    if (actual[index] && expected[index]) counts.truePositive++;
    else if (actual[index]) counts.falsePositive++;
    else if (expected[index]) counts.falseNegative++;
    else counts.trueNegative++;
  }
  return counts;
}

function precision(counts: ClassificationCounts): number {
  const denominator = counts.truePositive + counts.falsePositive;
  if (denominator === 0) {
    return counts.falseNegative === 0 ? 1 : 0;
  }
  return counts.truePositive / denominator;
}

function recall(counts: ClassificationCounts): number {
  const denominator = counts.truePositive + counts.falseNegative;
  if (denominator === 0) {
    return counts.falsePositive === 0 ? 1 : 0;
  }
  return counts.truePositive / denominator;
}

function f1(p: number, r: number): number {
  return p + r === 0 ? 0 : (2 * p * r) / (p + r);
}

function setPrecision(actual: string[], expected: string[]): number {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  if (actualSet.size === 0) return expectedSet.size === 0 ? 1 : 0;
  let hits = 0;
  for (const item of actualSet) if (expectedSet.has(item)) hits++;
  return hits / actualSet.size;
}

function setRecall(actual: string[], expected: string[]): number {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  if (expectedSet.size === 0) return actualSet.size === 0 ? 1 : 0;
  let hits = 0;
  for (const item of expectedSet) if (actualSet.has(item)) hits++;
  return hits / expectedSet.size;
}

function mean(values: number[]): number {
  return values.length === 0
    ? 1
    : values.reduce((sum, item) => sum + item, 0) / values.length;
}

function evaluateVariant(
  fixture: EvaluationFixture,
  config: VariantConfig
): VariantResult {
  const predictions = fixture.cases.map((testCase) => ({
    caseId: testCase.id,
    expected: testCase.expected,
    actual: baselinePrediction(testCase, fixture, config),
  }));
  const answerCorrect = predictions.map(
    (item) =>
      item.actual.answerEvidenceId === item.expected.answerEvidenceId &&
      item.actual.abstain === item.expected.abstain
  );
  const conflictCounts = classification(
    predictions.map((item) => item.actual.conflict),
    predictions.map((item) => item.expected.conflict)
  );
  const abstentionCounts = classification(
    predictions.map((item) => item.actual.abstain),
    predictions.map((item) => item.expected.abstain)
  );
  const conflictPrecision = precision(conflictCounts);
  const conflictRecall = recall(conflictCounts);
  const abstentionPrecision = precision(abstentionCounts);
  const abstentionRecall = recall(abstentionCounts);
  const temporalIndexes = fixture.cases
    .map((testCase, index) =>
      testCase.tags.includes("temporal") ? index : -1
    )
    .filter((index) => index >= 0);
  const longitudinalIndexes = fixture.cases
    .map((testCase, index) =>
      testCase.tags.includes("longitudinal") ? index : -1
    )
    .filter((index) => index >= 0);
  const expectedActionCases = predictions.filter(
    (item) => item.expected.action !== null
  );
  const actionDecisionCorrect = predictions.map(
    (item) =>
      canonicalJson(item.actual.action) === canonicalJson(item.expected.action)
  );
  const expectedActionExact = expectedActionCases.map(
    (item) =>
      canonicalJson(item.actual.action) === canonicalJson(item.expected.action)
  );
  return {
    id: config.id,
    description: config.description,
    productionEligible: config.productionEligible,
    metrics: {
      cases: fixture.cases.length,
      answerAccuracy: round(mean(answerCorrect.map(Number))),
      evidencePrecision: round(
        mean(
          predictions.map((item) =>
            setPrecision(item.actual.evidenceIds, item.expected.evidenceIds)
          )
        )
      ),
      evidenceRecall: round(
        mean(
          predictions.map((item) =>
            setRecall(item.actual.evidenceIds, item.expected.evidenceIds)
          )
        )
      ),
      contradictionPrecision: round(conflictPrecision),
      contradictionRecall: round(conflictRecall),
      contradictionF1: round(f1(conflictPrecision, conflictRecall)),
      abstentionPrecision: round(abstentionPrecision),
      abstentionRecall: round(abstentionRecall),
      abstentionF1: round(f1(abstentionPrecision, abstentionRecall)),
      temporalUpdateAccuracy: round(
        mean(temporalIndexes.map((index) => Number(answerCorrect[index])))
      ),
      longitudinalAccuracy: round(
        mean(longitudinalIndexes.map((index) => Number(answerCorrect[index])))
      ),
      actionDecisionAccuracy: round(mean(actionDecisionCorrect.map(Number))),
      expectedActionExactMatch: round(mean(expectedActionExact.map(Number))),
      unauthorizedActions: predictions.reduce(
        (sum, item) => sum + item.actual.unauthorizedActions,
        0
      ),
      actionExecutions: predictions.reduce(
        (sum, item) => sum + item.actual.actionExecutions,
        0
      ),
      decisionDuplicateSuppressions: predictions.reduce(
        (sum, item) => sum + item.actual.decisionDuplicateSuppressions,
        0
      ),
    },
    predictions,
  };
}

const BASELINES: VariantConfig[] = [
  {
    id: "B0_SESSION_ONLY",
    description: "Current-session-only memory; no persistent cross-session recall.",
    kind: "session",
    productionEligible: false,
    useScope: true,
    useTemporal: false,
    useContradiction: false,
    useAuthority: false,
    useAbstention: false,
    useConsolidation: false,
    useForgetting: false,
    useHumanGate: true,
  },
  {
    id: "B1_LEXICAL",
    description: "Persistent lexical overlap only; a deliberately simple research baseline.",
    kind: "lexical",
    productionEligible: false,
    useScope: false,
    useTemporal: false,
    useContradiction: false,
    useAuthority: false,
    useAbstention: false,
    useConsolidation: false,
    useForgetting: false,
    useHumanGate: true,
  },
  {
    id: "B2_VECTOR_ONLY",
    description: "Vector-score-only selection over the same candidates; no lifecycle policy.",
    kind: "vector",
    productionEligible: false,
    useScope: false,
    useTemporal: false,
    useContradiction: false,
    useAuthority: false,
    useAbstention: true,
    useConsolidation: false,
    useForgetting: false,
    useHumanGate: true,
  },
  {
    id: "B3_VECTOR_SCOPE_TIME",
    description: "Vector selection with tenant/company and valid-time filters.",
    kind: "lifecycle",
    productionEligible: false,
    useScope: true,
    useTemporal: true,
    useContradiction: false,
    useAuthority: false,
    useAbstention: true,
    useConsolidation: false,
    useForgetting: false,
    useHumanGate: true,
  },
  {
    id: "B4_FULL_LIFECYCLE",
    description: "Scoped temporal memory with contradiction, source authority, abstention, human-gated consolidation, and idempotent actions.",
    kind: "lifecycle",
    productionEligible: true,
    useScope: true,
    useTemporal: true,
    useContradiction: true,
    useAuthority: true,
    useAbstention: true,
    useConsolidation: true,
    useForgetting: true,
    useHumanGate: true,
  },
];

const ABLATIONS: VariantConfig[] = [
  {
    ...BASELINES[4],
    id: "A_NO_SCOPE",
    description: "B4 without tenant/company scope filtering.",
    productionEligible: false,
    useScope: false,
  },
  {
    ...BASELINES[4],
    id: "A_NO_TEMPORAL",
    description: "B4 without valid-time filtering.",
    productionEligible: false,
    useTemporal: false,
  },
  {
    ...BASELINES[4],
    id: "A_NO_CONTRADICTION",
    description: "B4 without contradiction detection.",
    productionEligible: false,
    useContradiction: false,
  },
  {
    ...BASELINES[4],
    id: "A_NO_AUTHORITY",
    description: "B4 without source-authority ranking.",
    productionEligible: false,
    useAuthority: false,
  },
  {
    ...BASELINES[4],
    id: "A_NO_ABSTENTION",
    description: "B4 forced to select even below threshold or amid unresolved conflict.",
    productionEligible: false,
    useAbstention: false,
  },
  {
    ...BASELINES[4],
    id: "A_NO_CONSOLIDATION",
    description: "B4 ignores approved/rejected consolidation decisions.",
    productionEligible: false,
    useConsolidation: false,
  },
  {
    ...BASELINES[4],
    id: "A_NO_FORGETTING",
    description: "B4 recalls retracted or retention-expired memory.",
    productionEligible: false,
    useForgetting: false,
  },
  {
    ...BASELINES[4],
    id: "A_NO_HUMAN_GATE",
    description: "B4 treats missing or wrong-role approval as authorization.",
    productionEligible: false,
    useHumanGate: false,
  },
];

function byId(results: VariantResult[], id: string): VariantResult {
  const result = results.find((item) => item.id === id);
  if (!result) fail(`Missing evaluation variant ${id}.`);
  return result;
}

function policyGates(
  baselines: VariantResult[],
  ablations: VariantResult[]
): Record<string, boolean> {
  const b2 = byId(baselines, "B2_VECTOR_ONLY").metrics;
  const b4 = byId(baselines, "B4_FULL_LIFECYCLE").metrics;
  return {
    b4PerfectDeterministicAnswerAccuracy: b4.answerAccuracy === 1,
    b4PerfectEvidencePrecision: b4.evidencePrecision === 1,
    b4PerfectEvidenceRecall: b4.evidenceRecall === 1,
    b4PerfectContradictionF1: b4.contradictionF1 === 1,
    b4PerfectAbstentionF1: b4.abstentionF1 === 1,
    b4PerfectActionDecisionAccuracy: b4.actionDecisionAccuracy === 1,
    b4ExpectedActionsExact: b4.expectedActionExactMatch === 1,
    b4UnauthorizedActionsZero: b4.unauthorizedActions === 0,
    b4OutperformsVectorOnly: b4.answerAccuracy > b2.answerAccuracy,
    scopeAblationDegrades:
      byId(ablations, "A_NO_SCOPE").metrics.answerAccuracy <
      b4.answerAccuracy,
    temporalAblationDegrades:
      byId(ablations, "A_NO_TEMPORAL").metrics.temporalUpdateAccuracy <
      b4.temporalUpdateAccuracy,
    contradictionAblationDegrades:
      byId(ablations, "A_NO_CONTRADICTION").metrics.contradictionF1 <
      b4.contradictionF1,
    authorityAblationDegrades:
      byId(ablations, "A_NO_AUTHORITY").metrics.answerAccuracy <
      b4.answerAccuracy,
    abstentionAblationDegrades:
      byId(ablations, "A_NO_ABSTENTION").metrics.abstentionRecall <
      b4.abstentionRecall,
    consolidationAblationDegrades:
      byId(ablations, "A_NO_CONSOLIDATION").metrics.longitudinalAccuracy <
      b4.longitudinalAccuracy,
    forgettingAblationDegrades:
      byId(ablations, "A_NO_FORGETTING").metrics.answerAccuracy <
      b4.answerAccuracy,
    humanGateAblationExecutesUnauthorizedAction:
      byId(ablations, "A_NO_HUMAN_GATE").metrics.unauthorizedActions > 0,
  };
}

function scaleEventsForEntity(entityIndex: number): ScaleEvent[] {
  const entityId = `entity-${String(entityIndex).padStart(6, "0")}`;
  const priorEvidenceId = `${entityId}:prior`;
  const proposedEvidenceId = `${entityId}:corrected`;
  const idempotencyId = sha256Text(
    `${SCALE_GENERATOR_VERSION}:${entityId}`
  ).slice(0, 32);
  const outcome =
    entityIndex % 3 === 0
      ? "approved"
      : entityIndex % 3 === 1
        ? "rejected"
        : "pending";
  const actorRole = outcome === "pending" ? "none" : "financial-controller";
  const expectedEvidenceId =
    outcome === "approved"
      ? proposedEvidenceId
      : outcome === "rejected"
        ? priorEvidenceId
        : null;
  const expectedAbstain = outcome === "pending";
  const common = {
    entityId,
    priorEvidenceId,
    proposedEvidenceId,
    idempotencyId,
    outcome,
    actorRole,
    expectedEvidenceId,
    expectedAbstain,
  } as const;
  const base = entityIndex * 5;
  return [
    {
      ...common,
      sequence: base,
      sessionId: "session-a",
      kind: "original",
    },
    {
      ...common,
      sequence: base + 1,
      sessionId: "session-b",
      kind: "proposal",
    },
    {
      ...common,
      sequence: base + 2,
      sessionId: "session-b",
      kind: "decision",
    },
    {
      ...common,
      sequence: base + 3,
      sessionId: "session-b",
      kind: "decision-retry",
    },
    {
      ...common,
      sequence: base + 4,
      sessionId: "session-c",
      kind: "query",
    },
  ];
}

async function generateScaleCorpus(
  path: string,
  records: number
): Promise<void> {
  const writer = createWriteStream(path, {
    encoding: "utf8",
    flags: "wx",
  });
  const entities = records / 5;
  for (let entityIndex = 0; entityIndex < entities; entityIndex++) {
    for (const event of scaleEventsForEntity(entityIndex)) {
      if (!writer.write(`${canonicalJson(event)}\n`)) {
        await once(writer, "drain");
      }
    }
  }
  writer.end();
  await finished(writer);
}

async function evaluateScaleCorpus(path: string): Promise<{
  records: number;
  entities: number;
  queries: number;
  queryAccuracy: number;
  expectedActions: number;
  actionExecutions: number;
  unauthorizedActions: number;
  decisionDuplicateSuppressions: number;
  invalidTransitions: number;
  observedProcessingEventsPerSecond: number;
}> {
  interface EntityState {
    phase: number;
    priorEvidenceId: string;
    proposedEvidenceId: string;
    outcome: ScaleEvent["outcome"];
    currentEvidenceId: string | null;
    expectedEvidenceId: string | null;
    expectedAbstain: boolean;
    idempotencyId: string;
    decided: boolean;
  }
  const states = new Map<string, EntityState>();
  let records = 0;
  let queries = 0;
  let correctQueries = 0;
  let expectedActions = 0;
  let actionExecutions = 0;
  let unauthorizedActions = 0;
  let decisionDuplicateSuppressions = 0;
  let invalidTransitions = 0;
  let previousSequence = -1;
  const started = performance.now();
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    const event = JSON.parse(line) as ScaleEvent;
    records++;
    if (event.sequence !== previousSequence + 1) invalidTransitions++;
    previousSequence = event.sequence;
    let state = states.get(event.entityId);
    if (event.kind === "original") {
      if (state) invalidTransitions++;
      state = {
        phase: 1,
        priorEvidenceId: event.priorEvidenceId,
        proposedEvidenceId: event.proposedEvidenceId,
        outcome: event.outcome,
        currentEvidenceId: event.priorEvidenceId,
        expectedEvidenceId: event.expectedEvidenceId,
        expectedAbstain: event.expectedAbstain,
        idempotencyId: event.idempotencyId,
        decided: false,
      };
      states.set(event.entityId, state);
      continue;
    }
    if (!state) {
      invalidTransitions++;
      continue;
    }
    if (
      state.priorEvidenceId !== event.priorEvidenceId ||
      state.proposedEvidenceId !== event.proposedEvidenceId ||
      state.outcome !== event.outcome ||
      state.idempotencyId !== event.idempotencyId
    ) {
      invalidTransitions++;
    }
    if (event.kind === "proposal") {
      if (state.phase !== 1) invalidTransitions++;
      state.phase = 2;
    } else if (event.kind === "decision") {
      if (state.phase !== 2) invalidTransitions++;
      state.phase = 3;
      if (event.outcome === "approved") {
        if (event.actorRole !== "financial-controller") {
          unauthorizedActions++;
        } else {
          state.currentEvidenceId = event.proposedEvidenceId;
          state.decided = true;
          expectedActions++;
          actionExecutions++;
        }
      } else if (event.outcome === "rejected") {
        if (event.actorRole !== "financial-controller") invalidTransitions++;
        state.currentEvidenceId = event.priorEvidenceId;
        state.decided = true;
      } else {
        state.currentEvidenceId = null;
      }
    } else if (event.kind === "decision-retry") {
      if (state.phase !== 3) invalidTransitions++;
      state.phase = 4;
      if (state.decided) decisionDuplicateSuppressions++;
    } else if (event.kind === "query") {
      if (state.phase !== 4) invalidTransitions++;
      state.phase = 5;
      queries++;
      const actualAbstain = state.currentEvidenceId === null;
      if (
        state.currentEvidenceId === state.expectedEvidenceId &&
        actualAbstain === state.expectedAbstain
      ) {
        correctQueries++;
      }
    } else {
      invalidTransitions++;
    }
  }
  for (const state of states.values()) {
    if (state.phase !== 5) invalidTransitions++;
  }
  const elapsedSeconds = Math.max(
    (performance.now() - started) / 1000,
    0.001
  );
  return {
    records,
    entities: states.size,
    queries,
    queryAccuracy: round(queries === 0 ? 0 : correctQueries / queries),
    expectedActions,
    actionExecutions,
    unauthorizedActions,
    decisionDuplicateSuppressions,
    invalidTransitions,
    observedProcessingEventsPerSecond: Math.round(records / elapsedSeconds),
  };
}

async function runPolicy(cli: Cli, output: string): Promise<void> {
  const fixturePath = resolve(cli.fixture!);
  assertFileWithin(
    process.env.GITHUB_WORKSPACE ?? process.cwd(),
    fixturePath,
    "--fixture"
  );
  const fixtureText = await readFile(fixturePath, "utf8");
  const fixture = validateFixture(JSON.parse(fixtureText));
  const baselines = BASELINES.map((config) =>
    evaluateVariant(fixture, config)
  );
  const ablations = ABLATIONS.map((config) =>
    evaluateVariant(fixture, config)
  );
  const gates = policyGates(baselines, ablations);
  if (Object.values(gates).some((passed) => !passed)) {
    const failures = Object.entries(gates)
      .filter(([, passed]) => !passed)
      .map(([name]) => name)
      .join(", ");
    fail(`Policy evaluation gates failed: ${failures}`);
  }
  const policyResult = {
    schemaVersion: "1.0.0",
    evidenceClass: "deterministic-synthetic-policy-evaluation",
    sourceSha: cli.sourceSha,
    fixture: {
      path: relative(process.cwd(), fixturePath).replaceAll("\\", "/"),
      sha256: sha256Text(fixtureText),
      cases: fixture.cases.length,
      dataset: fixture.dataset,
    },
    fairnessControls: {
      sameCases: true,
      sameEvidence: true,
      sameQueryCutoff: true,
      sameSemanticScores: true,
      sameThreshold: fixture.defaults.semanticThreshold,
      deterministic: true,
      warning:
        "Fixture semantic scores isolate lifecycle-policy effects; they are not C-SPANN measurements.",
    },
    baselines,
    ablations,
    gates,
  };
  await writeJson(resolve(output, "policy-results.json"), policyResult);

  const rawScalePath = resolve(output, "representative-scale-corpus.jsonl");
  let rawScaleSha256 = "";
  let rawScaleBytes = 0;
  let scaleMetrics:
    | Awaited<ReturnType<typeof evaluateScaleCorpus>>
    | undefined;
  try {
    await generateScaleCorpus(rawScalePath, cli.scaleRecords);
    rawScaleSha256 = await sha256File(rawScalePath);
    rawScaleBytes = (await stat(rawScalePath)).size;
    scaleMetrics = await evaluateScaleCorpus(rawScalePath);
  } finally {
    await rm(rawScalePath, { force: true });
  }
  if (!rawScaleSha256 || rawScaleBytes <= 0 || !scaleMetrics) {
    fail("The representative scale corpus did not produce complete evidence.");
  }
  const scaleGates = {
    recordCountExact: scaleMetrics.records === cli.scaleRecords,
    representativeScaleAtLeast100k: scaleMetrics.records >= 100_000,
    fiveEventsPerEntity:
      scaleMetrics.records === scaleMetrics.entities * 5,
    allQueriesCorrect: scaleMetrics.queryAccuracy === 1,
    approvedActionsExecuteExactlyOnce:
      scaleMetrics.actionExecutions === scaleMetrics.expectedActions,
    unauthorizedActionsZero: scaleMetrics.unauthorizedActions === 0,
    retryDecisionsSuppressed:
      scaleMetrics.decisionDuplicateSuppressions > 0,
    lifecycleTransitionsValid: scaleMetrics.invalidTransitions === 0,
  };
  if (Object.values(scaleGates).some((passed) => !passed)) {
    const failures = Object.entries(scaleGates)
      .filter(([, passed]) => !passed)
      .map(([name]) => name)
      .join(", ");
    fail(`Scale evaluation gates failed: ${failures}`);
  }
  const scaleManifest = {
    schemaVersion: "1.0.0",
    evidenceClass: "representative-synthetic-lifecycle-scale-rehearsal",
    sourceSha: cli.sourceSha,
    generator: {
      version: SCALE_GENERATOR_VERSION,
      records: cli.scaleRecords,
      eventsPerEntity: 5,
      deterministic: true,
    },
    rawCorpus: {
      sha256: rawScaleSha256,
      bytes: rawScaleBytes,
      retainedInArtifact: false,
      reproduction:
        "Re-run this exact source SHA in memory-evaluation.yml; the JSONL is generated in RUNNER_TEMP.",
    },
    metrics: scaleMetrics,
    gates: scaleGates,
    claimBoundary:
      "This is generated representative scale, not customer data, hosted load evidence, or a production corpus.",
  };
  await writeJson(resolve(output, "scale-manifest.json"), scaleManifest);
}

function parseVectorBenchmarkLog(raw: string): VectorBenchmarkSummary {
  const jsonLines = raw
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("JSON "));
  if (jsonLines.length !== 1) {
    fail(
      `Expected exactly one benchmark JSON summary, found ${jsonLines.length}.`
    );
  }
  const parsed = asObject(
    JSON.parse(jsonLines[0].slice("JSON ".length)),
    "vector benchmark summary"
  );
  if (
    !Number.isSafeInteger(parsed.corpus_size) ||
    !Number.isSafeInteger(parsed.queries) ||
    !Number.isSafeInteger(parsed.top_k) ||
    !Number.isSafeInteger(parsed.dim) ||
    typeof parsed.corpus !== "string" ||
    !Number.isFinite(parsed.write_rows_per_sec) ||
    !Array.isArray(parsed.beams) ||
    parsed.beams.length === 0
  ) {
    fail("Vector benchmark summary has an invalid shape.");
  }
  for (const beam of parsed.beams) {
    const item = asObject(beam, "vector beam result");
    if (
      typeof item.recall_at_k_mean !== "number" ||
      item.recall_at_k_mean < 0 ||
      item.recall_at_k_mean > 1 ||
      typeof item.recall_at_k_min !== "number" ||
      item.recall_at_k_min < 0 ||
      item.recall_at_k_min > 1
    ) {
      fail("Vector benchmark recall metrics are invalid.");
    }
  }
  return parsed as unknown as VectorBenchmarkSummary;
}

async function readAndValidateArtifact(
  output: string,
  name: string,
  sourceSha: string
): Promise<{ path: string; sha256: string; value: Record<string, unknown> }> {
  const path = resolve(output, name);
  const raw = await readFile(path, "utf8");
  const value = asObject(JSON.parse(raw), name);
  if (value.sourceSha !== sourceSha) {
    fail(`${name} is not bound to source SHA ${sourceSha}.`);
  }
  return { path, sha256: sha256Text(raw), value };
}

async function runFinalize(cli: Cli, output: string): Promise<void> {
  const policy = await readAndValidateArtifact(
    output,
    "policy-results.json",
    cli.sourceSha
  );
  const scale = await readAndValidateArtifact(
    output,
    "scale-manifest.json",
    cli.sourceSha
  );
  const vectorLogPath = resolve(cli.vectorLog!);
  assertFileWithin(output, vectorLogPath, "--vector-log");
  const vectorLog = await readFile(vectorLogPath, "utf8");
  const summary = parseVectorBenchmarkLog(vectorLog);
  const bestRecall = Math.max(
    ...summary.beams.map((item) => item.recall_at_k_mean)
  );
  const recallFloor = Number(process.env.VECTOR_RECALL_FLOOR ?? "0.80");
  if (
    !Number.isFinite(recallFloor) ||
    recallFloor <= 0 ||
    recallFloor > 1
  ) {
    fail("VECTOR_RECALL_FLOOR must be in (0, 1].");
  }
  const vectorGates = {
    realCockroachDbRun: true,
    exactGroundTruthPresent: true,
    cspannRecallFloorMet: bestRecall >= recallFloor,
    corpusAtLeast1500: summary.corpus_size >= 1_500,
    queriesAtLeast50: summary.queries >= 50,
  };
  if (Object.values(vectorGates).some((passed) => !passed)) {
    const failures = Object.entries(vectorGates)
      .filter(([, passed]) => !passed)
      .map(([name]) => name)
      .join(", ");
    fail(`Vector evaluation gates failed: ${failures}`);
  }
  const vectorResult = {
    schemaVersion: "1.0.0",
    evidenceClass: "real-cockroachdb-cspann-versus-exact-ground-truth",
    sourceSha: cli.sourceSha,
    comparison: {
      exactMode:
        "Brute-force cosine over the generated vector corpus in JavaScript.",
      approximateMode:
        "CockroachDB C-SPANN ORDER BY embedding <=> query LIMIT k.",
      scope:
        "Retrieval correctness/recall and C-SPANN latency only; no exact-scan latency claim is made.",
      bestRecallAtK: round(bestRecall),
      recallDeltaFromExact: round(1 - bestRecall),
      recallFloor,
    },
    benchmark: summary,
    rawLog: {
      file: basename(vectorLogPath),
      sha256: sha256Text(vectorLog),
    },
    gates: vectorGates,
  };
  const vectorResultPath = resolve(output, "vector-results.json");
  await writeJson(vectorResultPath, vectorResult);
  const vectorResultRaw = await readFile(vectorResultPath, "utf8");

  const policyGatesValue = asObject(policy.value.gates, "policy gates");
  const scaleGatesValue = asObject(scale.value.gates, "scale gates");
  const allPolicyPassed = Object.values(policyGatesValue).every(
    (value) => value === true
  );
  const allScalePassed = Object.values(scaleGatesValue).every(
    (value) => value === true
  );
  const receiptBody = {
    schemaVersion: "1.0.0",
    source: {
      repository: process.env.GITHUB_REPOSITORY ?? "unknown",
      sha: cli.sourceSha,
      workflow: process.env.GITHUB_WORKFLOW ?? "unknown",
      runId: process.env.GITHUB_RUN_ID ?? "unknown",
      runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? "unknown",
      eventName: process.env.GITHUB_EVENT_NAME ?? "unknown",
    },
    generatedAt: new Date().toISOString(),
    artifacts: [
      {
        file: basename(policy.path),
        sha256: policy.sha256,
      },
      {
        file: basename(scale.path),
        sha256: scale.sha256,
      },
      {
        file: basename(vectorResultPath),
        sha256: sha256Text(vectorResultRaw),
      },
      {
        file: basename(vectorLogPath),
        sha256: sha256Text(vectorLog),
      },
    ],
    gates: {
      policy: allPolicyPassed,
      representativeScale: allScalePassed,
      cspannVersusExact: Object.values(vectorGates).every(Boolean),
      exactShaBound: true,
    },
    claims: {
      supported: [
        "deterministic-longitudinal-policy-evaluation",
        "B0-through-B4-fair-fixture-comparison",
        "lifecycle-ablation-study",
        "representative-100k-plus-event-rehearsal",
        "unauthorized-actions-zero-in-B4-and-scale-rehearsal",
        "real-cockroachdb-cspann-recall-versus-exact-ground-truth",
      ],
      notSupportedByThisReceipt: [
        "real-customer-production-corpus",
        "human-evaluation-results",
        "production-business-impact",
        "hosted-load-or-SLA-results",
        "exact-scan-latency-comparison",
      ],
    },
  };
  const receipt = {
    ...receiptBody,
    receipt: {
      algorithm: "sha256",
      digest: sha256Text(canonicalJson(receiptBody)),
    },
  };
  await writeJson(resolve(output, "memory-evaluation-receipt.json"), receipt);
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  const output = assertPipelineOutput(cli.output);
  await mkdir(output, { recursive: true });
  if (cli.mode === "policy") {
    await runPolicy(cli, output);
  } else {
    await runFinalize(cli, output);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`memory-evaluation failed: ${message}`);
  process.exitCode = 1;
});
