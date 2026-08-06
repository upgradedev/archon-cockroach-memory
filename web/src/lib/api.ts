export const PUBLIC_COMPANY = "Helios SA";
const RELEASE_EVIDENCE = "server-configured Lambda environment";
const EXACT_COMMIT_SHA = /^[0-9a-f]{40}$/u;
const EXACT_RUNTIME_PRINCIPAL =
  /^archon_(?:staging|production)_[0-9a-f]{10}$/u;
const EXACT_UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const EMBEDDING_MODEL = "amazon.titan-embed-text-v2:0";
const NARRATION_MODEL = "eu.anthropic.claude-sonnet-4-6";
const RESOLUTION_RATIONALE =
  "Prefer the newer signed payroll register, but preserve both sources and require a financial controller decision.";
const RESOLUTION_STATE_CONTRACT = {
  pending: {
    priorStatus: "current",
    correctedStatus: "candidate",
    learning: "two-source-conflict-observed",
    consolidation: "awaiting-human-decision",
    forgetting: "session-scoped-ttl-pending",
  },
  approved: {
    priorStatus: "superseded",
    correctedStatus: "current",
    learning: "human-approved-correction",
    consolidation: "approved-observation-is-current",
    forgetting: "session-scoped-ttl-after-decision",
  },
  rejected: {
    priorStatus: "current",
    correctedStatus: "rejected",
    learning: "human-rejected-correction",
    consolidation: "prior-observation-remains-current",
    forgetting: "session-scoped-ttl-after-decision",
  },
} as const;

type JsonRecord = Record<string, unknown>;

export class PublicApiError extends Error {
  readonly endpoint: string;
  readonly status: number | null;

  constructor(endpoint: string, message: string, status: number | null = null) {
    super(message);
    this.name = "PublicApiError";
    this.endpoint = endpoint;
    this.status = status;
  }
}

export interface ServiceHealth {
  ok: boolean;
  status: "reachable" | "degraded";
  service: string;
  version: string | null;
  dependencies: "unchecked" | "ready" | null;
  scope: {
    tenantId: string | null;
    company: string | null;
    mode: string | null;
    access: string | null;
  } | null;
}

export interface RecallCitation {
  marker: string;
  memoryId: string;
  kind: string;
  company: string;
  period: string | null;
  score: number | null;
  content: string;
  sourceRef: string | null;
}

export interface RecallTrace {
  retrieval: string | null;
  grounding: string | null;
  durationMs: number | null;
}

export interface RecallResult {
  question: string;
  answer: string;
  modelId: string;
  recalled: number;
  citations: RecallCitation[];
  consistencyOk: boolean | null;
  trace: RecallTrace;
  degraded: boolean;
  warning: string | null;
  noEvidence: boolean;
}

export interface AuditValue {
  memoryId: string;
  sourceRef: string | null;
  value: unknown;
  createdAt: string | null;
}

export interface AuditResolution {
  recommendedMemoryId: string | null;
  recommendedValue: unknown;
  rule: string;
  confidence: number | null;
  rationale: string;
}

export interface AuditConflict {
  subject: string;
  attribute: string;
  values: AuditValue[];
  resolution: AuditResolution | null;
}

export interface AuditAbsence {
  subject: string;
  referencedBy: Array<{ memoryId: string; sourceRef: string | null }>;
  recommendation: string | null;
}

export interface AuditReport {
  audited: number | null;
  subjects: number | null;
  conflicts: AuditConflict[];
  absences: AuditAbsence[];
  recommendations: string[];
  ok: boolean;
  summary: string | null;
  memoryCount: number | null;
  generatedAt: string | null;
  coverage: {
    total: number | null;
    scanned: number | null;
    limit: number | null;
    complete: boolean;
  };
}

export interface ProofSnapshot {
  database: {
    provider: string | null;
    version: string | null;
    region: string | null;
    regionEvidence: string | null;
    runtimePrincipal: string | null;
    topology: string | null;
    activeMemories: number | null;
  };
  vectorIndex: {
    enabled: boolean | null;
    name: string | null;
    dimensions: number | null;
    metric: string | null;
    engine: string | null;
    lifecycleState: string | null;
    evidence: string | null;
    definitionFingerprint: string | null;
    plan: string | null;
    recallAt10Percent: number | null;
    p95Ms: number | null;
  };
  resolutionLoop: {
    enabled: boolean;
    schemaTables: number | null;
    activeSandboxSessions: number | null;
    transactionIsolation: string | null;
    authorityBoundary: string | null;
    identityAssurance: string | null;
    idempotency: string | null;
    receipt: string | null;
    learning: string | null;
    consolidation: string | null;
    forgetting: string | null;
    canonicalMemoryMutable: boolean | null;
    externalSideEffects: string | null;
    evidence: string | null;
  };
  embeddingModel: string | null;
  narrationModel: string | null;
  scope: {
    company: string;
    mode: string | null;
  };
  memory: {
    persisted: number | null;
    idempotencyKeys: number | null;
    contentDigests: number | null;
    storeVerified: boolean | null;
    evidence: string | null;
  };
  release: {
    commitSha: string | null;
    evidence: string | null;
  };
  features: string[];
  memoryCount: number | null;
  generatedAt: string | null;
  hasEvidence: boolean;
}

export type ResolutionDecision = "approve" | "reject";
export type ResolutionState = "pending" | "approved" | "rejected";

export interface ResolutionObservation {
  id: string;
  label: "prior" | "corrected";
  sourceRef: string;
  sourceClass: "payroll-register" | "signed-payroll-register";
  observedAt: string;
  authorityRank: number;
  employerCostCents: number;
  employerCostDisplay: string;
  status: "candidate" | "current" | "superseded" | "rejected";
}

