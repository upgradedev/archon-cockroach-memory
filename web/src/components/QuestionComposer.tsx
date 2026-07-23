import { useState, type FormEvent } from "react";

const SUGGESTED_QUESTIONS = [
  "What was Helios SA’s true employer cost and how much was invisible on the bank statement?",
  "Which payments are missing a matching source document?",
  "Does the memory contain conflicting values for the same financial record?",
  "What evidence should a CFO review before closing April 2026?",
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
      <div className="mb-6 flex items-end justify-between gap-6">
        <div>
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-ember">
            Ask the memory
          </p>
          <h2 id="ask-title" className="font-editorial text-4xl tracking-editorial text-paper sm:text-5xl">
            Start with the evidence.
          </h2>
        </div>
        <span className="hidden font-mono text-[10px] uppercase tracking-[0.12em] text-muted sm:block">
          Read-only / top 5
        </span>
      </div>

      <form className="border-y border-line py-5" onSubmit={submit}>
        <label className="sr-only" htmlFor="memory-question">
          Financial question for the Archon memory
        </label>
        <textarea
          id="memory-question"
          className="min-h-32 w-full resize-y bg-transparent font-editorial text-2xl leading-snug tracking-editorial text-paper outline-none placeholder:text-paper/25 focus-visible:ring-0 sm:text-3xl"
          value={question}
          onChange={(event) => setQuestion(event.target.value.slice(0, 500))}
          placeholder="Ask what the books forgot to tell you…"
          maxLength={500}
          rows={3}
          aria-describedby="question-help"
          disabled={isPending}
        />
        <div className="mt-4 flex items-center justify-between gap-4">
          <p id="question-help" className="text-xs leading-5 text-muted">
            Grounded recall over the fixed synthetic Helios SA memory.
          </p>
          <span className="font-mono text-[10px] text-muted" aria-label={`${question.length} of 500 characters`}>
            {question.length}/500
          </span>
        </div>
        <button
          className="mt-5 inline-flex min-h-12 items-center gap-6 bg-paper px-5 py-3 text-xs font-bold uppercase tracking-[0.18em] text-ink transition hover:bg-mint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint focus-visible:ring-offset-4 focus-visible:ring-offset-ink disabled:cursor-not-allowed disabled:bg-paper/25 disabled:text-ink/60"
          type="submit"
          disabled={!normalizedQuestion || isPending}
        >
          <span>{isPending ? "Retrieving evidence…" : "Ask Archon"}</span>
          <span aria-hidden="true">↗</span>
        </button>
      </form>

      <div className="mt-6">
        <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted">
          Suggested investigations
        </p>
        <div className="grid gap-px overflow-hidden border border-line bg-line sm:grid-cols-2">
          {SUGGESTED_QUESTIONS.map((suggestion, position) => (
            <button
              key={suggestion}
              className="group flex min-h-24 items-start gap-4 bg-ink px-4 py-4 text-left text-sm leading-5 text-paper/[0.72] transition hover:bg-carbon hover:text-paper focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-mint disabled:cursor-wait disabled:opacity-50"
              type="button"
              onClick={() => askSuggested(suggestion)}
              disabled={isPending}
            >
              <span className="font-mono text-[10px] text-ember">0{position + 1}</span>
              <span>{suggestion}</span>
              <span className="ml-auto text-muted transition group-hover:translate-x-0.5 group-hover:text-mint" aria-hidden="true">
                →
              </span>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
