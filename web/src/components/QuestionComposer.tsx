import { useState, type FormEvent } from "react";

const EXECUTIVE_SCENARIOS = [
  {
    tag: "SCENARIO A — INVOICE DISCREPANCY",
    question: "What was Helios SA’s true employer cost and how much was invisible on the bank statement?",
    detail: "Cross-references Slack approval (€18.4k) vs M&A contract (€18.9k) to expose silent variance."
  },
  {
    tag: "SCENARIO B — MISSING PAYMENT PROOF",
    question: "Which payments are missing a matching source document?",
    detail: "Identifies unanchored payment records (PAY-118) lacking bank receipt evidence."
  },
  {
    tag: "SCENARIO C — CONFLICT AUDIT",
    question: "Does the memory contain conflicting values for the same financial record?",
    detail: "Surfaces all multi-session record collisions across the CockroachDB vector memory."
  },
  {
    tag: "SCENARIO D — CFO CLOSE GATE",
    question: "What evidence should a CFO review before closing April 2026?",
    detail: "Executes complete-scope audit across employer costs, M&A clauses, and pending resolution loops."
  }
] as const;

interface QuestionComposerProps {
  isPending: boolean;
  onAsk: (question: string) => void;
}

export function QuestionComposer({ isPending, onAsk }: QuestionComposerProps) {
  const [question, setQuestion] = useState("");
  const normalizedQuestion = question.trim();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (normalizedQuestion && !isPending) onAsk(normalizedQuestion);
  }

  function askSuggested(suggestion: string) {
    setQuestion(suggestion);
    if (!isPending) onAsk(suggestion);
  }

  return (
    <section aria-labelledby="ask-title">
      <div className="mb-6 flex items-end justify-between gap-6 border-b border-line pb-4">
        <div>
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-ember">
            01 / Financial Query Engine
          </p>
          <h2 id="ask-title" className="font-editorial text-3xl tracking-editorial text-paper sm:text-4xl">
            Ask the Memory Guardrail
          </h2>
        </div>
        <span className="hidden font-mono text-[10px] uppercase tracking-[0.12em] text-mint sm:block">
          C-SPANN Vector Search Active
        </span>
      </div>

      <form className="py-2" onSubmit={submit}>
        <label className="sr-only" htmlFor="memory-question">
          Financial question for the Archon memory
        </label>
        <textarea
          id="memory-question"
          className="min-h-28 w-full resize-y bg-carbon/30 border border-line p-4 font-editorial text-xl leading-relaxed tracking-editorial text-paper outline-none placeholder:text-paper/30 focus:border-mint focus:ring-1 focus:ring-mint sm:text-2xl"
          value={question}
          onChange={(event) => setQuestion(event.target.value.slice(0, 500))}
          placeholder="Type your financial question or click an executive scenario below…"
          maxLength={500}
          rows={3}
          aria-describedby="question-help"
          disabled={isPending}
        />
        <div className="mt-3 flex items-center justify-between gap-4">
          <p id="question-help" className="text-xs leading-5 text-muted">
            Grounded recall over CockroachDB vector memory with line-by-line evidence citations.
          </p>
          <span className="font-mono text-[10px] text-muted" aria-label={`${question.length} of 500 characters`}>
            {question.length}/500
          </span>
        </div>
        <button
          className="mt-4 inline-flex min-h-12 items-center gap-4 bg-paper px-6 py-3 text-xs font-bold uppercase tracking-[0.18em] text-ink transition hover:bg-mint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint focus-visible:ring-offset-4 focus-visible:ring-offset-ink disabled:cursor-not-allowed disabled:bg-paper/25 disabled:text-ink/60"
          type="submit"
          disabled={!normalizedQuestion || isPending}
        >
          <span>{isPending ? "Retrieving & Citing Evidence…" : "Execute Financial Recall"}</span>
          <span aria-hidden="true">↗</span>
        </button>
      </form>

      <div className="mt-8">
        <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-ember">
          Executive One-Click Guided Scenarios
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {EXECUTIVE_SCENARIOS.map((item) => (
            <button
              key={item.tag}
              className="group flex flex-col justify-between border border-line bg-carbon/40 p-4 text-left transition hover:border-mint hover:bg-carbon focus-visible:z-10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-mint disabled:cursor-wait disabled:opacity-50"
              type="button"
              onClick={() => askSuggested(item.question)}
              disabled={isPending}
            >
              <div>
                <span className="block font-mono text-[9px] font-bold tracking-widest text-mint uppercase mb-1">
                  {item.tag}
                </span>
                <span className="text-xs font-semibold leading-snug text-paper group-hover:text-mint transition">
                  "{item.question}"
                </span>
              </div>
              <p className="mt-2 text-[11px] leading-4 text-muted border-t border-line/40 pt-2">
                {item.detail}
              </p>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