export interface ResolutionSnapshot {
  sessionId: string;
  scenarioId: "helios-payroll-2026-06-correction-v1";
  company: "Helios SA";
  period: "2026-06";
  state: ResolutionState;
  expiresAt: string;
  observations: ResolutionObservation[];
  proposal: {
    id: string;
    action: "resolve-conflicting-memory";
    status: ResolutionState;
    proposedObservationId: string;
    supersedesObservationId: string;
    rationale: string;
    requiresHumanRole: "financial-controller";
  };
  receipt: {
    algorithm: "sha256";
    digest: string;
    decisionId: string;
    decidedAt: string;
    actorRole: "financial-controller";
    policyVersion: "resolution-policy-v1";
  } | null;
  lifecycle: {
    learning:
      | "two-source-conflict-observed"
      | "human-approved-correction"
      | "human-rejected-correction";
    consolidation:
      | "awaiting-human-decision"
      | "approved-observation-is-current"
      | "prior-observation-remains-current";
    forgetting:
      | "session-scoped-ttl-pending"
      | "session-scoped-ttl-after-decision";
    externalSideEffects: "none";
  };
  policy: {
    version: "resolution-policy-v1";
    conflictRule: "newer-higher-authority-evidence-is-proposed";
    authorityBoundary: "human-approval-required";
    mutationScope: "ephemeral-synthetic-session-only";
    retention: "row-level-ttl";
    canonicalMemoryMutable: false;
  };
}

export interface ResolutionSession {
  token: string;
  snapshot: ResolutionSnapshot;
}

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function asNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function asBoolean(...values: unknown[]): boolean | null {
  for (const value of values) {
    if (typeof value === "boolean") return value;
    if (value === "true") return true;
    if (value === "false") return false;
  }
  return null;
}

function nested(record: JsonRecord | null, key: string): JsonRecord | null {
  return record ? asRecord(record[key]) : null;
}

function unwrap(value: unknown, key?: string): JsonRecord {
  const root = asRecord(value);
  if (!root) throw new PublicApiError("response", "The service returned an unreadable response.");
  if (key) return asRecord(root[key]) ?? root;
  return asRecord(root.data) ?? root;
}

function publicErrorMessage(body: unknown, fallback: string): string {
  const record = asRecord(body);
  const message = asString(record?.error, record?.message);
  return message && message.length <= 240 ? message : fallback;
}

async function requestJson(path: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      signal,
      headers: {
        accept: "application/json",
        ...init.headers,
      },
    });
  } catch {
    throw new PublicApiError(path, "The live service could not be reached.");
  }

  const text = await response.text();
  let body: unknown = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      if (!response.ok) {
        throw new PublicApiError(path, `The service returned HTTP ${response.status}.`, response.status);
      }
      throw new PublicApiError(path, "The service returned a non-JSON response.", response.status);
    }
  }

  if (!response.ok) {
    throw new PublicApiError(
      path,
      publicErrorMessage(body, `The service returned HTTP ${response.status}.`),
      response.status,
    );
  }
  return body;
}

export async function getHealth(signal?: AbortSignal): Promise<ServiceHealth> {
  const body = unwrap(await requestJson("/api/health", { method: "GET" }, signal));
  const ok = asBoolean(body.ok) ?? false;
  const rawStatus = asString(body.status)?.toLowerCase();
  const scope = nested(body, "scope");
  return {
    ok,
    status: ok && rawStatus === "reachable" ? "reachable" : "degraded",
    service: asString(body.service) ?? "archon-memory",
    version: asString(body.version),
    dependencies:
      asString(body.dependencies) === "ready"
        ? "ready"
        : asString(body.dependencies) === "unchecked"
          ? "unchecked"
          : null,
    scope: scope
      ? {
          tenantId: asString(scope.tenantId, scope.tenant_id),
          company: asString(scope.company),
          mode: asString(scope.mode),
          access: asString(scope.access),
        }
      : null,
  };
}

function normalizeCitation(value: unknown): RecallCitation | null {
  const item = asRecord(value);
  if (!item) return null;
  const content = asString(item.content);
  const marker = asString(item.marker);
  const memoryId = asString(item.memoryId);
  const company = asString(item.company);
  const score = asNumber(item.score);
  if (
    !content ||
    !marker ||
    !/^\[\d+\]$/u.test(marker) ||
    !memoryId ||
    company !== PUBLIC_COMPANY ||
    score === null ||
    score < 0 ||
    score > 1
  ) {
    return null;
  }
  return {
    marker,
    memoryId,
    kind: asString(item.kind) ?? "memory",
    company,
    period: asString(item.period),
    score,
    content,
    sourceRef: asString(item.sourceRef),
  };
}

