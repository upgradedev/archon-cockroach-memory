// Read-only release boundary for the final demo-video workflow. The initial
// phase selects one exact, fully evidenced production release. The terminal
// phase revalidates the same run and artifact identities after capture/rendering
// has completed. Only a sanitized receipt below RUNNER_TEMP is persisted.

import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  exactPublicScope,
  parseWorkflowArtifacts,
  parseWorkflowJobs,
  parseWorkflowRuns,
  requireFreshGeneratedAt,
  requirePostDeployAuditTiming,
  requireSuccessfulDeployJobs,
  requireSuccessfulHostedDastJobs,
  requireSuccessfulRecoveryAuditJobs,
  selectSuccessfulRun,
  validLiveResponseMetadata,
} from "./final-submission-gate.js";
import type {
  GitHubArtifact,
  GitHubWorkflowRun,
} from "./final-submission-gate.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY = "upgradedev/archon-cockroach-memory";
const DEMO_ORIGIN = "https://d2s5v0o0eg2aaw.cloudfront.net";
const WORKFLOW_PATH = ".github/workflows/demo-video.yml";
const WORKFLOW_REF = `${REPOSITORY}/${WORKFLOW_PATH}@refs/heads/main`;
const MAXIMUM_AGE_MS = 24 * 60 * 60 * 1_000;
const CLOCK_SKEW_MS = 5 * 60 * 1_000;
export const DEMO_VIDEO_CHECK_IDS = [
  "trusted-workflow-identity",
  "current-main",
  "exact-release-runs",
  "attempt-specific-job-contracts",
  "post-deploy-freshness",
  "digest-bearing-artifacts",
  "canonical-live-proof",
] as const;

export type DemoVideoGatePhase = "initial" | "terminal";

export interface StoredRunSelection {
  id: number;
  attempt: number;
  event: string;
  workflowPath: string;
  headSha: string;
  completedAt: string;
}

export interface StoredArtifactSelection {
  id: number;
  name: string;
  sizeInBytes: number;
  digest: string;
  workflowRunId: number;
  headSha: string;
  createdAt: string;
  updatedAt: string;
}

export interface DemoVideoRunSelections {
  ci: StoredRunSelection;
  codeql: StoredRunSelection;
  deploy: StoredRunSelection;
  hostedDast: StoredRunSelection;
  managedMcp: StoredRunSelection;
  recovery: StoredRunSelection;
}

export interface DemoVideoArtifactSelections {
  hostedDast: StoredArtifactSelection;
  hostedDastZap: StoredArtifactSelection;
  managedMcp: StoredArtifactSelection;
  recoveryStaging: StoredArtifactSelection;
  recoveryProduction: StoredArtifactSelection;
}

export interface DemoVideoGateCheck {
  id: (typeof DEMO_VIDEO_CHECK_IDS)[number];
  status: "pass";
}

export interface CanonicalProofSummary {
  endpoint: `${typeof DEMO_ORIGIN}/api/proof`;
  generatedAt: string;
  releaseSha: string;
  database: "CockroachDB";
  deployment: "CockroachDB Cloud on AWS";
  region: "eu-west-1";
  vectorEngine: "native CockroachDB C-SPANN";
  vectorDimensions: 1024;
  persisted: 9;
  idempotencyKeys: 9;
  contentDigests: 9;
}

export interface DemoVideoReleaseBindingReceipt {
  schema: "archon.demo-video-release-binding";
  version: 1;
  repository: typeof REPOSITORY;
  ref: "refs/heads/main";
  releaseSha: string;
  demoUrl: typeof DEMO_ORIGIN;
  sourceGateRunId: number;
  sourceGateRunAttempt: number;
  passed: true;
  selectedRuns: DemoVideoRunSelections;
  selectedArtifacts: DemoVideoArtifactSelections;
  liveProof: CanonicalProofSummary;
  checks: DemoVideoGateCheck[];
}

interface Invocation {
  phase: DemoVideoGatePhase;
  sha: string;
  token: string;
  repository: typeof REPOSITORY;
  runId: number;
  runAttempt: number;
  sourceGateRunAttempt: number;
  receiptPath: string;
  outputPath: string;
}

interface SelectedEvidenceRuns {
  ci: GitHubWorkflowRun;
  codeql: GitHubWorkflowRun;
  deploy: GitHubWorkflowRun;
  dast: GitHubWorkflowRun;
  mcp: GitHubWorkflowRun;
  recovery: GitHubWorkflowRun;
}

interface SelectedEvidenceArtifacts {
  dastReceipt: GitHubArtifact;
  dastZap: GitHubArtifact;
  mcpReceipt: GitHubArtifact;
  recoveryStaging: GitHubArtifact;
  recoveryProduction: GitHubArtifact;
}

interface EvidenceBundle {
  runs: SelectedEvidenceRuns;
  artifacts: SelectedEvidenceArtifacts;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value
        .map(asRecord)
        .filter(
          (candidate): candidate is Record<string, unknown> =>
            candidate !== undefined
        )
    : [];
}

function stringValue(
  record: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function numberValue(
  record: Record<string, unknown> | undefined,
  key: string
): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function booleanValue(
  record: Record<string, unknown> | undefined,
  key: string
): boolean | undefined {
  const value = record?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requirePositiveInteger(value: string, label: string): number {
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new Error(`${label} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${label} is outside the safe integer range`);
  }
  return parsed;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown failure";
  return message
    .replace(/Bearer\s+\S+/giu, "Bearer [redacted]")
    .replace(/(?:token|key|secret)[=:]\S+/giu, "[redacted]")
    .slice(0, 500);
}

export function validExactCommitSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/u.test(value);
}

export function parseDemoVideoPhase(
  value: unknown
): DemoVideoGatePhase | undefined {
  return value === "initial" || value === "terminal" ? value : undefined;
}

export function requireRunnerTempReceiptPath(
  runnerTemp: string,
  requestedPath: string
): string {
  const root = resolve(runnerTemp);
  const receipt = resolve(requestedPath);
  const relativePath = relative(root, receipt);
  if (
    receipt === root ||
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    resolve(root, relativePath) !== receipt
  ) {
    throw new Error("Demo-video release receipt must be below RUNNER_TEMP");
  }
  return receipt;
}

export function exactMainSha(value: unknown): string {
  const root = asRecord(value);
  const object = asRecord(root?.object);
  const sha = stringValue(object, "sha");
  if (!validExactCommitSha(sha)) {
    throw new Error("GitHub main ref did not return an exact commit SHA");
  }
  return sha;
}

