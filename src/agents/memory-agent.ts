// MemoryAgent — the minimal agentic loop over CockroachDB memory.
//
// This is the read/write-memory path the rest of the Archon pipeline plugs into:
//
//   ingestEvent()   WRITE  — an agent has fused a financial event; it commits the
//                            salient facts to memory (event, per-employee lines,
//                            the headline insight) so future runs can recall them.
//   recallAnswer()  READ   — a user (or another agent) asks a question; the agent
//                            recalls the most relevant memories by meaning and
//                            grounds its answer in them (RAG over agent memory).
//
// It is deliberately thin and injectable (Embedder passed in) so it runs offline
// with the FakeEmbedder and against real Bedrock Titan in production unchanged.

import type { Embedder } from "../memory/embeddings.js";
import { remember, recall, type MemoryKind, type RecallHit } from "../memory/memory.js";
import type { PayrollEvent } from "../extraction/types.js";

export class MemoryAgent {
  constructor(private embedder: Embedder) {}

  // ── WRITE ────────────────────────────────────────────────────────────────
  // Commit a fused PayrollEvent to memory as several recallable facts. Returns
  // the ids of the memories written.
  async ingestEvent(event: PayrollEvent): Promise<string[]> {
    const ids: string[] = [];
    const base = { company: event.company, period: event.period } as const;

    // 1. The event summary.
    ids.push(
      await remember(this.embedder, {
        ...base,
        kind: "payroll_event",
        sourceRef: event.event_id,
        content:
          `Payroll for ${event.company} in ${event.period}: ` +
          `${event.employee_count} employees, gross ${money(event.gross_total)}, ` +
          `true employer cost ${money(event.employer_cost_total)}, ` +
          `net paid from bank ${money(event.bank_net_total)}.`,
        metadata: {
          employee_count: event.employee_count,
          gross_total: event.gross_total,
          employer_cost_total: event.employer_cost_total,
          bank_net_total: event.bank_net_total,
        },
      })
    );

    // 2. The headline insight — the hidden employer-cost gap.
    ids.push(
      await remember(this.embedder, {
        ...base,
        kind: "insight",
        sourceRef: event.event_id,
        content:
          `Hidden payroll cost at ${event.company} for ${event.period}: the bank ` +
          `salary transfer of ${money(event.bank_net_total)} understates the true ` +
          `employer cost by ${money(event.hidden_total)} ` +
          `(${event.cost_gap_pct.toFixed(1)}%), mostly employer social-security ` +
          `(IKA) of ${money(event.employer_ika_total)}.`,
        metadata: {
          hidden_total: event.hidden_total,
          cost_gap_pct: event.cost_gap_pct,
          employer_ika_total: event.employer_ika_total,
        },
      })
    );

    // 3. Per-employee lines (bounded — memory of who was paid what).
    for (const emp of event.employees) {
      ids.push(
        await remember(this.embedder, {
          ...base,
          kind: "payroll_event",
          sourceRef: `${event.event_id}:${emp.employee_id}`,
          content:
            `${emp.name} (id ${emp.employee_id}) at ${event.company} in ` +
            `${event.period}: gross ${money(emp.gross)}, net ${money(emp.net)}, ` +
            `employer cost ${money(emp.employer_cost)}.`,
          metadata: { employee_id: emp.employee_id, net: emp.net, gross: emp.gross },
        })
      );
    }
    return ids;
  }

  // Commit an arbitrary fact (used by the extractor / validator agents).
  async remember(
    kind: MemoryKind,
    content: string,
    opts: { company?: string; period?: string; sourceRef?: string; metadata?: Record<string, unknown> } = {}
  ): Promise<string> {
    return remember(this.embedder, { kind, content, ...opts });
  }

  // ── READ ─────────────────────────────────────────────────────────────────
  // Recall the memories most relevant to a question, then compose a grounded,
  // citation-style answer. Narration is intentionally deterministic here (no LLM
  // call) so the recall path is verifiable offline; a Bedrock narrator can be
  // layered on top using the same hits (see README → roadmap).
  async recallAnswer(
    question: string,
    opts: { company?: string; kind?: MemoryKind; limit?: number } = {}
  ): Promise<{ answer: string; hits: RecallHit[] }> {
    const hits = await recall(this.embedder, question, {
      company: opts.company,
      kind: opts.kind,
      limit: opts.limit ?? 5,
    });
    if (hits.length === 0) {
      return { answer: "No relevant memories found.", hits };
    }
    const cited = hits
      .map((h, i) => `  [${i + 1}] (${h.kind}, sim ${h.score.toFixed(3)}) ${h.content}`)
      .join("\n");
    const answer =
      `Recalled ${hits.length} memory item(s) relevant to "${question}":\n${cited}`;
    return { answer, hits };
  }
}

function money(n: number | null | undefined): string {
  if (n == null) return "n/a";
  return `€${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}