export async function recallMemory(
  question: string,
  signal?: AbortSignal,
): Promise<RecallResult> {
  const body = unwrap(
    await requestJson(
      "/api/recall",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question, limit: 5 }),
      },
      signal,
    ),
  );

  const answer = asString(body.answer);
  if (!answer) {
    throw new PublicApiError("/api/recall", "Recall completed without a grounded answer.");
  }

  const rawCitations = asArray(body.citations);
  const citations = rawCitations
    .map(normalizeCitation)
    .filter((item): item is RecallCitation => item !== null);
  const trace = asRecord(body.trace);
  const retrieval = nested(trace, "retrieval");
  const narration = nested(trace, "narration");
  const groundingRecord =
    nested(narration, "grounding") ?? asRecord(body.grounding);
  const groundingChecks = nested(groundingRecord, "checks");
  const grounding = asString(
    groundingRecord?.status,
    narration?.grounding,
    trace?.grounding,
    body.groundingStatus,
    body.grounding,
  );
  const echoedQuestion = asString(body.question);
  const recalled = asNumber(body.recalled);
  const modelId = asString(body.modelId);
  const retrievalLabel = [
    asString(retrieval?.index, retrieval?.strategy, trace?.strategy),
    asString(retrieval?.metric),
  ].filter((value): value is string => value !== null).join(" · ");
  const normalizedTrace: RecallTrace = {
    retrieval: retrievalLabel || asString(trace?.retrieval, trace?.strategy),
    grounding,
    durationMs: asNumber(
      narration?.durationMs,
      trace?.durationMs,
      trace?.latencyMs,
      body.durationMs,
    ),
  };

  if (grounding === "no-evidence") {
    const canonicalNoEvidence =
      "No relevant memories found in the agent's CockroachDB memory.";
    if (
      echoedQuestion !== question.trim() ||
      recalled !== 0 ||
      rawCitations.length !== 0 ||
      citations.length !== 0 ||
      answer !== canonicalNoEvidence ||
      !modelId ||
      !(
        asBoolean(groundingChecks?.citations) === false &&
        asBoolean(groundingChecks?.numerics) === false &&
        asBoolean(groundingChecks?.claims) === false
      )
    ) {
      throw new PublicApiError(
        "/api/recall",
        "Recall returned an invalid no-evidence response.",
      );
    }
    return {
      question: echoedQuestion,
      answer,
      modelId,
      recalled,
      citations,
      consistencyOk: asBoolean(body.consistencyOk, nested(body, "consistency")?.ok),
      trace: normalizedTrace,
      degraded: /fake|offline/iu.test(modelId),
      warning: null,
      noEvidence: true,
    };
  }

  if (
    citations.length === 0 ||
    citations.length !== rawCitations.length ||
    new Set(citations.map((citation) => citation.marker)).size !==
      citations.length ||
    citations.some(
      (citation, index) => citation.marker !== `[${index + 1}]`,
    )
  ) {
    throw new PublicApiError(
      "/api/recall",
      "Recall returned missing or malformed CockroachDB citations, so no answer is displayed.",
    );
  }
  if (
    grounding !== "verified" &&
    grounding !== "extractive" &&
    grounding !== "fallback"
  ) {
    throw new PublicApiError(
      "/api/recall",
      "Recall did not report a verified, extractive, or deterministic-fallback grounding state.",
    );
  }
  if (
    echoedQuestion !== question.trim() ||
    recalled === null ||
    !Number.isInteger(recalled) ||
    recalled <= 0 ||
    recalled !== citations.length ||
    !modelId
  ) {
    throw new PublicApiError(
      "/api/recall",
      "Recall response did not match the canonical request, evidence count, or model contract.",
    );
  }
  const knownMarkers = new Set(citations.map((citation) => citation.marker));
  const answerMarkers = [...answer.matchAll(/\[\d+\]/gu)].map(
    (match) => match[0]
  );
  if (
    answerMarkers.length === 0 ||
    answerMarkers.some((marker) => !knownMarkers.has(marker))
  ) {
    throw new PublicApiError(
      "/api/recall",
      "Recall answer contained missing or unknown evidence markers.",
    );
  }
  if (
    (grounding === "verified" || grounding === "extractive") &&
    !(
      asBoolean(groundingChecks?.citations) === true &&
      asBoolean(groundingChecks?.numerics) === true &&
      asBoolean(groundingChecks?.claims) === true
    )
  ) {
    throw new PublicApiError(
      "/api/recall",
      "Recall claimed safe grounding without all evidence checks passing.",
    );
  }
  const deterministicFallback =
    "Retrieved evidence from the agent's CockroachDB memory: " +
    citations
      .map((citation) => `${citation.marker} ${citation.content}`)
      .join(" ");
  if (grounding === "fallback" && answer !== deterministicFallback) {
    throw new PublicApiError(
      "/api/recall",
      "Recall fallback did not match the deterministic cited evidence rendering.",
    );
  }
  const deterministicExtractive = citations
    .flatMap((citation) =>
      citation.content
        .split(/(?<=[.!?])\s+|\n+/gu)
        .map((claim) => claim.trim())
        .filter(Boolean)
        .map(
          (claim) =>
            `${claim.replace(/[.!?]+$/u, "").trim()} ${citation.marker}.`,
        ),
    )
    .join(" ");
  if (grounding === "extractive" && answer !== deterministicExtractive) {
    throw new PublicApiError(
      "/api/recall",
      "Recall extractive answer did not match the exact cited evidence rendering.",
    );
  }
  const degraded =
    (asBoolean(body.degraded) ?? false) ||
    /fake|offline/iu.test(modelId) ||
    grounding === "fallback";
  const warning =
    grounding === "extractive"
      ? "Model paraphrase was withheld; the displayed answer is exact revalidated CockroachDB evidence."
      : grounding === "fallback"
        ? "Model output did not pass the grounding guard; the displayed answer is the deterministic cited fallback."
        : asString(body.warning);

  return {
    question: echoedQuestion,
    answer,
    modelId,
    recalled,
    citations,
    consistencyOk: asBoolean(body.consistencyOk, nested(body, "consistency")?.ok),
    trace: normalizedTrace,
    degraded,
    warning,
    noEvidence: false,
  };
}

export interface SandboxFactInput {
  sandboxToken?: string;
  company: string;
  fact: string;
  sourceRef: string;
  subject: string;
  attribute: string;
  numericValue: number;
}

export interface SandboxIngestResult {
  sandboxToken: string;
  memoryId: string;
  reused: boolean;
  ttlSeconds: number;
  expiresAt: string;
}

export interface SandboxCitation {
  marker: string;
  memoryId: string;
  company: string;
  content: string;
  sourceRef: string;
  score: number;
}

export interface SandboxRecallResult {
  answer: string;
  recalled: number;
  citations: SandboxCitation[];
  grounding: {
    status: "verified" | "extractive" | "fallback" | "no-evidence";
    reason: string | null;
  };
}

type SandboxGroundingStatus = SandboxRecallResult["grounding"]["status"];

function sandboxGroundingStatus(value: unknown): SandboxGroundingStatus | null {
  return value === "verified" ||
    value === "extractive" ||
    value === "fallback" ||
    value === "no-evidence"
    ? value
    : null;
}

export interface SandboxContradiction {
  subject: string;
  attribute: string;
  values: Array<{
    value: number;
    sourceRef: string;
    memoryId: string;
  }>;
}

