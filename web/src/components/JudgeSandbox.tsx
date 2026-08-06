import { type FormEvent, useState } from "react";
import {
  auditSandboxFacts,
  ingestSandboxFact,
  PublicApiError,
  recallSandboxFact,
  type SandboxContradiction,
  type SandboxIngestResult,
  type SandboxRecallResult,
} from "../lib/api";

type PendingAction = "ingest" | "recall" | "audit" | null;

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : "The sandbox request failed.";
}

export function JudgeSandbox() {
  const [sandboxToken, setSandboxToken] = useState<string | null>(null);
  const [company, setCompany] = useState("Judge Corp");
  const [subject, setSubject] = useState("INV-9901");
  const [attribute, setAttribute] = useState("total");
  const [numericValue, setNumericValue] = useState("45000");
  const [sourceRef, setSourceRef] = useState("DOC-9901-A");
  const [fact, setFact] = useState(
    "Invoice INV-9901 is recorded at EUR 45000.",
  );
  const [question, setQuestion] = useState(
    "What values are recorded for invoice INV-9901?",
  );
  const [receipt, setReceipt] = useState<SandboxIngestResult | null>(null);
  const [recall, setRecall] = useState<SandboxRecallResult | null>(null);
  const [contradictions, setContradictions] = useState<SandboxContradiction[]>([]);
  const [auditComplete, setAuditComplete] = useState(false);
  const [pending, setPending] = useState<PendingAction>(null);
  const [error, setError] = useState<string | null>(null);

  function handleRequestError(requestError: unknown) {
    setError(messageFrom(requestError));
    if (requestError instanceof PublicApiError && requestError.status === 410) {
      setSandboxToken(null);
      setReceipt(null);
      setRecall(null);
      setContradictions([]);
      setAuditComplete(false);
    }
  }

  async function storeFact(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const amount = Number(numericValue);
    if (!numericValue.trim() || !Number.isFinite(amount)) {
      setError("Amount must be a finite number.");
      return;
    }
    setPending("ingest");
    setError(null);
    try {
      const result = await ingestSandboxFact({
        ...(sandboxToken ? { sandboxToken } : {}),
        company,
        fact,
        sourceRef,
        subject,
        attribute,
        numericValue: amount,
      });
      setSandboxToken(result.sandboxToken);
      setReceipt(result);
      setRecall(null);
      setContradictions([]);
      setAuditComplete(false);
    } catch (requestError) {
      handleRequestError(requestError);
    } finally {
      setPending(null);
    }
  }

  async function recallFacts() {
    if (!sandboxToken) return;
    setPending("recall");
    setError(null);
    setRecall(null);
    try {
      setRecall(await recallSandboxFact(sandboxToken, question));
    } catch (requestError) {
      handleRequestError(requestError);
    } finally {
      setPending(null);
    }
  }

  async function auditFacts() {
    if (!sandboxToken) return;
    setPending("audit");
    setError(null);
    setAuditComplete(false);
    setContradictions([]);
    try {
      setContradictions(await auditSandboxFacts(sandboxToken));
      setAuditComplete(true);
    } catch (requestError) {
      handleRequestError(requestError);
    } finally {
      setPending(null);
    }
  }

  function loadConflictingFact() {
    setNumericValue("47000");
    setSourceRef("DOC-9901-B");
    setFact("A signed correction records invoice INV-9901 at EUR 47000.");
  }

  const expiresLabel = receipt
    ? new Date(receipt.expiresAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

  return (
    <section
      className="border-y border-line bg-carbon/60"
      aria-labelledby="judge-sandbox-title"
    >
      <div className="mx-auto grid max-w-[1480px] gap-10 px-5 py-16 sm:px-8 lg:grid-cols-12 lg:px-12">
        <div className="lg:col-span-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-ember">
            Bring your own evidence
          </p>
          <h2
            id="judge-sandbox-title"
            className="mt-3 font-editorial text-4xl tracking-editorial text-paper"
          >
            Test memory.
            <span className="block italic text-muted">Leave no permanent trace.</span>
          </h2>
          <p className="mt-5 max-w-md text-sm leading-6 text-paper/70">
            Add up to 20 structured facts in one of at most 200 active public
            sessions, recall them with citations, then ask CockroachDB to
            surface a contradiction. The opaque capability stays
            in this tab; reads reject expired rows and storage enforces a maximum
            one-hour TTL. Canonical Helios memory is never modified.
          </p>
          {receipt ? (
            <div className="mt-6 border border-mint/30 bg-mint/5 p-4 text-xs text-paper/75">
              <p className="font-semibold text-mint">Session active</p>
              <p className="mt-1 font-mono">
                {receipt.reused ? "Existing fact reused" : "Fact stored"} · expires {expiresLabel}
              </p>
              <button
                className="mt-4 border border-line px-3 py-2 font-semibold uppercase tracking-[0.12em] text-paper transition hover:border-ember focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ember"
                type="button"
                onClick={loadConflictingFact}
              >
                Load conflicting fact
              </button>
            </div>
          ) : null}
        </div>

        <div className="space-y-8 lg:col-span-8">
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={storeFact}>
            <label className="text-xs font-semibold text-paper/75" htmlFor="sandbox-company">
              Company
              <input
                id="sandbox-company"
                className="mt-2 w-full border border-line bg-ink px-3 py-2.5 text-sm text-paper outline-none focus:border-mint"
                maxLength={120}
                required
                value={company}
                onChange={(event) => setCompany(event.target.value)}
              />
            </label>
            <label className="text-xs font-semibold text-paper/75" htmlFor="sandbox-source">
              Source reference
              <input
                id="sandbox-source"
                className="mt-2 w-full border border-line bg-ink px-3 py-2.5 text-sm text-paper outline-none focus:border-mint"
                maxLength={160}
                required
                value={sourceRef}
                onChange={(event) => setSourceRef(event.target.value)}
              />
            </label>
            <label className="text-xs font-semibold text-paper/75" htmlFor="sandbox-subject">
              Subject
              <input
                id="sandbox-subject"
                className="mt-2 w-full border border-line bg-ink px-3 py-2.5 text-sm text-paper outline-none focus:border-mint"
                maxLength={160}
                required
                value={subject}
                onChange={(event) => setSubject(event.target.value)}
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs font-semibold text-paper/75" htmlFor="sandbox-attribute">
                Attribute
                <input
                  id="sandbox-attribute"
                  className="mt-2 w-full border border-line bg-ink px-3 py-2.5 text-sm text-paper outline-none focus:border-mint"
                  maxLength={80}
                  required
                  value={attribute}
                  onChange={(event) => setAttribute(event.target.value)}
                />
              </label>
              <label className="text-xs font-semibold text-paper/75" htmlFor="sandbox-value">
                Numeric value
                <input
                  id="sandbox-value"
                  className="mt-2 w-full border border-line bg-ink px-3 py-2.5 text-sm text-paper outline-none focus:border-mint"
                  inputMode="decimal"
                  required
                  value={numericValue}
                  onChange={(event) => setNumericValue(event.target.value)}
                />
              </label>
            </div>
            <label className="text-xs font-semibold text-paper/75 sm:col-span-2" htmlFor="sandbox-fact">
              Fact text
              <textarea
                id="sandbox-fact"
                className="mt-2 min-h-24 w-full resize-y border border-line bg-ink px-3 py-2.5 text-sm text-paper outline-none focus:border-mint"
                maxLength={1000}
                minLength={5}
                required
                value={fact}
                onChange={(event) => setFact(event.target.value)}
              />
            </label>
            <div className="sm:col-span-2">
              <button
                className="bg-ember px-5 py-3 text-xs font-bold uppercase tracking-[0.16em] text-ink disabled:cursor-not-allowed disabled:opacity-50"
                disabled={pending !== null}
                type="submit"
              >
                {pending === "ingest" ? "Storing…" : sandboxToken ? "Store another fact" : "Start sandbox"}
              </button>
            </div>
          </form>

          {sandboxToken ? (
            <div className="border-t border-line pt-7">
              <label className="text-xs font-semibold text-paper/75" htmlFor="sandbox-question">
                Ask only about this sandbox
                <input
                  id="sandbox-question"
                  className="mt-2 w-full border border-line bg-ink px-3 py-3 text-sm text-paper outline-none focus:border-mint"
                  maxLength={1000}
                  required
                  value={question}
                  onChange={(event) => setQuestion(event.target.value)}
                />
              </label>
              <div className="mt-4 flex flex-wrap gap-3">
                <button
                  className="border border-mint/50 px-4 py-2.5 text-xs font-bold uppercase tracking-[0.14em] text-mint disabled:opacity-50"
                  disabled={pending !== null || !question.trim()}
                  type="button"
                  onClick={recallFacts}
                >
                  {pending === "recall" ? "Recalling…" : "Recall with citations"}
                </button>
                <button
                  className="border border-ember/50 px-4 py-2.5 text-xs font-bold uppercase tracking-[0.14em] text-ember disabled:opacity-50"
                  disabled={pending !== null}
                  type="button"
                  onClick={auditFacts}
                >
                  {pending === "audit" ? "Auditing…" : "Detect contradictions"}
                </button>
              </div>
            </div>
          ) : null}

          <div aria-live="polite" aria-atomic="true">
            {error ? (
              <p className="border border-ember/40 bg-ember/5 p-4 text-sm text-ember" role="alert">
                {error}
              </p>
            ) : null}
            {recall ? (
              <article className="border border-line bg-ink/60 p-5">
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-mint">
                  {recall.grounding.status === "verified"
                    ? "Verified grounded answer"
                    : recall.grounding.status === "extractive"
                      ? "Exact evidence answer"
                      : recall.grounding.status === "fallback"
                        ? "Grounding fallback"
                        : "No safe evidence"} · {recall.recalled} recalled
                </p>
                <p className="mt-3 text-sm leading-6 text-paper">{recall.answer}</p>
                {recall.grounding.reason ? (
                  <p className="mt-2 text-xs text-muted">{recall.grounding.reason}</p>
                ) : null}
                <ul className="mt-4 space-y-2 text-xs text-paper/65">
                  {recall.citations.map((citation) => (
                    <li key={citation.memoryId}>
                      {citation.marker} {citation.sourceRef ?? "Unlabelled source"}: {citation.content}
                    </li>
                  ))}
                </ul>
              </article>
            ) : null}
            {contradictions.length > 0 ? (
              <div className="mt-4 border border-ember/40 bg-ember/5 p-5">
                <p className="text-xs font-bold uppercase tracking-[0.15em] text-ember">
                  Contradiction detected
                </p>
                {contradictions.map((contradiction) => (
                  <p className="mt-2 text-sm text-paper" key={`${contradiction.subject}:${contradiction.attribute}`}>
                    {contradiction.subject}.{contradiction.attribute}: {contradiction.values.map((item) => `${item.value} (${item.sourceRef})`).join(" vs ")}
                  </p>
                ))}
              </div>
            ) : null}
            {auditComplete && contradictions.length === 0 && !error ? (
              <p className="mt-4 text-xs text-muted">
                No conflicting structured values were found in this sandbox.
              </p>
            ) : null}
            {pending === null && sandboxToken && !auditComplete && !recall && !error ? (
              <p className="mt-4 text-xs text-muted">
                Store a second value, then run recall or contradiction detection.
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
