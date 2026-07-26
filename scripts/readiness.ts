// Source-readiness + submission-eligibility report for the CockroachDB AI
// challenge. These are deliberately separate:
//
// - CI blocks on engineering evidence that can be verified from the repository.
// - The report never calls the submission eligible until the unrestricted hosted
//   app, public <3-minute video, final description, and Devpost form exist.
//
// By default this command prints only. CI opts into an artifact with:
//   READINESS_OUTPUT=readiness.json npm run readiness
// Final submission validation additionally sets REQUIRE_SUBMISSION_READY=1 and
// supplies the SUBMISSION_* environment variables below.

import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SOURCE_FLOOR = Number(process.env.SOURCE_READINESS_FLOOR ?? 100);
export const PINNED_NODE_VERSION = "22.23.1";
export const EXPECTED_WORKFLOW_ACTION_REFS = 79;
export const EXPECTED_SETUP_NODE_STEPS = 14;
export const EXPECTED_COCKROACH_IMAGE_REFS = 8;
export const EXPECTED_COMPOSE_IMAGE_REFS = 4;
export const EXPECTED_DOCKERFILE_BASE_REFS = 1;
export const EXPECTED_WORKFLOW_FILES = [
  "benchmark.yml",
  "bootstrap-aws.yml",
  "ci.yml",
  "codeql.yml",
  "database-release.yml",
  "deploy-aws.yml",
  "managed-mcp-audit.yml",
  "recover-aws.yml",
] as const;
const ALLOWED_LOCAL_ACTION_REFS = new Set([
  "./.github/workflows/database-release.yml",
]);
export const GENERATED_ARTIFACT_BASENAMES = [
  "legacy-reconciliation-receipt.json",
  "api-stage-preflight.json",
  "api-stage-proof.json",
  "foundation-s3-access-logging-receipt.json",
  "application-s3-access-logging-preflight.json",
  "application-s3-access-logging-proof.json",
  "application-s3-access-logging-recovery.json",
  "previous-stack-template.yaml",
  "previous-stack-parameters.json",
  "previous-stack-tags.json",
  "bench-clustered.txt",
  "bench-uniform.txt",
  "distribution.txt",
  "server.pid",
] as const;
export const DURABLE_RECOVERY_LOCAL_BASENAMES = [
  "frontend-prestate.json",
  "previous-index.html",
  "previous-live-alias.json",
  "recovery-intent.json",
  "recovery-intent.tar",
  "recovery-snapshot-proof.json",
  "staging-durable-recovery-receipt.json",
  "production-durable-recovery-receipt.json",
  "staging-recovery-execution.json",
  "production-recovery-execution.json",
  "staging-recovery-finalization.json",
  "production-recovery-finalization.json",
  "staging-terminal-receipt-object.json",
  "production-terminal-receipt-object.json",
  "staging-cloudformation-controls-preflight.json",
  "production-cloudformation-controls-preflight.json",
  "staging-cloudformation-controls-terminal.json",
  "production-cloudformation-controls-terminal.json",
  "staging-cloudformation-controls-recovery.json",
  "production-cloudformation-controls-recovery.json",
  "staging-cloudformation-controls-audit.json",
  "production-cloudformation-controls-audit.json",
] as const;
export const DURABLE_RECOVERY_SCRIPT_PATHS = [
  "aws/classify-durable-recovery-source.sh",
  "aws/create-durable-recovery-bundle.sh",
  "aws/download-durable-recovery-bundle.sh",
  "aws/enforce-cloudformation-controls.sh",
  "aws/extract-durable-recovery-bundle.sh",
  "aws/finalize-durable-recovery-receipt.sh",
  "aws/put-durable-recovery-object.sh",
  "aws/recover-durable-environment.sh",
  "aws/recovery-intent-ledger.sh",
  "aws/verify-durable-recovery-bundle.sh",
  "aws/verify-durable-recovery-receipt.sh",
] as const;
const CANONICAL_DEMO_URL =
  "https://d2s5v0o0eg2aaw.cloudfront.net";

export const OFFICIAL_CRITERIA = [
  "Agentic Memory Design",
  "Technical Implementation",
  "Real-World Impact",
  "Production Readiness",
  "Creativity & Originality",
] as const;

export type OfficialCriterion = (typeof OFFICIAL_CRITERIA)[number];
export type CheckStatus = "pass" | "fail";

export interface SourceCheck {
  id: string;
  criterion: OfficialCriterion;
  status: CheckStatus;
  detail: string;
}

export interface EligibilityRequirement {
  id: string;
  status: "complete" | "pending";
  detail: string;
}

export interface ReadinessReport {
  generatedAt: string;
  checks: SourceCheck[];
  judging: Record<
    OfficialCriterion,
    { passed: number; total: number; pct: number }
  >;
  sourceGate: {
    threshold: number;
    passed: number;
    total: number;
    pct: number;
    pass: boolean;
  };
  eligibility: {
    requirements: EligibilityRequirement[];
    complete: number;
    total: number;
    pass: boolean;
  };
  submissionEligible: boolean;
}

function path(rel: string): string {
  return join(ROOT, rel);
}

function has(rel: string): boolean {
  return existsSync(path(rel));
}

function read(rel: string): string {
  return has(rel) ? readFileSync(path(rel), "utf8") : "";
}

export function generatedArtifactPaths(root = ROOT): string[] {
  const blockedDirectories = new Set([
    ".aws-sam",
    "__pycache__",
    "build",
    "coverage",
    "dist",
    "playwright-report",
    "test-results",
  ]);
  const blockedDemoDirectories = new Set(["audio", "clips", "frames"]);
  const blockedBasenames = new Set<string>(GENERATED_ARTIFACT_BASENAMES);
  const blockedDurableRecoveryBasenames = new Set<string>(
    DURABLE_RECOVERY_LOCAL_BASENAMES
  );
  const found: string[] = [];
  const visit = (absolute: string, relative: string): void => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const childRelative = relative
        ? `${relative}/${entry.name}`
        : entry.name;
      if (entry.isDirectory()) {
        // Dependency trees are required to execute this gate and are already
        // protected by .gitignore/secret scanning. Do not recurse through them.
        if (entry.name === "node_modules") continue;
        if (
          blockedDirectories.has(entry.name) ||
          /^(?:staging|production)-(?:durable-recovery-bundle|recovery-verified-[0-9]+-[1-9][0-9]*)$/u.test(
            entry.name
          ) ||
          /^archon-(?:recovery-bundle|durable-recovery)\.[A-Za-z0-9]+$/u.test(
            entry.name
          ) ||
          (relative === "demo/assets" &&
            blockedDemoDirectories.has(entry.name))
        ) {
          found.push(childRelative);
          continue;
        }
        visit(join(absolute, entry.name), childRelative);
      } else if (
        blockedBasenames.has(entry.name) ||
        blockedDurableRecoveryBasenames.has(entry.name) ||
        /^archon-recovery-(?:archive|receipt)\.[A-Za-z0-9]+$/u.test(
          entry.name
        ) ||
        /^(?:staging|production)-(?:durable-)?recovery-[a-z0-9-]+\.json$/u.test(
          entry.name
        ) ||
        /^(?:staging|production)-recovery-(?:roundtrip-)?[0-9]+-[1-9][0-9]*\.tar$/u.test(
          entry.name
        ) ||
        /\.(?:mp4|pyc)$/iu.test(entry.name) ||
        /^(?:readiness|database-release-receipt|legacy-reconciliation-receipt|managed-mcp(?:-[a-z0-9-]+)?-receipt|deployment-receipt[a-z0-9-]*|[a-z0-9-]+-deployment-receipt)\.json$/iu.test(
          entry.name
        )
      ) {
        found.push(childRelative);
      }
    }
  };
  visit(root, "");
  return found;
}

export interface WorkflowSource {
  name: string;
  source: string;
}

export function repositoryWorkflowSources(
  root = ROOT
): WorkflowSource[] {
  const directory = join(root, ".github", "workflows");
  if (!existsSync(directory)) return [];
  const entries = readdirSync(directory, { withFileTypes: true });
  if (
    entries.some(
      (entry) =>
        entry.isSymbolicLink() &&
        /\.(?:yml|yaml)$/iu.test(entry.name)
    )
  ) {
    return [{ name: "__unsafe_workflow_symlink__", source: "" }];
  }
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        /\.(?:yml|yaml)$/iu.test(entry.name)
    )
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => ({
      name: entry.name,
      source: readFileSync(join(directory, entry.name), "utf8"),
    }));
}

interface RepositorySource {
  basename: string;
  source: string;
}

function repositorySourceFiles(
  predicate: (basename: string) => boolean,
  root = ROOT
): RepositorySource[] {
  const matches: Array<{ absolute: string; basename: string }> = [];
  let unsafeSymlink = false;
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        unsafeSymlink = true;
      } else if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile() && predicate(entry.name)) {
        matches.push({ absolute, basename: entry.name });
      }
    }
  };
  visit(root);
  if (unsafeSymlink) return [];
  return matches
    .sort((left, right) => left.absolute.localeCompare(right.absolute))
    .map(({ absolute, basename }) => ({
      basename,
      source: readFileSync(absolute, "utf8"),
    }));
}

function parseYamlMap(
  source: string
): Map<unknown, unknown> | undefined {
  try {
    const document = parseDocument(source, {
      schema: "core",
      strict: true,
      uniqueKeys: true,
    });
    if (
      document.errors.length > 0 ||
      document.warnings.length > 0
    ) {
      return undefined;
    }
    const value: unknown = document.toJS({
      mapAsMap: true,
      maxAliasCount: 0,
    });
    return value instanceof Map ? value : undefined;
  } catch {
    return undefined;
  }
}

export function repositoryDockerComposeSources(
  root = ROOT
): string[] {
  return repositorySourceFiles(
    (basename) => /\.ya?ml$/iu.test(basename),
    root
  )
    .filter(({ basename, source }) => {
      if (
        /^(?:docker-compose|compose)(?:\..+)?\.ya?ml$/iu.test(
          basename
        )
      ) {
        return true;
      }
      return parseYamlMap(source)?.get("services") instanceof Map;
    })
    .map(({ source }) => source);
}

export function repositoryDockerfileSources(
  root = ROOT
): string[] {
  return repositorySourceFiles(
    (basename) =>
      /^Dockerfile(?:\..+)?$/iu.test(basename) ||
      /\.Dockerfile$/iu.test(basename),
    root
  ).map(({ source }) => source);
}

interface WorkflowUse {
  ref: unknown;
  inputs: unknown;
}

interface ParsedWorkflow {
  root: Map<unknown, unknown>;
  uses: WorkflowUse[];
  runs: unknown[];
}

function collectWorkflowSemantics(
  value: unknown,
  uses: WorkflowUse[],
  runs: unknown[]
): boolean {
  if (value instanceof Map) {
    for (const key of value.keys()) {
      if (typeof key !== "string") return false;
    }
    if (value.has("uses")) {
      uses.push({
        ref: value.get("uses"),
        inputs: value.get("with"),
      });
    }
    if (value.has("run")) runs.push(value.get("run"));
    for (const child of value.values()) {
      if (!collectWorkflowSemantics(child, uses, runs)) return false;
    }
    return true;
  }
  if (Array.isArray(value)) {
    for (const child of value) {
      if (!collectWorkflowSemantics(child, uses, runs)) return false;
    }
    return true;
  }
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function parseWorkflow(source: string): ParsedWorkflow | undefined {
  const root = parseYamlMap(source);
  if (!root) return undefined;
  const uses: WorkflowUse[] = [];
  const runs: unknown[] = [];
  return collectWorkflowSemantics(root, uses, runs)
    ? { root, uses, runs }
    : undefined;
}

function actionIdentifier(ref: string): string | undefined {
  const separator = ref.lastIndexOf("@");
  return separator > 0
    ? ref.slice(0, separator).toLowerCase()
    : undefined;
}

function setupNodeVersionsFromUses(
  uses: WorkflowUse[]
): Array<string | undefined> {
  return uses
    .filter(
      ({ ref }) =>
        typeof ref === "string" &&
        actionIdentifier(ref) === "actions/setup-node"
    )
    .map(({ inputs }) => {
      if (!(inputs instanceof Map)) return undefined;
      for (const key of inputs.keys()) {
        if (typeof key !== "string") return undefined;
      }
      const version = inputs.get("node-version");
      return typeof version === "string" ? version : undefined;
    });
}

export function setupNodeVersions(
  workflowSource: string
): Array<string | undefined> {
  const parsed = parseWorkflow(workflowSource);
  return parsed ? setupNodeVersionsFromUses(parsed.uses) : [];
}

export function allSetupNodeStepsPinned(
  sources: string[],
  expected = PINNED_NODE_VERSION,
  expectedSteps = EXPECTED_SETUP_NODE_STEPS
): boolean {
  const parsed = sources.map(parseWorkflow);
  if (parsed.some((workflow) => workflow === undefined)) return false;
  const versions = parsed.flatMap((workflow) =>
    setupNodeVersionsFromUses(workflow?.uses ?? [])
  );
  return (
    versions.length === expectedSteps &&
    versions.every((version) => version === expected)
  );
}

export function allWorkflowActionsPinned(
  sources: string[],
  expectedRefs = EXPECTED_WORKFLOW_ACTION_REFS
): boolean {
  const parsed = sources.map(parseWorkflow);
  if (parsed.some((workflow) => workflow === undefined)) return false;
  const refs = parsed.flatMap(
    (workflow) => workflow?.uses.map(({ ref }) => ref) ?? []
  );
  return (
    refs.length === expectedRefs &&
    refs.every((ref) => {
      if (typeof ref !== "string") return false;
      if (ref.startsWith("./")) {
        return ALLOWED_LOCAL_ACTION_REFS.has(ref);
      }
      if (ref.startsWith("docker://")) {
        return /@sha256:[a-f0-9]{64}$/u.test(ref);
      }
      const separator = ref.lastIndexOf("@");
      return (
        separator > 0 &&
        /^[a-f0-9]{40}$/u.test(ref.slice(separator + 1))
      );
    })
  );
}

function composeImageRefs(
  source: string
): Array<unknown> | undefined {
  const root = parseYamlMap(source);
  const services = root?.get("services");
  if (!(services instanceof Map)) return undefined;
  const images: unknown[] = [];
  for (const [serviceName, service] of services) {
    if (
      typeof serviceName !== "string" ||
      !(service instanceof Map)
    ) {
      return undefined;
    }
    for (const key of service.keys()) {
      if (typeof key !== "string") return undefined;
    }
    if (!service.has("image") || service.has("build")) {
      return undefined;
    }
    images.push(service.get("image"));
  }
  return images;
}

export function allComposeImagesPinned(
  sources: string[],
  expectedRefs = EXPECTED_COMPOSE_IMAGE_REFS
): boolean {
  const parsed = sources.map(composeImageRefs);
  if (parsed.some((images) => images === undefined)) return false;
  const refs = parsed.flatMap((images) => images ?? []);
  return (
    refs.length === expectedRefs &&
    refs.every(
      (ref) =>
        typeof ref === "string" &&
        /^[^${}\s]+@sha256:[a-f0-9]{64}$/u.test(ref)
    )
  );
}

function stripShellComment(line: string): string {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
    } else if (
      character === "#" &&
      (index === 0 || /[\s;|&()]/u.test(line[index - 1]))
    ) {
      return line.slice(0, index);
    }
  }
  return line;
}

function shellLogicalCommands(source: string): string[] {
  const commands: string[] = [];
  let pending = "";
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = stripShellComment(rawLine).trim();
    if (!line && !pending) continue;
    const continued = /\\\s*$/u.test(line);
    const fragment = line.replace(/\\\s*$/u, "").trim();
    pending = `${pending}${pending && fragment ? " " : ""}${fragment}`;
    if (!continued) {
      if (pending) commands.push(pending);
      pending = "";
    }
  }
  if (pending) commands.push(pending);
  return commands;
}