function normalizeSandboxCitation(value: unknown): SandboxCitation | null {
  const item = asRecord(value);
  const marker = asString(item?.marker);
  const memoryId = asString(item?.memoryId);
  const company = asString(item?.company);
  const content = asString(item?.content);
  const sourceRef = asString(item?.sourceRef);
  const score = item?.score;
  if (
    !item ||
    !marker ||
    !/^\[[1-9][0-9]*\]$/u.test(marker) ||
    !memoryId ||
    !EXACT_UUID_V4.test(memoryId) ||
    !company ||
    !content ||
    !sourceRef ||
    typeof score !== "number" ||
    !Number.isFinite(score)
  ) return null;
  return {
    marker,
    memoryId,
    company,
    content,
    sourceRef,
    score,
  };
}

export async function ingestSandboxFact(
  input: SandboxFactInput,
  signal?: AbortSignal,
): Promise<SandboxIngestResult> {
  const body = unwrap(
    await requestJson(
      "/api/sandbox/ingest",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(input.sandboxToken
            ? { sandbox_token: input.sandboxToken }
            : {}),
          company: input.company,
          fact: input.fact,
          sourceRef: input.sourceRef,
          subject: input.subject,
          attribute: input.attribute,
          numericValue: input.numericValue,
        }),
      },
      signal,
    ),
  );
  const sandboxToken = typeof body.sandbox_token === "string"
    ? body.sandbox_token
    : null;
  const memoryId = typeof body.memory_id === "string" ? body.memory_id : null;
  const reused = typeof body.reused === "boolean" ? body.reused : null;
  const ttlSeconds = typeof body.ttl_seconds === "number"
    ? body.ttl_seconds
    : null;
  const expiresAt = typeof body.expires_at === "string"
    ? body.expires_at
    : null;
  const expiryTimestamp = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  if (
    body.ok !== true ||
    !sandboxToken ||
    !/^[A-Za-z0-9_-]{43}$/u.test(sandboxToken) ||
    !memoryId ||
    !EXACT_UUID_V4.test(memoryId) ||
    reused === null ||
    ttlSeconds !== 3600 ||
    !expiresAt ||
    !Number.isFinite(expiryTimestamp) ||
    new Date(expiryTimestamp).toISOString() !== expiresAt
  ) {
    throw new PublicApiError(
      "/api/sandbox/ingest",
      "The sandbox returned an invalid storage receipt.",
    );
  }
  return {
    sandboxToken,
    memoryId,
    reused,
    ttlSeconds,
    expiresAt,
  };
}

export async function recallSandboxFact(
  sandboxToken: string,
  question: string,
  signal?: AbortSignal,
): Promise<SandboxRecallResult> {
  const body = unwrap(
    await requestJson(
      "/api/sandbox/recall",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sandbox_token: sandboxToken, question, limit: 10 }),
      },
      signal,
    ),
  );
  const answer = typeof body.answer === "string" && body.answer.trim()
    ? body.answer.trim()
    : null;
  const recalled = typeof body.recalled === "number" ? body.recalled : null;
  const rawCitations = body.citations;
  const citations = Array.isArray(rawCitations)
    ? rawCitations
        .map(normalizeSandboxCitation)
        .filter((item): item is SandboxCitation => item !== null)
    : [];
  const grounding = asRecord(body.grounding);
  const groundingStatus = sandboxGroundingStatus(grounding?.status);
  const groundingChecks = asRecord(grounding?.checks);
  const groundingReason = grounding?.reason == null
    ? null
    : typeof grounding.reason === "string" && grounding.reason.trim()
      ? grounding.reason.trim()
      : null;
  const citationsCheck = groundingChecks?.citations;
  const numericsCheck = groundingChecks?.numerics;
  const claimsCheck = groundingChecks?.claims;
  const checksAreBooleans =
    typeof citationsCheck === "boolean" &&
    typeof numericsCheck === "boolean" &&
    typeof claimsCheck === "boolean";
  const checksAllPassed =
    citationsCheck === true && numericsCheck === true && claimsCheck === true;
  const checksAllWithheld =
    citationsCheck === false && numericsCheck === false && claimsCheck === false;
  const answerMarkers = answer
    ? [...answer.matchAll(/\[([0-9]+)\]/gu)].map((match) => match[1]!)
    : [];
  const citationsComplete = citations.every((citation) =>
    answer?.includes(citation.marker)
  );
  const answerMarkersCanonical = answerMarkers.every(
    (marker) =>
      marker === String(Number(marker)) &&
      Number(marker) >= 1 &&
      Number(marker) <= citations.length,
  );
  const groundingContractValid =
    groundingStatus !== null &&
    checksAreBooleans &&
    ((groundingStatus === "verified" || groundingStatus === "extractive")
      ? checksAllPassed && citations.length > 0
      : checksAllWithheld &&
        (groundingStatus === "fallback"
          ? citations.length > 0
          : citations.length === 0));
  if (
    body.ok !== true ||
    !answer ||
    recalled === null ||
    !Number.isInteger(recalled) ||
    recalled < 0 ||
    recalled > 20 ||
    !Array.isArray(rawCitations) ||
    citations.length !== rawCitations.length ||
    citations.length > recalled ||
    new Set(citations.map((citation) => citation.memoryId)).size !==
      citations.length ||
    citations.some(
      (citation, index) => citation.marker !== `[${index + 1}]`,
    ) ||
    !citationsComplete ||
    !answerMarkersCanonical ||
    groundingStatus === null ||
    !groundingContractValid ||
    (grounding?.reason != null && groundingReason === null) ||
    (citations.length < recalled && groundingReason === null)
  ) {
    throw new PublicApiError(
      "/api/sandbox/recall",
      "The sandbox returned an invalid grounded answer.",
    );
  }
  return {
    answer,
    recalled,
    citations,
    grounding: {
      status: groundingStatus,
      reason: groundingReason,
    },
  };
}

