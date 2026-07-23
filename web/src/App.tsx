import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AnswerBrief } from "./components/AnswerBrief";
import { AuditLedger } from "./components/AuditLedger";
import { Hero } from "./components/Hero";
import { Masthead } from "./components/Masthead";
import { ProofLedger } from "./components/ProofLedger";
import { QuestionComposer } from "./components/QuestionComposer";
import { getAudit, getHealth, getProof, recallMemory } from "./lib/api";

export function App() {
  const queryClient = useQueryClient();
  const [activeQuestion, setActiveQuestion] = useState<string | null>(null);

  const healthQuery = useQuery({
    queryKey: ["health"],
    queryFn: ({ signal }) => getHealth(signal),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
  const auditQuery = useQuery({
    queryKey: ["audit"],
    queryFn: ({ signal }) => getAudit(signal),
    staleTime: 30_000,
  });
  const proofQuery = useQuery({
    queryKey: ["proof"],
    queryFn: ({ signal }) => getProof(signal),
    staleTime: 30_000,
  });
  const recallMutation = useMutation({
    mutationFn: (question: string) => recallMemory(question),
  });

  function ask(question: string) {
    setActiveQuestion(question);
    recallMutation.reset();
    recallMutation.mutate(question);
  }

  function refreshAll() {
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: ["health"] }),
      queryClient.invalidateQueries({ queryKey: ["audit"] }),
      queryClient.invalidateQueries({ queryKey: ["proof"] }),
    ]);
  }

  function refreshAudit() {
    void queryClient.invalidateQueries({ queryKey: ["audit"] });
  }

  const refreshingAll = healthQuery.isFetching || auditQuery.isFetching || proofQuery.isFetching;

  return (
    <div id="top" className="ambient-grid min-h-screen overflow-hidden bg-ink text-paper">
      <a
        className="fixed left-4 top-3 z-50 -translate-y-24 bg-paper px-4 py-3 text-xs font-bold uppercase tracking-[0.16em] text-ink transition focus:translate-y-0"
        href="#main-content"
      >
        Skip to content
      </a>

      <Masthead
        health={healthQuery.data}
        isLoading={healthQuery.isLoading}
        hasError={Boolean(healthQuery.error)}
        isRefreshing={refreshingAll}
        onRefresh={refreshAll}
      />

      <main id="main-content">
        <Hero />

        <section className="mx-auto grid max-w-[1480px] gap-12 px-5 py-16 sm:px-8 sm:py-20 lg:grid-cols-12 lg:px-12">
          <div className="space-y-12 lg:col-span-8">
            <QuestionComposer isPending={recallMutation.isPending} onAsk={ask} />
            <AnswerBrief
              result={recallMutation.data}
              activeQuestion={activeQuestion}
              isPending={recallMutation.isPending}
              error={recallMutation.error}
            />
          </div>
          <div className="lg:col-span-4">
            <div className="lg:sticky lg:top-8">
              <ProofLedger
                proof={proofQuery.data}
                auditMemoryCount={auditQuery.data?.memoryCount ?? auditQuery.data?.audited ?? null}
                isLoading={proofQuery.isLoading}
                isFetching={proofQuery.isFetching}
                error={proofQuery.error}
              />
            </div>
          </div>
        </section>

        <AuditLedger
          report={auditQuery.data}
          isLoading={auditQuery.isLoading}
          isFetching={auditQuery.isFetching}
          error={auditQuery.error}
          onRefresh={refreshAudit}
        />

        <section className="border-y border-line bg-carbon/[0.45]" aria-labelledby="path-title">
          <div className="mx-auto max-w-[1480px] px-5 py-14 sm:px-8 lg:px-12">
            <div className="grid gap-8 lg:grid-cols-12">
              <div className="lg:col-span-3">
                <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-ember">
                  03 / Request boundary
                </p>
                <h2 id="path-title" className="mt-3 font-editorial text-4xl tracking-editorial text-paper">
                  One question.
                  <span className="block italic text-muted">Four accountable layers.</span>
                </h2>
              </div>
              <ol className="grid gap-px border border-line bg-line sm:grid-cols-2 lg:col-span-9 lg:grid-cols-4">
                {[
                  ["01", "Control room", "A read-only question from the fixed public demo."],
                  ["02", "AWS boundary", "Same-origin API routes bound and shape the request."],
                  ["03", "CockroachDB", "Relational evidence and C-SPANN vector recall."],
                  ["04", "Bedrock", "Titan retrieval context; Claude narration when live."],
                ].map(([number, title, detail]) => (
                  <li className="relative min-h-40 bg-ink p-5" key={number}>
                    <span className="font-mono text-[10px] text-ember">{number}</span>
                    <h3 className="mt-8 text-xs font-bold uppercase tracking-[0.16em] text-paper">{title}</h3>
                    <p className="mt-3 text-xs leading-5 text-muted">{detail}</p>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </section>
      </main>

      <footer className="mx-auto flex max-w-[1480px] flex-col gap-5 px-5 py-10 text-[10px] uppercase tracking-[0.16em] text-muted sm:flex-row sm:items-center sm:justify-between sm:px-8 lg:px-12">
        <p>Archon Memory Control Room · Synthetic financial evidence only</p>
        <div className="flex items-center gap-5">
          <span>Public read-only demo</span>
          <a
            className="text-paper underline decoration-paper/30 underline-offset-4 hover:text-mint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mint"
            href="#top"
          >
            Back to top ↑
          </a>
        </div>
      </footer>
    </div>
  );
}