export function requireTrustedWorkflowInvocation(
  input: {
    repository: unknown;
    eventName: unknown;
    ref: unknown;
    workflowRef: unknown;
    githubSha: unknown;
    expectedSha: unknown;
    runId: unknown;
    runAttempt: unknown;
  }
): void {
  if (
    input.repository !== REPOSITORY ||
    input.eventName !== "workflow_dispatch" ||
    input.ref !== "refs/heads/main" ||
    input.workflowRef !== WORKFLOW_REF ||
    !validExactCommitSha(input.expectedSha) ||
    input.githubSha !== input.expectedSha ||
    !Number.isSafeInteger(input.runId) ||
    (input.runId as number) < 1 ||
    !Number.isSafeInteger(input.runAttempt) ||
    (input.runAttempt as number) < 1
  ) {
    throw new Error(
      "Demo-video workflow identity, dispatch event, ref, SHA, or run identity is invalid"
    );
  }
}

export function requireCurrentWorkflowRun(
  value: unknown,
  expected: {
    id: number;
    attempt: number;
    sha: string;
  }
): GitHubWorkflowRun {
  const run = parseWorkflowRuns({ workflow_runs: [value] })[0];
  if (
    !run ||
    run.id !== expected.id ||
    run.run_attempt !== expected.attempt ||
    run.path !== WORKFLOW_PATH ||
    run.event !== "workflow_dispatch" ||
    run.head_branch !== "main" ||
    run.head_sha !== expected.sha ||
    run.status !== "in_progress" ||
    run.conclusion !== null
  ) {
    throw new Error(
      "Current GitHub run is not the in-progress exact-main demo-video dispatch"
    );
  }
  return run;
}

export function selectReleaseEvidenceRuns(
  value: {
    ci: GitHubWorkflowRun[];
    codeql: GitHubWorkflowRun[];
    deploy: GitHubWorkflowRun[];
    dast: GitHubWorkflowRun[];
    mcp: GitHubWorkflowRun[];
    recovery: GitHubWorkflowRun[];
  },
  sha: string
): SelectedEvidenceRuns {
  if (!validExactCommitSha(sha)) {
    throw new Error("Release evidence selection requires an exact commit SHA");
  }
  return {
    ci: selectSuccessfulRun(
      value.ci,
      "CI",
      "push",
      sha,
      ".github/workflows/ci.yml"
    ),
    codeql: selectSuccessfulRun(
      value.codeql,
      "CodeQL",
      "push",
      sha,
      ".github/workflows/codeql.yml"
    ),
    deploy: selectSuccessfulRun(
      value.deploy,
      "Deploy AWS",
      "workflow_run",
      sha,
      ".github/workflows/deploy-aws.yml"
    ),
    dast: selectSuccessfulRun(
      value.dast,
      "Hosted DAST",
      "workflow_run",
      sha,
      ".github/workflows/security-dast.yml"
    ),
    mcp: selectSuccessfulRun(
      value.mcp,
      "Cockroach Cloud Managed MCP Audit",
      "workflow_dispatch",
      sha,
      ".github/workflows/managed-mcp-audit.yml"
    ),
    recovery: selectSuccessfulRun(
      value.recovery,
      "Recover AWS",
      "workflow_dispatch",
      sha,
      ".github/workflows/recover-aws.yml"
    ),
  };
}

type ParsedWorkflowJob = ReturnType<
  typeof parseWorkflowJobs
>["jobs"][number];

function requireSuccessfulJob(
  jobs: ParsedWorkflowJob[],
  runId: number,
  sha: string,
  name: string,
  requiredSteps: readonly string[]
): void {
  const matches = jobs.filter((job) => job.name === name);
  const job = matches[0];
  if (
    matches.length !== 1 ||
    !job ||
    job.run_id !== runId ||
    job.head_sha !== sha ||
    job.status !== "completed" ||
    job.conclusion !== "success"
  ) {
    throw new Error(`${name} did not complete successfully`);
  }
  for (const stepName of requiredSteps) {
    const steps = job.steps.filter((step) => step.name === stepName);
    if (
      steps.length !== 1 ||
      steps[0]?.status !== "completed" ||
      steps[0]?.conclusion !== "success"
    ) {
      throw new Error(`${name} / ${stepName} did not execute successfully`);
    }
  }
}

export function requireDemoVideoDeployContract(
  value: unknown,
  runId: number,
  sha: string
): void {
  requireSuccessfulDeployJobs(value, runId, sha);
  const { totalCount, jobs } = parseWorkflowJobs(value);
  const databaseJobName =
    "Reconcile CockroachDB memory release / Atomic schema, seed, runtime RLS, and C-SPANN execution proof";
  const expectedNames = [
    "Validate Deploy AWS source CI",
    "Verify CI SHA and build once",
    databaseJobName,
    "Deploy and smoke staging",
    "Promote identical candidate to production",
    "Prove production memory through CockroachDB Managed MCP",
  ].sort();
  if (
    totalCount !== expectedNames.length ||
    jobs.length !== expectedNames.length ||
    JSON.stringify(jobs.map((job) => job.name).sort()) !==
      JSON.stringify(expectedNames)
  ) {
    throw new Error("Deploy AWS must contain the exact six-job release contract");
  }
  requireSuccessfulJob(
    jobs,
    runId,
    sha,
    databaseJobName,
    [
      "Prove target is still current main",
      "Prove CockroachDB Cloud provider, plan, state, and region",
      "Gate real Titan and Claude quality on the golden judge question",
      "Reconcile schema, canonical memory, and runtime credentials",
      "Upload sanitized database release receipt",
    ]
  );
}

export function requireManagedMcpJobContract(
  value: unknown,
  runId: number,
  sha: string
): void {
  const { totalCount, rawCount, jobs } = parseWorkflowJobs(value);
  if (totalCount !== 1 || rawCount !== 1 || jobs.length !== 1) {
    throw new Error("Standalone Managed MCP audit must contain exactly one job");
  }
  requireSuccessfulJob(
    jobs,
    runId,
    sha,
    "Verify the live cluster through Managed MCP",
    [
      "Check out the default branch",
      "Set up Node.js",
      "Install locked dependencies",
      "Run the bounded read-only Managed MCP proof",
      "Upload the sanitized proof receipt",
    ]
  );
}

export function requireDemoVideoRecoveryContract(
  value: unknown,
  runId: number,
  sha: string
): void {
  requireSuccessfulRecoveryAuditJobs(value, runId, sha);
  const { jobs } = parseWorkflowJobs(value);
  requireSuccessfulJob(
    jobs,
    runId,
    sha,
    "Recover unresolved staging delivery",
    [
      "Check out trusted recovery code",
      "Prove trusted recovery source identity",
      "Configure short-lived staging recovery credentials",
      "Classify the exact staging source run",
      "Run the daily staging protection and drift audit",
      "Upload staging daily protection and drift audit",
    ]
  );
  requireSuccessfulJob(
    jobs,
    runId,
    sha,
    "Recover unresolved production delivery",
    [
      "Check out trusted recovery code",
      "Prove trusted recovery source identity",
      "Configure short-lived production recovery credentials",
      "Classify the exact production source run",
      "Run the daily production protection and drift audit",
      "Upload production daily protection and drift audit",
    ]
  );
}