export async function auditSandboxFacts(
  sandboxToken: string,
  signal?: AbortSignal,
): Promise<SandboxContradiction[]> {
  const body = unwrap(
    await requestJson(
      "/api/sandbox/audit",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sandbox_token: sandboxToken }),
      },
      signal,
    ),
  );
  const rawContradictions = body.contradictions;
  if (body.ok !== true || !Array.isArray(rawContradictions)) {
    throw new PublicApiError(
      "/api/sandbox/audit",
      "The sandbox returned an invalid contradiction audit.",
    );
  }
  const contradictions = rawContradictions.flatMap((value) => {
    const item = asRecord(value);
    const subject = asString(item?.subject);
    const attribute = asString(item?.attribute);
    if (!item || !subject || !attribute) return [];
    const rawValues = item.values;
    if (!Array.isArray(rawValues)) return [];
    const values = rawValues.flatMap((rawValue) => {
      const entry = asRecord(rawValue);
      const numericValue = entry?.value;
      const sourceRef = asString(entry?.sourceRef);
      const memoryId = asString(entry?.memoryId);
      return entry &&
        typeof numericValue === "number" &&
        Number.isFinite(numericValue) &&
        sourceRef &&
        memoryId &&
        EXACT_UUID_V4.test(memoryId)
        ? [{ value: numericValue, sourceRef, memoryId }]
        : [];
    });
    return values.length === rawValues.length &&
      values.length > 1 &&
      new Set(values.map((entry) => entry.memoryId)).size === values.length &&
      new Set(values.map((entry) => entry.value)).size > 1
      ? [{ subject, attribute, values }]
      : [];
  });
  if (
    contradictions.length !== rawContradictions.length ||
    new Set(
      contradictions.map((item) => `${item.subject}\u0000${item.attribute}`),
    ).size !== contradictions.length
  ) {
    throw new PublicApiError(
      "/api/sandbox/audit",
      "The sandbox returned an invalid contradiction audit.",
    );
  }
  return contradictions;
}

function normalizeAuditValue(value: unknown): AuditValue | null {
  const item = asRecord(value);
  if (!item) return null;
  return {
    memoryId: asString(item.memoryId, item.memory_id, item.id) ?? "unreported-memory",
    sourceRef: asString(item.sourceRef, item.source_ref),
    value: item.value,
    createdAt: asString(item.createdAt, item.created_at),
  };
}

function normalizeResolution(value: unknown): AuditResolution | null {
  const item = asRecord(value);
  if (!item) return null;
  return {
    recommendedMemoryId: asString(item.recommendedMemoryId, item.recommended_memory_id, item.memoryId),
    recommendedValue: item.recommendedValue ?? item.recommended_value ?? item.value,
    rule: asString(item.rule, item.policy) ?? "human review",
    confidence: asNumber(item.confidence),
    rationale: asString(item.rationale, item.reason) ?? "Review the competing evidence before accepting a value.",
  };
}

function normalizeConflict(value: unknown): AuditConflict | null {
  const item = asRecord(value);
  if (!item) return null;
  const values = asArray(item.values)
    .map(normalizeAuditValue)
    .filter((entry): entry is AuditValue => entry !== null);
  return {
    subject: asString(item.subject, item.record, item.id) ?? "unreported subject",
    attribute: asString(item.attribute, item.field) ?? "value",
    values,
    resolution: normalizeResolution(item.resolution ?? item.recommendation),
  };
}

function normalizeAbsence(value: unknown): AuditAbsence | null {
  const item = asRecord(value);
  if (!item) return null;
  const referencedBy = asArray(item.referencedBy ?? item.referenced_by)
    .map((raw) => {
      const reference = asRecord(raw);
      if (!reference) return null;
      return {
        memoryId: asString(reference.memoryId, reference.memory_id, reference.id) ?? "unreported-memory",
        sourceRef: asString(reference.sourceRef, reference.source_ref),
      };
    })
    .filter((entry): entry is { memoryId: string; sourceRef: string | null } => entry !== null);
  return {
    subject: asString(item.subject, item.missing, item.reference) ?? "unreported reference",
    referencedBy,
    recommendation: asString(item.recommendation, item.rationale),
  };
}

export async function getAudit(signal?: AbortSignal): Promise<AuditReport> {
  const root = unwrap(await requestJson("/api/audit", { method: "GET" }, signal));
  const report = asRecord(root.report) ?? root;
  const coverage = nested(root, "coverage");
  const rawConflicts = asArray(report.conflicts).length > 0
    ? asArray(report.conflicts)
    : asArray(report.contradictions);
  const conflicts = rawConflicts
    .map(normalizeConflict)
    .filter((item): item is AuditConflict => item !== null);
  const absences = asArray(report.absences)
    .map(normalizeAbsence)
    .filter((item): item is AuditAbsence => item !== null);
  const recommendations = asArray(report.recommendations)
    .map((item) => asString(item))
    .filter((item): item is string => item !== null);
  const explicitOk = asBoolean(report.ok);
  const coverageTotal = asNumber(coverage?.total);
  const coverageScanned = asNumber(coverage?.scanned);
  const coverageLimit = asNumber(coverage?.limit);
  const coverageComplete =
    asBoolean(coverage?.complete) === true &&
    coverageTotal !== null &&
    coverageScanned !== null &&
    Number.isInteger(coverageTotal) &&
    Number.isInteger(coverageScanned) &&
    coverageTotal >= 0 &&
    coverageScanned >= 0 &&
    coverageScanned === coverageTotal &&
    (coverageLimit === null ||
      (Number.isInteger(coverageLimit) &&
        coverageLimit >= coverageScanned));

  return {
    audited: asNumber(
      report.audited,
      report.memoryCount,
      coverage?.scanned,
      asArray(root.memories).length,
    ),
    subjects: asNumber(report.subjects),
    conflicts,
    absences,
    recommendations,
    ok:
      coverageComplete &&
      explicitOk !== false &&
      conflicts.length === 0 &&
      absences.length === 0,
    summary: asString(report.summary),
    memoryCount: asNumber(
      coverage?.total,
      root.memoryCount,
      asArray(root.memories).length,
    ),
    generatedAt: asString(root.generatedAt, report.generatedAt),
    coverage: {
      total: coverageTotal,
      scanned: coverageScanned,
      limit: coverageLimit,
      complete: coverageComplete,
    },
  };
}

function normalizePercent(value: unknown): number | null {
  const numeric = asNumber(value);
  if (numeric === null) return null;
  return numeric >= 0 && numeric <= 1 ? numeric * 100 : numeric;
}

