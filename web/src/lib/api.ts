export const PUBLIC_COMPANY = "Helios SA";

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
  embeddingModel: string | null;
  narrationModel: string | null;
  scope: {
    company: string;
    mode: string | null;
  };
  features: string[];
  memoryCount: number | null;
  generatedAt: string | null;
  hasEvidence: boolean;
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

export async function getProof(signal?: AbortSignal): Promise<ProofSnapshot> {
  const body = unwrap(await requestJson("/api/proof", { method: "GET" }, signal));
  const database = nested(body, "database");
  const vector = nested(body, "vectorIndex") ?? nested(body, "vector") ?? nested(body, "cspann");
  const scope = nested(body, "scope");
  const memory = nested(body, "memory");
  const benchmark = nested(body, "benchmark");
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
    embeddingModel: asString(body.embeddingModel, nested(body, "bedrock")?.embeddingModel),
    narrationModel: asString(body.narrationModel, nested(body, "bedrock")?.narrationModel),
    scope: {
      company: asString(scope?.company) ?? PUBLIC_COMPANY,
      mode: asString(scope?.mode),
    },
    features,
    memoryCount: asNumber(
      body.memoryCount,
      database?.activeMemories,
      memory?.count,
      memory?.total,
    ),
    generatedAt: asString(body.generatedAt),
    hasEvidence: false,
  };

  snapshot.hasEvidence = Boolean(
    snapshot.database.provider === "CockroachDB" &&
      snapshot.database.region === "eu-west-1" &&
      snapshot.database.regionEvidence === "cockroach-cloud-api-release-gate" &&
      snapshot.database.runtimePrincipal?.startsWith("archon_") &&
      snapshot.vectorIndex.enabled === true &&
      snapshot.vectorIndex.name === "idx_agent_memory_company_scope_embedding" &&
      snapshot.vectorIndex.engine?.includes("CockroachDB C-SPANN") &&
      snapshot.vectorIndex.lifecycleState === "active" &&
      snapshot.vectorIndex.evidence === "live pg_catalog.pg_indexes definition" &&
      /^[a-f0-9]{64}$/u.test(
        snapshot.vectorIndex.definitionFingerprint ?? ""
      ) &&
      snapshot.vectorIndex.dimensions === 1024 &&
      snapshot.vectorIndex.metric === "cosine" &&
      snapshot.embeddingModel &&
      snapshot.narrationModel &&
      !/fake|offline/iu.test(snapshot.embeddingModel) &&
      !/fake|offline/iu.test(snapshot.narrationModel) &&
      snapshot.scope.company === PUBLIC_COMPANY &&
      snapshot.scope.mode === "fixed-synthetic-demo" &&
      snapshot.memoryCount !== null &&
      snapshot.memoryCount > 0 &&
      snapshot.generatedAt &&
      Number.isFinite(Date.parse(snapshot.generatedAt))
  );
  return snapshot;
}

export function formatApiError(error: unknown): string {
  return error instanceof Error ? error.message : "The live service is temporarily unavailable.";
}
