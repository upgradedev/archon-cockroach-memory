import { formatApiError, type AuditReport } from "../lib/api";

interface AuditLedgerProps {
  report: AuditReport | undefined;
  isLoading: boolean;
  isFetching: boolean;
  error: unknown;
  onRefresh: () => void;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "not reported";
  if (typeof value === "number") {
    return new Intl.NumberFormat("en-IE", { maximumFractionDigits: 2 }).format(value);
  }
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  try {
    return JSON.stringify(value) ?? "unreadable value";
  } catch {
    return "unreadable value";
  }
}

function formatTimestamp(value: string | null): string {
  if (!value) return "time not reported";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("en-GB", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      }).format(date);
}

function confidenceLabel(value: number | null): string {
  if (value === null) return "signal not reported";
  const percent = value <= 1 ? value * 100 : value;
  return `${Math.max(0, Math.min(100, Math.round(percent)))} / 100 heuristic signal`;
}

export function AuditLedger({
  report,
  isLoading,
  isFetching,
  error,
  onRefresh,
}: AuditLedgerProps) {
  return (
    <section className="border-t border-line" aria-labelledby="audit-title">
      <div className="mx-auto max-w-[1480px] px-5 py-16 sm:px-8 sm:py-20 lg:px-12">
        <div className="grid gap-8 lg:grid-cols-12">
          <div className="lg:col-span-4">
            <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.22em] text-ember">
              02 / Integrity ledger
            </p>
            <h2 id="audit-title" className="max-w-md font-editorial text-5xl tracking-editorial text-paper sm:text-6xl">
              The memory audits itself.
            </h2>
            <p className="mt-6 max-w-sm text-sm leading-6 text-paper/[0.65]">
              Separate sessions can remember the same record differently—or point to evidence that
              was never stored. This read-only audit exposes both before a decision is made.
            </p>
            <button
              className="mt-7 border-b border-paper/[0.35] pb-1 text-[10px] font-bold uppercase tracking-[0.18em] text-paper transition hover:border-mint hover:text-mint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint disabled:cursor-wait disabled:opacity-50"
              type="button"
              onClick={onRefresh}
              disabled={isFetching}
            >
              {isFetching ? "Auditing…" : "Run audit again"}
            </button>
          </div>

          <div className="lg:col-span-8">
            {isLoading && !report ? (
              <div className="space-y-3" role="status" aria-label="Loading memory audit">
                <div className="h-24 animate-slow-pulse border border-line bg-paper/[0.025]" />
                <div className="h-56 animate-slow-pulse border border-line bg-paper/[0.025]" />
                <div className="h-44 animate-slow-pulse border border-line bg-paper/[0.025]" />
              </div>
            ) : error && !report ? (
              <div className="border border-ember/[0.35] bg-ember/[0.035] p-6" role="alert">
                <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-ember">
                  Audit unavailable
                </p>
                <p className="mt-4 text-sm leading-6 text-paper/[0.72]">{formatApiError(error)}</p>
                <p className="mt-2 text-xs leading-5 text-muted">
                  No “all clear” result is inferred while the audit endpoint is unavailable.
                </p>
              </div>
            ) : report ? (
              <>
                {error && (
                  <div className="mb-4 border-l-2 border-ember bg-ember/[0.04] px-4 py-3 text-xs leading-5 text-paper/70">
                    Refresh failed. The ledger below is the last successful snapshot.
                  </div>
                )}

                <div className="grid gap-px border border-line bg-line sm:grid-cols-3">
                  <div className="bg-carbon p-5">
                    <p className="text-[9px] font-bold uppercase tracking-[0.17em] text-muted">Memories audited</p>
                    <p className="mt-3 font-editorial text-4xl tracking-editorial text-paper">
                      {report.audited ?? report.memoryCount ?? "—"}
                    </p>
                  </div>
                  <div className="bg-carbon p-5">
                    <p className="text-[9px] font-bold uppercase tracking-[0.17em] text-muted">Conflicts</p>
                    <p className={`mt-3 font-editorial text-4xl tracking-editorial ${report.conflicts.length ? "text-ember" : "text-mint"}`}>
                      {report.conflicts.length}
                    </p>
                  </div>
                  <div className="bg-carbon p-5">
                    <p className="text-[9px] font-bold uppercase tracking-[0.17em] text-muted">Missing evidence</p>
                    <p className={`mt-3 font-editorial text-4xl tracking-editorial ${report.absences.length ? "text-acid" : "text-mint"}`}>
                      {report.absences.length}
                    </p>
                  </div>
                </div>

                {report.summary && (
                  <p className="border-x border-b border-line px-5 py-4 text-sm leading-6 text-paper/70">
                    {report.summary}
                  </p>
                )}

                {!report.coverage.complete ? (
                  <div className="mt-4 border border-acid/30 bg-acid/[0.035] p-6">
                    <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-acid">
                      Coverage limited
                    </p>
                    <p className="mt-3 text-sm leading-6 text-paper/70">
                      This response scanned {report.coverage.scanned ?? "an unreported number of"} of{" "}
                      {report.coverage.total ?? "an unreported total of"} memories. No all-clear
                      conclusion is shown until the fixed demo scope is completely audited.
                    </p>
                  </div>
                ) : report.ok ? (
                  <div className="mt-4 border border-mint/30 bg-mint/[0.035] p-6">
                    <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-mint">
                      No findings in this scope
                    </p>
                    <p className="mt-3 text-sm leading-6 text-paper/70">
                      The live report contains no cross-session conflict or dangling reference. This
                      is an audit result, not a guarantee that every source document exists.
                    </p>
                  </div>
                ) : (
                  <div className="mt-4 space-y-4">
                    {report.conflicts.map((conflict) => (
                      <article
                        key={`${conflict.subject}-${conflict.attribute}`}
                        className="overflow-hidden border border-ember/30 bg-carbon"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
                          <div>
                            <p className="text-[9px] font-bold uppercase tracking-[0.17em] text-ember">
                              Cross-session conflict
                            </p>
                            <h3 className="mt-2 font-editorial text-2xl tracking-editorial text-paper">
                              {conflict.subject}
                              <span className="mx-2 text-muted">/</span>
                              <span className="italic">{conflict.attribute}</span>
                            </h3>
                          </div>
                          <span className="font-mono text-[10px] text-muted">
                            {conflict.values.length} competing records
                          </span>
                        </div>

                        <div className="grid gap-px bg-line sm:grid-cols-2">
                          {conflict.values.map((value) => (
                            <div className="bg-ink p-5" key={value.memoryId}>
                              <p className="break-words font-editorial text-3xl tracking-editorial text-paper">
                                {formatValue(value.value)}
                              </p>
                              <p className="mt-4 break-all font-mono text-[10px] text-muted">
                                memory / {value.memoryId}
                              </p>
                              <p className="mt-1 font-mono text-[10px] text-muted">
                                {formatTimestamp(value.createdAt)}
                              </p>
                            </div>
                          ))}
                        </div>

                        <div className="border-t border-mint/20 bg-mint/[0.035] px-5 py-5">
                          <div className="flex flex-wrap items-start justify-between gap-5">
                            <div>
                              <p className="text-[9px] font-bold uppercase tracking-[0.17em] text-mint">
                                Read-only recommendation
                              </p>
                              <p className="mt-3 font-editorial text-2xl tracking-editorial text-paper">
                                {conflict.resolution
                                  ? formatValue(conflict.resolution.recommendedValue)
                                  : "Human review required"}
                              </p>
                            </div>
                            {conflict.resolution && (
                              <div className="max-w-sm text-xs leading-5 text-paper/[0.68]">
                                <p>{conflict.resolution.rationale}</p>
                                <p className="mt-2 font-mono text-[10px] text-muted">
                                  rule / {conflict.resolution.rule} · {confidenceLabel(conflict.resolution.confidence)}
                                </p>
                              </div>
                            )}
                          </div>
                        </div>
                      </article>
                    ))}

                    {report.absences.map((absence) => (
                      <article
                        key={absence.subject}
                        className="grid border border-acid/25 bg-carbon sm:grid-cols-[minmax(0,1fr)_minmax(16rem,0.62fr)]"
                      >
                        <div className="p-5">
                          <p className="text-[9px] font-bold uppercase tracking-[0.17em] text-acid">
                            Missing counterpart
                          </p>
                          <h3 className="mt-3 break-words font-editorial text-3xl tracking-editorial text-paper">
                            {absence.subject}
                          </h3>
                          <p className="mt-4 font-mono text-[10px] leading-5 text-muted">
                            Referenced by{" "}
                            {absence.referencedBy.length
                              ? absence.referencedBy.map((reference) => reference.memoryId).join(", ")
                              : "an unreported memory"}
                          </p>
                        </div>
                        <div className="border-t border-line bg-acid/[0.025] p-5 sm:border-l sm:border-t-0">
                          <p className="text-[9px] font-bold uppercase tracking-[0.17em] text-muted">
                            Recommended operator check
                          </p>
                          <p className="mt-3 text-sm leading-6 text-paper/[0.72]">
                            {absence.recommendation
                              ?? "Locate the source record, then ingest the missing evidence or correct the dangling reference."}
                          </p>
                          <p className="mt-3 text-[10px] uppercase tracking-[0.14em] text-muted">
                            No automatic mutation
                          </p>
                        </div>
                      </article>
                    ))}
                  </div>
                )}

                {report.recommendations.length > 0 && (
                  <div className="mt-4 border border-line p-5">
                    <p className="text-[9px] font-bold uppercase tracking-[0.17em] text-muted">
                      Audit recommendations
                    </p>
                    <ul className="mt-3 space-y-2 text-sm leading-6 text-paper/70">
                      {report.recommendations.map((recommendation) => (
                        <li className="flex gap-3" key={recommendation}>
                          <span className="text-mint" aria-hidden="true">↳</span>
                          <span>{recommendation}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
