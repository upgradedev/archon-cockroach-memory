import { randomUUID } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import { withSerializableRetry } from "../db/client.js";
import {
  buildResolutionReceipt,
  lifecycleFor,
  newResolutionIdentity,
  RESOLUTION_COMPANY,
  RESOLUTION_POLICY,
  RESOLUTION_SCENARIO_ID,
  ResolutionError,
  safeDigestEqual,
  type ResolutionDecisionRequest,
  type ResolutionObservation,
  type ResolutionReceipt,
  type ResolutionSnapshot,
  type ResolutionState,
  type ResolutionStore,
} from "./resolution.js";

function boundedIntegerConfiguration(
  name: string,
  fallback: number,
  min: number,
  max: number
): number {
  const raw = process.env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

const SESSION_TTL_MINUTES = boundedIntegerConfiguration(
  "RESOLUTION_SESSION_TTL_MINUTES",
  30,
  5,
  60
);
const MAX_ACTIVE_SESSIONS = boundedIntegerConfiguration(
  "RESOLUTION_MAX_ACTIVE_SESSIONS",
  500,
  10,
  500
);

interface SessionRow extends QueryResultRow {
  id: string;
  scenario_id: string;
  company: string;
  period: string;
  state: ResolutionState;
  expires_at: Date | string;
}

interface ObservationRow extends QueryResultRow {
  id: string;
  label: "prior" | "corrected";
  source_ref: string;
  source_class: "payroll-register" | "signed-payroll-register";
  observed_at: Date | string;
  authority_rank: number | string;
  employer_cost_cents: number | string;
  status: ResolutionObservation["status"];
}

interface ProposalRow extends QueryResultRow {
  id: string;
  status: ResolutionState;
  proposed_observation_id: string;
  supersedes_observation_id: string;
  rationale: string;
}

interface DecisionRow extends QueryResultRow {
  id: string;
  decision: "approve" | "reject";
  idempotency_key: string;
  decided_at: Date | string;
  receipt_hash: string;
  current_observation_id: string;
  superseded_observation_id: string | null;
}

interface ConsolidationRow extends QueryResultRow {
  decision_id: string;
  policy_version: string;
  mode: "approved-correction" | "retained-prior";
  current_observation_id: string;
  superseded_observation_id: string | null;
  receipt_hash: string;
  consolidated_at: Date | string;
}

function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf())) {
    throw new Error("Resolution store returned an invalid timestamp.");
  }
  return date.toISOString();
}

