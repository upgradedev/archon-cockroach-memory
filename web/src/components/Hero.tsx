import { PUBLIC_COMPANY } from "../lib/api";

export function Hero() {
  return (
    <section className="relative overflow-hidden border-b border-line" aria-labelledby="hero-title">
      <div className="pointer-events-none absolute -right-32 -top-40 h-[34rem] w-[34rem] rounded-full border border-ember/[0.15] bg-ember/[0.035] blur-3xl" />
      <div className="mx-auto grid max-w-[1480px] gap-10 px-5 py-12 sm:px-8 sm:py-16 lg:grid-cols-12 lg:px-12 lg:py-20">
        <div className="lg:col-span-8">
          <div className="mb-4 flex flex-wrap items-center gap-2 text-[10px] font-bold uppercase tracking-[0.2em]">
            <span className="border border-ember/30 bg-ember/10 px-2.5 py-1 text-ember">
              Executive AI Guardrail
            </span>
            <span className="border border-mint/30 bg-mint/10 px-2.5 py-1 text-mint">
              EU AI Act Compliant
            </span>
            <span className="border border-paper/20 bg-paper/5 px-2.5 py-1 text-paper/80">
              CockroachDB Distributed Memory
            </span>
          </div>

          <h1
            id="hero-title"
            className="max-w-5xl font-editorial text-[clamp(2.8rem,7vw,6.5rem)] leading-[0.88] tracking-editorial text-paper"
          >
            Financial Agent Memory
            <span className="block italic text-muted">That Disagrees Out Loud.</span>
          </h1>

          <p className="mt-5 max-w-3xl text-lg leading-relaxed text-paper/80 font-sans">
            Ordinary AI chatbots smooth over financial contradictions and hallucinate. Archon Memory <strong className="text-paper font-semibold">actively flags invoice discrepancies</strong> and missing payment proof <strong className="text-ember font-semibold">BEFORE</strong> a CFO approves or executes a transfer.
          </p>

          {/* KPI Badges Grid */}
          <div className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-4 max-w-3xl">
            <div className="border border-line bg-carbon/40 p-3 rounded-none">
              <span className="block text-[10px] font-mono text-muted uppercase tracking-wider">Grounding</span>
              <span className="text-sm font-bold text-mint">100% Cited</span>
            </div>
            <div className="border border-line bg-carbon/40 p-3 rounded-none">
              <span className="block text-[10px] font-mono text-muted uppercase tracking-wider">EU AI Act</span>
              <span className="text-sm font-bold text-mint">Compliant (Art 14/50)</span>
            </div>
            <div className="border border-line bg-carbon/40 p-3 rounded-none">
              <span className="block text-[10px] font-mono text-muted uppercase tracking-wider">p95 Latency</span>
              <span className="text-sm font-bold text-paper">&lt; 1500 ms</span>
            </div>
            <div className="border border-line bg-carbon/40 p-3 rounded-none">
              <span className="block text-[10px] font-mono text-muted uppercase tracking-wider">Audit Security</span>
              <span className="text-sm font-bold text-ember">SHA-256 Sealed</span>
            </div>
          </div>
        </div>

        <div className="flex flex-col justify-between border-l border-line pl-5 lg:col-span-4 lg:pl-8">
          <div>
            <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-ember mb-3">
              Operational User Journey
            </h3>
            <ol className="space-y-4 text-xs text-paper/75">
              <li className="flex items-start gap-3">
                <span className="font-mono font-bold text-mint bg-mint/10 border border-mint/30 px-1.5 py-0.5 text-[10px]">1</span>
                <div>
                  <strong className="text-paper block font-semibold">Recall or Ingest Facts</strong>
                  <span>Ask financial questions or inject custom facts via Sandbox API.</span>
                </div>
              </li>
              <li className="flex items-start gap-3">
                <span className="font-mono font-bold text-ember bg-ember/10 border border-ember/30 px-1.5 py-0.5 text-[10px]">2</span>
                <div>
                  <strong className="text-paper block font-semibold">Inspect Discrepancy Radar</strong>
                  <span>Auto-detect conflicting invoices (€18.4k vs €18.9k) & missing proof.</span>
                </div>
              </li>
              <li className="flex items-start gap-3">
                <span className="font-mono font-bold text-paper bg-paper/10 border border-paper/30 px-1.5 py-0.5 text-[10px]">3</span>
                <div>
                  <strong className="text-paper block font-semibold">Human Gate & SHA-256 Receipt</strong>
                  <span>Executive approves correction and receives a tamper-evident audit seal.</span>
                </div>
              </li>
            </ol>
          </div>

          <div className="mt-8 border-t border-line pt-4">
            <div className="flex items-center gap-3">
              <span className="border border-mint/40 bg-mint/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-mint">
                Canonical Scope
              </span>
              <span className="font-mono text-xs text-muted">{PUBLIC_COMPANY}</span>
            </div>
            <p className="mt-2 text-[11px] leading-4 text-muted">
              Public, read-only demonstration data stays canonical. Sandbox test writes expire automatically via CockroachDB TTL (1h).
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
