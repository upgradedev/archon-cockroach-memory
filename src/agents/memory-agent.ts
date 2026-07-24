// MemoryAgent — the minimal agentic loop over CockroachDB memory.
//
// This is the read/write-memory path the rest of the Archon pipeline plugs into:
//
//   ingestEvent()   WRITE  — an agent has fused a financial event; it commits the
//                            salient facts to memory (event, per-employee lines,
//                            key insights) so future runs can recall them.
//   recallAnswer()  READ   — a user (or another agent) asks a question; the agent
//                            recalls the most relevant memories by meaning and
//                            grounds its answer in them (RAG over agent memory).
//
// It is deliberately thin and injectable (Embedder passed in) so it runs offline
// with the FakeEmbedder and against real Bedrock Titan in production unchanged.

import type { Embedder } from "../memory/embeddings.js";
import {
  remember,
  recall,
  listForAudit,
  auditMemoryCount,
  type MemoryKind,
  type RecallHit,
} from "../memory/memory.js";
import {
  auditConsistency,
  type AuditMemory,
  type ConsistencyReport,
} from "../memory/consistency.js";
import {
  defaultNarrator,
  type Narrator,
  type Citation,
  type GroundingTrace,
} from "./narrator.js";
import type { PayrollEvent } from "../extraction/types.js";

export class MemoryAgent {
  private narrator: Narrator;
  // The narrator is injectable (real Bedrock Claude / offline FakeNarrator) and
  // defaults to environment auto-detection, exactly like the embedder. Passing
  // it in keeps the whole agent testable offline.
  constructor(private embedder: Embedder, narrator: Narrator = defaultNarrator()) {
    this.narrator = narrator;
  }

  get embeddingModelId(): string {
    return this.embedder.modelId;
  }

  get embeddingDimension(): number {
    return this.embedder.dim;
  }

  get narrationModelId(): string {
    return this.narrator.modelId;
  }

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
        idempotencyKey: `archon-event/v1/${event.event_id}/summary`,
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

    // 2. An insight — the off-bank workforce-cost gap (one of several the agents remember).
    //    This is the highest-salience memory the agent keeps, so it carries an
    //    explicit `importance` in metadata. The self-audit's resolver reads that
    //    salience: if a later, casual write ever contradicts this figure, importance
    //    (not recency) decides which value to recommend trusting.
    ids.push(
      await remember(this.embedder, {
        ...base,
        kind: "insight",
        sourceRef: event.event_id,
        idempotencyKey: `archon-event/v1/${event.event_id}/off-bank-cost`,
        content:
          `Off-bank employment cost at ${event.company} for ${event.period}: the bank ` +
          `salary transfer of ${money(event.bank_net_total)} understates the true ` +
          `cost of employing the team by ${money(event.off_bank_cost)} — mostly employer ` +
          `social-security contributions of ${money(event.employer_social_security_total)}, ` +
          `~${event.cost_gap_pct.toFixed(1)}% of the bank transfer on its own.`,
        metadata: {
          off_bank_cost: event.off_bank_cost,
          cost_gap_pct: event.cost_gap_pct,
          employer_social_security_total: event.employer_social_security_total,
          importance: 0.9,
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
          idempotencyKey:
            `archon-event/v1/${event.event_id}/employee/${emp.employee_id}`,
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
    opts: {
      company?: string;
      period?: string;
      sourceRef?: string;
      metadata?: Record<string, unknown>;
      idempotencyKey?: string;
    } = {}
  ): Promise<string> {
    return remember(this.embedder, { kind, content, ...opts });
  }

  // ── READ (RAG over agent memory) ───────────────────────────────────────────
  // Recall the memories most relevant to a question via the distributed vector
  // index, then have the narrator write a grounded, CITING answer from them.
  // With real AWS creds this calls Claude Sonnet on Bedrock (real RAG); offline
  // it uses the deterministic FakeNarrator — same recall path either way, so the
  // full memory→narrate loop is verifiable in CI without AWS.
  async recallAnswer(
    question: string,
    opts: {
      company?: string;
      kind?: MemoryKind;
      limit?: number;
      minScore?: number;
    } = {}
  ): Promise<{
    answer: string;
    hits: RecallHit[];
    citations: Citation[];
    modelId: string;
    grounding: GroundingTrace;
    consistency: ConsistencyReport;
  }> {
    const requestedLimit = Math.max(1, Math.min(opts.limit ?? 5, 20));
    const candidates = await recall(this.embedder, question, {
      company: opts.company,
      kind: opts.kind,
      limit: opts.minScore === undefined
        ? requestedLimit
        : Math.min(requestedLimit * 3, 50),
    });
    const hits = candidates
      .filter((hit) => opts.minScore === undefined || hit.score >= opts.minScore)
      .slice(0, requestedLimit);
    const { answer, citations, modelId, grounding } =
      await this.narrator.narrate(question, hits);
    // Best-effort self-audit over the memories JUST recalled — no extra DB round
    // trip, so the live /recall hot path is unchanged. It surfaces a conflict when
    // both sides of a contradiction happen to land in the top-k. The exhaustive,
    // guaranteed audit is `audit()` below, which scans the full scope.
    const consistency = auditConsistency(hits.map(hitToAuditMemory));
    return { answer, hits, citations, modelId, grounding, consistency };
  }

  // ── SELF-AUDIT (memory-consistency) ─────────────────────────────────────────
  // Audit a bounded slice of the agent's OWN memory for cross-session contradictions
  // (two write events stored different values for one record) and dangling
  // references (a memory points at a record the agent never stored). Read-only:
  // it scans stored memories in scope via `listForAudit` (a plain SELECT) and
  // returns findings plus a resolution RECOMMENDATION for each contradiction. It
  // never mutates or deletes memory. HTTP/MCP callers pair the slice with the
  // identically filtered count and withhold all-clear unless coverage is complete.
  async audit(
    scope: {
      company?: string;
      period?: string;
      kind?: MemoryKind;
      limit?: number;
    } = {}
  ): Promise<ConsistencyReport> {
    return (await this.auditSnapshot(scope)).report;
  }

  async auditSnapshot(
    scope: {
      company?: string;
      period?: string;
      kind?: MemoryKind;
      limit?: number;
    } = {}
  ): Promise<{
    report: ConsistencyReport;
    memories: AuditMemory[];
    coverage: {
      total: number;
      scanned: number;
      limit: number;
      complete: boolean;
    };
  }> {
    const [memories, total] = await Promise.all([
      listForAudit(scope, this.embedder.modelId),
      auditMemoryCount(scope, this.embedder.modelId),
    ]);
    const limit = Math.max(1, Math.min(scope.limit ?? 500, 500));
    const coverage = {
      total,
      scanned: memories.length,
      limit,
      complete: memories.length === total,
    };
    const rawReport = auditConsistency(memories);
    return {
      report: {
        ...rawReport,
        ok: rawReport.ok && coverage.complete,
      },
      memories,
      coverage,
    };
  }
}

// A RecallHit already carries every field the audit needs (it is a MemoryRecord
// plus scores), so the audit view over recalled hits is just a projection.
function hitToAuditMemory(h: RecallHit): AuditMemory {
  return {
    id: h.id,
    kind: h.kind,
    company: h.company,
    period: h.period,
    sourceRef: h.sourceRef,
    content: h.content,
    metadata: h.metadata,
    createdAt: h.createdAt,
  };
}

function money(n: number | null | undefined): string {
  if (n == null) return "n/a";
  return `€${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}
