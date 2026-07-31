import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import {
  createResolutionSession,
  decideResolution,
  formatApiError,
  type ResolutionDecision,
  type ResolutionSnapshot,
} from "../lib/api";

interface DecisionIntent {
  decision: ResolutionDecision;
  idempotencyKey: string;
}

function formattedTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.valueOf())
    ? new Intl.DateTimeFormat("en-GB", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      }).format(date)
    : value;
}

function stateLabel(snapshot: ResolutionSnapshot): string {
  if (snapshot.state === "approved") return "Correction approved";
  if (snapshot.state === "rejected") return "Correction rejected";
  return "Human decision pending";
}

export function MemoryResolutionLoop() {
  const [token, setToken] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<ResolutionSnapshot | null>(null);
  const [intent, setIntent] = useState<DecisionIntent | null>(null);

  const createMutation = useMutation({
    mutationFn: createResolutionSession,
    onSuccess: (session) => {
      setToken(session.token);
      setSnapshot(session.snapshot);
      setIntent(null);
    },
  });
  const decisionMutation = useMutation({
    mutationFn: async (next: DecisionIntent) => {
      if (!token) throw new Error("The isolated session capability is missing.");
      return decideResolution(
        token,
        next.decision,
        next.idempotencyKey
      );
    },
    onSuccess: (nextSnapshot) => {
      setSnapshot(nextSnapshot);
      setIntent(null);
    },
  });

  function startSession() {
    decisionMutation.reset();
    createMutation.reset();
    setToken(null);
    setSnapshot(null);
    setIntent(null);
    createMutation.mutate();
  }

  function decide(decision: ResolutionDecision) {
    const next =
      intent?.decision === decision
        ? intent
        : {
            decision,
            idempotencyKey: globalThis.crypto.randomUUID(),
          };
    setIntent(next);
    decisionMutation.mutate(next);
  }

  const prior = snapshot?.observations.find(
    (observation) => observation.label === "prior"
  );
  const corrected = snapshot?.observations.find(
    (observation) => observation.label === "corrected"
  );
  const finalized = snapshot?.state !== "pending";

  return (
    <section
      className="border-t border-line bg-carbon/[0.28]"
      aria-labelledby="resolution-title"
    >
      <div className="mx-auto max-w-[1480px] px-5 py-16 sm:px-8 sm:py-20 lg:px-12">
        <div className="grid gap-10 lg:grid-cols-12">
          <div className="lg:col-span-4">
            <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.22em] text-mint">
              03 / Memory resolution loop
            </p>
            <h2
              id="resolution-title"
              className="max-w-md font-editorial text-5xl tracking-editorial text-paper sm:text-6xl"
            >
              Memory can learn.
              <span className="block italic text-muted">
                Authority stays human.
              </span>
            </h2>
            <p className="mt-6 max-w-sm text-sm leading-6 text-paper/[0.68]">
              Open a disposable session, inspect two longitudinally conflicting
              sources, then act as the financial controller. Approval runs a
              real serializable CockroachDB transaction; canonical demo memory
              is never writable.
            </p>
            <div className="mt-6 border-l-2 border-mint/60 pl-4 text-xs leading-5 text-paper/[0.62]">
              <p>Opaque 256-bit capability · fixed synthetic inputs</p>
              <p>Idempotent decision · immutable SHA-256 receipt</p>
              <p>Row-level TTL · no external side effects</p>
              <p>Demo role assertion · no enterprise identity claim</p>
            </div>
          </div>

          <div className="lg:col-span-8">
            {!snapshot ? (
              <div className="flex min-h-80 flex-col items-start justify-between border border-line bg-ink p-6 sm:p-8">
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted">
                    Fixed scenario / June 2026 payroll
                  </p>
                  <p className="mt-5 max-w-2xl font-editorial text-3xl leading-tight tracking-editorial text-paper">
                    A newer signed payroll register contradicts the current
                    employer-cost memory. The agent may propose a correction,
                    but it cannot make the decision.
                  </p>
                </div>
                <button
                  className="mt-8 bg-mint px-5 py-3 text-[10px] font-bold uppercase tracking-[0.17em] text-ink transition hover:bg-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-paper disabled:cursor-wait disabled:opacity-50"
                  type="button"
                  onClick={startSession}
                  disabled={createMutation.isPending}
                >
                  {createMutation.isPending
                    ? "Opening isolated session…"
                    : "Start resolution session"}
                </button>
                {createMutation.error && (
                  <p className="mt-5 text-sm text-ember" role="alert">
                    {formatApiError(createMutation.error)}
                  </p>
                )}
              </div>
            ) : (
              <div className="border border-line bg-ink">
                <div className="flex flex-wrap items-start justify-between gap-4 border-b border-line px-5 py-4">
                  <div>
                    <p className="text-[9px] font-bold uppercase tracking-[0.17em] text-muted">
                      {snapshot.scenarioId}
                    </p>
                    <p
                      className={`mt-2 text-xs font-bold uppercase tracking-[0.16em] ${
                        snapshot.state === "pending"
                          ? "text-acid"
                          : "text-mint"
                      }`}
                      role="status"
                    >
                      {stateLabel(snapshot)}
                    </p>
                  </div>
                  <p className="font-mono text-[10px] text-muted">
                    expires / {formattedTime(snapshot.expiresAt)} UTC
                  </p>
                </div>

                <div className="grid gap-px bg-line sm:grid-cols-2">
                  {[prior, corrected].map((observation) =>
                    observation ? (
                      <article className="bg-carbon p-5" key={observation.id}>
                        <div className="flex items-center justify-between gap-4">
                          <p className="text-[9px] font-bold uppercase tracking-[0.17em] text-muted">
                            {observation.label === "prior"
                              ? "Session A / prior memory"
                              : "Session B / corrected evidence"}
                          </p>
                          <span
                            className={`font-mono text-[9px] uppercase ${
                              observation.status === "current"
                                ? "text-mint"
                                : observation.status === "superseded" ||
                                    observation.status === "rejected"
                                  ? "text-ember"
                                  : "text-acid"
                            }`}
                          >
                            {observation.status}
                          </span>
                        </div>
                        <p className="mt-6 font-editorial text-4xl tracking-editorial text-paper">
                          {observation.employerCostDisplay}
                        </p>
                        <p className="mt-2 text-xs text-paper/[0.64]">
                          Employer cost · authority{" "}
                          {observation.authorityRank}/100
                        </p>
                        <p className="mt-5 break-all font-mono text-[10px] leading-4 text-muted">
                          {observation.sourceRef}
                        </p>
                        <p className="mt-1 font-mono text-[10px] text-muted">
                          observed / {formattedTime(observation.observedAt)}
                        </p>
                      </article>
                    ) : null
                  )}
                </div>

                <div className="border-t border-line p-5 sm:p-6">
                  <p className="text-[9px] font-bold uppercase tracking-[0.17em] text-mint">
                    Agent proposal · financial-controller approval required
                  </p>
                  <p className="mt-3 max-w-3xl text-sm leading-6 text-paper/[0.72]">
                    {snapshot.proposal.rationale}
                  </p>

                  {!finalized ? (
                    <div className="mt-6 flex flex-wrap gap-3">
                      <button
                        className="bg-mint px-5 py-3 text-[10px] font-bold uppercase tracking-[0.17em] text-ink transition hover:bg-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-paper disabled:cursor-wait disabled:opacity-40"
                        type="button"
                        onClick={() => decide("approve")}
                        disabled={
                          decisionMutation.isPending ||
                          (intent !== null && intent.decision !== "approve")
                        }
                      >
                        {intent?.decision === "approve" &&
                        decisionMutation.error
                          ? "Retry same approval"
                          : decisionMutation.isPending &&
                              intent?.decision === "approve"
                            ? "Committing approval…"
                            : "Approve correction"}
                      </button>
                      <button
                        className="border border-ember/60 px-5 py-3 text-[10px] font-bold uppercase tracking-[0.17em] text-ember transition hover:border-paper hover:text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember disabled:cursor-wait disabled:opacity-40"
                        type="button"
                        onClick={() => decide("reject")}
                        disabled={
                          decisionMutation.isPending ||
                          (intent !== null && intent.decision !== "reject")
                        }
                      >
                        {intent?.decision === "reject" &&
                        decisionMutation.error
                          ? "Retry same rejection"
                          : decisionMutation.isPending &&
                              intent?.decision === "reject"
                            ? "Committing rejection…"
                            : "Reject correction"}
                      </button>
                    </div>
                  ) : (
                    <div className="mt-6 border border-mint/25 bg-mint/[0.035] p-5">
                      <p className="text-[9px] font-bold uppercase tracking-[0.17em] text-mint">
                        Session C / consolidated current memory
                      </p>
                      <p className="mt-3 font-editorial text-3xl tracking-editorial text-paper">
                        {
                          snapshot.observations.find(
                            (observation) => observation.status === "current"
                          )?.employerCostDisplay
                        }
                      </p>
                      <p className="mt-4 break-all font-mono text-[10px] leading-5 text-muted">
                        receipt / {snapshot.receipt?.digest}
                      </p>
                      <p className="mt-1 font-mono text-[10px] text-muted">
                        policy / {snapshot.receipt?.policyVersion} · actor /{" "}
                        {snapshot.receipt?.actorRole}
                      </p>
                    </div>
                  )}

                  {decisionMutation.error && (
                    <div
                      className="mt-4 border-l-2 border-ember bg-ember/[0.04] px-4 py-3"
                      role="alert"
                    >
                      <p className="text-xs leading-5 text-paper/75">
                        {formatApiError(decisionMutation.error)}
                      </p>
                      <p className="mt-1 text-[10px] leading-4 text-muted">
                        The retry button reuses the identical idempotency key;
                        no second decision is created.
                      </p>
                    </div>
                  )}

                  {finalized && (
                    <button
                      className="mt-6 border-b border-paper/30 pb-1 text-[9px] font-bold uppercase tracking-[0.17em] text-paper hover:border-mint hover:text-mint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint"
                      type="button"
                      onClick={startSession}
                    >
                      Start a fresh disposable session
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
