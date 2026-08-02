/**
 * CI-only runtime evidence for the supported intersection between the authored
 * lifecycle policy and the application that ships.
 *
 * This intentionally does not claim full B4 parity. Canonical agent_memory has
 * durable write/recall/audit behavior, while approve/reject/consolidation lives
 * in a fixed, disposable synthetic sandbox. The receipt names both boundaries.
 */

import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { MemoryAgent } from "../src/agents/memory-agent.js";
import { FakeNarrator } from "../src/agents/narrator.js";
import { closePool, query } from "../src/db/client.js";
import {
  deriveVectorEvidenceGates,
  parseVectorBenchmarkSummary,
} from "../src/evaluation/memory-policy.js";
import { FakeEmbedder } from "../src/memory/embeddings.js";
import { CockroachResolutionStore } from "../src/memory/resolution-store.js";
import {
  issueResolutionToken,
  resolutionTokenHash,
  ResolutionError,
  type ResolutionSnapshot,
} from "../src/memory/resolution.js";

type Mode = "runtime" | "vector-provenance";

interface Cli {
  mode: Mode;
  output: string;
  sourceSha: string;
  vectorLog?: string;
  benchmarkSource?: string;
}

interface CanonicalRow {
  id: string;
  idempotency_key: string | null;
  content_hash: string | null;
  status: string;
  superseded_by: string | null;
}

const SOURCE_SHA_PATTERN = /^[a-f0-9]{40}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const COMPANY = "Helios SA";

function fail(message: string): never {
  throw new Error(message);
}

function requireEvidence(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [
          key,
          canonicalize((value as Record<string, unknown>)[key]),
        ])
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function prettyJson(value: unknown): string {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function parseCli(argv: string[]): Cli {
  const [rawMode, ...rest] = argv;
  if (rawMode !== "runtime" && rawMode !== "vector-provenance") {
    fail(
      "Usage: evaluate-runtime-longitudinal.ts <runtime|vector-provenance> [options]"
    );
  }
  const options = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      fail(`Invalid CLI argument near "${key ?? ""}".`);
    }
    if (options.has(key.slice(2))) {
      fail(`Duplicate CLI option "${key}".`);
    }
    options.set(key.slice(2), value);
  }
  const output = options.get("output");
  const sourceSha = options.get("source-sha");
  if (!output || !sourceSha || !SOURCE_SHA_PATTERN.test(sourceSha)) {
    fail("--output and an exact lowercase 40-character --source-sha are required.");
  }
  const cli: Cli = { mode: rawMode, output, sourceSha };
  if (rawMode === "vector-provenance") {
    cli.vectorLog = options.get("vector-log");
    cli.benchmarkSource = options.get("benchmark-source");
    if (!cli.vectorLog || !cli.benchmarkSource) {
      fail(
        "vector-provenance mode requires --vector-log and --benchmark-source."
      );
    }
  }
  return cli;
}

function assertStrictChild(parent: string, target: string, label: string): string {
  const parentPath = resolve(parent);
  const targetPath = resolve(target);
  const child = relative(parentPath, targetPath);
  if (
    child === "" ||
    child === "." ||
    child === ".." ||
    child.startsWith(`..${sep}`) ||
    resolve(parentPath, child) !== targetPath
  ) {
    fail(`${label} must be a strict child of ${parentPath}.`);
  }
  return targetPath;
}

function pipelinePaths(cli: Cli): {
  output: string;
  workspace: string;
  runnerTemp: string;
} {
  if (process.env.CI !== "true") {
    fail("Runtime evaluation is pipeline-only and requires CI=true.");
  }
  const runnerTempRaw = process.env.RUNNER_TEMP;
  const workspaceRaw = process.env.GITHUB_WORKSPACE;
  if (!runnerTempRaw || !workspaceRaw) {
    fail("RUNNER_TEMP and GITHUB_WORKSPACE are required.");
  }
  const runnerTemp = resolve(runnerTempRaw);
  const workspace = resolve(workspaceRaw);
  const output = assertStrictChild(runnerTemp, cli.output, "--output");
  return { output, workspace, runnerTemp };
}

