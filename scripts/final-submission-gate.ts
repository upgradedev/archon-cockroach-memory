// Read-only, hosted boundary for the final Devpost handoff. This script is
// intentionally network-aware and must run only from the manually dispatched
// Submission readiness workflow on the exact current main commit. It writes one
// sanitized receipt under RUNNER_TEMP and never receives AWS credentials.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluate,
  parseCanonicalSubmissionVideoUrl,
  SUBMISSION_THUMBNAIL_PATH,
  validDevpostSubmissionUrl,
  validSubmissionThumbnail,
  validSubmissionVideoDuration,
} from "./readiness.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY = "upgradedev/archon-cockroach-memory";
const DEMO_URL = "https://d2s5v0o0eg2aaw.cloudfront.net";
const REPOSITORY_URL =
  "https://github.com/upgradedev/archon-cockroach-memory";
const WORKFLOW_REF =
  `${REPOSITORY}/.github/workflows/submission-readiness.yml@refs/heads/main`;
const RECALL_QUESTION =
  "What was the true employer cost and the off-bank wedge?";

type GatePhase = "pre-submit" | "post-submit";
type CheckStatus = "pass" | "fail";

interface GateCheck {
  id: string;
  status: CheckStatus;
  detail: string;
}

export interface GitHubWorkflowRun {
  id: number;
  name: string;
  display_title: string;
  path: string;
  event: string;
  head_branch: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  run_attempt: number;
  html_url: string;
  run_started_at: string;
  updated_at: string;
}

interface SelectedRun {
  id: number;
  attempt: number;
  url: string;
  workflowPath: string;
  event: string;
  startedAt: string;
  completedAt: string;
}

interface GitHubWorkflowStep {
  name: string;
  status: string;
  conclusion: string | null;
}

interface GitHubWorkflowJob {
  id: number;
  run_id: number;
  head_sha: string;
  name: string;
  status: string;
  conclusion: string | null;
  steps: GitHubWorkflowStep[];
}

interface VideoReceipt {
  provider: "youtube" | "vimeo";
  id: string;
  url: string;
  durationSeconds: number;
  durationSource: "vimeo-oembed" | "operator-attested";
  oembedVerified: boolean;
  publicEmbeddableAttested: true;
  englishCaptionsAttested: true;
}

interface ThumbnailReceipt {
  path: string;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
}

interface SubmissionReceipt {
  schema: "archon.submission-readiness";
  version: 1;
  generatedAt: string;
  phase: GatePhase | "invalid";
  repository: string;
  commitSha: string;
  passed: boolean;
  checks: GateCheck[];
  selectedRuns: Record<string, SelectedRun>;
  live: Record<string, boolean>;
  video?: VideoReceipt;
  thumbnail?: ThumbnailReceipt;
  devpostUrl?: string;
  sourceGate?: {
    passed: boolean;
    pct: number;
  };
  eligibility?: {
    complete: number;
    total: number;
    passed: boolean;
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.map(asRecord).filter(
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

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown failure";
  return message
    .replace(/Bearer\s+\S+/giu, "Bearer [redacted]")
    .replace(/token[=:]\S+/giu, "token=[redacted]")
    .slice(0, 500);
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
      signal: controller.signal,
      redirect: "follow",
    });
    if (!response.ok) {
      throw new Error(`${label} returned HTTP ${response.status}`);
    }
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(
  url: string,
  init: RequestInit,
  label: string,
  timeoutMs?: number
): Promise<unknown> {
  const response = await fetchWithTimeout(url, init, label, timeoutMs);
  try {
    return await response.json();
  } catch {
    throw new Error(`${label} did not return JSON`);
  }
}

async function fetchLiveJson(
  path: string,
  init: RequestInit,
  label: string,
  timeoutMs = 30_000
): Promise<Record<string, unknown>> {
  let lastError: unknown;
  const expectedUrl = `${DEMO_URL}${path}`;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetchWithTimeout(
        expectedUrl,
        init,
        label,
        timeoutMs
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
          `${label} redirected or omitted its JSON/no-store contract`
        );
      }
      const body = await response.json();
      const record = asRecord(body);
      if (!record) throw new Error(`${label} returned a non-object payload`);
      return record;
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

export function validLiveResponseMetadata(
  responseUrl: string,
  expectedUrl: string,
  contentType: string,
  cacheControl: string
): boolean {
  return (
    responseUrl === expectedUrl &&
    /^application\/json(?:;|$)/iu.test(contentType) &&
    cacheControl
      .split(",")
      .map((directive) => directive.trim().toLowerCase())
      .includes("no-store")
  );
}

export function exactPublicScope(value: unknown): boolean {
  const scope = asRecord(value);
  return (
    scope?.tenantId === "public-demo" &&
    scope?.company === "Helios SA" &&
    scope?.mode === "fixed-synthetic-demo" &&
    scope?.access === "read-only" &&
    scope?.dataClassification === "synthetic-public-demo" &&
    scope?.source === "server-configured" &&
    Object.keys(scope).length === 6
  );
}

export function exactSequentialCitationMarkers(
  markers: unknown[]
): boolean {
  return (
    markers.length >= 1 &&
    markers.length <= 5 &&
    markers.every(
      (marker, index) =>
        marker === `[${index + 1}]`
    )
  );
}

export function requireFreshGeneratedAt(
  record: Record<string, unknown>,
  label: string,
  now = Date.now()
): void {
  const generatedAt = stringValue(record, "generatedAt") ?? "";
  const timestamp = Date.parse(generatedAt);
  if (
    Number.isNaN(timestamp) ||
    timestamp > now + 2 * 60 * 1_000 ||
    now - timestamp > 5 * 60 * 1_000
  ) {
    throw new Error(`${label} generatedAt is missing or stale`);
  }
}

async function githubJson(
  path: string,
  token: string,
  label: string
): Promise<unknown> {
  return fetchJson(
    `https://api.github.com${path}`,
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "archon-submission-readiness",
        "x-github-api-version": "2022-11-28",
      },
    },
    label
  );
}