export function requireFreshPostDeployTiming(
  runs: Pick<SelectedEvidenceRuns, "deploy" | "dast" | "mcp" | "recovery">,
  now = Date.now()
): void {
  requirePostDeployAuditTiming(
    runs.deploy,
    runs.dast,
    runs.mcp,
    runs.recovery,
    now
  );
  const deployedAt = Date.parse(runs.deploy.updated_at);
  if (
    !Number.isFinite(deployedAt) ||
    deployedAt > now + CLOCK_SKEW_MS ||
    now - deployedAt > MAXIMUM_AGE_MS
  ) {
    throw new Error("Selected production deployment must be under 24 hours old");
  }
  for (const [label, run] of [
    ["Hosted DAST", runs.dast],
    ["Managed MCP", runs.mcp],
    ["manual recovery audit", runs.recovery],
  ] as const) {
    const startedAt = Date.parse(run.run_started_at);
    const completedAt = Date.parse(run.updated_at);
    if (
      startedAt <= deployedAt ||
      completedAt < startedAt ||
      startedAt - deployedAt > MAXIMUM_AGE_MS ||
      completedAt - deployedAt > MAXIMUM_AGE_MS
    ) {
      throw new Error(
        `${label} must start and finish within 24 hours after deployment`
      );
    }
  }
}

export function selectExactArtifactInventory(
  value: unknown,
  expectedNames: readonly string[],
  run: GitHubWorkflowRun,
  now = Date.now(),
  allowedPriorAttemptNames: readonly string[] = [],
  maximumSizeInBytes = 1_000_000
): Record<string, GitHubArtifact> {
  const root = asRecord(value);
  const rawArtifacts = asRecords(root?.artifacts);
  const totalCount = numberValue(root, "total_count");
  const allowedNames = [...expectedNames, ...allowedPriorAttemptNames];
  const rawNames = rawArtifacts.map(
    (artifact) => stringValue(artifact, "name") ?? ""
  );
  if (
    new Set(expectedNames).size !== expectedNames.length ||
    new Set(allowedNames).size !== allowedNames.length ||
    totalCount !== rawArtifacts.length ||
    (totalCount ?? 0) < expectedNames.length ||
    (totalCount ?? 0) > 100 ||
    rawNames.some((name) => !allowedNames.includes(name)) ||
    new Set(rawNames).size !== rawNames.length ||
    expectedNames.some(
      (expectedName) =>
        rawNames.filter((name) => name === expectedName).length !== 1
    )
  ) {
    throw new Error(
      "Artifact inventory is incomplete, ambiguous, or contains unexpected artifacts"
    );
  }

  const parsed = parseWorkflowArtifacts(value, maximumSizeInBytes);
  if (
    parsed.length !== rawArtifacts.length ||
    new Set(parsed.map((artifact) => artifact.id)).size !== parsed.length
  ) {
    throw new Error(
      "Every current or prior-attempt artifact must have canonical digest-bearing metadata"
    );
  }
  if (
    parsed.some(
      (artifact) =>
        artifact.workflowRunId !== run.id ||
        artifact.workflowRunHeadSha !== run.head_sha
    )
  ) {
    throw new Error(
      "Every current or prior-attempt artifact must belong to the exact run and SHA"
    );
  }
  const runStartedAt = Date.parse(run.run_started_at);
  const runCompletedAt = Date.parse(run.updated_at);
  if (
    parsed.some((artifact) => {
      const createdAt = Date.parse(artifact.createdAt);
      const updatedAt = Date.parse(artifact.updatedAt);
      const isCurrent = expectedNames.includes(artifact.name);
      return (
        ![createdAt, updatedAt, runStartedAt, runCompletedAt, now].every(
          Number.isFinite
        ) ||
        (isCurrent &&
          createdAt < runStartedAt - CLOCK_SKEW_MS) ||
        updatedAt < createdAt ||
        updatedAt > runCompletedAt + CLOCK_SKEW_MS ||
        updatedAt > now + CLOCK_SKEW_MS ||
        (isCurrent &&
          (artifact.expired !== false ||
            now - updatedAt > MAXIMUM_AGE_MS)) ||
        !/^sha256:[0-9a-f]{64}$/u.test(artifact.digest)
      );
    })
  ) {
    throw new Error(
      "Current or prior-attempt artifact timing or digest metadata is invalid"
    );
  }
  const output: Record<string, GitHubArtifact> = {};
  for (const expectedName of expectedNames) {
    const matches = parsed.filter(
      (artifact) =>
        artifact.name === expectedName &&
        artifact.workflowRunId === run.id &&
        artifact.workflowRunHeadSha === run.head_sha &&
        artifact.expired === false
    );
    const artifact = matches[0];
    if (matches.length !== 1 || !artifact) {
      throw new Error(
        `Exactly one unexpired ${expectedName} artifact is required`
      );
    }
    const createdAt = Date.parse(artifact.createdAt);
    const updatedAt = Date.parse(artifact.updatedAt);
    if (
      ![createdAt, updatedAt, runStartedAt, runCompletedAt, now].every(
        Number.isFinite
      ) ||
      createdAt < runStartedAt - CLOCK_SKEW_MS ||
      updatedAt < createdAt ||
      updatedAt > runCompletedAt + CLOCK_SKEW_MS ||
      updatedAt > now + CLOCK_SKEW_MS ||
      now - updatedAt > MAXIMUM_AGE_MS ||
      !/^sha256:[0-9a-f]{64}$/u.test(artifact.digest)
    ) {
      throw new Error(
        `${expectedName} artifact timing or digest metadata is invalid`
      );
    }
    output[expectedName] = artifact;
  }
  return output;
}

