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
export const EXPECTED_WORKFLOW_ACTION_REFS = 59;
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
] as const;
const ALLOWED_LOCAL_ACTION_REFS = new Set([
  "./.github/workflows/database-release.yml",
]);
export const GENERATED_ARTIFACT_BASENAMES = [
  "legacy-reconciliation-receipt.json",
  "api-stage-preflight.json",
  "api-stage-proof.json",
  "foundation-s3-access-logging-receipt.json",
  "previous-stack-template.yaml",
  "previous-stack-parameters.json",
  "bench-clustered.txt",
  "bench-uniform.txt",
  "distribution.txt",
  "server.pid",
] as const;
const CANONICAL_DEMO_URL =
  "https://d2s5v0o0eg2aaw.cloudfront.net";

export const OFFICIAL_CRITERIA = [
  "Agentic Memory Design",
  "Technological Implementation",
  "Real-World Impact",
  "Product Readiness",
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
          (relative === "demo/assets" &&
            blockedDemoDirectories.has(entry.name))
        ) {
          found.push(childRelative);
          continue;
        }
        visit(join(absolute, entry.name), childRelative);
      } else if (
        blockedBasenames.has(entry.name) ||
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
  return (
    ci !== undefined &&
    codeql !== undefined &&
    hasExactCiTrigger(ci.source) &&
    hasExactCodeqlTrigger(codeql.source)
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
  const foundationWorkflow = read(
    ".github/workflows/bootstrap-aws.yml"
  );
  const lambdaTemplate = read("aws/template.yaml");
  const deliveryBootstrap = read("aws/bootstrap-oidc.yaml");
  const foundationPromotionRole =
    deliveryBootstrap.match(
      /(?:^|\r?\n)  FoundationPromotionRole:\r?\n[\s\S]*?(?=\r?\n  StagingDeployRole:\r?\n|$)/u
    )?.[0] ?? "";
  const apiStageProof = read("aws/prove-api-stage-controls.sh");
  const s3AccessLoggingProof = read(
    "aws/prove-s3-access-logging.sh"
  );
  const bootstrapStackPolicy = read(
    "aws/bootstrap-stack-policy.json"
  );
  const s3AccessLoggingTests = read(
    "tests/s3-access-logging.test.ts"
  );
  const stackRestore = read("aws/restore-cloudformation-stack.sh");
  const greenfieldCleanup = read("aws/delete-greenfield-stack.sh");
  const gitignore = read(".gitignore");
  const makefile = read("Makefile");
  const narrator = read("src/agents/narrator.ts");
  const handler = read("src/http/handler.ts");
  const memory = read("src/memory/memory.ts");
  const packageSource = read("package.json");
  const managedMcpAudit = read("scripts/cloud-mcp-audit.ts");
  const managedMcpAuditTests = read("tests/cloud-mcp-audit.test.ts");
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
      /- name: Restore the previous staging release on verification failure[\s\S]*?(?=\r?\n      - name: Publish sanitized staging deployment receipt)/u
    )?.[0] ?? "",
    deploy.match(
      /- name: Restore the previous production release on verification failure[\s\S]*?(?=\r?\n      - name: Publish sanitized production deployment receipt)/u
    )?.[0] ?? "",
  ];
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
      "Technological Implementation",
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
      "Technological Implementation",
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
      "Technological Implementation",
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
      "Technological Implementation",
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
      "Technological Implementation",
      hasExactCiTrigger(ci) &&
        hasUniqueCiTriggerOwnership(workflowEntries),
      "The CI workflow runs once for main pushes and every pull request; only CI and the explicit CodeQL scan own those repository events.",
      "CI triggers are duplicated repository-wide, omit main, or filter pull requests."
    ),
    sourceCheck(
      "tech.bedrock-grounding",
      "Technological Implementation",
      /checks:\s*\{[\s\S]*claims:\s*boolean/iu.test(narrator) &&
        /RECALL_MIN_SCORE/iu.test(handler) &&
        /citation/iu.test(narrator),
      "Bedrock narration is guarded by relevance abstention, per-claim citations, numeric checks, and fallback.",
      "Grounding or relevance-abstention controls are incomplete."
    ),
    sourceCheck(
      "tech.runtime-cspann-release-gate",
      "Technological Implementation",
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
      "Product Readiness",
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
      "Product Readiness",
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
        /name: Delete an unverified unexecuted activation plan\s+if: \$\{\{ always\(\) && env\.ALREADY_ACTIVE != 'true' && steps\.exact_plan\.outcome == 'failure' && env\.CHANGE_SET_ID != '' \}\}[\s\S]*?\.Status == "CREATE_COMPLETE"[\s\S]*?\.ExecutionStatus == "AVAILABLE"[\s\S]*?cloudformation delete-change-set[\s\S]*?--change-set-name "\$CHANGE_SET_ID"[\s\S]*?grep -Fq "ChangeSetNotFound"[\s\S]*?"ChangeSet \[\$CHANGE_SET_ID\] does not exist"[\s\S]*?test "\$deleted" = "true"[\s\S]*?record_cleanup "unverified-plan-deleted" true "AVAILABLE"/u.test(
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
      "product.oidc-promotion-rollback",
      "Product Readiness",
      has("aws/bootstrap-oidc.yaml") &&
        /AssumeRoleWithWebIdentity/u.test(read("aws/bootstrap-oidc.yaml")) &&
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
        ).length === 2 &&
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
            (
              block.match(/test "\$RECOVERY_FAILED" -eq 0/gu) ?? []
            ).length === 2
        ) &&
        (
          deploy.match(
            /name: Refresh short-lived AWS credentials for (?:staging|production) recovery/gu
          ) ?? []
        ).length === 2 &&
        (deploy.match(/timeout-minutes:\s+90/gu) ?? []).length === 2 &&
        /--parameters "file:\/\/\$\{parameters_file\}"/u.test(stackRestore) &&
        /cloudformation create-change-set/u.test(stackRestore) &&
        /cloudformation execute-change-set/u.test(stackRestore) &&
        /cloudformation wait stack-update-complete/u.test(stackRestore) &&
        /cloudformation delete-stack/u.test(greenfieldCleanup) &&
        /s3api list-object-versions/u.test(greenfieldCleanup) &&
        /s3api delete-bucket/u.test(greenfieldCleanup),
      "Environment-bound OIDC, build-once promotion, pre-mutation permission proof, hosted E2E, and full-stack fail-closed rollback are source-controlled.",
      "OIDC/promotion/preflight/hosted verification/full-stack rollback evidence is incomplete."
    ),
    sourceCheck(
      "product.recovery-safe-canary",
      "Product Readiness",
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
      "Product Readiness",
      GENERATED_ARTIFACT_BASENAMES.every((basename) =>
        gitignore.split(/\r?\n/u).includes(basename)
      ) &&
        ["dist/", "build/"].every((directory) =>
          gitignore.split(/\r?\n/u).includes(directory)
        ) &&
        [
          ...GENERATED_ARTIFACT_BASENAMES,
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
      "Product Readiness",
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
