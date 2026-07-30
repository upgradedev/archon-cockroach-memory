// Read-only, hosted boundary for the final Devpost handoff. This script is
// intentionally network-aware and must run only from the manually dispatched
// Submission readiness workflow on the exact current main commit. It writes one
// sanitized receipt under RUNNER_TEMP and never receives AWS credentials.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { parse } from "parse5";
import {
  evaluate,
  parseCanonicalSubmissionVideoUrl,
  SUBMISSION_THUMBNAIL_PATH,
  validDevpostSubmissionUrl,
  validatedSubmissionThumbnail,
  validSubmissionVideoDuration,
} from "./readiness.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY = "upgradedev/archon-cockroach-memory";
const DEMO_URL = "https://d2s5v0o0eg2aaw.cloudfront.net";
const REPOSITORY_URL =
  "https://github.com/upgradedev/archon-cockroach-memory";
const YOUTUBE_OEMBED_ENDPOINT = "https://www.youtube.com/oembed";
const VIMEO_OEMBED_ENDPOINT = "https://vimeo.com/api/oembed.json";
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

export interface GitHubArtifact {
  id: number;
  name: string;
  sizeInBytes: number;
  archiveDownloadUrl: string;
  digest: string;
  expired: boolean;
  createdAt: string;
  updatedAt: string;
  workflowRunId: number;
  workflowRunHeadSha: string;
}