function cockroachRefsFromWorkflow(
  source: string
): string[] | undefined {
  const parsed = parseWorkflow(source);
  if (!parsed) return undefined;
  const refs: string[] = [];
  for (const run of parsed.runs) {
    if (typeof run !== "string") return undefined;
    for (const command of shellLogicalCommands(run)) {
      const invocations = [
        ...command.matchAll(/\bdocker\s+run\b/gu),
      ].length;
      if (invocations === 0) continue;
      if (invocations !== 1) return undefined;
      const canonical = command.match(
        /^docker\s+run\s+-d\s+--name\s+crdb\s+-p\s+26257:26257(?:\s+-p\s+8080:8080)?\s+(cockroachdb\/cockroach:[^\s"'\\]+)\s+start-single-node\s+--insecure$/u
      );
      if (!canonical) return undefined;
      refs.push(canonical[1]);
    }
  }
  return refs;
}

export interface CockroachImageSources {
  workflows: string[];
  compose: string[];
  dockerfiles: string[];
}

export function allCockroachImagesPinned(
  sources: CockroachImageSources,
  expectedRefs = EXPECTED_COCKROACH_IMAGE_REFS
): boolean {
  const workflowRefs = sources.workflows.map(
    cockroachRefsFromWorkflow
  );
  const composeRefs = sources.compose.map(composeImageRefs);
  if (
    workflowRefs.some((refs) => refs === undefined) ||
    composeRefs.some((refs) => refs === undefined)
  ) {
    return false;
  }
  const refs = [
    ...workflowRefs.flatMap((items) => items ?? []),
    ...composeRefs
      .flatMap((items) => items ?? [])
      .filter((ref): ref is string => typeof ref === "string")
      .filter((ref) => ref.includes("cockroachdb/cockroach")),
    ...sources.dockerfiles
      .flatMap(dockerfileBaseRefs)
      .filter((ref) => ref.includes("cockroachdb/cockroach")),
  ];
  return (
    refs.length === expectedRefs &&
    refs.every((ref) =>
      /^cockroachdb\/cockroach:v26\.2\.3@sha256:[a-f0-9]{64}$/u.test(
        ref
      )
    )
  );
}

function dockerfileBaseRefs(source: string): string[] {
  return [
    ...source.matchAll(
      /^\s*FROM(?:\s+--platform=\S+)?\s+(\S+)/gimu
    ),
  ].map((match) => match[1]);
}

export function allDockerfileBasesPinned(
  sources: string[],
  expectedRefs = EXPECTED_DOCKERFILE_BASE_REFS
): boolean {
  const refs = sources.flatMap(dockerfileBaseRefs);
  return (
    sources.length > 0 &&
    sources.every((source) => dockerfileBaseRefs(source).length > 0) &&
    refs.length === expectedRefs &&
    refs.every((ref) => /@sha256:[a-f0-9]{64}$/u.test(ref))
  );
}

function workflowTriggerNames(
  parsed: ParsedWorkflow
): string[] | undefined {
  const trigger = parsed.root.get("on");
  if (typeof trigger === "string") return [trigger];
  if (
    Array.isArray(trigger) &&
    trigger.every((event) => typeof event === "string")
  ) {
    return trigger;
  }
  if (trigger instanceof Map) {
    const names = [...trigger.keys()];
    return names.every((event) => typeof event === "string")
      ? (names as string[])
      : undefined;
  }
  return undefined;
}

function hasExactMainPush(trigger: Map<unknown, unknown>): boolean {
  const push = trigger.get("push");
  if (!(push instanceof Map) || push.size !== 1) return false;
  const branches = push.get("branches");
  return (
    Array.isArray(branches) &&
    branches.length === 1 &&
    branches[0] === "main"
  );
}

export function hasExactCiTrigger(source: string): boolean {
  const parsed = parseWorkflow(source);
  const trigger = parsed?.root.get("on");
  if (!(trigger instanceof Map) || trigger.size !== 2) return false;
  return (
    hasExactMainPush(trigger) &&
    trigger.get("pull_request") === null
  );
}

function hasExactCodeqlTrigger(source: string): boolean {
  const parsed = parseWorkflow(source);
  const trigger = parsed?.root.get("on");
  if (!(trigger instanceof Map) || trigger.size !== 3) return false;
  const schedule = trigger.get("schedule");
  if (!Array.isArray(schedule) || schedule.length !== 1) return false;
  const entry = schedule[0];
  return (
    hasExactMainPush(trigger) &&
    trigger.get("pull_request") === null &&
    entry instanceof Map &&
    entry.size === 1 &&
    entry.get("cron") === "27 3 * * 1"
  );
}

export function hasExactAwsRecoveryTrigger(source: string): boolean {
  const parsed = parseWorkflow(source);
  const trigger = parsed?.root.get("on");
  if (!(trigger instanceof Map) || trigger.size !== 3) return false;

  const workflowRun = trigger.get("workflow_run");
  const schedule = trigger.get("schedule");
  if (
    !(workflowRun instanceof Map) ||
    workflowRun.size !== 3 ||
    !Array.isArray(schedule) ||
    schedule.length !== 2
  ) {
    return false;
  }
  const workflows = workflowRun.get("workflows");
  const branches = workflowRun.get("branches");
  const types = workflowRun.get("types");
  const scheduleCrons = schedule
    .map((entry) =>
      entry instanceof Map && entry.size === 1
        ? entry.get("cron")
        : null
    )
    .filter((cron): cron is string => typeof cron === "string")
    .sort();
  return (
    Array.isArray(workflows) &&
    workflows.length === 1 &&
    workflows[0] === "Deploy AWS" &&
    Array.isArray(branches) &&
    branches.length === 1 &&
    branches[0] === "main" &&
    Array.isArray(types) &&
    types.length === 1 &&
    types[0] === "completed" &&
    scheduleCrons.length === 2 &&
    scheduleCrons[0] === "17 4 * * *" &&
    scheduleCrons[1] === "7,22,37,52 * * * *" &&
    trigger.get("workflow_dispatch") === null
  );
}

export function hasExactAwsDeliveryConcurrency(source: string): boolean {
  const parsed = parseWorkflow(source);
  const concurrency = parsed?.root.get("concurrency");
  return (
    concurrency instanceof Map &&
    concurrency.size === 3 &&
    concurrency.get("group") === "aws-production-delivery" &&
    concurrency.get("cancel-in-progress") === false &&
    concurrency.get("queue") === "max"
  );
}

export function hasUniqueCiTriggerOwnership(
  workflows: WorkflowSource[]
): boolean {
  const names = workflows
    .map(({ name }) => name)
    .sort((left, right) => left.localeCompare(right));
  if (new Set(names).size !== names.length) return false;
  if (
    names.length !== EXPECTED_WORKFLOW_FILES.length ||
    names.some(
      (name, index) => name !== EXPECTED_WORKFLOW_FILES[index]
    )
  ) {
    return false;
  }
  const expectedEvents = new Map<string, string[]>([
    ["benchmark.yml", ["workflow_dispatch"]],
    ["bootstrap-aws.yml", ["workflow_dispatch"]],
    ["ci.yml", ["pull_request", "push"]],
    ["codeql.yml", ["pull_request", "push", "schedule"]],
    [
      "database-release.yml",
      ["workflow_call", "workflow_dispatch"],
    ],
    ["deploy-aws.yml", ["workflow_run"]],
    ["managed-mcp-audit.yml", ["workflow_dispatch"]],
    [
      "recover-aws.yml",
      ["schedule", "workflow_dispatch", "workflow_run"],
    ],
  ]);
  for (const workflow of workflows) {
    const parsed = parseWorkflow(workflow.source);
    if (!parsed) return false;
    const triggers = workflowTriggerNames(parsed);
    if (!triggers) return false;
    const expected = expectedEvents.get(workflow.name);
    const actual = [...triggers].sort((left, right) =>
      left.localeCompare(right)
    );
    if (
      !expected ||
      actual.length !== expected.length ||
      actual.some((event, index) => event !== expected[index])
    ) {
      return false;
    }
  }
  const ci = workflows.find(({ name }) => name === "ci.yml");
  const codeql = workflows.find(({ name }) => name === "codeql.yml");
  const recovery = workflows.find(
    ({ name }) => name === "recover-aws.yml"
  );
  return (
    ci !== undefined &&
    codeql !== undefined &&
    recovery !== undefined &&
    hasExactCiTrigger(ci.source) &&
    hasExactCodeqlTrigger(codeql.source) &&
    hasExactAwsRecoveryTrigger(recovery.source)
  );
}

export function isSubmissionEligible(
  sourceGatePass: boolean,
  eligibilityPass: boolean
): boolean {
  return sourceGatePass && eligibilityPass;
}

function contains(rel: string, pattern: RegExp): boolean {
  return pattern.test(read(rel));
}

function sourceCheck(
  id: string,
  criterion: OfficialCriterion,
  condition: boolean,
  passed: string,
  failed: string
): SourceCheck {
  return {
    id,
    criterion,
    status: condition ? "pass" : "fail",
    detail: condition ? passed : failed,
  };
}

function sourceChecks(): SourceCheck[] {
  const schema = read("src/db/schema.sql");
  const ci = read(".github/workflows/ci.yml");
  const deploy = read(".github/workflows/deploy-aws.yml");
  const recoveryWorkflow = read(".github/workflows/recover-aws.yml");
  const foundationWorkflow = read(
    ".github/workflows/bootstrap-aws.yml"
  );
  const lambdaTemplate = read("aws/template.yaml");
  const deliveryBootstrap = read("aws/bootstrap-oidc.yaml");
  const foundationPromotionRole =
    deliveryBootstrap.match(
      /(?:^|\r?\n)  FoundationPromotionRole:\r?\n[\s\S]*?(?=\r?\n  StagingDeployRole:\r?\n|$)/u
    )?.[0] ?? "";
  const environmentDeployTrustBlocks = [
    {
      environment: "staging",
      source:
        deliveryBootstrap.match(
          /(?:^|\r?\n)  StagingDeployRole:\r?\n[\s\S]*?\r?\n      Policies:/u
        )?.[0] ?? "",
    },
    {
      environment: "production",
      source:
        deliveryBootstrap.match(
          /(?:^|\r?\n)  ProductionDeployRole:\r?\n[\s\S]*?\r?\n      Policies:/u
        )?.[0] ?? "",
    },
  ];
  const apiStageProof = read("aws/prove-api-stage-controls.sh");
  const s3AccessLoggingProof = read(
    "aws/prove-s3-access-logging.sh"
  );
  const applicationS3AccessLoggingProof = read(
    "aws/prove-application-s3-access-logging.sh"
  );
  const bootstrapStackPolicy = read(
    "aws/bootstrap-stack-policy.json"
  );
  const s3AccessLoggingTests = read(
    "tests/s3-access-logging.test.ts"
  );
  const stackRestore = read("aws/restore-cloudformation-stack.sh");
  const greenfieldCleanup = read("aws/delete-greenfield-stack.sh");
  const recoverySnapshot = read("aws/prove-recovery-snapshot.sh");
  const samStackTagSerializer = read("aws/serialize-sam-stack-tags.sh");
  const awsRecoveryTests = read("tests/aws-recovery-scripts.test.ts");
  const durableRecoveryClassifier = read(
    "aws/classify-durable-recovery-source.sh"
  );
  const durableRecoveryBundleCreator = read(
    "aws/create-durable-recovery-bundle.sh"
  );
  const durableRecoveryDownloader = read(
    "aws/download-durable-recovery-bundle.sh"
  );
  const durableRecoveryExtractor = read(
    "aws/extract-durable-recovery-bundle.sh"
  );
  const cloudFormationControls = read(
    "aws/enforce-cloudformation-controls.sh"
  );
  const durableRecoveryFinalizer = read(
    "aws/finalize-durable-recovery-receipt.sh"
  );
  const durableRecoveryObjectPublisher = read(
    "aws/put-durable-recovery-object.sh"
  );
  const durableRecoveryExecutor = read(
    "aws/recover-durable-environment.sh"
  );
  const durableRecoveryLedger = read("aws/recovery-intent-ledger.sh");
  const durableRecoveryVerifier = read(
    "aws/verify-durable-recovery-bundle.sh"
  );
  const durableRecoveryReceiptVerifier = read(
    "aws/verify-durable-recovery-receipt.sh"
  );
  const durableRecoveryScriptSources = DURABLE_RECOVERY_SCRIPT_PATHS.map(
    (scriptPath) => read(scriptPath)
  );
  const durableRecoveryTests = read("tests/durable-recovery.test.ts");
  const recoveryWatchdogTests = read(
    "tests/recovery-watchdog.test.ts"
  );
  const cloudFormationControlsTests = read(
    "tests/cloudformation-controls.test.ts"
  );
  const gitignore = read(".gitignore");
  const makefile = read("Makefile");
  const narrator = read("src/agents/narrator.ts");
  const handler = read("src/http/handler.ts");
  const memory = read("src/memory/memory.ts");
  const packageSource = read("package.json");
  const managedMcpAudit = read("scripts/cloud-mcp-audit.ts");
  const managedMcpAuditTests = read("tests/cloud-mcp-audit.test.ts");
  const managedMcpEvidenceDocs = [
    read("README.md"),
    read("docs/TOOLS.md"),
    read("docs/MANAGED_MCP_SMOKE.md"),
  ];
  const staleManagedMcpEvidence =
    /had not yet been recorded|becomes live evidence only|awaits a new protected|new protected pass is required/iu;
  const managedMcpWorkflow = read(
    ".github/workflows/managed-mcp-audit.yml"
  );
  const readinessJob =
    ci.match(
      /(?:^|\r?\n)  readiness:\r?\n[\s\S]*?(?=\r?\n  [A-Za-z0-9_-]+:\r?\n|$)/u
    )?.[0] ?? "";
  const managedMcpDeployJob =
    deploy.match(
      /(?:^|\r?\n)  managed-mcp-production-audit:\r?\n[\s\S]*?(?=\r?\n  [A-Za-z0-9_-]+:\r?\n|$)/u
    )?.[0] ?? "";
  const databaseRelease = read("scripts/verify-database-release.ts");
  const databaseReleaseWorkflow = read(
    ".github/workflows/database-release.yml"
  );
  const demoReconciliation = read(
    "src/memory/demo-reconciliation.ts"
  );
  const reconciliationRehearsal = read(
    "scripts/reconcile-demo-memory-rehearsal.ts"
  );
  const scopedServingQueryVerifier =
    databaseRelease.match(
      /async function verifyScopedServingQueryCanaries[\s\S]*?(?=\r?\nasync function verifyRuntimeCspannPath)/u
    )?.[0] ?? "";
  const canaryDeploymentPreference =
    lambdaTemplate.match(
      /AutoPublishAlias:\s*live[\s\S]*?DeploymentPreference:[\s\S]*?(?=\r?\n      Environment:)/u
    )?.[0] ?? "";
  const candidateCanaryAlarm =
    lambdaTemplate.match(
      /  LambdaCanaryErrorAlarm:[\s\S]*?(?=\r?\n  LambdaThrottleAlarm:)/u
    )?.[0] ?? "";
  const operationalLambdaAlarm =
    lambdaTemplate.match(
      /  LambdaErrorAlarm:[\s\S]*?(?=\r?\n  LambdaCanaryErrorAlarm:)/u
    )?.[0] ?? "";
  const canaryDeployBlocks = [
    deploy.match(
      /- name: Deploy staging with recovery-safe SAM canary[\s\S]*?(?=\r?\n      - name: Resolve public, non-secret stack outputs)/u
    )?.[0] ?? "",
    deploy.match(
      /- name: Deploy production with recovery-safe SAM canary[\s\S]*?(?=\r?\n      - name: Resolve public, non-secret stack outputs)/u
    )?.[0] ?? "",
  ];
  const stageRoutingProofPositions = [
    ...deploy.matchAll(
      /name: Prove transformed and live API stage routing before frontend mutation/gu
    ),
  ].map((match) => match.index ?? -1);
  const frontendPublishPositions = [
    ...deploy.matchAll(
      /name: Publish the frontend and invalidate CloudFront/gu
    ),
  ].map((match) => match.index ?? -1);
  const stageRoutingProofsPrecedeFrontend =
    stageRoutingProofPositions.length === 2 &&
    frontendPublishPositions.length === 2 &&
    stageRoutingProofPositions.every(
      (position, index) => position < frontendPublishPositions[index]
    );
  const applicationS3PreflightPositions = [
    ...deploy.matchAll(
      /name: Preflight application S3 access logging before stack mutation/gu
    ),
  ].map((match) => match.index ?? -1);
  const applicationS3RecheckPositions = [
    ...deploy.matchAll(
      /name: Re-prove the application S3 preflight immediately before SAM/gu
    ),
  ].map((match) => match.index ?? -1);
  const applicationDeployPositions = [
    ...deploy.matchAll(
      /name: Deploy (?:staging|production) with recovery-safe SAM canary/gu
    ),
  ].map((match) => match.index ?? -1);
  const reconciliationPositions = [
    ...deploy.matchAll(
      /name: Reconcile an interrupted same-run (?:staging|production) greenfield recovery/gu
    ),
  ].map((match) => match.index ?? -1);
  const postReconciliationCredentialRefreshPositions = [
    ...deploy.matchAll(
      /name: Refresh short-lived AWS credentials after (?:staging|production) reconciliation/gu
    ),
  ].map((match) => match.index ?? -1);
  const reconciliationCredentialsArePhaseBounded =
    reconciliationPositions.length === 2 &&
    postReconciliationCredentialRefreshPositions.length === 2 &&
    applicationS3PreflightPositions.length === 2 &&
    reconciliationPositions.every((position, index) => {
      const refreshPosition =
        postReconciliationCredentialRefreshPositions[index];
      const preflightPosition = applicationS3PreflightPositions[index];
      return (
        position < refreshPosition &&
        refreshPosition < preflightPosition &&
        (
          deploy
            .slice(position, refreshPosition)
            .match(/\r?\n      - name:/gu) ?? []
        ).length === 0 &&
        (
          deploy
            .slice(refreshPosition, preflightPosition)
            .match(/\r?\n      - name:/gu) ?? []
        ).length === 0
      );
    }) &&
    (deploy.match(/role-duration-seconds:\s+3600/gu) ?? []).length ===
      12;
  const durableRecoveryArmPositions = [
    ...deploy.matchAll(
      /name: Persist and arm the immutable (?:staging|production) recovery intent/gu
    ),
  ].map((match) => match.index ?? -1);
  const durableRecoveryArmBlocks = [
    deploy.match(
      /- name: Persist and arm the immutable staging recovery intent[\s\S]*?(?=\r?\n      - name: Deploy staging with recovery-safe SAM canary)/u
    )?.[0] ?? "",
    deploy.match(
      /- name: Persist and arm the immutable production recovery intent[\s\S]*?(?=\r?\n      - name: Deploy production with recovery-safe SAM canary)/u
    )?.[0] ?? "",
  ];
  const durableRecoveryArmsPrecedeSam =
    durableRecoveryArmPositions.length === 2 &&
    applicationDeployPositions.length === 2 &&
    durableRecoveryArmPositions.every(
      (position, index) => position < applicationDeployPositions[index]
    );
  const samCredentialRefreshPositions = [
    ...deploy.matchAll(
      /name: Refresh short-lived AWS credentials for (?:staging|production) SAM deployment/gu
    ),
  ].map((match) => match.index ?? -1);
  const samCredentialsRefreshImmediatelyBeforeDeploy =
    samCredentialRefreshPositions.length === 2 &&
    applicationDeployPositions.length === 2 &&
    samCredentialRefreshPositions.every((position, index) => {
      const deployPosition = applicationDeployPositions[index];
      return (
        position < deployPosition &&
        (
          deploy
            .slice(position, deployPosition)
            .match(/\r?\n      - name:/gu) ?? []
        ).length === 0
      );
    });
  const postSamCredentialRefreshPositions = [
    ...deploy.matchAll(
      /name: Refresh short-lived AWS credentials after (?:staging|production) SAM deployment/gu
    ),
  ].map((match) => match.index ?? -1);
  const stackOutputPositions = [
    ...deploy.matchAll(
      /name: Resolve public, non-secret stack outputs/gu
    ),
  ].map((match) => match.index ?? -1);
  const samCredentialsRefreshImmediatelyAfterDeploy =
    applicationDeployPositions.length === 2 &&
    postSamCredentialRefreshPositions.length === 2 &&
    stackOutputPositions.length === 2 &&
    postSamCredentialRefreshPositions.every((position, index) => {
      const deployPosition = applicationDeployPositions[index];
      const stackOutputPosition = stackOutputPositions[index];
      return (
        deployPosition < position &&
        position < stackOutputPosition &&
        (
          deploy
            .slice(position, stackOutputPosition)
            .match(/\r?\n      - name:/gu) ?? []
        ).length === 0
      );
    });
  const applicationS3VerifyPositions = [
    ...deploy.matchAll(
      /name: Prove live application S3 access logging before frontend mutation/gu
    ),
  ].map((match) => match.index ?? -1);
  const applicationS3ProofsOrdered =
    applicationS3PreflightPositions.length === 2 &&
    applicationS3RecheckPositions.length === 2 &&
    applicationDeployPositions.length === 2 &&
    applicationS3VerifyPositions.length === 2 &&
    applicationS3PreflightPositions.every(
      (position, index) =>
        position < applicationS3RecheckPositions[index] &&
        applicationS3RecheckPositions[index] <
          applicationDeployPositions[index] &&
        applicationDeployPositions[index] <
          applicationS3VerifyPositions[index] &&
        applicationS3VerifyPositions[index] <
          stageRoutingProofPositions[index] &&
        applicationS3VerifyPositions[index] <
          frontendPublishPositions[index]
    );
  const terminalReceiptPositions = [
    ...deploy.matchAll(
      /name: Build and validate sanitized (?:staging|production) deployment receipt/gu
    ),
  ].map((match) => match.index ?? -1);
  const terminalReceiptBlocks = [
    deploy.match(
      /- name: Build and validate sanitized staging deployment receipt[\s\S]*?(?=\r?\n      - name: Commit the receipt-bound staging recovery intent)/u
    )?.[0] ?? "",
    deploy.match(
      /- name: Build and validate sanitized production deployment receipt[\s\S]*?(?=\r?\n      - name: Commit the receipt-bound production recovery intent)/u
    )?.[0] ?? "",
  ];
  const recoveryCredentialPositions = [
    ...deploy.matchAll(
      /name: Refresh short-lived AWS credentials for (?:staging|production) recovery/gu
    ),
  ].map((match) => match.index ?? -1);
  const receiptUploadPositions = [
    ...deploy.matchAll(
      /name: Upload (?:staging|production) receipt/gu
    ),
  ].map((match) => match.index ?? -1);
  const applicationS3TerminallyOrdered =
    terminalReceiptPositions.length === 2 &&
    recoveryCredentialPositions.length === 2 &&
    receiptUploadPositions.length === 2 &&
    terminalReceiptPositions.every(
      (position, index) =>
        frontendPublishPositions[index] < position &&
        position < recoveryCredentialPositions[index] &&
        recoveryCredentialPositions[index] < receiptUploadPositions[index]
    );
  const durableRecoveryCommitPositions = [
    ...deploy.matchAll(
      /name: Commit the receipt-bound (?:staging|production) recovery intent/gu
    ),
  ].map((match) => match.index ?? -1);
  const durableRecoveryCommitBlocks = [
    deploy.match(
      /- name: Commit the receipt-bound staging recovery intent[\s\S]*?(?=\r?\n      - name: Refresh short-lived AWS credentials for staging recovery)/u
    )?.[0] ?? "",
    deploy.match(
      /- name: Commit the receipt-bound production recovery intent[\s\S]*?(?=\r?\n      - name: Refresh short-lived AWS credentials for production recovery)/u
    )?.[0] ?? "",
  ];
  const durableRecoveryCommitsAreTerminallyOrdered =
    terminalReceiptPositions.length === 2 &&
    durableRecoveryCommitPositions.length === 2 &&
    recoveryCredentialPositions.length === 2 &&
    terminalReceiptPositions.every(
      (position, index) =>
        position < durableRecoveryCommitPositions[index] &&
        durableRecoveryCommitPositions[index] <
          recoveryCredentialPositions[index]
    );
  const watchdogCredentialRefreshPositions = [
    ...recoveryWorkflow.matchAll(
      /name: Refresh credentials for the full (?:staging|production) recovery cycle/gu
    ),
  ].map((match) => match.index ?? -1);
  const watchdogExecutorPositions = [
    ...recoveryWorkflow.matchAll(
      /name: Restore and prove the exact (?:staging|production) prestate/gu
    ),
  ].map((match) => match.index ?? -1);
  const watchdogTerminalBlocks = [
    recoveryWorkflow.match(
      /- name: Restore and prove the exact staging prestate[\s\S]*?(?=\r?\n      - name: Upload supplemental staging recovery receipt)/u
    )?.[0] ?? "",
    recoveryWorkflow.match(
      /- name: Restore and prove the exact production prestate[\s\S]*?(?=\r?\n      - name: Upload supplemental production recovery receipt)/u
    )?.[0] ?? "",
  ];
  const watchdogRefreshesImmediatelyPrecedeExecution =
    watchdogCredentialRefreshPositions.length === 2 &&
    watchdogExecutorPositions.length === 2 &&
    watchdogCredentialRefreshPositions.every((position, index) => {
      const executorPosition = watchdogExecutorPositions[index];
      return (
        position < executorPosition &&
        (
          recoveryWorkflow
            .slice(position, executorPosition)
            .match(/\r?\n      - name:/gu) ?? []
        ).length === 0
      );
    });
  const watchdogTerminalJsonGatesAreOrdered =
    watchdogTerminalBlocks.every((block, index) => {
      const environment = index === 0 ? "staging" : "production";
      const executionInputs = block.indexOf(
        'for output in "$receipt" "$execution"; do'
      );
      const executionGate = block.indexOf("jq -e -s", executionInputs);
      const controlStep = block.indexOf(
        `name: Enforce exact ${environment} post-recovery stack controls`
      );
      const controlGate = block.indexOf("jq -e -s", controlStep);
      const finalizerStep = block.indexOf(
        `name: Persist receipt and mark ${environment} recovered atomically`
      );
      const finalizerInputs = block.indexOf(
        'for input in "$receipt" "$execution" "$controls"; do',
        finalizerStep
      );
      const finalizerInputGate = block.indexOf(
        "jq -e -s",
        finalizerInputs
      );
      const finalizerCommand = block.indexOf(
        "bash aws/finalize-durable-recovery-receipt.sh",
        finalizerInputGate
      );
      const finalizationGate = block.indexOf(
        "jq -e -s",
        finalizerCommand
      );
      return (
        block.length > 0 &&
        (
          block.match(
            /length == 1 and \(\.\[0\] \| type == "object"\)/gu
          ) ?? []
        ).length === 4 &&
        executionInputs >= 0 &&
        executionInputs < executionGate &&
        executionGate < controlStep &&
        controlStep < controlGate &&
        controlGate < finalizerStep &&
        finalizerStep < finalizerInputs &&
        finalizerInputs < finalizerInputGate &&
        finalizerInputGate < finalizerCommand &&
        finalizerCommand < finalizationGate
      );
    });
  const cloudFormationPreflightPositions = [
    ...deploy.matchAll(
      /name: Enforce (?:staging|production) stack protection and fresh pre-deploy drift gate/gu
    ),
  ].map((match) => match.index ?? -1);
  const recoveryControlPositions = [
    ...recoveryWorkflow.matchAll(
      /name: Enforce exact (?:staging|production) post-recovery stack controls/gu
    ),
  ].map((match) => match.index ?? -1);
  const recoveryFinalizerPositions = [
    ...recoveryWorkflow.matchAll(
      /name: Persist receipt and mark (?:staging|production) recovered atomically/gu
    ),
  ].map((match) => match.index ?? -1);
  const cloudFormationControlsAreOrdered =
    cloudFormationPreflightPositions.length === 2 &&
    durableRecoveryArmPositions.length === 2 &&
    terminalReceiptPositions.length === 2 &&
    durableRecoveryCommitPositions.length === 2 &&
    watchdogExecutorPositions.length === 2 &&
    recoveryControlPositions.length === 2 &&
    recoveryFinalizerPositions.length === 2 &&
    cloudFormationPreflightPositions.every(
      (position, index) => position < durableRecoveryArmPositions[index]
    ) &&
    terminalReceiptPositions.every(
      (position, index) => position < durableRecoveryCommitPositions[index]
    ) &&
    watchdogExecutorPositions.every(
      (position, index) =>
        position < recoveryControlPositions[index] &&
        recoveryControlPositions[index] < recoveryFinalizerPositions[index]
    );
  const fullRecallSmokeBlocks = [
    deploy.match(
      /- name: Smoke the same-origin application and real recall path[\s\S]*?(?=\r?\n      - name: Hosted Chromium judge journey on staging)/u
    )?.[0] ?? "",
    deploy.match(
      /- name: Smoke production through CloudFront[\s\S]*?(?=\r?\n      - name: Hosted Chromium judge journey on production)/u
    )?.[0] ?? "",
  ];
  const recoveryBlocks = [
    deploy.match(
      /- name: Restore the previous staging release on verification failure[\s\S]*?(?=\r?\n      - name: Upload staging receipt)/u
    )?.[0] ?? "",
    deploy.match(
      /- name: Restore the previous production release on verification failure[\s\S]*?(?=\r?\n      - name: Upload production receipt)/u
    )?.[0] ?? "",
  ];
  const greenfieldOwnerPayloadBlock =
    recoverySnapshot.match(
      /owner_payload="\$\([\s\S]*?\r?\n    \)"\r?\n    greenfield_owner="\$\(/u
    )?.[0] ?? "";
  const canaryTrafficFragments = [
    "trap stop_canary_probe EXIT",
    "while true; do",
    "$CANARY_URL/api/proof",
    "$CANARY_URL/api/recall",
    "sam deploy",
    "stop_canary_probe",
    "trap - EXIT",
  ];
  const fullRecallFragments = [
    ".database.activeMemories == .memory.persisted",
    ".memory.persisted == 9",
    ".memory.idempotencyKeys == .memory.persisted",
    ".memory.contentDigests == .memory.persisted",
    ".memory.storeVerified == true",
    '.memory.evidence == "live bounded fixed-scope payload-digest verification"',
    '-X POST "$APPLICATION_URL/api/recall"',
    ".recalled > 0",
    "(.citations | length) > 0",
    '(.answer | type == "string" and length > 0)',
    ".modelId == $narrator",
    '(.grounding.status == "verified" or .grounding.status == "extractive")',
    ".grounding.checks.citations == true",
    ".grounding.checks.numerics == true",
    ".grounding.checks.claims == true",
    'contains("€15,375")',
    'contains("€6,775")',
  ];
  const managedMcpGateFragments = [
    'keys == ["aggregate","bound","calledTools","checkedAt","database","endpoint","mode","ok","proofs","redactions","schemaVersion","scope","toolsAdvertised"]',
    ".schemaVersion == 2",
    '"tenantId":"public-demo"',
    '"company":"Helios SA"',
    '"status":"active"',
    '"embedModel":"amazon.titan-embed-text-v2:0"',
    '"index":"idx_agent_memory_active_scope"',
    '"innerLimit":10',
    '"outerLimit":1',
    '"persisted":9',
    '"idempotencyKeys":9',
    '"contentDigests":9',
    '.calledTools == ["get_cluster","list_tables","get_table_schema","select_query"]',
    ".proofs == [",
    '"detail":"Live cluster metadata returned through CockroachDB Cloud Managed MCP."',
    '"detail":"`agent_memory` is present in the configured application database."',
    '"detail":"Live schema exposes VECTOR(1024) and a native vector index."',
    '"detail":"The fixed-scope, index-forced, ten-row-sentinel aggregate is exactly 9/9/9."',
    "length == 4",
    'map(.name) == ["get_cluster","list_tables","get_table_schema","select_query"]',
    '.redactions == ["API key","cluster identifier","SQL credentials","memory content","embeddings"]',
    'grep -Fq -- "$CCLOUD_API_KEY"',
    'grep -Fq -- "$COCKROACH_CLUSTER_ID"',
  ];
  const managedMcpGateBlocks = [
    managedMcpWorkflow,
    managedMcpDeployJob,
  ];
  const managedMcpLeakChecksPrecedeJq = managedMcpGateBlocks.every(
    (block) => {
      const receipt = block.indexOf(
        "npm run --silent mcp:cloud:audit"
      );
      const apiKeyCheck = block.indexOf(
        'grep -Fq -- "$CCLOUD_API_KEY"'
      );
      const clusterIdCheck = block.indexOf(
        'grep -Fq -- "$COCKROACH_CLUSTER_ID"'
      );
      const exactJqGate = block.indexOf(
        'jq -e --arg database "$COCKROACH_DATABASE"'
      );
      return (
        receipt >= 0 &&
        receipt < apiKeyCheck &&
        receipt < clusterIdCheck &&
        apiKeyCheck < exactJqGate &&
        clusterIdCheck < exactJqGate
      );
    }
  );
  const durableRecoveryScriptsAreCiGated =
    durableRecoveryScriptSources.every(
      (source) =>
        /^#!\/usr\/bin\/env bash\r?\n/u.test(source) &&
        /^set -euo pipefail$/mu.test(source)
    ) &&
    DURABLE_RECOVERY_SCRIPT_PATHS.every((scriptPath) =>
      ci.includes(`bash -n ${scriptPath}`)
    );
  const durableRecoveryArmContract =
    durableRecoveryArmsPrecedeSam &&
    reconciliationCredentialsArePhaseBounded &&
    samCredentialsRefreshImmediatelyBeforeDeploy &&
    samCredentialsRefreshImmediatelyAfterDeploy &&
    durableRecoveryArmBlocks.every(
      (block) =>
        block.length > 0 &&
        /id: durable_recovery/u.test(block) &&
        /bundle_tar="\$\{RUNNER_TEMP:\?\}\//u.test(block) &&
        /roundtrip_tar="\$\{RUNNER_TEMP:\?\}\//u.test(block) &&
        /extracted_dir="\$\{RUNNER_TEMP:\?\}\//u.test(block) &&
        /trap cleanup_durable_intent EXIT/u.test(block) &&
        /bash aws\/create-durable-recovery-bundle\.sh/u.test(block) &&
        /bash aws\/put-durable-recovery-object\.sh/u.test(block) &&
        /aws s3api get-object/u.test(block) &&
        /--version-id "\$RECOVERY_ARCHIVE_VERSION_ID"/u.test(block) &&
        /--checksum-mode ENABLED/u.test(block) &&
        /bash aws\/extract-durable-recovery-bundle\.sh/u.test(block) &&
        /bash aws\/recovery-intent-ledger\.sh arm/u.test(block) &&
        /\.state == "ARMED"/u.test(block) &&
        /echo "armed=true"/u.test(block) &&
        /echo "previous_index_version=/u.test(block) &&
        /echo "previous_index_sha256=/u.test(block)
    );
  const durableFrontendBaselineContract =
    (
      deploy.match(
        /EXPECTED_HAD_PREVIOUS_INDEX: \$\{\{ steps\.durable_recovery\.outputs\.had_previous_index \}\}/gu
      ) ?? []
    ).length === 2 &&
    (
      deploy.match(
        /EXPECTED_PREVIOUS_INDEX_SHA256: \$\{\{ steps\.durable_recovery\.outputs\.previous_index_sha256 \}\}/gu
      ) ?? []
    ).length === 2 &&
    (
      deploy.match(
        /EXPECTED_PREVIOUS_INDEX_VERSION: \$\{\{ steps\.durable_recovery\.outputs\.previous_index_version \}\}/gu
      ) ?? []
    ).length === 2 &&
    (
      deploy.match(
        /test "\$current_version" = "\$EXPECTED_PREVIOUS_INDEX_VERSION"/gu
      ) ?? []
    ).length === 2 &&
    (
      deploy.match(/test -z "\$EXPECTED_PREVIOUS_INDEX_SHA256"/gu) ?? []
    ).length === 2 &&
    (
      deploy.match(
        /Unable to re-prove the durable frontend baseline\./gu
      ) ?? []
    ).length === 2;
  const durableRecoveryCommitContract =
    durableRecoveryCommitsAreTerminallyOrdered &&
    durableRecoveryCommitBlocks.every(
      (block) =>
        block.length > 0 &&
        /^        if: success\(\)$/mu.test(block) &&
        /RECOVERY_INTENT_ID: \$\{\{ steps\.durable_recovery\.outputs\.intent_id \}\}/u.test(
          block
        ) &&
        /receipt_key="candidates\/recovery\/(?:staging|production)\/receipts\/\$\{RECOVERY_INTENT_ID\}\/\$\{receipt_sha256\}\.json"/u.test(
          block
        ) &&
        /trap 'rm -f -- "\$object_proof"' EXIT/u.test(block) &&
        /bash aws\/put-durable-recovery-object\.sh/u.test(block) &&
        /RECOVERY_RECEIPT_BUCKET=/u.test(block) &&
        /RECOVERY_RECEIPT_KEY=/u.test(block) &&
        /RECOVERY_RECEIPT_SHA256=/u.test(block) &&
        /RECOVERY_RECEIPT_VERSION_ID=/u.test(block) &&
        /bash aws\/recovery-intent-ledger\.sh commit/u.test(block) &&
        /\.schema == "archon\.recovery-intent\.terminal"/u.test(block) &&
        /\.state == "COMMITTED"/u.test(block) &&
        /\.receiptSha256 == \$receipt/u.test(block)
    );
  const environmentDeployOidcTrustContract =
    /GitHubRepositoryId:\r?\n\s+Type: String\r?\n\s+Default: "1285750381"\r?\n\s+AllowedPattern: "\^\[0-9\]\{1,20\}\$"/u.test(
      deliveryBootstrap
    ) &&
    /GitHubRepositoryOwnerId:\r?\n\s+Type: String\r?\n\s+Default: "25751981"\r?\n\s+AllowedPattern: "\^\[0-9\]\{1,20\}\$"/u.test(
      deliveryBootstrap
    ) &&
    environmentDeployTrustBlocks.every(({ environment, source }) => {
      const claimPrefix = "token.actions.githubusercontent.com:";
      return (
        source.length > 0 &&
        (source.match(/token\.actions\.githubusercontent\.com:/gu) ?? [])
          .length === 8 &&
        source.includes(
          `${claimPrefix}aud: sts.amazonaws.com`
        ) &&
        source.includes(
          `${claimPrefix}sub: !Sub >-`
        ) &&
        source.includes(
          `repo:\${GitHubOrganization}/\${GitHubRepository}:environment:${environment}`
        ) &&
        source.includes(
          `${claimPrefix}repository: !Sub >-`
        ) &&
        source.includes(
          "${GitHubOrganization}/${GitHubRepository}"
        ) &&
        source.includes(
          `${claimPrefix}repository_id: !Ref GitHubRepositoryId`
        ) &&
        source.includes(
          `${claimPrefix}repository_owner_id: !Ref GitHubRepositoryOwnerId`
        ) &&
        source.includes(
          `${claimPrefix}ref: refs/heads/main`
        ) &&
        source.includes(
          `${claimPrefix}environment: ${environment}`
        ) &&
        /token\.actions\.githubusercontent\.com:workflow:\r?\n\s+- Deploy AWS\r?\n\s+- Recover AWS\r?\n      Policies:$/u.test(
          source
        ) &&
        !/token\.actions\.githubusercontent\.com:(?:workflow_ref|job_workflow_ref):/u.test(
          source
        )
      );
    });
  const watchdogWorkflowContract =
    hasExactAwsRecoveryTrigger(recoveryWorkflow) &&
    hasExactAwsDeliveryConcurrency(deploy) &&
    hasExactAwsDeliveryConcurrency(recoveryWorkflow) &&
    /name: Deploy and smoke staging/u.test(deploy) &&
    /name: Promote identical candidate to production/u.test(deploy) &&
    /TERMINAL_JOB_NAME: Deploy and smoke staging/u.test(recoveryWorkflow) &&
    /TERMINAL_JOB_NAME: Promote identical candidate to production/u.test(
      recoveryWorkflow
    ) &&
    /"staging:Deploy and smoke staging"\|"production:Promote identical candidate to production"/u.test(
      durableRecoveryClassifier
    ) &&
    (recoveryWorkflow.match(/timeout-minutes:\s+65/gu) ?? []).length === 2 &&
    (
      recoveryWorkflow.match(/role-duration-seconds:\s+3600/gu) ?? []
    ).length === 6 &&
    /--argjson leaseUntil "\$\(\(now \+ 7200\)\)"/u.test(
      durableRecoveryLedger
    ) &&
    watchdogRefreshesImmediatelyPrecedeExecution &&
    watchdogTerminalJsonGatesAreOrdered &&
    (
      recoveryWorkflow.match(
        /uses: actions\/checkout@[0-9a-f]{40}[^\r\n]*\r?\n        with:\r?\n          ref: \$\{\{ github\.sha \}\}\r?\n          fetch-depth: 0/gu
      ) ?? []
    ).length === 2 &&
    (
      recoveryWorkflow.match(
        /github\.repository == 'upgradedev\/archon-cockroach-memory' &&\r?\n\s+github\.ref == 'refs\/heads\/main'/gu
      ) ?? []
    ).length === 2 &&
    (
      recoveryWorkflow.match(
        /test "\$GITHUB_REPOSITORY" = \\\r?\n\s+"upgradedev\/archon-cockroach-memory"/gu
      ) ?? []
    ).length === 2 &&
    (
      recoveryWorkflow.match(
        /test "\$GITHUB_REF" = "refs\/heads\/main"/gu
      ) ?? []
    ).length === 2 &&
    (
      recoveryWorkflow.match(
        /test "\$GITHUB_REF_TYPE" = "branch"/gu
      ) ?? []
    ).length === 2 &&
    (
      recoveryWorkflow.match(
        /test "\$GITHUB_WORKFLOW_REF" = \\\r?\n\s+"upgradedev\/archon-cockroach-memory\/\.github\/workflows\/recover-aws\.yml@refs\/heads\/main"/gu
      ) ?? []
    ).length === 2 &&
    (
      recoveryWorkflow.match(
        /test "\$\(git rev-parse HEAD\)" = "\$GITHUB_SHA"/gu
      ) ?? []
    ).length === 2 &&
    (
      recoveryWorkflow.match(
        /git fetch --no-tags origin \\\r?\n\s+\+refs\/heads\/main:refs\/remotes\/origin\/main/gu
      ) ?? []
    ).length === 2 &&
    (
      recoveryWorkflow.match(
        /test "\$\(git rev-parse origin\/main\)" = "\$GITHUB_SHA"/gu
      ) ?? []
    ).length === 2 &&
    !/github\.event\.workflow_run\.head_sha/u.test(recoveryWorkflow) &&
    /recover-staging:[\s\S]*?if: >-\r?\n\s+github\.repository == 'upgradedev\/archon-cockroach-memory' &&\r?\n\s+github\.ref == 'refs\/heads\/main'\r?\n\s+runs-on:/u.test(
      recoveryWorkflow
    ) &&
    /recover-production:[\s\S]*?needs:\r?\n\s+- recover-staging\r?\n\s+if: >-\r?\n\s+always\(\) &&\r?\n\s+github\.repository == 'upgradedev\/archon-cockroach-memory' &&\r?\n\s+github\.ref == 'refs\/heads\/main'\r?\n\s+runs-on:/u.test(
      recoveryWorkflow
    ) &&
    !/needs\.recover-staging\.result/u.test(recoveryWorkflow) &&
    (
      recoveryWorkflow.match(
        /bash aws\/recovery-intent-ledger\.sh claim/gu
      ) ?? []
    ).length === 2 &&
    (
      recoveryWorkflow.match(
        /bash aws\/download-durable-recovery-bundle\.sh/gu
      ) ?? []
    ).length === 2 &&
    (
      recoveryWorkflow.match(
        /bash aws\/recover-durable-environment\.sh/gu
      ) ?? []
    ).length === 2 &&
    (
      recoveryWorkflow.match(
        /bash aws\/finalize-durable-recovery-receipt\.sh/gu
      ) ?? []
    ).length === 2 &&
    (
      recoveryWorkflow.match(
        /length == 1 and \(\.\[0\] \| type == "object"\)/gu
      ) ?? []
    ).length === 16 &&
    (
      recoveryWorkflow.match(
        /bash aws\/classify-durable-recovery-source\.sh >"\$classification"\r?\n\s+jq -e -s/gu
      ) ?? []
    ).length === 2 &&
    (
      recoveryWorkflow.match(
        /bash aws\/recovery-intent-ledger\.sh claim \\\r?\n\s+>"\$\{RUNNER_TEMP:\?\}\/(?:staging|production)-recovery-claim\.json"\r?\n\s+jq -e -s/gu
      ) ?? []
    ).length === 2 &&
    (
      recoveryWorkflow.match(
        /bash aws\/download-durable-recovery-bundle\.sh "\$bundle_dir" \\\r?\n\s+>"\$\{RUNNER_TEMP:\?\}\/(?:staging|production)-recovery-download\.json"\r?\n\s+jq -e -s/gu
      ) ?? []
    ).length === 2 &&
    (
      recoveryWorkflow.match(
        /\$\{\{ runner\.temp \}\}\/(?:staging|production)-recovery-(?:execution|finalization)\.json/gu
      ) ?? []
    ).length === 4 &&
    /bash aws\/recovery-intent-ledger\.sh recover/u.test(
      durableRecoveryFinalizer
    ) &&
    (
      recoveryWorkflow.match(
        /bash aws\/enforce-cloudformation-controls\.sh audit/gu
      ) ?? []
    ).length === 2 &&
    (
      recoveryWorkflow.match(
        /name: Upload (?:staging|production) daily protection and drift audit/gu
      ) ?? []
    ).length === 2 &&
    (
      recoveryWorkflow.match(
        /\$\{\{ runner\.temp \}\}\/(?:staging|production)-cloudformation-controls-audit\.json/gu
      ) ?? []
    ).length === 2 &&
    (
      recoveryWorkflow.match(
        /bash aws\/enforce-cloudformation-controls\.sh recover/gu
      ) ?? []
    ).length === 4 &&
    (recoveryWorkflow.match(/\.state == "RECOVERED"/gu) ?? []).length ===
      2 &&
    (
      recoveryWorkflow.match(
        /name: Remove (?:staging|production) runner recovery material\r?\n        if: always\(\)/gu
      ) ?? []
    ).length === 2 &&
    (
      recoveryWorkflow.match(
        /rm -rf -- "\$\{RUNNER_TEMP:\?\}\/(?:staging|production)-durable-recovery-bundle"/gu
      ) ?? []
    ).length === 2;
  const durableS3CasLedgerContract =
    /assert-clear\|arm\|read\|claim\|commit\|recover/u.test(
      durableRecoveryLedger
    ) &&
    /ledger_key="candidates\/recovery\/\$\{RECOVERY_ENVIRONMENT\}\/ledger\.json"/u.test(
      durableRecoveryLedger
    ) &&
    /--expected-bucket-owner "\$AWS_ACCOUNT_ID"/u.test(
      durableRecoveryLedger
    ) &&
    /--checksum-mode ENABLED/u.test(durableRecoveryLedger) &&
    durableRecoveryLedger.includes(
      String.raw`.ETag | type == "string" and test("^\"[0-9a-f]{32}\"$")`
    ) &&
    /\.ServerSideEncryption == "AES256"/u.test(durableRecoveryLedger) &&
    /\.Metadata == \{/u.test(durableRecoveryLedger) &&
    /"kind": "recovery-ledger"/u.test(durableRecoveryLedger) &&
    /\(keys \| sort\) == \(\[/u.test(durableRecoveryLedger) &&
    /\.schema == "archon\.recovery-intent\.ledger"/u.test(
      durableRecoveryLedger
    ) &&
    /\.state == "ARMED"/u.test(durableRecoveryLedger) &&
    /\.state == "RECOVERING"/u.test(durableRecoveryLedger) &&
    /\.state == "COMMITTED"/u.test(durableRecoveryLedger) &&
    /\.state == "RECOVERED"/u.test(durableRecoveryLedger) &&
    /put_args\+=\(--if-match "\$prior_etag"\)/u.test(
      durableRecoveryLedger
    ) &&
    /put_args\+=\(--if-none-match '\*'\)/u.test(durableRecoveryLedger) &&
    /--server-side-encryption AES256/u.test(durableRecoveryLedger) &&
    /--checksum-algorithm SHA256/u.test(durableRecoveryLedger) &&
    /validate_previous_ledger_provenance\(\)/u.test(
      durableRecoveryLedger
    ) &&
    /read\|first-create\|terminal-rearm/u.test(durableRecoveryLedger) &&
    /if \$armedMode == "first-create"[\s\S]*?then null_previous_ledger[\s\S]*?elif \$armedMode == "terminal-rearm"[\s\S]*?then complete_previous_ledger/u.test(
      durableRecoveryLedger
    ) &&
    /armed_provenance_mode="terminal-rearm"[\s\S]*?armed_provenance_mode="first-create"/u.test(
      durableRecoveryLedger
    ) &&
    /RECOVERED terminal ledger re-arms with its complete exact provenance/u.test(
      durableRecoveryTests
    ) &&
    /Regression: a terminal ledger must re-arm with the complete exact/u.test(
      durableRecoveryTests
    ) &&
    [
      "incomplete prior tuple",
      "malformed prior ETag",
      "null S3 prior version",
    ].every((marker) => durableRecoveryTests.includes(marker)) &&
    /COMMITTED\|RECOVERED[\s\S]*?assert_terminal_item/u.test(
      durableRecoveryLedger
    ) &&
    /ARMED\|RECOVERING[\s\S]*?unresolved/u.test(durableRecoveryLedger) &&
    /\.receiptKey == \([\s\S]*?"candidates\/recovery\/" \+ \$environment \+ "\/receipts\/"/u.test(
      durableRecoveryLedger
    ) &&
    /\.receiptVersionId[\s\S]*?type == "string" and length > 0/u.test(
      durableRecoveryLedger
    ) &&
    /test "\$\(jq -er '\.state' <<<"\$current"\)" = "ARMED"/u.test(
      durableRecoveryLedger
    ) &&
    /test "\$\(jq -er '\.state' <<<"\$current"\)" = "RECOVERING"/u.test(
      durableRecoveryLedger
    );
  const durableRecoveryDataContract =
    /--if-none-match '\*'/u.test(durableRecoveryObjectPublisher) &&
    /--server-side-encryption AES256/u.test(
      durableRecoveryObjectPublisher
    ) &&
    /--checksum-algorithm SHA256/u.test(durableRecoveryObjectPublisher) &&
    /--version-id "\$archive_version_id"/u.test(
      durableRecoveryDownloader
    ) &&
    /--checksum-mode ENABLED/u.test(durableRecoveryDownloader) &&
    /bash aws\/extract-durable-recovery-bundle\.sh/u.test(
      durableRecoveryDownloader
    ) &&
    durableRecoveryExtractor.indexOf('tar -tf "$archive_file"') >= 0 &&
    durableRecoveryExtractor.indexOf('tar -tf "$archive_file"') <
      durableRecoveryExtractor.indexOf("  --extract") &&
    /contains an unsafe member name/u.test(durableRecoveryExtractor) &&
    /contains a non-regular member/u.test(durableRecoveryExtractor) &&
    /--no-same-owner/u.test(durableRecoveryExtractor) &&
    /--no-same-permissions/u.test(durableRecoveryExtractor) &&
    /\.schema == "archon\.durable-recovery-intent"/u.test(
      durableRecoveryVerifier
    ) &&
    /\(\(keys \| sort\) == \["bytes", "path", "sha256"\]\)/u.test(
      durableRecoveryVerifier
    ) &&
    /bash aws\/prove-recovery-snapshot\.sh/u.test(
      durableRecoveryVerifier
    ) &&
    /\.state == "RECOVERING"/u.test(durableRecoveryExecutor) &&
    /bash aws\/verify-durable-recovery-bundle\.sh/u.test(
      durableRecoveryExecutor
    ) &&
    /schema: "archon\.durable-recovery\.receipt"/u.test(
      durableRecoveryExecutor
    ) &&
    /version: 2/u.test(durableRecoveryExecutor) &&
    /--slurpfile stackProof "\$stack_proof"/u.test(
      durableRecoveryExecutor
    ) &&
    /proofs: \{\r?\n\s+stack: \$stackProof\[0\]/u.test(
      durableRecoveryExecutor
    ) &&
    /schema: "archon\.durable-recovery-receipt\.validation"/u.test(
      durableRecoveryReceiptVerifier
    ) &&
    /EXPECTED_RECOVERY_RECEIPT_SHA256/u.test(
      durableRecoveryReceiptVerifier
    ) &&
    /aws s3api get-object/u.test(durableRecoveryFinalizer) &&
    /--version-id "\$receipt_version_id"/u.test(
      durableRecoveryFinalizer
    ) &&
    /--checksum-mode ENABLED/u.test(durableRecoveryFinalizer) &&
    /bash aws\/verify-durable-recovery-receipt\.sh/u.test(
      durableRecoveryFinalizer
    ) &&
    /control_proof_key="candidates\/recovery\/\$\{RECOVERY_ENVIRONMENT\}\/controls\/\$\{RECOVERY_INTENT_ID\}\/\$\{control_proof_sha256\}\.json"/u.test(
      durableRecoveryFinalizer
    ) &&
    /validate_control_proof "\$roundtrip_control_proof"/u.test(
      durableRecoveryFinalizer
    ) &&
    /RECOVERY_CONTROL_PROOF_SHA256/u.test(durableRecoveryFinalizer) &&
    /RECOVERY_CONTROL_PROOF_SHA256/u.test(durableRecoveryLedger) &&
    (
      recoveryWorkflow.match(
        /"\$execution" \\\r?\n\s+"\$controls" >"\$finalization"/gu
      ) ?? []
    ).length === 2 &&
    /test "\$GITHUB_REPOSITORY" = "upgradedev\/archon-cockroach-memory"/u.test(
      durableRecoveryClassifier
    ) &&
    /actions\/runs\/\$\{source_run_id\}\/attempts\/\$\{source_run_attempt\}/u.test(
      durableRecoveryClassifier
    ) &&
    /schema: "archon\.durable-recovery-bundle\.proof"/u.test(
      durableRecoveryBundleCreator
    ) &&
    /private S3 recovery ledger preserves terminal provenance, CAS, and lease bounds/u.test(
      durableRecoveryTests
    ) &&
    /durable extraction rejects \$\{unsafeCase\.name\} before extraction/u.test(
      durableRecoveryTests
    ) &&
    /ambiguous terminal CAS succeeds only after an exact RECOVERED read/u.test(
      durableRecoveryTests
    ) &&
    /classifier accepts every documented Deploy AWS path/u.test(
      recoveryWatchdogTests
    ) &&
    (packageSource.match(/tests\/durable-recovery\.test\.ts/gu) ?? [])
      .length === 2 &&
    (packageSource.match(/tests\/recovery-watchdog\.test\.ts/gu) ?? [])
      .length === 2;
  const legacyCandidateReadPattern = "\\?".repeat(40);
  const durableRecoveryIamContract =
    (["staging", "production"] as const).every((environment) => {
      const title =
        environment === "staging" ? "Staging" : "Production";
      return (
        new RegExp(
          `Sid: Publish${title}DeploymentArtifacts[\\s\\S]*?` +
            "- s3:GetObject\\r?\\n\\s+- s3:GetObjectVersion\\r?\\n" +
            `\\s+- s3:PutObject[\\s\\S]*?candidates/deployments/${environment}/\\*`,
          "u"
        ).test(deliveryBootstrap) &&
        new RegExp(
          `Sid: Manage${title}RecoveryArtifacts[\\s\\S]*?` +
            "- s3:GetObject\\r?\\n\\s+- s3:GetObjectVersion\\r?\\n" +
            `\\s+- s3:PutObject[\\s\\S]*?candidates/recovery/${environment}/\\*`,
          "u"
        ).test(deliveryBootstrap) &&
        new RegExp(
          `Sid: List${title}ArtifactNamespaces[\\s\\S]*?` +
            `candidates/deployments/${environment}/\\*[\\s\\S]*?` +
            `candidates/recovery/${environment}/\\*`,
          "u"
        ).test(deliveryBootstrap) &&
        deploy.includes(
          `--s3-prefix "candidates/deployments/${environment}/\${{ github.event.workflow_run.head_sha }}"`
        ) &&
        (
          deliveryBootstrap.match(
            new RegExp(
              `\\$\\{ArtifactBucket\\.Arn\\}/candidates/deployments/${environment}/\\*`,
              "gu"
            )
          ) ?? []
        ).length === 3 &&
        (
          deliveryBootstrap.match(
            new RegExp(
              `\\$\\{ArtifactBucket\\.Arn\\}/candidates/recovery/${environment}/\\*`,
              "gu"
            )
          ) ?? []
        ).length === 1
      );
    }) &&
    !deliveryBootstrap.includes("${ArtifactBucket.Arn}/candidates/*") &&
    (
      deliveryBootstrap.match(
        new RegExp(
          `\\$\\{ArtifactBucket\\.Arn\\}/candidates/${legacyCandidateReadPattern}/\\*`,
          "gu"
        )
      ) ?? []
    ).length === 4 &&
    ![
      lambdaTemplate,
      deliveryBootstrap,
      foundationWorkflow,
      deploy,
      recoveryWorkflow,
      ...durableRecoveryScriptSources,
    ].some((source) =>
      /AWS::DynamoDB::Table|\bdynamodb:/iu.test(source)
    );
  const cloudFormationControlsContract =
    cloudFormationControlsAreOrdered &&
    /preflight\|terminal\|recover\|audit/u.test(cloudFormationControls) &&
    /update-termination-protection/u.test(cloudFormationControls) &&
    /--enable-termination-protection/u.test(cloudFormationControls) &&
    /detect-stack-drift/u.test(cloudFormationControls) &&
    /describe-stack-drift-detection-status/u.test(
      cloudFormationControls
    ) &&
    /describe-stack-resource-drifts/u.test(cloudFormationControls) &&
    /DETECTION_COMPLETE/u.test(cloudFormationControls) &&
    /StackDriftStatus == "IN_SYNC"/u.test(cloudFormationControls) &&
    /DriftedStackResourceCount == 0/u.test(cloudFormationControls) &&
    /checkedResourceCount/u.test(cloudFormationControls) &&
    (
      cloudFormationControls.match(/require_single_json_object/gu) ?? []
    ).length === 6 &&
    /require_single_json_object\(\) \{[\s\S]*?jq -s -e \\\r?\n\s+'length == 1 and \(\.\[0\] \| type == "object"\)'/u.test(
      cloudFormationControls
    ) &&
    /every live CloudFormation boundary rejects duplicate valid JSON documents/u.test(
      cloudFormationControlsTests
    ) &&
    /\.identity\.stackId == \$receipt\[0\]\.proofs\.stack\.stackId/u.test(
      durableRecoveryFinalizer
    ) &&
    /\.identity\.stackRevision[\s\S]*?== \$receipt\[0\]\.proofs\.stack\.stackRevision/u.test(
      durableRecoveryFinalizer
    ) &&
    /\.identity\.tagsSha256 == \$receipt\[0\]\.proofs\.stack\.tagsSha256/u.test(
      durableRecoveryFinalizer
    ) &&
    /controlProofBucket/u.test(durableRecoveryLedger) &&
    /controlProofKey/u.test(durableRecoveryLedger) &&
    /controlProofSha256/u.test(durableRecoveryLedger) &&
    /controlProofVersionId/u.test(durableRecoveryLedger) &&
    !/ExpectedProperties|ActualProperties/u.test(
      cloudFormationControls
    ) &&
    (
      deploy.match(
        /bash aws\/enforce-cloudformation-controls\.sh preflight/gu
      ) ?? []
    ).length === 2 &&
    (
      deploy.match(
        /bash aws\/enforce-cloudformation-controls\.sh terminal/gu
      ) ?? []
    ).length === 2 &&
    terminalReceiptBlocks.every(
      (block) =>
        block.length > 0 &&
        /bash aws\/enforce-cloudformation-controls\.sh terminal/u.test(
          block
        ) &&
        /--slurpfile cfnPreflight "\$preflight_control"/u.test(block) &&
        /--slurpfile cfnTerminal "\$terminal_control"/u.test(block) &&
        /cloudFormationControls: \{/u.test(block)
    ) &&
    (
      deploy.match(
        /length == 1 and \(\.\[0\] \| type == "object"\)/gu
      ) ?? []
    ).length >= 4 &&
    (
      recoveryWorkflow.match(
        /bash aws\/enforce-cloudformation-controls\.sh audit/gu
      ) ?? []
    ).length === 2 &&
    (
      recoveryWorkflow.match(
        /bash aws\/enforce-cloudformation-controls\.sh recover/gu
      ) ?? []
    ).length === 4 &&
    (
      deliveryBootstrap.match(
        /cloudformation:UpdateTerminationProtection/gu
      ) ?? []
    ).length === 2 &&
    (
      deliveryBootstrap.match(/cloudformation:DetectStackDrift/gu) ?? []
    ).length === 2 &&
    (
      deliveryBootstrap.match(
        /cloudformation:DetectStackResourceDrift/gu
      ) ?? []
    ).length === 2 &&
    (
      deliveryBootstrap.match(
        /cloudformation:DescribeStackResourceDrifts/gu
      ) ?? []
    ).length === 2 &&
    (
      deliveryBootstrap.match(
        /cloudformation:BatchDescribeTypeConfigurations/gu
      ) ?? []
    ).length === 2 &&
    /update-termination-protection/u.test(greenfieldCleanup) &&
    /--no-enable-termination-protection/u.test(greenfieldCleanup) &&
    /proof output is sanitized and never persists resource properties/u.test(
      cloudFormationControlsTests
    ) &&
    (
      packageSource.match(/tests\/cloudformation-controls\.test\.ts/gu) ??
      []
    ).length === 2;
  const greenfieldRetainedLogDeleteIamBlocks = [
    ...deliveryBootstrap.matchAll(
      /- Sid: DeleteFailed(?:Staging|Production)GreenfieldRetainedLogs[\s\S]*?(?=\r?\n              - Sid: InspectFailed(?:Staging|Production)GreenfieldRetainedLogTags)/gu
    ),
  ].map((match) => match[0]);
  const greenfieldRetainedLogInspectIamBlocks = [
    ...deliveryBootstrap.matchAll(
      /- Sid: InspectFailed(?:Staging|Production)GreenfieldRetainedLogTags[\s\S]*?(?=\r?\n              - Effect: Allow)/gu
    ),
  ].map((match) => match[0]);
  const greenfieldRetainedLogCleanupContract =
    [
      'legacy_api_log_group="/aws/apigateway/${APP_NAME}-${ENVIRONMENT}"',
      'vended_api_log_group="/aws/vendedlogs/apigateway/${APP_NAME}-${ENVIRONMENT}"',
      'lambda_log_group="/aws/lambda/${APP_NAME}-${ENVIRONMENT}-api"',
      "ApiAccessLogGroup",
      "ApiVendedAccessLogGroup",
      "ArchonFunctionLogGroup",
    ].every((fragment) => greenfieldCleanup.includes(fragment)) &&
    /log_owner_state\(\)/u.test(greenfieldCleanup) &&
    /assert_log_absent\(\)/u.test(greenfieldCleanup) &&
    (
      greenfieldCleanup.match(
        /^delete_owned_log_group \\$/gmu
      ) ?? []
    ).length === 3 &&
    /retainedLogGroupsDeleted: \$logGroupsDeleted/u.test(
      greenfieldCleanup
    ) &&
    greenfieldRetainedLogDeleteIamBlocks.length === 2 &&
    greenfieldRetainedLogDeleteIamBlocks.every(
      (block) =>
        /Action: logs:DeleteLogGroup/u.test(block) &&
        (block.match(/log-group:/gu) ?? []).length === 3 &&
        /log-group:\/aws\/apigateway\/\$\{AppName\}-(?:staging|production)"/u.test(
          block
        ) &&
        /log-group:\/aws\/vendedlogs\/apigateway\/\$\{AppName\}-(?:staging|production)"/u.test(
          block
        ) &&
        /log-group:\/aws\/lambda\/\$\{AppName\}-(?:staging|production)-api"/u.test(
          block
        ) &&
        !/:\*"/u.test(block)
    ) &&
    greenfieldRetainedLogInspectIamBlocks.length === 2 &&
    greenfieldRetainedLogInspectIamBlocks.every(
      (block) =>
        /Action: logs:ListTagsForResource/u.test(block) &&
        (block.match(/log-group:/gu) ?? []).length === 3 &&
        /log-group:\/aws\/apigateway\/\$\{AppName\}-(?:staging|production)"/u.test(
          block
        ) &&
        /log-group:\/aws\/vendedlogs\/apigateway\/\$\{AppName\}-(?:staging|production)"/u.test(
          block
        ) &&
        /log-group:\/aws\/lambda\/\$\{AppName\}-(?:staging|production)-api"/u.test(
          block
        ) &&
        !/:\*"/u.test(block)
    ) &&
    /logs delete-log-group --log-group-name \\/u.test(awsRecoveryTests) &&
    /\/aws\/vendedlogs\/apigateway\/archon-memory-staging/u.test(
      awsRecoveryTests
    ) &&
    /vended API log logical-id/u.test(awsRecoveryTests);
  const boundedCloudFormationPollingContract =
    !/\bcloudformation\s+wait\b/u.test(stackRestore) &&
    !/\bcloudformation\s+wait\b/u.test(greenfieldCleanup) &&
    [
      "read_bounded_poll_setting",
      "assert_poll_phase_budget",
      "ensure_recovery_time_budget",
      "sleep_within_recovery_budget",
      "describe_exact_stack_status",
      "poll_exact_stack_status",
      "poll_exact_change_set_creation",
      "ARCHON_RECOVERY_TOTAL_BUDGET_SECONDS 2400 60 3000",
      "ARCHON_RECOVERY_STABILIZE_POLL_ATTEMPTS 12 1 30",
      "ARCHON_RECOVERY_STABILIZE_POLL_INTERVAL_SECONDS 5 0 10",
      "ARCHON_RECOVERY_CHANGE_SET_POLL_ATTEMPTS 60 1 90",
      "ARCHON_RECOVERY_CHANGE_SET_POLL_INTERVAL_SECONDS 5 0 10",
      "ARCHON_RECOVERY_FINAL_POLL_ATTEMPTS 120 1 180",
      "ARCHON_RECOVERY_FINAL_POLL_INTERVAL_SECONDS 10 0 15",
      'recovery_started_epoch="${ARCHON_RECOVERY_STARTED_EPOCH:-$current_epoch}"',
    ].every((fragment) => stackRestore.includes(fragment)) &&
    [
      "read_bounded_poll_setting",
      "assert_poll_phase_budget",
      "ensure_greenfield_time_budget",
      "sleep_within_greenfield_budget",
      "describe_exact_greenfield_stack_status",
      "poll_exact_greenfield_stack_status",
      "poll_exact_greenfield_stack_deletion",
      "ARCHON_GREENFIELD_TOTAL_BUDGET_SECONDS 2400 60 3000",
      "ARCHON_GREENFIELD_STABILIZE_POLL_ATTEMPTS 12 1 30",
      "ARCHON_GREENFIELD_STABILIZE_POLL_INTERVAL_SECONDS 5 0 10",
      "ARCHON_GREENFIELD_DELETE_POLL_ATTEMPTS 120 1 180",
      "ARCHON_GREENFIELD_DELETE_POLL_INTERVAL_SECONDS 10 0 15",
      'greenfield_started_epoch="${ARCHON_GREENFIELD_STARTED_EPOCH:-$current_epoch}"',
    ].every((fragment) => greenfieldCleanup.includes(fragment)) &&
    (stackRestore.match(/AWS_MAX_ATTEMPTS=1 aws/gu) ?? []).length >= 2 &&
    (greenfieldCleanup.match(/AWS_MAX_ATTEMPTS=1 aws/gu) ?? []).length >=
      2 &&
    /jq -ser/u.test(stackRestore) &&
    /jq -ser/u.test(greenfieldCleanup) &&
    /AWS recovery scripts contain no CloudFormation service waiter/u.test(
      awsRecoveryTests
    ) &&
    /stack recovery bounds change-set polling and leaves it for a later watchdog/u.test(
      awsRecoveryTests
    ) &&
    /stack recovery fails closed on final polling \$\{pollFailure\.name\}/u.test(
      awsRecoveryTests
    ) &&
    /greenfield cleanup fails closed on delete polling \$\{deletePollFailure\.name\}/u.test(
      awsRecoveryTests
    ) &&
    (
      awsRecoveryTests.match(
        /\{ name: "multiple-object JSON stream", mode: "json-stream" \}/gu
      ) ?? []
    ).length === 2;
  const greenfieldRerunOwnerContract =
    greenfieldOwnerPayloadBlock.length > 0 &&
    [
      "--arg account",
      "--arg app",
      "--arg candidate",
      "--arg environment",
      "--arg region",
      "--arg repository",
      "--arg runId",
      "--arg stack",
    ].every((fragment) => greenfieldOwnerPayloadBlock.includes(fragment)) &&
    !/runAttempt/u.test(greenfieldOwnerPayloadBlock) &&
    /--arg runAttempt "\$source_deploy_run_attempt"/u.test(
      recoverySnapshot
    ) &&
    /runAttempt: \$runAttempt/u.test(recoverySnapshot) &&
    (
      deploy.match(
        /SOURCE_REPOSITORY: \$\{\{ github\.repository \}\}/gu
      ) ?? []
    ).length === 2 &&
    (
      deploy.match(
        /SOURCE_DEPLOY_RUN_ATTEMPT: \$\{\{ github\.run_attempt \}\}/gu
      ) ?? []
    ).length === 4 &&
    (
      deploy.match(
        /SOURCE_DEPLOY_RUN_ID: \$\{\{ github\.run_id \}\}/gu
      ) ?? []
    ).length === 4 &&
    /greenfield owner is rerun-stable while the manifest binds the attempt/u.test(
      awsRecoveryTests
    ) &&
    /attempt 2 can clean an attempt-1 failed greenfield stack/u.test(
      awsRecoveryTests
    );
  const localArtifacts = generatedArtifactPaths();
  const workflowEntries = repositoryWorkflowSources();
  const workflows = workflowEntries.map(({ source }) => source);
  const composeSources = repositoryDockerComposeSources();
  const dockerfiles = repositoryDockerfileSources();
  const cockroachImageSources: CockroachImageSources = {
    workflows,
    compose: composeSources,
    dockerfiles,
  };

  return [
    sourceCheck(
      "memory.native-vector-lifecycle",
      "Agentic Memory Design",
      /CREATE\s+VECTOR\s+INDEX/iu.test(schema) &&
        /embed_model/iu.test(schema) &&
        /idempotency_key/iu.test(schema) &&
        /superseded_by/iu.test(schema),
      "Native C-SPANN indexes and durable idempotency/model/lifecycle fields are explicit.",
      "Native vector or durable lifecycle evidence is incomplete."
    ),
    sourceCheck(
      "memory.role-bound-scope",
      "Agentic Memory Design",
      /archon_public_reader/iu.test(schema) &&
        /TO\s+archon_public_reader/iu.test(schema) &&
        /company\s*=\s*'Helios SA'/iu.test(schema) &&
        !/current_setting\('application_name'/iu.test(schema),
      "CockroachDB RLS binds the read-only runtime role to the fixed synthetic tenant and company.",
      "Role-bound fixed-scope RLS is missing or still depends on mutable application_name."
    ),
    sourceCheck(
      "memory.fixed-scope-cspann-owner",
      "Agentic Memory Design",
      /archon_public_memory_view_owner\s+WITH\s+NOLOGIN/iu.test(schema) &&
        /archon_public_memory_view_owner\s+WITH\s+NOLOGIN\s+BYPASSRLS/iu.test(
          schema
        ) &&
        /GRANT\s+SELECT\s+ON\s+TABLE\s+agent_memory\s+TO\s+archon_public_memory_view_owner/iu.test(
          schema
        ) &&
        /archon_public_memory_recall/iu.test(schema) &&
        /archon_public_memory_kind_recall/iu.test(schema) &&
        /security_invoker\s*=\s*false/iu.test(schema) &&
        /sql\.auth\.skip_underlying_view_privilege_checks\.enabled\s*=\s*false/iu.test(
          schema
        ) &&
        /REVOKE\s+CREATE\s+ON\s+SCHEMA\s+public\s+FROM\s+archon_public_memory_view_owner/iu.test(
          schema
        ),
      "Two fixed-scope C-SPANN views use an isolated non-login owner while runtime roles remain RLS-bound.",
      "The fixed-scope C-SPANN serving owner/views are incomplete or retain schema creation authority."
    ),
    sourceCheck(
      "memory.managed-mcp",
      "Agentic Memory Design",
      /MANAGED_MCP_RECEIPT_SCHEMA_VERSION\s*=\s*2/iu.test(
        managedMcpAudit
      ) &&
        /tenantId:\s*"public-demo"/u.test(managedMcpAudit) &&
        /company:\s*"Helios SA"/u.test(managedMcpAudit) &&
        /status:\s*"active"/u.test(managedMcpAudit) &&
        /embedModel:\s*"amazon\.titan-embed-text-v2:0"/u.test(
          managedMcpAudit
        ) &&
        /FORCE_INDEX=idx_agent_memory_active_scope/u.test(
          managedMcpAudit
        ) &&
        /LIMIT 10[\s\S]*LIMIT 1/u.test(managedMcpAudit) &&
        /parseManagedMcpAggregateResult/u.test(managedMcpAudit) &&
        /assertExactKeys/u.test(managedMcpAudit) &&
        /Number\.isSafeInteger/u.test(managedMcpAudit) &&
        /structuredContent/u.test(managedMcpAudit) &&
        /invokedDirectly/u.test(managedMcpAudit) &&
        /persisted:\s*9[\s\S]*idempotencyKeys:\s*9[\s\S]*contentDigests:\s*9/u.test(
          managedMcpAudit
        ) &&
        /tests\/cloud-mcp-audit\.test\.ts/u.test(packageSource) &&
        /rejects malformed and ambiguous envelopes/u.test(
          managedMcpAuditTests
        ) &&
        contains(
          "docs/MANAGED_MCP_SMOKE.md",
          /receipt schema v2/iu
        ) &&
        managedMcpEvidenceDocs.every(
          (document) =>
            /actions\/runs\/30204081177/u.test(document) &&
            /a2b69e3fad31010d14d0c3bca261421e635ca885/u.test(
              document
            ) &&
            !staleManagedMcpEvidence.test(document)
        ),
      "Managed MCP v2 proves the exact fixed scope with an index-forced ten-row sentinel, strict typed aggregate parsing, and sanitized pure-test coverage.",
      "Managed MCP v2 fixed scope, bounds, strict parser, import guard, tests, or evidence disclosure is incomplete."
    ),
    sourceCheck(
      "memory.legacy-reconciliation",
      "Agentic Memory Design",
      /withSerializableRetry/iu.test(demoReconciliation) &&
        /status = 'superseded'/iu.test(demoReconciliation) &&
        /superseded_by/iu.test(demoReconciliation) &&
        /historicalRowsPreserved:\s*true/iu.test(demoReconciliation) &&
        !/DELETE\s+FROM\s+agent_memory/iu.test(demoReconciliation) &&
        /db:memory:reconcile/iu.test(databaseReleaseWorkflow) &&
        /legacy-reconciliation-receipt\.json/iu.test(
          databaseReleaseWorkflow
        ) &&
        !/\.mode\s*==\s*"clean"/u.test(databaseReleaseWorkflow) &&
        /\.mode\s*==\s*"migrated"\s+and\s+\.activeBefore\s*==\s*6\s+and\s+\.alreadySuperseded\s*==\s*0\s+and\s+\.supersededThisRun\s*==\s*6\s+and\s+\.linkedAfter\s*==\s*6/u.test(
          databaseReleaseWorkflow
        ) &&
        /\.mode\s*==\s*"already-reconciled"\s+and\s+\.activeBefore\s*==\s*0\s+and\s+\.alreadySuperseded\s*==\s*6\s+and\s+\.supersededThisRun\s*==\s*0\s+and\s+\.linkedAfter\s*==\s*6/u.test(
          databaseReleaseWorkflow
        ) &&
        /alteredCandidateRejected:\s*true/iu.test(
          reconciliationRehearsal
        ) &&
        /transactionRollbackAfterMutation:\s*true/iu.test(
          reconciliationRehearsal
        ),
      "Protected CI supersedes only exact legacy duplicates, preserves history, proves rejection plus post-mutation rollback, and emits a sanitized receipt.",
      "Exact legacy-memory reconciliation, rollback rehearsal, or protected receipt gating is incomplete."
    ),
    sourceCheck(
      "tech.ci-matrix",
      "Technical Implementation",
      /frontend-iac:/u.test(ci) &&
        /cluster-survival:/u.test(ci) &&
        /pen-test:/u.test(ci) &&
        /load:/u.test(ci) &&
        /test:e2e/iu.test(ci),
      "CI gates backend, real CockroachDB, node loss, security, load, frontend, SAM, and browser journeys.",
      "One or more release-critical CI jobs are missing."
    ),
    sourceCheck(
      "tech.managed-mcp-receipt-v2-gate",
      "Technical Implementation",
      managedMcpGateBlocks.every(
        (block) =>
          block.length > 0 &&
          managedMcpGateFragments.every((fragment) =>
            block.includes(fragment)
          )
      ) &&
        managedMcpLeakChecksPrecedeJq &&
        /- name: Upload the sanitized proof receipt[\s\S]*?if: success\(\)[\s\S]*?if-no-files-found: error/u.test(
          managedMcpWorkflow
        ),
      "Both protected Managed MCP paths enforce the exact v2 receipt shape, scope, bounds, 9/9/9 aggregate, four proof calls, and secret-value exclusions.",
      "A Managed MCP workflow does not fail closed on the exact sanitized v2 receipt contract."
    ),
    sourceCheck(
      "tech.fail-closed-ci-aggregate",
      "Technical Implementation",
      /needs:\s*\[secret-scan,\s*dep-audit,\s*build-test,\s*cluster-survival,\s*pen-test,\s*load,\s*frontend-iac\]/u.test(
        readinessJob
      ) &&
        /^    if:\s*\$\{\{\s*always\(\)\s*\}\}\s*$/mu.test(readinessJob) &&
        /^    steps:\r?\n      - name: Require every prerequisite CI job to pass\s*$/mu.test(
          readinessJob
        ) &&
        /length == 7 and all\(\.\[\];\s*\.result == "success"\)/u.test(
          readinessJob
        ),
      "The aggregate readiness check always runs and fails unless every prerequisite CI job succeeded.",
      "The aggregate readiness check can be skipped or does not fail closed over every prerequisite."
    ),
    sourceCheck(
      "tech.immutable-supply-chain",
      "Technical Implementation",
      allWorkflowActionsPinned(workflows) &&
        allSetupNodeStepsPinned(workflows) &&
        allComposeImagesPinned(composeSources) &&
        allCockroachImagesPinned(cockroachImageSources) &&
        allDockerfileBasesPinned(dockerfiles) &&
        has("package-lock.json") &&
        has("web/package-lock.json"),
      "Actions, CockroachDB image, runtime, and lockfiles are immutable/reproducible.",
      "A mutable Action/image/runtime reference remains."
    ),
    sourceCheck(
      "tech.exact-ci-trigger",
      "Technical Implementation",
      hasExactCiTrigger(ci) &&
        hasUniqueCiTriggerOwnership(workflowEntries),
      "The CI workflow runs once for main pushes and every pull request; only CI and the explicit CodeQL scan own those repository events.",
      "CI triggers are duplicated repository-wide, omit main, or filter pull requests."
    ),
    sourceCheck(
      "tech.bedrock-grounding",
      "Technical Implementation",
      /checks:\s*\{[\s\S]*claims:\s*boolean/iu.test(narrator) &&
        /RECALL_MIN_SCORE/iu.test(handler) &&
        /citation/iu.test(narrator),
      "Bedrock narration is guarded by relevance abstention, per-claim citations, numeric checks, and fallback.",
      "Grounding or relevance-abstention controls are incomplete."
    ),
    sourceCheck(
      "tech.runtime-cspann-release-gate",
      "Technical Implementation",
      /export\s+function\s+buildRecallQuery/iu.test(memory) &&
        /buildRecallQuery/iu.test(databaseRelease) &&
        /verifyRuntimeCspannPath/iu.test(databaseRelease) &&
        /EXPLAIN\s+\$\{statement\.text\}/u.test(databaseRelease) &&
        /safeRuntimeQuery<RecallQueryRow>\(\s*client,\s*statement\.text,\s*statement\.params/iu.test(
          databaseRelease
        ) &&
        /schemaVersion:\s*5/u.test(databaseRelease) &&
        /scopedServingQueriesRejectCanaries:\s*true/u.test(
          databaseRelease
        ) &&
        /\.schemaVersion\s*==\s*5/u.test(databaseReleaseWorkflow) &&
        /\.proofs\.durableStoreIntegrity\s*==\s*true/u.test(
          databaseReleaseWorkflow
        ) &&
        /\.proofs\.canonicalActiveMemories\s*==\s*9/u.test(
          databaseReleaseWorkflow
        ) &&
        /\.proofs\.scopedServingQueriesRejectCanaries\s*==\s*true/u.test(
          databaseReleaseWorkflow
        ) &&
        scopedServingQueryVerifier.length > 0 &&
        /for\s*\(const\s+canary\s+of\s+canaryVectors\)/u.test(
          scopedServingQueryVerifier
        ) &&
        /buildRecallQuery\(embedding,\s*expectedModel/iu.test(
          scopedServingQueryVerifier
        ) &&
        /company:\s*"Helios SA"/u.test(scopedServingQueryVerifier) &&
        /kind:\s*input\.kind/u.test(scopedServingQueryVerifier) &&
        /limit:\s*50/u.test(scopedServingQueryVerifier) &&
        /!query\.fixedPublicScope/u.test(scopedServingQueryVerifier) &&
        /query\.relation\s*!==\s*input\.expectedView/u.test(
          scopedServingQueryVerifier
        ) &&
        /query\.expectedIndexName\s*!==\s*input\.expectedIndex/u.test(
          scopedServingQueryVerifier
        ) &&
        /idempotency_key\s*===\s*canary\.idempotencyKey/u.test(
          scopedServingQueryVerifier
        ) &&
        /\/idempotency_key\\s\*=\//u.test(scopedServingQueryVerifier) &&
        /publicControlMissing/u.test(scopedServingQueryVerifier) &&
        /scopedRows\.rows\.length\s*<\s*1/u.test(
          scopedServingQueryVerifier
        ) &&
        /scopedRows\.rows\.length\s*>\s*50/u.test(
          scopedServingQueryVerifier
        ) &&
        /SET vector_search_beam_size = 600/u.test(
          scopedServingQueryVerifier
        ) &&
        /class\s+ReleaseGateError\s+extends\s+Error/u.test(
          databaseRelease
        ) &&
        /error\s+instanceof\s+ReleaseGateError/u.test(databaseRelease) &&
        /safeRuntimeQuery/iu.test(databaseRelease) &&
        /runtimePrincipalCspannPlanAndExecute/iu.test(
          databaseReleaseWorkflow
        ) &&
        /all\(\.runtimes\[\];/u.test(databaseReleaseWorkflow) &&
        /idx_agent_memory_company_kind_scope_embedding/u.test(
          databaseReleaseWorkflow
        ) &&
        /\.cspannRecall\.noKind\.scopedServingQueryVerified\s*==\s*true/u.test(
          databaseReleaseWorkflow
        ) &&
        /\.cspannRecall\.kind\.scopedServingQueryVerified\s*==\s*true/u.test(
          databaseReleaseWorkflow
        ) &&
        /\.cspannRecall\.noKind\.isolationCanariesRejected\s*==\s*3/u.test(
          databaseReleaseWorkflow
        ) &&
        /\.cspannRecall\.kind\.isolationCanariesRejected\s*==\s*3/u.test(
          databaseReleaseWorkflow
        ) &&
        /\.proofs\.isolationCanaryCount\s*==\s*3/u.test(
          databaseReleaseWorkflow
        ) &&
        /servingViewOwnerPrivilegeBoundary\s*==\s*\n?\s*"direct non-inheritable BYPASSRLS role option; SELECT agent_memory only; no system privileges"/u.test(
          databaseReleaseWorkflow
        ),
      "CI executes the exact application query as both runtime principals and rejects three-axis canaries through both fixed-scope C-SPANN views.",
      "The database release does not enforce exact runtime-principal C-SPANN planning, execution, and serving-view isolation."
    ),
    sourceCheck(
      "impact.working-slice",
      "Real-World Impact",
      contains("README.md", /Financial Memory Control Room/iu) &&
        contains("README.md", /fixed synthetic/iu) &&
        contains("README.md", /working challenge slice/iu),
      "README defines the concrete CFO investigation slice without presenting the broader vision as shipped.",
      "The current working product slice is not stated precisely."
    ),
    sourceCheck(
      "impact.audit-before-action",
      "Real-World Impact",
      has("src/memory/consistency.ts") &&
        has("web/src/components/AuditLedger.tsx") &&
        /contradiction/iu.test(read("src/memory/consistency.ts")) &&
        /No automatic mutation/iu.test(read("web/src/components/AuditLedger.tsx")),
      "Contradictions and missing evidence are exposed as read-only recommendations before action.",
      "The accountable contradiction/absence user journey is incomplete."
    ),
    sourceCheck(
      "impact.public-data-boundary",
      "Real-World Impact",
      /dataClassification:\s*"synthetic-public-demo"/u.test(
        read("src/config/scope.ts")
      ) &&
        /Public,?\s+read-only demonstration data/iu.test(
          read("web/src/components/Hero.tsx")
        ),
      "The judge app is explicitly fixed to synthetic public data with no tenant selector.",
      "The public data classification/boundary is unclear."
    ),
    sourceCheck(
      "product.aws-reference-architecture",
      "Production Readiness",
      /AWS::CloudFront::Distribution/u.test(lambdaTemplate) &&
        /AWS::Serverless::HttpApi/u.test(lambdaTemplate) &&
        /AWS::Serverless::Function/u.test(lambdaTemplate) &&
        /AWS::S3::Bucket/u.test(lambdaTemplate) &&
        /DATABASE_SECRET_ID/u.test(lambdaTemplate) &&
        /^  ArchonHttpApi:$/mu.test(lambdaTemplate) &&
        !/^  ServerlessHttpApi:$/mu.test(lambdaTemplate) &&
        /HttpApiStageName:\s*Type:\s*String\s*Default:\s*live\s*AllowedValues:\s*- live/u.test(
          lambdaTemplate
        ) &&
        /StageName:\s*!Ref HttpApiStageName/u.test(lambdaTemplate) &&
        /OriginPath:\s*!Join\s*\["",\s*\["\/",\s*!Ref ArchonHttpApi\.Stage\]\]/u.test(
          lambdaTemplate
        ) &&
        /DetailedMetricsEnabled:\s*true/u.test(lambdaTemplate) &&
        /ThrottlingBurstLimit:\s*!Ref ApiThrottleBurst/u.test(
          lambdaTemplate
        ) &&
        /ThrottlingRateLimit:\s*!Ref ApiThrottleRate/u.test(
          lambdaTemplate
        ) &&
        /AccessLogSettings:/u.test(lambdaTemplate) &&
        /\/aws\/vendedlogs\/apigateway\//u.test(lambdaTemplate) &&
        (
          lambdaTemplate.match(/DeletionPolicy:\s+RetainExceptOnCreate/gu) ??
          []
        ).length === 3 &&
        /cloudformation:GetTemplate/u.test(deliveryBootstrap) &&
        /cloudfront:GetDistribution/u.test(deliveryBootstrap) &&
        /cloudfront:GetDistributionConfig/u.test(deliveryBootstrap) &&
        /logs:CreateLogDelivery/u.test(deliveryBootstrap) &&
        /logs:PutResourcePolicy/u.test(deliveryBootstrap) &&
        /logs:UpdateLogDelivery/u.test(deliveryBootstrap) &&
        /logs:DescribeLogStreams/u.test(deliveryBootstrap) &&
        /logs:FilterLogEvents/u.test(deliveryBootstrap) &&
        (
          deliveryBootstrap.match(
            /log-group:\/aws\/(?:vendedlogs\/)?apigateway\/\$\{AppName\}-(?:staging|production):\*"/gu
          ) ?? []
        ).length === 4 &&
        /Sid: VerifyStagingApiAccessLogs[\s\S]*?- logs:DescribeLogStreams\s+- logs:FilterLogEvents[\s\S]*?\$\{AppName\}-staging:\*"/u.test(
          deliveryBootstrap
        ) &&
        /Sid: VerifyProductionApiAccessLogs[\s\S]*?- logs:DescribeLogStreams\s+- logs:FilterLogEvents[\s\S]*?\$\{AppName\}-production:\*"/u.test(
          deliveryBootstrap
        ) &&
        /--template-stage Processed/u.test(apiStageProof) &&
        /apigatewayv2 get-stage/u.test(apiStageProof) &&
        /cloudfront wait distribution-deployed/u.test(apiStageProof) &&
        /cloudfront get-distribution-config/u.test(apiStageProof) &&
        /directStageHealth: "GET \/live\/api\/health 200"/u.test(
          apiStageProof
        ) &&
        /logs filter-log-events/u.test(apiStageProof) &&
        stageRoutingProofsPrecedeFrontend &&
        ci.includes("reserved logical ID|unexpected behaviors") &&
        deploy.includes("reserved logical ID|unexpected behaviors"),
      "SAM defines the private S3/CloudFront/Lambda architecture and CI proves the non-reserved named stage, exact live CloudFront binding, throttling, metrics, and access logs before frontend mutation.",
      "The deployable AWS architecture or its live API stage-control proof is incomplete."
    ),
    sourceCheck(
      "product.s3-access-logging-foundation",
      "Production Readiness",
      /S3AccessLogArchiveS39Suppression:[\s\S]*?Type: AWS::SecurityHub::AutomationRule/u.test(
        deliveryBootstrap
      ) &&
        /S3AccessLogArchive:[\s\S]*?DeletionPolicy: RetainExceptOnCreate[\s\S]*?ObjectOwnership: BucketOwnerEnforced/u.test(
          deliveryBootstrap
        ) &&
        /AllowArtifactBucketServerAccessLogs[\s\S]*?\/artifacts\/\*[\s\S]*?AllowStagingWebBucketServerAccessLogs[\s\S]*?\/staging-web\/\*[\s\S]*?AllowProductionWebBucketServerAccessLogs[\s\S]*?\/production-web\/\*/u.test(
          deliveryBootstrap
        ) &&
        /LoggingConfiguration: !If[\s\S]*?EnableArtifactAccessLogging[\s\S]*?PartitionDateSource: EventTime[\s\S]*?!Ref AWS::NoValue/u.test(
          deliveryBootstrap
        ) &&
        /cloudformation:GetStackPolicy/u.test(deliveryBootstrap) &&
        /aws:CalledVia: cloudformation\.amazonaws\.com/u.test(
          deliveryBootstrap
        ) &&
        /Sid: ExecuteOnlyBootstrapLoggingChangeSets[\s\S]*?cloudformation:ChangeSetName:[\s\S]*?changeSet\/bootstrap-s3-\*\/\*/u.test(
          deliveryBootstrap
        ) &&
        /Sid: ResolveExactCloudFormationExecutionRoles[\s\S]*?Action: iam:GetRole\s+Resource:\s+- !Sub >-\s+arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:role\/\$\{AppName\}-staging-cloudformation\s+- !Sub >-\s+arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:role\/\$\{AppName\}-production-cloudformation\s+Condition:\s+"ForAnyValue:StringEquals":\s+aws:CalledVia: cloudformation\.amazonaws\.com/u.test(
          foundationPromotionRole
        ) &&
        /Sid: ResolveExactFoundationRoleAttributes[\s\S]*?Action: iam:GetRole\s+Resource:\s+- !Sub >-\s+arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:role\/\$\{AppName\}-staging-lambda-runtime\s+- !Sub >-\s+arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:role\/\$\{AppName\}-production-lambda-runtime\s+- !Sub >-\s+arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:role\/\$\{AppName\}-staging-codedeploy\s+- !Sub >-\s+arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:role\/\$\{AppName\}-production-codedeploy\s+- !Sub >-\s+arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:role\/\$\{AppName\}-github-database-operator\s+- !Sub >-\s+arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:role\/\$\{AppName\}-github-foundation-promotion\s+- !Sub >-\s+arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:role\/\$\{AppName\}-github-staging-deploy\s+- !Sub >-\s+arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:role\/\$\{AppName\}-github-production-deploy\s+Condition:\s+"ForAnyValue:StringEquals":\s+aws:CalledVia: cloudformation\.amazonaws\.com/u.test(
          foundationPromotionRole
        ) &&
        /Sid: ResolveExactFoundationAutomationRule[\s\S]*?Action: securityhub:ListTagsForResource\s+Resource: !GetAtt S3AccessLogArchiveS39Suppression\.RuleArn\s+Condition:\s+"ForAnyValue:StringEquals":\s+aws:CalledVia: cloudformation\.amazonaws\.com/u.test(
          foundationPromotionRole
        ) &&
        (
          foundationPromotionRole.match(/Action: iam:GetRole/gmu) ?? []
        ).length === 2 &&
        (
          foundationPromotionRole.match(
            /arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:role\/\$\{AppName\}-[a-z-]+/gmu
          ) ?? []
        ).length === 10 &&
        (
          foundationPromotionRole.match(
            /Action: securityhub:ListTagsForResource/gmu
          ) ?? []
        ).length === 1 &&
        (
          foundationPromotionRole.match(
            /Resource: !GetAtt S3AccessLogArchiveS39Suppression\.RuleArn/gmu
          ) ?? []
        ).length === 2 &&
        !/iam:(?:ListRoles|ListRolePolicies|GetRolePolicy|ListAttachedRolePolicies|ListRoleTags)|role\/\*|automation-rule\/\*|Resource: "\*"/u.test(
          foundationPromotionRole
        ) &&
        (
          deliveryBootstrap.match(
            /Sid: InspectS3AccessLoggingFoundationStack/gmu
          ) ?? []
        ).length === 2 &&
        (
          deliveryBootstrap.match(
            /Resource: !GetAtt S3AccessLogArchiveS39Suppression\.RuleArn/gmu
          ) ?? []
        ).length === 4 &&
        (
          deliveryBootstrap.match(
            /Sid: InspectS3AccessLoggingFoundationRule/gmu
          ) ?? []
        ).length === 2 &&
        !/ListAutomationRules|automation-rule\/\*/u.test(
          deliveryBootstrap
        ) &&
        !/list-automation-rules/u.test(s3AccessLoggingProof) &&
        /\.Rules\[0\]\.RuleName == \$ruleName/u.test(
          s3AccessLoggingProof
        ) &&
        /name: Bootstrap AWS Foundation/u.test(foundationWorkflow) &&
        /operation:[\s\S]*?- plan[\s\S]*?- apply/u.test(
          foundationWorkflow
        ) &&
        /cloudformation get-stack-policy/u.test(foundationWorkflow) &&
        /StackPolicyBody \| fromjson/u.test(foundationWorkflow) &&
        /cloudformation get-template[\s\S]*?--template-stage Original/u.test(
          foundationWorkflow
        ) &&
        /foundation-change-set-template\.yaml[\s\S]*?TEMPLATE_DIGEST/u.test(
          foundationWorkflow
        ) &&
        /CHANGE_SET_ID/u.test(foundationWorkflow) &&
        /\.ChangeSetId == \$id/u.test(foundationWorkflow) &&
        /name: Delete an unverified unexecuted activation plan\s+if: \$\{\{ always\(\) && env\.ALREADY_ACTIVE != 'true' && steps\.exact_plan\.outcome == 'failure' && env\.CHANGE_SET_ID != '' \}\}[\s\S]*?\.ChangeSetId == \$id[\s\S]*?\.Status == "CREATE_COMPLETE"[\s\S]*?\.ExecutionStatus == "AVAILABLE"[\s\S]*?cloudformation delete-change-set[\s\S]*?--change-set-name "\$CHANGE_SET_ID"[\s\S]*?grep -Fq "ChangeSetNotFound"[\s\S]*?"ChangeSet \[\$CHANGE_SET_ID\] does not exist"[\s\S]*?test "\$deleted" = "true"[\s\S]*?record_cleanup "unverified-plan-deleted" true "AVAILABLE"/u.test(
          foundationWorkflow
        ) &&
        /--change-set-name "\$CHANGE_SET_ID"/u.test(
          foundationWorkflow
        ) &&
        /wait_for_change_set_available/u.test(foundationWorkflow) &&
        /wait_for_rollback_change_set/u.test(foundationWorkflow) &&
        (
          foundationWorkflow.match(/--include-property-values/gmu) ?? []
        ).length === 4 &&
        (
          foundationWorkflow.match(/--change-set-type UPDATE/gmu) ?? []
        ).length === 2 &&
        !/\.ChangeSetType/u.test(foundationWorkflow) &&
        (foundationWorkflow.match(/RoleARN \/\/ null/gmu) ?? []).length ===
          2 &&
        !/cloudformation wait change-set-create-complete/u.test(
          foundationWorkflow
        ) &&
        /ResourceChange\.LogicalResourceId == "ArtifactBucket"/u.test(
          foundationWorkflow
        ) &&
        /ResourceChange\.Replacement == "False"/u.test(
          foundationWorkflow
        ) &&
        /recover_to_baseline/u.test(foundationWorkflow) &&
        /poll_activation_outcome/u.test(foundationWorkflow) &&
        /wait_for_recovery_outcome/u.test(foundationWorkflow) &&
        !/stack-update-rollback-complete/u.test(foundationWorkflow) &&
        /live-proof-failed-rolled-back/u.test(foundationWorkflow) &&
        /prove-s3-access-logging\.sh baseline/u.test(
          foundationWorkflow
        ) &&
        /prove-s3-access-logging\.sh verify/u.test(
          foundationWorkflow
        ) &&
        /mode="\$\{1:-verify\}"/u.test(s3AccessLoggingProof) &&
        /PartitionDateSource": "EventTime"/u.test(
          s3AccessLoggingProof
        ) &&
        /"Update:Delete"[\s\S]*?"Update:Replace"/u.test(
          bootstrapStackPolicy
        ) &&
        /LogicalResourceId\/S3AccessLogArchiveS39Suppression/u.test(
          bootstrapStackPolicy
        ) &&
        /bash -n aws\/prove-s3-access-logging\.sh/u.test(ci) &&
        /foundation-s3-access-logging-receipt\.json/u.test(ci) &&
        /tests\/s3-access-logging\.test\.ts/u.test(packageSource) &&
        /rejects drift and redacts AWS failures/u.test(
          s3AccessLoggingTests
        ),
      "A retained, non-recursive S3 log archive, exact S3.9 exception, protected activation/rollback workflow with unverified-plan cleanup, CloudFormation-only dynamic-reference reads, live proof, and CI gate are source-controlled.",
      "The centralized S3 logging archive, narrow exception, activation recovery, exact dynamic-reference reads, proof, or CI/readiness gate is incomplete."
    ),
    sourceCheck(
      "product.application-s3-access-logging-live",
      "Production Readiness",
      /SpaBucket:[\s\S]*?LoggingConfiguration:[\s\S]*?DestinationBucketName: !Sub "\$\{AppName\}-s3-access-logs-\$\{AWS::AccountId\}-\$\{AWS::Region\}"[\s\S]*?LogFilePrefix: !Sub "\$\{Environment\}-web\/"[\s\S]*?PartitionDateSource: EventTime/u.test(
        lambdaTemplate
      ) &&
        /preflight\|validate-preflight\|verify\|recover/u.test(
          applicationS3AccessLoggingProof
        ) &&
        /bash aws\/prove-s3-access-logging\.sh verify/u.test(
          applicationS3AccessLoggingProof
        ) &&
        /archon\.application-s3-access-logging\.preflight/u.test(
          applicationS3AccessLoggingProof
        ) &&
        /canonicalization: "jq-cS-v1"/u.test(
          applicationS3AccessLoggingProof
        ) &&
        /NoSuchBucket/u.test(applicationS3AccessLoggingProof) &&
        /--template-stage Processed/u.test(
          applicationS3AccessLoggingProof
        ) &&
        /processedTemplateManaged: true/u.test(
          applicationS3AccessLoggingProof
        ) &&
        /foundationVerified: true/u.test(
          applicationS3AccessLoggingProof
        ) &&
        /EXPECTED_STACK_STATE/u.test(
          applicationS3AccessLoggingProof
        ) &&
        /AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN/u.test(
          applicationS3AccessLoggingProof
        ) &&
        /stack_fingerprint/u.test(applicationS3AccessLoggingProof) &&
        /--stack-name "\$stack_id"/u.test(
          applicationS3AccessLoggingProof
        ) &&
        /greenfield:absent\|existing:disabled\|existing:enabled/u.test(
          applicationS3AccessLoggingProof
        ) &&
        /CREATE_COMPLETE/u.test(applicationS3AccessLoggingProof) &&
        /UPDATE_COMPLETE/u.test(applicationS3AccessLoggingProof) &&
        /type == "string" then[\s\S]*?fromjson/u.test(
          applicationS3AccessLoggingProof
        ) &&
        applicationS3ProofsOrdered &&
        applicationS3TerminallyOrdered &&
        (
          deploy.match(
            /EXPECTED_STACK_STATE: \$\{\{ steps\.api_preflight\.outputs\.stack_state \}\}/gu
          ) ?? []
        ).length === 10 &&
        (
          deploy.match(/id: application_s3_verify/gu) ?? []
        ).length === 2 &&
        (
          deploy.match(
            /EXPECTED_PROOF_SHA256: \$\{\{ steps\.application_s3_verify\.outputs\.receipt_sha256 \}\}/gu
          ) ?? []
        ).length === 2 &&
        (
          deploy.match(
            /sha256sum application-s3-access-logging-proof\.json/gu
          ) ?? []
        ).length === 4 &&
        (
          deploy.match(
            /prove-application-s3-access-logging\.sh preflight/gu
          ) ?? []
        ).length === 4 &&
        (
          deploy.match(
            /prove-application-s3-access-logging\.sh verify/gu
          ) ?? []
        ).length === 4 &&
        (
          deploy.match(
            /prove-application-s3-access-logging\.sh \\\r?\n\s+validate-preflight/gu
          ) ?? []
        ).length === 2 &&
        (
          deploy.match(
            /prove-application-s3-access-logging\.sh recover/gu
          ) ?? []
        ).length === 2 &&
        recoveryBlocks.every((block) => {
          const preflightValidation = block.indexOf("validate-preflight");
          const snapshotValidation = block.indexOf(
            "bash aws/prove-recovery-snapshot.sh"
          );
          const firstRecoveryMutation = block.indexOf("RECOVERY_FAILED=0");
          return (
            /prove_application_s3_recovery/u.test(block) &&
            /application-s3-access-logging-recovery\.json/u.test(block) &&
            /EXPECTED_STACK_STATE/u.test(block) &&
            /sha256sum application-s3-access-logging-preflight\.json/u.test(
              block
            ) &&
            preflightValidation >= 0 &&
            snapshotValidation >= 0 &&
            firstRecoveryMutation >= 0 &&
            preflightValidation < firstRecoveryMutation &&
            snapshotValidation < firstRecoveryMutation
          );
        }) &&
        (
          deploy.match(
            /--slurpfile s3Preflight application-s3-access-logging-preflight\.json/gu
          ) ?? []
        ).length === 2 &&
        (
          deploy.match(
            /--slurpfile s3Proof "\$terminal_proof"/gu
          ) ?? []
        ).length === 2 &&
        (deploy.match(/s3AccessLogging: \{/gu) ?? []).length === 2 &&
        (
          deploy.match(
            /preMutationReproved: true[\s\S]*?loggingEnabled: true[\s\S]*?targetPrefix:[\s\S]*?partitionDateSource:[\s\S]*?processedTemplateManaged: true[\s\S]*?liveControlPlaneVerified: true/gu
          ) ?? []
        ).length === 2 &&
        (deploy.match(/terminalLiveReproved: true/gu) ?? []).length === 2 &&
        (deploy.match(/terminalProofSha256:/gu) ?? []).length === 2 &&
        /candidateSha/u.test(recoverySnapshot) &&
        /executionRoleArn/u.test(recoverySnapshot) &&
        /manifestSha256/u.test(recoverySnapshot) &&
        /bash -n aws\/prove-application-s3-access-logging\.sh/u.test(ci) &&
        /bash -n aws\/prove-recovery-snapshot\.sh/u.test(ci) &&
        /prove-application-s3-access-logging\.sh/u.test(
          s3AccessLoggingTests
        ) &&
        /greenfield[\s\S]*?CREATE_COMPLETE/u.test(
          s3AccessLoggingTests
        ) &&
        /stringTemplateBody/u.test(s3AccessLoggingTests),
      "Both application web buckets are source-controlled for exact EventTime S3 logging, cross-bound to immutable recovery snapshots, re-proved immediately before mutation and at the terminal receipt, verified in the processed template and live control plane, and restored fail-closed.",
      "Application S3 access logging lacks exact template/live proof, stack-state binding, immutable receipt evidence, pre-mutation replay protection, recovery verification, or CI regression coverage."
    ),
    sourceCheck(
      "product.durable-out-of-band-recovery",
      "Production Readiness",
      durableRecoveryScriptsAreCiGated &&
        durableRecoveryArmContract &&
        durableFrontendBaselineContract &&
        durableRecoveryCommitContract &&
        environmentDeployOidcTrustContract &&
        watchdogWorkflowContract &&
        durableS3CasLedgerContract &&
        durableRecoveryDataContract &&
        durableRecoveryIamContract &&
        cloudFormationControlsContract &&
        localArtifacts.length === 0,
      "Both deployments establish a checksum/version-bound S3 CAS recovery fence plus termination-protection and fresh drift gates before mutation; receipt-bound commits, daily audits, and a trusted serialized watchdog recover unresolved intents with no local residue.",
      "Durable pre-mutation fencing, S3 conditional CAS, receipt-bound terminal state, CloudFormation protection/drift evidence, trusted watchdog recovery, CI coverage, or runner artifact hygiene is incomplete."
    ),
    sourceCheck(
      "product.oidc-promotion-rollback",
      "Production Readiness",
      has("aws/bootstrap-oidc.yaml") &&
        /AssumeRoleWithWebIdentity/u.test(read("aws/bootstrap-oidc.yaml")) &&
        environmentDeployOidcTrustContract &&
        /Verify candidate tree hashes/iu.test(deploy) &&
        /Restore the previous production release/iu.test(deploy) &&
        /Hosted Chromium judge journey on staging/iu.test(deploy) &&
        (
          deploy.match(
            /name: Preflight API stage-proof permissions before stack mutation/gu
          ) ?? []
        ).length === 2 &&
        (
          deploy.match(/--template-stage Original/gu) ?? []
        ).length === 4 &&
        (
          deploy.match(/bash aws\/restore-cloudformation-stack\.sh/gu) ?? []
        ).length === 2 &&
        recoveryBlocks.every(
          (block) =>
            block.length > 0 &&
            block.includes("bash aws/delete-greenfield-stack.sh") &&
            block.includes('"$PREVIOUS_APPLICATION_URL/api/health"') &&
            block.includes('"$PREVIOUS_APPLICATION_URL/api/proof"') &&
            block.includes("set -euo pipefail") &&
            /RECOVERY_CANCELLED: \$\{\{ job\.status == 'cancelled' \}\}/u.test(
              block
            ) &&
            (
              block.match(/test "\$RECOVERY_FAILED" -eq 0/gu) ?? []
            ).length === 3
        ) &&
        (
          deploy.match(
            /name: Refresh short-lived AWS credentials for (?:staging|production) recovery/gu
          ) ?? []
        ).length === 2 &&
        (deploy.match(/timeout-minutes:\s+105/gu) ?? []).length === 2 &&
        /--template-body "file:\/\/\$\{immutable_template_file\}"/u.test(
          stackRestore
        ) &&
        /--parameters "file:\/\/\$\{immutable_parameters_file\}"/u.test(
          stackRestore
        ) &&
        /--tags "file:\/\/\$\{immutable_tags_file\}"/u.test(stackRestore) &&
        /assert_recovery_snapshot_integrity/u.test(stackRestore) &&
        /cloudformation create-change-set/u.test(stackRestore) &&
        /--client-token "\$change_set_name"/u.test(stackRestore) &&
        /change_set_id/u.test(stackRestore) &&
        /\.ExecutionStatus == "AVAILABLE"/u.test(stackRestore) &&
        /\.StackId == \$stackId/u.test(stackRestore) &&
        /EXPECTED_PREVIOUS_STACK_TEMPLATE_SHA256/u.test(stackRestore) &&
        /EXPECTED_PREVIOUS_STACK_PARAMETERS_SHA256/u.test(stackRestore) &&
        /EXPECTED_PREVIOUS_STACK_TAGS_SHA256/u.test(stackRestore) &&
        /--slurpfile expectedTags "\$immutable_tags_file"/u.test(
          stackRestore
        ) &&
        /cloudformation execute-change-set/u.test(stackRestore) &&
        /--client-request-token "\$execute_token"/u.test(stackRestore) &&
        /--no-disable-rollback/u.test(stackRestore) &&
        /--retain-except-on-create/u.test(stackRestore) &&
        /cloudformation continue-update-rollback/u.test(stackRestore) &&
        boundedCloudFormationPollingContract &&
        /cloudformation describe-stack-resources/u.test(greenfieldCleanup) &&
        /ArchonGreenfieldOwner/u.test(greenfieldCleanup) &&
        /aws:cloudformation:stack-id/u.test(greenfieldCleanup) &&
        /aws:cloudformation:stack-name/u.test(greenfieldCleanup) &&
        /aws:cloudformation:logical-id/u.test(greenfieldCleanup) &&
        /s3api get-bucket-tagging/u.test(greenfieldCleanup) &&
        /logs list-tags-for-resource/u.test(greenfieldCleanup) &&
        /--expected-bucket-owner "\$AWS_ACCOUNT_ID"/u.test(
          greenfieldCleanup
        ) &&
        /REVIEW_IN_PROGRESS/u.test(greenfieldCleanup) &&
        /DELETE_FAILED/u.test(greenfieldCleanup) &&
        /archon-retry-/u.test(greenfieldCleanup) &&
        !/NoSuchBucket\|Not Found\|\\\(404\\\)/u.test(greenfieldCleanup) &&
        /result_state="greenfield-stack-absent"/u.test(greenfieldCleanup) &&
        /cloudformation:DescribeStackResources/u.test(deliveryBootstrap) &&
        /s3:GetBucketTagging/u.test(deliveryBootstrap) &&
        /logs:ListTagsForResource/u.test(deliveryBootstrap) &&
        greenfieldRetainedLogCleanupContract &&
        greenfieldRerunOwnerContract &&
        /cloudformation delete-stack/u.test(greenfieldCleanup) &&
        /cloudformation update-termination-protection/u.test(
          greenfieldCleanup
        ) &&
        /--no-enable-termination-protection/u.test(greenfieldCleanup) &&
        /--client-request-token "\$delete_token"/u.test(greenfieldCleanup) &&
        /@json/u.test(samStackTagSerializer) &&
        samStackTagSerializer.includes('contains("\\\\") | not') &&
        /SAM tag serializer preserves legal parser-sensitive values/u.test(
          awsRecoveryTests
        ) &&
        /bash -n aws\/serialize-sam-stack-tags\.sh/u.test(ci) &&
        (
          deploy.match(
            /bash aws\/serialize-sam-stack-tags\.sh \\\r?\n\s+previous-stack-tags\.json >"\$serialized_tags_file"/gu
          ) ?? []
        ).length === 2 &&
        (
          deploy.match(
            /if: \(failure\(\) \|\| cancelled\(\)\) && steps\.deploy\.outputs\.started == 'true'/gu
          ) ?? []
        ).length === 4 &&
        (deploy.match(/terminally_proved=false/gu) ?? []).length === 2 &&
        (
          deploy.match(
            /actions\/runs\/\$\{GITHUB_RUN_ID\}\/attempts\/\$\{prior_attempt\}\/jobs\?per_page=100/gu
          ) ?? []
        ).length === 2 &&
        (deploy.match(/post_sam_tags="\$\{RUNNER_TEMP:\?\}/gu) ?? [])
          .length === 2 &&
        (deploy.match(/\.Stacks\[0\]\.StackId == \$previousStackId/gu) ?? [])
          .length === 2 &&
        (
          deliveryBootstrap.match(
            /Sid: Expand(?:Staging|Production)ServerlessTransform/gu
          ) ?? []
        ).length === 2 &&
        !/cloudformation:(?:CreateStack|UpdateStack)/u.test(
          deliveryBootstrap
        ) &&
        /s3api list-object-versions/u.test(greenfieldCleanup) &&
        /s3api delete-bucket/u.test(greenfieldCleanup) &&
        (
          deploy.match(
            /Reconcile an interrupted same-run (?:staging|production) greenfield recovery/gu
          ) ?? []
        ).length === 2 &&
        (deploy.match(/--annotation-directive EXCLUDE/gu) ?? []).length ===
          2 &&
        (
          deploy.match(
            /--expected-source-bucket-owner "\$AWS_ACCOUNT_ID"/gu
          ) ?? []
        ).length === 2 &&
        (deploy.match(/--revision-id "\$alias_revision"/gu) ?? []).length ===
          2,
      "Environment-bound OIDC, build-once promotion, immutable change-set recovery, run-owned greenfield cleanup, hosted E2E, and full-stack fail-closed rollback are source-controlled.",
      "OIDC/promotion/preflight/hosted verification/full-stack rollback evidence is incomplete."
    ),
    sourceCheck(
      "product.recovery-safe-canary",
      "Production Readiness",
      canaryDeployBlocks.every(
        (block) =>
          block.length > 0 &&
          canaryTrafficFragments.every((fragment) =>
            block.includes(fragment)
          ) &&
          /sam deploy[\s\S]*?--no-progressbar\s+stop_canary_probe\s+trap - EXIT/u.test(
            block
          )
      ) &&
        fullRecallSmokeBlocks.every(
          (block) =>
            block.length > 0 &&
            fullRecallFragments.every((fragment) => block.includes(fragment))
        ) &&
        (
          deploy.match(
            /canaryTrafficProbe:\s*"weighted-alias-proof-and-recall"/gu
          ) ?? []
        ).length === 2 &&
        (
          deploy.match(
            /deployAlarm:\s*"candidate-executed-version-errors"/gu
          ) ?? []
        ).length === 2 &&
        (
          deploy.match(
            /recallGate:\s*"post-promotion-with-explicit-restore"/gu
          ) ?? []
        ).length === 2 &&
        (
          deploy.match(
            /name: Restore the previous (?:staging|production) release on verification failure/gu
          ) ?? []
        ).length === 2 &&
        /Type:\s*Canary10Percent5Minutes[\s\S]*?Alarms:\s*- !Ref LambdaCanaryErrorAlarm/u.test(
          canaryDeploymentPreference
        ) &&
        !/!Ref LambdaErrorAlarm/u.test(canaryDeploymentPreference) &&
        /AlarmName:\s*!Sub\s+- "\$\{AppName\}-\$\{Environment\}-lambda-canary-errors-v\$\{CandidateVersion\}"\s+- CandidateVersion: !GetAtt ArchonFunction\.Version\.Version/u.test(
          candidateCanaryAlarm
        ) &&
        /Dimensions:\s*- Name: FunctionName\s+Value: !Ref ArchonFunction\s+- Name: Resource\s+Value: !Sub "\$\{ArchonFunction\}:live"\s+- Name: ExecutedVersion\s+Value: !GetAtt ArchonFunction\.Version\.Version/u.test(
          candidateCanaryAlarm
        ) &&
        /Dimensions:\s*- Name: FunctionName\s+Value: !Ref ArchonFunction/u.test(
          operationalLambdaAlarm
        ) &&
        !/Name:\s*(?:Resource|ExecutedVersion)/u.test(
          operationalLambdaAlarm
        ),
      "Both CodeDeploy shifts continuously exercise proof and recall while a fresh alarm isolates the exact candidate ExecutedVersion; each environment then requires the full grounded recall contract with explicit release restoration.",
      "The AWS canary is not candidate-version scoped, does not exercise both critical paths for the full shift, or lacks an environment-specific full recall/restore gate."
    ),
    sourceCheck(
      "product.generated-artifact-hygiene",
      "Production Readiness",
      GENERATED_ARTIFACT_BASENAMES.every((basename) =>
        gitignore.split(/\r?\n/u).includes(basename)
      ) &&
        [
          "frontend-prestate.json",
          "previous-index.html",
          "previous-live-alias.json",
          "recovery-intent.json",
          "recovery-intent.tar",
          "recovery-snapshot-proof.json",
          "staging-recovery-*.json",
          "production-recovery-*.json",
          "staging-durable-recovery-*.json",
          "production-durable-recovery-*.json",
          "staging-terminal-receipt-object.json",
          "production-terminal-receipt-object.json",
          "staging-cloudformation-controls-*.json",
          "production-cloudformation-controls-*.json",
        ].every((pattern) =>
          gitignore.split(/\r?\n/u).includes(pattern)
        ) &&
        ["dist/", "build/"].every((directory) =>
          gitignore.split(/\r?\n/u).includes(directory)
        ) &&
        [
          ...GENERATED_ARTIFACT_BASENAMES,
          ...DURABLE_RECOVERY_LOCAL_BASENAMES,
          "dist/nested/generated.js",
          "build/nested/generated.js",
        ].every((candidate) => ci.includes(candidate)) &&
        /for generated_path in "\$\{generated_paths\[@\]\}"; do[\s\S]*?git check-ignore --quiet -- "\$generated_path"/u.test(
          ci
        ) &&
        !/scripts\/build_video\.py/u.test(makefile),
      "Generated receipts and nested build outputs are recursively detected, ignored, and checked before CI fan-out.",
      "Generated-output ignore/detection gates or the Makefile cleanup are incomplete."
    ),
    sourceCheck(
      "product.no-local-build-products",
      "Production Readiness",
      localArtifacts.length === 0,
      "No local build/video products are left in the repository workspace.",
      "Local build or generated video artifacts remain."
    ),
    sourceCheck(
      "creativity.memory-disagrees",
      "Creativity & Originality",
      /auditConsistency/iu.test(read("src/agents/memory-agent.ts")) &&
        /contradictions/iu.test(read("src/memory/consistency.ts")) &&
        /absences/iu.test(read("src/memory/consistency.ts")),
      "The memory does more than retrieve: it surfaces cross-session disagreement and missing counterparts.",
      "The contradiction/absence memory differentiator is incomplete."
    ),
    sourceCheck(
      "creativity.live-proof-ledger",
      "Creativity & Originality",
      /pg_catalog\.pg_indexes/iu.test(handler) &&
        /runtimePrincipal/iu.test(handler) &&
        has("web/src/components/ProofLedger.tsx"),
      "The UI exposes a live, catalog-backed infrastructure and model proof ledger.",
      "The proof ledger is static or lacks live catalog evidence."
    ),
    sourceCheck(
      "creativity.provenance-receipts",
      "Creativity & Originality",
      has("aws/create-deployment-receipt.mjs") &&
        /buildOncePromoteSameArtifact/iu.test(
          read("aws/create-deployment-receipt.mjs")
        ) &&
        /citation and numeric grounding guard/iu.test(handler),
      "Evidence citations and cryptographic deployment receipts make provenance visible at both product and delivery layers.",
      "Product/deployment provenance evidence is incomplete."
    ),
  ];
}

function validHostedUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      url.href === `${CANONICAL_DEMO_URL}/` &&
      url.protocol === "https:" &&
      url.origin === CANONICAL_DEMO_URL &&
      url.pathname === "/" &&
      url.username === "" &&
      url.password === "" &&
      url.port === "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

function validPublicRepositoryUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname.toLowerCase() === "github.com" &&
      url.pathname.replace(/\/+$/u, "") ===
        "/upgradedev/archon-cockroach-memory" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

function eligibilityRequirements(): EligibilityRequirement[] {
  const demoUrl = process.env.SUBMISSION_DEMO_URL?.trim();
  const videoUrl = process.env.SUBMISSION_VIDEO_URL?.trim();
  const publicRepoUrl =
    process.env.SUBMISSION_PUBLIC_REPO_URL?.trim() ||
    "https://github.com/upgradedev/archon-cockroach-memory";

  const requirement = (
    id: string,
    complete: boolean,
    done: string,
    pending: string
  ): EligibilityRequirement => ({
    id,
    status: complete ? "complete" : "pending",
    detail: complete ? done : pending,
  });

  return [
    requirement(
      "public-repository-and-license",
      has("LICENSE") && validPublicRepositoryUrl(publicRepoUrl),
      "Public GitHub repository target and MIT license are identified.",
      "Confirm the public repository URL and OSI license."
    ),
    requirement(
      "unrestricted-functional-demo",
      validHostedUrl(demoUrl),
      `Unrestricted HTTPS demo supplied: ${demoUrl}`,
      "Set SUBMISSION_DEMO_URL after production CloudFront hosted smoke/E2E passes."
    ),
    requirement(
      "public-under-three-minute-video",
      Boolean(
        videoUrl &&
          /^https:\/\/(?:www\.)?(?:youtube\.com|youtu\.be|vimeo\.com)\//iu.test(
            videoUrl
          )
      ),
      `Public YouTube/Vimeo demo supplied: ${videoUrl}`,
      "Set SUBMISSION_VIDEO_URL only after the final public <3-minute browser/memory demo is uploaded."
    ),
    requirement(
      "english-description-and-tool-identification",
      has("docs/DEVPOST_SUBMISSION.md") &&
        contains("docs/DEVPOST_SUBMISSION.md", /Managed MCP/iu) &&
        contains("docs/DEVPOST_SUBMISSION.md", /Distributed Vector/iu) &&
        contains("docs/DEVPOST_SUBMISSION.md", /AWS/iu),
      "Final English Devpost description identifies the CockroachDB and AWS tools.",
      "Create docs/DEVPOST_SUBMISSION.md at the final submission phase."
    ),
    requirement(
      "prior-work-disclosure",
      contains("README.md", /Prior-work disclosure/iu) &&
        contains("README.md", /pre-existing/iu) &&
        contains("README.md", /challenge-period/iu),
      "README separates pre-existing Archon work from challenge-period implementation.",
      "Add an explicit prior-work disclosure."
    ),
    requirement(
      "devpost-submitted",
      process.env.DEVPOST_SUBMITTED === "1",
      "Operator confirmed the Devpost form is submitted.",
      "Set DEVPOST_SUBMITTED=1 only after the final form has been submitted."
    ),
  ];
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

export function evaluate(): ReadinessReport {
  const checks = sourceChecks();
  const judging = Object.fromEntries(
    OFFICIAL_CRITERIA.map((criterion) => {
      const group = checks.filter((check) => check.criterion === criterion);
      const passed = group.filter((check) => check.status === "pass").length;
      return [
        criterion,
        {
          passed,
          total: group.length,
          pct: group.length ? round((passed / group.length) * 100) : 0,
        },
      ];
    })
  ) as ReadinessReport["judging"];

  const passed = checks.filter((check) => check.status === "pass").length;
  const pct = checks.length ? round((passed / checks.length) * 100) : 0;
  const requirements = eligibilityRequirements();
  const eligibilityComplete = requirements.filter(
    (requirement) => requirement.status === "complete"
  ).length;
  const eligibilityPass = eligibilityComplete === requirements.length;
  const sourceGatePass = pct >= SOURCE_FLOOR;

  return {
    generatedAt: new Date().toISOString(),
    checks,
    judging,
    sourceGate: {
      threshold: SOURCE_FLOOR,
      passed,
      total: checks.length,
      pct,
      pass: sourceGatePass,
    },
    eligibility: {
      requirements,
      complete: eligibilityComplete,
      total: requirements.length,
      pass: eligibilityPass,
    },
    submissionEligible: isSubmissionEligible(
      sourceGatePass,
      eligibilityPass
    ),
  };
}

function printReport(report: ReadinessReport): void {
  console.log("\nARCHON MEMORY — SOURCE READINESS / SUBMISSION ELIGIBILITY");
  for (const criterion of OFFICIAL_CRITERIA) {
    const score = report.judging[criterion];
    console.log(`\n${criterion}: ${score.pct}% (${score.passed}/${score.total})`);
    for (const check of report.checks.filter(
      (item) => item.criterion === criterion
    )) {
      console.log(`  ${check.status === "pass" ? "PASS" : "FAIL"} ${check.id} — ${check.detail}`);
    }
  }
  console.log(
    `\nSOURCE GATE: ${report.sourceGate.pass ? "PASS" : "FAIL"} ` +
      `${report.sourceGate.pct}% (floor ${report.sourceGate.threshold}%)`
  );
  console.log(
    `SUBMISSION ELIGIBLE: ${report.submissionEligible ? "YES" : "NO"} ` +
      `(${report.eligibility.complete}/${report.eligibility.total})`
  );
  for (const item of report.eligibility.requirements) {
    console.log(`  ${item.status.toUpperCase()} ${item.id} — ${item.detail}`);
  }
  console.log();
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
const isMain = invokedPath === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const report = evaluate();
  const output = process.env.READINESS_OUTPUT?.trim();
  if (output) {
    writeFileSync(resolve(ROOT, output), `${JSON.stringify(report, null, 2)}\n`);
  }
  printReport(report);
  if (!report.sourceGate.pass) process.exitCode = 1;
  if (
    process.env.REQUIRE_SUBMISSION_READY === "1" &&
    !report.submissionEligible
  ) {
    process.exitCode = 1;
  }
}
