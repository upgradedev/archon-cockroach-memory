import { createHash, randomBytes } from "node:crypto";
import { defaultNarrator, type Narrator } from "../agents/narrator.js";
import { defaultEmbedder, type Embedder } from "../memory/embeddings.js";
import type { MemoryKind } from "../memory/memory.js";
import {
  auditSandbox,
  recallSandbox,
  rememberSandbox,
  SANDBOX_TTL_SECONDS,
  SandboxCapacityError,
  SandboxExpiredError,
  SandboxServiceCapacityError,
} from "../memory/sandbox-store.js";

const ALLOWED_KINDS = new Set<MemoryKind>([
  "document",
  "payroll_event",
  "validation",
  "insight",
]);

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/u.test(text)) {
    return null;
  }
  return text;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function validToken(value: unknown): string | null {
  const token = cleanText(value, 128);
  return token && /^[A-Za-z0-9_-]{43}$/u.test(token) ? token : null;
}

function publicFailure(error: unknown): { status: number; error: string } {
  if (error instanceof SandboxCapacityError) {
    return { status: 429, error: "sandbox session capacity reached" };
  }
  if (error instanceof SandboxExpiredError) {
    return { status: 410, error: "sandbox session expired" };
  }
  if (error instanceof SandboxServiceCapacityError) {
    return { status: 429, error: "sandbox service capacity reached" };
  }
  return { status: 503, error: "sandbox temporarily unavailable" };
}

export async function handleSandboxIngest(
  raw: unknown,
  embedder: Embedder = defaultEmbedder()
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      status: 400,
      body: { ok: false, error: "JSON object request body is required" },
    };
  }
  const request = raw as Record<string, unknown>;
  const fact = cleanText(request.fact, 1000);
  if (!fact || fact.length < 5) {
    return {
      status: 400,
      body: { ok: false, error: "fact must contain 5-1000 safe characters" },
    };
  }
  const suppliedToken = request.sandbox_token == null
    ? null
    : validToken(request.sandbox_token);
  if (request.sandbox_token != null && !suppliedToken) {
    return {
      status: 400,
      body: { ok: false, error: "invalid sandbox capability" },
    };
  }
  const sandboxToken = suppliedToken ?? randomBytes(32).toString("base64url");
  const company = request.company == null
    ? "Sandbox Corp"
    : cleanText(request.company, 120);
  const period = request.period == null ? null : cleanText(request.period, 40);
  const suppliedSourceRef = request.sourceRef == null
    ? null
    : cleanText(request.sourceRef, 160);
  if (
    !company ||
    (request.period != null && !period) ||
    (request.sourceRef != null && !suppliedSourceRef)
  ) {
    return {
      status: 400,
      body: { ok: false, error: "invalid sandbox text field" },
    };
  }
  const sourceRef =
    suppliedSourceRef ??
    `JUDGE-${createHash("sha256")
      .update(fact, "utf8")
      .digest("hex")
      .slice(0, 16)}`;
  let kind: MemoryKind = "document";
  if (request.kind != null) {
    if (
      typeof request.kind !== "string" ||
      !ALLOWED_KINDS.has(request.kind as MemoryKind)
    ) {
      return {
        status: 400,
        body: { ok: false, error: "invalid sandbox memory kind" },
      };
    }
    kind = request.kind as MemoryKind;
  }
  const subject =
    request.subject == null ? null : cleanText(request.subject, 160);
  const attribute =
    request.attribute == null ? null : cleanText(request.attribute, 80);
  if (
    (request.subject != null && !subject) ||
    (request.attribute != null && !attribute)
  ) {
    return {
      status: 400,
      body: { ok: false, error: "invalid structured fact field" },
    };
  }
  const numericValue = request.numericValue == null
    ? null
    : typeof request.numericValue === "number"
      ? request.numericValue
      : Number.NaN;
  const structuredCount = [subject, attribute, numericValue].filter(
    (value) => value != null
  ).length;
  if (
    structuredCount !== 0 &&
    (structuredCount !== 3 ||
      !Number.isFinite(numericValue) ||
      Math.abs(numericValue as number) > 1_000_000_000_000_000)
  ) {
    return {
      status: 400,
      body: {
        ok: false,
        error: "subject, attribute, and bounded finite numericValue must be supplied together",
      },
    };
  }
  try {
    const result = await rememberSandbox(embedder, {
      tokenHash: tokenHash(sandboxToken),
      kind,
      company,
      period,
      sourceRef,
      content: fact,
      subject,
      attribute,
      numericValue,
    });
    return {
      status: result.reused ? 200 : 201,
      body: {
        ok: true,
        sandbox_token: sandboxToken,
        memory_id: result.id,
        reused: result.reused,
        ttl_seconds: SANDBOX_TTL_SECONDS,
        expires_at: result.expiresAt,
      },
    };
  } catch (error) {
    const failure = publicFailure(error);
    return { status: failure.status, body: { ok: false, error: failure.error } };
  }
}

export async function handleSandboxRecall(
  raw: unknown,
  embedder: Embedder = defaultEmbedder(),
  narrator: Narrator = defaultNarrator()
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      status: 400,
      body: { ok: false, error: "JSON object request body is required" },
    };
  }
  const request = raw as Record<string, unknown>;
  const sandboxToken = validToken(request.sandbox_token);
  const question = cleanText(request.question, 1000);
  if (!sandboxToken || !question) {
    return {
      status: 400,
      body: { ok: false, error: "sandbox_token and question are required" },
    };
  }
  const requestedLimit = request.limit ?? 10;
  if (
    typeof requestedLimit !== "number" ||
    !Number.isInteger(requestedLimit) ||
    requestedLimit < 1 ||
    requestedLimit > 20
  ) {
    return {
      status: 400,
      body: {
        ok: false,
        error: "limit must be an integer from 1 through 20",
      },
    };
  }
  try {
    const hits = await recallSandbox(
      embedder,
      tokenHash(sandboxToken),
      question,
      requestedLimit
    );
    const answer = await narrator.narrate(question, hits);
    return {
      status: 200,
      body: {
        ok: true,
        question,
        answer: answer.answer,
        recalled: hits.length,
        modelId: answer.modelId,
        grounding: answer.grounding,
        citations: answer.citations,
      },
    };
  } catch (error) {
    const failure = publicFailure(error);
    return { status: failure.status, body: { ok: false, error: failure.error } };
  }
}

export async function handleSandboxAudit(
  raw: unknown
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      status: 400,
      body: { ok: false, error: "JSON object request body is required" },
    };
  }
  const sandboxToken = validToken((raw as Record<string, unknown>).sandbox_token);
  if (!sandboxToken) {
    return { status: 400, body: { ok: false, error: "sandbox_token is required" } };
  }
  try {
    const contradictions = await auditSandbox(tokenHash(sandboxToken));
    return { status: 200, body: { ok: true, contradictions } };
  } catch (error) {
    const failure = publicFailure(error);
    return { status: failure.status, body: { ok: false, error: failure.error } };
  }
}