export function requireCanonicalPublicProof(
  value: unknown,
  sha: string,
  now = Date.now()
): CanonicalProofSummary {
  if (!validExactCommitSha(sha)) {
    throw new Error("Canonical proof requires an exact release SHA");
  }
  const proof = asRecord(value);
  if (!proof) throw new Error("Public proof is not an object");
  const database = asRecord(proof.database);
  const memory = asRecord(proof.memory);
  const vector = asRecord(proof.vectorIndex);
  const release = asRecord(proof.release);
  requireFreshGeneratedAt(proof, "Demo-video live proof", now);
  const prefixes = Array.isArray(vector?.prefixes) ? vector.prefixes : [];
  if (
    database?.engine !== "CockroachDB" ||
    database?.deployment !== "CockroachDB Cloud on AWS" ||
    database?.role !== "persistent agent memory" ||
    database?.transactionIsolation !== "SERIALIZABLE" ||
    database?.database !== "archon" ||
    !/CockroachDB/iu.test(stringValue(database, "version") ?? "") ||
    database?.region !== "eu-west-1" ||
    database?.regionEvidence !== "cockroach-cloud-api-release-gate" ||
    !/^archon_production_[0-9a-f]{10}$/u.test(
      stringValue(database, "runtimePrincipal") ?? ""
    ) ||
    numberValue(database, "activeMemories") !== 9 ||
    numberValue(memory, "persisted") !== 9 ||
    numberValue(memory, "idempotencyKeys") !== 9 ||
    numberValue(memory, "contentDigests") !== 9 ||
    booleanValue(memory, "storeVerified") !== true ||
    memory?.evidence !==
      "live bounded fixed-scope payload-digest verification" ||
    vector?.engine !== "native CockroachDB C-SPANN" ||
    vector?.enabled !== true ||
    vector?.name !== "idx_agent_memory_company_scope_embedding" ||
    vector?.metric !== "cosine" ||
    numberValue(vector, "dimensions") !== 1024 ||
    JSON.stringify(prefixes) !==
      JSON.stringify(["tenant_id", "embed_model", "status", "company"]) ||
    vector?.lifecycleState !== "active" ||
    vector?.evidence !== "live pg_catalog.pg_indexes definition" ||
    !/^[0-9a-f]{64}$/u.test(
      stringValue(vector, "definitionFingerprint") ?? ""
    ) ||
    proof.embeddingModel !== "amazon.titan-embed-text-v2:0" ||
    proof.narrationModel !== "eu.anthropic.claude-sonnet-4-6" ||
    release?.commitSha !== sha ||
    release?.evidence !== "server-configured Lambda environment" ||
    !exactPublicScope(proof.scope)
  ) {
    throw new Error(
      "Public proof is not the exact production SHA/eu-west-1/C-SPANN/9-9-9 contract"
    );
  }
  return {
    endpoint: `${DEMO_ORIGIN}/api/proof`,
    generatedAt: stringValue(proof, "generatedAt")!,
    releaseSha: sha,
    database: "CockroachDB",
    deployment: "CockroachDB Cloud on AWS",
    region: "eu-west-1",
    vectorEngine: "native CockroachDB C-SPANN",
    vectorDimensions: 1024,
    persisted: 9,
    idempotencyKeys: 9,
    contentDigests: 9,
  };
}

function toStoredRun(run: GitHubWorkflowRun): StoredRunSelection {
  return {
    id: run.id,
    attempt: run.run_attempt,
    event: run.event,
    workflowPath: run.path,
    headSha: run.head_sha,
    completedAt: run.updated_at,
  };
}

function toStoredArtifact(artifact: GitHubArtifact): StoredArtifactSelection {
  return {
    id: artifact.id,
    name: artifact.name,
    sizeInBytes: artifact.sizeInBytes,
    digest: artifact.digest,
    workflowRunId: artifact.workflowRunId,
    headSha: artifact.workflowRunHeadSha,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
  };
}

function storeRunSelections(runs: SelectedEvidenceRuns): DemoVideoRunSelections {
  return {
    ci: toStoredRun(runs.ci),
    codeql: toStoredRun(runs.codeql),
    deploy: toStoredRun(runs.deploy),
    hostedDast: toStoredRun(runs.dast),
    managedMcp: toStoredRun(runs.mcp),
    recovery: toStoredRun(runs.recovery),
  };
}

function storeArtifactSelections(
  artifacts: SelectedEvidenceArtifacts
): DemoVideoArtifactSelections {
  return {
    hostedDast: toStoredArtifact(artifacts.dastReceipt),
    hostedDastZap: toStoredArtifact(artifacts.dastZap),
    managedMcp: toStoredArtifact(artifacts.mcpReceipt),
    recoveryStaging: toStoredArtifact(artifacts.recoveryStaging),
    recoveryProduction: toStoredArtifact(artifacts.recoveryProduction),
  };
}

function exactKeys(
  record: Record<string, unknown>,
  expected: readonly string[]
): boolean {
  const observed = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  return (
    observed.length === sortedExpected.length &&
    observed.every((key, index) => key === sortedExpected[index])
  );
}

function validStoredRun(value: unknown): value is StoredRunSelection {
  const run = asRecord(value);
  return Boolean(
    run &&
      exactKeys(run, [
        "id",
        "attempt",
        "event",
        "workflowPath",
        "headSha",
        "completedAt",
      ]) &&
      Number.isSafeInteger(run.id) &&
      (run.id as number) > 0 &&
      Number.isSafeInteger(run.attempt) &&
      (run.attempt as number) > 0 &&
      typeof run.event === "string" &&
      typeof run.workflowPath === "string" &&
      validExactCommitSha(run.headSha) &&
      typeof run.completedAt === "string" &&
      !Number.isNaN(Date.parse(run.completedAt))
  );
}

function validStoredArtifact(
  value: unknown
): value is StoredArtifactSelection {
  const artifact = asRecord(value);
  return Boolean(
    artifact &&
      exactKeys(artifact, [
        "id",
        "name",
        "sizeInBytes",
        "digest",
        "workflowRunId",
        "headSha",
        "createdAt",
        "updatedAt",
      ]) &&
      Number.isSafeInteger(artifact.id) &&
      (artifact.id as number) > 0 &&
      typeof artifact.name === "string" &&
      Number.isSafeInteger(artifact.sizeInBytes) &&
      (artifact.sizeInBytes as number) > 0 &&
      (artifact.sizeInBytes as number) <= 100_000_000 &&
      typeof artifact.digest === "string" &&
      /^sha256:[0-9a-f]{64}$/u.test(artifact.digest as string) &&
      Number.isSafeInteger(artifact.workflowRunId) &&
      (artifact.workflowRunId as number) > 0 &&
      validExactCommitSha(artifact.headSha) &&
      typeof artifact.createdAt === "string" &&
      typeof artifact.updatedAt === "string" &&
      !Number.isNaN(Date.parse(artifact.createdAt)) &&
      !Number.isNaN(Date.parse(artifact.updatedAt)) &&
      Date.parse(artifact.createdAt) <= Date.parse(artifact.updatedAt)
  );
}

function validProofSummary(
  value: unknown,
  sha: string
): value is CanonicalProofSummary {
  const proof = asRecord(value);
  return Boolean(
    proof &&
      exactKeys(proof, [
        "endpoint",
        "generatedAt",
        "releaseSha",
        "database",
        "deployment",
        "region",
        "vectorEngine",
        "vectorDimensions",
        "persisted",
        "idempotencyKeys",
        "contentDigests",
      ]) &&
      proof.endpoint === `${DEMO_ORIGIN}/api/proof` &&
      typeof proof.generatedAt === "string" &&
      !Number.isNaN(Date.parse(proof.generatedAt)) &&
      proof.releaseSha === sha &&
      proof.database === "CockroachDB" &&
      proof.deployment === "CockroachDB Cloud on AWS" &&
      proof.region === "eu-west-1" &&
      proof.vectorEngine === "native CockroachDB C-SPANN" &&
      proof.vectorDimensions === 1024 &&
      proof.persisted === 9 &&
      proof.idempotencyKeys === 9 &&
      proof.contentDigests === 9
  );
}

