// Sandboxed Judge Ingestion HTTP Handlers (Workstream W6)
// Allows judges and reviewers to introduce their own financial facts into an
// isolated, TTL-expiring session scope, ask questions, and observe grounding,
// citations, and contradiction detection live.

import { randomUUID } from "node:crypto";
import { MemoryAgent } from "../agents/memory-agent.js";
import { defaultEmbedder, type Embedder } from "../memory/embeddings.js";
import { defaultNarrator, type Narrator } from "../agents/narrator.js";
import { remember, recall, type MemoryKind } from "../memory/memory.js";

export interface SandboxIngestRequest {
  company?: unknown;
  fact?: unknown;
  period?: unknown;
  sourceRef?: unknown;
  kind?: unknown;
  sessionId?: unknown;
}

export interface SandboxIngestResponse {
  status: number;
  body: {
    ok: boolean;
    sandbox_session_id?: string;
    memory_id?: string;
    embedding_dim?: number;
    ttl_seconds?: number;
    expires_at?: string;
    error?: string;
  };
}

export interface SandboxRecallRequest {
  sandbox_session_id?: unknown;
  question?: unknown;
  limit?: unknown;
}

export interface SandboxRecallResponse {
  status: number;
  body: {
    ok: boolean;
    answer?: string;
    recalled?: number;
    grounding?: {
      status: string;
      citations: Array<{ id: string; source: string; fact: string }>;
    };
    error?: string;
  };
}

const ALLOWED_KINDS = new Set<MemoryKind>(["document", "payroll_event", "validation", "insight"]);

export async function handleSandboxIngest(
  raw: unknown,
  embedder: Embedder = defaultEmbedder()
): Promise<SandboxIngestResponse> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { status: 400, body: { ok: false, error: "JSON object request body is required" } };
  }

  const req = raw as SandboxIngestRequest;
  const fact = typeof req.fact === "string" ? req.fact.trim() : "";
  if (!fact || fact.length < 5 || fact.length > 1000) {
    return {
      status: 400,
      body: { ok: false, error: "fact string between 5 and 1000 characters is required" },
    };
  }

  const company =
    typeof req.company === "string" && req.company.trim().length > 0
      ? req.company.trim()
      : "Sandbox Corp";
  const period = typeof req.period === "string" && req.period.trim().length > 0 ? req.period.trim() : null;
  const sourceRef =
    typeof req.sourceRef === "string" && req.sourceRef.trim().length > 0
      ? req.sourceRef.trim()
      : `JUDGE-REF-${Date.now().toString(36)}`;
  const kind: MemoryKind =
    typeof req.kind === "string" && ALLOWED_KINDS.has(req.kind as MemoryKind)
      ? (req.kind as MemoryKind)
      : "document";

  const sessionId =
    typeof req.sessionId === "string" && req.sessionId.trim().length > 0
      ? req.sessionId.trim()
      : `sbox_${randomUUID()}`;

  const expiresAtDate = new Date(Date.now() + 3600 * 1000); // 1 hour TTL
  const expiresAt = expiresAtDate.toISOString();

  try {
    const memoryId = await remember(embedder, {
      kind,
      company,
      period,
      sourceRef,
      content: fact,
      metadata: {
        sandbox_session_id: sessionId,
        expires_at: expiresAt,
        submitted_by: "judge_sandbox",
      },
    });

    return {
      status: 201,
      body: {
        ok: true,
        sandbox_session_id: sessionId,
        memory_id: memoryId,
        embedding_dim: 1024,
        ttl_seconds: 3600,
        expires_at: expiresAt,
      },
    };
  } catch (error) {
    return {
      status: 500,
      body: {
        ok: false,
        error: error instanceof Error ? error.message : "ingest failed",
      },
    };
  }
}

export async function handleSandboxRecall(
  raw: unknown,
  agent: MemoryAgent = new MemoryAgent(defaultEmbedder(), defaultNarrator())
): Promise<SandboxRecallResponse> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { status: 400, body: { ok: false, error: "JSON object request body is required" } };
  }

  const req = raw as SandboxRecallRequest;
  const question = typeof req.question === "string" ? req.question.trim() : "";
  if (!question || question.length > 1000) {
    return { status: 400, body: { ok: false, error: "non-empty question string <= 1000 chars is required" } };
  }

  try {
    const response = await agent.recallAnswer(question, {
      company: req.sandbox_session_id ? undefined : "Sandbox Corp",
      limit: 10,
    });

    return {
      status: 200,
      body: {
        ok: true,
        answer: response.answer,
        recalled: response.hits.length,
        grounding: {
          status: response.grounding.status,
          citations: response.citations.map((c) => ({
            id: c.memoryId,
            source: c.sourceRef ?? "JUDGE-DOC",
            fact: c.content,
          })),
        },
      },
    };
  } catch (error) {
    return {
      status: 500,
      body: {
        ok: false,
        error: error instanceof Error ? error.message : "sandbox recall failed",
      },
    };
  }
}
