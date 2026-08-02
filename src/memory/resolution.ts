import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

export const RESOLUTION_SCENARIO_ID =
  "helios-payroll-2026-06-correction-v1";
export const RESOLUTION_POLICY_VERSION = "resolution-policy-v1";
export const RESOLUTION_TENANT = "public-demo";
export const RESOLUTION_COMPANY = "Helios SA";
export const RESOLUTION_TOKEN_BYTES = 32;

export type ResolutionDecision = "approve" | "reject";
export type ResolutionState = "pending" | "approved" | "rejected";
export type ResolutionObservationStatus =
  | "candidate"
  | "current"
  | "superseded"
  | "rejected";

export interface ResolutionObservation {
  id: string;
  label: "prior" | "corrected";
  sourceRef: string;
  sourceClass: "payroll-register" | "signed-payroll-register";
  observedAt: string;
  authorityRank: number;
  employerCostCents: number;
  employerCostDisplay: string;
  status: ResolutionObservationStatus;
}

export interface ResolutionProposal {
  id: string;
  action: "resolve-conflicting-memory";
  status: ResolutionState;
  proposedObservationId: string;
  supersedesObservationId: string;
  rationale: string;
  requiresHumanRole: "financial-controller";
}

export interface ResolutionReceipt {
  algorithm: "sha256";
  digest: string;
  decisionId: string;
  decidedAt: string;
  actorRole: "financial-controller";
  policyVersion: typeof RESOLUTION_POLICY_VERSION;
}

export interface ResolutionLifecycle {
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
}

export interface ResolutionSnapshot {
  sessionId: string;
  scenarioId: typeof RESOLUTION_SCENARIO_ID;
  company: typeof RESOLUTION_COMPANY;
  period: "2026-06";
  state: ResolutionState;
  expiresAt: string;
  observations: ResolutionObservation[];
  proposal: ResolutionProposal;
  receipt: ResolutionReceipt | null;
  lifecycle: ResolutionLifecycle;
  policy: {
    version: typeof RESOLUTION_POLICY_VERSION;
    conflictRule: "newer-higher-authority-evidence-is-proposed";
    authorityBoundary: "human-approval-required";
    mutationScope: "ephemeral-synthetic-session-only";
    retention: "row-level-ttl";
    canonicalMemoryMutable: false;
  };
}

export interface CreateResolutionSessionResult {
  token: string;
  snapshot: ResolutionSnapshot;
}

export interface ResolutionDecisionRequest {
  decision: ResolutionDecision;
  idempotencyKey: string;
}

export interface ResolutionStore {
  createSession(tokenHash: string): Promise<ResolutionSnapshot>;
  getSession(tokenHash: string): Promise<ResolutionSnapshot>;
  decide(
    tokenHash: string,
    request: ResolutionDecisionRequest
  ): Promise<ResolutionSnapshot>;
}

export class ResolutionError extends Error {
  constructor(
    readonly status: 400 | 401 | 404 | 409 | 410 | 429,
    readonly publicMessage: string
  ) {
    super(publicMessage);
    this.name = "ResolutionError";
  }
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const IDEMPOTENCY_KEY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function issueResolutionToken(): string {
  return randomBytes(RESOLUTION_TOKEN_BYTES).toString("base64url");
}

export function resolutionTokenHash(token: string): string {
  if (!TOKEN_PATTERN.test(token)) {
    throw new ResolutionError(401, "A valid resolution session token is required.");
  }
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function extractResolutionToken(
  authorization: string | undefined
): string {
  if (!authorization) {
    throw new ResolutionError(401, "A resolution session token is required.");
  }
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(authorization);
  if (!match) {
    throw new ResolutionError(
      401,
      "Authorization must contain a valid Bearer resolution session token."
    );
  }
  return match[1];
}

export function parseResolutionDecision(
  raw: unknown
): ResolutionDecisionRequest {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ResolutionError(400, "A JSON decision object is required.");
  }
  const value = raw as Record<string, unknown>;
  if (value.decision !== "approve" && value.decision !== "reject") {
    throw new ResolutionError(
      400,
      "`decision` must be exactly `approve` or `reject`."
    );
  }
  if (
    typeof value.idempotencyKey !== "string" ||
    !IDEMPOTENCY_KEY_PATTERN.test(value.idempotencyKey)
  ) {
    throw new ResolutionError(
      400,
      "`idempotencyKey` must be a version-4 UUID."
    );
  }
  const unexpected = Object.keys(value).filter(
    (key) => key !== "decision" && key !== "idempotencyKey"
  );
  if (unexpected.length > 0) {
    throw new ResolutionError(
      400,
      "Decision requests accept only `decision` and `idempotencyKey`."
    );
  }
  return {
    decision: value.decision,
    idempotencyKey: value.idempotencyKey.toLowerCase(),
  };
}

export function newResolutionIdentity(): {
  sessionId: string;
  priorObservationId: string;
  correctedObservationId: string;
  proposalId: string;
} {
  return {
    sessionId: randomUUID(),
    priorObservationId: randomUUID(),
    correctedObservationId: randomUUID(),
    proposalId: randomUUID(),
  };
}

export function buildResolutionReceipt(input: {
  decisionId: string;
  sessionId: string;
  proposalId: string;
  decision: ResolutionDecision;
  idempotencyKey: string;
  decidedAt: string;
  currentObservationId: string;
  supersededObservationId: string | null;
}): ResolutionReceipt {
  const canonical = JSON.stringify({
    actorRole: "financial-controller",
    currentObservationId: input.currentObservationId,
    decidedAt: input.decidedAt,
    decision: input.decision,
    decisionId: input.decisionId,
    idempotencyKey: input.idempotencyKey,
    policyVersion: RESOLUTION_POLICY_VERSION,
    proposalId: input.proposalId,
    scenarioId: RESOLUTION_SCENARIO_ID,
    sessionId: input.sessionId,
    supersededObservationId: input.supersededObservationId,
  });
  return {
    algorithm: "sha256",
    digest: createHash("sha256").update(canonical, "utf8").digest("hex"),
    decisionId: input.decisionId,
    decidedAt: input.decidedAt,
    actorRole: "financial-controller",
    policyVersion: RESOLUTION_POLICY_VERSION,
  };
}

export function safeDigestEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(left) || !/^[a-f0-9]{64}$/u.test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export function lifecycleFor(state: ResolutionState): ResolutionLifecycle {
  if (state === "approved") {
    return {
      learning: "human-approved-correction",
      consolidation: "approved-observation-is-current",
      forgetting: "session-scoped-ttl-after-decision",
      externalSideEffects: "none",
    };
  }
  if (state === "rejected") {
    return {
      learning: "human-rejected-correction",
      consolidation: "prior-observation-remains-current",
      forgetting: "session-scoped-ttl-after-decision",
      externalSideEffects: "none",
    };
  }
  return {
    learning: "two-source-conflict-observed",
    consolidation: "awaiting-human-decision",
    forgetting: "session-scoped-ttl-pending",
    externalSideEffects: "none",
  };
}

export const RESOLUTION_POLICY = Object.freeze({
  version: RESOLUTION_POLICY_VERSION,
  conflictRule: "newer-higher-authority-evidence-is-proposed" as const,
  authorityBoundary: "human-approval-required" as const,
  mutationScope: "ephemeral-synthetic-session-only" as const,
  retention: "row-level-ttl" as const,
  canonicalMemoryMutable: false as const,
});
