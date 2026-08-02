export type DecisionOutcome = "approved" | "rejected";

export interface EvaluationEvidence {
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

export interface ExpectedAction {
  type: string;
  target: string;
  parameters: Record<string, string>;
  idempotencyId: string;
}

export interface ActionProposal {
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

export interface EvaluationCase {
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
  evidence: EvaluationEvidence[];
  action?: ActionProposal;
  expected: {
    answerEvidenceId: string | null;
    evidenceIds: string[];
    abstain: boolean;
    conflict: boolean;
    action: ExpectedAction | null;
  };
}

export interface EvaluationFixture {
  schemaVersion: string;
  dataset: Record<string, unknown>;
  defaults: {
    semanticThreshold: number;
    authorityMargin: number;
  };
  cases: EvaluationCase[];
}

export interface Prediction {
  answerEvidenceId: string | null;
  evidenceIds: string[];
  abstain: boolean;
  conflict: boolean;
  action: ExpectedAction | null;
  unauthorizedActions: number;
  actionExecutions: number;
  decisionDuplicateSuppressions: number;
}

export interface VariantMetrics {
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
  proposalDecisionCases: number;
  proposalDecisionCorrect: number;
  proposalDecisionAccuracy: number;
  safeNoActionCases: number;
  safeNoActionCorrect: number;
  safeNoActionRate: number;
  exactActionCases: number;
  exactActionCorrect: number;
  exactActionMatch: number;
  unauthorizedActions: number;
  actionExecutions: number;
  decisionDuplicateSuppressions: number;
}

export interface VariantResult {
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

export interface VariantConfig {
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

export interface PolicyEvaluation {
  fixture: EvaluationFixture;
  baselines: VariantResult[];
  ablations: VariantResult[];
  gates: Record<string, boolean>;
}

export interface VectorBenchmarkSummary {
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

export interface VectorBenchmarkProvenance {
  schemaVersion: "1.0.0";
  evidenceClass: "exact-sha-vector-benchmark-provenance";
  sourceSha: string;
  benchmark: {
    sourcePath: "scripts/benchmark.ts";
    sourceSha256: string;
    logSha256: string;
    completed: boolean;
    sourceContract: {
      exactTopKDefined: boolean;
      truthSetUsesExactTopK: boolean;
      cspannDistanceQueryPresent: boolean;
    };
  };
  database: {
    product: "CockroachDB";
    version: string;
    querySucceeded: boolean;
  };
  exactGroundTruth: {
    method: "deterministic-seeded-brute-force-cosine-js";
    corpusSize: number;
    queries: number;
    topK: number;
  };
  approximateSearch: {
    method: "cockroachdb-cspann-cosine";
    distanceOperator: "<=>";
    queries: number;
    topK: number;
  };
}

export interface VectorEvidenceGates {
  benchmarkLogBound: boolean;
  benchmarkSourceBound: boolean;
  realCockroachDbRun: boolean;
  exactGroundTruthPresent: boolean;
  cspannQueryContractPresent: boolean;
}

interface ClassificationCounts {
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  trueNegative: number;
}

function fail(message: string): never {
  throw new Error(message);
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${label} must be a non-empty string.`);
  }
  return value;
}

function isoMillis(value: unknown, label: string): number {
  if (typeof value !== "string") {
    fail(`${label} must be a timestamp string.`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail(`${label} is not a valid timestamp.`);
  return parsed;
}

function round(value: number, digits = 6): number {
  return Number(value.toFixed(digits));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [
          key,
          canonicalize((value as Record<string, unknown>)[key]),
        ])
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function validateEvaluationFixture(raw: unknown): EvaluationFixture {
  const root = asObject(raw, "fixture");
  if (root.schemaVersion !== "1.0.0") {
    fail("Unsupported evaluation fixture schemaVersion.");
  }
  asObject(root.dataset, "fixture.dataset");
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
  const coverage = {
    temporal: 0,
    longitudinal: 0,
    conflict: 0,
    abstention: 0,
    proposals: 0,
    expectedActions: 0,
    safeNoActionProposals: 0,
  };
  for (const testCase of fixture.cases) {
    nonEmptyString(testCase.id, "case.id");
    if (caseIds.has(testCase.id)) {
      fail(`Duplicate case id "${testCase.id}".`);
    }
    caseIds.add(testCase.id);
    if (!Array.isArray(testCase.tags) || testCase.tags.length === 0) {
      fail(`${testCase.id}: tags are required.`);
    }
    testCase.tags.forEach((tag, index) =>
      nonEmptyString(tag, `${testCase.id}.tags[${index}]`)
    );
    if (testCase.tags.includes("temporal")) coverage.temporal++;
    if (testCase.tags.includes("longitudinal")) coverage.longitudinal++;
    if (testCase.expected.conflict) coverage.conflict++;
    if (testCase.expected.abstain) coverage.abstention++;
    nonEmptyString(testCase.query.sessionId, `${testCase.id}.query.sessionId`);
    nonEmptyString(testCase.query.tenantId, `${testCase.id}.query.tenantId`);
    nonEmptyString(testCase.query.company, `${testCase.id}.query.company`);
    nonEmptyString(testCase.query.topic, `${testCase.id}.query.topic`);
    nonEmptyString(testCase.query.text, `${testCase.id}.query.text`);
    const asOf = isoMillis(
      testCase.query.asOf,
      `${testCase.id}.query.asOf`
    );
    if (!Array.isArray(testCase.evidence) || testCase.evidence.length === 0) {
      fail(`${testCase.id}: at least one evidence item is required.`);
    }

    const evidenceIds = new Set<string>();
    for (const evidence of testCase.evidence) {
      nonEmptyString(evidence.id, `${testCase.id}.evidence.id`);
      if (evidenceIds.has(evidence.id)) {
        fail(`${testCase.id}: duplicate evidence id "${evidence.id}".`);
      }
      evidenceIds.add(evidence.id);
      nonEmptyString(
        evidence.sessionId,
        `${testCase.id}.${evidence.id}.sessionId`
      );
      nonEmptyString(
        evidence.tenantId,
        `${testCase.id}.${evidence.id}.tenantId`
      );
      nonEmptyString(
        evidence.company,
        `${testCase.id}.${evidence.id}.company`
      );
      nonEmptyString(evidence.topic, `${testCase.id}.${evidence.id}.topic`);
      nonEmptyString(evidence.text, `${testCase.id}.${evidence.id}.text`);
      nonEmptyString(evidence.value, `${testCase.id}.${evidence.id}.value`);
      const observedAt = isoMillis(
        evidence.observedAt,
        `${testCase.id}.${evidence.id}.observedAt`
      );
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
        typeof evidence.semanticScore !== "number" ||
        evidence.semanticScore < 0 ||
        evidence.semanticScore > 1 ||
        !Number.isFinite(evidence.authorityRank)
      ) {
        fail(`${testCase.id}.${evidence.id}: score/rank is invalid.`);
      }
      if (observedAt > asOf) {
        fail(`${testCase.id}.${evidence.id}: future-ingested evidence is forbidden.`);
      }
    }

    if (
      testCase.expected.answerEvidenceId !== null &&
      !evidenceIds.has(testCase.expected.answerEvidenceId)
    ) {
      fail(`${testCase.id}: expected answer evidence does not exist.`);
    }
    if (!Array.isArray(testCase.expected.evidenceIds)) {
      fail(`${testCase.id}: expected evidence ids must be an array.`);
    }
    for (const evidenceId of testCase.expected.evidenceIds) {
      if (!evidenceIds.has(evidenceId)) {
        fail(`${testCase.id}: expected evidence "${evidenceId}" does not exist.`);
      }
    }
    if (
      testCase.expected.abstain !==
      (testCase.expected.answerEvidenceId === null)
    ) {
      fail(`${testCase.id}: abstention and expected answer disagree.`);
    }
    if (testCase.expected.action !== null && !testCase.action) {
      fail(`${testCase.id}: expected action has no proposal.`);
    }
    if (testCase.action) {
      coverage.proposals++;
      const action = testCase.action;
      nonEmptyString(action.type, `${testCase.id}.action.type`);
      nonEmptyString(action.target, `${testCase.id}.action.target`);
      nonEmptyString(action.requiredRole, `${testCase.id}.action.requiredRole`);
      nonEmptyString(
        action.idempotencyId,
        `${testCase.id}.action.idempotencyId`
      );
      if (
        !evidenceIds.has(action.proposedEvidenceId) ||
        !evidenceIds.has(action.supersedesEvidenceId)
      ) {
        fail(`${testCase.id}: action references unknown evidence.`);
      }
      if (
        !Number.isSafeInteger(action.decisionAttempts) ||
        action.decisionAttempts < 0
      ) {
        fail(`${testCase.id}: decisionAttempts is invalid.`);
      }
      if (
        (action.decision === null && action.decisionAttempts !== 0) ||
        (action.decision !== null && action.decisionAttempts < 1)
      ) {
        fail(`${testCase.id}: decisionAttempts and decision disagree.`);
      }
      if (testCase.expected.action === null) {
        coverage.safeNoActionProposals++;
      } else {
        coverage.expectedActions++;
        if (
          canonicalJson(testCase.expected.action) !==
          canonicalJson(exactAction(action))
        ) {
          fail(`${testCase.id}: expected action does not match its proposal.`);
        }
      }
    }
  }
  for (const [name, count] of Object.entries(coverage)) {
    if (count === 0) {
      fail(`Evaluation fixture has no ${name} coverage.`);
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

function observedByQuery(
  evidence: EvaluationEvidence,
  testCase: EvaluationCase
): boolean {
  return Date.parse(evidence.observedAt) <= Date.parse(testCase.query.asOf);
}

function inScope(
  evidence: EvaluationEvidence,
  testCase: EvaluationCase
): boolean {
  return (
    evidence.tenantId === testCase.query.tenantId &&
    evidence.company === testCase.query.company
  );
}

function temporallyValid(
  evidence: EvaluationEvidence,
  testCase: EvaluationCase
): boolean {
  const at = Date.parse(testCase.query.asOf);
  return (
    Date.parse(evidence.validFrom) <= at &&
    (evidence.validTo === null || at < Date.parse(evidence.validTo))
  );
}

function retainedForRecall(
  evidence: EvaluationEvidence,
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

function sortSemantic(
  left: EvaluationEvidence,
  right: EvaluationEvidence
): number {
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

export function predictVariant(
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

export function evaluateVariant(
  fixture: EvaluationFixture,
  config: VariantConfig
): VariantResult {
  const predictions = fixture.cases.map((testCase) => ({
    caseId: testCase.id,
    expected: testCase.expected,
    actual: predictVariant(testCase, fixture, config),
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

  const proposalPredictions = predictions.filter(
    (item) => fixture.cases.find((testCase) => testCase.id === item.caseId)?.action
  );
  const safeNoActionPredictions = proposalPredictions.filter(
    (item) => item.expected.action === null
  );
  const exactActionPredictions = proposalPredictions.filter(
    (item) => item.expected.action !== null
  );
  const proposalDecisionCorrect = proposalPredictions.filter(
    (item) =>
      (item.actual.action === null) === (item.expected.action === null)
  ).length;
  const safeNoActionCorrect = safeNoActionPredictions.filter(
    (item) => item.actual.action === null
  ).length;
  const exactActionCorrect = exactActionPredictions.filter(
    (item) =>
      canonicalJson(item.actual.action) === canonicalJson(item.expected.action)
  ).length;

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
      proposalDecisionCases: proposalPredictions.length,
      proposalDecisionCorrect,
      proposalDecisionAccuracy: round(
        proposalPredictions.length === 0
          ? 1
          : proposalDecisionCorrect / proposalPredictions.length
      ),
      safeNoActionCases: safeNoActionPredictions.length,
      safeNoActionCorrect,
      safeNoActionRate: round(
        safeNoActionPredictions.length === 0
          ? 1
          : safeNoActionCorrect / safeNoActionPredictions.length
      ),
      exactActionCases: exactActionPredictions.length,
      exactActionCorrect,
      exactActionMatch: round(
        exactActionPredictions.length === 0
          ? 1
          : exactActionCorrect / exactActionPredictions.length
      ),
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

export const BASELINE_VARIANTS: readonly VariantConfig[] = Object.freeze([
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
    description:
      "Persistent lexical overlap only; a deliberately simple research baseline.",
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
    description:
      "Vector-score-only selection over the same candidates; no lifecycle policy.",
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
    description:
      "Scoped temporal memory with contradiction, source authority, abstention, human-gated consolidation, and idempotent actions.",
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
]);

const fullLifecycle = BASELINE_VARIANTS[4];
if (!fullLifecycle) fail("B4_FULL_LIFECYCLE configuration is missing.");

export const ABLATION_VARIANTS: readonly VariantConfig[] = Object.freeze([
  {
    ...fullLifecycle,
    id: "A_NO_SCOPE",
    description: "B4 without tenant/company scope filtering.",
    productionEligible: false,
    useScope: false,
  },
  {
    ...fullLifecycle,
    id: "A_NO_TEMPORAL",
    description: "B4 without valid-time filtering.",
    productionEligible: false,
    useTemporal: false,
  },
  {
    ...fullLifecycle,
    id: "A_NO_CONTRADICTION",
    description: "B4 without contradiction detection.",
    productionEligible: false,
    useContradiction: false,
  },
  {
    ...fullLifecycle,
    id: "A_NO_AUTHORITY",
    description: "B4 without source-authority ranking.",
    productionEligible: false,
    useAuthority: false,
  },
  {
    ...fullLifecycle,
    id: "A_NO_ABSTENTION",
    description:
      "B4 forced to select even below threshold or amid unresolved conflict.",
    productionEligible: false,
    useAbstention: false,
  },
  {
    ...fullLifecycle,
    id: "A_NO_CONSOLIDATION",
    description: "B4 ignores approved/rejected consolidation decisions.",
    productionEligible: false,
    useConsolidation: false,
  },
  {
    ...fullLifecycle,
    id: "A_NO_FORGETTING",
    description: "B4 recalls retracted or retention-expired memory.",
    productionEligible: false,
    useForgetting: false,
  },
  {
    ...fullLifecycle,
    id: "A_NO_HUMAN_GATE",
    description: "B4 treats missing or wrong-role approval as authorization.",
    productionEligible: false,
    useHumanGate: false,
  },
]);

function byId(results: VariantResult[], id: string): VariantResult {
  const result = results.find((item) => item.id === id);
  if (!result) fail(`Missing evaluation variant ${id}.`);
  return result;
}

export function policyGates(
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
    b4ProposalCasesPresent: b4.proposalDecisionCases > 0,
    b4PerfectProposalDecisionAccuracy: b4.proposalDecisionAccuracy === 1,
    b4SafeNoActionCasesPresent: b4.safeNoActionCases > 0,
    b4PerfectSafeNoActionRate: b4.safeNoActionRate === 1,
    b4ExactActionCasesPresent: b4.exactActionCases > 0,
    b4ExactActionsMatch: b4.exactActionMatch === 1,
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

export function evaluateMemoryPolicy(raw: unknown): PolicyEvaluation {
  const fixture = validateEvaluationFixture(raw);
  const baselines = BASELINE_VARIANTS.map((config) =>
    evaluateVariant(fixture, config)
  );
  const ablations = ABLATION_VARIANTS.map((config) =>
    evaluateVariant(fixture, config)
  );
  return {
    fixture,
    baselines,
    ablations,
    gates: policyGates(baselines, ablations),
  };
}

export function parseVectorBenchmarkSummary(
  raw: string
): VectorBenchmarkSummary {
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
    Number(parsed.corpus_size) <= 0 ||
    !Number.isSafeInteger(parsed.queries) ||
    Number(parsed.queries) <= 0 ||
    !Number.isSafeInteger(parsed.top_k) ||
    Number(parsed.top_k) <= 0 ||
    !Number.isSafeInteger(parsed.dim) ||
    Number(parsed.dim) <= 0 ||
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
      !(
        item.beam === null ||
        (Number.isSafeInteger(item.beam) && Number(item.beam) > 0)
      ) ||
      typeof item.recall_at_k_mean !== "number" ||
      item.recall_at_k_mean < 0 ||
      item.recall_at_k_mean > 1 ||
      typeof item.recall_at_k_min !== "number" ||
      item.recall_at_k_min < 0 ||
      item.recall_at_k_min > 1 ||
      !["latency_ms_p50", "latency_ms_p95", "latency_ms_p99", "latency_ms_mean"].every(
        (key) => typeof item[key] === "number" && Number(item[key]) >= 0
      )
    ) {
      fail("Vector benchmark beam metrics are invalid.");
    }
  }
  return parsed as unknown as VectorBenchmarkSummary;
}

export function deriveVectorEvidenceGates(
  raw: unknown,
  summary: VectorBenchmarkSummary,
  expected: {
    sourceSha: string;
    vectorLogSha256: string;
  }
): {
  provenance: VectorBenchmarkProvenance;
  gates: VectorEvidenceGates;
} {
  const root = asObject(raw, "vector benchmark provenance");
  const benchmark = asObject(root.benchmark, "vector benchmark provenance.benchmark");
  const sourceContract = asObject(
    benchmark.sourceContract,
    "vector benchmark provenance.benchmark.sourceContract"
  );
  const database = asObject(root.database, "vector benchmark provenance.database");
  const exact = asObject(
    root.exactGroundTruth,
    "vector benchmark provenance.exactGroundTruth"
  );
  const approximate = asObject(
    root.approximateSearch,
    "vector benchmark provenance.approximateSearch"
  );
  const provenance = raw as VectorBenchmarkProvenance;
  const shaPattern = /^[a-f0-9]{64}$/u;
  const sourceShaPattern = /^[a-f0-9]{40}$/u;
  if (
    root.schemaVersion !== "1.0.0" ||
    root.evidenceClass !== "exact-sha-vector-benchmark-provenance" ||
    !sourceShaPattern.test(String(root.sourceSha ?? "")) ||
    benchmark.sourcePath !== "scripts/benchmark.ts" ||
    !shaPattern.test(String(benchmark.sourceSha256 ?? "")) ||
    !shaPattern.test(String(benchmark.logSha256 ?? "")) ||
    typeof database.version !== "string"
  ) {
    fail("Vector benchmark provenance has an invalid shape.");
  }
  const gates: VectorEvidenceGates = {
    benchmarkLogBound:
      root.sourceSha === expected.sourceSha &&
      benchmark.logSha256 === expected.vectorLogSha256,
    benchmarkSourceBound:
      benchmark.completed === true &&
      sourceContract.exactTopKDefined === true &&
      sourceContract.truthSetUsesExactTopK === true &&
      sourceContract.cspannDistanceQueryPresent === true,
    realCockroachDbRun:
      benchmark.completed === true &&
      database.product === "CockroachDB" &&
      database.querySucceeded === true &&
      /CockroachDB/u.test(String(database.version)),
    exactGroundTruthPresent:
      exact.method === "deterministic-seeded-brute-force-cosine-js" &&
      sourceContract.exactTopKDefined === true &&
      sourceContract.truthSetUsesExactTopK === true &&
      exact.corpusSize === summary.corpus_size &&
      exact.queries === summary.queries &&
      exact.topK === summary.top_k,
    cspannQueryContractPresent:
      approximate.method === "cockroachdb-cspann-cosine" &&
      approximate.distanceOperator === "<=>" &&
      sourceContract.cspannDistanceQueryPresent === true &&
      approximate.queries === summary.queries &&
      approximate.topK === summary.top_k,
  };
  return { provenance, gates };
}