function isFreshGeneratedAt(value: string | null): boolean {
  if (!value) return false;
  const timestamp = Date.parse(value);
  const now = Date.now();
  return (
    Number.isFinite(timestamp) &&
    timestamp <= now + 2 * 60 * 1_000 &&
    now - timestamp <= 5 * 60 * 1_000
  );
}

export async function getProof(signal?: AbortSignal): Promise<ProofSnapshot> {
  const body = unwrap(await requestJson("/api/proof", { method: "GET" }, signal));
  const database = nested(body, "database");
  const vector = nested(body, "vectorIndex") ?? nested(body, "vector") ?? nested(body, "cspann");
  const scope = nested(body, "scope");
  const memory = nested(body, "memory");
  const release = nested(body, "release");
  const benchmark = nested(body, "benchmark");
  const resolution = nested(body, "resolutionLoop");
  const databaseActiveMemories = asNumber(database?.activeMemories);
  const persisted = asNumber(memory?.persisted);
  const idempotencyKeys = asNumber(memory?.idempotencyKeys);
  const contentDigests = asNumber(memory?.contentDigests);
  const storeEvidence = asString(memory?.evidence);
  const reportedStoreVerified = asBoolean(memory?.storeVerified);
  const storeProofReported =
    persisted !== null ||
    idempotencyKeys !== null ||
    contentDigests !== null ||
    storeEvidence !== null ||
    reportedStoreVerified !== null;
  const storeVerified = storeProofReported
    ? Boolean(
        reportedStoreVerified === true &&
          persisted === 9 &&
          idempotencyKeys === 9 &&
          contentDigests === 9 &&
          databaseActiveMemories === 9 &&
          storeEvidence ===
            "live bounded fixed-scope payload-digest verification"
      )
    : null;
  const releaseCommitSha =
    typeof release?.commitSha === "string" &&
    EXACT_COMMIT_SHA.test(release.commitSha) &&
    release.evidence === RELEASE_EVIDENCE
      ? release.commitSha
      : null;
  const features = asArray(body.features)
    .map((item) => {
      const feature = asRecord(item);
      return asString(feature?.label, feature?.name, item);
    })
    .filter((item): item is string => item !== null);
  const snapshot: ProofSnapshot = {
    database: {
      provider: asString(database?.provider, database?.engine),
      version: asString(database?.version),
      region: asString(database?.region),
      regionEvidence: asString(database?.regionEvidence),
      runtimePrincipal: asString(database?.runtimePrincipal, database?.databaseUser),
      topology: asString(
        database?.topology,
        database?.deployment,
        database?.replication,
        database?.nodes,
      ),
      activeMemories: databaseActiveMemories,
    },
    vectorIndex: {
      enabled: asBoolean(vector?.enabled, vector?.active, vector?.verified),
      name: asString(vector?.name, vector?.indexName),
      dimensions: asNumber(vector?.dimensions, vector?.dimension),
      metric: asString(vector?.metric, vector?.distance),
      engine: asString(vector?.engine, vector?.type),
      lifecycleState: asString(vector?.lifecycleState),
      evidence: asString(vector?.evidence),
      definitionFingerprint: asString(vector?.definitionFingerprint),
      plan: asString(vector?.plan, vector?.operator),
      recallAt10Percent: normalizePercent(vector?.recallAt10 ?? benchmark?.recallAt10),
      p95Ms: asNumber(vector?.p95Ms, benchmark?.p95Ms),
    },
    resolutionLoop: {
      enabled:
        asBoolean(resolution?.enabled) === true &&
        asNumber(resolution?.schemaTables) === 5 &&
        resolution?.transactionIsolation === "SERIALIZABLE" &&
        resolution?.authorityBoundary ===
          "financial-controller-human-gate" &&
        resolution?.identityAssurance ===
          "fixed-demo-role-assertion-not-authenticated" &&
        resolution?.canonicalMemoryMutable === false &&
        resolution?.externalSideEffects === "none" &&
        resolution?.evidence === "live fixed-scope sandbox schema query",
      schemaTables: asNumber(resolution?.schemaTables),
      activeSandboxSessions: asNumber(
        resolution?.activeSandboxSessions
      ),
      transactionIsolation: asString(resolution?.transactionIsolation),
      authorityBoundary: asString(resolution?.authorityBoundary),
      identityAssurance: asString(resolution?.identityAssurance),
      idempotency: asString(resolution?.idempotency),
      receipt: asString(resolution?.receipt),
      learning: asString(resolution?.learning),
      consolidation: asString(resolution?.consolidation),
      forgetting: asString(resolution?.forgetting),
      canonicalMemoryMutable: asBoolean(
        resolution?.canonicalMemoryMutable
      ),
      externalSideEffects: asString(resolution?.externalSideEffects),
      evidence: asString(resolution?.evidence),
    },
    embeddingModel: asString(body.embeddingModel, nested(body, "bedrock")?.embeddingModel),
    narrationModel: asString(body.narrationModel, nested(body, "bedrock")?.narrationModel),
    scope: {
      company: asString(scope?.company) ?? PUBLIC_COMPANY,
      mode: asString(scope?.mode),
    },
    memory: {
      persisted,
      idempotencyKeys,
      contentDigests,
      storeVerified,
      evidence: storeEvidence,
    },
    release: {
      commitSha: releaseCommitSha,
      evidence: releaseCommitSha ? RELEASE_EVIDENCE : null,
    },
    features,
    memoryCount: asNumber(
      databaseActiveMemories,
      body.memoryCount,
      memory?.count,
      memory?.total,
      persisted,
    ),
    generatedAt: asString(body.generatedAt),
    hasEvidence: false,
  };

  snapshot.hasEvidence = Boolean(
    snapshot.database.provider === "CockroachDB" &&
    snapshot.database.topology === "CockroachDB Cloud on AWS" &&
    snapshot.database.region === "eu-west-1" &&
    snapshot.database.regionEvidence === "cockroach-cloud-api-release-gate" &&
    EXACT_RUNTIME_PRINCIPAL.test(
      snapshot.database.runtimePrincipal ?? ""
    ) &&
    snapshot.vectorIndex.enabled === true &&
    snapshot.vectorIndex.name === "idx_agent_memory_company_scope_embedding" &&
    snapshot.vectorIndex.engine === "native CockroachDB C-SPANN" &&
    snapshot.vectorIndex.lifecycleState === "active" &&
    snapshot.vectorIndex.evidence === "live pg_catalog.pg_indexes definition" &&
    /^[a-f0-9]{64}$/u.test(
      snapshot.vectorIndex.definitionFingerprint ?? ""
    ) &&
    snapshot.vectorIndex.dimensions === 1024 &&
    snapshot.vectorIndex.metric === "cosine" &&
    snapshot.resolutionLoop.enabled === true &&
    snapshot.resolutionLoop.schemaTables === 5 &&
    snapshot.resolutionLoop.transactionIsolation === "SERIALIZABLE" &&
    snapshot.resolutionLoop.authorityBoundary ===
      "financial-controller-human-gate" &&
    snapshot.resolutionLoop.identityAssurance ===
      "fixed-demo-role-assertion-not-authenticated" &&
    snapshot.resolutionLoop.canonicalMemoryMutable === false &&
    snapshot.resolutionLoop.externalSideEffects === "none" &&
    snapshot.resolutionLoop.evidence ===
      "live fixed-scope sandbox schema query" &&
    snapshot.embeddingModel === EMBEDDING_MODEL &&
    snapshot.narrationModel === NARRATION_MODEL &&
    snapshot.scope.company === PUBLIC_COMPANY &&
    snapshot.scope.mode === "fixed-synthetic-demo" &&
    snapshot.memory.storeVerified === true &&
    snapshot.memory.persisted === 9 &&
    snapshot.memory.idempotencyKeys === 9 &&
    snapshot.memory.contentDigests === 9 &&
    snapshot.memory.evidence ===
      "live bounded fixed-scope payload-digest verification" &&
    snapshot.database.activeMemories === 9 &&
    snapshot.release.commitSha !== null &&
    EXACT_COMMIT_SHA.test(snapshot.release.commitSha) &&
    snapshot.release.evidence === RELEASE_EVIDENCE &&
    snapshot.memoryCount === 9 &&
    isFreshGeneratedAt(snapshot.generatedAt)
  );
  return snapshot;
}

