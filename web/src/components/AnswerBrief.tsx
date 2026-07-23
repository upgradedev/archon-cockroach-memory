import type { ReactNode } from "react";
import { formatApiError, type RecallResult } from "../lib/api";

interface AnswerBriefProps {
  result: RecallResult | undefined;
  activeQuestion: string | null;
  isPending: boolean;
  error: unknown;
}

function citationId(marker: string): string {
  return `citation-${marker.replace(/\D/g, "") || "evidence"}`;
}

function renderGroundedText(answer: string, citations: RecallResult["citations"]): ReactNode[] {
  const knownMarkers = new Set(citations.map((citation) => citation.marker));
  return answer.split(/(\[\d+\])/g).map((part, position) => {
    if (knownMarkers.has(part)) {
      return (
        <a
          key={`${part}-${position}`}
          className="mx-0.5 align-super font-sans text-xs font-bold text-mint underline decoration-mint/[0.35] underline-offset-2 hover:decoration-mint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint"
          href={`#${citationId(part)}`}
          aria-label={`Jump to evidence ${part}`}
        >
          {part}
        </a>
      );
    }
    return <span key={`answer-${position}`}>{part}</span>;
  });
}

function formatScore(score: number | null): string {
  if (score === null || score < 0 || score > 1) return "Ranked evidence";
  return `${Math.round(score * 100)}% semantic match`;
}