function assertEphemeralDatabaseUrl(): void {
  const raw = process.env.DATABASE_URL?.trim();
  if (!raw) fail("DATABASE_URL is required.");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    fail("DATABASE_URL is invalid.");
  }
  const localHost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (
    (url.protocol !== "postgresql:" && url.protocol !== "postgres:") ||
    !localHost ||
    url.port !== "26257" ||
    decodeURIComponent(url.username) !== "root" ||
    url.password !== "" ||
    url.pathname !== "/archon_memory" ||
    url.searchParams.get("sslmode") !== "disable"
  ) {
    fail(
      "Runtime evaluation requires the passwordless local ephemeral CockroachDB URL."
    );
  }
}

async function cockroachVersion(): Promise<string> {
  const rows = await query<{ version: string }>("SELECT version()");
  const version = rows[0]?.version;
  requireEvidence(
    typeof version === "string" && /CockroachDB/u.test(version),
    "The ephemeral database did not identify itself as CockroachDB."
  );
  return version;
}

function newAgent(): MemoryAgent {
  return new MemoryAgent(new FakeEmbedder(1024), new FakeNarrator());
}

async function withFreshPool<T>(operation: () => Promise<T>): Promise<T> {
  await closePool();
  try {
    return await operation();
  } finally {
    await closePool();
  }
}

async function retryBounded<T>(
  operation: () => Promise<T>,
  accepted: (value: T) => boolean
): Promise<T> {
  let last: T | undefined;
  for (let attempt = 1; attempt <= 6; attempt++) {
    last = await operation();
    if (accepted(last)) return last;
    if (attempt < 6) {
      await new Promise<void>((resolveDelay) =>
        setTimeout(resolveDelay, attempt * 150)
      );
    }
  }
  return last as T;
}

async function canonicalRows(idempotencyKeys: string[]): Promise<CanonicalRow[]> {
  return query<CanonicalRow>(
    `SELECT id, idempotency_key, content_hash, status, superseded_by
       FROM public.agent_memory
      WHERE tenant_id = 'public-demo'
        AND embed_model = 'fake-hash-embedder'
        AND idempotency_key = ANY($1::STRING[])
      ORDER BY idempotency_key`,
    [idempotencyKeys]
  );
}

function observation(
  snapshot: ResolutionSnapshot,
  label: "prior" | "corrected"
) {
  const result = snapshot.observations.find((item) => item.label === label);
  if (!result) fail(`Resolution snapshot is missing ${label} observation.`);
  return result;
}

function validReceipt(snapshot: ResolutionSnapshot): boolean {
  return Boolean(
    snapshot.receipt &&
      snapshot.receipt.algorithm === "sha256" &&
      SHA256_PATTERN.test(snapshot.receipt.digest) &&
      snapshot.receipt.actorRole === "financial-controller" &&
      snapshot.receipt.policyVersion === "resolution-policy-v1"
  );
}

async function exactCount(
  table: "memory_resolution_decisions" | "memory_resolution_consolidations",
  sessionId: string
): Promise<number> {
  const rows = await query<{ n: string }>(
    `SELECT count(*)::STRING AS n
       FROM public.${table}
      WHERE session_id = $1`,
    [sessionId]
  );
  return Number(rows[0]?.n ?? "NaN");
}

async function removeExactEvidence(
  idempotencyKeys: string[],
  sessionIds: string[]
): Promise<boolean> {
  await closePool();
  try {
    if (sessionIds.length > 0) {
      await query(
        `DELETE FROM public.memory_demo_sessions
          WHERE id = ANY($1::UUID[])`,
        [sessionIds]
      );
    }
    if (idempotencyKeys.length > 0) {
      await query(
        `DELETE FROM public.agent_memory
          WHERE tenant_id = 'public-demo'
            AND embed_model = 'fake-hash-embedder'
            AND idempotency_key = ANY($1::STRING[])`,
        [idempotencyKeys]
      );
    }
    const canonical = await canonicalRows(idempotencyKeys);
    const remainingSessions =
      sessionIds.length === 0
        ? []
        : await query<{ id: string }>(
            `SELECT id
               FROM public.memory_demo_sessions
              WHERE id = ANY($1::UUID[])`,
            [sessionIds]
          );
    return canonical.length === 0 && remainingSessions.length === 0;
  } finally {
    await closePool();
  }
}