function normalizeResolutionObservation(
  value: unknown
): ResolutionObservation | null {
  const item = asRecord(value);
  if (!item) return null;
  const id = asString(item.id);
  const label = asString(item.label);
  const sourceRef = asString(item.sourceRef);
  const sourceClass = asString(item.sourceClass);
  const observedAt = asString(item.observedAt);
  const authorityRank = asNumber(item.authorityRank);
  const employerCostCents = asNumber(item.employerCostCents);
  const employerCostDisplay = asString(item.employerCostDisplay);
  const status = asString(item.status);
  if (
    !id ||
    !EXACT_UUID_V4.test(id) ||
    (label !== "prior" && label !== "corrected") ||
    !sourceRef ||
    (sourceClass !== "payroll-register" &&
      sourceClass !== "signed-payroll-register") ||
    !observedAt ||
    !Number.isFinite(Date.parse(observedAt)) ||
    authorityRank === null ||
    !Number.isInteger(authorityRank) ||
    employerCostCents === null ||
    !Number.isSafeInteger(employerCostCents) ||
    !employerCostDisplay ||
    !["candidate", "current", "superseded", "rejected"].includes(
      status ?? ""
    )
  ) {
    return null;
  }
  const isPrior =
    label === "prior" &&
    sourceRef === "payroll-register-2026-06-v1" &&
    sourceClass === "payroll-register" &&
    observedAt === "2026-07-01T08:00:00.000Z" &&
    authorityRank === 60 &&
    employerCostCents === 12_440_000 &&
    employerCostDisplay === "€124,400.00";
  const isCorrected =
    label === "corrected" &&
    sourceRef === "signed-payroll-register-2026-06-v2" &&
    sourceClass === "signed-payroll-register" &&
    observedAt === "2026-07-08T10:30:00.000Z" &&
    authorityRank === 100 &&
    employerCostCents === 12_890_000 &&
    employerCostDisplay === "€128,900.00";
  if (!isPrior && !isCorrected) return null;
  return {
    id,
    label,
    sourceRef,
    sourceClass,
    observedAt,
    authorityRank,
    employerCostCents,
    employerCostDisplay,
    status: status as ResolutionObservation["status"],
  };
}