function requireString(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parsePhase(value: string | undefined): GatePhase | undefined {
  return value === "pre-submit" || value === "post-submit"
    ? value
    : undefined;
}

export function expectedPreSubmitDisplayTitle(
  sha: string,
  videoUrl: string | undefined,
  durationSeconds: string | undefined
): string {
  return `Submission readiness / pre-submit / ${sha} / ${videoUrl} / ${durationSeconds}s`;
}

export function parseWorkflowRuns(value: unknown): GitHubWorkflowRun[] {
  const root = asRecord(value);
  return asRecords(root?.workflow_runs)
    .map((run) => ({
      id: numberValue(run, "id") ?? 0,
      name: stringValue(run, "name") ?? "",
      display_title: stringValue(run, "display_title") ?? "",
      path: stringValue(run, "path") ?? "",
      event: stringValue(run, "event") ?? "",
      head_branch: stringValue(run, "head_branch") ?? "",
      head_sha: stringValue(run, "head_sha") ?? "",
      status: stringValue(run, "status") ?? "",
      conclusion:
        run.conclusion === null
          ? null
          : stringValue(run, "conclusion") ?? null,
      run_attempt: numberValue(run, "run_attempt") ?? 0,
      html_url: stringValue(run, "html_url") ?? "",
      run_started_at: stringValue(run, "run_started_at") ?? "",
      updated_at: stringValue(run, "updated_at") ?? "",
    }))
    .filter(
      (run) =>
        Number.isSafeInteger(run.id) &&
        run.id > 0 &&
        Number.isSafeInteger(run.run_attempt) &&
        run.run_attempt > 0 &&
        /^https:\/\/github\.com\/upgradedev\/archon-cockroach-memory\/actions\/runs\/[0-9]+$/u.test(
          run.html_url
        ) &&
        !Number.isNaN(Date.parse(run.run_started_at)) &&
        !Number.isNaN(Date.parse(run.updated_at))
    );
}

function parseWorkflowRun(value: unknown): GitHubWorkflowRun | undefined {
  return parseWorkflowRuns({ workflow_runs: [value] })[0];
}

export function selectSuccessfulRun(
  runs: GitHubWorkflowRun[],
  name: string,
  event: string,
  sha: string,
  workflowPath: string
): GitHubWorkflowRun {
  const candidates = runs
    .filter(
      (run) =>
        run.event === event &&
        run.head_branch === "main" &&
        run.head_sha === sha &&
        run.path === workflowPath
    )
    .sort(
      (left, right) =>
        Date.parse(right.run_started_at) -
          Date.parse(left.run_started_at) ||
        right.id - left.id
    );
  const selected = candidates[0];
  if (
    !selected ||
    selected.name !== name ||
    selected.status !== "completed" ||
    selected.conclusion !== "success"
  ) {
    throw new Error(
      `The latest ${name} ${event} run is not successful for the exact commit`
    );
  }
  return selected;
}

function toSelectedRun(run: GitHubWorkflowRun): SelectedRun {
  return {
    id: run.id,
    attempt: run.run_attempt,
    url: run.html_url,
    workflowPath: run.path,
    event: run.event,
    startedAt: run.run_started_at,
    completedAt: run.updated_at,
  };
}

export function parseWorkflowJobs(value: unknown): {
  totalCount: number;
  jobs: GitHubWorkflowJob[];
} {
  const root = asRecord(value);
  const totalCount = numberValue(root, "total_count") ?? -1;
  const jobs = asRecords(root?.jobs)
    .map((job) => ({
      id: numberValue(job, "id") ?? 0,
      run_id: numberValue(job, "run_id") ?? 0,
      head_sha: stringValue(job, "head_sha") ?? "",
      name: stringValue(job, "name") ?? "",
      status: stringValue(job, "status") ?? "",
      conclusion:
        job.conclusion === null
          ? null
          : stringValue(job, "conclusion") ?? null,
      steps: asRecords(job.steps).map((step) => ({
        name: stringValue(step, "name") ?? "",
        status: stringValue(step, "status") ?? "",
        conclusion:
          step.conclusion === null
            ? null
            : stringValue(step, "conclusion") ?? null,
      })),
    }))
    .filter(
      (job) =>
        Number.isSafeInteger(job.id) &&
        job.id > 0 &&
        Number.isSafeInteger(job.run_id) &&
        job.run_id > 0 &&
        /^[0-9a-f]{40}$/u.test(job.head_sha)
    );
  return { totalCount, jobs };
}

export function requireSuccessfulRecoveryAuditJobs(
  value: unknown,
  runId: number,
  sha: string
): void {
  const { totalCount, jobs } = parseWorkflowJobs(value);
  const expected = [
    {
      job: "Recover unresolved staging delivery",
      audit: "Run the daily staging protection and drift audit",
      upload: "Upload staging daily protection and drift audit",
    },
    {
      job: "Recover unresolved production delivery",
      audit: "Run the daily production protection and drift audit",
      upload: "Upload production daily protection and drift audit",
    },
  ] as const;
  if (totalCount !== expected.length || jobs.length !== expected.length) {
    throw new Error("Recovery audit must contain exactly two successful jobs");
  }
  for (const contract of expected) {
    const matches = jobs.filter((job) => job.name === contract.job);
    const job = matches[0];
    if (
      matches.length !== 1 ||
      !job ||
      job.run_id !== runId ||
      job.head_sha !== sha ||
      job.status !== "completed" ||
      job.conclusion !== "success"
    ) {
      throw new Error(`${contract.job} did not complete successfully`);
    }
    for (const stepName of [contract.audit, contract.upload]) {
      const steps = job.steps.filter((step) => step.name === stepName);
      if (
        steps.length !== 1 ||
        steps[0]?.status !== "completed" ||
        steps[0]?.conclusion !== "success"
      ) {
        throw new Error(`${stepName} did not execute successfully`);
      }
    }
  }
}

export function requirePostDeployAuditTiming(
  deployRun: GitHubWorkflowRun,
  mcpRun: GitHubWorkflowRun,
  recoveryRun: GitHubWorkflowRun,
  now = Date.now()
): void {
  const deployedStartedAt = Date.parse(deployRun.run_started_at);
  const deployedAt = Date.parse(deployRun.updated_at);
  const mcpStartedAt = Date.parse(mcpRun.run_started_at);
  const recoveryStartedAt = Date.parse(recoveryRun.run_started_at);
  if (
    ![
      deployedStartedAt,
      deployedAt,
      mcpStartedAt,
      recoveryStartedAt,
      now,
    ].every(Number.isFinite) ||
    deployedAt < deployedStartedAt ||
    mcpStartedAt <= deployedAt ||
    recoveryStartedAt <= deployedAt
  ) {
    throw new Error(
      "Deploy timing must be valid and both audits must start after deploy completes"
    );
  }
  const maximumAuditAgeMs = 24 * 60 * 60 * 1_000;
  for (const [label, run] of [
    ["Managed MCP", mcpRun],
    ["recovery", recoveryRun],
  ] as const) {
    const startedAt = Date.parse(run.run_started_at);
    const completedAt = Date.parse(run.updated_at);
    if (
      !Number.isFinite(startedAt) ||
      !Number.isFinite(completedAt) ||
      completedAt < startedAt ||
      completedAt > now + 5 * 60 * 1_000 ||
      now - completedAt > maximumAuditAgeMs
    ) {
      throw new Error(`${label} audit must have completed within 24 hours`);
    }
  }
}

function exactMainSha(value: unknown): string {
  const root = asRecord(value);
  const object = asRecord(root?.object);
  const sha = stringValue(object, "sha");
  if (!sha || !/^[0-9a-f]{40}$/u.test(sha)) {
    throw new Error("GitHub main ref did not return an exact commit SHA");
  }
  return sha;
}

type SubmissionVideoIdentity = NonNullable<
  ReturnType<typeof parseCanonicalSubmissionVideoUrl>
>;

export function validOembedContract(
  value: unknown,
  identity: SubmissionVideoIdentity
): boolean {
  const oembed = asRecord(value);
  if (!oembed) return false;
  const html = stringValue(oembed, "html") ?? "";
  return (
    /Archon Memory/iu.test(stringValue(oembed, "title") ?? "") &&
    oembed.type === "video" &&
    oembed.provider_name ===
      (identity.provider === "youtube" ? "YouTube" : "Vimeo") &&
    html.includes("<iframe") &&
    html.includes(identity.id) &&
    (identity.provider === "youtube"
      ? /(?:www\.)?youtube\.com\/embed\//iu.test(html)
      : /player\.vimeo\.com\/video\//iu.test(html))
  );
}

export function validDevpostPageContract(
  html: string,
  responseUrl: string,
  requestedUrl: string,
  contentType: string,
  identity: SubmissionVideoIdentity
): boolean {
  const normalizedHtml = html
    .replace(/&amp;|&#38;|&#x26;/giu, "&")
    .replace(/&#47;|&#x2f;/giu, "/")
    .replace(/&times;|&#215;|&#x[dD]7;/giu, "×");
  const challengeAnchor =
    /<a\b[^>]*\bhref=["']https:\/\/cockroachdb-ai\.devpost\.com\/?(?:[^"']*)["'][^>]*>/iu;
  const repositoryAnchor =
    /<a\b[^>]*\bhref=["']https:\/\/github\.com\/upgradedev\/archon-cockroach-memory\/?["'][^>]*>/iu;
  const demoAnchor =
    /<a\b[^>]*\bhref=["']https:\/\/d2s5v0o0eg2aaw\.cloudfront\.net\/?["'][^>]*>/iu;
  return (
    responseUrl === requestedUrl &&
    /^text\/html(?:;|$)/iu.test(contentType) &&
    /Archon Memory/iu.test(normalizedHtml) &&
    challengeAnchor.test(normalizedHtml) &&
    /CockroachDB × AWS Hackathon - Build with Agentic Memory/iu.test(
      normalizedHtml
    ) &&
    repositoryAnchor.test(normalizedHtml) &&
    demoAnchor.test(normalizedHtml) &&
    normalizedHtml.includes(identity.id) &&
    (identity.provider === "youtube"
      ? /(?:www\.)?youtube\.com|youtu\.be/iu.test(normalizedHtml)
      : /(?:player\.)?vimeo\.com/iu.test(normalizedHtml))
  );
}

async function main(): Promise<void> {
  const checks: GateCheck[] = [];
  const selectedRuns: Record<string, SelectedRun> = {};
  const live: Record<string, boolean> = {};
  const sha = process.env.GITHUB_SHA ?? "";
  const phase = parsePhase(process.env.SUBMISSION_PHASE);
  let video: VideoReceipt | undefined;
  let thumbnail: ThumbnailReceipt | undefined;
  let devpostUrl: string | undefined;
  let readiness: ReturnType<typeof evaluate> | undefined;

  const check = async (
    id: string,
    task: () => string | Promise<string>
  ): Promise<boolean> => {
    try {
      const detail = await task();
      checks.push({ id, status: "pass", detail });
      return true;
    } catch (error) {
      checks.push({ id, status: "fail", detail: safeError(error) });
      return false;
    }
  };

  const token = process.env.GITHUB_TOKEN ?? "";
  const exactShaWorkflowRuns = async (
    workflow: string,
    event: string,
    label: string
  ): Promise<GitHubWorkflowRun[]> =>
    parseWorkflowRuns(
      await githubJson(
        `/repos/${REPOSITORY}/actions/workflows/${workflow}/runs?head_sha=${sha}&event=${event}&per_page=100`,
        token,
        label
      )
    );

  await check("trusted-workflow-identity", () => {
    if (
      process.env.GITHUB_REPOSITORY !== REPOSITORY ||
      process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
      process.env.GITHUB_REF !== "refs/heads/main" ||
      process.env.GITHUB_WORKFLOW_REF !== WORKFLOW_REF ||
      !/^[0-9a-f]{40}$/u.test(sha) ||
      !phase
    ) {
      throw new Error("Workflow identity, phase, ref, or commit is invalid");
    }
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim();
    if (head !== sha) throw new Error("Checked-out HEAD differs from GITHUB_SHA");
    return `Trusted manual ${phase} gate at ${sha}`;
  });

  let mainAtStart = "";
  await check("current-main-at-start", async () => {
    if (!token) throw new Error("GITHUB_TOKEN is required");
    mainAtStart = exactMainSha(
      await githubJson(
        `/repos/${REPOSITORY}/git/ref/heads/main`,
        token,
        "GitHub main ref"
      )
    );
    if (mainAtStart !== sha) {
      throw new Error("The dispatched commit is not the current main head");
    }
    return `Current main is ${sha}`;
  });

  await check("public-repository-contract", async () => {
    const repository = asRecord(
      await githubJson(
        `/repos/${REPOSITORY}`,
        token,
        "GitHub repository metadata"
      )
    );
    const license = asRecord(repository?.license);
    if (
      !repository ||
      repository.private !== false ||
      repository.archived !== false ||
      repository.disabled !== false ||
      repository.fork !== false ||
      repository.default_branch !== "main" ||
      repository.homepage !== DEMO_URL ||
      stringValue(license, "spdx_id") !== "MIT"
    ) {
      throw new Error(
        "Repository must be public, active, non-fork, MIT, main-default, and linked to the demo"
      );
    }
    return "Public non-fork MIT repository metadata is exact";
  });

  let deployRun: GitHubWorkflowRun | undefined;
  let mcpRun: GitHubWorkflowRun | undefined;
  let recoveryRun: GitHubWorkflowRun | undefined;
  await check("exact-sha-hosted-evidence", async () => {
    const [ciRuns, codeqlRuns, deployRuns, mcpRuns, recoveryRuns] =
      await Promise.all([
        exactShaWorkflowRuns("ci.yml", "push", "Exact-SHA CI runs"),
        exactShaWorkflowRuns("codeql.yml", "push", "Exact-SHA CodeQL runs"),
        exactShaWorkflowRuns(
          "deploy-aws.yml",
          "workflow_run",
          "Exact-SHA deploy runs"
        ),
        exactShaWorkflowRuns(
          "managed-mcp-audit.yml",
          "workflow_dispatch",
          "Exact-SHA Managed MCP runs"
        ),
        exactShaWorkflowRuns(
          "recover-aws.yml",
          "workflow_dispatch",
          "Exact-SHA recovery runs"
        ),
      ]);
    const ciRun = selectSuccessfulRun(
      ciRuns,
      "CI",
      "push",
      sha,
      ".github/workflows/ci.yml"
    );
    const codeqlRun = selectSuccessfulRun(
      codeqlRuns,
      "CodeQL",
      "push",
      sha,
      ".github/workflows/codeql.yml"
    );
    deployRun = selectSuccessfulRun(
      deployRuns,
      "Deploy AWS",
      "workflow_run",
      sha,
      ".github/workflows/deploy-aws.yml"
    );
    mcpRun = selectSuccessfulRun(
      mcpRuns,
      "Cockroach Cloud Managed MCP Audit",
      "workflow_dispatch",
      sha,
      ".github/workflows/managed-mcp-audit.yml"
    );
    recoveryRun = selectSuccessfulRun(
      recoveryRuns,
      "Recover AWS",
      "workflow_dispatch",
      sha,
      ".github/workflows/recover-aws.yml"
    );
    selectedRuns.ci = toSelectedRun(ciRun);
    selectedRuns.codeql = toSelectedRun(codeqlRun);
    selectedRuns.deploy = toSelectedRun(deployRun);
    selectedRuns.managedMcp = toSelectedRun(mcpRun);
    selectedRuns.recovery = toSelectedRun(recoveryRun);
    return "CI, CodeQL, deploy, standalone Managed MCP, and recovery are green";
  });

  await check("recovery-audit-operation", async () => {
    if (!recoveryRun) {
      throw new Error("Exact-SHA recovery evidence is incomplete");
    }
    const jobs = await githubJson(
      `/repos/${REPOSITORY}/actions/runs/${recoveryRun.id}/jobs?filter=latest&per_page=100`,
      token,
      "Exact recovery audit jobs"
    );
    requireSuccessfulRecoveryAuditJobs(jobs, recoveryRun.id, sha);
    return "Both daily protection/drift audits and receipt uploads succeeded";
  });

  await check("post-deploy-independent-audits", () => {
    if (!deployRun || !mcpRun || !recoveryRun) {
      throw new Error("Exact-SHA hosted evidence is incomplete");
    }
    requirePostDeployAuditTiming(deployRun, mcpRun, recoveryRun);
    return "Standalone Managed MCP and operation-bound recovery audits post-date deployment and are under 24 hours old";
  });

  await check("submission-copy", () => {
    const copy = readFileSync(
      resolve(ROOT, "docs/DEVPOST_SUBMISSION.md"),
      "utf8"
    );
    const videoPlan = readFileSync(
      resolve(ROOT, "demo/VIDEO_PLAN.md"),
      "utf8"
    );
    if (
      !/^status: submission-copy-complete$/mu.test(copy) ||
      !copy.includes(REPOSITORY_URL) ||
      !copy.includes(DEMO_URL) ||
      !/Distributed Vector Indexing/u.test(copy) ||
      !/CockroachDB Cloud Managed MCP/u.test(copy) ||
      !/^## How we used AWS$/mu.test(copy) ||
      !/^## Prior-work disclosure$/mu.test(copy) ||
      /\b(?:TODO|TBD|PENDING)\b/iu.test(copy) ||
      !/^Target runtime: \*\*2:50 \(170 seconds\)\*\*[ \t]*\r?$/mu.test(
        videoPlan
      ) ||
      !/separate deterministic release controller uses CockroachDB Cloud Managed MCP/u.test(
        videoPlan
      )
    ) {
      throw new Error("Submission copy or video plan is incomplete");
    }
    return "English copy and the under-three-minute judge story are complete";
  });

  await check("submission-thumbnail", () => {
    const metadata = validSubmissionThumbnail();
    if (!metadata) {
      throw new Error("Owned thumbnail is not a valid 3:2 PNG under 5 MB");
    }
    const bytes = readFileSync(resolve(ROOT, SUBMISSION_THUMBNAIL_PATH));
    thumbnail = {
      path: SUBMISSION_THUMBNAIL_PATH,
      ...metadata,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    return `${metadata.width}x${metadata.height}, ${metadata.bytes} bytes`;
  });

  await check("live-root", async () => {
    const response = await fetchWithTimeout(
      DEMO_URL,
      { headers: { accept: "text/html" } },
      "Live root"
    );
    const html = await response.text();
    if (
      response.url !== `${DEMO_URL}/` ||
      !/^text\/html(?:;|$)/iu.test(
        response.headers.get("content-type") ?? ""
      ) ||
      !/Archon Memory/iu.test(html)
    ) {
      throw new Error("Live root does not identify Archon Memory");
    }
    live.root = true;
    return "Public React root is reachable without authentication";
  });

  await check("live-health", async () => {
    const health = await fetchLiveJson(
      "/api/health",
      { headers: { accept: "application/json" } },
      "Live health"
    );
    if (
      health.ok !== true ||
      health.status !== "reachable" ||
      health.service !== "archon-cockroach-memory" ||
      health.access !== "public-read-only" ||
      !exactPublicScope(health.scope)
    ) {
      throw new Error("Live health contract is not exact");
    }
    live.health = true;
    return "Fixed synthetic public-read-only health contract passed";
  });

  await check("live-proof", async () => {
    const proof = await fetchLiveJson(
      "/api/proof",
      { headers: { accept: "application/json" } },
      "Live proof"
    );
    const database = asRecord(proof.database);
    const memory = asRecord(proof.memory);
    const vector = asRecord(proof.vectorIndex);
    const release = asRecord(proof.release);
    requireFreshGeneratedAt(proof, "Live proof");
    const prefixes = Array.isArray(vector?.prefixes)
      ? vector.prefixes
      : [];
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
        "Live proof is not bound to the exact production release and 9/9/9 contract"
      );
    }
    live.proof = true;
    return "Exact live release SHA, CockroachDB, C-SPANN, eu-west-1, models, and 9/9/9 passed";
  });

  await check("live-recall", async () => {
    const recall = await fetchLiveJson(
      "/api/recall",
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ question: RECALL_QUESTION, limit: 5 }),
      },
      "Live recall",
      60_000
    );
    const answer = stringValue(recall, "answer") ?? "";
    const citations = asRecords(recall.citations);
    const grounding = asRecord(recall.grounding);
    const groundingChecks = asRecord(grounding?.checks);
    const trace = asRecord(recall.trace);
    const retrieval = asRecord(trace?.retrieval);
    const narration = asRecord(trace?.narration);
    const recalled = numberValue(recall, "recalled") ?? 0;
    const evidence = citations.map((citation) => ({
      marker: stringValue(citation, "marker") ?? "",
      memoryId: stringValue(citation, "memoryId") ?? "",
      sourceRef: stringValue(citation, "sourceRef") ?? "",
      content: stringValue(citation, "content") ?? "",
      company: stringValue(citation, "company") ?? "",
    }));
    if (
      recall.question !== RECALL_QUESTION ||
      !answer.includes("€15,375") ||
      !answer.includes("€6,775") ||
      recall.modelId !== "eu.anthropic.claude-sonnet-4-6" ||
      citations.length < 2 ||
      citations.length > 5 ||
      recalled !== citations.length ||
      !["verified", "extractive"].includes(
        stringValue(grounding, "status") ?? ""
      ) ||
      groundingChecks?.citations !== true ||
      groundingChecks?.numerics !== true ||
      groundingChecks?.claims !== true ||
      retrieval?.database !== "CockroachDB" ||
      retrieval?.index !== "native C-SPANN vector index" ||
      retrieval?.metric !== "cosine" ||
      retrieval?.embeddingModel !== "amazon.titan-embed-text-v2:0" ||
      numberValue(retrieval, "requestedTopK") !== 5 ||
      numberValue(retrieval, "recalled") !== recalled ||
      narration?.model !== "eu.anthropic.claude-sonnet-4-6" ||
      !exactPublicScope(trace?.scope) ||
      !evidence.some((citation) => citation.content.includes("€15,375")) ||
      !evidence.some((citation) => citation.content.includes("€6,775")) ||
      evidence.some(
        (citation) =>
          !/^\[[1-5]\]$/u.test(citation.marker) ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
            citation.memoryId
          ) ||
          citation.sourceRef.length === 0 ||
          citation.company !== "Helios SA" ||
          !answer.includes(citation.marker)
      ) ||
      !exactSequentialCitationMarkers(
        evidence.map((citation) => citation.marker)
      ) ||
      citations.some((citation) => {
        const score = numberValue(citation, "score");
        return (
          !["document", "payroll_event", "validation", "insight"].includes(
            stringValue(citation, "kind") ?? ""
          ) ||
          citation.period !== "2026-04" ||
          score === undefined ||
          score < 0.15 ||
          score > 1
        );
      }) ||
      new Set(evidence.map((citation) => citation.memoryId)).size !==
        evidence.length ||
      recall.consistencyOk !== true
    ) {
      throw new Error("Live recall or grounding evidence is incomplete");
    }
    live.recall = true;
    return `Grounded C-SPANN recall passed with ${citations.length} citations`;
  });

  await check("live-audit", async () => {
    const audit = await fetchLiveJson(
      "/api/audit",
      { headers: { accept: "application/json" } },
      "Live audit"
    );
    const report = asRecord(audit.report);
    const coverage = asRecord(audit.coverage);
    requireFreshGeneratedAt(audit, "Live audit");
    const contradictions = asRecords(report?.contradictions);
    const absences = asRecords(report?.absences);
    const contradiction = contradictions[0];
    const resolution = asRecord(contradiction?.resolution);
    const values = asRecords(contradiction?.values)
      .map((value) => numberValue(value, "value"))
      .filter((value): value is number => value !== undefined)
      .sort((left, right) => left - right);
    if (
      numberValue(report, "audited") !== 9 ||
      report?.ok !== false ||
      numberValue(coverage, "total") !== 9 ||
      numberValue(coverage, "scanned") !== 9 ||
      coverage?.complete !== true ||
      !exactPublicScope(audit.scope) ||
      contradictions.length !== 1 ||
      contradiction?.subject !== "INV-2043" ||
      contradiction?.type !== "contradiction" ||
      contradiction?.attribute !== "total" ||
      values.length !== 2 ||
      values[0] !== 18_400 ||
      values[1] !== 18_900 ||
      resolution?.recommendedValue !== 18_400 ||
      resolution?.rule !== "importance" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
        stringValue(resolution, "recommendedMemoryId") ?? ""
      ) ||
      (numberValue(resolution, "confidence") ?? -1) < 0 ||
      (numberValue(resolution, "confidence") ?? 2) > 1 ||
      (stringValue(resolution, "rationale") ?? "").length < 20 ||
      absences.length !== 1 ||
      absences[0]?.type !== "absence" ||
      absences[0]?.subject !== "PAY-118" ||
      asRecords(absences[0]?.referencedBy).length !== 1 ||
      asRecords(absences[0]?.referencedBy)[0]?.sourceRef !== "RECON-2043"
    ) {
      throw new Error(
        "Live audit is not the exact complete contradiction/absence contract"
      );
    }
    live.audit = true;
    return "Complete 9/9 audit found INV-2043 conflict and PAY-118 absence";
  });

  await check("public-video", async () => {
    const videoUrl = process.env.SUBMISSION_VIDEO_URL;
    const duration = process.env.SUBMISSION_VIDEO_DURATION_SECONDS;
    const identity = parseCanonicalSubmissionVideoUrl(videoUrl);
    if (
      !identity ||
      !validSubmissionVideoDuration(duration) ||
      process.env.SUBMISSION_VIDEO_PUBLIC_EMBEDDABLE_ATTESTED !== "true" ||
      process.env.SUBMISSION_VIDEO_CAPTIONS_ATTESTED !== "true"
    ) {
      throw new Error(
        "Canonical video, 1-179s duration, public/embed, and English-caption attestations are required"
      );
    }
    const oembedUrl =
      identity.provider === "youtube"
        ? `https://www.youtube.com/oembed?url=${encodeURIComponent(identity.canonicalUrl)}&format=json`
        : `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(identity.canonicalUrl)}`;
    const oembed = asRecord(
      await fetchJson(oembedUrl, {}, `${identity.provider} oEmbed`)
    );
    if (!validOembedContract(oembed, identity)) {
      throw new Error("Video is not publicly available through oEmbed");
    }
    const durationSeconds = Number(duration);
    let durationSource: VideoReceipt["durationSource"] =
      "operator-attested";
    if (identity.provider === "vimeo") {
      if (numberValue(oembed, "duration") !== durationSeconds) {
        throw new Error("Vimeo oEmbed duration differs from the gate input");
      }
      durationSource = "vimeo-oembed";
    }
    video = {
      provider: identity.provider,
      id: identity.id,
      url: identity.canonicalUrl,
      durationSeconds,
      durationSource,
      oembedVerified: true,
      publicEmbeddableAttested: true,
      englishCaptionsAttested: true,
    };
    return identity.provider === "vimeo"
      ? `Vimeo oEmbed availability and ${durationSeconds}s duration passed; public/embed/captions operator-attested`
      : `YouTube oEmbed availability passed; ${durationSeconds}s duration and public/embed/captions operator-attested`;
  });

  await check("phase-contract", async () => {
    if (!phase) throw new Error("Submission phase is invalid");
    const requestedDevpostUrl = process.env.DEVPOST_SUBMISSION_URL;
    const requestedPreSubmitRunId = process.env.PRE_SUBMIT_RUN_ID ?? "";
    if (phase === "pre-submit") {
      if (
        requestedDevpostUrl ||
        requestedPreSubmitRunId ||
        process.env.DEVPOST_SUBMITTED === "1"
      ) {
        throw new Error(
          "Pre-submit must not claim an existing Devpost submission or prior gate"
        );
      }
      return "Pre-submit excludes the final Devpost side effect";
    }
    if (
      process.env.DEVPOST_SUBMITTED !== "1" ||
      !requestedDevpostUrl ||
      !validDevpostSubmissionUrl(requestedDevpostUrl)
    ) {
      throw new Error(
        "Post-submit requires confirmation and a canonical Devpost project URL"
      );
    }
    if (!/^[1-9][0-9]*$/u.test(requestedPreSubmitRunId)) {
      throw new Error("Post-submit requires a canonical pre-submit run ID");
    }
    const currentRunId = Number(requireString("GITHUB_RUN_ID"));
    const preSubmitRunId = Number(requestedPreSubmitRunId);
    if (
      !Number.isSafeInteger(currentRunId) ||
      !Number.isSafeInteger(preSubmitRunId) ||
      preSubmitRunId >= currentRunId
    ) {
      throw new Error("Pre-submit run ID is not an earlier trusted run");
    }
    const prior = parseWorkflowRun(
      await githubJson(
        `/repos/${REPOSITORY}/actions/runs/${preSubmitRunId}`,
        token,
        "Bound pre-submit run"
      )
    );
    if (!prior) throw new Error("Pre-submit run metadata is invalid");
    const preSubmitRun = selectSuccessfulRun(
      [prior],
      "Submission readiness",
      "workflow_dispatch",
      sha,
      ".github/workflows/submission-readiness.yml"
    );
    if (
      preSubmitRun.display_title !==
        expectedPreSubmitDisplayTitle(
          sha,
          process.env.SUBMISSION_VIDEO_URL,
          process.env.SUBMISSION_VIDEO_DURATION_SECONDS
        ) ||
      Date.now() - Date.parse(preSubmitRun.updated_at) > 24 * 60 * 60 * 1_000
    ) {
      throw new Error(
        "Post-submit must chain to a successful pre-submit gate from the last 24 hours"
      );
    }
    selectedRuns.preSubmit = toSelectedRun(preSubmitRun);
    const response = await fetchWithTimeout(
      requestedDevpostUrl,
      { headers: { accept: "text/html" } },
      "Public Devpost project"
    );
    const html = await response.text();
    const videoIdentity = parseCanonicalSubmissionVideoUrl(
      process.env.SUBMISSION_VIDEO_URL
    );
    if (
      !videoIdentity ||
      !validDevpostPageContract(
        html,
        response.url,
        requestedDevpostUrl,
        response.headers.get("content-type") ?? "",
        videoIdentity
      )
    ) {
      throw new Error(
        "Public Devpost page lacks the exact challenge, project, repo, demo, or video contract"
      );
    }
    devpostUrl = requestedDevpostUrl;
    return "Public canonical challenge page contract passed after explicit operator submission attestation";
  });

  await check("readiness-truth-table", () => {
    process.env.SUBMISSION_DEMO_URL = DEMO_URL;
    process.env.SUBMISSION_PUBLIC_REPO_URL = REPOSITORY_URL;
    readiness = evaluate();
    if (!readiness.sourceGate.pass) {
      throw new Error("Repository source readiness is not complete");
    }
    const pending = readiness.eligibility.requirements.filter(
      (requirement) => requirement.status === "pending"
    );
    if (phase === "pre-submit") {
      if (
        readiness.submissionEligible ||
        pending.length !== 1 ||
        pending[0]?.id !== "devpost-submitted"
      ) {
        throw new Error(
          "Pre-submit must have exactly the Devpost submission pending"
        );
      }
    } else if (!readiness.submissionEligible || pending.length !== 0) {
      throw new Error("Post-submit must satisfy full submission eligibility");
    }
    return `${readiness.sourceGate.pct}% source gate; ${readiness.eligibility.complete}/${readiness.eligibility.total} eligibility`;
  });

  await check("current-main-at-finish", async () => {
    const finalMain = exactMainSha(
      await githubJson(
        `/repos/${REPOSITORY}/git/ref/heads/main`,
        token,
        "Terminal GitHub main ref"
      )
    );
    if (!mainAtStart || finalMain !== mainAtStart || finalMain !== sha) {
      throw new Error("Main moved while the submission gate was running");
    }
    const [ciRuns, codeqlRuns, deployRuns, mcpRuns, recoveryRuns] =
      await Promise.all([
        exactShaWorkflowRuns("ci.yml", "push", "Terminal exact-SHA CI runs"),
        exactShaWorkflowRuns(
          "codeql.yml",
          "push",
          "Terminal exact-SHA CodeQL runs"
        ),
        exactShaWorkflowRuns(
          "deploy-aws.yml",
          "workflow_run",
          "Terminal exact-SHA deploy runs"
        ),
        exactShaWorkflowRuns(
          "managed-mcp-audit.yml",
          "workflow_dispatch",
          "Terminal exact-SHA Managed MCP runs"
        ),
        exactShaWorkflowRuns(
          "recover-aws.yml",
          "workflow_dispatch",
          "Terminal exact-SHA recovery runs"
        ),
      ]);
    const terminalRuns = {
      ci: selectSuccessfulRun(
        ciRuns,
        "CI",
        "push",
        sha,
        ".github/workflows/ci.yml"
      ),
      codeql: selectSuccessfulRun(
        codeqlRuns,
        "CodeQL",
        "push",
        sha,
        ".github/workflows/codeql.yml"
      ),
      deploy: selectSuccessfulRun(
        deployRuns,
        "Deploy AWS",
        "workflow_run",
        sha,
        ".github/workflows/deploy-aws.yml"
      ),
      managedMcp: selectSuccessfulRun(
        mcpRuns,
        "Cockroach Cloud Managed MCP Audit",
        "workflow_dispatch",
        sha,
        ".github/workflows/managed-mcp-audit.yml"
      ),
      recovery: selectSuccessfulRun(
        recoveryRuns,
        "Recover AWS",
        "workflow_dispatch",
        sha,
        ".github/workflows/recover-aws.yml"
      ),
    };
    for (const [key, run] of Object.entries(terminalRuns)) {
      const initiallySelected = selectedRuns[key];
      if (
        !initiallySelected ||
        initiallySelected.id !== run.id ||
        initiallySelected.attempt !== run.run_attempt
      ) {
        throw new Error(
          `Latest exact-SHA ${key} run changed while the gate was running`
        );
      }
    }
    const terminalRecoveryJobs = await githubJson(
      `/repos/${REPOSITORY}/actions/runs/${terminalRuns.recovery.id}/jobs?filter=latest&per_page=100`,
      token,
      "Terminal exact recovery audit jobs"
    );
    requireSuccessfulRecoveryAuditJobs(
      terminalRecoveryJobs,
      terminalRuns.recovery.id,
      sha
    );
    requirePostDeployAuditTiming(
      terminalRuns.deploy,
      terminalRuns.managedMcp,
      terminalRuns.recovery
    );
    if (phase === "post-submit") {
      const preSubmitRunId = Number(process.env.PRE_SUBMIT_RUN_ID);
      const prior = parseWorkflowRun(
        await githubJson(
          `/repos/${REPOSITORY}/actions/runs/${preSubmitRunId}`,
          token,
          "Terminal bound pre-submit run"
        )
      );
      if (!prior) throw new Error("Terminal pre-submit metadata is invalid");
      const terminalPreSubmit = selectSuccessfulRun(
        [prior],
        "Submission readiness",
        "workflow_dispatch",
        sha,
        ".github/workflows/submission-readiness.yml"
      );
      const initiallySelected = selectedRuns.preSubmit;
      if (
        !initiallySelected ||
        initiallySelected.id !== terminalPreSubmit.id ||
        initiallySelected.attempt !== terminalPreSubmit.run_attempt ||
        terminalPreSubmit.display_title !==
          expectedPreSubmitDisplayTitle(
            sha,
            process.env.SUBMISSION_VIDEO_URL,
            process.env.SUBMISSION_VIDEO_DURATION_SECONDS
          ) ||
        Date.now() - Date.parse(terminalPreSubmit.updated_at) >
          24 * 60 * 60 * 1_000
      ) {
        throw new Error(
          "Bound pre-submit run changed while post-submit verification was running"
        );
      }
    }
    return `Main and all exact-SHA hosted evidence remained pinned to ${sha}`;
  });

  const passed = checks.every((candidate) => candidate.status === "pass");
  const receipt: SubmissionReceipt = {
    schema: "archon.submission-readiness",
    version: 1,
    generatedAt: new Date().toISOString(),
    phase: phase ?? "invalid",
    repository: REPOSITORY,
    commitSha: sha,
    passed,
    checks,
    selectedRuns,
    live,
    ...(video ? { video } : {}),
    ...(thumbnail ? { thumbnail } : {}),
    ...(devpostUrl ? { devpostUrl } : {}),
    ...(readiness
      ? {
          sourceGate: {
            passed: readiness.sourceGate.pass,
            pct: readiness.sourceGate.pct,
          },
          eligibility: {
            complete: readiness.eligibility.complete,
            total: readiness.eligibility.total,
            passed: readiness.eligibility.pass,
          },
        }
      : {}),
  };

  const runnerTemp = requireString("RUNNER_TEMP");
  const expectedReceiptPath = resolve(
    runnerTemp,
    "submission-readiness-receipt.json"
  );
  const receiptPath = resolve(requireString("SUBMISSION_RECEIPT_PATH"));
  if (receiptPath !== expectedReceiptPath) {
    throw new Error("Submission receipt must use the exact RUNNER_TEMP path");
  }
  const temporaryReceiptPath = `${receiptPath}.tmp-${process.pid}`;
  writeFileSync(temporaryReceiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporaryReceiptPath, receiptPath);
  console.log(
    `Submission readiness ${passed ? "PASS" : "FAIL"}: ` +
      `${checks.filter((candidate) => candidate.status === "pass").length}/${checks.length}`
  );
  if (!passed) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
const isMain = invokedPath === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error: unknown) => {
    console.error(`Submission gate failed before receipt: ${safeError(error)}`);
    process.exitCode = 1;
  });
}