async function runRuntime(cli: Cli, output: string): Promise<void> {
  assertEphemeralDatabaseUrl();
  const caseId = randomUUID();
  const recordId = `runtime-parity-${caseId}`;
  const priorKey = `runtime-parity/v1/${caseId}/prior`;
  const correctedKey = `runtime-parity/v1/${caseId}/corrected`;
  const idempotencyKeys = [priorKey, correctedKey];
  const sessionIds: string[] = [];
  let cleanupVerified = false;

  try {
    const version = await withFreshPool(cockroachVersion);
    const priorId = await withFreshPool(() =>
      newAgent().remember(
        "document",
        `Signed payroll evidence ${recordId} reports employer cost EUR 124,400.`,
        {
          company: COMPANY,
          period: "2026-06",
          sourceRef: recordId,
          idempotencyKey: priorKey,
          metadata: {
            record: recordId,
            employer_cost_cents: 12_440_000,
            importance: 0.6,
          },
        }
      )
    );

    const priorRecall = await withFreshPool(() =>
      retryBounded(
        () =>
          newAgent().recallAnswer(
            `What employer cost does ${recordId} report as EUR 124,400?`,
            { company: COMPANY, limit: 10 }
          ),
        (result) => result.hits.some((hit) => hit.id === priorId)
      )
    );
    const retriedPriorId = await withFreshPool(() =>
      newAgent().remember(
        "document",
        `Signed payroll evidence ${recordId} reports employer cost EUR 124,400.`,
        {
          company: COMPANY,
          period: "2026-06",
          sourceRef: recordId,
          idempotencyKey: priorKey,
          metadata: {
            record: recordId,
            employer_cost_cents: 12_440_000,
            importance: 0.6,
          },
        }
      )
    );
    const priorRowsAfterRetry = await withFreshPool(() =>
      canonicalRows([priorKey])
    );

    const correctedId = await withFreshPool(() =>
      newAgent().remember(
        "document",
        `Newer signed payroll evidence ${recordId} corrects employer cost to EUR 128,900.`,
        {
          company: COMPANY,
          period: "2026-06",
          sourceRef: recordId,
          idempotencyKey: correctedKey,
          metadata: {
            record: recordId,
            employer_cost_cents: 12_890_000,
            importance: 0.95,
          },
        }
      )
    );

    const audit = await withFreshPool(() =>
      newAgent().auditSnapshot({ company: COMPANY, period: "2026-06" })
    );
    const relevantConflict = audit.report.contradictions.find(
      (item) =>
        item.subject === recordId &&
        item.attribute === "employer_cost_cents"
    );
    const correctionRecall = await withFreshPool(() =>
      retryBounded(
        () =>
          newAgent().recallAnswer(
            `Which newer signed payroll evidence corrects ${recordId} to EUR 128,900?`,
            { company: COMPANY, limit: 10 }
          ),
        (result) => result.hits.some((hit) => hit.id === correctedId)
      )
    );
    const canonicalBeforeSandbox = await withFreshPool(() =>
      canonicalRows(idempotencyKeys)
    );

    const approvalToken = issueResolutionToken();
    const approvalPending = await withFreshPool(() =>
      new CockroachResolutionStore().createSession(
        resolutionTokenHash(approvalToken)
      )
    );
    sessionIds.push(approvalPending.sessionId);
    const approvalKey = randomUUID();
    const approved = await withFreshPool(() =>
      new CockroachResolutionStore().decide(
        resolutionTokenHash(approvalToken),
        { decision: "approve", idempotencyKey: approvalKey }
      )
    );
    const approvedRead = await withFreshPool(() =>
      new CockroachResolutionStore().getSession(
        resolutionTokenHash(approvalToken)
      )
    );
    const approvedReplay = await withFreshPool(() =>
      new CockroachResolutionStore().decide(
        resolutionTokenHash(approvalToken),
        { decision: "approve", idempotencyKey: approvalKey }
      )
    );
    const approvalCounts = await withFreshPool(async () => ({
      decisions: await exactCount(
        "memory_resolution_decisions",
        approvalPending.sessionId
      ),
      consolidations: await exactCount(
        "memory_resolution_consolidations",
        approvalPending.sessionId
      ),
    }));
    const conflictingFinalDecisionRejected = await withFreshPool(async () => {
      try {
        await new CockroachResolutionStore().decide(
          resolutionTokenHash(approvalToken),
          { decision: "reject", idempotencyKey: randomUUID() }
        );
        return false;
      } catch (error) {
        return error instanceof ResolutionError && error.status === 409;
      }
    });

    const rejectionToken = issueResolutionToken();
    const rejectionPending = await withFreshPool(() =>
      new CockroachResolutionStore().createSession(
        resolutionTokenHash(rejectionToken)
      )
    );
    sessionIds.push(rejectionPending.sessionId);
    const rejected = await withFreshPool(() =>
      new CockroachResolutionStore().decide(
        resolutionTokenHash(rejectionToken),
        { decision: "reject", idempotencyKey: randomUUID() }
      )
    );
    const rejectedRead = await withFreshPool(() =>
      new CockroachResolutionStore().getSession(
        resolutionTokenHash(rejectionToken)
      )
    );
    const approvedAfterRejectedSession = await withFreshPool(() =>
      new CockroachResolutionStore().getSession(
        resolutionTokenHash(approvalToken)
      )
    );

    const canonicalAfterSandbox = await withFreshPool(() =>
      canonicalRows(idempotencyKeys)
    );
    const canonicalUnchangedBySandbox =
      canonicalJson(canonicalBeforeSandbox) ===
      canonicalJson(canonicalAfterSandbox);

    const gates: Record<string, boolean> = {
      ephemeralCockroachVerified: /CockroachDB/u.test(version),
      priorWritePersisted: priorRowsAfterRetry[0]?.id === priorId,
      freshAgentRecallFoundPrior: priorRecall.hits.some(
        (hit) => hit.id === priorId
      ),
      freshPoolPreservedMemory: priorRecall.hits.some(
        (hit) => hit.id === priorId
      ),
      identicalRetrySameId: retriedPriorId === priorId,
      identicalRetryExactlyOneRow: priorRowsAfterRetry.length === 1,
      freshAgentConflictDetected: Boolean(relevantConflict),
      supportedImportanceRuleSelectedCorrection:
        relevantConflict?.resolution.rule === "importance" &&
        relevantConflict.resolution.recommendedMemoryId === correctedId,
      freshAgentRecallFoundCorrection: correctionRecall.hits.some(
        (hit) => hit.id === correctedId
      ),
      bothCanonicalEvidenceRowsRemainActive:
        canonicalBeforeSandbox.length === 2 &&
        canonicalBeforeSandbox.every((row) => row.status === "active"),
      pendingGraphsValid:
        approvalPending.state === "pending" &&
        rejectionPending.state === "pending" &&
        approvalPending.receipt === null &&
        rejectionPending.receipt === null,
      approvalPersistedAcrossFreshStore:
        approved.state === "approved" &&
        approvedRead.state === "approved" &&
        observation(approvedRead, "prior").status === "superseded" &&
        observation(approvedRead, "corrected").status === "current",
      approvalReplayExactlyOnce:
        approvalCounts.decisions === 1 &&
        approvalCounts.consolidations === 1 &&
        approved.receipt?.decisionId === approvedReplay.receipt?.decisionId &&
        approved.receipt?.digest === approvedReplay.receipt?.digest &&
        approved.receipt?.decidedAt === approvedReplay.receipt?.decidedAt,
      conflictingFinalDecisionRejected,
      rejectionPersistedAcrossFreshStore:
        rejected.state === "rejected" &&
        rejectedRead.state === "rejected" &&
        observation(rejectedRead, "prior").status === "current" &&
        observation(rejectedRead, "corrected").status === "rejected",
      resolutionSessionsIsolated:
        approvalPending.sessionId !== rejectionPending.sessionId &&
        approvedAfterRejectedSession.state === "approved",
      receiptsValidAndStable:
        validReceipt(approved) &&
        validReceipt(approvedRead) &&
        validReceipt(approvedReplay) &&
        validReceipt(rejected) &&
        validReceipt(rejectedRead),
      canonicalRowsUnchangedBySandbox: canonicalUnchangedBySandbox,
    };

    cleanupVerified = await removeExactEvidence(idempotencyKeys, sessionIds);
    gates.cleanupVerified = cleanupVerified;
    const failed = Object.entries(gates)
      .filter(([, passed]) => !passed)
      .map(([name]) => name);
    requireEvidence(
      failed.length === 0,
      `Runtime parity gates failed: ${failed.join(", ")}`
    );

    const evidenceBody = {
      schemaVersion: "1.0.0",
      evidenceClass: "real-ephemeral-cockroachdb-runtime-partial-parity",
      sourceSha: cli.sourceSha,
      generatedAt: new Date().toISOString(),
      environment: {
        topology: "single-node-ephemeral-ci",
        databaseProduct: "CockroachDB",
        databaseVersion: version,
        embedding: "fake-hash-embedder",
        narrator: "fake-narrator",
        externalModelCalls: false,
        distinctObjectAndPoolLifetimes: true,
        separateOperatingSystemProcesses: false,
      },
      canonicalMemory: {
        company: COMPANY,
        writes: 2,
        distinctWriterInstances: 3,
        distinctReaderInstances: 3,
        priorIdSha256: sha256Text(priorId),
        correctedIdSha256: sha256Text(correctedId),
        completeAuditCoverage: audit.coverage.complete,
        contradictionCount: audit.report.contradictions.length,
        selectedRule: relevantConflict?.resolution.rule ?? null,
        currentStatuses: canonicalBeforeSandbox.map((row) => row.status),
      },
      resolutionSandbox: {
        sessions: 2,
        distinctStoreInstancesAcrossTransitions: true,
        approvedState: approvedRead.state,
        rejectedState: rejectedRead.state,
        replayDecisionRows: approvalCounts.decisions,
        replayConsolidationRows: approvalCounts.consolidations,
        receiptDigests: {
          approved: approvedRead.receipt?.digest ?? null,
          rejected: rejectedRead.receipt?.digest ?? null,
        },
        canonicalRowsUnchanged: canonicalUnchangedBySandbox,
        externalSideEffects: "none",
      },
      cleanup: {
        exactSyntheticRowsOnly: true,
        verified: cleanupVerified,
      },
      gates,
      claims: {
        supported: [
          "durable-canonical-memory-across-fresh-agent-and-pool-lifetimes",
          "exact-key-canonical-write-idempotency",
          "active-evidence-conflict-audit-and-salience-recommendation",
          "fixed-synthetic-resolution-approve-reject-replay-and-receipts",
          "resolution-sandbox-isolated-from-canonical-memory",
        ],
        notSupported: [
          "full-B0-through-B4-production-runtime-parity",
          "native-canonical-session-identities",
          "canonical-valid-time-retention-or-authority-rank-policy",
          "independent-session-A-and-session-B-resolution-ingestion",
          "authenticated-financial-controller-identity",
          "canonical-memory-consolidation-from-public-sandbox",
          "external-business-side-effects",
          "TTL-garbage-collection-execution",
          "real-embedding-or-narration-models",
          "multi-node-or-concurrent-runtime-load",
          "customer-corpus-or-business-outcome",
        ],
      },
    };
    const result = {
      ...evidenceBody,
      receipt: {
        algorithm: "sha256",
        digest: sha256Text(canonicalJson(evidenceBody)),
      },
    };
    await writeFile(
      resolve(output, "runtime-longitudinal-results.json"),
      prettyJson(result),
      { encoding: "utf8", flag: "w" }
    );
  } catch (error) {
    if (!cleanupVerified) {
      try {
        await removeExactEvidence(idempotencyKeys, sessionIds);
      } catch {
        // Preserve the evaluation failure. A failed exact-row cleanup is still
        // bounded to the disposable CI database, which the workflow destroys.
      }
    }
    throw error;
  } finally {
    await closePool();
  }
}