function normalizeResolutionSnapshot(value: unknown): ResolutionSnapshot {
  const item = asRecord(value);
  const sessionId = asString(item?.sessionId);
  const state = asString(item?.state);
  const expiresAt = asString(item?.expiresAt);
  const observations = asArray(item?.observations)
    .map(normalizeResolutionObservation)
    .filter(
      (observation): observation is ResolutionObservation =>
        observation !== null
    );
  const proposal = asRecord(item?.proposal);
  const lifecycle = asRecord(item?.lifecycle);
  const policy = asRecord(item?.policy);
  const receipt = asRecord(item?.receipt);
  const observationIds = new Set(
    observations.map((observation) => observation.id)
  );
  const proposalId = asString(proposal?.id);
  const proposedObservationId = asString(
    proposal?.proposedObservationId
  );
  const supersedesObservationId = asString(
    proposal?.supersedesObservationId
  );
  const states = new Set(["pending", "approved", "rejected"]);
  const stateContract =
    state === "pending" || state === "approved" || state === "rejected"
      ? RESOLUTION_STATE_CONTRACT[state]
      : null;
  if (
    !sessionId ||
    !EXACT_UUID_V4.test(sessionId) ||
    item?.scenarioId !== "helios-payroll-2026-06-correction-v1" ||
    item?.company !== PUBLIC_COMPANY ||
    item?.period !== "2026-06" ||
    !state ||
    !states.has(state) ||
    !stateContract ||
    !expiresAt ||
    !Number.isFinite(Date.parse(expiresAt)) ||
    observations.length !== 2 ||
    observations[0]?.label !== "prior" ||
    observations[1]?.label !== "corrected" ||
    new Set(observations.map((observation) => observation.label)).size !== 2 ||
    observationIds.size !== 2 ||
    !proposalId ||
    !EXACT_UUID_V4.test(proposalId) ||
    proposal?.action !== "resolve-conflicting-memory" ||
    proposal?.status !== state ||
    !proposedObservationId ||
    !EXACT_UUID_V4.test(proposedObservationId) ||
    !supersedesObservationId ||
    !EXACT_UUID_V4.test(supersedesObservationId) ||
    !observationIds.has(proposedObservationId) ||
    !observationIds.has(supersedesObservationId) ||
    proposedObservationId === supersedesObservationId ||
    proposal?.rationale !== RESOLUTION_RATIONALE ||
    proposal?.requiresHumanRole !== "financial-controller" ||
    lifecycle?.externalSideEffects !== "none" ||
    lifecycle?.learning !== stateContract.learning ||
    lifecycle?.consolidation !== stateContract.consolidation ||
    lifecycle?.forgetting !== stateContract.forgetting ||
    policy?.version !== "resolution-policy-v1" ||
    policy?.conflictRule !==
      "newer-higher-authority-evidence-is-proposed" ||
    policy?.authorityBoundary !== "human-approval-required" ||
    policy?.mutationScope !== "ephemeral-synthetic-session-only" ||
    policy?.retention !== "row-level-ttl" ||
    policy?.canonicalMemoryMutable !== false
  ) {
    throw new PublicApiError(
      "/api/resolution",
      "Resolution response violated the fixed evidence and authority contract."
    );
  }
  const corrected = observations.find(
    (observation) => observation.label === "corrected"
  );
  const prior = observations.find(
    (observation) => observation.label === "prior"
  );
  if (
    prior?.status !== stateContract.priorStatus ||
    corrected?.status !== stateContract.correctedStatus ||
    proposedObservationId !== corrected?.id ||
    supersedesObservationId !== prior?.id
  ) {
    throw new PublicApiError(
      "/api/resolution",
      "Resolution graph did not match the exact state-dependent evidence contract."
    );
  }

  let normalizedReceipt: ResolutionSnapshot["receipt"] = null;
  if (state === "pending") {
    if (receipt !== null) {
      throw new PublicApiError(
        "/api/resolution",
        "A pending resolution unexpectedly contained a decision receipt."
      );
    }
  } else {
    const digest = asString(receipt?.digest);
    const decisionId = asString(receipt?.decisionId);
    const decidedAt = asString(receipt?.decidedAt);
    if (
      receipt?.algorithm !== "sha256" ||
      !digest ||
      !/^[a-f0-9]{64}$/u.test(digest) ||
      !decisionId ||
      !EXACT_UUID_V4.test(decisionId) ||
      !decidedAt ||
      !Number.isFinite(Date.parse(decidedAt)) ||
      receipt?.actorRole !== "financial-controller" ||
      receipt?.policyVersion !== "resolution-policy-v1"
    ) {
      throw new PublicApiError(
        "/api/resolution",
        "A finalized resolution did not contain a verifiable decision receipt."
      );
    }
    normalizedReceipt = {
      algorithm: "sha256",
      digest,
      decisionId,
      decidedAt,
      actorRole: "financial-controller",
      policyVersion: "resolution-policy-v1",
    };
  }

  return {
    sessionId,
    scenarioId: "helios-payroll-2026-06-correction-v1",
    company: "Helios SA",
    period: "2026-06",
    state: state as ResolutionState,
    expiresAt,
    observations,
    proposal: {
      id: proposalId,
      action: "resolve-conflicting-memory",
      status: state as ResolutionState,
      proposedObservationId,
      supersedesObservationId,
      rationale: RESOLUTION_RATIONALE,
      requiresHumanRole: "financial-controller",
    },
    receipt: normalizedReceipt,
    lifecycle: {
      learning: stateContract.learning,
      consolidation: stateContract.consolidation,
      forgetting: stateContract.forgetting,
      externalSideEffects: "none",
    },
    policy: {
      version: "resolution-policy-v1",
      conflictRule: "newer-higher-authority-evidence-is-proposed",
      authorityBoundary: "human-approval-required",
      mutationScope: "ephemeral-synthetic-session-only",
      retention: "row-level-ttl",
      canonicalMemoryMutable: false,
    },
  };
}

export async function createResolutionSession(
  signal?: AbortSignal
): Promise<ResolutionSession> {
  const body = unwrap(
    await requestJson(
      "/api/resolution/session",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
      signal
    )
  );
  const token = asString(body.sessionToken);
  if (
    !token ||
    !/^[A-Za-z0-9_-]{43}$/u.test(token) ||
    body.tokenType !== "Bearer"
  ) {
    throw new PublicApiError(
      "/api/resolution/session",
      "The service did not issue a valid isolated session capability."
    );
  }
  return {
    token,
    snapshot: normalizeResolutionSnapshot(body.snapshot),
  };
}

export async function getResolutionSession(
  token: string,
  signal?: AbortSignal
): Promise<ResolutionSnapshot> {
  const body = unwrap(
    await requestJson(
      "/api/resolution/session",
      {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
      },
      signal
    )
  );
  return normalizeResolutionSnapshot(body.snapshot);
}

export async function decideResolution(
  token: string,
  decision: ResolutionDecision,
  idempotencyKey: string,
  signal?: AbortSignal
): Promise<ResolutionSnapshot> {
  if (
    !/^[A-Za-z0-9_-]{43}$/u.test(token) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      idempotencyKey
    )
  ) {
    throw new PublicApiError(
      "/api/resolution/decision",
      "Resolution capability or idempotency key is invalid."
    );
  }
  const body = unwrap(
    await requestJson(
      "/api/resolution/decision",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ decision, idempotencyKey }),
      },
      signal
    )
  );
  return normalizeResolutionSnapshot(body.snapshot);
}

export function formatApiError(error: unknown): string {
  return error instanceof Error ? error.message : "The live service is temporarily unavailable.";
}