function validGateChecks(value: unknown): value is DemoVideoGateCheck[] {
  if (!Array.isArray(value) || value.length !== DEMO_VIDEO_CHECK_IDS.length) {
    return false;
  }
  return value.every((candidate, index) => {
    const check = asRecord(candidate);
    return Boolean(
      check &&
        exactKeys(check, ["id", "status"]) &&
        check.id === DEMO_VIDEO_CHECK_IDS[index] &&
        check.status === "pass"
    );
  });
}

function proofContract(summary: CanonicalProofSummary): readonly unknown[] {
  return [
    summary.endpoint,
    summary.releaseSha,
    summary.database,
    summary.deployment,
    summary.region,
    summary.vectorEngine,
    summary.vectorDimensions,
    summary.persisted,
    summary.idempotencyKeys,
    summary.contentDigests,
  ];
}

export function requireEquivalentCanonicalProof(
  stored: CanonicalProofSummary,
  current: CanonicalProofSummary
): void {
  if (
    !validProofSummary(stored, stored.releaseSha) ||
    !validProofSummary(current, stored.releaseSha) ||
    JSON.stringify(proofContract(stored)) !==
      JSON.stringify(proofContract(current))
  ) {
    throw new Error(
      "Canonical production proof contract changed during demo-video production"
    );
  }
}

export function requireStoredReleaseBinding(
  value: unknown,
  expected: {
    sha: string;
    runId: number;
    runAttempt: number;
    now?: number;
  }
): DemoVideoReleaseBindingReceipt {
  const receipt = asRecord(value);
  const now = expected.now ?? Date.now();
  if (
    !validExactCommitSha(expected.sha) ||
    !Number.isSafeInteger(expected.runId) ||
    expected.runId < 1 ||
    !Number.isSafeInteger(expected.runAttempt) ||
    expected.runAttempt < 1 ||
    !Number.isFinite(now)
  ) {
    throw new Error("Stored release binding expectations are invalid");
  }
  const selectedRuns = asRecord(receipt?.selectedRuns);
  const selectedArtifacts = asRecord(receipt?.selectedArtifacts);
  const liveProof = receipt?.liveProof;
  const runKeys = [
    "ci",
    "codeql",
    "deploy",
    "hostedDast",
    "managedMcp",
    "recovery",
  ];
  const artifactKeys = [
    "hostedDast",
    "hostedDastZap",
    "managedMcp",
    "recoveryStaging",
    "recoveryProduction",
  ];
  const runContracts: Record<
    string,
    { event: string; workflowPath: string }
  > = {
    ci: { event: "push", workflowPath: ".github/workflows/ci.yml" },
    codeql: {
      event: "push",
      workflowPath: ".github/workflows/codeql.yml",
    },
    deploy: {
      event: "workflow_run",
      workflowPath: ".github/workflows/deploy-aws.yml",
    },
    hostedDast: {
      event: "workflow_run",
      workflowPath: ".github/workflows/security-dast.yml",
    },
    managedMcp: {
      event: "workflow_dispatch",
      workflowPath: ".github/workflows/managed-mcp-audit.yml",
    },
    recovery: {
      event: "workflow_dispatch",
      workflowPath: ".github/workflows/recover-aws.yml",
    },
  };
  if (
    !receipt ||
    !exactKeys(receipt, [
      "schema",
      "version",
      "repository",
      "ref",
      "releaseSha",
      "demoUrl",
      "sourceGateRunId",
      "sourceGateRunAttempt",
      "passed",
      "selectedRuns",
      "selectedArtifacts",
      "liveProof",
      "checks",
    ]) ||
    receipt.schema !== "archon.demo-video-release-binding" ||
    receipt.version !== 1 ||
    receipt.repository !== REPOSITORY ||
    receipt.ref !== "refs/heads/main" ||
    receipt.releaseSha !== expected.sha ||
    receipt.demoUrl !== DEMO_ORIGIN ||
    receipt.sourceGateRunId !== expected.runId ||
    receipt.sourceGateRunAttempt !== expected.runAttempt ||
    receipt.passed !== true ||
    !selectedRuns ||
    !exactKeys(selectedRuns, runKeys) ||
    runKeys.some((key) => !validStoredRun(selectedRuns[key])) ||
    runKeys.some((key) => {
      const run = asRecord(selectedRuns[key])!;
      const contract = runContracts[key]!;
      return (
        run.event !== contract.event ||
        run.workflowPath !== contract.workflowPath ||
        run.headSha !== expected.sha ||
        Date.parse(String(run.completedAt)) > now + CLOCK_SKEW_MS
      );
    }) ||
    !selectedArtifacts ||
    !exactKeys(selectedArtifacts, artifactKeys) ||
    artifactKeys.some(
      (key) => !validStoredArtifact(selectedArtifacts[key])
    ) ||
    !validProofSummary(liveProof, expected.sha) ||
    Date.parse(liveProof.generatedAt) > now + CLOCK_SKEW_MS ||
    now - Date.parse(liveProof.generatedAt) > MAXIMUM_AGE_MS ||
    !validGateChecks(receipt.checks)
  ) {
    throw new Error(
      "Initial demo-video release binding receipt is malformed or not bound to this run"
    );
  }
  const storedRuns = selectedRuns as unknown as DemoVideoRunSelections;
  const storedArtifacts =
    selectedArtifacts as unknown as DemoVideoArtifactSelections;
  const selectedRunIds = Object.values(storedRuns).map((run) => run.id);
  const selectedArtifactIds = Object.values(storedArtifacts).map(
    (artifact) => artifact.id
  );
  const deployedAt = Date.parse(storedRuns.deploy.completedAt);
  const postDeployRuns = [
    storedRuns.hostedDast,
    storedRuns.managedMcp,
    storedRuns.recovery,
  ];
  const expectedArtifactRuns: Array<
    [keyof DemoVideoArtifactSelections, StoredRunSelection]
  > = [
    ["hostedDast", storedRuns.hostedDast],
    ["hostedDastZap", storedRuns.hostedDast],
    ["managedMcp", storedRuns.managedMcp],
    ["recoveryStaging", storedRuns.recovery],
    ["recoveryProduction", storedRuns.recovery],
  ];
  if (
    new Set(selectedRunIds).size !== selectedRunIds.length ||
    new Set(selectedArtifactIds).size !== selectedArtifactIds.length ||
    deployedAt > now + CLOCK_SKEW_MS ||
    now - deployedAt > MAXIMUM_AGE_MS ||
    postDeployRuns.some((run) => {
      const completedAt = Date.parse(run.completedAt);
      return (
        completedAt <= deployedAt ||
        completedAt > now + CLOCK_SKEW_MS ||
        now - completedAt > MAXIMUM_AGE_MS
      );
    }) ||
    expectedArtifactRuns.some(([key, run]) => {
      const artifact = storedArtifacts[key];
      const createdAt = Date.parse(artifact.createdAt);
      const updatedAt = Date.parse(artifact.updatedAt);
      const runCompletedAt = Date.parse(run.completedAt);
      return (
        artifact.workflowRunId !== run.id ||
        artifact.headSha !== expected.sha ||
        createdAt > runCompletedAt + CLOCK_SKEW_MS ||
        updatedAt > runCompletedAt + CLOCK_SKEW_MS ||
        updatedAt > now + CLOCK_SKEW_MS ||
        now - createdAt > MAXIMUM_AGE_MS ||
        now - updatedAt > MAXIMUM_AGE_MS
      );
    }) ||
    storedArtifacts.hostedDast.name !==
      `hosted-dast-${expected.sha}-${storedRuns.deploy.id}-` +
        `${storedRuns.deploy.attempt}-${storedRuns.hostedDast.attempt}` ||
    storedArtifacts.hostedDastZap.name !==
      `zap-baseline-${expected.sha}-${storedRuns.hostedDast.attempt}` ||
    storedArtifacts.managedMcp.name !==
      `managed-mcp-proof-${storedRuns.managedMcp.id}-` +
        `${storedRuns.managedMcp.attempt}` ||
    storedArtifacts.recoveryStaging.name !==
      `staging-cloudformation-controls-audit-${storedRuns.recovery.id}-` +
        `${storedRuns.recovery.attempt}` ||
    storedArtifacts.recoveryProduction.name !==
      `production-cloudformation-controls-audit-${storedRuns.recovery.id}-` +
        `${storedRuns.recovery.attempt}`
  ) {
    throw new Error(
      "Initial demo-video artifact bindings are malformed or inconsistent"
    );
  }
  return receipt as unknown as DemoVideoReleaseBindingReceipt;
}