async function runVectorProvenance(
  cli: Cli,
  output: string,
  workspace: string,
  runnerTemp: string
): Promise<void> {
  assertEphemeralDatabaseUrl();
  try {
    const vectorLogPath = assertStrictChild(
      runnerTemp,
      cli.vectorLog!,
      "--vector-log"
    );
    const benchmarkSourcePath = assertStrictChild(
      workspace,
      cli.benchmarkSource!,
      "--benchmark-source"
    );
    const benchmarkSourceRelative = relative(
      workspace,
      benchmarkSourcePath
    ).replaceAll("\\", "/");
    requireEvidence(
      benchmarkSourceRelative === "scripts/benchmark.ts",
      "--benchmark-source must be scripts/benchmark.ts."
    );
    const [log, source, version] = await Promise.all([
      readFile(vectorLogPath, "utf8"),
      readFile(benchmarkSourcePath, "utf8"),
      cockroachVersion(),
    ]);
    const summary = parseVectorBenchmarkSummary(log);
    const sourceContract = {
      exactTopKDefined: /function exactTopK\s*\(/u.test(source),
      truthSetUsesExactTopK:
        /queries\.map\(\(q\)\s*=>\s*new Set\(exactTopK\(corpus,\s*q,\s*K\)\)\)/u.test(
          source
        ),
      cspannDistanceQueryPresent:
        /ORDER BY embedding <=> \$1::VECTOR LIMIT \$\{K\}/u.test(source),
    };
    const provenance = {
      schemaVersion: "1.0.0",
      evidenceClass: "exact-sha-vector-benchmark-provenance",
      sourceSha: cli.sourceSha,
      benchmark: {
        sourcePath: "scripts/benchmark.ts",
        sourceSha256: sha256Text(source),
        logSha256: sha256Text(log),
        completed:
          log.includes("=== Vector-index benchmark ===") &&
          summary.beams.length > 0,
        sourceContract,
      },
      database: {
        product: "CockroachDB",
        version,
        querySucceeded: true,
      },
      exactGroundTruth: {
        method: "deterministic-seeded-brute-force-cosine-js",
        corpusSize: summary.corpus_size,
        queries: summary.queries,
        topK: summary.top_k,
      },
      approximateSearch: {
        method: "cockroachdb-cspann-cosine",
        distanceOperator: "<=>",
        queries: summary.queries,
        topK: summary.top_k,
      },
      limitations: [
        "Source-contract attestation is reviewable integrity evidence, not formal verification.",
        "This benchmark uses deterministic generated vectors, not semantic customer data.",
      ],
    } as const;
    const derived = deriveVectorEvidenceGates(provenance, summary, {
      sourceSha: cli.sourceSha,
      vectorLogSha256: sha256Text(log),
    });
    const failed = Object.entries(derived.gates)
      .filter(([, passed]) => !passed)
      .map(([name]) => name);
    requireEvidence(
      failed.length === 0,
      `Vector provenance gates failed: ${failed.join(", ")}`
    );
    await writeFile(
      resolve(output, "vector-provenance.json"),
      prettyJson({ ...provenance, derivedGates: derived.gates }),
      { encoding: "utf8", flag: "w" }
    );
  } finally {
    await closePool();
  }
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  const paths = pipelinePaths(cli);
  if (cli.mode === "runtime") {
    await runRuntime(cli, paths.output);
  } else {
    await runVectorProvenance(
      cli,
      paths.output,
      paths.workspace,
      paths.runnerTemp
    );
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`runtime-longitudinal-evaluation failed: ${message}`);
  process.exitCode = 1;
});
