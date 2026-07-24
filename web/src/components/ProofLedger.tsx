import { formatApiError, PUBLIC_COMPANY, type ProofSnapshot } from "../lib/api";

interface ProofLedgerProps {
  proof: ProofSnapshot | undefined;
  auditMemoryCount: number | null;
  isLoading: boolean;
  isFetching: boolean;
  error: unknown;
}

function display(value: string | number | null | undefined): string {
  return value === null || value === undefined || value === "" ? "Not reported" : String(value);
}

function modelName(value: string | null): string {
  if (!value) return "Not reported";
  return value.replace(/^(?:us|eu)\./, "").replace(/:0$/, "");
}

export function ProofLedger({
  proof,
  auditMemoryCount,
  isLoading,
  isFetching,
  error,
}: ProofLedgerProps) {
  const memoryCount = proof?.memoryCount ?? auditMemoryCount;
  const cspannVerified = proof?.vectorIndex.enabled === true;
  const company = proof?.scope.company ?? PUBLIC_COMPANY;

  return (
    <aside className="border-t border-line lg:border-l lg:border-t-0 lg:pl-8" aria-labelledby="proof-title">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-ember">Live proof</p>
          <h2 id="proof-title" className="mt-3 font-editorial text-3xl tracking-editorial text-paper">
            System ledger
          </h2>
        </div>
        <span
          className={`mt-1 h-2 w-2 rounded-full ${
            isFetching
              ? "animate-slow-pulse bg-paper"
              : error
                ? "bg-ember"
                : proof?.hasEvidence
                  ? "bg-mint shadow-[0_0_12px_rgba(156,230,200,0.65)]"
                  : "bg-muted"
          }`}
          aria-hidden="true"
        />
      </div>

      {isLoading && !proof ? (
        <div className="mt-8 space-y-px bg-line" role="status" aria-label="Loading infrastructure proof">
          {[1, 2, 3, 4, 5].map((item) => (
            <div className="h-24 animate-slow-pulse bg-paper/[0.025]" key={item} />
          ))}
        </div>
      ) : (
        <>
          {error && (
            <div className="mt-6 border-l-2 border-ember bg-ember/[0.04] px-4 py-3" role="alert">
              <p className="text-xs leading-5 text-paper/[0.72]">{formatApiError(error)}</p>
              <p className="mt-1 text-[10px] uppercase tracking-[0.12em] text-muted">
                {proof ? "Showing the last successful snapshot" : "Metrics withheld"}
              </p>
            </div>
          )}

          {!error && proof && !proof.hasEvidence && (
            <div
              className="mt-6 border-l-2 border-ember bg-ember/[0.04] px-4 py-3 text-xs leading-5 text-paper/70"
              data-testid="proof-unverifiable"
            >
              The proof endpoint responded, but did not report verifiable infrastructure fields.
            </div>
          )}

          <dl className="mt-8 border-y border-line">
            <div className="grid grid-cols-[6.5rem_1fr] gap-4 border-b border-line py-5">
              <dt className="text-[9px] font-bold uppercase tracking-[0.17em] text-muted">Memory facts</dt>
              <dd className="text-right">
                <span className="font-editorial text-3xl tracking-editorial text-paper">
                  {memoryCount ?? "—"}
                </span>
                <span className="mt-1 block text-[10px] uppercase tracking-[0.12em] text-muted">
                  active synthetic records
                </span>
              </dd>
            </div>

            <div className="grid grid-cols-[6.5rem_1fr] gap-4 border-b border-line py-5">
              <dt className="text-[9px] font-bold uppercase tracking-[0.17em] text-muted">C-SPANN</dt>
              <dd className="text-right">
                <span className={`font-mono text-xs font-bold uppercase ${cspannVerified ? "text-mint" : "text-paper"}`}>
                  {proof?.vectorIndex.enabled === null || proof?.vectorIndex.enabled === undefined
                    ? "Not reported"
                    : cspannVerified
                      ? "Index verified"
                      : "Not verified"}
                </span>
                <span className="mt-2 block font-mono text-[10px] leading-5 text-muted">
                  {proof?.vectorIndex.dimensions ? `${proof.vectorIndex.dimensions} dimensions` : "dimensions unavailable"}
                  {" · "}
                  {proof?.vectorIndex.metric ?? "metric unavailable"}
                </span>
                {proof?.vectorIndex.name && (
                  <span className="block break-all font-mono text-[10px] leading-5 text-muted">
                    {proof.vectorIndex.name}
                  </span>
                )}
                {proof?.vectorIndex.evidence && (
                  <span className="block font-mono text-[10px] leading-5 text-muted">
                    {proof.vectorIndex.lifecycleState ?? "state unreported"} ·{" "}
                    {proof.vectorIndex.evidence}
                  </span>
                )}
                {proof?.vectorIndex.definitionFingerprint && (
                  <span className="block break-all font-mono text-[10px] leading-5 text-muted">
                    definition sha256 · {proof.vectorIndex.definitionFingerprint}
                  </span>
                )}
              </dd>
            </div>

            <div className="grid grid-cols-[6.5rem_1fr] gap-4 border-b border-line py-5">
              <dt className="text-[9px] font-bold uppercase tracking-[0.17em] text-muted">CockroachDB</dt>
              <dd className="text-right">
                <span className="font-mono text-xs text-paper">
                  {display(proof?.database.provider)}
                </span>
                <span className="mt-2 block font-mono text-[10px] leading-5 text-muted">
                  {[proof?.database.version, proof?.database.region].filter(Boolean).join(" · ") || "version and region not reported"}
                </span>
                {proof?.database.topology && (
                  <span className="block font-mono text-[10px] leading-5 text-muted">
                    {proof.database.topology}
                  </span>
                )}
                {proof?.database.runtimePrincipal && (
                  <span className="block break-all font-mono text-[10px] leading-5 text-muted">
                    role {proof.database.runtimePrincipal}
                  </span>
                )}
                {proof?.database.regionEvidence && (
                  <span className="block font-mono text-[10px] leading-5 text-muted">
                    region evidence · {proof.database.regionEvidence}
                  </span>
                )}
              </dd>
            </div>

            <div className="grid grid-cols-[6.5rem_1fr] gap-4 py-5">
              <dt className="text-[9px] font-bold uppercase tracking-[0.17em] text-muted">Bedrock</dt>
              <dd className="space-y-2 text-right">
                <p>
                  <span className="block text-[9px] uppercase tracking-[0.14em] text-muted">Embeddings</span>
                  <span className="break-all font-mono text-[10px] leading-5 text-paper">
                    {modelName(proof?.embeddingModel ?? null)}
                  </span>
                </p>
                <p>
                  <span className="block text-[9px] uppercase tracking-[0.14em] text-muted">Narration</span>
                  <span className="break-all font-mono text-[10px] leading-5 text-paper">
                    {modelName(proof?.narrationModel ?? null)}
                  </span>
                </p>
              </dd>
            </div>
          </dl>

          <div className="mt-6 border border-mint/20 bg-mint/[0.025] p-4">
            <p className="text-[9px] font-bold uppercase tracking-[0.17em] text-mint">
              Demonstration scope
            </p>
            <p className="mt-2 font-mono text-xs text-paper">{company}</p>
            <p className="mt-1 text-[10px] leading-5 text-muted">
              {proof?.scope.mode === "fixed-synthetic-demo"
                ? "Fixed synthetic public dataset · read-only"
                : proof?.scope.mode ?? "Scope mode not reported"}
            </p>
          </div>

          {proof && proof.features.length > 0 && (
            <div className="mt-6">
              <p className="text-[9px] font-bold uppercase tracking-[0.17em] text-muted">Reported features</p>
              <ul className="mt-3 space-y-2">
                {proof.features.map((feature) => (
                  <li className="flex gap-3 text-xs leading-5 text-paper/[0.68]" key={feature}>
                    <span className="text-mint" aria-hidden="true">✓</span>
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </aside>
  );
}
