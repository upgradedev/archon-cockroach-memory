import { PUBLIC_COMPANY } from "../lib/api";

export function Hero() {
  return (
    <section className="relative overflow-hidden border-b border-line" aria-labelledby="hero-title">
      <div className="pointer-events-none absolute -right-32 -top-40 h-[34rem] w-[34rem] rounded-full border border-ember/[0.15] bg-ember/[0.035] blur-3xl" />
      <div className="mx-auto grid max-w-[1480px] gap-10 px-5 py-14 sm:px-8 sm:py-20 lg:grid-cols-12 lg:px-12 lg:py-24">
        <div className="lg:col-span-8">
          <p className="mb-6 flex items-center gap-3 text-[10px] font-semibold uppercase tracking-[0.24em] text-ember">
            <span aria-hidden="true">01</span>
            Distributed evidence memory
          </p>
          <h1
            id="hero-title"
            className="max-w-5xl font-editorial text-[clamp(3.35rem,8vw,8.8rem)] leading-[0.82] tracking-editorial text-paper"
          >
            Memory that
            <span className="block italic text-muted">disagrees out loud.</span>
          </h1>
        </div>

        <div className="flex flex-col justify-end border-l border-line pl-5 lg:col-span-4 lg:pl-8">
          <p className="max-w-md text-base leading-7 text-paper/[0.78]">
            Ask a financial question. Inspect the exact memories behind the answer. Then audit what
            the agent remembers across sessions before trusting the result.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <span className="border border-mint/[0.35] bg-mint/[0.06] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-mint">
              Fixed synthetic scope
            </span>
            <span className="font-mono text-xs text-muted">{PUBLIC_COMPANY}</span>
          </div>
          <p className="mt-4 max-w-sm text-xs leading-5 text-muted">
            Public, read-only demonstration data. No customer records and no account or tenant
            selection.
          </p>
        </div>
      </div>
    </section>
  );
}