interface SelectedArtifact {
  id: number;
  name: string;
  sizeInBytes: number;
  digest: string;
  url: string;
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
  selectedArtifacts?: Record<string, SelectedArtifact>;
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

async function githubArtifactArchive(
  artifact: GitHubArtifact,
  token: string,
  label: string
): Promise<Uint8Array> {
  const response = await fetchWithTimeout(
    artifact.archiveDownloadUrl,
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
  const contentLength = Number(
    response.headers.get("content-length") ?? "0"
  );
  if (
    (contentLength !== 0 &&
      (!Number.isSafeInteger(contentLength) ||
        contentLength < 1 ||
        contentLength > 1_000_000))
  ) {
    throw new Error(`${label} content length is invalid`);
  }
  const archive = new Uint8Array(await response.arrayBuffer());
  if (archive.length < 1 || archive.length > 1_000_000) {
    throw new Error(`${label} archive size is invalid`);
  }
  try {
    requireArtifactArchiveDigest(archive, artifact.digest);
  } catch {
    throw new Error(`${label} digest differs from GitHub artifact metadata`);
  }
  return archive;
}

async function githubArtifactReceipt(
  artifact: GitHubArtifact,
  token: string,
  label: string
): Promise<unknown> {
  return extractSingleJsonArtifact(
    await githubArtifactArchive(artifact, token, label),
    "hosted-dast.json"
  );
}

export function requireArtifactArchiveDigest(
  archive: Uint8Array,
  expectedDigest: string
): void {
  const digest = `sha256:${createHash("sha256")
    .update(archive)
    .digest("hex")}`;
  if (
    !/^sha256:[0-9a-f]{64}$/u.test(expectedDigest) ||
    digest !== expectedDigest
  ) {
    throw new Error("Artifact archive digest does not match");
  }
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

export function parseWorkflowArtifacts(value: unknown): GitHubArtifact[] {
  const root = asRecord(value);
  return asRecords(root?.artifacts)
    .map((artifact) => {
      const workflowRun = asRecord(artifact.workflow_run);
      return {
        id: numberValue(artifact, "id") ?? 0,
        name: stringValue(artifact, "name") ?? "",
        sizeInBytes: numberValue(artifact, "size_in_bytes") ?? -1,
        archiveDownloadUrl:
          stringValue(artifact, "archive_download_url") ?? "",
        digest: stringValue(artifact, "digest") ?? "",
        expired: booleanValue(artifact, "expired") ?? true,
        createdAt: stringValue(artifact, "created_at") ?? "",
        updatedAt: stringValue(artifact, "updated_at") ?? "",
        workflowRunId: numberValue(workflowRun, "id") ?? 0,
        workflowRunHeadSha: stringValue(workflowRun, "head_sha") ?? "",
      };
    })
    .filter(
      (artifact) =>
        Number.isSafeInteger(artifact.id) &&
        artifact.id > 0 &&
        Number.isSafeInteger(artifact.sizeInBytes) &&
        artifact.sizeInBytes > 0 &&
        artifact.sizeInBytes <= 1_000_000 &&
        artifact.workflowRunId > 0 &&
        /^[0-9a-f]{40}$/u.test(artifact.workflowRunHeadSha) &&
        /^sha256:[0-9a-f]{64}$/u.test(artifact.digest) &&
        artifact.archiveDownloadUrl ===
          `https://api.github.com/repos/${REPOSITORY}/actions/artifacts/${artifact.id}/zip` &&
        !Number.isNaN(Date.parse(artifact.createdAt)) &&
        !Number.isNaN(Date.parse(artifact.updatedAt))
    );
}

export function selectExactHostedDastArtifact(
  value: unknown,
  expectedName: string,
  hostedDastRun: GitHubWorkflowRun
): GitHubArtifact {
  const root = asRecord(value);
  const rawArtifacts = asRecords(root?.artifacts);
  const totalCount = numberValue(root, "total_count");
  const rawMatches = rawArtifacts.filter(
    (artifact) => stringValue(artifact, "name") === expectedName
  );
  if (
    !Number.isSafeInteger(totalCount) ||
    totalCount !== rawArtifacts.length ||
    (totalCount ?? 0) < 1 ||
    (totalCount ?? 0) > 100 ||
    rawMatches.length !== 1
  ) {
    throw new Error(
      "Hosted DAST artifact inventory is incomplete or ambiguous"
    );
  }
  const matches = parseWorkflowArtifacts(value).filter(
    (artifact) =>
      artifact.name === expectedName &&
      artifact.workflowRunId === hostedDastRun.id &&
      artifact.workflowRunHeadSha === hostedDastRun.head_sha &&
      artifact.expired === false
  );
  if (matches.length !== 1 || !matches[0]) {
    throw new Error(
      "Exactly one unexpired operation-bound Hosted DAST artifact is required"
    );
  }
  return matches[0];
}

function toSelectedArtifact(artifact: GitHubArtifact): SelectedArtifact {
  return {
    id: artifact.id,
    name: artifact.name,
    sizeInBytes: artifact.sizeInBytes,
    digest: artifact.digest,
    url: `https://github.com/${REPOSITORY}/actions/runs/${artifact.workflowRunId}/artifacts/${artifact.id}`,
  };
}

function crc32(value: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function extractSingleJsonArtifact(
  archive: Uint8Array,
  expectedPath: string
): unknown {
  const input = Buffer.from(
    archive.buffer,
    archive.byteOffset,
    archive.byteLength
  );
  if (input.length < 22 || input.length > 1_000_000) {
    throw new Error("Hosted DAST artifact ZIP size is invalid");
  }

  const minimumOffset = Math.max(0, input.length - 22 - 65_535);
  let eocdOffset = -1;
  for (let offset = input.length - 22; offset >= minimumOffset; offset -= 1) {
    if (input.readUInt32LE(offset) === 0x06054b50) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error("Hosted DAST artifact ZIP has no EOCD");

  const disk = input.readUInt16LE(eocdOffset + 4);
  const centralDisk = input.readUInt16LE(eocdOffset + 6);
  const entriesOnDisk = input.readUInt16LE(eocdOffset + 8);
  const entries = input.readUInt16LE(eocdOffset + 10);
  const centralSize = input.readUInt32LE(eocdOffset + 12);
  const centralOffset = input.readUInt32LE(eocdOffset + 16);
  const commentLength = input.readUInt16LE(eocdOffset + 20);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    entriesOnDisk !== 1 ||
    entries !== 1 ||
    eocdOffset + 22 + commentLength !== input.length ||
    centralOffset + centralSize !== eocdOffset ||
    centralSize < 46 ||
    input.readUInt32LE(centralOffset) !== 0x02014b50
  ) {
    throw new Error("Hosted DAST artifact ZIP structure is not canonical");
  }

  const flags = input.readUInt16LE(centralOffset + 8);
  const compression = input.readUInt16LE(centralOffset + 10);
  const expectedCrc = input.readUInt32LE(centralOffset + 16);
  const compressedSize = input.readUInt32LE(centralOffset + 20);
  const uncompressedSize = input.readUInt32LE(centralOffset + 24);
  const nameLength = input.readUInt16LE(centralOffset + 28);
  const extraLength = input.readUInt16LE(centralOffset + 30);
  const entryCommentLength = input.readUInt16LE(centralOffset + 32);
  const localOffset = input.readUInt32LE(centralOffset + 42);
  const centralEntryEnd =
    centralOffset + 46 + nameLength + extraLength + entryCommentLength;
  const name = input
    .subarray(centralOffset + 46, centralOffset + 46 + nameLength)
    .toString("utf8");
  if (
    centralEntryEnd !== centralOffset + centralSize ||
    name !== expectedPath ||
    (flags & ~(0x0008 | 0x0800)) !== 0 ||
    (compression !== 0 && compression !== 8) ||
    uncompressedSize < 2 ||
    uncompressedSize > 65_536 ||
    localOffset !== 0 ||
    localOffset + 30 > centralOffset ||
    input.readUInt32LE(localOffset) !== 0x04034b50
  ) {
    throw new Error("Hosted DAST artifact ZIP entry is invalid");
  }

  const localFlags = input.readUInt16LE(localOffset + 6);
  const localCompression = input.readUInt16LE(localOffset + 8);
  const localCrc = input.readUInt32LE(localOffset + 14);
  const localCompressedSize = input.readUInt32LE(localOffset + 18);
  const localUncompressedSize = input.readUInt32LE(localOffset + 22);
  const localNameLength = input.readUInt16LE(localOffset + 26);
  const localExtraLength = input.readUInt16LE(localOffset + 28);
  const localName = input
    .subarray(localOffset + 30, localOffset + 30 + localNameLength)
    .toString("utf8");
  const dataStart = localOffset + 30 + localNameLength + localExtraLength;
  const dataEnd = dataStart + compressedSize;
  const usesDataDescriptor = (flags & 0x0008) !== 0;
  const exactTerminalStructure = usesDataDescriptor
    ? dataEnd + 16 === centralOffset &&
      input.readUInt32LE(dataEnd) === 0x08074b50 &&
      input.readUInt32LE(dataEnd + 4) === expectedCrc &&
      input.readUInt32LE(dataEnd + 8) === compressedSize &&
      input.readUInt32LE(dataEnd + 12) === uncompressedSize &&
      localCrc === 0 &&
      localCompressedSize === 0 &&
      localUncompressedSize === 0
    : dataEnd === centralOffset &&
      localCrc === expectedCrc &&
      localCompressedSize === compressedSize &&
      localUncompressedSize === uncompressedSize;
  if (
    localFlags !== flags ||
    localCompression !== compression ||
    localName !== expectedPath ||
    dataStart > dataEnd ||
    dataEnd > centralOffset ||
    !exactTerminalStructure
  ) {
    throw new Error("Hosted DAST artifact local ZIP entry is invalid");
  }

  const compressed = input.subarray(dataStart, dataEnd);
  const output =
    compression === 0
      ? Buffer.from(compressed)
      : inflateRawSync(compressed, {
          maxOutputLength: 65_536,
        });
  if (
    output.length !== uncompressedSize ||
    crc32(output) !== expectedCrc
  ) {
    throw new Error("Hosted DAST artifact ZIP integrity check failed");
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(output));
  } catch {
    throw new Error("Hosted DAST artifact receipt is not canonical UTF-8 JSON");
  }
}

export function requireExactHostedDastReceipt(
  value: unknown,
  deployRun: GitHubWorkflowRun,
  hostedDastRun: GitHubWorkflowRun,
  sha: string,
  now = Date.now()
): void {
  const receipt = asRecord(value);
  const expectedKeys = [
    "checks",
    "generatedAt",
    "passed",
    "profile",
    "releaseSha",
    "scannerRunAttempt",
    "scannerRunId",
    "scannerSha",
    "schema",
    "sourceDeployRunAttempt",
    "sourceDeployRunId",
    "targetOrigin",
    "version",
  ];
  const actualKeys = receipt ? Object.keys(receipt).sort() : [];
  const generatedAt = Date.parse(stringValue(receipt, "generatedAt") ?? "");
  const scannerRunId = numberValue(receipt, "scannerRunId");
  const scannerRunAttempt = numberValue(receipt, "scannerRunAttempt");
  const sourceDeployRunId = numberValue(receipt, "sourceDeployRunId");
  const sourceDeployRunAttempt = numberValue(
    receipt,
    "sourceDeployRunAttempt"
  );
  const hostedStartedAt = Date.parse(hostedDastRun.run_started_at);
  const hostedCompletedAt = Date.parse(hostedDastRun.updated_at);
  if (
    !receipt ||
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index]) ||
    receipt.schema !== "archon.hosted-dast" ||
    receipt.version !== 3 ||
    receipt.profile !== "exact-release" ||
    receipt.targetOrigin !== DEMO_URL ||
    receipt.releaseSha !== sha ||
    receipt.scannerSha !== sha ||
    receipt.passed !== true ||
    scannerRunId !== hostedDastRun.id ||
    scannerRunAttempt !== hostedDastRun.run_attempt ||
    sourceDeployRunId !== deployRun.id ||
    sourceDeployRunAttempt !== deployRun.run_attempt ||
    !Number.isSafeInteger(scannerRunId) ||
    !Number.isSafeInteger(scannerRunAttempt) ||
    !Number.isSafeInteger(sourceDeployRunId) ||
    !Number.isSafeInteger(sourceDeployRunAttempt) ||
    ![generatedAt, hostedStartedAt, hostedCompletedAt, now].every(
      Number.isFinite
    ) ||
    generatedAt < hostedStartedAt ||
    generatedAt > hostedCompletedAt + 2 * 60 * 1_000 ||
    hostedCompletedAt < hostedStartedAt ||
    hostedCompletedAt > now + 5 * 60 * 1_000 ||
    now - hostedCompletedAt > 24 * 60 * 60 * 1_000
  ) {
    throw new Error(
      "Hosted DAST receipt is not bound to the exact scanner and source deployment"
    );
  }

  const expectedChecks = [
    ["root-security-headers", 200],
    ["health-boundary", 200],
    ["release-proof-boundary", 200],
    ["audit-boundary", 200],
    ["method-boundary-get", 405],
    ["method-boundary-delete", 405],
    ["content-type-boundary", 415],
    ["malformed-json-boundary", 400],
    ["body-size-boundary", 413],
    ["question-size-boundary", 400],
    ["fixed-scope-sql-injection", 400],
    ["kind-enumeration-boundary", 400],
    ["limit-boundary", 400],
    ["write-route-absent", 404],
    ["audit-scope-injection", 400],
    ["unknown-route-boundary", 404],
  ] as const;
  const rawChecks = Array.isArray(receipt.checks)
    ? receipt.checks
    : [];
  const checks = asRecords(rawChecks);
  if (
    rawChecks.length !== checks.length ||
    checks.length !== expectedChecks.length ||
    checks.some((check, index) => {
      const checkKeys = Object.keys(check).sort();
      const observedStatus = numberValue(check, "observedStatus");
      const expected = expectedChecks[index];
      return (
        !expected ||
        checkKeys.length !== 3 ||
        checkKeys[0] !== "id" ||
        checkKeys[1] !== "observedStatus" ||
        checkKeys[2] !== "status" ||
        check.id !== expected[0] ||
        check.status !== "pass" ||
        observedStatus !== expected[1]
      );
    })
  ) {
    throw new Error("Hosted DAST receipt does not prove all 16 checks");
  }
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

export function requireSuccessfulDeployJobs(
  value: unknown,
  runId: number,
  sha: string
): void {
  const { totalCount, jobs } = parseWorkflowJobs(value);
  const expected = [
    {
      job: "Validate Deploy AWS source CI",
      steps: ["Require successful exact-main push CI source"],
    },
    {
      job: "Verify CI SHA and build once",
      steps: [
        "Prove the CI SHA is still the main branch head",
        "Prove CodeQL succeeded for the exact release SHA",
        "Test and build the frontend",
        "Validate and build the SAM application",
        "Create sanitized build receipt",
        "Upload immutable candidate",
      ],
    },
    {
      job: "Deploy and smoke staging",
      steps: [
        "Deploy staging with recovery-safe SAM canary",
        "Smoke the same-origin application and real recall path",
        "Hosted Chromium judge journey on staging",
        "Build and validate sanitized staging deployment receipt",
        "Upload staging receipt",
      ],
    },
    {
      job: "Promote identical candidate to production",
      steps: [
        "Deploy production with recovery-safe SAM canary",
        "Smoke production through CloudFront",
        "Hosted Chromium judge journey on production",
        "Build and validate sanitized production deployment receipt",
        "Commit the receipt-bound production recovery intent",
        "Upload production receipt",
      ],
    },
    {
      job: "Prove production memory through CockroachDB Managed MCP",
      steps: [
        "Run bounded read-only Managed MCP proof",
        "Upload sanitized Managed MCP receipt",
      ],
    },
  ] as const;
  if (
    totalCount !== jobs.length ||
    jobs.length < expected.length ||
    jobs.length > 100
  ) {
    throw new Error("Deploy AWS job inventory is incomplete or truncated");
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
    for (const stepName of contract.steps) {
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

export function requireSuccessfulHostedDastJobs(
  value: unknown,
  runId: number,
  sha: string
): void {
  const { totalCount, jobs } = parseWorkflowJobs(value);
  const expected = [
    {
      job: "Validate Hosted DAST source deployment",
      steps: ["Require successful operation-bound Deploy AWS source"],
    },
    {
      job: "Bounded active API and browser-boundary probes",
      steps: [
        "Run fail-closed hosted adversarial probes",
        "Upload sanitized hosted DAST receipt",
      ],
    },
    {
      job: "OWASP ZAP passive and AJAX-spider baseline",
      steps: ["Scan the owned public production release"],
    },
  ] as const;
  if (totalCount !== expected.length || jobs.length !== expected.length) {
    throw new Error("Hosted DAST must contain exactly three successful jobs");
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
    for (const stepName of contract.steps) {
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
  hostedDastRun: GitHubWorkflowRun,
  mcpRun: GitHubWorkflowRun,
  recoveryRun: GitHubWorkflowRun,
  now = Date.now()
): void {
  const deployedStartedAt = Date.parse(deployRun.run_started_at);
  const deployedAt = Date.parse(deployRun.updated_at);
  const hostedDastStartedAt = Date.parse(hostedDastRun.run_started_at);
  const mcpStartedAt = Date.parse(mcpRun.run_started_at);
  const recoveryStartedAt = Date.parse(recoveryRun.run_started_at);
  if (
    ![
      deployedStartedAt,
      deployedAt,
      hostedDastStartedAt,
      mcpStartedAt,
      recoveryStartedAt,
      now,
    ].every(Number.isFinite) ||
    deployedAt < deployedStartedAt ||
    hostedDastStartedAt <= deployedAt ||
    mcpStartedAt <= deployedAt ||
    recoveryStartedAt <= deployedAt
  ) {
    throw new Error(
      "Deploy timing must be valid and all independent audits must start after deploy completes"
    );
  }
  const maximumAuditAgeMs = 24 * 60 * 60 * 1_000;
  for (const [label, run] of [
    ["Hosted DAST", hostedDastRun],
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

interface SemanticHtmlEvidence {
  anchors: ParsedHtmlNode[];
  iframes: ParsedHtmlNode[];
  text: string;
}

interface ParsedHtmlAttribute {
  name: string;
  value: string;
}

interface ParsedHtmlNode {
  nodeName: string;
  tagName?: string;
  attrs?: ParsedHtmlAttribute[];
  childNodes?: ParsedHtmlNode[];
  value?: string;
}

const MAX_SUBMISSION_HTML_CHARACTERS = 5_000_000;
const IGNORED_SEMANTIC_HTML = new Set([
  "head",
  "iframe",
  "math",
  "noembed",
  "noframes",
  "noscript",
  "object",
  "plaintext",
  "script",
  "style",
  "svg",
  "template",
  "textarea",
  "title",
  "xmp",
]);

function semanticHtmlEvidence(html: string): SemanticHtmlEvidence {
  const empty = { anchors: [], iframes: [], text: "" };
  if (
    html.length < 1 ||
    html.length > MAX_SUBMISSION_HTML_CHARACTERS
  ) {
    return empty;
  }

  const anchors: ParsedHtmlNode[] = [];
  const iframes: ParsedHtmlNode[] = [];
  const text: string[] = [];
  try {
    const document = parse(html, {
      scriptingEnabled: true,
    }) as unknown as ParsedHtmlNode;
    const pending = [document];
    let visited = 0;
    while (pending.length > 0) {
      const node = pending.pop();
      if (!node || (visited += 1) > 200_000) return empty;
      const name = node.tagName?.toLowerCase();
      if (name === "a") anchors.push(node);
      if (name === "iframe") iframes.push(node);
      if (name !== undefined && IGNORED_SEMANTIC_HTML.has(name)) {
        continue;
      }
      if (node.nodeName === "#text" && node.value !== undefined) {
        text.push(node.value);
      }
      const children = node.childNodes ?? [];
      for (let index = children.length - 1; index >= 0; index -= 1) {
        pending.push(children[index]!);
      }
    }
  } catch {
    return empty;
  }

  return {
    anchors,
    iframes,
    text: text.join(" ").replace(/\s+/gu, " ").trim(),
  };
}

function htmlTagAttributeValues(
  elements: readonly ParsedHtmlNode[],
  attribute: "href" | "src"
): string[] {
  const values: string[] = [];
  for (const element of elements) {
    const value = element.attrs?.find(
      (candidate) => candidate.name.toLowerCase() === attribute
    )?.value;
    if (value !== undefined) values.push(value);
  }
  return values;
}

function cleanHttpsUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.port === ""
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}

function htmlTagUrls(
  elements: readonly ParsedHtmlNode[],
  attribute: "href" | "src"
): URL[] {
  return htmlTagAttributeValues(elements, attribute)
    .map(cleanHttpsUrl)
    .filter((url): url is URL => url !== undefined);
}

function exactUrl(url: URL, expected: string): boolean {
  return url.href === new URL(expected).href;
}

function trustedVideoEmbed(
  url: URL,
  identity: SubmissionVideoIdentity
): boolean {
  if (url.hash !== "") return false;
  return identity.provider === "youtube"
    ? url.hostname.toLowerCase() === "www.youtube.com" &&
        url.pathname === `/embed/${identity.id}`
    : url.hostname.toLowerCase() === "player.vimeo.com" &&
        url.pathname === `/video/${identity.id}`;
}

function canonicalVideoLink(
  url: URL,
  identity: SubmissionVideoIdentity
): boolean {
  const parsed = parseCanonicalSubmissionVideoUrl(url.href);
  return (
    parsed?.provider === identity.provider &&
    parsed.id === identity.id &&
    parsed.canonicalUrl === identity.canonicalUrl
  );
}

function hasExactMetadataLine(
  document: string,
  key: string,
  value: string
): boolean {
  const prefix = `${key}:`;
  const expected = `${key}: ${value}`;
  const matches = document
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(prefix));
  return matches.length === 1 && matches[0] === expected;
}

export function validSubmissionCopyMetadata(document: string): boolean {
  return (
    hasExactMetadataLine(document, "repository", REPOSITORY_URL) &&
    hasExactMetadataLine(document, "demo", DEMO_URL)
  );
}

export function validOembedContract(
  value: unknown,
  identity: SubmissionVideoIdentity
): boolean {
  const oembed = asRecord(value);
  if (!oembed) return false;
  const html = stringValue(oembed, "html") ?? "";
  const evidence = semanticHtmlEvidence(html);
  const iframeUrls = htmlTagUrls(evidence.iframes, "src");
  return (
    /Archon Memory/iu.test(stringValue(oembed, "title") ?? "") &&
    oembed.type === "video" &&
    oembed.provider_name ===
      (identity.provider === "youtube" ? "YouTube" : "Vimeo") &&
    iframeUrls.some((url) => trustedVideoEmbed(url, identity))
  );
}

export function validDevpostPageContract(
  html: string,
  responseUrl: string,
  requestedUrl: string,
  contentType: string,
  identity: SubmissionVideoIdentity
): boolean {
  const evidence = semanticHtmlEvidence(html);
  const normalizedText = evidence.text;
  const anchorUrls = htmlTagUrls(evidence.anchors, "href");
  const iframeUrls = htmlTagUrls(evidence.iframes, "src");
  const challengeAnchor = anchorUrls.some((url) =>
    exactUrl(url, "https://cockroachdb-ai.devpost.com/")
  );
  const repositoryAnchor = anchorUrls.some((url) =>
    exactUrl(url, REPOSITORY_URL)
  );
  const demoAnchor = anchorUrls.some((url) =>
    exactUrl(url, DEMO_URL)
  );
  const videoPresent =
    anchorUrls.some((url) => canonicalVideoLink(url, identity)) ||
    iframeUrls.some((url) => trustedVideoEmbed(url, identity));
  return (
    responseUrl === requestedUrl &&
    /^text\/html(?:;|$)/iu.test(contentType) &&
    /Archon Memory/iu.test(normalizedText) &&
    challengeAnchor &&
    /CockroachDB × AWS Hackathon - Build with Agentic Memory/iu.test(
      normalizedText
    ) &&
    repositoryAnchor &&
    demoAnchor &&
    videoPresent
  );
}

async function main(): Promise<void> {
  const checks: GateCheck[] = [];
  const selectedRuns: Record<string, SelectedRun> = {};
  const selectedArtifacts: Record<string, SelectedArtifact> = {};
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
  let hostedDastRun: GitHubWorkflowRun | undefined;
  let hostedDastArtifact: GitHubArtifact | undefined;
  let hostedDastZapArtifact: GitHubArtifact | undefined;
  let mcpRun: GitHubWorkflowRun | undefined;
  let recoveryRun: GitHubWorkflowRun | undefined;
  await check("exact-sha-hosted-evidence", async () => {
    const [
      ciRuns,
      codeqlRuns,
      deployRuns,
      hostedDastRuns,
      mcpRuns,
      recoveryRuns,
    ] =
      await Promise.all([
        exactShaWorkflowRuns("ci.yml", "push", "Exact-SHA CI runs"),
        exactShaWorkflowRuns("codeql.yml", "push", "Exact-SHA CodeQL runs"),
        exactShaWorkflowRuns(
          "deploy-aws.yml",
          "workflow_run",
          "Exact-SHA deploy runs"
        ),
        exactShaWorkflowRuns(
          "security-dast.yml",
          "workflow_run",
          "Exact-SHA Hosted DAST runs"
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
    hostedDastRun = selectSuccessfulRun(
      hostedDastRuns,
      "Hosted DAST",
      "workflow_run",
      sha,
      ".github/workflows/security-dast.yml"
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
    selectedRuns.hostedDast = toSelectedRun(hostedDastRun);
    selectedRuns.managedMcp = toSelectedRun(mcpRun);
    selectedRuns.recovery = toSelectedRun(recoveryRun);
    return "CI, CodeQL, deploy, exact-release Hosted DAST, standalone Managed MCP, and recovery are green";
  });

  await check("hosted-dast-jobs", async () => {
    if (!hostedDastRun) {
      throw new Error("Exact-SHA Hosted DAST evidence is incomplete");
    }
    const jobs = await githubJson(
      `/repos/${REPOSITORY}/actions/runs/${hostedDastRun.id}/attempts/${hostedDastRun.run_attempt}/jobs?per_page=100`,
      token,
      "Exact Hosted DAST jobs"
    );
    requireSuccessfulHostedDastJobs(jobs, hostedDastRun.id, sha);
    return "Both exact-release active probes and ZAP baseline executed successfully";
  });

  await check("deploy-operation", async () => {
    if (!deployRun) {
      throw new Error("Exact-SHA Deploy AWS evidence is incomplete");
    }
    const jobs = await githubJson(
      `/repos/${REPOSITORY}/actions/runs/${deployRun.id}/attempts/${deployRun.run_attempt}/jobs?per_page=100`,
      token,
      "Exact Deploy AWS jobs"
    );
    requireSuccessfulDeployJobs(jobs, deployRun.id, sha);
    return "Exact-main source, build-once, staging, production, smoke, receipt, and Managed MCP deployment jobs passed";
  });

  await check("hosted-dast-receipt", async () => {
    if (!deployRun || !hostedDastRun) {
      throw new Error("Exact-SHA Hosted DAST evidence is incomplete");
    }
    const artifacts = await githubJson(
      `/repos/${REPOSITORY}/actions/runs/${hostedDastRun.id}/artifacts?per_page=100`,
      token,
      "Exact Hosted DAST artifacts"
    );
    hostedDastArtifact = selectExactHostedDastArtifact(
      artifacts,
      `hosted-dast-${sha}-${deployRun.id}-${deployRun.run_attempt}-${hostedDastRun.run_attempt}`,
      hostedDastRun
    );
    hostedDastZapArtifact = selectExactHostedDastArtifact(
      artifacts,
      `zap-baseline-${sha}-${hostedDastRun.run_attempt}`,
      hostedDastRun
    );
    const receipt = await githubArtifactReceipt(
      hostedDastArtifact,
      token,
      "Exact Hosted DAST receipt"
    );
    requireExactHostedDastReceipt(
      receipt,
      deployRun,
      hostedDastRun,
      sha
    );
    await githubArtifactArchive(
      hostedDastZapArtifact,
      token,
      "Exact Hosted DAST ZAP report"
    );
    selectedArtifacts.hostedDast = toSelectedArtifact(
      hostedDastArtifact
    );
    selectedArtifacts.hostedDastZap = toSelectedArtifact(
      hostedDastZapArtifact
    );
    return `Hosted DAST receipt ${hostedDastArtifact.id} and ZAP report ${hostedDastZapArtifact.id} are digest-bound to deploy ${deployRun.id}/${deployRun.run_attempt}`;
  });

  await check("recovery-audit-operation", async () => {
    if (!recoveryRun) {
      throw new Error("Exact-SHA recovery evidence is incomplete");
    }
    const jobs = await githubJson(
      `/repos/${REPOSITORY}/actions/runs/${recoveryRun.id}/attempts/${recoveryRun.run_attempt}/jobs?per_page=100`,
      token,
      "Exact recovery audit jobs"
    );
    requireSuccessfulRecoveryAuditJobs(jobs, recoveryRun.id, sha);
    return "Both daily protection/drift audits and receipt uploads succeeded";
  });

  await check("post-deploy-independent-audits", () => {
    if (!deployRun || !hostedDastRun || !mcpRun || !recoveryRun) {
      throw new Error("Exact-SHA hosted evidence is incomplete");
    }
    requirePostDeployAuditTiming(
      deployRun,
      hostedDastRun,
      mcpRun,
      recoveryRun
    );
    return "Exact-release DAST, standalone Managed MCP, and operation-bound recovery audits post-date deployment and are under 24 hours old";
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
      !validSubmissionCopyMetadata(copy) ||
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
    const validated = validatedSubmissionThumbnail();
    if (!validated) {
      throw new Error("Owned thumbnail is not a valid 3:2 PNG under 5 MB");
    }
    thumbnail = {
      path: SUBMISSION_THUMBNAIL_PATH,
      ...validated,
    };
    return `${validated.width}x${validated.height}, ${validated.bytes} bytes`;
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
    const oembedUrl = new URL(
      identity.provider === "youtube"
        ? YOUTUBE_OEMBED_ENDPOINT
        : VIMEO_OEMBED_ENDPOINT
    );
    oembedUrl.searchParams.set("url", identity.canonicalUrl);
    if (identity.provider === "youtube") {
      oembedUrl.searchParams.set("format", "json");
    }
    const oembed = asRecord(
      await fetchJson(oembedUrl.href, {}, `${identity.provider} oEmbed`)
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
    const [
      ciRuns,
      codeqlRuns,
      deployRuns,
      hostedDastRuns,
      mcpRuns,
      recoveryRuns,
    ] =
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
          "security-dast.yml",
          "workflow_run",
          "Terminal exact-SHA Hosted DAST runs"
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
      hostedDast: selectSuccessfulRun(
        hostedDastRuns,
        "Hosted DAST",
        "workflow_run",
        sha,
        ".github/workflows/security-dast.yml"
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
    const [
      terminalDeployJobs,
      terminalHostedDastJobs,
      terminalRecoveryJobs,
      terminalHostedDastArtifacts,
    ] =
      await Promise.all([
        githubJson(
          `/repos/${REPOSITORY}/actions/runs/${terminalRuns.deploy.id}/attempts/${terminalRuns.deploy.run_attempt}/jobs?per_page=100`,
          token,
          "Terminal exact Deploy AWS jobs"
        ),
        githubJson(
          `/repos/${REPOSITORY}/actions/runs/${terminalRuns.hostedDast.id}/attempts/${terminalRuns.hostedDast.run_attempt}/jobs?per_page=100`,
          token,
          "Terminal exact Hosted DAST jobs"
        ),
        githubJson(
          `/repos/${REPOSITORY}/actions/runs/${terminalRuns.recovery.id}/attempts/${terminalRuns.recovery.run_attempt}/jobs?per_page=100`,
          token,
          "Terminal exact recovery audit jobs"
        ),
        githubJson(
          `/repos/${REPOSITORY}/actions/runs/${terminalRuns.hostedDast.id}/artifacts?per_page=100`,
          token,
          "Terminal exact Hosted DAST artifacts"
        ),
      ]);
    requireSuccessfulDeployJobs(
      terminalDeployJobs,
      terminalRuns.deploy.id,
      sha
    );
    requireSuccessfulHostedDastJobs(
      terminalHostedDastJobs,
      terminalRuns.hostedDast.id,
      sha
    );
    requireSuccessfulRecoveryAuditJobs(
      terminalRecoveryJobs,
      terminalRuns.recovery.id,
      sha
    );
    const terminalHostedDastArtifact = selectExactHostedDastArtifact(
      terminalHostedDastArtifacts,
      `hosted-dast-${sha}-${terminalRuns.deploy.id}-${terminalRuns.deploy.run_attempt}-${terminalRuns.hostedDast.run_attempt}`,
      terminalRuns.hostedDast
    );
    const terminalHostedDastZapArtifact = selectExactHostedDastArtifact(
      terminalHostedDastArtifacts,
      `zap-baseline-${sha}-${terminalRuns.hostedDast.run_attempt}`,
      terminalRuns.hostedDast
    );
    if (
      !hostedDastArtifact ||
      terminalHostedDastArtifact.id !== hostedDastArtifact.id ||
      terminalHostedDastArtifact.digest !== hostedDastArtifact.digest ||
      !hostedDastZapArtifact ||
      terminalHostedDastZapArtifact.id !== hostedDastZapArtifact.id ||
      terminalHostedDastZapArtifact.digest !==
        hostedDastZapArtifact.digest
    ) {
      throw new Error(
        "Hosted DAST receipt artifact changed while the gate was running"
      );
    }
    requireExactHostedDastReceipt(
      await githubArtifactReceipt(
        terminalHostedDastArtifact,
        token,
        "Terminal exact Hosted DAST receipt"
      ),
      terminalRuns.deploy,
      terminalRuns.hostedDast,
      sha
    );
    await githubArtifactArchive(
      terminalHostedDastZapArtifact,
      token,
      "Terminal exact Hosted DAST ZAP report"
    );
    requirePostDeployAuditTiming(
      terminalRuns.deploy,
      terminalRuns.hostedDast,
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
    ...(Object.keys(selectedArtifacts).length > 0
      ? { selectedArtifacts }
      : {}),
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
