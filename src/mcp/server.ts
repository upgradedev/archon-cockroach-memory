// Model Context Protocol (MCP) server over the CockroachDB-backed agent memory.
//
// This exposes Archon's CockroachDB memory layer as an *agentic tool surface*: any
// MCP-speaking agent (Claude Code, Cursor, VS Code, a custom orchestrator) can call
// these tools to recall memories by meaning from the distributed vector index, audit
// the memory for cross-session contradictions, and (with consent) store new facts —
// all backed by the same CockroachDB `agent_memory` table and native vector index the
// rest of the app uses.
//
// HONEST SCOPE (see README / docs/TOOLS.md): this is the additional self-hosted MCP
// surface over our application memory. The separately configured CockroachDB Cloud
// Managed MCP Server is the counted challenge feature and is verified read-only by
// scripts/cloud-mcp-audit.ts plus protected deployment workflows.
//
// Design mirrors the CockroachDB Cloud Managed MCP surface's safety posture: the read
// tools (recall, audit) are the default; the write tool (remember) is explicitly
// separated and annotated as a mutating operation.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  defaultEmbedder,
  type Embedder,
} from "../memory/embeddings.js";
import {
  auditMemoryCount,
  recall,
  listForAudit,
  type MemoryKind,
} from "../memory/memory.js";
import { remember as rememberMemory } from "../memory/memory.js";
import { auditConsistency } from "../memory/consistency.js";

export const MEMORY_KINDS = [
  "document",
  "payroll_event",
  "validation",
  "insight",
] as const;

const kindSchema = z.enum(MEMORY_KINDS);

/**
 * Build the Archon Memory MCP server. The embedder is injectable so the server
 * runs offline in tests/CI with the deterministic `FakeEmbedder` and against real
 * Bedrock Titan in production — same tools, same CockroachDB store, unchanged.
 */
export function createMemoryMcpServer(embedder: Embedder = defaultEmbedder()): McpServer {
  const server = new McpServer(
    {
      name: "archon-cockroach-memory",
      version: "0.1.0",
    },
    {
      instructions:
        "Agentic memory over CockroachDB's distributed vector index. Use recall_memory " +
        "to retrieve prior facts by meaning, audit_memory to check the stored memory for " +
        "cross-session contradictions and dangling references, and remember_memory to " +
        "store a new fact (a write — use deliberately).",
    }
  );

  // ── READ: semantic recall over the distributed vector index ──────────────────
  server.registerTool(
    "recall_memory",
    {
      title: "Recall memories by meaning",
      description:
        "Approximate-nearest-neighbour recall over the CockroachDB native distributed " +
        "vector index (C-SPANN). Returns the top-k stored memories most semantically " +
        "similar to `question`, optionally scoped by company/kind. Read-only.",
      inputSchema: {
        question: z.string().min(1).describe("Natural-language question to recall against"),
        company: z.string().optional().describe("Scope recall to one company"),
        kind: kindSchema.optional().describe("Scope recall to one memory kind"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Top-k to return (default 5)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ question, company, kind, limit }) => {
      const hits = await recall(embedder, question, {
        company,
        kind: kind as MemoryKind | undefined,
        limit: limit ?? 5,
      });
      const summary = hits.length
        ? hits
            .map(
              (h, i) =>
                `[${i + 1}] (${h.kind}, ${h.company}, score ${h.score.toFixed(3)}) ${h.content}`
            )
            .join("\n")
        : "No memories recalled for that question.";
      return {
        content: [{ type: "text", text: summary }],
        structuredContent: {
          count: hits.length,
          hits: hits.map((h) => ({
            id: h.id,
            kind: h.kind,
            company: h.company,
            period: h.period,
            content: h.content,
            score: h.score,
            distance: h.distance,
          })),
        },
      };
    }
  );

  // ── READ: self-audit for contradictions / dangling references ────────────────
  server.registerTool(
    "audit_memory",
    {
      title: "Audit memory for contradictions",
      description:
        "Scan a bounded stored-memory slice (a plain SELECT, not vector top-k) for " +
        "cross-session contradictions (two writes gave " +
        "one record different values) and dangling references, and recommend which value " +
        "to trust. Returns exact coverage and withholds all-clear when truncated. " +
        "Strictly read-only: never mutates memory.",
      inputSchema: {
        company: z.string().optional().describe("Scope the audit to one company"),
        period: z.string().optional().describe("Scope the audit to one period"),
        kind: kindSchema.optional().describe("Scope the audit to one memory kind"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .default(500)
          .describe("Maximum memories to scan; coverage reports truncation"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ company, period, kind, limit }) => {
      const scope = {
        company,
        period,
        kind: kind as MemoryKind | undefined,
        limit,
      };
      const [memories, total] = await Promise.all([
        listForAudit(scope, embedder.modelId),
        auditMemoryCount(scope, embedder.modelId),
      ]);
      const report = auditConsistency(memories);
      const coverage = {
        total,
        scanned: memories.length,
        limit,
        complete: memories.length >= total,
      };
      const structured = {
        ...report,
        ok: report.ok && coverage.complete,
        coverage,
        generatedAt: new Date().toISOString(),
      };
      const lines: string[] = [
        `Audited ${coverage.scanned} of ${coverage.total} memories across ${report.subjects} records: ` +
          (!coverage.complete
            ? "scan truncated; all-clear withheld."
            : report.ok
              ? "no findings in the complete scope."
              : "findings detected."),
      ];
      for (const c of report.contradictions) {
        lines.push(
          `• contradiction on ${c.subject}.${c.attribute}: ` +
            c.values.map((v) => String(v.value)).join(" vs ") +
            ` → recommend ${String(c.resolution.recommendedValue)} (${c.resolution.rule})`
        );
      }
      for (const a of report.absences) {
        lines.push(`• dangling reference: ${a.subject} is referenced but never stored`);
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        structuredContent: structured as unknown as Record<string, unknown>,
      };
    }
  );

  // ── WRITE: store a new fact (explicitly a mutation) ──────────────────────────
  server.registerTool(
    "remember_memory",
    {
      title: "Store a new memory",
      description:
        "Embed a natural-language fact and durably store it in CockroachDB. This is a " +
        "WRITE — it adds a row to agent_memory. Returns the new memory id.",
      inputSchema: {
        kind: kindSchema.describe("The kind of memory being stored"),
        content: z.string().min(1).describe("The recallable natural-language fact"),
        company: z.string().optional(),
        period: z.string().optional(),
        sourceRef: z.string().optional().describe("Originating record id"),
        idempotencyKey: z
          .string()
          .max(256)
          .optional()
          .describe("Stable upstream event/request key for retry-safe writes"),
        metadata: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Structured metadata (e.g. importance, refs)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({
      kind,
      content,
      company,
      period,
      sourceRef,
      idempotencyKey,
      metadata,
    }) => {
      const id = await rememberMemory(embedder, {
        kind: kind as MemoryKind,
        content,
        company,
        period,
        sourceRef,
        idempotencyKey,
        metadata,
      });
      return {
        content: [{ type: "text", text: `Stored memory ${id}.` }],
        structuredContent: { id },
      };
    }
  );

  return server;
}