export function AnswerBrief({ result, activeQuestion, isPending, error }: AnswerBriefProps) {
  if (isPending) {
    return (
      <section
        className="min-h-[34rem] border border-line bg-carbon/50 p-6 sm:p-8"
        aria-labelledby="answer-title"
        aria-busy="true"
      >
        <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-mint">Evidence brief</p>
        <h2 id="answer-title" className="mt-4 font-editorial text-3xl text-paper">
          Reading distributed memory…
        </h2>
        <div className="mt-10 space-y-4" role="status">
          <span className="sr-only">Retrieving and grounding the answer.</span>
          <div className="h-5 w-11/12 animate-slow-pulse bg-paper/10" />
          <div className="h-5 w-full animate-slow-pulse bg-paper/10" />
          <div className="h-5 w-8/12 animate-slow-pulse bg-paper/10" />
          <div className="mt-10 h-28 w-full animate-slow-pulse border border-line bg-paper/[0.025]" />
          <div className="h-28 w-full animate-slow-pulse border border-line bg-paper/[0.025]" />
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section
        className="min-h-[34rem] border border-ember/[0.35] bg-ember/[0.035] p-6 sm:p-8"
        aria-labelledby="answer-title"
        role="alert"
      >
        <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-ember">
          Recall unavailable
        </p>
        <h2 id="answer-title" className="mt-5 max-w-xl font-editorial text-4xl tracking-editorial text-paper">
          The question was not answered.
        </h2>
        <p className="mt-6 max-w-xl text-sm leading-6 text-paper/[0.72]">{formatApiError(error)}</p>
        <p className="mt-3 text-xs leading-5 text-muted">
          No cached or fabricated answer is shown. Check the service proof, then try again.
        </p>
      </section>
    );
  }

  if (!result) {
    return (
      <section
        className="flex min-h-[34rem] flex-col justify-between border border-line bg-carbon/[0.35] p-6 sm:p-8"
        aria-labelledby="answer-title"
      >
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted">Evidence brief</p>
          <h2 id="answer-title" className="mt-5 max-w-xl font-editorial text-4xl tracking-editorial text-paper sm:text-5xl">
            Every answer should leave a trail.
          </h2>
          <p className="mt-6 max-w-xl text-sm leading-6 text-paper/[0.65]">
            Ask a question to see the narrated result, its exact CockroachDB memories, semantic
            scores, model identity, and consistency signal together.
          </p>
        </div>
        <div className="mt-16 border-t border-line pt-5">
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
            Waiting for an investigation
          </p>
        </div>
      </section>
    );
  }

  const offlineModel = /fake|offline/i.test(result.modelId);
  const fallbackMarkers = result.citations.map((citation) => citation.marker).join(" ");
  const displayedAnswer =
    result.trace.grounding === "fallback"
      ? `Model narration was withheld because it did not pass every grounding guard. Review the exact CockroachDB evidence ${fallbackMarkers} below.`
      : result.answer;
  return (
    <section
      className="border border-line bg-carbon/50"
      aria-labelledby="answer-title"
      aria-live="polite"
    >
      <div className="border-b border-line p-6 sm:p-8">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-mint">
            Evidence brief
          </p>
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
            {result.recalled} memories recalled
          </span>
        </div>
        <p className="mt-5 text-xs font-medium uppercase tracking-[0.12em] text-muted">
          {activeQuestion ?? result.question}
        </p>
        <h2
          id="answer-title"
          className="mt-6 whitespace-pre-wrap font-editorial text-[clamp(1.8rem,3.5vw,3.25rem)] leading-[1.12] tracking-editorial text-paper"
        >
          {renderGroundedText(displayedAnswer, result.citations)}
        </h2>

        {(offlineModel || result.warning || result.consistencyOk === false) && (
          <div className="mt-7 space-y-2 border-l-2 border-ember bg-ember/[0.04] px-4 py-3 text-xs leading-5 text-paper/[0.72]">
            {offlineModel && (
              <p>
                Degraded narration: the response reports an offline or fallback model, so no live
                Bedrock claim is made.
              </p>
            )}
            {result.consistencyOk === false && (
              <p>The recalled set contains a consistency finding. Review the integrity ledger below.</p>
            )}
            {result.warning && <p>{result.warning}</p>}
          </div>
        )}

        <dl className="mt-8 grid gap-px border-y border-line bg-line sm:grid-cols-3">
          <div className="bg-carbon px-4 py-3">
            <dt className="text-[9px] uppercase tracking-[0.17em] text-muted">Narration</dt>
            <dd className="mt-1 break-all font-mono text-[11px] text-paper">{result.modelId}</dd>
          </div>
          <div className="bg-carbon px-4 py-3">
            <dt className="text-[9px] uppercase tracking-[0.17em] text-muted">Retrieval</dt>
            <dd className="mt-1 font-mono text-[11px] text-paper">
              {result.trace.retrieval ?? "vector-ranked"}
            </dd>
          </div>
          <div className="bg-carbon px-4 py-3">
            <dt className="text-[9px] uppercase tracking-[0.17em] text-muted">Grounding</dt>
            <dd
              className="mt-1 font-mono text-[11px] text-paper"
              data-testid="grounding-status"
            >
              {result.trace.grounding ?? "not reported"}
              {result.trace.durationMs !== null ? ` · ${Math.round(result.trace.durationMs)} ms` : ""}
            </dd>
          </div>
        </dl>
      </div>

      <div className="p-6 sm:p-8">
        <div className="mb-5 flex items-center justify-between">
          <h3 className="text-xs font-bold uppercase tracking-[0.18em] text-paper">Grounding record</h3>
          <span className="font-mono text-[10px] text-muted">Exact returned evidence</span>
        </div>
        {result.noEvidence ? (
          <div className="border border-line px-4 py-4 text-sm leading-6 text-paper/[0.68]">
            No relevant evidence exists in the fixed CockroachDB memory scope for this question.
            No model-generated claim was displayed.
          </div>
        ) : result.citations.length === 0 ? (
          <div className="border border-ember/30 px-4 py-4 text-sm leading-6 text-paper/[0.68]">
            The answer returned no citation records. Treat it as unverified.
          </div>
        ) : (
          <ol className="space-y-px bg-line">
            {result.citations.map((citation) => (
              <li
                id={citationId(citation.marker)}
                key={`${citation.marker}-${citation.sourceRef ?? citation.content}`}
                className="scroll-mt-24 bg-ink px-4 py-5"
              >
                <div className="flex flex-wrap items-center gap-3">
                  <span className="font-mono text-xs font-bold text-mint">{citation.marker}</span>
                  <span className="border border-line px-2 py-1 text-[9px] font-bold uppercase tracking-[0.14em] text-muted">
                    {citation.kind.replaceAll("_", " ")}
                  </span>
                  <span className="ml-auto font-mono text-[10px] text-muted">
                    {formatScore(citation.score)}
                  </span>
                </div>
                <p className="mt-3 text-sm leading-6 text-paper/[0.76]">{citation.content}</p>
                <div className="mt-3 space-y-1 font-mono text-[10px] text-muted">
                  <p className="break-all">memory / {citation.memoryId}</p>
                  <p>
                    scope / {citation.company}
                    {citation.period ? ` · ${citation.period}` : ""}
                  </p>
                  {citation.sourceRef && (
                    <p className="break-all">source / {citation.sourceRef}</p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
