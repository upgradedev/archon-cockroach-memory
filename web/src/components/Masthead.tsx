import type { ServiceHealth } from "../lib/api";

interface MastheadProps {
  health: ServiceHealth | undefined;
  isLoading: boolean;
  hasError: boolean;
  isRefreshing: boolean;
  onRefresh: () => void;
}

export function Masthead({
  health,
  isLoading,
  hasError,
  isRefreshing,
  onRefresh,
}: MastheadProps) {
  const state = isLoading && !health
    ? "checking"
    : hasError
      ? "unavailable"
      : health?.status ?? "degraded";
  const healthy = state === "reachable";

  return (
    <header className="relative z-20 border-b border-line bg-ink/90 backdrop-blur-xl">
      <div className="mx-auto flex max-w-[1480px] items-center justify-between gap-5 px-5 py-4 sm:px-8 lg:px-12">
        <a
          className="group flex items-baseline gap-3 outline-none focus-visible:ring-2 focus-visible:ring-mint"
          href="#top"
          aria-label="Archon Memory Control Room home"
        >
          <span className="font-editorial text-2xl italic tracking-editorial text-paper sm:text-3xl">
            Archon
          </span>
          <span className="hidden border-l border-line pl-3 text-[10px] font-semibold uppercase tracking-[0.22em] text-muted sm:inline">
            Memory Control Room
          </span>
        </a>

        <div className="flex items-center gap-3 sm:gap-5">
          <div
            className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.16em]"
            role="status"
            aria-live="polite"
          >
            <span
              className={`h-2 w-2 rounded-full ${
                healthy
                  ? "bg-mint shadow-[0_0_16px_rgba(156,230,200,0.7)]"
                  : state === "checking"
                    ? "animate-slow-pulse bg-paper"
                    : "bg-ember"
              }`}
              aria-hidden="true"
            />
            <span className={healthy ? "text-mint" : "text-muted"}>
              {state === "reachable"
                ? "API reachable"
                : state === "checking"
                  ? "Checking"
                  : state === "unavailable"
                    ? "Proof unavailable"
                    : "Degraded"}
            </span>
          </div>
          <button
            className="border border-line px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-paper transition hover:border-paper/40 hover:bg-paper/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint disabled:cursor-wait disabled:opacity-50"
            type="button"
            onClick={onRefresh}
            disabled={isRefreshing}
          >
            {isRefreshing ? "Refreshing…" : "Refresh proof"}
          </button>
        </div>
      </div>
    </header>
  );
}