function canonicalJson(value: unknown): string {
  const normalize: (candidate: unknown) => unknown = (candidate) => {
    if (Array.isArray(candidate)) {
      return candidate.map(normalize);
    }
    const record = asRecord(candidate);
    if (!record) return candidate;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, normalize(record[key])])
    );
  };
  return JSON.stringify(normalize(value));
}

export function requireUnchangedSelections(
  stored: DemoVideoReleaseBindingReceipt,
  currentRuns: DemoVideoRunSelections,
  currentArtifacts: DemoVideoArtifactSelections
): void {
  if (
    canonicalJson(stored.selectedRuns) !== canonicalJson(currentRuns) ||
    canonicalJson(stored.selectedArtifacts) !==
      canonicalJson(currentArtifacts)
  ) {
    throw new Error(
      "Exact release evidence selection changed during demo-video production"
    );
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  label: string,
  timeoutMs = 45_000
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`${label} returned HTTP ${response.status}`);
    }
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

async function githubJson(
  path: string,
  token: string,
  label: string
): Promise<unknown> {
  const response = await fetchWithTimeout(
    `https://api.github.com${path}`,
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "archon-demo-video-release-gate",
        "x-github-api-version": "2022-11-28",
      },
    },
    label
  );
  if (
    !/^application\/json(?:;|$)/iu.test(
      response.headers.get("content-type") ?? ""
    )
  ) {
    throw new Error(`${label} did not return JSON`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`${label} returned malformed JSON`);
  }
}

async function publicProof(sha: string): Promise<CanonicalProofSummary> {
  const expectedUrl = `${DEMO_ORIGIN}/api/proof`;
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetchWithTimeout(
        expectedUrl,
        {
          headers: {
            accept: "application/json",
            "cache-control": "no-cache",
          },
        },
        "Canonical public production proof",
        30_000
      );
      if (
        !validLiveResponseMetadata(
          response.url,
          expectedUrl,
          response.headers.get("content-type") ?? "",
          response.headers.get("cache-control") ?? ""
        )
      ) {
        throw new Error(
          "Public proof redirected or omitted its JSON/no-store boundary"
        );
      }
      const contentLength = Number(
        response.headers.get("content-length") ?? "0"
      );
      if (
        contentLength !== 0 &&
        (!Number.isSafeInteger(contentLength) ||
          contentLength < 2 ||
          contentLength > 131_072)
      ) {
        throw new Error("Public proof content length is invalid");
      }
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > 131_072) {
        throw new Error("Public proof payload is too large");
      }
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        throw new Error("Public proof returned malformed JSON");
      }
      return requireCanonicalPublicProof(value, sha);
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise((accept) =>
          setTimeout(accept, attempt * 1_000)
        );
      }
    }
  }
  throw lastError;
}

function workflowRunsPath(
  workflow: string,
  event: string,
  sha: string
): string {
  return (
    `/repos/${REPOSITORY}/actions/workflows/${workflow}/runs` +
    `?head_sha=${encodeURIComponent(sha)}` +
    `&event=${encodeURIComponent(event)}&per_page=100`
  );
}