function exactInteger(value: number | string, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Resolution store returned an invalid ${label}.`);
  }
  return parsed;
}

function money(cents: number): string {
  return new Intl.NumberFormat("en-IE", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

async function loadSnapshot(
  client: PoolClient,
  tokenHash: string
): Promise<ResolutionSnapshot> {
  const sessions = await client.query<SessionRow>(
    `SELECT id, scenario_id, company, period, state, expires_at
       FROM public.memory_demo_sessions
      WHERE token_hash = $1`,
    [tokenHash]
  );
  const session = sessions.rows[0];
  if (!session) {
    throw new ResolutionError(404, "Resolution session was not found.");
  }
  if (new Date(iso(session.expires_at)).valueOf() <= Date.now()) {
    throw new ResolutionError(
      410,
      "Resolution session expired; start a fresh isolated session."
    );
  }
  if (
    session.scenario_id !== RESOLUTION_SCENARIO_ID ||
    session.company !== RESOLUTION_COMPANY ||
    session.period !== "2026-06"
  ) {
    throw new Error("Resolution session violated the fixed synthetic scope.");
  }

  const [
    observationResult,
    proposalResult,
    decisionResult,
    consolidationResult,
  ] = await Promise.all([
    client.query<ObservationRow>(
      `SELECT id, label, source_ref, source_class, observed_at,
              authority_rank, employer_cost_cents, status
         FROM public.memory_resolution_observations
        WHERE session_id = $1
        ORDER BY ordinal`,
      [session.id]
    ),
    client.query<ProposalRow>(
      `SELECT id, status, proposed_observation_id,
              supersedes_observation_id, rationale
         FROM public.memory_resolution_proposals
        WHERE session_id = $1`,
      [session.id]
    ),
    client.query<DecisionRow>(
      `SELECT id, decision, idempotency_key, decided_at, receipt_hash,
              current_observation_id, superseded_observation_id
         FROM public.memory_resolution_decisions
        WHERE session_id = $1`,
      [session.id]
    ),
    client.query<ConsolidationRow>(
      `SELECT decision_id, policy_version, mode, current_observation_id,
              superseded_observation_id, receipt_hash, consolidated_at
         FROM public.memory_resolution_consolidations
        WHERE session_id = $1`,
      [session.id]
    ),
  ]);

  if (
    observationResult.rows.length !== 2 ||
    proposalResult.rows.length !== 1 ||
    decisionResult.rows.length > 1 ||
    consolidationResult.rows.length > 1
  ) {
    throw new Error("Resolution session graph is incomplete or ambiguous.");
  }
  const observations = observationResult.rows.map((row) => {
    const cents = exactInteger(row.employer_cost_cents, "employer cost");
    return {
      id: row.id,
      label: row.label,
      sourceRef: row.source_ref,
      sourceClass: row.source_class,
      observedAt: iso(row.observed_at),
      authorityRank: exactInteger(row.authority_rank, "authority rank"),
      employerCostCents: cents,
      employerCostDisplay: money(cents),
      status: row.status,
    } satisfies ResolutionObservation;
  });
  const proposalRow = proposalResult.rows[0];
  let receipt: ResolutionReceipt | null = null;
  const decision = decisionResult.rows[0];
  if (decision) {
    receipt = buildResolutionReceipt({
      decisionId: decision.id,
      sessionId: session.id,
      proposalId: proposalRow.id,
      decision: decision.decision,
      idempotencyKey: decision.idempotency_key,
      decidedAt: iso(decision.decided_at),
      currentObservationId: decision.current_observation_id,
      supersededObservationId: decision.superseded_observation_id,
    });
    if (!safeDigestEqual(receipt.digest, decision.receipt_hash)) {
      throw new Error("Resolution decision receipt verification failed.");
    }
    const consolidation = consolidationResult.rows[0];
    const expectedMode =
      decision.decision === "approve"
        ? "approved-correction"
        : "retained-prior";
    if (
      !consolidation ||
      consolidation.decision_id !== decision.id ||
      consolidation.policy_version !== "resolution-policy-v1" ||
      consolidation.mode !== expectedMode ||
      consolidation.current_observation_id !==
        decision.current_observation_id ||
      consolidation.superseded_observation_id !==
        decision.superseded_observation_id ||
      !safeDigestEqual(consolidation.receipt_hash, decision.receipt_hash) ||
      iso(consolidation.consolidated_at) !== iso(decision.decided_at)
    ) {
      throw new Error(
        "Resolution consolidation is missing or does not match the decision."
      );
    }
  } else if (consolidationResult.rows.length !== 0) {
    throw new Error("Resolution consolidation exists without a decision.");
  }

  return {
    sessionId: session.id,
    scenarioId: RESOLUTION_SCENARIO_ID,
    company: RESOLUTION_COMPANY,
    period: "2026-06",
    state: session.state,
    expiresAt: iso(session.expires_at),
    observations,
    proposal: {
      id: proposalRow.id,
      action: "resolve-conflicting-memory",
      status: proposalRow.status,
      proposedObservationId: proposalRow.proposed_observation_id,
      supersedesObservationId: proposalRow.supersedes_observation_id,
      rationale: proposalRow.rationale,
      requiresHumanRole: "financial-controller",
    },
    receipt,
    lifecycle: lifecycleFor(session.state),
    policy: RESOLUTION_POLICY,
  };
}

export class CockroachResolutionStore implements ResolutionStore {
  async createSession(tokenHash: string): Promise<ResolutionSnapshot> {
    const identity = newResolutionIdentity();
    const expiresAt = new Date(
      Date.now() + SESSION_TTL_MINUTES * 60_000
    ).toISOString();
    return withSerializableRetry(async (client) => {
      const created = await client.query<{ result: string }>(
        `SELECT public.archon_resolution_create_session(
           $1, $2, $3, $4, $5, $6, $7
         ) AS result`,
        [
          tokenHash,
          identity.sessionId,
          identity.priorObservationId,
          identity.correctedObservationId,
          identity.proposalId,
          expiresAt,
          MAX_ACTIVE_SESSIONS,
        ]
      );
      if (created.rows[0]?.result === "capacity") {
        throw new ResolutionError(
          429,
          "The bounded resolution sandbox is at capacity; retry later."
        );
      }
      if (created.rows[0]?.result !== "created") {
        throw new Error(
          "CockroachDB rejected the fixed resolution session transition."
        );
      }
      return loadSnapshot(client, tokenHash);
    });
  }

  async getSession(tokenHash: string): Promise<ResolutionSnapshot> {
    return withSerializableRetry((client) => loadSnapshot(client, tokenHash));
  }

  async decide(
    tokenHash: string,
    request: ResolutionDecisionRequest
  ): Promise<ResolutionSnapshot> {
    const decisionId = randomUUID();
    const consolidationId = randomUUID();
    const decidedAt = new Date().toISOString();
    return withSerializableRetry(async (client) => {
      await loadSnapshot(client, tokenHash);

      const result = await client.query<{ result: string }>(
        `SELECT public.archon_resolution_decide(
           $1, $2, $3, $4, $5, $6
         ) AS result`,
        [
          tokenHash,
          request.decision,
          request.idempotencyKey,
          decisionId,
          consolidationId,
          decidedAt,
        ]
      );
      if (result.rows[0]?.result === "not_found") {
        throw new ResolutionError(404, "Resolution session was not found.");
      }
      if (result.rows[0]?.result === "conflict") {
        throw new ResolutionError(
          409,
          "This resolution proposal already has a final human decision."
        );
      }
      if (
        result.rows[0]?.result !== "applied" &&
        result.rows[0]?.result !== "replayed"
      ) {
        throw new Error(
          "CockroachDB rejected the fixed resolution decision transition."
        );
      }
      return loadSnapshot(client, tokenHash);
    });
  }
}

export const cockroachResolutionStore = new CockroachResolutionStore();