async function collectEvidence(
  token: string,
  sha: string,
  now = Date.now()
): Promise<EvidenceBundle> {
  const [ci, codeql, deploy, dast, mcp, recovery] = await Promise.all([
    githubJson(
      workflowRunsPath("ci.yml", "push", sha),
      token,
      "Exact-SHA CI runs"
    ),
    githubJson(
      workflowRunsPath("codeql.yml", "push", sha),
      token,
      "Exact-SHA CodeQL runs"
    ),
    githubJson(
      workflowRunsPath("deploy-aws.yml", "workflow_run", sha),
      token,
      "Exact-SHA Deploy AWS runs"
    ),
    githubJson(
      workflowRunsPath("security-dast.yml", "workflow_run", sha),
      token,
      "Exact-SHA Hosted DAST runs"
    ),
    githubJson(
      workflowRunsPath("managed-mcp-audit.yml", "workflow_dispatch", sha),
      token,
      "Exact-SHA standalone Managed MCP runs"
    ),
    githubJson(
      workflowRunsPath("recover-aws.yml", "workflow_dispatch", sha),
      token,
      "Exact-SHA manual Recover AWS runs"
    ),
  ]);
  const runs = selectReleaseEvidenceRuns(
    {
      ci: parseWorkflowRuns(ci),
      codeql: parseWorkflowRuns(codeql),
      deploy: parseWorkflowRuns(deploy),
      dast: parseWorkflowRuns(dast),
      mcp: parseWorkflowRuns(mcp),
      recovery: parseWorkflowRuns(recovery),
    },
    sha
  );
  requireFreshPostDeployTiming(runs, now);

  const [
    deployJobs,
    dastJobs,
    mcpJobs,
    recoveryJobs,
    dastArtifacts,
    mcpArtifacts,
    recoveryArtifacts,
  ] = await Promise.all([
    githubJson(
      `/repos/${REPOSITORY}/actions/runs/${runs.deploy.id}/attempts/${runs.deploy.run_attempt}/jobs?per_page=100`,
      token,
      "Attempt-specific Deploy AWS jobs"
    ),
    githubJson(
      `/repos/${REPOSITORY}/actions/runs/${runs.dast.id}/attempts/${runs.dast.run_attempt}/jobs?per_page=100`,
      token,
      "Attempt-specific Hosted DAST jobs"
    ),
    githubJson(
      `/repos/${REPOSITORY}/actions/runs/${runs.mcp.id}/attempts/${runs.mcp.run_attempt}/jobs?per_page=100`,
      token,
      "Attempt-specific standalone Managed MCP jobs"
    ),
    githubJson(
      `/repos/${REPOSITORY}/actions/runs/${runs.recovery.id}/attempts/${runs.recovery.run_attempt}/jobs?per_page=100`,
      token,
      "Attempt-specific manual recovery jobs"
    ),
    githubJson(
      `/repos/${REPOSITORY}/actions/runs/${runs.dast.id}/artifacts?per_page=100`,
      token,
      "Exact Hosted DAST artifacts"
    ),
    githubJson(
      `/repos/${REPOSITORY}/actions/runs/${runs.mcp.id}/artifacts?per_page=100`,
      token,
      "Exact standalone Managed MCP artifacts"
    ),
    githubJson(
      `/repos/${REPOSITORY}/actions/runs/${runs.recovery.id}/artifacts?per_page=100`,
      token,
      "Exact manual recovery artifacts"
    ),
  ]);

  requireDemoVideoDeployContract(deployJobs, runs.deploy.id, sha);
  requireSuccessfulHostedDastJobs(dastJobs, runs.dast.id, sha);
  requireManagedMcpJobContract(mcpJobs, runs.mcp.id, sha);
  requireDemoVideoRecoveryContract(recoveryJobs, runs.recovery.id, sha);

  const dastReceiptName =
    `hosted-dast-${sha}-${runs.deploy.id}-${runs.deploy.run_attempt}-` +
    `${runs.dast.run_attempt}`;
  const dastZapName = `zap-baseline-${sha}-${runs.dast.run_attempt}`;
  const mcpReceiptName =
    `managed-mcp-proof-${runs.mcp.id}-${runs.mcp.run_attempt}`;
  const recoveryStagingName =
    `staging-cloudformation-controls-audit-${runs.recovery.id}-` +
    `${runs.recovery.run_attempt}`;
  const recoveryProductionName =
    `production-cloudformation-controls-audit-${runs.recovery.id}-` +
    `${runs.recovery.run_attempt}`;
  const priorDastNames = Array.from(
    { length: Math.max(0, runs.dast.run_attempt - 1) },
    (_, index) => {
      const attempt = index + 1;
      return [
        `hosted-dast-${sha}-${runs.deploy.id}-` +
          `${runs.deploy.run_attempt}-${attempt}`,
        `zap-baseline-${sha}-${attempt}`,
      ];
    }
  ).flat();
  const priorMcpNames = Array.from(
    { length: Math.max(0, runs.mcp.run_attempt - 1) },
    (_, index) => `managed-mcp-proof-${runs.mcp.id}-${index + 1}`
  );
  const priorRecoveryNames = Array.from(
    { length: Math.max(0, runs.recovery.run_attempt - 1) },
    (_, index) => {
      const attempt = index + 1;
      return [
        `staging-cloudformation-controls-audit-${runs.recovery.id}-${attempt}`,
        `production-cloudformation-controls-audit-${runs.recovery.id}-${attempt}`,
      ];
    }
  ).flat();

  const selectedDastArtifacts = selectExactArtifactInventory(
    dastArtifacts,
    [dastReceiptName, dastZapName],
    runs.dast,
    now,
    priorDastNames,
    100_000_000
  );
  const selectedMcpArtifacts = selectExactArtifactInventory(
    mcpArtifacts,
    [mcpReceiptName],
    runs.mcp,
    now,
    priorMcpNames
  );
  const selectedRecoveryArtifacts = selectExactArtifactInventory(
    recoveryArtifacts,
    [recoveryStagingName, recoveryProductionName],
    runs.recovery,
    now,
    priorRecoveryNames
  );
  const artifacts: SelectedEvidenceArtifacts = {
    dastReceipt: selectedDastArtifacts[dastReceiptName]!,
    dastZap: selectedDastArtifacts[dastZapName]!,
    mcpReceipt: selectedMcpArtifacts[mcpReceiptName]!,
    recoveryStaging: selectedRecoveryArtifacts[recoveryStagingName]!,
    recoveryProduction: selectedRecoveryArtifacts[recoveryProductionName]!,
  };
  return { runs, artifacts };
}

export function readInitialReceipt(
  path: string,
  expected: {
    sha: string;
    runId: number;
    runAttempt: number;
    now?: number;
  }
): DemoVideoReleaseBindingReceipt {
  if (
    typeof fsConstants.O_NOFOLLOW !== "number" ||
    fsConstants.O_NOFOLLOW === 0
  ) {
    throw new Error("This runner cannot enforce no-follow receipt reads");
  }
  let descriptor: number;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
    );
  } catch {
    throw new Error(
      "Initial release binding could not be opened without following links"
    );
  }
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.size < 2n || before.size > 131_072n) {
      throw new Error("Initial release binding must be a small regular file");
    }
    const source = readFileSync(descriptor, "utf8");
    const after = fstatSync(descriptor, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      BigInt(Buffer.byteLength(source, "utf8")) !== after.size
    ) {
      throw new Error("Initial release binding changed while being read");
    }
    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch {
      throw new Error("Initial release binding is not valid JSON");
    }
    return requireStoredReleaseBinding(value, expected);
  } finally {
    closeSync(descriptor);
  }
}

function encodeReceiptHandoff(
  receipt: DemoVideoReleaseBindingReceipt
): string {
  const source = `${JSON.stringify(receipt, null, 2)}\n`;
  const bytes = Buffer.byteLength(source, "utf8");
  if (bytes < 2 || bytes > 131_072) {
    throw new Error("Release binding handoff is outside its byte boundary");
  }
  return Buffer.from(source, "utf8").toString("base64");
}

function emitOutputs(
  outputPath: string,
  runs: SelectedEvidenceRuns,
  artifacts: SelectedEvidenceArtifacts
): void {
  const outputs: Record<string, number> = {
    ci_run_id: runs.ci.id,
    ci_run_attempt: runs.ci.run_attempt,
    codeql_run_id: runs.codeql.id,
    codeql_run_attempt: runs.codeql.run_attempt,
    deploy_run_id: runs.deploy.id,
    deploy_run_attempt: runs.deploy.run_attempt,
    dast_run_id: runs.dast.id,
    dast_run_attempt: runs.dast.run_attempt,
    mcp_run_id: runs.mcp.id,
    mcp_run_attempt: runs.mcp.run_attempt,
    recovery_run_id: runs.recovery.id,
    recovery_run_attempt: runs.recovery.run_attempt,
    dast_receipt_artifact_id: artifacts.dastReceipt.id,
    dast_zap_artifact_id: artifacts.dastZap.id,
    mcp_receipt_artifact_id: artifacts.mcpReceipt.id,
    recovery_staging_artifact_id: artifacts.recoveryStaging.id,
    recovery_production_artifact_id: artifacts.recoveryProduction.id,
  };
  appendFileSync(
    outputPath,
    Object.entries(outputs)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
    "utf8"
  );
}

function loadInvocation(): Invocation {
  const phase = parseDemoVideoPhase(requireEnvironment("DEMO_VIDEO_PHASE"));
  if (!phase) throw new Error("DEMO_VIDEO_PHASE must be initial or terminal");
  const sha = requireEnvironment("DEMO_VIDEO_EXPECTED_SHA");
  const repository = requireEnvironment("GITHUB_REPOSITORY");
  const runId = requirePositiveInteger(
    requireEnvironment("GITHUB_RUN_ID"),
    "GITHUB_RUN_ID"
  );
  const runAttempt = requirePositiveInteger(
    requireEnvironment("GITHUB_RUN_ATTEMPT"),
    "GITHUB_RUN_ATTEMPT"
  );
  const sourceGateRunAttempt = requirePositiveInteger(
    requireEnvironment("DEMO_VIDEO_SOURCE_GATE_ATTEMPT"),
    "DEMO_VIDEO_SOURCE_GATE_ATTEMPT"
  );
  if (
    sourceGateRunAttempt > runAttempt ||
    (phase === "initial" && sourceGateRunAttempt !== runAttempt)
  ) {
    throw new Error(
      "Demo-video source-gate artifact attempt is not valid for this phase"
    );
  }
  requireTrustedWorkflowInvocation({
    repository,
    eventName: process.env.GITHUB_EVENT_NAME,
    ref: process.env.GITHUB_REF,
    workflowRef: process.env.GITHUB_WORKFLOW_REF,
    githubSha: process.env.GITHUB_SHA,
    expectedSha: sha,
    runId,
    runAttempt,
  });
  const receiptPath = requireRunnerTempReceiptPath(
    requireEnvironment("RUNNER_TEMP"),
    requireEnvironment("DEMO_VIDEO_RELEASE_RECEIPT")
  );
  return {
    phase,
    sha,
    token: requireEnvironment("GITHUB_TOKEN"),
    repository: repository as typeof REPOSITORY,
    runId,
    runAttempt,
    sourceGateRunAttempt,
    receiptPath,
    outputPath: requireEnvironment("GITHUB_OUTPUT"),
  };
}

async function main(): Promise<void> {
  const invocation = loadInvocation();
  const checkedOutHead = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
  if (checkedOutHead !== invocation.sha) {
    throw new Error("Checked-out HEAD differs from the expected release SHA");
  }

  const currentRun = await githubJson(
    `/repos/${REPOSITORY}/actions/runs/${invocation.runId}`,
    invocation.token,
    "Current demo-video workflow run"
  );
  requireCurrentWorkflowRun(currentRun, {
    id: invocation.runId,
    attempt: invocation.runAttempt,
    sha: invocation.sha,
  });

  const mainAtStart = exactMainSha(
    await githubJson(
      `/repos/${REPOSITORY}/git/ref/heads/main`,
      invocation.token,
      "GitHub main ref at demo-video gate start"
    )
  );
  if (mainAtStart !== invocation.sha) {
    throw new Error("Expected demo-video release is no longer current main");
  }

  const initialReceipt =
    invocation.phase === "terminal"
      ? readInitialReceipt(invocation.receiptPath, {
          sha: invocation.sha,
          runId: invocation.runId,
          runAttempt: invocation.sourceGateRunAttempt,
        })
      : undefined;
  const now = Date.now();
  const evidence = await collectEvidence(
    invocation.token,
    invocation.sha,
    now
  );
  const selectedRuns = storeRunSelections(evidence.runs);
  const selectedArtifacts = storeArtifactSelections(evidence.artifacts);
  if (initialReceipt) {
    requireUnchangedSelections(
      initialReceipt,
      selectedRuns,
      selectedArtifacts
    );
  }
  const proof = await publicProof(invocation.sha);
  if (initialReceipt) {
    requireEquivalentCanonicalProof(initialReceipt.liveProof, proof);
  }

  const mainAtFinish = exactMainSha(
    await githubJson(
      `/repos/${REPOSITORY}/git/ref/heads/main`,
      invocation.token,
      "GitHub main ref at demo-video gate finish"
    )
  );
  if (mainAtFinish !== mainAtStart || mainAtFinish !== invocation.sha) {
    throw new Error("Main moved while the demo-video release gate was running");
  }

  // The initial receipt is hashed into the media receipts. Terminal phases
  // therefore revalidate it in place and must never rewrite even one byte.
  let receiptHandoff = "";
  if (!initialReceipt) {
    const receipt: DemoVideoReleaseBindingReceipt = {
      schema: "archon.demo-video-release-binding",
      version: 1,
      repository: REPOSITORY,
      ref: "refs/heads/main",
      releaseSha: invocation.sha,
      demoUrl: DEMO_ORIGIN,
      sourceGateRunId: invocation.runId,
      sourceGateRunAttempt: invocation.sourceGateRunAttempt,
      passed: true,
      selectedRuns,
      selectedArtifacts,
      liveProof: proof,
      checks: DEMO_VIDEO_CHECK_IDS.map(
        (id): DemoVideoGateCheck => ({ id, status: "pass" })
      ),
    };
    const validatedReceipt = requireStoredReleaseBinding(receipt, {
      sha: invocation.sha,
      runId: invocation.runId,
      runAttempt: invocation.sourceGateRunAttempt,
    });
    receiptHandoff = encodeReceiptHandoff(validatedReceipt);
  }
  emitOutputs(invocation.outputPath, evidence.runs, evidence.artifacts);
  console.error(
    `Demo-video release gate ${invocation.phase} PASS: ` +
      `SHA ${invocation.sha}; deploy ${evidence.runs.deploy.id}/` +
      `${evidence.runs.deploy.run_attempt}; DAST ${evidence.runs.dast.id}; ` +
      `MCP ${evidence.runs.mcp.id}; recovery ${evidence.runs.recovery.id}`
  );
  if (receiptHandoff !== "") {
    process.stdout.write(receiptHandoff);
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
const isMain = invokedPath === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error: unknown) => {
    console.error(`Demo-video release gate failed: ${safeError(error)}`);
    process.exitCode = 1;
  });
}
