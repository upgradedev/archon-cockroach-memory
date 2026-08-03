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

import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { parseDocument } from "yaml";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SOURCE_FLOOR = Number(process.env.SOURCE_READINESS_FLOOR ?? 100);
export const PINNED_NODE_VERSION = "22.23.1";
export const PINNED_CODEQL_ACTION_SHA =
  "4187e74d05793876e9989daffde9c3e66b4acd07";
export const EXPECTED_WORKFLOW_ACTION_REFS = 216;
export const EXPECTED_SETUP_NODE_STEPS = 31;
export const EXPECTED_COCKROACH_IMAGE_REFS = 9;
export const EXPECTED_COMPOSE_IMAGE_REFS = 4;
export const EXPECTED_DOCKERFILE_BASE_REFS = 0;
export const EXPECTED_WORKFLOW_FILES = [
  "alarm-routing-controls.yml",
  "aws-security-baseline.yml",
  "benchmark.yml",
  "bootstrap-aws.yml",
  "ci.yml",
  "cockroach-restore-drill.yml",
  "codeql.yml",
  "database-credential-rotation.yml",
  "database-release.yml",
  "demo-video.yml",
  "deploy-aws.yml",
  "edge-controls.yml",
  "finops-controls.yml",
  "foundation-migration.yml",
  "hosted-load-evidence.yml",
  "human-impact-evaluation.yml",
  "managed-mcp-audit.yml",
  "memory-evaluation.yml",
  "recover-aws.yml",
  "security-dast.yml",
  "submission-readiness.yml",
  "supply-chain.yml",
  "sustainability-intensity-evidence.yml",
  "well-architected-audit.yml",
] as const;
export const EXPECTED_DEPENDABOT_RELEASE_FREEZE = [
  ["docker-compose", "/"],
  ["github-actions", "/"],
  ["npm", "/"],
  ["npm", "/web"],
] as const;
const ALLOWED_LOCAL_ACTION_REFS = new Set([
  "./.github/workflows/database-release.yml",
  "./.github/workflows/security-dast.yml",
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
  "submission-readiness-receipt.json",
  "supply-chain-release-receipt.json",
  "well-architected-repository-receipt.json",
  "well-architected-live-receipt.json",
  "aws-account-security-baseline-receipt.json",
  "database-credential-rotation-receipt.json",
  "hosted-load-receipt.json",
  "hosted-k6-summary.json",
  "hosted-load-contract.sha256",
  "k6-machine-readable-schema.json",
  "sustainability-intensity-receipt.json",
  "human-impact-receipt.json",
  "evidence-manifest.sha256",
  "lambda-zip-content.sha256",
  "sbom-inputs-and-documents.sha256",
  "memory-evaluation-receipt.json",
  "policy-results.json",
  "scale-manifest.json",
  "vector-results.json",
  "vector-benchmark.log",
  "candidate-evidence-binding.json",
  "production-capture.webm",
  "capture-receipt.json",
  "narration-receipt.json",
  "video-build-receipt.json",
  "video-verification-receipt.json",
  "video-release-binding.json",
  "toolchain-provenance.json",
  "demo-video-publication.json",
  "01-hook.png",
  "02-scope-architecture.png",
  "03-recall-grounding.png",
  "04-audit-conflict.png",
  "05-audit-absence.png",
  "06-proof-ledger.png",
  "07-managed-mcp.png",
  "08-close.png",
  "captions.en.srt",
  "archon-memory-demo.mp4",
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
  "aws/classify-github-recovery-preflight.sh",
  "aws/classify-durable-recovery-source.sh",
  "aws/create-durable-recovery-bundle.sh",
  "aws/download-durable-recovery-bundle.sh",
  "aws/enforce-cloudformation-controls.sh",
  "aws/extract-durable-recovery-bundle.sh",
  "aws/finalize-durable-recovery-receipt.sh",
  "aws/fetch-codedeploy-appspec-revision.sh",
  "aws/put-durable-recovery-object.sh",
  "aws/recover-durable-environment.sh",
  "aws/recovery-intent-ledger.sh",
  "aws/verify-durable-recovery-bundle.sh",
  "aws/verify-durable-recovery-receipt.sh",
] as const;
const CANONICAL_DEMO_URL =
  "https://d2s5v0o0eg2aaw.cloudfront.net";
const CANONICAL_DEMO_HOSTNAME = new URL(CANONICAL_DEMO_URL).hostname;
export const SUBMISSION_THUMBNAIL_PATH =
  "demo/assets/devpost-thumbnail.png";
export const MAX_SUBMISSION_THUMBNAIL_BYTES = 5_000_000;

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

export interface IncrementalFixedCostEvaluation {
  valid: boolean;
  scenarioMonthlyUsd: Record<string, number>;
  maximumMonthlyUsd: number | null;
  approvedCeilingMonthlyUsd: number | null;
  headroomMonthlyUsd: number | null;
}

const INCREMENTAL_FIXED_COST_SCENARIOS = [
  "initial",
  "afterFirstBilledKmsRotation",
  "afterSecondBilledKmsRotation",
] as const;

type IncrementalFixedCostScenario =
  (typeof INCREMENTAL_FIXED_COST_SCENARIOS)[number];

const EXPECTED_INCREMENTAL_FIXED_COST_LINE_ITEMS = [
  {
    id: "cloudfront-web-acls",
    quantity: 2,
    unitMonthlyUsdCents: 500,
    pricingSource: "awsWaf",
  },
  {
    id: "web-acl-rules",
    quantity: 10,
    unitMonthlyUsdCents: 100,
    pricingSource: "awsWaf",
  },
  {
    id: "standard-cloudwatch-alarm-metrics",
    quantity: 6,
    unitMonthlyUsdCents: 10,
    pricingSource: "awsCloudWatch",
  },
  {
    id: "secrets-manager-secrets",
    quantity: 2,
    unitMonthlyUsdCents: 40,
    pricingSource: "awsSecretsManager",
  },
  {
    id: "application-customer-managed-kms-key",
    quantity: 1,
    unitMonthlyUsdCents: 100,
    pricingSource: "awsKms",
    billedUnitsByScenario: {
      initial: 1,
      afterFirstBilledKmsRotation: 2,
      afterSecondBilledKmsRotation: 3,
    },
  },
] as const;

const EXPECTED_INCREMENTAL_FIXED_COST_TOTALS_CENTS: Record<
  IncrementalFixedCostScenario,
  number
> = {
  initial: 2240,
  afterFirstBilledKmsRotation: 2340,
  afterSecondBilledKmsRotation: 2440,
};

const EXPECTED_INCREMENTAL_FIXED_COST_PRICING_URLS = {
  awsCloudWatch: "https://aws.amazon.com/cloudwatch/pricing/",
  awsKms: "https://aws.amazon.com/kms/pricing/",
  awsSecretsManager: "https://aws.amazon.com/secrets-manager/pricing/",
  awsWaf: "https://aws.amazon.com/waf/pricing/",
} as const;

const EXPECTED_INCREMENTAL_FIXED_COST_VARIABLE_EXCLUSIONS = [
  "AWS WAF requests",
  "CloudWatch Logs ingestion and storage",
  "Amazon S3 storage and requests",
  "Amazon EventBridge events",
  "data transfer",
] as const;

const EXPECTED_INCREMENTAL_FIXED_COST_EXTERNAL_EXCLUSIONS = [
  "taxes",
  "application compute, API, and network services",
  "CockroachDB Cloud",
  "model and inference services",
  "conditional regional alarm-routing control",
  "optional FinOps human notification route",
  "GitHub Actions",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactObjectKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[]
): boolean {
  const actual = Object.keys(value).sort((left, right) =>
    left.localeCompare(right)
  );
  const expected = [...expectedKeys].sort((left, right) =>
    left.localeCompare(right)
  );
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function sameOrderedStrings(
  value: unknown,
  expected: readonly string[]
): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  );
}

function usdToCents(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  const cents = Math.round(value * 100);
  return Math.abs(value - cents / 100) < Number.EPSILON * 100
    ? cents
    : null;
}

export function evaluateIncrementalFixedCostContract(
  value: unknown
): IncrementalFixedCostEvaluation {
  const invalid: IncrementalFixedCostEvaluation = {
    valid: false,
    scenarioMonthlyUsd: {},
    maximumMonthlyUsd: null,
    approvedCeilingMonthlyUsd: null,
    headroomMonthlyUsd: null,
  };
  if (!isRecord(value) || !isRecord(value.incrementalFixedCostContract)) {
    return invalid;
  }

  const contract = value.incrementalFixedCostContract;
  const contractKeysValid = hasExactObjectKeys(contract, [
    "schema",
    "schemaVersion",
    "scope",
    "currency",
    "billingPeriod",
    "pricingAsOf",
    "officialPricingUrls",
    "lineItems",
    "scenarios",
    "maximumExpectedMonthlyUsd",
    "approvedCeilingMonthlyUsd",
    "ceilingComparison",
    "variableUsageChargesExcluded",
    "externalAndOutOfScopeChargesExcluded",
  ]);

  const pricingUrls = isRecord(contract.officialPricingUrls)
    ? contract.officialPricingUrls
    : {};
  const pricingUrlsValid =
    hasExactObjectKeys(
      pricingUrls,
      Object.keys(EXPECTED_INCREMENTAL_FIXED_COST_PRICING_URLS)
    ) &&
    Object.entries(EXPECTED_INCREMENTAL_FIXED_COST_PRICING_URLS).every(
      ([key, expected]) => pricingUrls[key] === expected
    );

  const totalsCents: Record<IncrementalFixedCostScenario, number> = {
    initial: 0,
    afterFirstBilledKmsRotation: 0,
    afterSecondBilledKmsRotation: 0,
  };
  const lineItems = Array.isArray(contract.lineItems)
    ? contract.lineItems
    : [];
  let lineItemsValid =
    lineItems.length === EXPECTED_INCREMENTAL_FIXED_COST_LINE_ITEMS.length;

  for (const [index, expected] of
    EXPECTED_INCREMENTAL_FIXED_COST_LINE_ITEMS.entries()) {
    const item = lineItems[index];
    if (!isRecord(item)) {
      lineItemsValid = false;
      continue;
    }
    const expectedBilledUnitsByScenario =
      "billedUnitsByScenario" in expected
        ? expected.billedUnitsByScenario
        : undefined;
    const hasScenarioUnits = expectedBilledUnitsByScenario !== undefined;
    lineItemsValid &&=
      hasExactObjectKeys(item, [
        "id",
        "description",
        "quantity",
        "unitMonthlyUsd",
        "pricingSource",
        ...(hasScenarioUnits ? ["billedUnitsByScenario"] : []),
        "monthlyUsdByScenario",
      ]) &&
      item.id === expected.id &&
      typeof item.description === "string" &&
      item.description.trim().length > 0 &&
      item.quantity === expected.quantity &&
      usdToCents(item.unitMonthlyUsd) === expected.unitMonthlyUsdCents &&
      item.pricingSource === expected.pricingSource;

    const declaredMonthly = isRecord(item.monthlyUsdByScenario)
      ? item.monthlyUsdByScenario
      : {};
    lineItemsValid &&= hasExactObjectKeys(
      declaredMonthly,
      INCREMENTAL_FIXED_COST_SCENARIOS
    );
    const declaredBilledUnits = isRecord(item.billedUnitsByScenario)
      ? item.billedUnitsByScenario
      : {};
    if (hasScenarioUnits) {
      lineItemsValid &&= hasExactObjectKeys(
        declaredBilledUnits,
        INCREMENTAL_FIXED_COST_SCENARIOS
      );
    }

    for (const scenario of INCREMENTAL_FIXED_COST_SCENARIOS) {
      const billedUnits = hasScenarioUnits
        ? declaredBilledUnits[scenario]
        : item.quantity;
      const expectedBilledUnits =
        expectedBilledUnitsByScenario?.[scenario] ?? expected.quantity;
      const unitsValid =
        typeof billedUnits === "number" &&
        Number.isInteger(billedUnits) &&
        billedUnits === expectedBilledUnits;
      lineItemsValid &&= unitsValid;
      if (!unitsValid) continue;
      const computedMonthlyCents =
        expected.unitMonthlyUsdCents * billedUnits;
      totalsCents[scenario] += computedMonthlyCents;
      lineItemsValid &&=
        usdToCents(declaredMonthly[scenario]) === computedMonthlyCents;
    }
  }

  const scenarios = Array.isArray(contract.scenarios)
    ? contract.scenarios
    : [];
  let scenariosValid =
    scenarios.length === INCREMENTAL_FIXED_COST_SCENARIOS.length;
  for (const [index, scenarioId] of INCREMENTAL_FIXED_COST_SCENARIOS.entries()) {
    const scenario = scenarios[index];
    scenariosValid &&=
      isRecord(scenario) &&
      hasExactObjectKeys(scenario, ["id", "expectedMonthlyUsd"]) &&
      scenario.id === scenarioId &&
      totalsCents[scenarioId] ===
        EXPECTED_INCREMENTAL_FIXED_COST_TOTALS_CENTS[scenarioId] &&
      usdToCents(scenario.expectedMonthlyUsd) === totalsCents[scenarioId];
  }

  const maximumCents = Math.max(...Object.values(totalsCents));
  const declaredMaximumCents = usdToCents(
    contract.maximumExpectedMonthlyUsd
  );
  const ceilingCents = usdToCents(contract.approvedCeilingMonthlyUsd);
  const maximumAndCeilingValid =
    declaredMaximumCents === maximumCents &&
    maximumCents === 2440 &&
    ceilingCents === 2600 &&
    maximumCents < ceilingCents &&
    contract.ceilingComparison === "strictly-less-than";

  const scenarioMonthlyUsd = Object.fromEntries(
    INCREMENTAL_FIXED_COST_SCENARIOS.map((scenario) => [
      scenario,
      totalsCents[scenario] / 100,
    ])
  );
  const valid =
    contractKeysValid &&
    contract.schema === "archon.aws.incremental-fixed-monthly-cost-contract" &&
    contract.schemaVersion === 1 &&
    contract.scope ===
      "incremental foundation + two edge stacks; not total application cost" &&
    contract.currency === "USD" &&
    contract.billingPeriod === "month" &&
    contract.pricingAsOf === "2026-08-03" &&
    pricingUrlsValid &&
    lineItemsValid &&
    scenariosValid &&
    maximumAndCeilingValid &&
    sameOrderedStrings(
      contract.variableUsageChargesExcluded,
      EXPECTED_INCREMENTAL_FIXED_COST_VARIABLE_EXCLUSIONS
    ) &&
    sameOrderedStrings(
      contract.externalAndOutOfScopeChargesExcluded,
      EXPECTED_INCREMENTAL_FIXED_COST_EXTERNAL_EXCLUSIONS
    );

  return {
    valid,
    scenarioMonthlyUsd,
    maximumMonthlyUsd: maximumCents / 100,
    approvedCeilingMonthlyUsd:
      ceilingCents === null ? null : ceilingCents / 100,
    headroomMonthlyUsd:
      ceilingCents === null ? null : (ceilingCents - maximumCents) / 100,
  };
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function extractNamedWorkflowStep(source: string, name: string): string {
  return (
    source.match(
      new RegExp(
        `(?:^|\\r?\\n)      - name: ${escapeRegExp(name)}\\r?\\n[\\s\\S]*?(?=\\r?\\n      - name: |$)`,
        "u"
      )
    )?.[0] ?? ""
  );
}

function extractNamedWorkflowJob(source: string, id: string): string {
  return (
    source.match(
      new RegExp(
        `(?:^|\\r?\\n)  ${escapeRegExp(id)}:\\r?\\n[\\s\\S]*?(?=\\r?\\n  [A-Za-z0-9_-]+:\\r?\\n|$)`,
        "u"
      )
    )?.[0] ?? ""
  );
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
        /\.(?:aac|avi|flac|m4a|mkv|mov|mp3|mp4|ogg|opus|pyc|srt|wav|webm|wmv)$/iu.test(
          entry.name
        ) ||
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

export function allWorkflowActionCommitsInventoryLocked(
  sources: string[],
  lockSource: string
): boolean {
  const parsed = sources.map(parseWorkflow);
  if (parsed.some((workflow) => workflow === undefined)) return false;
  const workflowShas = new Set<string>();
  for (const workflow of parsed) {
    for (const ref of workflow?.uses.map(({ ref }) => ref) ?? []) {
      if (typeof ref !== "string" || ref.startsWith("./")) continue;
      const match = /@([a-f0-9]{40})$/u.exec(ref);
      if (!match) continue;
      workflowShas.add(match[1]);
    }
  }

  let lock: unknown;
  try {
    lock = JSON.parse(lockSource) as unknown;
  } catch {
    return false;
  }
  if (!lock || typeof lock !== "object" || Array.isArray(lock)) return false;
  const actions = (lock as Record<string, unknown>).actions;
  if (!actions || typeof actions !== "object" || Array.isArray(actions)) {
    return false;
  }
  const lockedShas = new Set<string>();
  for (const entry of Object.values(actions)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return false;
    }
    const sha = (entry as Record<string, unknown>).sha;
    if (typeof sha !== "string" || !/^[a-f0-9]{40}$/u.test(sha)) {
      return false;
    }
    lockedShas.add(sha);
  }
  return (
    workflowShas.size === lockedShas.size &&
    [...workflowShas].every((sha) => lockedShas.has(sha))
  );
}

export function allCheckoutStepsDisableCredentialPersistence(
  sources: string[]
): boolean {
  const parsed = sources.map(parseWorkflow);
  if (parsed.some((workflow) => workflow === undefined)) return false;
  const checkouts = parsed.flatMap(
    (workflow) =>
      workflow?.uses.filter(
        ({ ref }) =>
          typeof ref === "string" &&
          actionIdentifier(ref) === "actions/checkout"
      ) ?? []
  );
  return (
    checkouts.length > 0 &&
    checkouts.every(
      ({ inputs }) =>
        inputs instanceof Map &&
        inputs.get("persist-credentials") === false
    )
  );
}

export function hasExactCodeqlActionPins(
  source: string,
  expectedSha = PINNED_CODEQL_ACTION_SHA
): boolean {
  const parsed = parseWorkflow(source);
  if (!parsed || !/^[a-f0-9]{40}$/u.test(expectedSha)) return false;
  const refs = parsed.uses
    .map(({ ref }) => ref)
    .filter(
      (ref): ref is string =>
        typeof ref === "string" &&
        ref.toLowerCase().startsWith("github/codeql-action/")
    )
    .sort((left, right) => left.localeCompare(right));
  const expected = ["analyze", "autobuild", "init"]
    .map(
      (action) =>
        `github/codeql-action/${action}@${expectedSha}`
    )
    .sort((left, right) => left.localeCompare(right));
  return (
    refs.length === expected.length &&
    refs.every((ref, index) => ref === expected[index])
  );
}

function exactDependabotGroup(
  groups: unknown,
  expectedName: string
): boolean {
  if (!(groups instanceof Map) || groups.size !== 1) return false;
  const group = groups.get(expectedName);
  const patterns =
    group instanceof Map ? group.get("patterns") : undefined;
  return (
    group instanceof Map &&
    group.size === 1 &&
    Array.isArray(patterns) &&
    patterns.length === 1 &&
    patterns[0] === "*"
  );
}

export function hasExactDependabotReleaseFreeze(
  source: string
): boolean {
  const root = parseYamlMap(source);
  const updates = root?.get("updates");
  if (
    !root ||
    root.size !== 2 ||
    root.get("version") !== 2 ||
    !Array.isArray(updates) ||
    updates.length !== EXPECTED_DEPENDABOT_RELEASE_FREEZE.length
  ) {
    return false;
  }

  const pairs: string[] = [];
  for (const update of updates) {
    if (!(update instanceof Map) || update.has("ignore")) return false;
    const ecosystem = update.get("package-ecosystem");
    const directory = update.get("directory");
    const schedule = update.get("schedule");
    const cooldown = update.get("cooldown");
    if (
      typeof ecosystem !== "string" ||
      typeof directory !== "string" ||
      typeof update.get("open-pull-requests-limit") !== "number" ||
      update.get("open-pull-requests-limit") !== 0 ||
      !(schedule instanceof Map) ||
      schedule.size !== 2 ||
      schedule.get("interval") !== "weekly" ||
      schedule.get("day") !== "monday" ||
      !(cooldown instanceof Map) ||
      cooldown.size !== 1 ||
      cooldown.get("default-days") !== 7
    ) {
      return false;
    }

    const pair = `${ecosystem}\u0000${directory}`;
    pairs.push(pair);
    if (ecosystem === "npm" && directory === "/") {
      if (update.size !== 6) return false;
      if (!exactDependabotGroup(update.get("groups"), "backend-runtime")) {
        return false;
      }
    } else if (ecosystem === "npm" && directory === "/web") {
      if (update.size !== 6) return false;
      if (!exactDependabotGroup(update.get("groups"), "control-room")) {
        return false;
      }
    } else if (update.size !== 5 || update.has("groups")) {
      return false;
    }
  }

  const expectedPairs = EXPECTED_DEPENDABOT_RELEASE_FREEZE.map(
    ([ecosystem, directory]) => `${ecosystem}\u0000${directory}`
  ).sort((left, right) => left.localeCompare(right));
  return (
    new Set(pairs).size === pairs.length &&
    pairs
      .sort((left, right) => left.localeCompare(right))
      .every((pair, index) => pair === expectedPairs[index])
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
  if (expectedRefs === 0) {
    return sources.length === 0 && refs.length === 0;
  }
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
  if (!(trigger instanceof Map) || trigger.size !== 3) return false;
  return (
    hasExactMainPush(trigger) &&
    trigger.get("pull_request") === null &&
    trigger.get("workflow_dispatch") === null
  );
}

function hasExactCodeqlTrigger(source: string): boolean {
  const parsed = parseWorkflow(source);
  const trigger = parsed?.root.get("on");
  if (!(trigger instanceof Map) || trigger.size !== 4) return false;
  const schedule = trigger.get("schedule");
  if (!Array.isArray(schedule) || schedule.length !== 1) return false;
  const entry = schedule[0];
  return (
    hasExactMainPush(trigger) &&
    trigger.get("pull_request") === null &&
    trigger.get("workflow_dispatch") === null &&
    entry instanceof Map &&
    entry.size === 1 &&
    entry.get("cron") === "27 3 * * 1"
  );
}

export function hasExactBenchmarkTrigger(source: string): boolean {
  const parsed = parseWorkflow(source);
  const trigger = parsed?.root.get("on");
  if (!(trigger instanceof Map) || trigger.size !== 2) return false;

  const workflowDispatch = trigger.get("workflow_dispatch");
  const schedule = trigger.get("schedule");
  if (
    !(workflowDispatch instanceof Map) ||
    workflowDispatch.size !== 1 ||
    !Array.isArray(schedule) ||
    schedule.length !== 1
  ) {
    return false;
  }
  const inputs = workflowDispatch.get("inputs");
  const scheduleEntry = schedule[0];
  return (
    inputs instanceof Map &&
    inputs.size === 2 &&
    exactWorkflowInput(inputs, "corpus_n", {
      description: "Corpus size for the representative run",
      default: "10000",
    }) &&
    exactWorkflowInput(inputs, "queries", {
      description: "Number of probe queries",
      default: "200",
    }) &&
    scheduleEntry instanceof Map &&
    scheduleEntry.size === 1 &&
    scheduleEntry.get("cron") === "17 3 * * 0"
  );
}

export function hasExactHostedDastTrigger(source: string): boolean {
  const parsed = parseWorkflow(source);
  const trigger = parsed?.root.get("on");
  if (!(trigger instanceof Map) || trigger.size !== 3) return false;

  const workflowCall = trigger.get("workflow_call");
  const schedule = trigger.get("schedule");
  if (
    !(workflowCall instanceof Map) ||
    workflowCall.size !== 1 ||
    trigger.get("workflow_dispatch") !== null ||
    !Array.isArray(schedule) ||
    schedule.length !== 1
  ) {
    return false;
  }

  const inputs = workflowCall.get("inputs");
  const scheduleEntry = schedule[0];
  return (
    inputs instanceof Map &&
    inputs.size === 3 &&
    exactWorkflowInput(inputs, "exact_sha", {
      description: "Exact deployed main commit to scan",
      required: true,
      type: "string",
    }) &&
    exactWorkflowInput(inputs, "deploy_run_id", {
      description: "Deploy AWS run that promoted the release",
      required: true,
      type: "number",
    }) &&
    exactWorkflowInput(inputs, "deploy_run_attempt", {
      description: "Exact Deploy AWS run attempt",
      required: true,
      type: "number",
    }) &&
    scheduleEntry instanceof Map &&
    scheduleEntry.size === 1 &&
    scheduleEntry.get("cron") === "43 4 * * 1"
  );
}

export function hasExactAwsDeployTrigger(source: string): boolean {
  const parsed = parseWorkflow(source);
  const trigger = parsed?.root.get("on");
  if (!(trigger instanceof Map) || trigger.size !== 2) return false;
  const push = trigger.get("push");
  const workflowDispatch = trigger.get("workflow_dispatch");
  if (
    !(push instanceof Map) ||
    push.size !== 1 ||
    !(workflowDispatch instanceof Map) ||
    workflowDispatch.size !== 1
  ) {
    return false;
  }
  const branches = push.get("branches");
  const inputs = workflowDispatch.get("inputs");
  return (
    Array.isArray(branches) &&
    branches.length === 1 &&
    branches[0] === "main" &&
    inputs instanceof Map &&
    inputs.size === 4 &&
    exactWorkflowInput(inputs, "operation", {
      description:
        "The only manual mode is the protected staging recovery drill.",
      required: true,
      type: "choice",
      options: ["staging-recovery-drill"],
    }) &&
    exactWorkflowInput(inputs, "target_sha", {
      description: "Exact current main SHA already green in required pipelines.",
      required: true,
      type: "string",
    }) &&
    exactWorkflowInput(inputs, "approval_reference", {
      description:
        "Non-secret approved drill/change reference; retained only as SHA-256.",
      required: true,
      type: "string",
    }) &&
    exactWorkflowInput(inputs, "confirmation", {
      description:
        "Enter FAULT-INJECT-STAGING-RECOVERY-AND-REQUIRE-WATCHDOG.",
      required: true,
      type: "string",
    })
  );
}

export function hasExactAwsRecoveryTrigger(source: string): boolean {
  const parsed = parseWorkflow(source);
  const trigger = parsed?.root.get("on");
  if (!(trigger instanceof Map) || trigger.size !== 2) return false;

  const schedule = trigger.get("schedule");
  const workflowDispatch = trigger.get("workflow_dispatch");
  if (
    !Array.isArray(schedule) ||
    schedule.length !== 2 ||
    !(workflowDispatch instanceof Map) ||
    workflowDispatch.size !== 1
  ) {
    return false;
  }
  const inputs = workflowDispatch.get("inputs");
  if (!(inputs instanceof Map) || inputs.size !== 1) return false;
  const operation = inputs.get("operation");
  if (!(operation instanceof Map) || operation.size !== 5) return false;
  const operationOptions = operation.get("options");
  const scheduleCrons = schedule
    .map((entry) =>
      entry instanceof Map && entry.size === 1
        ? entry.get("cron")
        : null
    )
    .filter((cron): cron is string => typeof cron === "string")
    .sort();
  return (
    scheduleCrons.length === 2 &&
    scheduleCrons[0] === "17 4 * * *" &&
    scheduleCrons[1] === "7,22,37,52 * * * *" &&
    operation.get("description") === "Recovery watchdog operation" &&
    operation.get("required") === true &&
    operation.get("default") === "recover" &&
    operation.get("type") === "choice" &&
    Array.isArray(operationOptions) &&
    operationOptions.length === 2 &&
    operationOptions[0] === "recover" &&
    operationOptions[1] === "audit"
  );
}

function exactWorkflowInput(
  inputs: Map<unknown, unknown>,
  name: string,
  expected: Record<string, unknown>
): boolean {
  const input = inputs.get(name);
  if (!(input instanceof Map)) return false;
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = [...input.keys()];
  if (
    actualKeys.some((key) => typeof key !== "string") ||
    actualKeys.length !== expectedKeys.length ||
    (actualKeys as string[])
      .sort((left, right) => left.localeCompare(right))
      .some((key, index) => key !== expectedKeys[index])
  ) {
    return false;
  }
  return Object.entries(expected).every(([key, value]) => {
    const actual = input.get(key);
    return Array.isArray(value)
      ? Array.isArray(actual) &&
          actual.length === value.length &&
          actual.every((item, index) => item === value[index])
      : actual === value;
  });
}

export function hasExactSubmissionReadinessTrigger(
  source: string
): boolean {
  const parsed = parseWorkflow(source);
  const trigger = parsed?.root.get("on");
  if (!(trigger instanceof Map) || trigger.size !== 1) return false;
  const dispatch = trigger.get("workflow_dispatch");
  if (!(dispatch instanceof Map) || dispatch.size !== 1) return false;
  const inputs = dispatch.get("inputs");
  if (!(inputs instanceof Map) || inputs.size !== 12) return false;

  return (
    exactWorkflowInput(inputs, "phase", {
      description:
        "Validate everything before Devpost, or the final public project afterward.",
      required: true,
      type: "choice",
      options: ["pre-submit", "post-submit"],
    }) &&
    exactWorkflowInput(inputs, "video_url", {
      description: "Canonical public, embeddable YouTube or Vimeo URL.",
      required: true,
      type: "string",
    }) &&
    exactWorkflowInput(inputs, "video_duration_seconds", {
      description: "Verified integer duration from 1 through 179 seconds.",
      required: true,
      type: "string",
    }) &&
    exactWorkflowInput(inputs, "video_ci_run_id", {
      description:
        "Successful exact-SHA demo-video workflow run ID used for the public upload.",
      required: true,
      type: "string",
    }) &&
    exactWorkflowInput(inputs, "video_ci_run_attempt", {
      description:
        "Exact successful attempt number of the demo-video workflow run.",
      required: true,
      type: "string",
    }) &&
    exactWorkflowInput(inputs, "video_source_sha256", {
      description:
        "SHA-256 of the CI-produced MP4 that was uploaded publicly.",
      required: true,
      type: "string",
    }) &&
    exactWorkflowInput(
      inputs,
      "video_uploaded_from_ci_artifact_attested",
      {
        description:
          "Confirm the public video was uploaded from the bound CI artifact without content changes.",
        required: true,
        default: false,
        type: "boolean",
      }
    ) &&
    exactWorkflowInput(inputs, "video_public_embeddable_attested", {
      description:
        "Confirm the video was opened signed-out and embedding is allowed.",
      required: true,
      default: false,
      type: "boolean",
    }) &&
    exactWorkflowInput(inputs, "video_english_captions_attested", {
      description:
        "Confirm accurate English captions are enabled on the final video.",
      required: true,
      default: false,
      type: "boolean",
    }) &&
    exactWorkflowInput(inputs, "devpost_url", {
      description:
        "Empty before submission; canonical public Devpost project URL afterward.",
      required: false,
      default: "",
      type: "string",
    }) &&
    exactWorkflowInput(inputs, "devpost_submitted_attested", {
      description:
        "Confirm the final entry is submitted to this CockroachDB challenge with the exact repo, demo, and video.",
      required: true,
      default: false,
      type: "boolean",
    }) &&
    exactWorkflowInput(inputs, "pre_submit_run_id", {
      description:
        "Empty for pre-submit; successful pre-submit workflow run ID for post-submit.",
      required: false,
      default: "",
      type: "string",
    })
  );
}

export function hasExactDemoVideoTrigger(source: string): boolean {
  const parsed = parseWorkflow(source);
  const trigger = parsed?.root.get("on");
  if (!(trigger instanceof Map) || trigger.size !== 1) return false;
  const dispatch = trigger.get("workflow_dispatch");
  if (!(dispatch instanceof Map) || dispatch.size !== 1) return false;
  const inputs = dispatch.get("inputs");
  if (!(inputs instanceof Map) || inputs.size !== 2) return false;

  return (
    exactWorkflowInput(inputs, "exact_sha", {
      description:
        "Exact current main SHA whose hosted release evidence and live application will be recorded.",
      required: true,
      type: "string",
    }) &&
    exactWorkflowInput(inputs, "voice_rights_attested", {
      description:
        "Confirm the selected ElevenLabs premade voice is authorized for public competition use.",
      required: true,
      default: false,
      type: "boolean",
    })
  );
}

function exactScalarMap(
  value: unknown,
  expected: Record<string, string | number | boolean>
): boolean {
  if (!(value instanceof Map)) return false;
  const keys = [...value.keys()];
  const expectedKeys = Object.keys(expected).sort();
  return (
    keys.every((key) => typeof key === "string") &&
    keys.length === expectedKeys.length &&
    (keys as string[])
      .sort((left, right) => left.localeCompare(right))
      .every((key, index) => key === expectedKeys[index]) &&
    Object.entries(expected).every(
      ([key, expectedValue]) => value.get(key) === expectedValue
    )
  );
}

function exactMapKeys(value: unknown, expected: string[]): value is Map<unknown, unknown> {
  if (!(value instanceof Map)) return false;
  const keys = [...value.keys()];
  const sorted = [...expected].sort((left, right) =>
    left.localeCompare(right)
  );
  return (
    keys.every((key) => typeof key === "string") &&
    keys.length === sorted.length &&
    (keys as string[])
      .sort((left, right) => left.localeCompare(right))
      .every((key, index) => key === sorted[index])
  );
}

export function hasExactSubmissionWorkflowContract(source: string): boolean {
  const parsed = parseWorkflow(source);
  if (
    !parsed ||
    !hasExactSubmissionReadinessTrigger(source) ||
    !exactMapKeys(parsed.root, [
      "concurrency",
      "jobs",
      "name",
      "on",
      "permissions",
      "run-name",
    ]) ||
    parsed.root.get("name") !== "Submission readiness" ||
    parsed.root.get("run-name") !==
      "Submission readiness / ${{ inputs.phase }} / ${{ github.sha }} / ${{ inputs.video_url }} / ${{ inputs.video_duration_seconds }}s / CI ${{ inputs.video_ci_run_id }}.${{ inputs.video_ci_run_attempt }} / ${{ inputs.video_source_sha256 }}" ||
    !exactScalarMap(parsed.root.get("permissions"), {
      actions: "read",
      contents: "read",
    }) ||
    !exactScalarMap(parsed.root.get("concurrency"), {
      group: "submission-readiness",
      "cancel-in-progress": false,
    })
  ) {
    return false;
  }

  const jobs = parsed.root.get("jobs");
  if (!exactMapKeys(jobs, ["gate"])) return false;
  const gate = jobs.get("gate");
  if (
    !exactMapKeys(gate, [
      "env",
      "name",
      "runs-on",
      "steps",
      "timeout-minutes",
    ]) ||
    gate.get("name") !== "Verify exact release and deliverables" ||
    gate.get("runs-on") !== "ubuntu-latest" ||
    gate.get("timeout-minutes") !== 25
  ) {
    return false;
  }
  if (
    !exactScalarMap(gate.get("env"), {
      SUBMISSION_PHASE: "${{ inputs.phase }}",
      SUBMISSION_DEMO_URL:
        "https://d2s5v0o0eg2aaw.cloudfront.net",
      SUBMISSION_PUBLIC_REPO_URL:
        "https://github.com/upgradedev/archon-cockroach-memory",
      SUBMISSION_VIDEO_URL: "${{ inputs.video_url }}",
      SUBMISSION_VIDEO_DURATION_SECONDS:
        "${{ inputs.video_duration_seconds }}",
      SUBMISSION_VIDEO_CI_RUN_ID: "${{ inputs.video_ci_run_id }}",
      SUBMISSION_VIDEO_CI_RUN_ATTEMPT:
        "${{ inputs.video_ci_run_attempt }}",
      SUBMISSION_VIDEO_SOURCE_SHA256:
        "${{ inputs.video_source_sha256 }}",
      SUBMISSION_VIDEO_UPLOADED_FROM_CI_ARTIFACT_ATTESTED:
        "${{ inputs.video_uploaded_from_ci_artifact_attested }}",
      SUBMISSION_VIDEO_PUBLIC_EMBEDDABLE_ATTESTED:
        "${{ inputs.video_public_embeddable_attested }}",
      SUBMISSION_VIDEO_CAPTIONS_ATTESTED:
        "${{ inputs.video_english_captions_attested }}",
      DEVPOST_SUBMISSION_URL: "${{ inputs.devpost_url }}",
      DEVPOST_SUBMITTED:
        "${{ inputs.devpost_submitted_attested && '1' || '' }}",
      PRE_SUBMIT_RUN_ID: "${{ inputs.pre_submit_run_id }}",
    })
  ) {
    return false;
  }

  const steps = gate.get("steps");
  if (!Array.isArray(steps) || steps.length !== 7) return false;
  const [
    initialize,
    checkout,
    setup,
    install,
    runGate,
    upload,
    summary,
  ] = steps;
  const expectedInitializer = [
    "set -euo pipefail",
    "umask 077",
    'readonly receipt_path="${SUBMISSION_RECEIPT_PATH:?}"',
    `printf '%s\\n' '{"schema":"archon.submission-readiness","version":1,"generatedAt":"not-finalized","phase":"invalid","repository":"unknown","commitSha":"","passed":false,"checks":[{"id":"gate-not-finalized","status":"fail","detail":"The hosted gate did not reach atomic receipt finalization."}],"selectedRuns":{},"live":{}}' >"\${receipt_path}"`,
  ].join("\n");
  const initializerRun =
    typeof initialize.get("run") === "string"
      ? String(initialize.get("run"))
          .replace(/\r\n/gu, "\n")
          .trim()
      : "";
  if (
    !exactMapKeys(initialize, ["env", "name", "run", "shell"]) ||
    initialize.get("name") !== "Initialize a fail-closed sanitized receipt" ||
    initialize.get("shell") !== "bash" ||
    !exactScalarMap(initialize.get("env"), {
      SUBMISSION_RECEIPT_PATH:
        "${{ runner.temp }}/submission-readiness-receipt.json",
    }) ||
    initializerRun !== expectedInitializer ||
    !exactMapKeys(checkout, ["name", "uses", "with"]) ||
    checkout.get("name") !== "Check out the dispatched commit" ||
    checkout.get("uses") !==
      "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0" ||
    !exactScalarMap(checkout.get("with"), {
      ref: "${{ github.sha }}",
      "fetch-depth": 1,
      "persist-credentials": false,
    }) ||
    !exactMapKeys(setup, ["name", "uses", "with"]) ||
    setup.get("name") !== "Set up pinned Node.js" ||
    setup.get("uses") !==
      "actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e" ||
    !exactScalarMap(setup.get("with"), {
      "node-version": "22.23.1",
      cache: "npm",
    }) ||
    !exactMapKeys(install, ["name", "run"]) ||
    install.get("name") !== "Install the locked gate runtime" ||
    install.get("run") !== "npm ci --ignore-scripts" ||
    !exactMapKeys(runGate, ["env", "name", "run"]) ||
    runGate.get("name") !== "Run the read-only final gate" ||
    runGate.get("run") !==
      "node --import tsx scripts/final-submission-gate.ts" ||
    !exactScalarMap(runGate.get("env"), {
      GITHUB_TOKEN: "${{ github.token }}",
      SUBMISSION_RECEIPT_PATH:
        "${{ runner.temp }}/submission-readiness-receipt.json",
    }) ||
    !exactMapKeys(upload, ["id", "if", "name", "uses", "with"]) ||
    upload.get("name") !== "Upload the sanitized receipt" ||
    upload.get("id") !== "receipt_artifact" ||
    upload.get("if") !== "always()" ||
    upload.get("uses") !==
      "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a" ||
    !exactScalarMap(upload.get("with"), {
      name: "submission-readiness-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}",
      path: "${{ runner.temp }}/submission-readiness-receipt.json",
      "if-no-files-found": "error",
      "retention-days": 90,
    }) ||
    !exactMapKeys(summary, ["env", "if", "name", "run", "shell"]) ||
    summary.get("name") !== "Publish receipt artifact coordinates" ||
    summary.get("if") !==
      "always() && steps.receipt_artifact.outcome == 'success'" ||
    summary.get("shell") !== "bash" ||
    !exactScalarMap(summary.get("env"), {
      ARTIFACT_ID: "${{ steps.receipt_artifact.outputs.artifact-id }}",
      ARTIFACT_URL: "${{ steps.receipt_artifact.outputs.artifact-url }}",
      ARTIFACT_DIGEST:
        "${{ steps.receipt_artifact.outputs.artifact-digest }}",
    }) ||
    typeof summary.get("run") !== "string" ||
    !String(summary.get("run")).includes("ARTIFACT_DIGEST") ||
    !String(summary.get("run")).includes("GITHUB_STEP_SUMMARY")
  ) {
    return false;
  }
  return true;
}

function includesEvery(source: string, fragments: readonly string[]): boolean {
  return fragments.every((fragment) => source.includes(fragment));
}

export function hasExactZapIgnorePolicy(
  source: string,
  expectedRuleIds: readonly string[]
): boolean {
  const lines = source
    .replace(/\r\n/gu, "\n")
    .trimEnd()
    .split("\n");
  if (lines.length !== expectedRuleIds.length) return false;
  const observed: string[] = [];
  for (const line of lines) {
    const match = /^([0-9]{5})\tIGNORE\t\(([^()\r\n]{12,})\)$/u.exec(
      line
    );
    if (!match) return false;
    observed.push(match[1]!);
  }
  return (
    new Set(observed).size === observed.length &&
    observed.every((ruleId, index) => ruleId === expectedRuleIds[index])
  );
}

export function hasExactHostedSmokeContracts(source: string): boolean {
  const blocks = [
    source.match(
      /- name: Smoke the same-origin application and real recall path[\s\S]*?(?=\r?\n      - name: Hosted Chromium judge journey on staging)/u
    )?.[0] ?? "",
    source.match(
      /- name: Smoke production through CloudFront[\s\S]*?(?=\r?\n      - name: Hosted Chromium judge journey on production)/u
    )?.[0] ?? "",
  ];
  const scope = [
    'keys == ["access","company","dataClassification","mode","source","tenantId"]',
    '.tenantId == "public-demo"',
    '.company == "Helios SA"',
    '.mode == "fixed-synthetic-demo"',
    '.access == "read-only"',
    '.dataClassification == "synthetic-public-demo"',
    '.source == "server-configured"',
  ] as const;
  const health = [
    '$APPLICATION_URL/api/health',
    ".ok == true",
    '.status == "reachable"',
    '.service == "archon-cockroach-memory"',
    ".access ==",
    '"canonical-read-only+isolated-synthetic-resolution-write"',
    ".resolutionSandbox ==",
    '"state":"available"',
    '"authority":"financial-controller-human-gate"',
    '"persistence":"CockroachDB-row-level-TTL"',
    '"externalSideEffects":"none"',
    '.dependencies == "unchecked"',
    ".scope |",
    ...scope,
  ] as const;
  const proof = [
    '$APPLICATION_URL/api/proof',
    'RELEASE_COMMIT_SHA="${{ github.sha }}"',
    '[[ "$RELEASE_COMMIT_SHA" =~ ^[0-9a-f]{40}$ ]]',
    '--arg releaseCommitSha "$RELEASE_COMMIT_SHA"',
    '$embed == "amazon.titan-embed-text-v2:0"',
    '$narrator == "eu.anthropic.claude-sonnet-4-6"',
    '.database.engine == "CockroachDB"',
    '.database.deployment == "CockroachDB Cloud on AWS"',
    '.database.role == "persistent agent memory"',
    '.database.transactionIsolation == "SERIALIZABLE"',
    '.database.database == "archon"',
    'test("CockroachDB"; "i")',
    '.database.region == "eu-west-1"',
    '.database.regionEvidence == "cockroach-cloud-api-release-gate"',
    ".database.activeMemories == 9",
    ".memory.persisted == 9",
    ".memory.idempotencyKeys == 9",
    ".memory.contentDigests == 9",
    ".memory.storeVerified == true",
    '.memory.evidence == "live bounded fixed-scope payload-digest verification"',
    '.vectorIndex.engine == "native CockroachDB C-SPANN"',
    ".vectorIndex.enabled == true",
    '.vectorIndex.name == "idx_agent_memory_company_scope_embedding"',
    '.vectorIndex.metric == "cosine"',
    ".vectorIndex.dimensions == 1024",
    '.vectorIndex.prefixes == ["tenant_id","embed_model","status","company"]',
    '.vectorIndex.lifecycleState == "active"',
    '.vectorIndex.evidence == "live pg_catalog.pg_indexes definition"',
    'test("^[a-f0-9]{64}$")',
    ".resolutionLoop.enabled == true",
    ".resolutionLoop.schemaTables == 5",
    ".resolutionLoop.activeSandboxSessions |",
    'type == "number" and floor == . and . >= 0',
    '.resolutionLoop.transactionIsolation == "SERIALIZABLE"',
    ".resolutionLoop.authorityBoundary ==",
    '"financial-controller-human-gate"',
    ".resolutionLoop.identityAssurance ==",
    '"fixed-demo-role-assertion-not-authenticated"',
    ".resolutionLoop.idempotency ==",
    '"decision-key+database-unique-constraint"',
    ".resolutionLoop.receipt ==",
    '"SHA-256 immutable decision record"',
    ".resolutionLoop.learning ==",
    '"conflict-observation+human-decision"',
    ".resolutionLoop.consolidation ==",
    '"versioned current/superseded state"',
    '.resolutionLoop.forgetting == "CockroachDB row-level TTL"',
    ".resolutionLoop.canonicalMemoryMutable == false",
    '.resolutionLoop.externalSideEffects == "none"',
    ".resolutionLoop.evidence ==",
    '"live fixed-scope sandbox schema query"',
    '.embeddingModel == "amazon.titan-embed-text-v2:0"',
    '.narrationModel == "eu.anthropic.claude-sonnet-4-6"',
    ".release.commitSha == $releaseCommitSha",
    '.release.evidence == "server-configured Lambda environment"',
    ".scope |",
    ...scope,
    '.generatedAt | type == "string" and test("Z$")',
  ] as const;
  const recall = [
    '$APPLICATION_URL/api/recall',
    '--arg question "What was the true employer cost and the off-bank wedge?"',
    '--arg embed "$BEDROCK_EMBED_MODEL_ID"',
    '--arg narrator "$BEDROCK_NARRATOR_MODEL_ID"',
    ".question == $question",
    '(.answer | contains("€15,375"))',
    '(.answer | contains("€6,775"))',
    ".modelId == $narrator",
    "(.citations | length) >= 2",
    "(.citations | length) <= 5",
    ".recalled == (.citations | length)",
    '(.grounding.status == "verified" or .grounding.status == "extractive")',
    ".grounding.checks.citations == true",
    ".grounding.checks.numerics == true",
    ".grounding.checks.claims == true",
    '.trace.retrieval.database == "CockroachDB"',
    '.trace.retrieval.index == "native C-SPANN vector index"',
    '.trace.retrieval.metric == "cosine"',
    ".trace.retrieval.embeddingModel == $embed",
    '.trace.retrieval.requestedKind == "payroll_event"',
    ".trace.retrieval.requestedTopK == 5",
    ".trace.retrieval.recalled == .recalled",
    ".trace.narration.model == $narrator",
    ".trace.scope |",
    ...scope,
    'any(.citations[]; .content | contains("€15,375"))',
    'any(.citations[]; .content | contains("€6,775"))',
    '.marker | test("^\\\\[[1-5]\\\\]$")',
    '.memoryId | test("^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")',
    '.sourceRef | type == "string" and length > 0',
    '.company == "Helios SA"',
    '.kind == "payroll_event"',
    '.period == "2026-04"',
    '.score | type == "number" and . >= 0.15 and . <= 1',
    ".answer as $answer |",
    "all(.citations[].marker;",
    ". as $marker | $answer | contains($marker)",
    "([.citations[].marker] ==",
    '[range(1; ((.citations | length) + 1)) | "[\\(.)]"])',
    "([.citations[].memoryId] | unique | length) == (.citations | length)",
    ".consistencyOk == true",
  ] as const;
  const audit = [
    '$APPLICATION_URL/api/audit',
    ".report.audited == 9",
    ".report.ok == false",
    ".coverage.total == 9",
    ".coverage.scanned == 9",
    ".coverage.complete == true",
    ".scope |",
    ...scope,
    "(.report.contradictions | length) == 1",
    '.report.contradictions[0].subject == "INV-2043"',
    '.report.contradictions[0].type == "contradiction"',
    '.report.contradictions[0].attribute == "total"',
    "([.report.contradictions[0].values[].value] | sort) == [18400,18900]",
    ".report.contradictions[0].resolution.recommendedValue == 18400",
    '.report.contradictions[0].resolution.rule == "importance"',
    ".report.contradictions[0].resolution.recommendedMemoryId |",
    'test("^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")',
    ".report.contradictions[0].resolution.confidence |",
    'type == "number" and . >= 0 and . <= 1',
    ".report.contradictions[0].resolution.rationale |",
    'type == "string" and length >= 20',
    "(.report.absences | length) == 1",
    '.report.absences[0].type == "absence"',
    '.report.absences[0].subject == "PAY-118"',
    "(.report.absences[0].referencedBy | length) == 1",
    '.report.absences[0].referencedBy[0].sourceRef == "RECON-2043"',
    '.generatedAt | type == "string" and test("Z$")',
  ] as const;

  return blocks.every((block, index) => {
    if (!block) return false;
    const healthStart = block.indexOf('HEALTH="$(');
    const proofBindingStart = block.indexOf(
      'RELEASE_COMMIT_SHA="${{ github.sha }}"'
    );
    const proofRequestStart = block.indexOf('PROOF="$(');
    const recallStart = block.indexOf('RECALL="$(');
    const auditStart = block.indexOf('AUDIT="$(');
    if (
      healthStart < 0 ||
      proofBindingStart <= healthStart ||
      proofRequestStart <= proofBindingStart ||
      recallStart <= proofRequestStart ||
      auditStart <= recallStart
    ) {
      return false;
    }
    const sections = {
      health: block.slice(healthStart, proofBindingStart),
      proof: block.slice(proofBindingStart, recallStart),
      recall: block.slice(recallStart, auditStart),
      audit: block.slice(auditStart),
    };
    const environment = index === 0 ? "staging" : "production";
    return (
      includesEvery(sections.health, health) &&
      includesEvery(sections.proof, [
        ...proof,
        `test("^archon_${environment}_[0-9a-f]{10}$")`,
      ]) &&
      includesEvery(sections.recall, recall) &&
      includesEvery(sections.audit, audit)
    );
  });
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
    ["alarm-routing-controls.yml", ["workflow_dispatch"]],
    ["aws-security-baseline.yml", ["workflow_dispatch"]],
    ["benchmark.yml", ["schedule", "workflow_dispatch"]],
    ["bootstrap-aws.yml", ["workflow_dispatch"]],
    ["ci.yml", ["pull_request", "push", "workflow_dispatch"]],
    ["cockroach-restore-drill.yml", ["workflow_dispatch"]],
    [
      "codeql.yml",
      ["pull_request", "push", "schedule", "workflow_dispatch"],
    ],
    ["database-credential-rotation.yml", ["workflow_dispatch"]],
    [
      "database-release.yml",
      ["workflow_call", "workflow_dispatch"],
    ],
    ["demo-video.yml", ["workflow_dispatch"]],
    ["deploy-aws.yml", ["push", "workflow_dispatch"]],
    ["edge-controls.yml", ["workflow_dispatch"]],
    ["finops-controls.yml", ["workflow_dispatch"]],
    ["foundation-migration.yml", ["workflow_dispatch"]],
    ["hosted-load-evidence.yml", ["workflow_dispatch"]],
    [
      "human-impact-evaluation.yml",
      ["pull_request", "push", "workflow_dispatch"],
    ],
    ["managed-mcp-audit.yml", ["workflow_dispatch"]],
    [
      "memory-evaluation.yml",
      ["pull_request", "push", "schedule", "workflow_dispatch"],
    ],
    [
      "recover-aws.yml",
      ["schedule", "workflow_dispatch"],
    ],
    [
      "security-dast.yml",
      ["schedule", "workflow_call", "workflow_dispatch"],
    ],
    ["submission-readiness.yml", ["workflow_dispatch"]],
    [
      "supply-chain.yml",
      ["pull_request", "push", "schedule", "workflow_dispatch"],
    ],
    ["sustainability-intensity-evidence.yml", ["workflow_dispatch"]],
    [
      "well-architected-audit.yml",
      ["pull_request", "push", "schedule", "workflow_dispatch"],
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
  const benchmark = workflows.find(
    ({ name }) => name === "benchmark.yml"
  );
  const codeql = workflows.find(({ name }) => name === "codeql.yml");
  const demoVideo = workflows.find(
    ({ name }) => name === "demo-video.yml"
  );
  const recovery = workflows.find(
    ({ name }) => name === "recover-aws.yml"
  );
  const deploy = workflows.find(
    ({ name }) => name === "deploy-aws.yml"
  );
  const hostedDast = workflows.find(
    ({ name }) => name === "security-dast.yml"
  );
  const submission = workflows.find(
    ({ name }) => name === "submission-readiness.yml"
  );
  return (
    ci !== undefined &&
    benchmark !== undefined &&
    codeql !== undefined &&
    demoVideo !== undefined &&
    deploy !== undefined &&
    recovery !== undefined &&
    hostedDast !== undefined &&
    submission !== undefined &&
    hasExactBenchmarkTrigger(benchmark.source) &&
    hasExactCiTrigger(ci.source) &&
    hasExactCodeqlTrigger(codeql.source) &&
    hasExactDemoVideoTrigger(demoVideo.source) &&
    hasExactAwsDeployTrigger(deploy.source) &&
    hasExactAwsRecoveryTrigger(recovery.source) &&
    hasExactHostedDastTrigger(hostedDast.source) &&
    hasExactSubmissionReadinessTrigger(submission.source)
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

function hasExactTrimmedLine(source: string, expected: string): boolean {
  return source
    .split(/\r?\n/u)
    .some((line) => line.trim() === expected);
}

function containsExactHostnameToken(source: string, hostname: string): boolean {
  const normalizedHostname = hostname.toLowerCase();
  return source
    .split(/[^A-Za-z0-9.-]+/u)
    .some((token) => token.toLowerCase() === normalizedHostname);
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
  const codeqlWorkflow = read(".github/workflows/codeql.yml");
  const dependabotConfig = read(".github/dependabot.yml");
  const deploy = read(".github/workflows/deploy-aws.yml");
  const supplyChainWorkflow = read(
    ".github/workflows/supply-chain.yml"
  );
  const trivyIacCompatibilityValidator = read(
    ".github/scripts/validate-trivy-iac-compatibility.mjs"
  );
  const trivySbomPolicyValidator = read(
    ".github/scripts/validate-trivy-sbom-policy.mjs"
  );
  const supplyChainWaivers = read("security/waivers.yml");
  const memoryEvaluationWorkflow = read(
    ".github/workflows/memory-evaluation.yml"
  );
  const memoryEvaluationScript = read(
    "scripts/evaluate-memory-architecture.ts"
  );
  const wellArchitectedWorkflow = read(
    ".github/workflows/well-architected-audit.yml"
  );
  const wellArchitectedContractAudit = read(
    ".github/scripts/well-architected-contract-audit.mjs"
  );
  const supplyChainToolLock = read(".github/toolchain-lock.json");
  const wellArchitectedContract = read(
    "docs/operations/well-architected-contract.json"
  );
  const awsSecurityBaselineWorkflow = read(
    ".github/workflows/aws-security-baseline.yml"
  );
  const awsSecurityBaselineScript = read(
    "aws/audit-account-security-baseline.sh"
  );
  const awsSecurityBaselinePolicy = read(
    "aws/account-security-baseline-audit-policy.json"
  );
  const awsSecurityBaselineRunbook = read(
    "docs/runbooks/aws-account-security-baseline.md"
  );
  const sustainabilityIntensityWorkflow = read(
    ".github/workflows/sustainability-intensity-evidence.yml"
  );
  const sustainabilityIntensityScript = read(
    "aws/measure-sustainability-intensity.sh"
  );
  const sustainabilityIntensityPolicy = read(
    "aws/sustainability-intensity-audit-policy.json"
  );
  const sustainabilityIntensityRunbook = read(
    "docs/runbooks/sustainability-intensity.md"
  );
  const databaseCredentialRotationWorkflow = read(
    ".github/workflows/database-credential-rotation.yml"
  );
  const databaseCredentialRotationScript = read(
    "scripts/rotate-runtime-secret.ts"
  );
  const databaseCredentialProvisioningScript = read(
    "scripts/provision-runtime-secret.ts"
  );
  const databaseCredentialRotationTests = read(
    "tests/database-credential-rotation.test.ts"
  );
  const databaseClient = read("src/db/client.ts");
  const databaseClientRotationTests = read(
    "tests/db-client-rotation.test.ts"
  );
  const recoveryWorkflow = read(".github/workflows/recover-aws.yml");
  const securityDastWorkflow = read(
    ".github/workflows/security-dast.yml"
  );
  const submissionWorkflow = read(
    ".github/workflows/submission-readiness.yml"
  );
  const demoVideoWorkflow = read(
    ".github/workflows/demo-video.yml"
  );
  const foundationWorkflow = read(
    ".github/workflows/bootstrap-aws.yml"
  );
  const foundationMigrationWorkflow = read(
    ".github/workflows/foundation-migration.yml"
  );
  const edgeControlsWorkflow = read(
    ".github/workflows/edge-controls.yml"
  );
  const edgeInspectStackStep = extractNamedWorkflowStep(
    edgeControlsWorkflow,
    "Inspect current edge stack state"
  );
  const edgeCleanupStep = extractNamedWorkflowStep(
    edgeControlsWorkflow,
    "Clean up exact recoverable edge shell"
  );
  const edgeCleanupReceiptMarker =
    'receipt_next="${RUNNER_TEMP:?}/edge-cleanup-receipt.json"';
  const edgeCleanupReceiptOffset = edgeCleanupStep.indexOf(
    edgeCleanupReceiptMarker
  );
  const edgeCleanupReceiptSource =
    edgeCleanupReceiptOffset >= 0
      ? edgeCleanupStep.slice(edgeCleanupReceiptOffset)
      : "";
  const edgeCreatePlanStep = extractNamedWorkflowStep(
    edgeControlsWorkflow,
    "Create or reuse exact edge plan"
  );
  const edgeLoadPlanStep = extractNamedWorkflowStep(
    edgeControlsWorkflow,
    "Load exact existing edge plan"
  );
  const edgeRequirePlanStep = extractNamedWorkflowStep(
    edgeControlsWorkflow,
    "Require exact non-replacement WAF evidence plan"
  );
  const edgeExecutePlanStep = extractNamedWorkflowStep(
    edgeControlsWorkflow,
    "Execute exact inspected edge plan"
  );
  const edgePreProtectionProofStep = extractNamedWorkflowStep(
    edgeControlsWorkflow,
    "Prove exact deployed stack before lifecycle protection"
  );
  const edgeSetProtectionStep = extractNamedWorkflowStep(
    edgeControlsWorkflow,
    "Set exact edge stack lifecycle protections"
  );
  const edgeLiveProofStep = extractNamedWorkflowStep(
    edgeControlsWorkflow,
    "Prove exact deployed WAF controls"
  );
  const edgeHistoricalFinalizeStep = extractNamedWorkflowStep(
    edgeControlsWorkflow,
    "Prove historical finalize protection without current-control claims"
  );
  const edgeLifecycleOperationsValid =
    /environment: \$\{\{ inputs\.operation == 'cleanup' && 'edge-cleanup' \|\| 'edge-controls' \}\}/u.test(
      edgeControlsWorkflow
    ) &&
    /github-edge-cleanup/u.test(edgeControlsWorkflow) &&
    /options:\r?\n\s+- plan\r?\n\s+- apply\r?\n\s+- verify\r?\n\s+- cleanup\r?\n\s+- finalize/u.test(
      edgeControlsWorkflow
    ) &&
    /expected_confirmation="APPLY-\$\{environment_upper\}-EDGE-CONTROLS"/u.test(
      edgeControlsWorkflow
    ) &&
    /expected_confirmation="CLEANUP-\$\{environment_upper\}-EDGE-CONTROLS"/u.test(
      edgeControlsWorkflow
    ) &&
    /expected_confirmation="FINALIZE-\$\{environment_upper\}-EDGE-CONTROLS"/u.test(
      edgeControlsWorkflow
    ) &&
    /plan\|verify\)\r?\n\s+test -z "\$CONFIRMATION"/u.test(
      edgeControlsWorkflow
    ) &&
    /^[ \t]+REVIEW_IN_PROGRESS\)\r?$/mu.test(edgeInspectStackStep) &&
    /^[ \t]+apply\|cleanup\) ;;\r?$/mu.test(edgeInspectStackStep) &&
    /EDGE_CLEANUP_PRIOR_STATUS=REVIEW_IN_PROGRESS/u.test(
      edgeInspectStackStep
    ) &&
    /^[ \t]+ROLLBACK_COMPLETE\)\r?$/mu.test(edgeInspectStackStep) &&
    /test "\$OPERATION" = "cleanup"/u.test(edgeInspectStackStep) &&
    /EDGE_CLEANUP_PRIOR_STATUS=ROLLBACK_COMPLETE/u.test(
      edgeInspectStackStep
    ) &&
    /if \$priorStatus == "REVIEW_IN_PROGRESS"\s+then \(\.StackResourceSummaries \| length\) == 0\s+else \$priorStatus == "ROLLBACK_COMPLETE"\s+and all\(\s+\.StackResourceSummaries\[\];\s+\.ResourceStatus == "DELETE_COMPLETE"/u.test(
      edgeCleanupStep
    ) &&
    /"arn:aws:cloudformation:us-east-1:" \+ \$account/u.test(
      edgeCleanupStep
    ) &&
    /\(\(\.Stacks\[0\]\.RoleARN \/\/ null\) == null\)/u.test(
      edgeCleanupStep
    ) &&
    /\.Stacks\[0\]\.EnableTerminationProtection == false/u.test(
      edgeCleanupStep
    ) &&
    /capture\(\s+"\^operation=edge-controls environment="/u.test(
      edgeCleanupStep
    ) &&
    /git fetch --no-tags --depth=1 origin "\$cleanup_source_commit"/u.test(
      edgeCleanupStep
    ) &&
    /"\$\{cleanup_source_commit\}:aws\/edge-waf\.yaml"/u.test(
      edgeCleanupStep
    ) &&
    /sha256sum "\$cleanup_source_template"/u.test(edgeCleanupStep) &&
    /sha256sum "\$cleanup_template"/u.test(edgeCleanupStep) &&
    /final_stack[\s\S]*?final_resources[\s\S]*?final_change_sets[\s\S]*?final_change_set[\s\S]*?aws cloudformation delete-stack/u.test(
      edgeCleanupStep
    ) &&
    /aws cloudformation delete-stack \\\r?\n\s+--stack-name "\$stack_id"/u.test(
      edgeCleanupStep
    ) &&
    /grep -Fq "does not exist" "\$cleanup_error"/u.test(
      edgeCleanupStep
    ) &&
    /stackDeletedAndNotFound: true/u.test(edgeCleanupReceiptSource) &&
    /stackIdSha256: \$stackIdSha256/u.test(edgeCleanupReceiptSource) &&
    /clientRequestTokenSha256: \$cleanupTokenSha256/u.test(
      edgeCleanupReceiptSource
    ) &&
    !/--arg stackId "\$stack_id"|AWS_ACCOUNT_ID|arn:aws:/u.test(
      edgeCleanupReceiptSource
    ) &&
    !/(?:filter-log-events|get-log-events|start-query|set-alarm-state)/u.test(
      edgeCleanupStep
    ) &&
    /if \[ "\$OPERATION" = "finalize" \] \|\|/u.test(
      edgeInspectStackStep
    ) &&
    /EDGE_APPLY_MODE=finalize/u.test(edgeInspectStackStep) &&
    /deployed_sha:/u.test(edgeControlsWorkflow) &&
    /gh api --paginate --slurp[\s\S]*?head_sha=\$\{sha\}[\s\S]*?\.\[\]\.workflow_runs\[\][\s\S]*?prove_green_sha "\$DEPLOYED_SHA"/u.test(
      edgeControlsWorkflow
    ) &&
    /repos\/\$GITHUB_REPOSITORY\/compare\/\$\{DEPLOYED_SHA\}\.\.\.\$\{TARGET_SHA\}/u.test(
      edgeControlsWorkflow
    ) &&
    /\.base_commit\.sha == \$deployed[\s\S]*?\.merge_base_commit\.sha == \$deployed[\s\S]*?\.head_commit\.sha == \$target[\s\S]*?\.status == "ahead"[\s\S]*?\.ahead_by > 0[\s\S]*?\.behind_by == 0/u.test(
      edgeControlsWorkflow
    ) &&
    /if: inputs\.operation == 'plan'/u.test(edgeCreatePlanStep) &&
    /if: inputs\.operation == 'apply' && env\.EDGE_APPLY_MODE == 'execute'/u.test(
      edgeLoadPlanStep
    ) &&
    /if: inputs\.operation == 'plan' \|\| \(inputs\.operation == 'apply' && env\.EDGE_APPLY_MODE == 'execute'\)/u.test(
      edgeRequirePlanStep
    ) &&
    /if: inputs\.operation == 'apply' && env\.EDGE_APPLY_MODE == 'execute'/u.test(
      edgeExecutePlanStep
    ) &&
    /if: inputs\.operation == 'apply' \|\| inputs\.operation == 'finalize'/u.test(
      edgePreProtectionProofStep
    ) &&
    /\(\.StackResourceSummaries \| length\) == 9/u.test(
      edgePreProtectionProofStep
    ) &&
    /if: inputs\.operation == 'apply' \|\| inputs\.operation == 'finalize'/u.test(
      edgeSetProtectionStep
    ) &&
    /set-stack-policy/u.test(edgeSetProtectionStep) &&
    /update-termination-protection/u.test(edgeSetProtectionStep) &&
    /if: inputs\.operation == 'apply' \|\| inputs\.operation == 'verify' \|\| \(inputs\.operation == 'finalize' && env\.EDGE_CURRENT_SEMANTICS_MATCH == 'true'\)/u.test(
      edgeLiveProofStep
    ) &&
    /\(\.StackResourceSummaries \| length\) == 9/u.test(
      edgeLiveProofStep
    ) &&
    /aws wafv2 get-web-acl/u.test(edgeLiveProofStep) &&
    /aws wafv2 get-logging-configuration/u.test(edgeLiveProofStep) &&
    /aws logs describe-log-groups/u.test(edgeLiveProofStep) &&
    /aws logs describe-resource-policies/u.test(edgeLiveProofStep) &&
    /aws events describe-rule/u.test(edgeLiveProofStep) &&
    /aws events list-targets-by-rule/u.test(edgeLiveProofStep) &&
    /aws cloudwatch describe-alarms/u.test(edgeLiveProofStep) &&
    /stackPolicyProtected: true/u.test(edgeLiveProofStep) &&
    /terminationProtection: true/u.test(edgeLiveProofStep) &&
    /historical-finalized-protection-only/u.test(edgeHistoricalFinalizeStep) &&
    /currentLiveControlsProved:\s*false/u.test(edgeHistoricalFinalizeStep) &&
    !/git fetch|origin\/main/u.test(
      edgeExecutePlanStep.slice(
        edgeExecutePlanStep.indexOf("aws cloudformation execute-change-set")
      )
    ) &&
    /alarmDeliveryDrill: "not-run"/u.test(edgeLiveProofStep) &&
    /humanPagingDestination: "not-configured-by-this-stack"/u.test(
      edgeLiveProofStep
    ) &&
    !/(?:filter-log-events|get-log-events|start-query|set-alarm-state)/u.test(
      `${edgeSetProtectionStep}\n${edgeLiveProofStep}`
    ) &&
    !/cloudformation (?:create|describe|execute)-change-set/u.test(
      `${edgePreProtectionProofStep}\n${edgeSetProtectionStep}\n${edgeLiveProofStep}`
    ) &&
    /"operations":\s*"plan\|apply\|verify\|cleanup\|finalize"/u.test(
      wellArchitectedContract
    ) &&
    /"cleanupReceiptSanitized":\s*true/u.test(
      wellArchitectedContract
    ) &&
    /"cleanupProtectedEnvironment":\s*"edge-cleanup"/u.test(
      wellArchitectedContract
    ) &&
    wellArchitectedContract.includes(
      '"roleSeparation": "EdgeControlRole cannot list change sets or delete stacks; EdgeCleanupRole cannot create, execute, or delete change sets, set stack policy, change termination protection, pass roles, or assume roles"'
    ) &&
    /"cleanupFinalPreDeleteRevalidation":\s*true/u.test(
      wellArchitectedContract
    ) &&
    /"finalizeCreatesChangeSet":\s*false/u.test(
      wellArchitectedContract
    ) &&
    /"restartSafeProtectionRepair":\s*true/u.test(
      wellArchitectedContract
    ) &&
    /"finalizeHistoricalSourceAllowed":\s*true/u.test(
      wellArchitectedContract
    ) &&
    /"historicalFinalizeClaimsCurrentControls":\s*false/u.test(
      wellArchitectedContract
    ) &&
    /"postExecuteMutableMainRead":\s*false/u.test(
      wellArchitectedContract
    ) &&
    /"updatePlanShapes":\s*\[[\s\S]*?nine Add[\s\S]*?eight Add[\s\S]*?Modify-only/u.test(
      wellArchitectedContract
    );
  const finOpsControlsWorkflow = read(
    ".github/workflows/finops-controls.yml"
  );
  const lambdaTemplate = read("aws/template.yaml");
  const lambdaRuntime = read("src/lambda.ts");
  const lambdaRuntimeTests = read("tests/lambda.test.ts");
  const deliveryBootstrap = read("aws/bootstrap-oidc.yaml");
  const edgeTemplate = read("aws/edge-waf.yaml");
  const finOpsTemplate = read("aws/finops.yaml");
  const foundationMigrationAuthority = read(
    "aws/foundation-migration-authority.sh"
  );
  const foundationMigrationRunbook = read(
    "docs/operations/FOUNDATION_STORAGE_MIGRATION.md"
  );
  const foundationAuthorizeStep = extractNamedWorkflowStep(
    foundationMigrationWorkflow,
    "Fail closed unless the dispatch targets current green main"
  );
  const foundationFailedPlanCleanupStep = extractNamedWorkflowStep(
    foundationMigrationWorkflow,
    "Delete an unverified foundation migration plan"
  );
  const foundationAbortJob = extractNamedWorkflowJob(
    foundationMigrationWorkflow,
    "abort-authority"
  );
  const foundationAbortStep = extractNamedWorkflowStep(
    foundationAbortJob,
    "Prove stable foundation, clean safe plans, and delete authority"
  );
  const foundationApplyStep = extractNamedWorkflowStep(
    foundationMigrationWorkflow,
    "Apply target stack policy and execute the inspected plan"
  );
  const foundationRetireStep = extractNamedWorkflowStep(
    extractNamedWorkflowJob(foundationMigrationWorkflow, "retire-authority"),
    "Verify and retire the exact authority stack"
  );
  const foundationAbortReceiptOffset =
    foundationAbortStep.lastIndexOf("          phase=receipt");
  const foundationAbortReceiptSource =
    foundationAbortReceiptOffset >= 0
      ? foundationAbortStep.slice(foundationAbortReceiptOffset)
      : "";
  const foundationPhaseZeroSource =
    foundationMigrationRunbook.match(
      /## Phase 0: create the one-time authority[\s\S]*?```bash\r?\n([\s\S]*?)\r?\n```/u
    )?.[1] ?? "";
  const foundationLifecycleOperationsValid =
    /SOURCE_COMMIT=\$\(git rev-parse HEAD\)/u.test(
      foundationPhaseZeroSource
    ) &&
    /AUTHORITY_TEMPLATE_SHA256=\$\(\s*bash aws\/foundation-migration-authority\.sh render-template-sha256\s*\)/u.test(
      foundationPhaseZeroSource
    ) &&
    /authority_template=\$\(\s*bash aws\/foundation-migration-authority\.sh render-template\s*\)/u.test(
      foundationPhaseZeroSource
    ) &&
    /ParameterKey=SourceCommit,ParameterValue=\$\{SOURCE_COMMIT\}/u.test(
      foundationPhaseZeroSource
    ) &&
    /ParameterKey=AuthorityTemplateSha256,ParameterValue=\$\{AUTHORITY_TEMPLATE_SHA256\}/u.test(
      foundationPhaseZeroSource
    ) &&
    /Key=SourceCommit,Value=\$\{SOURCE_COMMIT\}/u.test(
      foundationPhaseZeroSource
    ) &&
    /Key=AuthorityTemplateSha256,Value=\$\{AUTHORITY_TEMPLATE_SHA256\}/u.test(
      foundationPhaseZeroSource
    ) &&
    /--no-enable-termination-protection/u.test(
      foundationPhaseZeroSource
    ) &&
    !/--role-arn/u.test(foundationPhaseZeroSource) &&
    /\(\$template\.Resources \| keys\) == \["FoundationMigrationRole"\]/u.test(
      foundationMigrationAuthority
    ) &&
    /\.Stacks\[0\]\.EnableTerminationProtection == false/u.test(
      foundationMigrationAuthority
    ) &&
    /\(\(\.Stacks\[0\]\.RoleARN \/\/ null\) == null\)/u.test(
      foundationMigrationAuthority
    ) &&
    /cloudformation:ListChangeSets/u.test(foundationMigrationAuthority) &&
    /cloudformation:ListStackResources/u.test(
      foundationMigrationAuthority
    ) &&
    /No authority stack has been created as part of[\s\S]*?repository work/u.test(
      foundationMigrationRunbook
    ) &&
    /pre-binding contract cannot be[\s\S]*?administrator must delete it and[\s\S]*?recreate it from Phase 0/u.test(
      foundationMigrationRunbook
    ) &&
    /always\(\)/u.test(foundationFailedPlanCleanupStep) &&
    /steps\.create_plan\.outcome == 'failure'/u.test(
      foundationFailedPlanCleanupStep
    ) &&
    /steps\.load_plan\.outcome == 'failure'/u.test(
      foundationFailedPlanCleanupStep
    ) &&
    /steps\.exact_plan\.outcome == 'failure'/u.test(
      foundationFailedPlanCleanupStep
    ) &&
    /\.ExecutionStatus == "AVAILABLE"/u.test(
      foundationFailedPlanCleanupStep
    ) &&
    /aws cloudformation delete-change-set/u.test(
      foundationFailedPlanCleanupStep
    ) &&
    /test "\$absent" = "true"/u.test(
      foundationFailedPlanCleanupStep
    ) &&
    /test "\$after_projection_sha256" = "\$before_projection_sha256"/u.test(
      foundationFailedPlanCleanupStep
    ) &&
    /changeSetArnSha256: \$arnSha256/u.test(
      foundationFailedPlanCleanupStep
    ) &&
    /cleanup_change_set_id="\$\{CHANGE_SET_ID:-\}"[\s\S]*?--change-set-name "\$CHANGE_SET_NAME"[\s\S]*?\(\$plans \| length\) == 1[\s\S]*?recoveredByDeterministicName/u.test(
      foundationFailedPlanCleanupStep
    ) &&
    /options:\r?\n\s+- plan\r?\n\s+- apply\r?\n\s+- verify\r?\n\s+- abort\r?\n\s+- retire/u.test(
      foundationMigrationWorkflow
    ) &&
    /ABORT-FOUNDATION-MIGRATION-AND-RETIRE-AUTHORITY/u.test(
      foundationAuthorizeStep
    ) &&
    /test "\$GITHUB_SHA" = "\$TARGET_SHA"/u.test(
      foundationAuthorizeStep
    ) &&
    /test "\$\(git rev-parse origin\/main\)" = "\$TARGET_SHA"/u.test(
      foundationAuthorizeStep
    ) &&
    /needs: authorize/u.test(foundationAbortJob) &&
    /Configure exact one-time migration authority/u.test(
      foundationAbortJob
    ) &&
    !/Configure permanent narrow foundation authority/u.test(
      foundationAbortJob
    ) &&
    /foundation-migration-authority\.sh verify-intrinsic/u.test(
      foundationAbortStep
    ) &&
    /\.creationBindingVerified == true/u.test(foundationAbortStep) &&
    /\.resourceCount == 1/u.test(foundationAbortStep) &&
    /all\(\s*\(\.Summaries \/\/ \[\]\)\[\];\s*\(\.ChangeSetName \| startswith\("foundation-storage-"\)\)\s*and \.Status == "CREATE_COMPLETE"\s*and \(\.ExecutionStatus \| IN\("AVAILABLE", "OBSOLETE"\)\)\s*and \(\(\.ImportExistingResources \/\/ false\) == false\)/u.test(
      foundationAbortStep
    ) &&
    /contents\/aws\/bootstrap-oidc\.yaml\?ref=\$\{plan_source\}/u.test(
      foundationAbortStep
    ) &&
    /aws cloudformation delete-change-set/u.test(foundationAbortStep) &&
    /remainingCount: 0/u.test(foundationAbortReceiptSource) &&
    /\)" = "\$target_projection_sha256"/u.test(foundationAbortStep) &&
    /\)" = \\\r?\n\s+"\$target_template_sha256"/u.test(
      foundationAbortStep
    ) &&
    /\)" = "\$target_policy_sha256"/u.test(foundationAbortStep) &&
    /\)" = "\$target_resources_sha256"/u.test(foundationAbortStep) &&
    /aws cloudformation delete-stack \\\r?\n\s+--stack-name "\$authority_stack_id"/u.test(
      foundationAbortStep
    ) &&
    (foundationAbortStep.match(/aws cloudformation delete-stack/gu) ?? [])
      .length === 1 &&
    /grep -Fq "NoSuchEntity" "\$role_error"/u.test(
      foundationAbortStep
    ) &&
    /stackDeleted: true/u.test(foundationAbortReceiptSource) &&
    /roleDeleted: true/u.test(foundationAbortReceiptSource) &&
    foundationAbortReceiptOffset >= 0 &&
    !/AWS_ACCOUNT_ID|arn:aws:/u.test(foundationAbortReceiptSource) &&
    !/cloudformation (?:create|execute)-change-set|cloudformation set-stack-policy|cloudformation update-stack/u.test(
      foundationAbortStep
    ) &&
    /execution_started=true\s+aws cloudformation execute-change-set/u.test(
      foundationApplyStep
    ) &&
    /UPDATE_ROLLBACK_COMPLETE\)[\s\S]*?set-stack-policy/u.test(
      foundationApplyStep
    ) &&
    /foundation-migration-authority\.sh\?ref=\$\{authority_source\}[\s\S]*?env -i[\s\S]*?render-template/u.test(
      foundationAbortStep
    ) &&
    (foundationAbortStep.match(/\(\.Summaries \/\/ \[\]\) \| length == 0/gu) ?? [])
      .length >= 2 &&
    /cloudformation:DetectStackResourceDrift/u.test(
      foundationMigrationAuthority
    ) &&
    /prove-foundation-storage-controls\.sh[\s\S]*?detect-stack-resource-drift[\s\S]*?StackResourceDriftStatus == "IN_SYNC"[\s\S]*?fresh_retirement_proof_sha256[\s\S]*?aws cloudformation delete-stack/u.test(
      foundationRetireStep
    ) &&
    /finalAuthorityProofBoundImmediatelyBeforeDeletion: true/u.test(
      foundationRetireStep
    ) &&
    !/\n\s+(?:aws|git)\s/u.test(
      foundationRetireStep.slice(
        foundationRetireStep.lastIndexOf(
          "bash aws/foundation-migration-authority.sh verify-intrinsic"
        ),
        foundationRetireStep.indexOf(
          "aws cloudformation delete-stack",
          foundationRetireStep.lastIndexOf(
            "bash aws/foundation-migration-authority.sh verify-intrinsic"
          )
        )
      )
    );
  const foundationStorageProof = read(
    "aws/prove-foundation-storage-controls.sh"
  );
  const foundationStorageMigrationPolicy = read(
    "aws/foundation-storage-migration-policy.json"
  );
  let parsedFoundationStorageMigrationPolicy: unknown;
  try {
    parsedFoundationStorageMigrationPolicy = JSON.parse(
      foundationStorageMigrationPolicy
    );
  } catch {
    parsedFoundationStorageMigrationPolicy = undefined;
  }
  const incrementalFixedCostEvaluation =
    evaluateIncrementalFixedCostContract(
      parsedFoundationStorageMigrationPolicy
    );
  const bootstrapStackPolicy = read("aws/bootstrap-stack-policy.json");
  const edgeStackPolicy = read("aws/edge-stack-policy.json");
  const foundationPromotionRole =
    deliveryBootstrap.match(
      /(?:^|\r?\n)  FoundationPromotionRole:\r?\n[\s\S]*?(?=\r?\n  StagingDeployRole:\r?\n|$)/u
    )?.[0] ?? "";
  const finOpsCloudFormationExecutionRole =
    deliveryBootstrap.match(
      /(?:^|\r?\n)  FinOpsCloudFormationExecutionRole:\r?\n[\s\S]*?(?=\r?\n  FinOpsControlRole:\r?\n|$)/u
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
  const alarmRoutingProof = read("aws/prove-alarm-routing.sh");
  const alarmRoutingControls = read(
    ".github/workflows/alarm-routing-controls.yml"
  );
  const s3AccessLoggingTests = read(
    "tests/s3-access-logging.test.ts"
  );
  const alarmRoutingTests = read("tests/alarm-routing.test.ts");
  const stackRestore = read("aws/restore-cloudformation-stack.sh");
  const greenfieldCleanup = read("aws/delete-greenfield-stack.sh");
  const recoverySnapshot = read("aws/prove-recovery-snapshot.sh");
  const canonicalStackTagMerger = read(
    "aws/merge-canonical-stack-tags.sh"
  );
  const samStackTagSerializer = read("aws/serialize-sam-stack-tags.sh");
  const awsRecoveryTests = read("tests/aws-recovery-scripts.test.ts");
  const githubRecoveryPreflight = read(
    "aws/classify-github-recovery-preflight.sh"
  );
  const durableRecoveryClassifier = read(
    "aws/classify-durable-recovery-source.sh"
  );
  const stagingCodeDeploySelector = read(
    "aws/select-staging-codedeploy-rollback.mjs"
  );
  const stagingCodeDeployAppSpecFetcher = read(
    "aws/fetch-codedeploy-appspec-revision.sh"
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
  const githubRecoveryPreflightTests = read(
    "tests/github-recovery-preflight.test.ts"
  );
  const stagingRecoveryDrillTests = read(
    "tests/staging-recovery-drill.test.ts"
  );
  const cloudFormationControlsTests = read(
    "tests/cloudformation-controls.test.ts"
  );
  const gitignore = read(".gitignore");
  const makefile = read("Makefile");
  const devpostSubmission = read("docs/DEVPOST_SUBMISSION.md");
  const videoPlan = read("demo/VIDEO_PLAN.md");
  const videoScenePlan = read("demo/video/scene-plan.json");
  const demoVideoReleaseGate = read(
    "scripts/demo-video-release-gate.ts"
  );
  const demoVideoLibrary = read("demo/video/lib.mjs");
  const demoVideoNarration = read(
    "demo/video/generate-narration.mjs"
  );
  const demoVideoBuilder = read("demo/video/build-video.mjs");
  const demoVideoVerifier = read("demo/video/verify-video.mjs");
  const demoVideoMediaSelfTest = read(
    "demo/video/media-gate-selftest.mjs"
  );
  const demoVideoReceiptGate = read(
    "demo/video/assert-video-receipt.mjs"
  );
  const demoVideoFfmpegInstaller = read(
    "demo/video/install-pinned-ffmpeg-linux.sh"
  );
  const demoVideoCapture = read(
    "web/video/capture-production.mjs"
  );
  const demoVideoCaptureMarkerSelfTest = read(
    "web/video/capture-marker-selftest.mjs"
  );
  const demoVideoTests = read("tests/demo-video.test.ts");
  const finalSubmissionGate = read(
    "scripts/final-submission-gate.ts"
  );
  const hostedDast = read("scripts/hosted-dast.mjs");
  const hostedDastTypes = read("scripts/hosted-dast.d.mts");
  const hostedDastTests = read("tests/hosted-dast.test.ts");
  const predeployZapServer = read("scripts/predeploy-zap-server.mjs");
  const zapPredeployRules = read(".zap/predeploy.tsv");
  const zapReleaseRules = read(".zap/release.tsv");
  const narrator = read("src/agents/narrator.ts");
  const handler = read("src/http/handler.ts");
  const memory = read("src/memory/memory.ts");
  const packageSource = read("package.json");
  const webPackageSource = read("web/package.json");
  const webPackageLock = read("web/package-lock.json");
  const backendCoverageRunner = read(
    "scripts/run-backend-coverage.mjs"
  );
  const frontendTestConfig = read("web/vite.config.ts");
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
  const hostedDastCiJob =
    ci.match(
      /(?:^|\r?\n)  hosted-dast:\r?\n[\s\S]*?(?=\r?\n  [A-Za-z0-9_-]+:\r?\n|$)/u
    )?.[0] ?? "";
  const hostedDastSourceGateJob =
    securityDastWorkflow.match(
      /(?:^|\r?\n)  source-gate:\r?\n[\s\S]*?(?=\r?\n  [A-Za-z0-9_-]+:\r?\n|$)/u
    )?.[0] ?? "";
  const hostedDastReleaseBoundaryJob =
    securityDastWorkflow.match(
      /(?:^|\r?\n)  boundary-probes:\r?\n[\s\S]*?(?=\r?\n  [A-Za-z0-9_-]+:\r?\n|$)/u
    )?.[0] ?? "";
  const hostedDastReleaseZapJob =
    securityDastWorkflow.match(
      /(?:^|\r?\n)  zap-baseline:\r?\n[\s\S]*?(?=\r?\n  [A-Za-z0-9_-]+:\r?\n|$)/u
    )?.[0] ?? "";
  const deploySourceGateJob =
    deploy.match(
      /(?:^|\r?\n)  source-gate:\r?\n[\s\S]*?(?=\r?\n  [A-Za-z0-9_-]+:\r?\n|$)/u
    )?.[0] ?? "";
  const deployBuildOnceJob =
    deploy.match(
      /(?:^|\r?\n)  build-once:\r?\n[\s\S]*?(?=\r?\n  [A-Za-z0-9_-]+:\r?\n|$)/u
    )?.[0] ?? "";
  const deployDatabaseReleaseJob =
    deploy.match(
      /(?:^|\r?\n)  database-release:\r?\n[\s\S]*?(?=\r?\n  [A-Za-z0-9_-]+:\r?\n|$)/u
    )?.[0] ?? "";
  const managedMcpDeployJob =
    deploy.match(
      /(?:^|\r?\n)  managed-mcp-production-audit:\r?\n[\s\S]*?(?=\r?\n  [A-Za-z0-9_-]+:\r?\n|$)/u
    )?.[0] ?? "";
  const supplyChainReleaseJob =
    supplyChainWorkflow.match(
      /(?:^|\r?\n)  release-evidence:\r?\n[\s\S]*?(?=\r?\n  [A-Za-z0-9_-]+:\r?\n|$)/u
    )?.[0] ?? "";
  const memoryEvaluationJob =
    memoryEvaluationWorkflow.match(
      /(?:^|\r?\n)  longitudinal-memory:\r?\n[\s\S]*?(?=\r?\n  [A-Za-z0-9_-]+:\r?\n|$)/u
    )?.[0] ?? "";
  const wellArchitectedRepositoryJob =
    wellArchitectedWorkflow.match(
      /(?:^|\r?\n)  repository-contract:\r?\n[\s\S]*?(?=\r?\n  [A-Za-z0-9_-]+:\r?\n|$)/u
    )?.[0] ?? "";
  const wellArchitectedLiveJob =
    wellArchitectedWorkflow.match(
      /(?:^|\r?\n)  live-read-only:\r?\n[\s\S]*?(?=\r?\n  [A-Za-z0-9_-]+:\r?\n|$)/u
    )?.[0] ?? "";
  const deployStagingJob =
    deploy.match(
      /(?:^|\r?\n)  deploy-staging:\r?\n[\s\S]*?(?=\r?\n  [A-Za-z0-9_-]+:\r?\n|$)/u
    )?.[0] ?? "";
  const deployProductionJob =
    deploy.match(
      /(?:^|\r?\n)  deploy-production:\r?\n[\s\S]*?(?=\r?\n  [A-Za-z0-9_-]+:\r?\n|$)/u
    )?.[0] ?? "";
  const deployHostedDastJob =
    deploy.match(
      /(?:^|\r?\n)  hosted-dast-production:\r?\n[\s\S]*?(?=\r?\n  [A-Za-z0-9_-]+:\r?\n|$)/u
    )?.[0] ?? "";
  const databaseRelease = read("scripts/verify-database-release.ts");
  const clusterGrantProof = read("src/db/cluster-grant-proof.ts");
  const systemGrantContract = read("src/db/system-grants.ts");
  const schemaMigrationRehearsal = read(
    "scripts/schema-migration-rehearsal.ts"
  );
  const databaseReleaseWorkflow = read(
    ".github/workflows/database-release.yml"
  );
  const databaseEndpointVerifier = read(
    "scripts/verify-database-endpoint.ts"
  );
  const databaseSecretContract = read("src/db/secret.ts");
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
  const runtimeResolutionVerifier =
    databaseRelease.match(
      /async function exerciseResolutionDecision[\s\S]*?(?=\r?\nasync function verifyRuntime\()/u
    )?.[0] ?? "";
  const resolutionSandboxVerifier =
    databaseRelease.match(
      /async function verifyResolutionSandboxSecurity[\s\S]*?(?=\r?\nasync function verifyAdmin)/u
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
  const edgeStackHandoffPositions = [
    ...deploy.matchAll(
      /name: Resolve the exact (?:staging|production) edge-stack handoff/gu
    ),
  ].map((match) => match.index ?? -1);
  const samCredentialsRefreshImmediatelyBeforeDeploy =
    samCredentialRefreshPositions.length === 2 &&
    edgeStackHandoffPositions.length === 2 &&
    applicationDeployPositions.length === 2 &&
    samCredentialRefreshPositions.every((position, index) => {
      const handoffPosition = edgeStackHandoffPositions[index];
      const deployPosition = applicationDeployPositions[index];
      return (
        position < handoffPosition &&
        handoffPosition < deployPosition &&
        (
          deploy
            .slice(position, handoffPosition)
            .match(/\r?\n      - name:/gu) ?? []
        ).length === 0 &&
        (
          deploy
            .slice(handoffPosition, deployPosition)
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
  const githubRecoveryPreflightJob =
    recoveryWorkflow.match(
      /(?:^|\r?\n)  classify-recovery:\r?\n[\s\S]*?(?=\r?\n  audit-environments:)/u
    )?.[0] ?? "";
  const recoveryAuditJob =
    recoveryWorkflow.match(
      /(?:^|\r?\n)  audit-environments:\r?\n[\s\S]*?(?=\r?\n  recover-staging:)/u
    )?.[0] ?? "";
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
    "while true; do",
    "$CANARY_URL/api/proof",
    "$CANARY_URL/api/recall",
    "sam deploy",
    "stop_canary_probe",
    "trap - EXIT",
  ];
  const managedMcpGateFragments = [
    'keys == ["aggregate","bound","calledTools","checkedAt","cspannLinkage","database","endpoint","mode","ok","proofs","redactions","release","schemaVersion","scope","toolsAdvertised"]',
    ".schemaVersion == 3",
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
    '"commitSha":$release',
    '"cspannReceiptSha256":$cspann',
    '"idx_agent_memory_company_scope_embedding"',
    '"status":"not-advertised"',
    '.cspannLinkage.explainQuery.status == "verified"',
    '["get_cluster","list_tables","get_table_schema","select_query"]',
    '["get_cluster","list_tables","get_table_schema","explain_query","select_query"]',
    '"Live cluster metadata returned through CockroachDB Cloud Managed MCP."',
    '"`agent_memory` is present in the configured application database."',
    '"Live schema exposes VECTOR(1024) and a native vector index."',
    '"Managed MCP EXPLAIN verified the exact fixed-scope C-SPANN serving index."',
    '"The fixed-scope, index-forced, ten-row-sentinel aggregate is exactly 9/9/9."',
    "map(.name) == $called",
    '.redactions == ["API key","cluster identifier","SQL credentials","memory content","embeddings","raw query plan"]',
    'grep -Fq -- "$CCLOUD_API_KEY"',
    'grep -Fq -- "$COCKROACH_CLUSTER_ID"',
    'sha256sum managed-mcp-',
  ];
  const managedMcpGateBlocks = [
    managedMcpWorkflow,
    managedMcpDeployJob,
  ];
  const managedMcpDatabaseReleaseGrantProofGate =
    /\.schemaVersion == 6[\s\S]*?\(\.runtimes \| length\) == 2[\s\S]*?\(\[\.runtimes\[\]\.environment\] \| sort\) ==[\s\S]*?\["production", "staging"\][\s\S]*?databaseMatrixSha256\] \|[\s\S]*?unique \| length\) == 2[\s\S]*?all\(\.runtimes\[\];[\s\S]*?archon_staging_[a-z0-9{}\[\],^-]+[\s\S]*?archon_production_[a-z0-9{}\[\],^-]+[\s\S]*?\.clusterGrantProof\.routineGrantCount == 2[\s\S]*?\.clusterGrantProof\.databaseGrantCount == 5[\s\S]*?\.clusterGrantProof\.databaseInventory ==[\s\S]*?\["archon", "defaultdb", "postgres", "system"\][\s\S]*?\.clusterGrantProof\.databaseGrantMatrix == \[[\s\S]*?"databaseName":"archon","grantee":\.principal,"privilegeType":"CONNECT","isGrantable":false[\s\S]*?"databaseName":"defaultdb","grantee":"public","privilegeType":"TEMPORARY","isGrantable":false[\s\S]*?"databaseName":"postgres","grantee":"public","privilegeType":"TEMPORARY","isGrantable":false[\s\S]*?\.clusterGrantProof\.databaseMatrixSha256/u;
  const databaseMatrixDigestRecomputeGate =
    /for runtime_environment in staging production; do[\s\S]*?expected_matrix_sha="\$\(jq -er[\s\S]*?\.clusterGrantProof\.databaseMatrixSha256[\s\S]*?matrix_json="\$\(jq -cer[\s\S]*?\.clusterGrantProof\.databaseGrantMatrix[\s\S]*?actual_matrix_sha="\$\(printf '%s' "\$matrix_json"[\s\S]*?sha256sum[\s\S]*?test "\$actual_matrix_sha" = "\$expected_matrix_sha"/u;
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
        '--arg database "$COCKROACH_DATABASE"'
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
  const managedMcpSecretsAreStepScoped = managedMcpGateBlocks.every(
    (block) => {
      const install = block.indexOf("npm ci --ignore-scripts");
      const secret = block.indexOf(
        "CCLOUD_API_KEY: ${{ secrets.CCLOUD_API_KEY }}"
      );
      const receipt = block.indexOf(
        "npm run --silent mcp:cloud:audit"
      );
      return (
        install >= 0 &&
        secret > install &&
        secret < receipt &&
        (
          block.match(
            /CCLOUD_API_KEY: \$\{\{ secrets\.CCLOUD_API_KEY \}\}/gu
          ) ?? []
        ).length === 1 &&
        block.includes("persist-credentials: false")
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
    hasExactAwsDeliveryConcurrency(foundationWorkflow) &&
    hasExactAwsDeliveryConcurrency(deploy) &&
    /(?:^|\r?\n)concurrency:\r?\n  group: aws-recovery-watchdog\r?\n  cancel-in-progress: false\r?\n  queue: max/u.test(
      recoveryWorkflow
    ) &&
    (
      recoveryWorkflow.match(
        /^    concurrency:\r?\n      group: aws-production-delivery\r?\n      cancel-in-progress: false\r?\n      queue: max$/gmu
      ) ?? []
    ).length === 2 &&
    githubRecoveryPreflightJob.length > 0 &&
    /name: Classify recovery candidates without AWS access/u.test(
      githubRecoveryPreflightJob
    ) &&
    /bash aws\/classify-github-recovery-preflight\.sh/u.test(
      githubRecoveryPreflightJob
    ) &&
    /classificationSource == "github-actions-metadata-only"/u.test(
      githubRecoveryPreflightJob
    ) &&
    /awsCredentialsUsed == false/u.test(githubRecoveryPreflightJob) &&
    !/^    environment:/mu.test(githubRecoveryPreflightJob) &&
    !/configure-aws-credentials|id-token:\s*write/u.test(
      githubRecoveryPreflightJob
    ) &&
    !/\baws\s+(?:cloudformation|s3|s3api|sts)\b/u.test(
      githubRecoveryPreflight
    ) &&
    /source-deploy-active/u.test(githubRecoveryPreflight) &&
    /terminal-commit-proved/u.test(githubRecoveryPreflight) &&
    /successful-recovery-receipt-proved/u.test(
      githubRecoveryPreflight
    ) &&
    /active deploy/u.test(githubRecoveryPreflightTests) &&
    /exact armed uncommitted candidate/u.test(
      githubRecoveryPreflightTests
    ) &&
    /receipt-bound successful watchdog/u.test(
      githubRecoveryPreflightTests
    ) &&
    /\.total_count == \(\.jobs \| length\)/u.test(
      githubRecoveryPreflight
    ) &&
    /test "\$run_count" -eq "\$expected_run_count"/u.test(
      githubRecoveryPreflight
    ) &&
    /test "\$artifact_count" -eq "\$expected_artifact_count"/u.test(
      githubRecoveryPreflight
    ) &&
    /GitHub preflight fails closed on an unknown listed deploy status/u.test(
      githubRecoveryPreflightTests
    ) &&
    /GitHub preflight fails closed on a truncated jobs response/u.test(
      githubRecoveryPreflightTests
    ) &&
    /GitHub preflight fails closed on a truncated workflow-runs response/u.test(
      githubRecoveryPreflightTests
    ) &&
    /GitHub preflight fails closed on a truncated recovery-artifact response/u.test(
      githubRecoveryPreflightTests
    ) &&
    /never promotes dispatch metadata into a production recovery candidate/u.test(
      githubRecoveryPreflightTests
    ) &&
    /trusted legacy workflow-run deploy history/u.test(
      githubRecoveryPreflightTests
    ) &&
    recoveryAuditJob.length > 0 &&
    /needs\.classify-recovery\.outputs\.staging_action == 'noop'/u.test(
      recoveryAuditJob
    ) &&
    /needs\.classify-recovery\.outputs\.production_action == 'noop'/u.test(
      recoveryAuditJob
    ) &&
    !/aws-production-delivery/u.test(recoveryAuditJob) &&
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
    ).length === 7 &&
    /--argjson leaseUntil "\$\(\(now \+ 7200\)\)"/u.test(
      durableRecoveryLedger
    ) &&
    watchdogRefreshesImmediatelyPrecedeExecution &&
    watchdogTerminalJsonGatesAreOrdered &&
    (
      recoveryWorkflow.match(
        /uses: actions\/checkout@[0-9a-f]{40}[^\r\n]*\r?\n        with:\r?\n          ref: \$\{\{ github\.sha \}\}\r?\n          fetch-depth: 0/gu
      ) ?? []
    ).length === 4 &&
    (
      recoveryWorkflow.match(
        /github\.repository == 'upgradedev\/archon-cockroach-memory' &&\r?\n\s+github\.ref == 'refs\/heads\/main'/gu
      ) ?? []
    ).length === 3 &&
    (
      recoveryWorkflow.match(
        /test "\$GITHUB_REPOSITORY" = \\\r?\n\s+"upgradedev\/archon-cockroach-memory"/gu
      ) ?? []
    ).length === 4 &&
    (
      recoveryWorkflow.match(
        /test "\$GITHUB_REF" = "refs\/heads\/main"/gu
      ) ?? []
    ).length === 4 &&
    (
      recoveryWorkflow.match(
        /test "\$GITHUB_REF_TYPE" = "branch"/gu
      ) ?? []
    ).length === 4 &&
    (
      recoveryWorkflow.match(
        /test "\$GITHUB_WORKFLOW_REF" = \\\r?\n\s+"upgradedev\/archon-cockroach-memory\/\.github\/workflows\/recover-aws\.yml@refs\/heads\/main"/gu
      ) ?? []
    ).length === 4 &&
    (
      recoveryWorkflow.match(
        /test "\$\(git rev-parse HEAD\)" = "\$GITHUB_SHA"/gu
      ) ?? []
    ).length === 4 &&
    (
      recoveryWorkflow.match(
        /git fetch --no-tags origin \\\r?\n\s+\+refs\/heads\/main:refs\/remotes\/origin\/main/gu
      ) ?? []
    ).length === 4 &&
    (
      recoveryWorkflow.match(
        /test "\$\(git rev-parse origin\/main\)" = "\$GITHUB_SHA"/gu
      ) ?? []
    ).length === 4 &&
    !/github\.event\.workflow_run\.head_sha/u.test(recoveryWorkflow) &&
    /recover-staging:[\s\S]*?needs:\r?\n\s+- classify-recovery\r?\n\s+if: >-\r?\n\s+needs\.classify-recovery\.result == 'success' &&\r?\n\s+needs\.classify-recovery\.outputs\.staging_action == 'recover' &&\r?\n\s+github\.repository == 'upgradedev\/archon-cockroach-memory' &&\r?\n\s+github\.ref == 'refs\/heads\/main'\r?\n\s+runs-on:/u.test(
      recoveryWorkflow
    ) &&
    /recover-production:[\s\S]*?needs:\r?\n\s+- classify-recovery\r?\n\s+- recover-staging\r?\n\s+if: >-\r?\n\s+always\(\) &&\r?\n\s+needs\.classify-recovery\.result == 'success' &&\r?\n\s+needs\.classify-recovery\.outputs\.production_action == 'recover' &&\r?\n\s+github\.repository == 'upgradedev\/archon-cockroach-memory' &&\r?\n\s+github\.ref == 'refs\/heads\/main'\r?\n\s+runs-on:/u.test(
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
    ).length === 17 &&
    (
      recoveryWorkflow.match(
        /bash aws\/classify-durable-recovery-source\.sh >"\$classification"\r?\n\s+jq -e -s/gu
      ) ?? []
    ).length === 3 &&
    (
      recoveryWorkflow.match(
        /PREFLIGHT_CANDIDATE_SHA: \$\{\{ needs\.classify-recovery\.outputs\.(?:staging|production)_candidate_sha \}\}/gu
      ) ?? []
    ).length === 2 &&
    (
      recoveryWorkflow.match(
        /and \.action == "recover"\r?\n\s+and \.candidateSha == \$candidate\r?\n\s+and \.sourceRunAttempt == \$sourceRunAttempt\r?\n\s+and \.sourceRunId == \$sourceRunId/gu
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
    ).length === 1 &&
    (
      recoveryWorkflow.match(
        /name: Upload exact protection and drift audit/gu
      ) ?? []
    ).length === 1 &&
    (
      recoveryWorkflow.match(
        /github\.event_name == 'schedule' &&\r?\n\s+github\.event\.schedule == '17 4 \* \* \*'/gu
      ) ?? []
    ).length === 1 &&
    (
      recoveryWorkflow.match(
        /github\.event_name == 'workflow_dispatch' &&\r?\n\s+inputs\.operation == 'audit'/gu
      ) ?? []
    ).length === 1 &&
    (
      recoveryWorkflow.match(
        /path: \$\{\{ runner\.temp \}\}\/\$\{\{ matrix\.environment \}\}-cloudformation-controls-audit\.json/gu
      ) ?? []
    ).length === 1 &&
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
    /\.ServerSideEncryption == "aws:kms"/u.test(
      durableRecoveryLedger
    ) &&
    /storage_key_alias="arn:aws:kms:\$\{AWS_REGION\}:\$\{AWS_ACCOUNT_ID\}:alias\/\$\{APP_NAME\}-storage"/u.test(
      durableRecoveryLedger
    ) &&
    /\.BucketKeyEnabled == true/u.test(durableRecoveryLedger) &&
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
    /--server-side-encryption aws:kms/u.test(durableRecoveryLedger) &&
    /--ssekms-key-id "\$storage_key_alias"/u.test(
      durableRecoveryLedger
    ) &&
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
    /--server-side-encryption aws:kms/u.test(
      durableRecoveryObjectPublisher
    ) &&
    /--ssekms-key-id "\$storage_key_alias"/u.test(
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
    (
      durableRecoveryClassifier.match(
        /queued\|in_progress\|pending\|waiting\|requested/gu
      ) ?? []
    ).length === 2 &&
    /The Deploy AWS run status is invalid\./u.test(
      durableRecoveryClassifier
    ) &&
    /\.total_count == \(\.jobs \| length\)/u.test(
      durableRecoveryClassifier
    ) &&
    /\.total_count <= 100/u.test(durableRecoveryClassifier) &&
    /classifier fails closed on an unknown Deploy AWS source status/u.test(
      recoveryWatchdogTests
    ) &&
    /classifier fails closed on a truncated Deploy AWS jobs response/u.test(
      recoveryWatchdogTests
    ) &&
    /classifier fails closed on an unknown prior watchdog owner status/u.test(
      recoveryWatchdogTests
    ) &&
    /trusted legacy workflow-run sources/u.test(recoveryWatchdogTests) &&
    /if \[ "\$run_event" != "workflow_dispatch" \]; then[\s\S]*?classify_environment_job production/u.test(
      githubRecoveryPreflight
    ) &&
    /test "\$run_count" -eq "\$expected_run_count"/u.test(
      githubRecoveryPreflight
    ) &&
    /test "\$artifact_count" -eq "\$expected_artifact_count"/u.test(
      githubRecoveryPreflight
    ) &&
    /\.total_count == \(\.jobs \| length\)/u.test(
      githubRecoveryPreflight
    ) &&
    /GitHub preflight fails closed on an unknown listed deploy status/u.test(
      githubRecoveryPreflightTests
    ) &&
    /GitHub preflight fails closed on a truncated jobs response/u.test(
      githubRecoveryPreflightTests
    ) &&
    /GitHub preflight fails closed on a truncated workflow-runs response/u.test(
      githubRecoveryPreflightTests
    ) &&
    /GitHub preflight fails closed on a truncated recovery-artifact response/u.test(
      githubRecoveryPreflightTests
    ) &&
    /never promotes dispatch metadata into a production recovery candidate/u.test(
      githubRecoveryPreflightTests
    ) &&
    /trusted legacy workflow-run deploy history/u.test(
      githubRecoveryPreflightTests
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
      .length === 1 &&
    (packageSource.match(/tests\/recovery-watchdog\.test\.ts/gu) ?? [])
      .length === 1 &&
    /const canonicalTestCommand = packageJson\?\.scripts\?\.test/u.test(
      backendCoverageRunner
    ) &&
    /canonicalTestCommand\.match\(/u.test(
      backendCoverageRunner
    ) &&
    /\.\.\.testFiles/u.test(backendCoverageRunner);
  const stagingCodeDeployPolicyStart = deliveryBootstrap.indexOf(
    "  StagingCodeDeployInspectionPolicy:"
  );
  const stagingCodeDeployPolicyEnd = deliveryBootstrap.indexOf(
    "  StagingAlarmRoutingInspectionPolicy:",
    stagingCodeDeployPolicyStart
  );
  const stagingCodeDeployPolicy =
    stagingCodeDeployPolicyStart >= 0 &&
    stagingCodeDeployPolicyEnd > stagingCodeDeployPolicyStart
      ? deliveryBootstrap.slice(
          stagingCodeDeployPolicyStart,
          stagingCodeDeployPolicyEnd
        )
      : "";
  const stagingCodeDeployActions = [
    ...stagingCodeDeployPolicy.matchAll(
      /(?:Action:\s+|- )(codedeploy:[A-Za-z]+)$/gmu
    ),
  ].map((match) => match[1]).sort();
  const exactStagingCodeDeployActions =
    JSON.stringify(stagingCodeDeployActions) ===
    JSON.stringify(
      [
        "codedeploy:GetApplicationRevision",
        "codedeploy:GetDeployment",
        "codedeploy:GetDeploymentGroup",
        "codedeploy:ListDeployments",
      ].sort()
    );
  const stagingFaultInjectedRecoveryContract =
    hasExactAwsDeployTrigger(deploy) &&
    deploySourceGateJob.includes(
      'test "$DEPLOY_TARGET_SHA" = "$EXPECTED_SHA"'
    ) &&
    deploySourceGateJob.includes(
      '"FAULT-INJECT-STAGING-RECOVERY-AND-REQUIRE-WATCHDOG"'
    ) &&
    deploySourceGateJob.includes(
      '[[ "$APPROVAL_REFERENCE" =~ ^[A-Za-z0-9][A-Za-z0-9._:/+-]{7,127}$ ]]'
    ) &&
    deploySourceGateJob.includes(
      '"drill-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"'
    ) &&
    /^    if: github\.event_name == 'push'$/mu.test(
      deployDatabaseReleaseJob
    ) &&
    /^    if: github\.event_name == 'push'$/mu.test(managedMcpDeployJob) &&
    /always\(\)/u.test(deployStagingJob) &&
    /!cancelled\(\)/u.test(deployStagingJob) &&
    /needs\.database-release\.result == 'success'/u.test(
      deployStagingJob
    ) &&
    /needs\.managed-mcp-production-audit\.result == 'success'/u.test(
      deployStagingJob
    ) &&
    /needs\.database-release\.result == 'skipped'/u.test(
      deployStagingJob
    ) &&
    /needs\.managed-mcp-production-audit\.result == 'skipped'/u.test(
      deployStagingJob
    ) &&
    /COCKROACH_SQL_DNS: \$\{\{ needs\.database-release\.outputs\.cockroach_sql_dns \|\| '' \}\}/u.test(
      deployStagingJob
    ) &&
    /prior_cockroach_sql_dns=/u.test(deployStagingJob) &&
    /exact_parameter\("CockroachSqlDns"; \$cockroachSqlDns\)/u.test(
      deployStagingJob
    ) &&
    /COCKROACH_SQL_DNS=\$prior_cockroach_sql_dns/u.test(
      deployStagingJob
    ) &&
    /name: Authorize the exact existing staging release for fault injection[\s\S]*?name: Persist and arm the immutable staging recovery intent[\s\S]*?name: Deploy staging with recovery-safe SAM canary/u.test(
      deployStagingJob
    ) &&
    /candidate_database_secret_id="\$\{APP_NAME\}\/staging\/recovery-drill-inaccessible-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}"/u.test(
      deployStagingJob
    ) &&
    /AdditionalVersionWeights/u.test(deployStagingJob) &&
    /\.value >= 0\.099/u.test(deployStagingJob) &&
    /\.value <= 0\.101/u.test(deployStagingJob) &&
    /StateValue == "ALARM"/u.test(deployStagingJob) &&
    /ExecutedVersion/u.test(deployStagingJob) &&
    /test "\$sam_status" -ne 0/u.test(deployStagingJob) &&
    /steps\.deploy\.outcome == 'failure'/u.test(deployStagingJob) &&
    /staging-recovery-drill-started-epoch/u.test(deployStagingJob) &&
    /bash aws\/fetch-codedeploy-appspec-revision\.sh/u.test(
      deployStagingJob
    ) &&
    /deploy get-application-revision/u.test(
      stagingCodeDeployAppSpecFetcher
    ) &&
    /appSpecContent: \{sha256: \$sha\}/u.test(
      stagingCodeDeployAppSpecFetcher
    ) &&
    /\.revision\.appSpecContent\.sha256 == \$sha/u.test(
      stagingCodeDeployAppSpecFetcher
    ) &&
    /select-staging-codedeploy-rollback\.mjs/u.test(deployStagingJob) &&
    /EXPECTED_CLOUDFORMATION_STACK_ID/u.test(deployStagingJob) &&
    /EXPECTED_CANDIDATE_OBSERVED_AT/u.test(deployStagingJob) &&
    /sourceBinding\.externalStackIdMatched/u.test(deployStagingJob) &&
    /sourceBinding\.appSpecSha256/u.test(deployStagingJob) &&
    /sourceErrorCode: "ALARM_ACTIVE"/u.test(deployStagingJob) &&
    /sourceStatus: "Stopped"/u.test(deployStagingJob) &&
    /rollbackRelationProved: true/u.test(deployStagingJob) &&
    /"UPDATE_ROLLBACK_COMPLETE"/u.test(deployStagingJob) &&
    /schema: "archon\.staging-recovery-drill"/u.test(deployStagingJob) &&
    /version: 2/u.test(deployStagingJob) &&
    /behaviorFaultInjected: true/u.test(deployStagingJob) &&
    /secretMaterialCreated: false/u.test(deployStagingJob) &&
    /productionMutationPermitted: false/u.test(deployStagingJob) &&
    /ledgerStateAfterInlineRecovery: "ARMED"/u.test(deployStagingJob) &&
    /watchdogTerminalRecoveryPending: true/u.test(deployStagingJob) &&
    /if: success\(\) && github\.event_name == 'push'/u.test(
      deployProductionJob
    ) &&
    !/staging-recovery-drill/u.test(deployProductionJob) &&
    /if \[ "\$run_event" != "workflow_dispatch" \]; then[\s\S]*?classify_environment_job production/u.test(
      githubRecoveryPreflight
    ) &&
    /\.event == "workflow_run"/u.test(githubRecoveryPreflight) &&
    /\.event == "workflow_dispatch" and \$environment == "staging"/u.test(
      durableRecoveryClassifier
    ) &&
    /RecoveryDrillToken:/u.test(lambdaTemplate) &&
    /RecoveryDrillIsStagingOnly:[\s\S]*?RuleCondition: !Not \[!Equals \[!Ref RecoveryDrillToken, disabled\]\][\s\S]*?Assert: !Equals \[!Ref Environment, staging\]/u.test(
      lambdaTemplate
    ) &&
    /RECOVERY_DRILL_TOKEN: !Ref RecoveryDrillToken/u.test(lambdaTemplate) &&
    exactStagingCodeDeployActions &&
    /application:\$\{AppName\}-staging-\*/u.test(
      stagingCodeDeployPolicy
    ) &&
    /deploymentgroup:\$\{AppName\}-staging-\*\/\*/u.test(
      stagingCodeDeployPolicy
    ) &&
    (
      stagingCodeDeployPolicy.match(
        /aws:RequestedRegion: !Ref AWS::Region/gu
      ) ?? []
    ).length === 2 &&
    (stagingCodeDeployPolicy.match(/Effect: Allow/gu) ?? []).length === 2 &&
    !/Resource: "\*"/u.test(stagingCodeDeployPolicy) &&
    /source\.status !== "Stopped"/u.test(stagingCodeDeploySelector) &&
    /source\.externalId !== stackId/u.test(stagingCodeDeploySelector) &&
    /revision\.currentVersion === previousVersion/u.test(
      stagingCodeDeploySelector
    ) &&
    /revision\.targetVersion === candidateVersion/u.test(
      stagingCodeDeploySelector
    ) &&
    /calculatedSha === requestedSha/u.test(stagingCodeDeploySelector) &&
    /sourceMatches\.length === 1/u.test(stagingCodeDeploySelector) &&
    /rollbackMatches\.length === 1/u.test(stagingCodeDeploySelector) &&
    /observed >= started/u.test(stagingCodeDeploySelector) &&
    /ended >= observed/u.test(stagingCodeDeploySelector) &&
    /created >= sourceCreated/u.test(stagingCodeDeploySelector) &&
    /staging fault injection is an exact protected manual operation/u.test(
      stagingRecoveryDrillTests
    ) &&
    /CodeDeploy selector proves the exact stack, drill window, AppSpec, and rollback relation/u.test(
      stagingRecoveryDrillTests
    ) &&
    /receipt requires Stopped ALARM_ACTIVE, related successful rollback/u.test(
      stagingRecoveryDrillTests
    ) &&
    /AppSpec fetcher sends the exact deployment SHA in the documented AWS request shape/u.test(
      stagingRecoveryDrillTests
    ) &&
    /CodeDeploy selector rejects reversed runner and deployment chronology/u.test(
      stagingRecoveryDrillTests
    ) &&
    /watchdog classifiers accept dispatch evidence only for staging/u.test(
      stagingRecoveryDrillTests
    ) &&
    /"recoveryDrillTokenEnforcedStagingOnlyByTemplate":\s*true/u.test(
      wellArchitectedContract
    ) &&
    /"sourceDeploymentAlarmTerminalStatus":\s*"Stopped"/u.test(
      wellArchitectedContract
    ) &&
    /"sourceDeploymentBoundToExactStackAndDrillWindow":\s*true/u.test(
      wellArchitectedContract
    ) &&
    /"sourceDeploymentBoundToShaVerifiedLambdaAppSpec":\s*true/u.test(
      wellArchitectedContract
    ) &&
    /"appSpecFetchRequestBehaviorallyTested":\s*true/u.test(
      wellArchitectedContract
    ) &&
    /"codeDeployInspectionStagingResourceScoped":\s*true/u.test(
      wellArchitectedContract
    ) &&
    /"githubRecoveryPaginationCompleteAndLegacyCompatible":\s*true/u.test(
      wellArchitectedContract
    ) &&
    /"watchdogUnknownStatusAndIncompleteInventoryFailClosed":\s*true/u.test(
      wellArchitectedContract
    ) &&
    /"sharedProductionDatabaseReconciliationPermitted":\s*false/u.test(
      wellArchitectedContract
    ) &&
    /"sharedProductionManagedMcpAuditPermitted":\s*false/u.test(
      wellArchitectedContract
    ) &&
    (packageSource.match(/tests\/staging-recovery-drill\.test\.ts/gu) ?? [])
      .length === 1;
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
          `--s3-prefix "candidates/deployments/${environment}/\${{ github.sha }}"`
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
      recoveryAuditJob.match(
        /bash aws\/enforce-cloudformation-controls\.sh audit/gu
      ) ?? []
    ).length === 1 &&
    /strategy:\r?\n\s+fail-fast: false\r?\n\s+matrix:\r?\n\s+include:\r?\n\s+- environment: staging\r?\n\s+stack_name: archon-memory-staging\r?\n\s+terminal_job_name: Deploy and smoke staging\r?\n\s+- environment: production\r?\n\s+stack_name: archon-memory-production\r?\n\s+terminal_job_name: Promote identical candidate to production/u.test(
      recoveryAuditJob
    ) &&
    (
      recoveryWorkflow.match(
        /bash aws\/enforce-cloudformation-controls\.sh recover/gu
      ) ?? []
    ).length === 4 &&
    (
      deliveryBootstrap.match(
        /cloudformation:UpdateTerminationProtection/gu
      ) ?? []
    ).length === 4 &&
    /Sid: PlanAndApplyExactEdgeStacks[\s\S]*?cloudformation:UpdateTerminationProtection[\s\S]*?stack\/\$\{AppName\}-staging-edge\/\*[\s\S]*?stack\/\$\{AppName\}-production-edge\/\*/u.test(
      deliveryBootstrap
    ) &&
    /Sid: PlanAndApplyExactFinOpsStacks[\s\S]*?cloudformation:UpdateTerminationProtection[\s\S]*?stack\/\$\{AppName\}-finops\/\*/u.test(
      deliveryBootstrap
    ) &&
    /PolicyName: deploy-staging[\s\S]*?cloudformation:UpdateTerminationProtection[\s\S]*?stack\/\$\{AppName\}-staging\/\*/u.test(
      deliveryBootstrap
    ) &&
    /PolicyName: deploy-production[\s\S]*?cloudformation:UpdateTerminationProtection[\s\S]*?stack\/\$\{AppName\}-production\/\*/u.test(
      deliveryBootstrap
    ) &&
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
    ).length === 1;
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
      /MANAGED_MCP_RECEIPT_SCHEMA_VERSION\s*=\s*3/iu.test(
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
        /parseManagedMcpCspannExplainResult/u.test(managedMcpAudit) &&
        /runMemoryIntegrityAgent/u.test(managedMcpAudit) &&
        /MANAGED_MCP_RELEASE_SHA/u.test(managedMcpAudit) &&
        /MANAGED_MCP_CSPANN_RECEIPT_SHA256/u.test(managedMcpAudit) &&
        /idx_agent_memory_company_scope_embedding/u.test(
          managedMcpAudit
        ) &&
        /"verified"\s*\|\s*"not-advertised"/u.test(managedMcpAudit) &&
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
        /receipt v3 binds exact release, C-SPANN evidence/u.test(
          managedMcpAuditTests
        ) &&
        managedMcpEvidenceDocs.every(
          (document) =>
            /actions\/runs\/30204081177/u.test(document) &&
            /a2b69e3fad31010d14d0c3bca261421e635ca885/u.test(
              document
            ) &&
            !staleManagedMcpEvidence.test(document)
        ),
      "Managed MCP v3 proves the exact fixed scope, binds the exact release C-SPANN receipt, and capability-safely verifies explain_query when advertised.",
      "Managed MCP v3 release linkage, capability-safe EXPLAIN, bounds, parser, tests, or evidence disclosure is incomplete."
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
        /hosted-dast:/u.test(ci) &&
        /test:e2e/iu.test(ci),
      "CI gates backend, real CockroachDB, node loss, security, hosted DAST, load, frontend, SAM, and browser journeys.",
      "One or more release-critical CI jobs are missing."
    ),
    sourceCheck(
      "tech.pipeline-coverage-evidence",
      "Technical Implementation",
      /"test:coverage":\s*"node scripts\/run-backend-coverage\.mjs"/u.test(
        packageSource
      ) &&
        /if \(!runnerTemp\)[\s\S]*?coverage is CI-only/iu.test(
          backendCoverageRunner
        ) &&
        /const canonicalTestCommand = packageJson\?\.scripts\?\.test/u.test(
          backendCoverageRunner
        ) &&
        /new Set\(testFiles\)\.size !== testFiles\.length/u.test(
          backendCoverageRunner
        ) &&
        /\.\.\.testFiles/u.test(backendCoverageRunner) &&
        /"archon-coverage",\s*\n?\s*"backend",\s*\n?\s*"lcov\.info"/u.test(
          backendCoverageRunner
        ) &&
        /--test-coverage-lines=80/u.test(backendCoverageRunner) &&
        /--test-coverage-branches=75/u.test(backendCoverageRunner) &&
        /--test-coverage-functions=80/u.test(backendCoverageRunner) &&
        /path:\s*\$\{\{\s*runner\.temp\s*\}\}\/archon-coverage\/backend\/lcov\.info/u.test(
          ci
        ) &&
        /@vitest\/coverage-v8":\s*"4\.1\.10"/u.test(webPackageSource) &&
        /node_modules\/@vitest\/coverage-v8/u.test(webPackageLock) &&
        /process\.env\.RUNNER_TEMP \?\? tmpdir\(\)/u.test(
          frontendTestConfig
        ) &&
        /"archon-coverage",\s*\n?\s*"frontend"/u.test(frontendTestConfig) &&
        /statements:\s*80[\s\S]*?branches:\s*75[\s\S]*?functions:\s*80[\s\S]*?lines:\s*80/u.test(
          frontendTestConfig
        ) &&
        /path:\s*\|[\s\S]*?\$\{\{\s*runner\.temp\s*\}\}\/archon-coverage\/frontend\/coverage-summary\.json[\s\S]*?\$\{\{\s*runner\.temp\s*\}\}\/archon-coverage\/frontend\/lcov\.info/u.test(
          ci
        ),
      "Backend and frontend coverage enforce 80/75/80 release floors and retain LCOV/summary evidence exclusively under the ephemeral CI runner.",
      "Coverage thresholds, immutable tooling, CI-only output isolation, or uploaded evidence is incomplete."
    ),
    sourceCheck(
      "tech.managed-mcp-receipt-v3-gate",
      "Technical Implementation",
      managedMcpGateBlocks.every(
        (block) =>
          block.length > 0 &&
          managedMcpGateFragments.every((fragment) =>
            block.includes(fragment)
          )
      ) &&
        managedMcpGateBlocks.every((block) =>
          managedMcpDatabaseReleaseGrantProofGate.test(block)
        ) &&
        managedMcpGateBlocks.every((block) =>
          databaseMatrixDigestRecomputeGate.test(block)
        ) &&
        managedMcpLeakChecksPrecedeJq &&
        managedMcpSecretsAreStepScoped &&
        /needs:\s*\r?\n      - database-release/u.test(
          managedMcpDeployJob
        ) &&
        /- managed-mcp-production-audit/u.test(deployStagingJob) &&
        /- managed-mcp-production-audit/u.test(
          deployProductionJob
        ) &&
        /database-release-\$\{\{\s*github\.sha\s*\}\}/u.test(
          managedMcpDeployJob
        ) &&
        /receipt_sha256:\s*\$\{\{\s*steps\.receipt\.outputs\.receipt_sha256\s*\}\}/u.test(
          managedMcpDeployJob
        ) &&
        /actions\/workflows\/deploy-aws\.yml\/runs\?branch=main&event=push&status=success/u.test(
          managedMcpWorkflow
        ) &&
        !/event=workflow_run/u.test(managedMcpWorkflow) &&
        /- name: Upload the sanitized proof receipt[\s\S]*?if: success\(\)[\s\S]*?if-no-files-found: error/u.test(
          managedMcpWorkflow
        ) &&
        /- name: Upload the sanitized proof receipt[\s\S]*?retention-days: 90/u.test(
          managedMcpWorkflow
        ),
      "Both protected Managed MCP paths bind exact-SHA C-SPANN evidence, capability-safely verify optional EXPLAIN, and causally gate staging and production promotion.",
      "A Managed MCP workflow does not fail closed on the exact sanitized v3 receipt or does not causally gate promotion."
    ),
    sourceCheck(
      "tech.fail-closed-ci-aggregate",
      "Technical Implementation",
      /needs:\s*\[secret-scan,\s*dep-audit,\s*build-test,\s*cluster-survival,\s*pen-test,\s*load,\s*frontend-iac,\s*hosted-dast,\s*video-gate\]/u.test(
        readinessJob
      ) &&
        /^    if:\s*\$\{\{\s*always\(\)\s*\}\}\s*$/mu.test(readinessJob) &&
        /^    steps:\r?\n      - name: Require every prerequisite CI job to pass\s*$/mu.test(
          readinessJob
        ) &&
        /length == 9 and all\(\.\[\];\s*\.result == "success"\)/u.test(
          readinessJob
        ),
      "The aggregate readiness check always runs and fails unless every prerequisite CI job succeeded.",
      "The aggregate readiness check can be skipped or does not fail closed over every prerequisite."
    ),
    sourceCheck(
      "tech.immutable-supply-chain",
      "Technical Implementation",
      allWorkflowActionsPinned(workflows) &&
        allWorkflowActionCommitsInventoryLocked(
          workflows,
          supplyChainToolLock
        ) &&
        allSetupNodeStepsPinned(workflows) &&
        allCheckoutStepsDisableCredentialPersistence(workflows) &&
        allComposeImagesPinned(composeSources) &&
        allCockroachImagesPinned(cockroachImageSources) &&
        allDockerfileBasesPinned(dockerfiles) &&
        has("package-lock.json") &&
        has("web/package-lock.json"),
      "Actions, CockroachDB image, runtime, and lockfiles are immutable/reproducible.",
      "A mutable Action/image/runtime reference remains."
    ),
    sourceCheck(
      "tech.pipeline-owned-supply-chain-evidence",
      "Technical Implementation",
      /name:\s*Supply Chain \(enforced\)/u.test(
        supplyChainWorkflow
      ) &&
        /install_locked_tool shellcheck/u.test(supplyChainWorkflow) &&
        /install_locked_tool actionlint/u.test(supplyChainWorkflow) &&
        /install_locked_tool zizmor/u.test(supplyChainWorkflow) &&
        /install_locked_tool cfn_guard/u.test(supplyChainWorkflow) &&
        /install_locked_tool trivy/u.test(supplyChainWorkflow) &&
        /install_locked_tool syft/u.test(supplyChainWorkflow) &&
        /actions\/dependency-review-action@a1d282b36b6f3519aa1f3fc636f609c47dddb294/u.test(
          supplyChainWorkflow
        ) &&
        /--scanners vuln,license/u.test(supplyChainWorkflow) &&
        /for scope in backend frontend lambda-content/u.test(
          supplyChainWorkflow
        ) &&
        /"lambdaContent":0/u.test(supplyChainWorkflow) &&
        /"lambdaContent":\s*"omitted-root-only"/u.test(supplyChainWorkflow) &&
        /"catalogedDependencyPackages":\s*0/u.test(supplyChainWorkflow) &&
        /cfn-lint==1\.53\.1/u.test(supplyChainWorkflow) &&
        /cfn-lint --format json "\$template"/u.test(
          supplyChainWorkflow
        ) &&
        /sam validate\s*\\\s*\r?\n\s*--lint/u.test(
          supplyChainWorkflow
        ) &&
        /spdx-json/u.test(supplyChainWorkflow) &&
        /cyclonedx-json/u.test(supplyChainWorkflow) &&
        /audit_template edge-waf aws\/edge-waf\.yaml/u.test(
          supplyChainWorkflow
        ) &&
        /audit_template finops aws\/finops\.yaml/u.test(
          supplyChainWorkflow
        ) &&
        /lint_template finops aws\/finops\.yaml/u.test(
          supplyChainWorkflow
        ) &&
        /name:\s*Enforce zero-unwaived static findings/u.test(
          supplyChainWorkflow
        ) &&
        /name:\s*Enforce zero-unwaived infrastructure findings/u.test(
          supplyChainWorkflow
        ) &&
        /name:\s*Enforce zero-unwaived vulnerability and license findings/u.test(
          supplyChainWorkflow
        ) &&
        (supplyChainWorkflow.match(/--exit-code 1/gu) ?? []).length ===
          1 &&
        (supplyChainWorkflow.match(/--exit-code 0/gu) ?? []).length >=
          2 &&
        /validate-trivy-iac-compatibility\.mjs\s+\\\s*\r?\n\s+--self-test/u.test(
          supplyChainWorkflow
        ) &&
        /validate-trivy-sbom-policy\.mjs --self-test/u.test(
          supplyChainWorkflow
        ) &&
        /trivy-iac-compatibility-findings\.json/u.test(
          supplyChainWorkflow
        ) &&
        /trivy-iac-blocking-findings\.json/u.test(
          supplyChainWorkflow
        ) &&
        /trivy-sbom-compatibility-findings\.json/u.test(
          supplyChainWorkflow
        ) &&
        /trivy-sbom-blocking-findings\.json/u.test(
          supplyChainWorkflow
        ) &&
        /--version-file "\$REPORT_DIR\/trivy-version\.txt"/u.test(
          supplyChainWorkflow
        ) &&
        /rawFindings == 4/u.test(supplyChainWorkflow) &&
        /compatibilityFindings == 4/u.test(supplyChainWorkflow) &&
        /rawFindings == 4/u.test(supplyChainWorkflow) &&
        /approvedBuildLicenseFindings == 4/u.test(supplyChainWorkflow) &&
        /blockingFindings == 0/u.test(supplyChainWorkflow) &&
        /EXPECTED_SCANNER_VERSION = "0\.72\.0"/u.test(
          trivyIacCompatibilityValidator
        ) &&
        /ruleId: "AWS-0011"/u.test(
          trivyIacCompatibilityValidator
        ) &&
        /ruleId: "AWS-0013"/u.test(
          trivyIacCompatibilityValidator
        ) &&
        /ruleId: "AWS-0132"/u.test(
          trivyIacCompatibilityValidator
        ) &&
        /EXPECTED_TARGET = "aws\/template\.yaml"/u.test(
          trivyIacCompatibilityValidator
        ) &&
        /EXPECTED_BOOTSTRAP_TARGET = "aws\/bootstrap-oidc\.yaml"/u.test(
          trivyIacCompatibilityValidator
        ) &&
        /CloudFrontDefaultCertificate: true/u.test(
          trivyIacCompatibilityValidator
        ) &&
        /mandatoryWebAcl: true/u.test(
          trivyIacCompatibilityValidator
        ) &&
        /dynamicOriginSecret: true/u.test(
          trivyIacCompatibilityValidator
        ) &&
        /accessLogging: true/u.test(
          trivyIacCompatibilityValidator
        ) &&
        /foundationCustomerManagedKey: true/u.test(
          trivyIacCompatibilityValidator
        ) &&
        /keyRotation: true/u.test(trivyIacCompatibilityValidator) &&
        /legacyCloudFrontStandardLogging: true/u.test(
          trivyIacCompatibilityValidator
        ) &&
        /sseS3Aes256: true/u.test(trivyIacCompatibilityValidator) &&
        /customerManagedKeyAbsent: true/u.test(
          trivyIacCompatibilityValidator
        ) &&
        /captured Trivy version must be/u.test(
          trivyIacCompatibilityValidator
        ) &&
        /@csstools\/color-helpers/u.test(trivySbomPolicyValidator) &&
        /lightningcss-linux-x64-musl/u.test(trivySbomPolicyValidator) &&
        /license: "MIT-0"/u.test(trivySbomPolicyValidator) &&
        /license: "MPL-2\.0"/u.test(trivySbomPolicyValidator) &&
        /resolve\/test\/resolver\/invalid_main/u.test(
          trivySbomPolicyValidator
        ) &&
        /"schema_version":\s*1/u.test(supplyChainWaivers) &&
        /"waivers":\s*\[\]/u.test(supplyChainWaivers) &&
        !/audit-first/u.test(supplyChainWorkflow) &&
        supplyChainReleaseJob.length > 0 &&
        /github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/u.test(
          supplyChainReleaseJob
        ) &&
        /schema: "archon\.supply-chain\.release-evidence"/u.test(
          supplyChainReleaseJob
        ) &&
        /sourceSha: \$sourceSha/u.test(supplyChainReleaseJob) &&
        /enforcement:\s*\{[\s\S]*mode:\s*"blocking-zero-unwaived-findings"/u.test(
          supplyChainReleaseJob
        ) &&
        /acceptedWaivers:\s*0/u.test(supplyChainReleaseJob) &&
        /unwaivedFindings:\s*0/u.test(supplyChainReleaseJob) &&
        /"aws\/finops\.yaml"/u.test(supplyChainReleaseJob) &&
        /actions\/attest-build-provenance@0f67c3f4856b2e3261c31976d6725780e5e4c373/u.test(
          supplyChainReleaseJob
        ) &&
        /supply-chain-release-\$\{\{\s*github\.sha\s*\}\}-\$\{\{\s*github\.run_id\s*\}\}-\$\{\{\s*github\.run_attempt\s*\}\}/u.test(
          supplyChainReleaseJob
        ) &&
        /"attest":\s*\{[\s\S]*"version":\s*"v4\.1\.1"[\s\S]*"sha":\s*"0f67c3f4856b2e3261c31976d6725780e5e4c373"/u.test(
          supplyChainToolLock
        ) &&
        /name:\s*Require successful exact-SHA Supply Chain evidence/u.test(
          deploySourceGateJob
        ) &&
        /actions\/workflows\/supply-chain\.yml\/runs\?branch=main&event=push/u.test(
          deploySourceGateJob
        ) &&
        /select\([\s\S]*\.head_sha == \$sha[\s\S]*\.path == "\.github\/workflows\/supply-chain\.yml"/u.test(
          deploySourceGateJob
        ) &&
        /supply_chain_run_id:\s*\$\{\{\s*steps\.supply_chain\.outputs\.run_id\s*\}\}/u.test(
          deploySourceGateJob
        ) &&
        /name:\s*Verify exact-SHA Supply Chain receipt and attestation/u.test(
          deployBuildOnceJob
        ) &&
        /run-id:\s*\$\{\{\s*needs\.source-gate\.outputs\.supply_chain_run_id\s*\}\}/u.test(
          deployBuildOnceJob
        ) &&
        /gh attestation verify "\$receipt"/u.test(deployBuildOnceJob) &&
        /blocking-zero-unwaived-findings/u.test(deployBuildOnceJob) &&
        /waiverLedgerSha256/u.test(deployBuildOnceJob) &&
        /name:\s*Create exact-SHA candidate evidence binding/u.test(
          deployBuildOnceJob
        ) &&
        /schema:\s*"archon\.aws-candidate\.evidence-binding"/u.test(
          deployBuildOnceJob
        ) &&
        /name:\s*Attest immutable candidate tree and evidence binding/u.test(
          deployBuildOnceJob
        ) &&
        /actions\/attest-build-provenance@0f67c3f4856b2e3261c31976d6725780e5e4c373/u.test(
          deployBuildOnceJob
        ) &&
        /subject-path:\s*candidate-evidence-binding\.json/u.test(
          deployBuildOnceJob
        ) &&
        /supply-chain-release-receipt\.json/u.test(
          deployBuildOnceJob
        ) &&
        /name:\s*Verify candidate, Supply Chain, and memory-evaluation provenance/u.test(
          deployStagingJob
        ) &&
        /name:\s*Verify candidate, Supply Chain, and memory-evaluation provenance/u.test(
          deployProductionJob
        ) &&
        /gh attestation verify candidate-evidence-binding\.json/u.test(
          deployStagingJob
        ) &&
        /gh attestation verify supply-chain-release-receipt\.json/u.test(
          deployStagingJob
        ) &&
        /gh attestation verify candidate-evidence-binding\.json/u.test(
          deployProductionJob
        ) &&
        /gh attestation verify supply-chain-release-receipt\.json/u.test(
          deployProductionJob
        ) &&
        /blocking-zero-unwaived-findings/u.test(deployStagingJob) &&
        /blocking-zero-unwaived-findings/u.test(
          deployProductionJob
        ),
      "Hosted CI blocks unwaived ShellCheck, actionlint, zizmor, cfn-lint, SAM, Guard, Trivy IaC/vulnerability/license, and dependency-policy findings; the exact-SHA receipt covers the dormant edge WAF and FinOps templates and is provenance-bound to the promoted candidate.",
      "A blocking supply-chain policy, exact-SHA receipt binding, dormant control-plane scan, provenance attestation, or promotion verification is incomplete."
    ),
    sourceCheck(
      "tech.exact-sha-memory-evaluation-gate",
      "Technical Implementation",
      /name:\s*Memory architecture evaluation/u.test(
        memoryEvaluationWorkflow
      ) &&
        memoryEvaluationJob.length > 0 &&
        /name:\s*Longitudinal, scale, and C-SPANN evidence/u.test(
          memoryEvaluationJob
        ) &&
        /EVALUATION_DIR=%s/u.test(memoryEvaluationJob) &&
        /\$RUNNER_TEMP\/memory-evaluation/u.test(
          memoryEvaluationJob
        ) &&
        /Evaluate B0-B4, lifecycle ablations, and 100k-event rehearsal/u.test(
          memoryEvaluationJob
        ) &&
        /Compare C-SPANN recall with exact cosine ground truth/u.test(
          memoryEvaluationJob
        ) &&
        /Object\.values\(receipt\.gates\)\.some\(\(value\) => value !== true\)/u.test(
          memoryEvaluationJob
        ) &&
        /memory-evaluation-\$\{\{\s*env\.SOURCE_SHA\s*\}\}-\$\{\{\s*github\.run_id\s*\}\}-\$\{\{\s*github\.run_attempt\s*\}\}/u.test(
          memoryEvaluationJob
        ) &&
        /B0_SESSION_ONLY/u.test(memoryEvaluationScript) &&
        /B1_LEXICAL/u.test(memoryEvaluationScript) &&
        /B2_VECTOR_ONLY/u.test(memoryEvaluationScript) &&
        /B3_VECTOR_SCOPE_TIME/u.test(memoryEvaluationScript) &&
        /B4_FULL_LIFECYCLE/u.test(memoryEvaluationScript) &&
        /A_NO_TEMPORAL/u.test(memoryEvaluationScript) &&
        /A_NO_CONTRADICTION/u.test(memoryEvaluationScript) &&
        /A_NO_HUMAN_GATE/u.test(memoryEvaluationScript) &&
        /real-customer-production-corpus/u.test(
          memoryEvaluationScript
        ) &&
        /human-evaluation-results/u.test(memoryEvaluationScript) &&
        /name:\s*Require successful exact-SHA Memory architecture evaluation/u.test(
          deploySourceGateJob
        ) &&
        /actions\/workflows\/memory-evaluation\.yml\/runs\?branch=main&event=push/u.test(
          deploySourceGateJob
        ) &&
        /\.name == "Memory architecture evaluation"/u.test(
          deploySourceGateJob
        ) &&
        /\.name ==\s*\r?\n\s+"Longitudinal, scale, and C-SPANN evidence"/u.test(
          deploySourceGateJob
        ) &&
        /gh run download "\$run_id"/u.test(deploySourceGateJob) &&
        /memory-evaluation-receipt\.json/u.test(
          deploySourceGateJob
        ) &&
        /actual_receipt_digest/u.test(deploySourceGateJob) &&
        /receipt_base64=/u.test(deploySourceGateJob) &&
        /name:\s*Bind exact-SHA Memory architecture evaluation receipt/u.test(
          deployBuildOnceJob
        ) &&
        /memory_evaluation_receipt_base64/u.test(
          deployBuildOnceJob
        ) &&
        /memory-evaluation-receipt\.json/u.test(
          deployBuildOnceJob
        ) &&
        /memoryEvaluation:\s*\{/u.test(deployBuildOnceJob) &&
        /memoryEvaluationReceiptSha256/u.test(
          deployBuildOnceJob
        ) &&
        /memory-evaluation-receipt\.json/u.test(
          deployStagingJob
        ) &&
        /memory-evaluation-receipt\.json/u.test(
          deployProductionJob
        ) &&
        /candidate-evidence-binding\.json/u.test(
          deployStagingJob
        ) &&
        /candidate-evidence-binding\.json/u.test(
          deployProductionJob
        ),
      "The release waits for the exact main-SHA longitudinal/scale/C-SPANN job, verifies its sealed receipt and artifacts, and binds the evaluation digest into the attested candidate promoted unchanged.",
      "The exact-SHA memory-evaluation run, job context, sealed receipt, or candidate evidence binding is incomplete."
    ),
    sourceCheck(
      "product.well-architected-evidence-contract",
      "Production Readiness",
      /name:\s*AWS Well-Architected Evidence Audit/u.test(
        wellArchitectedWorkflow
      ) &&
        wellArchitectedRepositoryJob.length > 0 &&
        /name:\s*Validate repository evidence contract/u.test(
          wellArchitectedRepositoryJob
        ) &&
        !/id-token:\s*write/u.test(wellArchitectedRepositoryJob) &&
        !/configure-aws-credentials/u.test(
          wellArchitectedRepositoryJob
        ) &&
        /archon\.aws-well-architected\.repository-audit/u.test(
          wellArchitectedRepositoryJob
        ) &&
        /if-no-files-found:\s*error/u.test(
          wellArchitectedRepositoryJob
        ) &&
        wellArchitectedLiveJob.length > 0 &&
        /github\.event_name == 'workflow_dispatch' &&\s*\r?\n\s*inputs\.mode == 'live-read-only'/u.test(
          wellArchitectedLiveJob
        ) &&
        /environment:\s*\r?\n\s+name:\s*production-audit/u.test(
          wellArchitectedLiveJob
        ) &&
        /LIVE_ACTIVATION_APPROVED/u.test(wellArchitectedLiveJob) &&
        /test "\$AWS_REGION" = "eu-west-1"/u.test(
          wellArchitectedLiveJob
        ) &&
        /test "\$FORBIDDEN_REGION" = "us-west-2"/u.test(
          wellArchitectedLiveJob
        ) &&
        /resourcegroupstaggingapi get-resources/u.test(
          wellArchitectedLiveJob
        ) &&
        /forbidden_count" -eq 0/u.test(wellArchitectedLiveJob) &&
        /RUNNER_TEMP is required; this audit is CI-only/u.test(
          wellArchitectedContractAudit
        ) &&
        /edge-waf-control-plane-boundary/u.test(
          wellArchitectedContractAudit
        ) &&
        /wa04-edge-protection-control-plane-source/u.test(
          wellArchitectedContractAudit
        ) &&
        /wa06-fault-injected-recovery-source/u.test(
          wellArchitectedContractAudit
        ) &&
        /AWS::WAFv2::WebACL/u.test(wellArchitectedContractAudit) &&
        /finops-control-plane-boundary/u.test(
          wellArchitectedContractAudit
        ) &&
        /wa07-managed-backup-restore-source/u.test(
          wellArchitectedContractAudit
        ) &&
        /wa08-hosted-performance-evidence-source/u.test(
          wellArchitectedContractAudit
        ) &&
        /wa09-finops-controls-source/u.test(
          wellArchitectedContractAudit
        ) &&
        /AWS::Budgets::Budget/u.test(wellArchitectedContractAudit) &&
        /AWS::CE::AnomalyMonitor/u.test(
          wellArchitectedContractAudit
        ) &&
        /AWS::CE::AnomalySubscription/u.test(
          wellArchitectedContractAudit
        ) &&
        /explicit-live-activation-required/u.test(
          wellArchitectedContractAudit
        ) &&
        /not an application workload region/u.test(
          wellArchitectedContractAudit
        ) &&
        (
          wellArchitectedWorkflow.match(
            /- "aws\/finops\.yaml"/gu
          ) ?? []
        ).length === 2 &&
        (
          wellArchitectedWorkflow.match(
            /- "\.github\/workflows\/edge-controls\.yml"/gu
          ) ?? []
        ).length === 2 &&
        (
          wellArchitectedWorkflow.match(
            /- "tests\/staging-recovery-drill\.test\.ts"/gu
          ) ?? []
        ).length === 2 &&
        (
          wellArchitectedWorkflow.match(
            /- "aws\/fetch-codedeploy-appspec-revision\.sh"/gu
          ) ?? []
        ).length === 2 &&
        (
          wellArchitectedWorkflow.match(
            /- "aws\/select-staging-codedeploy-rollback\.mjs"/gu
          ) ?? []
        ).length === 2 &&
        !/cloudformation deploy[\s\S]*?--template-file aws\/(?:edge-waf|finops)\.yaml/u.test(
          deploy
        ) &&
        /"primaryRegion":\s*"eu-west-1"/u.test(
          wellArchitectedContract
        ) &&
        /"explicitlyForbiddenRegions":\s*\[\s*"us-west-2"\s*\]/u.test(
          wellArchitectedContract
        ) &&
        /"defaultMode":\s*"repository"/u.test(
          wellArchitectedContract
        ) &&
        /"liveAuditMode":\s*"live-read-only"/u.test(
          wellArchitectedContract
        ) &&
        /"awsMutationPermitted":\s*false/u.test(
          wellArchitectedContract
        ) &&
        /"provisioningPermitted":\s*false/u.test(
          wellArchitectedContract
        ) &&
        /"state":\s*"repository-prepared-live-restore-required"/u.test(
          wellArchitectedContract
        ) &&
        /"state":\s*"repository-prepared-hosted-measurement-required"/u.test(
          wellArchitectedContract
        ) &&
        /"state":\s*"repository-prepared-live-drill-required"/u.test(
          wellArchitectedContract
        ) &&
        /"status":\s*"pending-human-assignment"/u.test(
          wellArchitectedContract
        ) &&
        /"status":\s*"pending-human-decision"/u.test(
          wellArchitectedContract
        ),
      "The default Well-Architected audit is credential-free and repository-only; optional live eu-west-1 inventory is explicit, read-only, owner/objective gated, and proves no tagged workload in us-west-2 while protected WAF and FinOps activation remain human-gated and live-unrun.",
      "The Well-Architected evidence contract, honest human-decision gates, region boundary, or non-mutating activation model is incomplete."
    ),
    sourceCheck(
      "product.aws-account-security-baseline-audit",
      "Production Readiness",
      /name:\s*AWS Account Security Baseline Audit/u.test(
        awsSecurityBaselineWorkflow
      ) &&
        /^\s{2}workflow_dispatch:/mu.test(
          awsSecurityBaselineWorkflow
        ) &&
        /environment:\s*security-audit/u.test(
          awsSecurityBaselineWorkflow
        ) &&
        /AWS_SECURITY_AUDIT_ROLE_ARN:\s*\$\{\{ vars\.AWS_SECURITY_AUDIT_ROLE_ARN \}\}/u.test(
          awsSecurityBaselineWorkflow
        ) &&
        /prove_workflow ci\.yml CI/u.test(
          awsSecurityBaselineWorkflow
        ) &&
        /prove_workflow codeql\.yml CodeQL/u.test(
          awsSecurityBaselineWorkflow
        ) &&
        /supply-chain\.yml "Supply Chain \(enforced\)"/u.test(
          awsSecurityBaselineWorkflow
        ) &&
        /allowed-account-ids:\s*\$\{\{ env\.AWS_ACCOUNT_ID \}\}/u.test(
          awsSecurityBaselineWorkflow
        ) &&
        /path:\s*\$\{\{ runner\.temp \}\}\/aws-account-security-baseline-receipt\.json/u.test(
          awsSecurityBaselineWorkflow
        ) &&
        /s3control get-public-access-block/u.test(
          awsSecurityBaselineScript
        ) &&
        /iam get-account-summary/u.test(awsSecurityBaselineScript) &&
        /cloudtrail describe-trails/u.test(
          awsSecurityBaselineScript
        ) &&
        /guardduty list-detectors/u.test(
          awsSecurityBaselineScript
        ) &&
        /securityhub get-enabled-standards/u.test(
          awsSecurityBaselineScript
        ) &&
        /configservice describe-configuration-recorders/u.test(
          awsSecurityBaselineScript
        ) &&
        /accessanalyzer list-analyzers/u.test(
          awsSecurityBaselineScript
        ) &&
        /ec2 get-ebs-encryption-by-default/u.test(
          awsSecurityBaselineScript
        ) &&
        /"s3:GetAccountPublicAccessBlock"/u.test(
          awsSecurityBaselinePolicy
        ) &&
        /"securityhub:GetEnabledStandards"/u.test(
          awsSecurityBaselinePolicy
        ) &&
        /"aws:RequestedRegion": "eu-west-1"/u.test(
          awsSecurityBaselinePolicy
        ) &&
        !/"(?:Create|Put|Update|Delete|Enable|Disable|Start|Stop|Attach|Detach)[A-Za-z]*"/u.test(
          awsSecurityBaselinePolicy
        ) &&
        /"state": "repository-prepared-live-audit-required"/u.test(
          wellArchitectedContract
        ) &&
        /"protectedEnvironment": "security-audit"/u.test(
          wellArchitectedContract
        ) &&
        /"id": "account-security-baseline-audit"/u.test(
          wellArchitectedContract
        ) &&
        /"mutationPermitted": false/u.test(
          wellArchitectedContract
        ) &&
        /wa03-account-security-baseline-source/u.test(
          wellArchitectedContractAudit
        ) &&
        /Status: repository-prepared/u.test(
          awsSecurityBaselineRunbook
        ) &&
        /does not enable or remediate/u.test(
          awsSecurityBaselineRunbook
        ),
      "WA-03 has a protected exact-green-main read-only account audit, an exact least-privilege reference policy, sanitized receipt boundary, and honest live-activation runbook.",
      "The protected WA-03 source, least-privilege policy, exact-SHA gate, sanitized receipt, or activation boundary is incomplete."
    ),
    sourceCheck(
      "product.sustainability-intensity-evidence",
      "Production Readiness",
      /name:\s*Sustainability Intensity Evidence/u.test(
        sustainabilityIntensityWorkflow
      ) &&
        /^\s{2}workflow_dispatch:/mu.test(
          sustainabilityIntensityWorkflow
        ) &&
        /environment:\s*sustainability-audit/u.test(
          sustainabilityIntensityWorkflow
        ) &&
        /AWS_SUSTAINABILITY_AUDIT_ROLE_ARN:\s*\$\{\{ vars\.AWS_SUSTAINABILITY_AUDIT_ROLE_ARN \}\}/u.test(
          sustainabilityIntensityWorkflow
        ) &&
        /prove_workflow ci\.yml CI/u.test(
          sustainabilityIntensityWorkflow
        ) &&
        /prove_workflow codeql\.yml CodeQL/u.test(
          sustainabilityIntensityWorkflow
        ) &&
        /Hosted Load Evidence/u.test(
          sustainabilityIntensityWorkflow
        ) &&
        /comparison_mode == 'compare'/u.test(
          sustainabilityIntensityWorkflow
        ) &&
        /path:\s*\$\{\{ runner\.temp \}\}\/sustainability-intensity-receipt\.json/u.test(
          sustainabilityIntensityWorkflow
        ) &&
        /cloudformation describe-stacks/u.test(
          sustainabilityIntensityScript
        ) &&
        /cloudwatch get-metric-data/u.test(
          sustainabilityIntensityScript
        ) &&
        /logs describe-log-groups/u.test(
          sustainabilityIntensityScript
        ) &&
        /configuredMemoryGbSecondsPerSuccessfulRecall/u.test(
          sustainabilityIntensityScript
        ) &&
        /dataProcessedBytesPerSuccessfulRecall/u.test(
          sustainabilityIntensityScript
        ) &&
        /transferBytesPerSuccessfulRecall/u.test(
          sustainabilityIntensityScript
        ) &&
        /rawResponsesUploaded:\s*false/u.test(
          sustainabilityIntensityScript
        ) &&
        /emissionsMeasured:\s*false/u.test(
          sustainabilityIntensityScript
        ) &&
        /"cloudwatch:GetMetricData"/u.test(
          sustainabilityIntensityPolicy
        ) &&
        /"logs:DescribeLogGroups"/u.test(
          sustainabilityIntensityPolicy
        ) &&
        !/"(?:Create|Put|Update|Delete|Enable|Disable|Start|Stop|Invoke)[A-Za-z]*"/u.test(
          sustainabilityIntensityPolicy
        ) &&
        /wa10-sustainability-intensity-source/u.test(
          wellArchitectedContractAudit
        ) &&
        /"state": "repository-prepared-live-measurement-required"/u.test(
          wellArchitectedContract
        ) &&
        /"id": "sustainability-intensity-measurement"/u.test(
          wellArchitectedContract
        ) &&
        /Status: repository-prepared/u.test(
          sustainabilityIntensityRunbook
        ) &&
        /no live baseline or improvement receipt is[\s\S]*?claimed/iu.test(
          sustainabilityIntensityRunbook
        ),
      "WA-10 has a protected exact-green-main read-only engineering-intensity pipeline, exact hosted-recall denominator, equivalent baseline/after contract, sanitized digests, and explicit non-emissions boundary.",
      "The WA-10 protected measurement source, least-privilege role contract, exact denominator, equivalent comparison, or honest claim boundary is incomplete."
    ),
    sourceCheck(
      "product.database-credential-rotation",
      "Production Readiness",
      /name:\s*Rotate CockroachDB Runtime Credential/u.test(
        databaseCredentialRotationWorkflow
      ) &&
        /^\s{2}workflow_dispatch:/mu.test(
          databaseCredentialRotationWorkflow
        ) &&
        /environment:\s*production-db/u.test(
          databaseCredentialRotationWorkflow
        ) &&
        /prove_workflow ci\.yml CI/u.test(
          databaseCredentialRotationWorkflow
        ) &&
        /prove_workflow codeql\.yml CodeQL/u.test(
          databaseCredentialRotationWorkflow
        ) &&
        /database-\?{6}/u.test(databaseCredentialRotationWorkflow) &&
        /cockroach-admin-\?{6}/u.test(
          databaseCredentialRotationWorkflow
        ) &&
        !/(?:database|cockroach-admin)-\*/u.test(
          databaseCredentialRotationWorkflow
        ) &&
        /ROTATION_INTERRUPTED_STATE_UNKNOWN/u.test(
          databaseCredentialRotationWorkflow
        ) &&
        /Attest the sanitized exact-SHA rotation receipt\s+if: always\(\)/u.test(
          databaseCredentialRotationWorkflow
        ) &&
        /export async function recoverFailedRotation/u.test(
          databaseCredentialRotationScript
        ) &&
        /new ListSecretVersionIdsCommand/u.test(
          databaseCredentialRotationScript
        ) &&
        /RuntimeCredentialRotationFailure/u.test(
          databaseCredentialRotationScript
        ) &&
        /expectedDatabaseGrants: expectedRuntimeDatabaseGrants\(\s*databaseName,\s*principal\s*\)/u.test(
          databaseCredentialRotationScript
        ) &&
        /expectedDatabaseGrants: expectedRuntimeDatabaseGrants\(\s*databaseRaw,\s*appUserRaw\s*\)/u.test(
          databaseCredentialProvisioningScript
        ) &&
        /process\.stdout\.write\(`\$\{JSON\.stringify\(receipt/u.test(
          databaseCredentialRotationScript
        ) &&
        /lost Put response reconciles/u.test(
          databaseCredentialRotationTests
        ) &&
        /lost Update response requires exact current observation/u.test(
          databaseCredentialRotationTests
        ) &&
        /stale cutover reads fail closed/u.test(
          databaseCredentialRotationTests
        ) &&
        /partial Cockroach DDL is reconciled/u.test(
          databaseCredentialRotationTests
        ) &&
        /injected rollback and cleanup failures/u.test(
          databaseCredentialRotationTests
        ) &&
        /createCredentialPoolController/u.test(databaseClient) &&
        /resolveDatabaseCredential/u.test(databaseClient) &&
        /concurrent fake-pg refresh coalesces/u.test(
          databaseClientRotationTests
        ) &&
        /failed fake-pg candidate never replaces/u.test(
          databaseClientRotationTests
        ) &&
        /COCKROACH_SQL_DNS:\s*!Ref CockroachSqlDns/u.test(
          lambdaTemplate
        ) &&
        /wa05-database-credential-rotation-source/u.test(
          wellArchitectedContractAudit
        ),
      "WA-05 has protected exact-release two-principal rotation, a cluster-wide exact runtime database-grant matrix at provisioning and rotation, exact secret ARN suffixes, hot pool refresh, injected failure-state tests, phase-specific attested receipts, and fail-closed interrupted-run evidence.",
      "The WA-05 protected rotation, exact IAM boundary, behavioral failure tests, hot refresh, or actionable failure receipt contract is incomplete."
    ),
    sourceCheck(
      "product.lifecycle-fixed-cost-ceiling",
      "Production Readiness",
      incrementalFixedCostEvaluation.valid,
      "The incremental foundation + two edge stacks fixed-cost contract independently recomputes $22.40/$23.40/$24.40 across the initial and two billed KMS-rotation scenarios, with a $24.40 maximum strictly below the $26.00 ceiling.",
      "The itemized lifecycle fixed-cost contract, official pricing sources, exclusions, scenario arithmetic, or strict sub-$26.00 ceiling is invalid."
    ),
    sourceCheck(
      "product.protected-foundation-and-edge-delivery",
      "Production Readiness",
      incrementalFixedCostEvaluation.valid &&
        foundationLifecycleOperationsValid &&
        /name:\s*Foundation Storage Migration/u.test(
          foundationMigrationWorkflow
        ) &&
        /- retire/u.test(foundationMigrationWorkflow) &&
        /environment:\s*bootstrap/u.test(
          foundationMigrationWorkflow
        ) &&
        /foundation-migration-authority\.sh verify/u.test(
          foundationMigrationWorkflow
        ) &&
        /foundation-storage-migration-policy\.json/u.test(
          foundationMigrationWorkflow
        ) &&
        /bootstrap-stack-policy\.pre-storage-migration\.json/u.test(
          foundationMigrationWorkflow
        ) &&
        /bootstrap-stack-policy\.json/u.test(
          foundationMigrationWorkflow
        ) &&
        /recoveryAnchor/u.test(foundationMigrationWorkflow) &&
        /prove-foundation-storage-controls\.sh/u.test(
          foundationMigrationWorkflow
        ) &&
        /RETIRE-FOUNDATION-MIGRATION-AUTHORITY/u.test(
          foundationMigrationWorkflow
        ) &&
        /"replacementPolicy":\s*"forbidden"/u.test(
          foundationStorageMigrationPolicy
        ) &&
        /"FinOpsCloudFormationExecutionRole"/u.test(
          foundationStorageMigrationPolicy
        ) &&
        /"FinOpsControlRole"/u.test(
          foundationStorageMigrationPolicy
        ) &&
        /render-trust\|render-policy\|render-template\|render-template-sha256\|verify\|verify-intrinsic/u.test(
          foundationMigrationAuthority
        ) &&
        /migrationAuthorityRetired/u.test(foundationStorageProof) &&
        /arnSha256/u.test(foundationStorageProof) &&
        /roleSeparation:\s*true/u.test(foundationStorageProof) &&
        /LogicalResourceId\/ApplicationStorageKey/u.test(
          bootstrapStackPolicy
        ) &&
        /LogicalResourceId\/FinOpsControlRole/u.test(
          bootstrapStackPolicy
        ) &&
        edgeLifecycleOperationsValid &&
        /name:\s*Manage AWS Edge Controls/u.test(
          edgeControlsWorkflow
        ) &&
        /environment:\s*\$\{\{ inputs\.operation == 'cleanup' && 'edge-cleanup' \|\| 'edge-controls' \}\}/u.test(
          edgeControlsWorkflow
        ) &&
        /set-stack-policy/u.test(edgeControlsWorkflow) &&
        /update-termination-protection/u.test(edgeControlsWorkflow) &&
        /Prove exact deployed WAF controls/u.test(edgeControlsWorkflow) &&
        /LogicalResourceId\/ArchonCloudFrontWebAcl/u.test(
          edgeStackPolicy
        ) &&
        /DeletionPolicy:\s*RetainExceptOnCreate/u.test(edgeTemplate) &&
        /CloudFrontWebAclArn:[\s\S]*?AllowedPattern:[\s\S]*?Rules:/u.test(
          lambdaTemplate
        ) &&
        !/CloudFrontWebAclArn:[\s\S]*?Default:\s*""[\s\S]*?Rules:/u.test(
          lambdaTemplate
        ) &&
        /WebACLId:\s*!Ref CloudFrontWebAclArn/u.test(lambdaTemplate) &&
        /\{\{resolve:secretsmanager:\$\{AppName\}\/\$\{Environment\}\/origin-verification:SecretString:ORIGIN_VERIFY_TOKEN\}\}/u.test(
          lambdaTemplate
        ) &&
        /environment !== "staging" && environment !== "production"/u.test(
          lambdaRuntime
        ) &&
        /deployed environments reject missing, blank, or malformed origin capability/u.test(
          lambdaRuntimeTests
        ) &&
        /Require exact-SHA foundation and edge-control receipts/u.test(
          deploy
        ) &&
        /Resolve the exact staging edge-stack handoff/u.test(deploy) &&
        /Resolve the exact production edge-stack handoff/u.test(deploy) &&
        !/CLOUDFRONT_WEB_ACL_ARN:\s*\$\{\{\s*vars\./u.test(deploy),
      "The exact-SHA foundation migration has source-bound Phase 0 creation, same-run failed-plan cleanup, bounded no-foundation-mutation abort and authority retirement; edge delivery adds mandatory five-rule WAF association, recoverable-shell cleanup, restart-safe finalization, direct handoff, sanitized live proofs, and the recomputed lifecycle cost ceiling.",
      "The source-bound foundation Phase 0/abort lifecycle, protected migration, mandatory five-rule WAF handoff, bounded edge cleanup/finalize lifecycle, role/stack protection, recomputed lifecycle cost ceiling, or sanitized live-proof contract is incomplete."
    ),
    sourceCheck(
      "product.separated-finops-control-plane",
      "Production Readiness",
      /name:\s*Manage AWS FinOps Controls/u.test(
        finOpsControlsWorkflow
      ) &&
        /environment:\s*finops-controls/u.test(finOpsControlsWorkflow) &&
        /AWS_FINOPS_CLOUDFORMATION_EXECUTION_ROLE_ARN/u.test(
          finOpsControlsWorkflow
        ) &&
        /--role-arn "\$AWS_FINOPS_CLOUDFORMATION_EXECUTION_ROLE_ARN"/u.test(
          finOpsControlsWorkflow
        ) &&
        !/\$\{\{\s*vars\.AWS_FINOPS_/u.test(finOpsControlsWorkflow) &&
        /rawAwsIdentifiersStored:\s*false/u.test(
          finOpsControlsWorkflow
        ) &&
        /routingTest:[\s\S]*?published/u.test(finOpsControlsWorkflow) &&
        /AWS::Budgets::Budget/u.test(finOpsTemplate) &&
        /AWS::CE::AnomalyMonitor/u.test(finOpsTemplate) &&
        /AWS::CE::AnomalySubscription/u.test(finOpsTemplate) &&
        finOpsCloudFormationExecutionRole.length > 0 &&
        hasExactTrimmedLine(
          finOpsCloudFormationExecutionRole,
          'RoleName: !Sub "${AppName}-finops-cloudformation-execution"'
        ) &&
        hasExactTrimmedLine(
          finOpsCloudFormationExecutionRole,
          "Principal:"
        ) &&
        hasExactTrimmedLine(
          finOpsCloudFormationExecutionRole,
          "Service: cloudformation.amazonaws.com"
        ) &&
        /FinOpsControlRole:/u.test(deliveryBootstrap) &&
        /RoleName:\s*!Sub "\$\{AppName\}-github-finops-controls"/u.test(
          deliveryBootstrap
        ) &&
        /environment:finops-controls/u.test(deliveryBootstrap) &&
        /workflow:\s*Manage AWS FinOps Controls/u.test(
          deliveryBootstrap
        ) &&
        /PassOnlyFinOpsCloudFormationExecutionRole/u.test(
          deliveryBootstrap
        ) &&
        /PublishOnlyThroughAccountBoundEncryptedSns/u.test(
          deliveryBootstrap
        ) &&
        /controllerRoleArnSha256/u.test(foundationStorageProof) &&
        /executionRoleArnSha256/u.test(foundationStorageProof),
      "FinOps uses deterministic repository-bound OIDC control, a separate CloudFormation execution role, exact billing resources, encrypted human routing, digest-only receipts, and no workload permissions.",
      "The FinOps workflow, deterministic role separation, exact CloudFormation role handoff, encrypted route proof, or sanitized receipt is incomplete."
    ),
    sourceCheck(
      "tech.release-dependency-governance",
      "Technical Implementation",
      hasExactCodeqlActionPins(codeqlWorkflow) &&
        /queries:\s*security-and-quality/u.test(codeqlWorkflow) &&
        /output:\s*\$\{\{\s*env\.CODEQL_RAW_SARIF_DIR\s*\}\}/u.test(
          codeqlWorkflow
        ) &&
        /post-processed-sarif-path:\s*\$\{\{\s*env\.CODEQL_SARIF_DIR\s*\}\}/u.test(
          codeqlWorkflow
        ) &&
        /upload:\s*always/u.test(codeqlWorkflow) &&
        /name:\s*Enforce the CodeQL high-severity policy/u.test(
          codeqlWorkflow
        ) &&
        /properties\?\.\["security-severity"\]/u.test(codeqlWorkflow) &&
        /securitySeverity >= 7 \|\| rawLevel === "error"/u.test(
          codeqlWorkflow
        ) &&
        /blockingFindings\.length > 0/u.test(codeqlWorkflow) &&
        /policy:\s*"codeql-high-critical-or-error"/u.test(
          codeqlWorkflow
        ) &&
        /acceptedWaivers:\s*0/u.test(codeqlWorkflow) &&
        /"waivers":\s*\[\]/u.test(supplyChainWaivers) &&
        /name:\s*Prove CodeQL succeeded for the exact release SHA/u.test(
          deployBuildOnceJob
        ) &&
        /actions\/workflows\/codeql\.yml\/runs\?branch=main&event=push/u.test(
          deployBuildOnceJob
        ) &&
        hasExactDependabotReleaseFreeze(dependabotConfig) &&
        has("docs/DEPENDENCY_RELEASE_POLICY.md") &&
        contains(
          "docs/DEPENDENCY_RELEASE_POLICY.md",
          /security updates remain enabled/iu
        ),
      "Release dependencies remain governable, all CodeQL phases share one immutable version, in-threshold security findings block with zero waivers, and Deploy AWS requires that exact-SHA CodeQL success.",
      "The dependency policy, atomic CodeQL pin, blocking finding policy, empty waiver boundary, or exact-SHA deploy gate is incomplete."
    ),
    sourceCheck(
      "tech.exact-ci-trigger",
      "Technical Implementation",
      hasExactCiTrigger(ci) &&
        hasUniqueCiTriggerOwnership(workflowEntries),
      "The CI workflow runs once for main pushes and every pull request, supports an explicit manual audit retry, and retains exact trigger ownership across scheduled evidence workflows.",
      "CI/evidence triggers are duplicated, mutable, omit main or pull requests, or lack the exact manual/scheduled audit contracts."
    ),
    sourceCheck(
      "tech.bedrock-grounding",
      "Technical Implementation",
      /checks:\s*\{[\s\S]*claims:\s*boolean/iu.test(narrator) &&
        /validateCompleteGroundedAnswer/iu.test(narrator) &&
        /answer did not cite the complete bounded evidence set/iu.test(
          narrator
        ) &&
        /RECALL_MIN_SCORE/iu.test(handler) &&
        /citation/iu.test(narrator),
      "Bedrock narration is guarded by relevance abstention, complete bounded evidence citation, per-claim numeric/claim checks, and deterministic extraction fallback.",
      "Grounding or relevance-abstention controls are incomplete."
    ),
    sourceCheck(
      "tech.runtime-cspann-release-gate",
      "Technical Implementation",
      /export\s+function\s+buildRecallQuery/iu.test(memory) &&
        /buildRecallQuery/iu.test(databaseRelease) &&
        /assertCockroachEndpointBinding/iu.test(databaseRelease) &&
        /assertCockroachEndpointBinding/iu.test(databaseEndpointVerifier) &&
        /ROUTING_OVERRIDE_PARAMETERS/iu.test(databaseSecretContract) &&
        /hostaddr/iu.test(databaseSecretContract) &&
        /options/iu.test(databaseSecretContract) &&
        /COCKROACH_SQL_DNS/iu.test(databaseReleaseWorkflow) &&
        /regions\[\]/iu.test(databaseReleaseWorkflow) &&
        /sql_dns/iu.test(databaseReleaseWorkflow) &&
        databaseReleaseWorkflow.indexOf("db:endpoint:verify") <
          databaseReleaseWorkflow.indexOf("npm run db:schema") &&
        /\.cockroachCloud\.sqlEndpointBinding\.boundUrlCount\s*==\s*3/u.test(
          databaseReleaseWorkflow
        ) &&
        /verifyRuntimeCspannPath/iu.test(databaseRelease) &&
        /EXPLAIN\s+\$\{statement\.text\}/u.test(databaseRelease) &&
        /safeRuntimeQuery<RecallQueryRow>\(\s*client,\s*statement\.text,\s*statement\.params/iu.test(
          databaseRelease
        ) &&
        /schemaVersion:\s*6/u.test(databaseRelease) &&
        /scopedServingQueriesRejectCanaries:\s*true/u.test(
          databaseRelease
        ) &&
        /\.schemaVersion\s*==\s*6/u.test(databaseReleaseWorkflow) &&
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
      "CI binds admin/staging/production URLs to the authenticated primary eu-west-1 Cockroach Cloud sql_dns before mutation, then executes the exact application query as both runtime principals and rejects three-axis canaries through both fixed-scope C-SPANN views.",
      "The database release does not enforce endpoint-to-cluster identity plus exact runtime-principal C-SPANN planning, execution, and serving-view isolation."
    ),
    sourceCheck(
      "tech.runtime-resolution-release-gate",
      "Technical Implementation",
      runtimeResolutionVerifier.length > 0 &&
        resolutionSandboxVerifier.length > 0 &&
        /CockroachResolutionStore/u.test(runtimeResolutionVerifier) &&
        /handleCreateResolutionSession/u.test(runtimeResolutionVerifier) &&
        /handleResolutionDecision/u.test(runtimeResolutionVerifier) &&
        /handleGetResolutionSession/u.test(runtimeResolutionVerifier) &&
        /decision:\s*"approve"\s*\|\s*"reject"/u.test(
          runtimeResolutionVerifier
        ) &&
        /conflict\.status\s*!==\s*409/u.test(runtimeResolutionVerifier) &&
        /replayReceipt\.digest\s*!==\s*receipt\.digest/u.test(
          runtimeResolutionVerifier
        ) &&
        /canonicalMemoryUnchanged:\s*true/u.test(
          runtimeResolutionVerifier
        ) &&
        /SHOW SYSTEM GRANTS FOR archon_resolution_writer/u.test(
          databaseRelease
        ) &&
        /verifyExactResolutionRelationGrants/u.test(databaseRelease) &&
        /verifyResolutionTransitionFunctions/u.test(databaseRelease) &&
        /SHOW GRANTS ON FUNCTION \$\{routine\.signature\}/u.test(
          databaseRelease
        ) &&
        /verifyClusterWideResolutionGrants/u.test(databaseRelease) &&
        /const proofClient = new Client\(\{/u.test(clusterGrantProof) &&
        !/SET database = ''/u.test(clusterGrantProof) &&
        /const databaseNames = await enumerateDatabases\(proofClient\)/u.test(
          clusterGrantProof
        ) &&
        /for \(const databaseName of databaseNames\)/u.test(
          clusterGrantProof
        ) &&
        /SET DATABASE = \$\{databaseSql\}/u.test(clusterGrantProof) &&
        /SELECT current_database\(\) AS database_name/u.test(
          clusterGrantProof
        ) &&
        /selectedDatabase\.rows\[0\]\?\.database_name !== databaseName/u.test(
          clusterGrantProof
        ) &&
        /SHOW GRANTS FOR \$\{principalSql\}[\s\S]*?scopedGrants\.rows\.filter\([\s\S]*?grant\.object_type === "routine"[\s\S]*?routineGrants\.push/u.test(
          clusterGrantProof
        ) &&
        /archon_resolution_create_session\(text, uuid, uuid, uuid, uuid, timestamptz, int8\)/u.test(
          clusterGrantProof
        ) &&
        /archon_resolution_decide\(text, text, uuid, uuid, uuid, timestamptz\)/u.test(
          clusterGrantProof
        ) &&
        /COCKROACH_BUILTIN_PUBLIC_DATABASE_GRANTS[\s\S]*?databaseName: "defaultdb"[\s\S]*?privilegeType: "CONNECT"[\s\S]*?databaseName: "defaultdb"[\s\S]*?privilegeType: "TEMPORARY"[\s\S]*?databaseName: "postgres"[\s\S]*?privilegeType: "CONNECT"[\s\S]*?databaseName: "postgres"[\s\S]*?privilegeType: "TEMPORARY"/u.test(
          clusterGrantProof
        ) &&
        /\}>\("SHOW DATABASES"\)[\s\S]*?\.map\(\(row\) => row\.database_name\)[\s\S]*?\.sort\(\)/u.test(
          clusterGrantProof
        ) &&
        !/FROM \[SHOW (?:GRANTS|DATABASES)/u.test(clusterGrantProof) &&
        /SHOW GRANTS ON DATABASE \$\{databaseSql\} FOR \$\{principalSql\}/u.test(
          clusterGrantProof
        ) &&
        /JSON\.stringify\(finalDatabaseInventory\)[\s\S]*?JSON\.stringify\(databaseNames\)/u.test(
          clusterGrantProof
        ) &&
        /JSON\.stringify\(actualDatabaseInventory\)[\s\S]*?JSON\.stringify\(requiredDatabaseInventory\)/u.test(
          clusterGrantProof
        ) &&
        /databaseMatrixSha256: createHash\("sha256"\)/u.test(
          clusterGrantProof
        ) &&
        /Supplied runtime database privilege matrix is not canonical/u.test(
          clusterGrantProof
        ) &&
        /GRANT CONNECT ON DATABASE "\$\{databaseName\}" TO archon_migration_ci/u.test(
          schemaMigrationRehearsal
        ) &&
        /expectedDatabaseGrants: expectedRuntimeDatabaseGrants\(\s*databaseName,\s*"archon_migration_ci"\s*\)/u.test(
          schemaMigrationRehearsal
        ) &&
        /GRANT TEMPORARY ON DATABASE "\$\{databaseName\}" TO archon_migration_ci[\s\S]*?expectClusterGrantProofRejected[\s\S]*?REVOKE TEMPORARY ON DATABASE "\$\{databaseName\}" FROM archon_migration_ci/u.test(
          schemaMigrationRehearsal
        ) &&
        /GRANT CONNECT ON DATABASE "\$\{databaseName\}" TO archon_migration_ci WITH GRANT OPTION[\s\S]*?expectClusterGrantProofRejected[\s\S]*?REVOKE CONNECT ON DATABASE "\$\{databaseName\}" FROM archon_migration_ci[\s\S]*?GRANT CONNECT ON DATABASE "\$\{databaseName\}" TO archon_migration_ci/u.test(
          schemaMigrationRehearsal
        ) &&
        /CREATE DATABASE archon_unexpected_grants_ci[\s\S]*?REVOKE CONNECT, TEMPORARY ON DATABASE archon_unexpected_grants_ci FROM public[\s\S]*?expectClusterGrantProofRejected[\s\S]*?Cluster-wide grant proof could not bind the exact database inventory\.[\s\S]*?DROP DATABASE archon_unexpected_grants_ci CASCADE/u.test(
          schemaMigrationRehearsal
        ) &&
        [
          "ADMIN",
          "BYPASSRLS",
          "CANCELQUERY",
          "CONTROLCHANGEFEED",
          "CONTROLJOB",
          "CREATEDB",
          "CREATELOGIN",
          "CREATEROLE",
          "MODIFYCLUSTERSETTING",
          "PROVISIONSRC",
          "REPLICATION",
          "SUBJECT",
          "VIEWACTIVITY",
          "VIEWACTIVITYREDACTED",
          "VIEWCLUSTERSETTING",
        ].every((option) => systemGrantContract.includes(`"${option}"`)) &&
        /export function privilegedRuntimeRoleOptions/u.test(
          systemGrantContract
        ) &&
        /export function runtimeLoginIsDisabled/u.test(systemGrantContract) &&
        /export function runtimeRoleOptionsAreCanonical/u.test(
          systemGrantContract
        ) &&
        [
          databaseRelease,
          databaseCredentialRotationScript,
          databaseCredentialProvisioningScript,
        ].every(
          (runtimeGate) =>
            /privilegedRuntimeRoleOptions/u.test(runtimeGate) &&
            /runtimeLoginIsDisabled/u.test(runtimeGate) &&
            /runtimeRoleOptionsAreCanonical/u.test(runtimeGate) &&
            /affirmativeSystemGrants/u.test(runtimeGate)
        ) &&
        /SHOW SYSTEM GRANTS FOR \$\{appUser\}/u.test(
          databaseCredentialProvisioningScript
        ) &&
        /proof\.databaseGrantCount !== 5/u.test(schemaMigrationRehearsal) &&
        /appTemporaryGrantDriftRejected:\s*true/u.test(
          schemaMigrationRehearsal
        ) &&
        /databaseGrantOptionDriftRejected:\s*true/u.test(
          schemaMigrationRehearsal
        ) &&
        /extraDatabaseGrantDriftRejected:\s*true/u.test(
          schemaMigrationRehearsal
        ) &&
        /expectedDatabaseGrants: expectedRuntimeDatabaseGrants\(\s*databaseName,\s*principal\s*\)/u.test(
          databaseRelease
        ) &&
        /finally \{[\s\S]*?proofClient\.end\(\)\.catch/u.test(
          clusterGrantProof
        ) &&
        /CREATE DATABASE IF NOT EXISTS archon_migration[\s\S]*?db:migration:rehearsal[\s\S]*?DROP DATABASE archon_migration CASCADE[\s\S]*?DROP USER archon_migration_ci[\s\S]*?CREATE DATABASE archon_reconciliation[\s\S]*?db:memory:reconciliation:rehearsal[\s\S]*?DROP DATABASE archon_reconciliation CASCADE[\s\S]*?local:bootstrap/u.test(
          ci
        ) &&
        /SHOW GRANTS ON DATABASE \$\{databaseSql\} FOR \$\{principalSql\}[\s\S]*?databaseGrants\.rows\.length !== 1/u.test(
          databaseRelease
        ) &&
        /\.proofs\.runtimeFunctionPrivilegeMatrix\s*==\s*\n?\s*"cluster-wide EXECUTE only on the two canonical resolution routine signatures"/u.test(
          databaseReleaseWorkflow
        ) &&
        /\.proofs\.runtimeDatabasePrivilegeMatrix\s*==\s*\n?\s*"cluster-wide exact five-row non-grantable matrix: public CONNECT\+TEMPORARY on defaultdb\/postgres; runtime principal CONNECT on archon; zero system rows"/u.test(
          databaseReleaseWorkflow
        ) &&
        /\.proofs\.runtimeSystemPrivileges\s*==\s*\n?\s*"exact-empty runtime role options; no affirmative system grants"/u.test(
          databaseReleaseWorkflow
        ) &&
        /\.clusterGrantProof\.routineGrantCount == 2/u.test(
          databaseReleaseWorkflow
        ) &&
        /\.clusterGrantProof\.databaseGrantCount == 5/u.test(
          databaseReleaseWorkflow
        ) &&
        /\.clusterGrantProof\.databaseInventory ==\s*\n?\s*\["archon", "defaultdb", "postgres", "system"\]/u.test(
          databaseReleaseWorkflow
        ) &&
        /\[\.runtimes\[\]\.clusterGrantProof\.databaseMatrixSha256\][\s\S]*?unique \| length\) == 2/u.test(
          databaseReleaseWorkflow
        ) &&
        /\.clusterGrantProof\.databaseGrantMatrix == \[[\s\S]*?"databaseName":"archon","grantee":\.principal,"privilegeType":"CONNECT","isGrantable":false[\s\S]*?"databaseName":"defaultdb","grantee":"public","privilegeType":"TEMPORARY","isGrantable":false[\s\S]*?"databaseName":"postgres","grantee":"public","privilegeType":"TEMPORARY","isGrantable":false/u.test(
          databaseReleaseWorkflow
        ) &&
        databaseMatrixDigestRecomputeGate.test(databaseReleaseWorkflow) &&
        /\.clusterGrantProof\.databaseMatrixSha256/u.test(
          databaseReleaseWorkflow
        ) &&
        /\.schemaVersion == 6[\s\S]*?all\(\.runtimes\[\];[\s\S]*?\.clusterGrantProof\.databaseGrantCount == 5[\s\S]*?\.clusterGrantProof\.databaseInventory ==[\s\S]*?\["archon", "defaultdb", "postgres", "system"\][\s\S]*?\.clusterGrantProof\.databaseMatrixSha256/u.test(
          deploy
        ) &&
        /sql\.ttl\.job\.enabled/u.test(resolutionSandboxVerifier) &&
        /SHOW SCHEDULES/u.test(resolutionSandboxVerifier) &&
        /tables:\s*5/u.test(resolutionSandboxVerifier) &&
        /rlsPolicies:\s*15/u.test(resolutionSandboxVerifier) &&
        /ttlScheduleStatus:\s*"ACTIVE"/u.test(
          resolutionSandboxVerifier
        ) &&
        /\.proofs\.memoryResolutionLoop\s*==\s*true/u.test(
          databaseReleaseWorkflow
        ) &&
        /\.proofs\.runtimeResolutionEnvironmentCount\s*==\s*2/u.test(
          databaseReleaseWorkflow
        ) &&
        /\.proofs\.resolutionSandbox\.tables\s*==\s*5/u.test(
          databaseReleaseWorkflow
        ) &&
        /\.proofs\.resolutionSandbox\.rlsPolicies\s*==\s*15/u.test(
          databaseReleaseWorkflow
        ) &&
        /\.proofs\.resolutionSandbox\.ttlSchedule\s*==\s*\n?\s*"0 \*\/4 \* \* \*"/u.test(
          databaseReleaseWorkflow
        ) &&
        /\.proofs\.resolutionSandbox\.ttlClusterEnabled\s*==\s*true/u.test(
          databaseReleaseWorkflow
        ) &&
        /\.proofs\.resolutionSandbox\.ttlScheduleStatus\s*==\s*"ACTIVE"/u.test(
          databaseReleaseWorkflow
        ) &&
        /\.proofs\.resolutionSandbox\.ttlPaused\s*==\s*false/u.test(
          databaseReleaseWorkflow
        ) &&
        /\.proofs\.resolutionSandbox\.writerRelationGrantCount\s*==\s*5/u.test(
          databaseReleaseWorkflow
        ) &&
        /\.proofs\.resolutionSandbox\.transitionOwnerRelationGrantCount\s*==\s*13/u.test(
          databaseReleaseWorkflow
        ) &&
        /\.proofs\.resolutionSandbox\.transitionFunctionCount\s*==\s*2/u.test(
          databaseReleaseWorkflow
        ) &&
        /\.proofs\.resolutionSandbox\.writerFunctionExecuteCount\s*==\s*2/u.test(
          databaseReleaseWorkflow
        ) &&
        /\.proofs\.resolutionSandbox\.directRuntimeDml\s*==\s*"none"/u.test(
          databaseReleaseWorkflow
        ) &&
        /\.resolutionLoop\.databaseEnforcedTransitions\s*==\s*true/u.test(
          databaseReleaseWorkflow
        ) &&
        /\.resolutionLoop\.exactTransitionFunctionExecute\s*==\s*true/u.test(
          databaseReleaseWorkflow
        ) &&
        /\.resolutionLoop\.directResolutionDmlDenied\s*==\s*true/u.test(
          databaseReleaseWorkflow
        ) &&
        /\.resolutionLoop\.approvePath\s*==\s*true/u.test(
          databaseReleaseWorkflow
        ) &&
        /\.resolutionLoop\.rejectPath\s*==\s*true/u.test(
          databaseReleaseWorkflow
        ) &&
        /\.resolutionLoop\.idempotentReplay\s*==\s*true/u.test(
          databaseReleaseWorkflow
        ) &&
        /\.resolutionLoop\.conflictingFinalDecisionRejected\s*==\s*true/u.test(
          databaseReleaseWorkflow
        ) &&
        /\.resolutionLoop\.receiptVerified\s*==\s*true/u.test(
          databaseReleaseWorkflow
        ) &&
        /\.resolutionLoop\.receiptDatabaseDerived\s*==\s*true/u.test(
          databaseReleaseWorkflow
        ) &&
        /\.resolutionLoop\.consolidationVerified\s*==\s*true/u.test(
          databaseReleaseWorkflow
        ) &&
        /\.resolutionLoop\.canonicalMemoryUnchanged\s*==\s*true/u.test(
          databaseReleaseWorkflow
        ) &&
        /\.resolutionLoop\.deletePrivilegeAbsent\s*==\s*true/u.test(
          databaseReleaseWorkflow
        ) &&
        /\.resolutionLoop\.approvedReceiptSha256\s*!=\s*\n?\s*\.resolutionLoop\.rejectedReceiptSha256/u.test(
          databaseReleaseWorkflow
        ),
      "The database release proves the five-table TTL/RLS sandbox, an exact cluster-wide two-signature transition API with isolated CI rehearsal databases, a live five-row runtime database matrix (public CONNECT+TEMPORARY on defaultdb/postgres, direct CONNECT on archon, zero system rows), drift rejection and a canonical digest, zero runtime DML, and approve/reject/idempotency/conflict/receipt/consolidation behavior through both runtime principals while canonical memory remains unchanged.",
      "The database release does not prove the bounded CockroachDB resolution action loop and its isolation, retention, or immutable receipt controls."
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
        /AccessLogSettings:[\s\S]*?DestinationArn:\s*!Sub "arn:\$\{AWS::Partition\}:logs:\$\{AWS::Region\}:\$\{AWS::AccountId\}:log-group:\$\{ApiVendedAccessLogGroup\}"/u.test(
          lambdaTemplate
        ) &&
        !/DestinationArn:\s*!GetAtt ApiVendedAccessLogGroup\.Arn/u.test(
          lambdaTemplate
        ) &&
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
        /logs:DescribeIndexPolicies/u.test(deliveryBootstrap) &&
        /logs:DescribeLogStreams/u.test(deliveryBootstrap) &&
        /logs:FilterLogEvents/u.test(deliveryBootstrap) &&
        /codedeploy:ListDeployments/u.test(deliveryBootstrap) &&
        /Sid: StagingLambda[\s\S]*?- lambda:GetProvisionedConcurrencyConfig[\s\S]*?Resource: !Sub "arn:\$\{AWS::Partition\}:lambda:\$\{AWS::Region\}:\$\{AWS::AccountId\}:function:\$\{AppName\}-staging-\*"/u.test(
          deliveryBootstrap
        ) &&
        /Sid: ProductionLambda[\s\S]*?- lambda:GetProvisionedConcurrencyConfig[\s\S]*?Resource: !Sub "arn:\$\{AWS::Partition\}:lambda:\$\{AWS::Region\}:\$\{AWS::AccountId\}:function:\$\{AppName\}-production-\*"/u.test(
          deliveryBootstrap
        ) &&
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
        /DestinationArn\."Fn::Sub"[\s\S]*?== "arn:\$\{AWS::Partition\}:logs:\$\{AWS::Region\}:\$\{AWS::AccountId\}:log-group:\$\{ApiVendedAccessLogGroup\}"/u.test(
          apiStageProof
        ) &&
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
      "SAM defines the private S3/CloudFront/Lambda architecture and CI proves the drift-stable canonical access-log ARN, complete read-only drift discovery, non-reserved named stage, exact live CloudFront binding, throttling, metrics, and access logs before frontend mutation.",
      "The deployable AWS architecture, canonical access-log ARN, complete drift-discovery permissions, or live API stage-control proof is incomplete."
    ),
    sourceCheck(
      "product.hosted-dast-release-gate",
      "Production Readiness",
      hasExactHostedDastTrigger(securityDastWorkflow) &&
        hostedDastCiJob.length > 0 &&
        hostedDastCiJob.includes(
          "DAST_CANDIDATE_URL: http://127.0.0.1:4173"
        ) &&
        !containsExactHostnameToken(
          hostedDastCiJob,
          CANONICAL_DEMO_HOSTNAME
        ) &&
        !/DAST_EXPECTED_RELEASE_SHA/u.test(hostedDastCiJob) &&
        /npm ci\s+npm ci --prefix web/u.test(hostedDastCiJob) &&
        /node --import tsx --test --test-concurrency=1[\s\S]*?tests\/hosted-dast\.test\.ts \| tee "\$DAST_CONTRACT_TAP"/u.test(
          hostedDastCiJob
        ) &&
        /npm run build --prefix web/u.test(hostedDastCiJob) &&
        /PREDEPLOY_WEB_ROOT="\$GITHUB_WORKSPACE\/web\/dist"[\s\S]*?node scripts\/predeploy-zap-server\.mjs/u.test(
          hostedDastCiJob
        ) &&
        /const LOOPBACK_HOST = "127\.0\.0\.1"/u.test(predeployZapServer) &&
        /server\.listen\(port, LOOPBACK_HOST/u.test(predeployZapServer) &&
        /tests\/predeploy-zap-server\.test\.ts/u.test(packageSource) &&
        /name:\s*dast-contract-ci-\$\{\{\s*github\.sha\s*\}\}-\$\{\{\s*github\.run_attempt\s*\}\}/u.test(
          hostedDastCiJob
        ) &&
        /target:\s*\$\{\{\s*env\.DAST_CANDIDATE_URL\s*\}\}/u.test(
          hostedDastCiJob
        ) &&
        /cleanup_candidate_metadata\(\) \{[\s\S]*?rm -f --[\s\S]*?"\$PREDEPLOY_ZAP_PID_FILE" "\$PREDEPLOY_ZAP_LOG_FILE" \|\| true[\s\S]*?trap cleanup_candidate_metadata EXIT/u.test(
          hostedDastCiJob
        ) &&
        /Require the candidate server to remain healthy and clean up[\s\S]*?\/proc\/\$server_pid\/cmdline[\s\S]*?kill -TERM "\$server_pid"[\s\S]*?kill -KILL "\$server_pid"[\s\S]*?cleanup_candidate_metadata/u.test(
          hostedDastCiJob
        ) &&
        !hostedDastCiJob.includes('wait "$server_pid"') &&
        hostedDastCiJob.includes('test "$alive" = "true"') &&
        hostedDastCiJob.includes('test "$healthy" = "true"') &&
        hostedDastCiJob.includes(
          'test "$candidate_identity" = "true"'
        ) &&
        hostedDastCiJob.includes('test "$shutdown_clean" = "true"') &&
        hostedDastCiJob.includes('test "$forced_cleanup" = "false"') &&
        hostedDastCiJob.includes('test "$process_absent" = "true"') &&
        /retention-days:\s*90/u.test(hostedDastCiJob) &&
        /zaproxy\/action-baseline@6c5a007541891231cd9e0ddec25d4f25c59c9874/u.test(
          hostedDastCiJob
        ) &&
        /rules_file_name:\s*\.zap\/predeploy\.tsv/u.test(
          hostedDastCiJob
        ) &&
        /ghcr\.io\/zaproxy\/zaproxy:2\.17\.0@sha256:8d387b1a63e3425beef4846e39719f5af2a787753af2d8b6558c6257d7a577a2/u.test(
          hostedDastCiJob
        ) &&
        /fail_action:\s*true/u.test(hostedDastCiJob) &&
        /allow_issue_writing:\s*false/u.test(hostedDastCiJob) &&
        /artifact_name:\s*zap-baseline-ci-\$\{\{\s*github\.sha\s*\}\}-\$\{\{\s*github\.run_attempt\s*\}\}/u.test(
          hostedDastCiJob
        ) &&
        /workflow_call:/u.test(securityDastWorkflow) &&
        !/workflow_run:/u.test(securityDastWorkflow) &&
        /cron:\s*"43 4 \* \* 1"/u.test(securityDastWorkflow) &&
        /DAST_REQUIRE_HARDENED_HEADERS:\s*"1"/u.test(
          securityDastWorkflow
        ) &&
        deployHostedDastJob.length > 0 &&
        /needs:\s*\r?\n\s+- deploy-production\r?\n\s+- managed-mcp-production-audit/u.test(
          deployHostedDastJob
        ) &&
        /uses:\s*\.\/\.github\/workflows\/security-dast\.yml/u.test(
          deployHostedDastJob
        ) &&
        /exact_sha:\s*\$\{\{\s*github\.sha\s*\}\}/u.test(
          deployHostedDastJob
        ) &&
        /deploy_run_id:\s*\$\{\{\s*fromJSON\(github\.run_id\)\s*\}\}/u.test(
          deployHostedDastJob
        ) &&
        /deploy_run_attempt:\s*\$\{\{\s*fromJSON\(github\.run_attempt\)\s*\}\}/u.test(
          deployHostedDastJob
        ) &&
        hostedDastSourceGateJob.length > 0 &&
        /name:\s*Validate Hosted DAST source deployment/u.test(
          hostedDastSourceGateJob
        ) &&
        /name:\s*Require successful operation-bound Deploy AWS source/u.test(
          hostedDastSourceGateJob
        ) &&
        /test "\$EVENT_NAME" = "push"/u.test(
          hostedDastSourceGateJob
        ) &&
        hasExactTrimmedLine(
          hostedDastSourceGateJob,
          '[[ "$REQUESTED_RUN_ID" =~ ^[1-9][0-9]*$ ]]'
        ) &&
        hasExactTrimmedLine(
          hostedDastSourceGateJob,
          '[[ "$REQUESTED_RUN_ATTEMPT" =~ ^[1-9][0-9]*$ ]]'
        ) &&
        hasExactTrimmedLine(
          hostedDastSourceGateJob,
          '[[ "$REQUESTED_SHA" =~ ^[0-9a-f]{40}$ ]]'
        ) &&
        /test "\$GITHUB_RUN_ID" = "\$REQUESTED_RUN_ID"/u.test(
          hostedDastSourceGateJob
        ) &&
        /test "\$GITHUB_RUN_ATTEMPT" = "\$REQUESTED_RUN_ATTEMPT"/u.test(
          hostedDastSourceGateJob
        ) &&
        /test "\$GITHUB_SHA" = "\$REQUESTED_SHA"/u.test(
          hostedDastSourceGateJob
        ) &&
        /actions:\s*read/u.test(hostedDastSourceGateJob) &&
        /actions\/runs\/\$\{REQUESTED_RUN_ID\}\/attempts\/\$\{REQUESTED_RUN_ATTEMPT\}\/jobs\?per_page=100/u.test(
          hostedDastSourceGateJob
        ) &&
        /exact_job\("Validate Deploy AWS source CI"\)/u.test(
          hostedDastSourceGateJob
        ) &&
        /exact_job\("Promote identical candidate to production"\)/u.test(
          hostedDastSourceGateJob
        ) &&
        /"Smoke production through CloudFront"/u.test(
          hostedDastSourceGateJob
        ) &&
        /"Upload production receipt"/u.test(
          hostedDastSourceGateJob
        ) &&
        (
          securityDastWorkflow.match(/needs:\s*source-gate/gu) ?? []
        ).length === 2 &&
        hostedDastReleaseBoundaryJob.length > 0 &&
        /actions\/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0/u.test(
          hostedDastReleaseBoundaryJob
        ) &&
        /ref:\s*\$\{\{\s*env\.DAST_CHECKOUT_SHA\s*\}\}/u.test(
          hostedDastReleaseBoundaryJob
        ) &&
        /node scripts\/hosted-dast\.mjs/u.test(
          hostedDastReleaseBoundaryJob
        ) &&
        /DAST_SOURCE_DEPLOY_RUN_ID:\s*\$\{\{\s*needs\.source-gate\.outputs\.source_deploy_run_id\s*\}\}/u.test(
          hostedDastReleaseBoundaryJob
        ) &&
        /DAST_SOURCE_DEPLOY_RUN_ATTEMPT:\s*\$\{\{\s*needs\.source-gate\.outputs\.source_deploy_run_attempt\s*\}\}/u.test(
          hostedDastReleaseBoundaryJob
        ) &&
        /DAST_EXPECTED_RELEASE_SHA:\s*\$\{\{\s*needs\.source-gate\.outputs\.expected_release_sha\s*\}\}/u.test(
          hostedDastReleaseBoundaryJob
        ) &&
        /name:\s*hosted-dast-\$\{\{\s*env\.DAST_CHECKOUT_SHA\s*\}\}-\$\{\{\s*needs\.source-gate\.outputs\.artifact_run_id\s*\}\}-\$\{\{\s*needs\.source-gate\.outputs\.artifact_run_attempt\s*\}\}/u.test(
          hostedDastReleaseBoundaryJob
        ) &&
        /retention-days:\s*90/u.test(hostedDastReleaseBoundaryJob) &&
        hostedDastReleaseZapJob.length > 0 &&
        /actions\/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0/u.test(
          hostedDastReleaseZapJob
        ) &&
        /ref:\s*\$\{\{\s*env\.DAST_CHECKOUT_SHA\s*\}\}/u.test(
          hostedDastReleaseZapJob
        ) &&
        /zaproxy\/action-baseline@6c5a007541891231cd9e0ddec25d4f25c59c9874/u.test(
          hostedDastReleaseZapJob
        ) &&
        /name:\s*Scan the owned public production release/u.test(
          hostedDastReleaseZapJob
        ) &&
        /target:\s*\$\{\{\s*env\.DAST_TARGET_URL\s*\}\}/u.test(
          hostedDastReleaseZapJob
        ) &&
        /rules_file_name:\s*\.zap\/release\.tsv/u.test(
          hostedDastReleaseZapJob
        ) &&
        /ghcr\.io\/zaproxy\/zaproxy:2\.17\.0@sha256:8d387b1a63e3425beef4846e39719f5af2a787753af2d8b6558c6257d7a577a2/u.test(
          hostedDastReleaseZapJob
        ) &&
        /fail_action:\s*true/u.test(hostedDastReleaseZapJob) &&
        /allow_issue_writing:\s*false/u.test(
          hostedDastReleaseZapJob
        ) &&
        /artifact_name:\s*zap-baseline-\$\{\{\s*env\.DAST_CHECKOUT_SHA\s*\}\}-\$\{\{\s*needs\.source-gate\.outputs\.artifact_run_attempt\s*\}\}/u.test(
          hostedDastReleaseZapJob
        ) &&
        hasExactZapIgnorePolicy(zapPredeployRules, [
          "10015",
          "10036",
          "10049",
          "10050",
          "10094",
          "10109",
          "90005",
        ]) &&
        hasExactZapIgnorePolicy(zapReleaseRules, [
          "10015",
          "10036",
          "10049",
          "10050",
          "10094",
          "10109",
          "90005",
        ]) &&
        /EXPECTED_PRODUCTION_URL\s*=\s*\n?\s*"https:\/\/d2s5v0o0eg2aaw\.cloudfront\.net"/u.test(
          hostedDast
        ) &&
        /"\/api\/proof"/u.test(hostedDast) &&
        /targetReleaseSha === expectedReleaseSha/u.test(hostedDast) &&
        /schema:\s*"archon\.hosted-dast"[\s\S]*?version:\s*4/u.test(
          hostedDast
        ) &&
        /version:\s*4/u.test(hostedDastTypes) &&
        /profile:\s*"predeploy" \| "production-audit" \| "exact-release"/u.test(
          hostedDastTypes
        ) &&
        /export function writeHostedDastReceipt\(/u.test(
          hostedDastTypes
        ) &&
        /const profile = dastProfile\(\)/u.test(hostedDast) &&
        /return process\.env\.DAST_EXPECTED_RELEASE_SHA[\s\S]*?\? "exact-release"[\s\S]*?: "production-audit"/u.test(
          hostedDast
        ) &&
        /function failedReceipt\(\)/u.test(hostedDast) &&
        /id:\s*"scan-completion"[\s\S]*?status:\s*"fail"/u.test(
          hostedDast
        ) &&
        /const strictApiBoundary = profile !== "predeploy"/u.test(
          hostedDast
        ) &&
        /status:\s*strictApiBoundary \? 405 : \[404, 405\]/u.test(
          hostedDast
        ) &&
        /allowGatewayFallback:\s*!strictApiBoundary/u.test(
          hostedDast
        ) &&
        /ApiFallback:[\s\S]*?Path:\s*\/api\/\{proxy\+\}[\s\S]*?Method:\s*ANY/u.test(
          lambdaTemplate
        ) &&
        !/style-src 'self' 'unsafe-inline'/u.test(lambdaTemplate) &&
        /style-src 'self'; upgrade-insecure-requests/u.test(
          lambdaTemplate
        ) &&
        /Header: Cross-Origin-Embedder-Policy\s+Value: "require-corp"/u.test(
          lambdaTemplate
        ) &&
        /Header: Cross-Origin-Opener-Policy\s+Value: "same-origin"/u.test(
          lambdaTemplate
        ) &&
        /Header: Cross-Origin-Resource-Policy\s+Value: "same-origin"/u.test(
          lambdaTemplate
        ) &&
        /flag:\s*"wx"/u.test(hostedDast) &&
        /checks\.length,\s*21/u.test(hostedDastTests) &&
        /!strictApiBoundary \|\|[\s\S]*?healthJson\?\.access ===\s*\n?\s*"canonical-read-only\+isolated-synthetic-resolution-write"/u.test(
          hostedDast
        ) &&
        /healthJson\?\.resolutionSandbox\?\.authority ===\s*\n?\s*"financial-controller-human-gate"/u.test(
          hostedDast
        ) &&
        /id:\s*"resolution-session-method-boundary"/u.test(hostedDast) &&
        /id:\s*"resolution-session-fixed-scope-boundary"/u.test(hostedDast) &&
        /id:\s*"resolution-session-auth-boundary"/u.test(hostedDast) &&
        /id:\s*"resolution-capability-shape-boundary"/u.test(hostedDast) &&
        /id:\s*"resolution-decision-auth-boundary"/u.test(hostedDast) &&
        /Hosted DAST receipt does not prove all 21 checks/u.test(
          finalSubmissionGate
        ) &&
        /rejects encoded runtime secrets in public responses/u.test(
          hostedDastTests
        ) &&
        /rejects base64url-encoded JSON secret fields/u.test(
          hostedDastTests
        ) &&
        /candidate\.replaceAll\("-", "\+"\)\.replaceAll\("_", "\/"\)/u.test(
          hostedDast
        ) &&
        /function allowlistedStatus\(actual, expectedStatuses, id\)/u.test(
          hostedDast
        ) &&
        /releaseSha:\s*expectedReleaseSha \|\| "unknown"/u.test(
          hostedDast
        ) &&
        /targetOrigin:\s*EXPECTED_PRODUCTION_URL/u.test(hostedDast) &&
        /id:\s*"audit-boundary"/u.test(hostedDast) &&
        /writes a sanitized fail-closed receipt before rethrowing/u.test(
          hostedDastTests
        ) &&
        /exact-release profile requires isolated browser headers/u.test(
          hostedDastTests
        ) &&
        /exact-release refuses the legacy API Gateway fallback/u.test(
          hostedDastTests
        ) &&
        /fails closed when production is not the expected release/u.test(
          hostedDastTests
        ) &&
        /refuses non-owned or non-HTTPS targets before fetching/u.test(
          hostedDastTests
        ) &&
        /exactShaWorkflowRuns\(\s*"deploy-aws\.yml",\s*"push"/u.test(
          finalSubmissionGate
        ) &&
        !/exactShaWorkflowRuns\(\s*"security-dast\.yml"/u.test(
          finalSubmissionGate
        ) &&
        !/selectedRuns\.hostedDast/u.test(finalSubmissionGate) &&
        (
          finalSubmissionGate.match(
            /requireSuccessfulHostedDastJobs\(/gu
          ) ?? []
        ).length >= 3 &&
        (
          finalSubmissionGate.match(
            /requireSuccessfulDeployJobs\(/gu
          ) ?? []
        ).length >= 3 &&
        /actions\/runs\/\$\{deployRun\.id\}\/attempts\/\$\{deployRun\.run_attempt\}\/jobs\?per_page=100/u.test(
          finalSubmissionGate
        ) &&
        /selectExactHostedDastArtifact\(/u.test(finalSubmissionGate) &&
        /githubArtifactReceipt\(/u.test(finalSubmissionGate) &&
        /githubArtifactArchive\(/u.test(finalSubmissionGate) &&
        /requireArtifactArchiveDigest\(/u.test(finalSubmissionGate) &&
        /requireExactHostedDastReceipt\(/u.test(finalSubmissionGate) &&
        /selectedArtifacts\.hostedDastZap = toSelectedArtifact/u.test(
          finalSubmissionGate
        ) &&
        /terminalHostedDastZapArtifact\.digest !==/u.test(
          finalSubmissionGate
        ) &&
        /terminalHostedDastArtifact\.digest !== hostedDastArtifact\.digest/u.test(
          finalSubmissionGate
        ),
      "CI blocks on the complete adversarial DAST contract and a digest-pinned ZAP scan of the exact candidate SPA; every successful AWS deployment then receives an exact-release live scan, sanitized evidence, and final-submission revalidation.",
      "The candidate DAST gate, exact deployed-release binding, immutable ZAP policy, final-submission revalidation, or adversarial regression coverage is incomplete."
    ),
    sourceCheck(
      "product.demo-concurrency-headroom",
      "Production Readiness",
      /ReservedConcurrency:\s*Type:\s*Number[\s\S]*?Default:\s*5[\s\S]*?ApiThrottleRate:\s*Type:\s*Number[\s\S]*?Default:\s*5/u.test(
        lambdaTemplate
      ) &&
        /ReservedConcurrentExecutions:\s*!Ref ReservedConcurrency/u.test(
          lambdaTemplate
        ) &&
        (
          deploy.match(/--arg reservedConcurrency "5"/gu) ?? []
        ).length === 6 &&
        (
          deploy.match(
            /ReservedConcurrency: \$reservedConcurrency/gu
          ) ?? []
        ).length === 2 &&
        (
          deploy.match(
            /and \.ReservedConcurrency == \$reservedConcurrency/gu
          ) ?? []
        ).length === 2 &&
        (
          deploy.match(
            /select\(\.ParameterKey == "ReservedConcurrency"\)\s+\| \.ParameterValue\] == \[\$reservedConcurrency\]/gu
          ) ?? []
        ).length === 2,
      "Reserved concurrency is explicitly promoted and then live-proved at five: three Control Room reads, one recall, and one bounded spare in-flight slot; API rate is enforced independently.",
      "The live promotion can retain insufficient Lambda concurrency for the judge-facing Control Room."
    ),
    sourceCheck(
      "product.exact-live-release-binding",
      "Production Readiness",
      /ReleaseCommitSha:\s*Type:\s*String[\s\S]*?AllowedPattern: "\^\[0-9a-f\]\{40\}\$"/u.test(
        lambdaTemplate
      ) &&
        /RELEASE_COMMIT_SHA:\s*!Ref ReleaseCommitSha/u.test(lambdaTemplate) &&
        /commitSha:\s*\n?\s*\/\^\[0-9a-f\]\{40\}\$\/u\.test\(process\.env\.RELEASE_COMMIT_SHA/u.test(
          handler
        ) &&
        (
          deploy.match(/ReleaseCommitSha: \$releaseCommitSha/gu) ?? []
        ).length === 2 &&
        (
          deploy.match(
            /select\(\.ParameterKey == "ReleaseCommitSha"\)\s+\| \.ParameterValue\] == \[\$releaseCommitSha\]/gu
          ) ?? []
        ).length === 2 &&
        (
          deploy.match(
            /\.release\.commitSha == \$releaseCommitSha and\s+\.release\.evidence == "server-configured Lambda environment"/gu
          ) ?? []
        ).length === 2,
      "The exact protected commit is an explicit stack parameter, Lambda proof field, post-SAM parameter proof, and staging/production live release gate.",
      "The public proof can drift from the protected commit promoted by AWS CI/CD."
    ),
    sourceCheck(
      "product.protected-encrypted-alarm-routing-control-loop",
      "Production Readiness",
      /AlarmRoutingEnabled:\s+Type: String\s+Default: "false"\s+AllowedValues:\s+- "true"\s+- "false"/u.test(
        deliveryBootstrap
      ) &&
        /EnableAlarmRouting: !Equals \[!Ref AlarmRoutingEnabled, "true"\]/u.test(
          deliveryBootstrap
        ) &&
        /AlarmNotificationsKey:[\s\S]*?Condition: EnableAlarmRouting[\s\S]*?DeletionPolicy: RetainExceptOnCreate[\s\S]*?EnableKeyRotation: true[\s\S]*?KeySpec: SYMMETRIC_DEFAULT[\s\S]*?AllowCloudWatchAlarmEncryption[\s\S]*?AllowSnsEncryptedQueueDelivery/u.test(
          deliveryBootstrap
        ) &&
        (
          deliveryBootstrap.match(
            /KmsMasterKeyId: !GetAtt AlarmNotificationsKey\.Arn/gu
          ) ?? []
        ).length === 5 &&
        /StagingAlarmTopic:[\s\S]*?Condition: EnableAlarmRouting[\s\S]*?TopicName: !Sub "\$\{AppName\}-staging-alarms"/u.test(
          deliveryBootstrap
        ) &&
        /ProductionAlarmTopic:[\s\S]*?Condition: EnableAlarmRouting[\s\S]*?TopicName: !Sub "\$\{AppName\}-production-alarms"/u.test(
          deliveryBootstrap
        ) &&
        /StagingAlarmArchiveQueue:[\s\S]*?Condition: EnableAlarmRouting[\s\S]*?MessageRetentionPeriod: 1209600/u.test(
          deliveryBootstrap
        ) &&
        /ProductionAlarmArchiveQueue:[\s\S]*?Condition: EnableAlarmRouting[\s\S]*?MessageRetentionPeriod: 1209600/u.test(
          deliveryBootstrap
        ) &&
        /AllowStagingCloudWatchAlarmPublish[\s\S]*?aws:SourceAccount[\s\S]*?AllowProductionCloudWatchAlarmPublish[\s\S]*?aws:SourceAccount/u.test(
          deliveryBootstrap
        ) &&
        /DenyStagingAlarmArchiveInjection[\s\S]*?ArnNotLike:[\s\S]*?aws:SourceArn: !Ref StagingAlarmTopic[\s\S]*?DenyProductionAlarmArchiveInjection[\s\S]*?ArnNotLike:[\s\S]*?aws:SourceArn: !Ref ProductionAlarmTopic/u.test(
          deliveryBootstrap
        ) &&
        /StagingAlarmArchiveSubscription:[\s\S]*?RawMessageDelivery: false/u.test(
          deliveryBootstrap
        ) &&
        /ProductionAlarmArchiveSubscription:[\s\S]*?RawMessageDelivery: false/u.test(
          deliveryBootstrap
        ) &&
        /AlarmStateInspectionPolicy:[\s\S]*?Roles:\s+- !Ref StagingDeployRole\s+- !Ref ProductionDeployRole[\s\S]*?Action: cloudwatch:DescribeAlarms\s+Resource: "\*"/u.test(
          deliveryBootstrap
        ) &&
        /LogicalResourceId\/AlarmStateInspectionPolicy/u.test(
          bootstrapStackPolicy
        ) &&
        (
          deliveryBootstrap.match(
            /Condition: EnableAlarmRouting\r?\n\s+Value:/gu
          ) ?? []
        ).length === 7 &&
        /LogicalResourceId\/AlarmNotificationsKey/u.test(
          bootstrapStackPolicy
        ) &&
        /LogicalResourceId\/StagingAlarmTopic/u.test(
          bootstrapStackPolicy
        ) &&
        /LogicalResourceId\/ProductionAlarmTopic/u.test(
          bootstrapStackPolicy
        ) &&
        /AlarmRoutingCloudFormationExecutionRole:[\s\S]*?Principal:\s+Service: cloudformation\.amazonaws\.com[\s\S]*?activate-exact-alarm-routing-resources/u.test(
          deliveryBootstrap
        ) &&
        /AlarmRoutingControlRole:[\s\S]*?token\.actions\.githubusercontent\.com:environment: alarm-routing-controls/u.test(
          deliveryBootstrap
        ) &&
        /token\.actions\.githubusercontent\.com:workflow: Manage AWS Alarm Routing/u.test(
          deliveryBootstrap
        ) &&
        /ManageExactAlarmSubscriptions[\s\S]*?sns:SetSubscriptionAttributes[\s\S]*?staging-alarms:\*/u.test(
          deliveryBootstrap
        ) &&
        /InspectExactAlarmSubscriptions[\s\S]*?sns:GetSubscriptionAttributes[\s\S]*?staging-alarms:\*/u.test(
          deliveryBootstrap
        ) &&
        /StagingAlarmRoutingDrillAlarm:[\s\S]*?Condition: EnableAlarmRouting[\s\S]*?AlarmName: !Sub "\$\{AppName\}-staging-routing-drill"[\s\S]*?AlarmActions:\s+- !Ref StagingAlarmTopic/u.test(
          deliveryBootstrap
        ) &&
        /StagingAlarmRoutingDrillQueue:[\s\S]*?Condition: EnableAlarmRouting[\s\S]*?MessageRetentionPeriod: 300[\s\S]*?synthetic-operational-evidence/u.test(
          deliveryBootstrap
        ) &&
        /StagingAlarmRoutingDrillSubscription:[\s\S]*?FilterPolicyScope: MessageBody[\s\S]*?AlarmName:[\s\S]*?!Sub "\$\{AppName\}-staging-routing-drill"/u.test(
          deliveryBootstrap
        ) &&
        /LogicalResourceId\/AlarmRoutingCloudFormationExecutionRole/u.test(
          bootstrapStackPolicy
        ) &&
        /LogicalResourceId\/AlarmRoutingControlRole/u.test(
          bootstrapStackPolicy
        ) &&
        /LogicalResourceId\/StagingAlarmRoutingDrillAlarm/u.test(
          bootstrapStackPolicy
        ) &&
        /LogicalResourceId\/StagingAlarmRoutingDrillQueue/u.test(
          bootstrapStackPolicy
        ) &&
        /LogicalResourceId\/StagingAlarmRoutingDrillSubscription/u.test(
          bootstrapStackPolicy
        ) &&
        /name: Manage AWS Alarm Routing/u.test(alarmRoutingControls) &&
        /workflow_dispatch:/u.test(alarmRoutingControls) &&
        /environment: alarm-routing-controls/u.test(alarmRoutingControls) &&
        /test "\$GITHUB_SHA" = "\$TARGET_SHA"/u.test(
          alarmRoutingControls
        ) &&
        /prove_workflow ci\.yml CI/u.test(alarmRoutingControls) &&
        /prove_workflow codeql\.yml CodeQL/u.test(
          alarmRoutingControls
        ) &&
        /ACTIVATE-ENCRYPTED-ALARM-ROUTING/u.test(
          alarmRoutingControls
        ) &&
        /DRILL-STAGING-ALARM-DELIVERY/u.test(alarmRoutingControls) &&
        /if \[ "\$OPERATION" = "drill" \]; then[\s\S]*?now_epoch - updated_epoch[\s\S]*?-ge 900/u.test(
          alarmRoutingControls
        ) &&
        /StateValue \| IN\([\s\S]*?"OK",[\s\S]*?"INSUFFICIENT_DATA"/u.test(
          alarmRoutingControls
        ) &&
        /if \[ "\$initial_state" = "INSUFFICIENT_DATA" \]; then[\s\S]*?--state-value OK/u.test(
          alarmRoutingControls
        ) &&
        /existingResourceMutations: 0/u.test(alarmRoutingControls) &&
        /resourceAdditions: 15/u.test(alarmRoutingControls) &&
        /replacementCount: 0/u.test(alarmRoutingControls) &&
        (
          alarmRoutingControls.match(/--template-stage Original/gu) ??
          []
        ).length === 3 &&
        /remove_unverified_plan/u.test(alarmRoutingControls) &&
        /cloudformation delete-change-set/u.test(
          alarmRoutingControls
        ) &&
        /--visibility-timeout 0/u.test(alarmRoutingControls) &&
        !/sqs delete-message/u.test(alarmRoutingControls) &&
        /humanContactDetailsStored: false/u.test(alarmRoutingControls) &&
        !/us-west-2/u.test(alarmRoutingControls) &&
        /mode="\$\{1:-discover\}"/u.test(alarmRoutingProof) &&
        /discover\|verify/u.test(alarmRoutingProof) &&
        /legacy-inactive-not-provisioned/u.test(alarmRoutingProof) &&
        /inactive-not-provisioned/u.test(alarmRoutingProof) &&
        /CloudWatch alarms are not exclusively wired/u.test(
          alarmRoutingProof
        ) &&
        /CloudWatch alarms retain actions while alarm routing is inactive/u.test(
          alarmRoutingProof
        ) &&
        /AllowAccountTopicAdministration/u.test(alarmRoutingProof) &&
        /DenyStagingAlarmArchiveInjection/u.test(alarmRoutingProof) &&
        /DenyProductionAlarmArchiveInjection/u.test(alarmRoutingProof) &&
        !/secrets\.ALARM_TOPIC_ARN/u.test(deploy) &&
        !/if \[ -n "\$ALARM_TOPIC_ARN" \]/u.test(deploy) &&
        (
          deploy.match(/AlarmTopicArn: \$alarmTopicArn/gu) ?? []
        ).length === 2 &&
        /parameter_overrides_file="\$\{RUNNER_TEMP:\?\}\/staging-sam-parameters\.yaml"/u.test(
          deploy
        ) &&
        /parameter_overrides_file="\$\{RUNNER_TEMP:\?\}\/production-sam-parameters\.yaml"/u.test(
          deploy
        ) &&
        !/sam-parameters\.json/u.test(deploy) &&
        /JSON support is intentionally disabled upstream/u.test(
          deploy
        ) &&
        (
          deploy.match(
            /and \.AlarmTopicArn == \$alarmTopicArn/gu
          ) ?? []
        ).length === 2 &&
        (
          deploy.match(
            /--parameter-overrides "file:\/\/\$\{parameter_overrides_file\}"/gu
          ) ?? []
        ).length === 2 &&
        !/"AlarmTopicArn=\$ALARM_TOPIC_ARN"/u.test(deploy) &&
        (
          deploy.match(
            /bash aws\/prove-alarm-routing\.sh discover/gu
          ) ?? []
        ).length === 2 &&
        (
          deploy.match(/bash aws\/prove-alarm-routing\.sh verify/gu) ??
          []
        ).length === 2 &&
        (
          deploy.match(
            /ALARM_TOPIC_ARN: \$\{\{ steps\.alarm_routing\.outputs\.topic_arn \}\}/gu
          ) ?? []
        ).length === 2 &&
        (
          deploy.match(
            /\.state == "legacy-inactive-not-provisioned"\s+and \.alarmCount == null/gu
          ) ?? []
        ).length === 2 &&
        (
          deploy.match(/\.state == "inactive-not-provisioned"/gu) ?? []
        ).length === 4 &&
        /bash -n aws\/prove-alarm-routing\.sh/u.test(ci) &&
        /tests\/alarm-routing\.test\.ts/u.test(packageSource) &&
        /legacy foundation remains safely inactive with one read/u.test(
          alarmRoutingTests
        ) &&
        /partial foundation output fails before resource reads/u.test(
          alarmRoutingTests
        ) &&
        /active verify rejects a cross-environment topic/u.test(
          alarmRoutingTests
        ) &&
        /inactive verify rejects stale alarm actions/u.test(
          alarmRoutingTests
        ) &&
        /proof rejects broadened SNS account administration/u.test(
          alarmRoutingTests
        ) &&
        /proof rejects a weakened archive producer deny/u.test(
          alarmRoutingTests
        ),
      "A manual exact-green-main control loop can plan and activate only the dormant false-to-true foundation switch through dedicated OIDC and CloudFormation roles, reject every replacement or existing-resource mutation, verify both encrypted routes, and run a bounded staging-only ALARM-to-OK archive drill with sanitized approval evidence. Live activation and human paging are not claimed until hosted receipts exist.",
      "The protected alarm-routing foundation, activation plan, dedicated authority, bounded staging drill, post-deploy proof, sanitized receipt, or CI coverage is incomplete."
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
        /Sid: ResolveExactFoundationRoleAttributes[\s\S]*?Action: iam:GetRole\s+Resource:\s+- !Sub >-\s+arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:role\/\$\{AppName\}-staging-lambda-runtime\s+- !Sub >-\s+arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:role\/\$\{AppName\}-production-lambda-runtime\s+- !Sub >-\s+arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:role\/\$\{AppName\}-staging-codedeploy\s+- !Sub >-\s+arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:role\/\$\{AppName\}-production-codedeploy\s+- !Sub >-\s+arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:role\/\$\{AppName\}-github-database-operator\s+- !Sub >-\s+arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:role\/\$\{AppName\}-github-edge-controls\s+- !Sub >-\s+arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:role\/\$\{AppName\}-github-edge-cleanup\s+- !Sub >-\s+arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:role\/\$\{AppName\}-github-finops-controls\s+- !Sub >-\s+arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:role\/\$\{AppName\}-finops-cloudformation-execution\s+- !Sub >-\s+arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:role\/\$\{AppName\}-github-alarm-routing-controls\s+- !Sub >-\s+arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:role\/\$\{AppName\}-alarm-routing-cloudformation-execution\s+- !Sub >-\s+arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:role\/\$\{AppName\}-github-foundation-promotion\s+- !Sub >-\s+arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:role\/\$\{AppName\}-github-foundation-migration\s+- !Sub >-\s+arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:role\/\$\{AppName\}-github-staging-deploy\s+- !Sub >-\s+arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:role\/\$\{AppName\}-github-production-deploy\s+Condition:\s+"ForAnyValue:StringEquals":\s+aws:CalledVia: cloudformation\.amazonaws\.com/u.test(
          foundationPromotionRole
        ) &&
        /Sid: InspectPermanentControlRoleMetadata[\s\S]*?Action: iam:GetRole\s+Resource:\s+- !Sub >-\s+arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:role\/\$\{AppName\}-github-edge-controls\s+- !Sub >-\s+arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:role\/\$\{AppName\}-github-edge-cleanup\s+- !Sub >-\s+arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:role\/\$\{AppName\}-github-finops-controls\s+- !Sub >-\s+arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:role\/\$\{AppName\}-finops-cloudformation-execution\s+- !Sub >-\s+arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:role\/\$\{AppName\}-github-alarm-routing-controls\s+- !Sub >-\s+arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:role\/\$\{AppName\}-alarm-routing-cloudformation-execution\s+- Sid: InspectPermanentControlRolePolicies/u.test(
          foundationPromotionRole
        ) &&
        /Sid: InspectPermanentControlRolePolicies[\s\S]*?Action: iam:GetRolePolicy\s+Resource:\s+- !Sub >-\s+arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:role\/\$\{AppName\}-github-edge-controls\s+- !Sub >-\s+arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:role\/\$\{AppName\}-github-edge-cleanup\s+- !Sub >-\s+arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:role\/\$\{AppName\}-github-finops-controls\s+- !Sub >-\s+arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:role\/\$\{AppName\}-finops-cloudformation-execution\s+- !Sub >-\s+arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:role\/\$\{AppName\}-github-alarm-routing-controls\s+- !Sub >-\s+arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:role\/\$\{AppName\}-alarm-routing-cloudformation-execution\s+- Sid: ResolveExactFoundationAutomationRule/u.test(
          foundationPromotionRole
        ) &&
        /Sid: ResolveExactFoundationAutomationRule[\s\S]*?Action: securityhub:ListTagsForResource\s+Resource: !GetAtt S3AccessLogArchiveS39Suppression\.RuleArn\s+Condition:\s+"ForAnyValue:StringEquals":\s+aws:CalledVia: cloudformation\.amazonaws\.com/u.test(
          foundationPromotionRole
        ) &&
        (
          foundationPromotionRole.match(/Action: iam:GetRole$/gmu) ?? []
        ).length === 3 &&
        (
          foundationPromotionRole.match(/Action: iam:GetRolePolicy$/gmu) ?? []
        ).length === 1 &&
        (
          foundationPromotionRole.match(
            /arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:role\/\$\{AppName\}-[a-z-]+/gmu
          ) ?? []
        ).length === 29 &&
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
        !/iam:(?:ListRoles|ListRolePolicies|ListAttachedRolePolicies|ListRoleTags)|role\/\*|automation-rule\/\*|Resource: "\*"/u.test(
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
      "product.staging-fault-injected-recovery",
      "Production Readiness",
      stagingFaultInjectedRecoveryContract && localArtifacts.length === 0,
      "A protected staging-only dispatch injects a real inaccessible-secret candidate fault, proves the 10% canary alarm plus linked CodeDeploy/CloudFormation automatic rollback, restores the live release, and leaves an attested handoff for watchdog terminalization; the live drill receipt remains an explicit activation requirement.",
      "The staging-only fault boundary, candidate alarm observation, automatic rollback linkage, sanitized handoff, watchdog classification, CI regression contract, or runner artifact hygiene is incomplete."
    ),
    sourceCheck(
      "product.oidc-promotion-rollback",
      "Production Readiness",
      has("aws/bootstrap-oidc.yaml") &&
        deploySourceGateJob.length > 0 &&
        /name:\s*Validate Deploy AWS source CI/u.test(
          deploySourceGateJob
        ) &&
        /name:\s*Require successful exact-main push CI source/u.test(
          deploySourceGateJob
        ) &&
        /case "\$GITHUB_EVENT_NAME" in[\s\S]*?push\)[\s\S]*?test "\$DEPLOY_OPERATION" = "release"[\s\S]*?test "\$RECOVERY_DRILL_TOKEN" = "disabled"[\s\S]*?workflow_dispatch\)[\s\S]*?test "\$DEPLOY_OPERATION" = "staging-recovery-drill"[\s\S]*?FAULT-INJECT-STAGING-RECOVERY-AND-REQUIRE-WATCHDOG/u.test(
          deploySourceGateJob
        ) &&
        hasExactTrimmedLine(
          deploySourceGateJob,
          'test "$GITHUB_REF" = "refs/heads/main"'
        ) &&
        hasExactTrimmedLine(
          deploySourceGateJob,
          '[[ "$EXPECTED_SHA" =~ ^[0-9a-f]{40}$ ]]'
        ) &&
        /actions\/workflows\/ci\.yml\/runs\?branch=main&event=push/u.test(
          deploySourceGateJob
        ) &&
        /\.head_sha == \$sha[\s\S]*?\.head_branch == "main"[\s\S]*?\.event == "push"[\s\S]*?\.name == "CI"[\s\S]*?\.path == "\.github\/workflows\/ci\.yml"/u.test(
          deploySourceGateJob
        ) &&
        /ci_run_id:\s*\$\{\{\s*steps\.source_ci\.outputs\.run_id\s*\}\}/u.test(
          deploySourceGateJob
        ) &&
        /ci_run_attempt:\s*\$\{\{\s*steps\.source_ci\.outputs\.run_attempt\s*\}\}/u.test(
          deploySourceGateJob
        ) &&
        !/github\.event\.workflow_run/u.test(deploySourceGateJob) &&
        deployBuildOnceJob.length > 0 &&
        /needs:\s*\r?\n\s+- source-gate/u.test(deployBuildOnceJob) &&
        !/^    if:/mu.test(deployBuildOnceJob) &&
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
        ).length === 5 &&
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
        /canonical stack tag merger backfills identity without weakening recovery snapshots/u.test(
          awsRecoveryTests
        ) &&
        /Application/u.test(canonicalStackTagMerger) &&
        /Environment/u.test(canonicalStackTagMerger) &&
        /ArchonGreenfieldOwner/u.test(canonicalStackTagMerger) &&
        /bash -n aws\/merge-canonical-stack-tags\.sh/u.test(ci) &&
        /bash -n aws\/serialize-sam-stack-tags\.sh/u.test(ci) &&
        (
          deploy.match(
            /bash aws\/merge-canonical-stack-tags\.sh \\\r?\n\s+"\$prior_tags" >"\$target_tags"/gu
          ) ?? []
        ).length === 2 &&
        (
          deploy.match(
            /bash aws\/serialize-sam-stack-tags\.sh \\\r?\n\s+"\$target_tags" >"\$serialized_tags_file"/gu
          ) ?? []
        ).length === 2 &&
        (
          deploy.match(
            /TARGET_STACK_TAGS_SHA256: \$\{\{ steps\.deploy\.outputs\.target_tags_sha256 \}\}/gu
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
          /trap (?:stop_canary_probe|cleanup_deploy_background) EXIT/u.test(
            block
          ) &&
          /sam deploy[\s\S]*?--no-progressbar[\s\S]*?stop_canary_probe[\s\S]*?trap - EXIT/u.test(
            block
          )
      ) &&
        hasExactHostedSmokeContracts(deploy) &&
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
      "product.ci-only-demo-video",
      "Production Readiness",
      hasExactDemoVideoTrigger(demoVideoWorkflow) &&
        /name:\s*Generate exact-release demo video/u.test(
          demoVideoWorkflow
        ) &&
        /actions:\s*read/u.test(demoVideoWorkflow) &&
        /contents:\s*read/u.test(demoVideoWorkflow) &&
        !/id-token:\s*write|configure-aws-credentials/u.test(
          demoVideoWorkflow
        ) &&
        (
          demoVideoWorkflow.match(
            /secrets\.ELEVENLABS_API_KEY/gu
          ) ?? []
        ).length === 1 &&
        /name:\s*Generate timestamped ElevenLabs narration[\s\S]*?environment:\s*\r?\n\s+name:\s*demo-video-production/u.test(
          demoVideoWorkflow
        ) &&
        !/edge-tts|ELEVEN_LABS_KEY|YOUTUBE|VIMEO/iu.test(
          demoVideoWorkflow
        ) &&
        /DEMO_VIDEO_PHASE:\s*initial/u.test(demoVideoWorkflow) &&
        /DEMO_VIDEO_PHASE:\s*terminal/u.test(demoVideoWorkflow) &&
        /Require main-ref exact-SHA dispatch before any paid call[\s\S]*?refs\/heads\/main[\s\S]*?DISPATCH_SHA[\s\S]*?EXPECTED_SHA/u.test(
          demoVideoWorkflow
        ) &&
        (
          demoVideoWorkflow.match(
            /ref:\s*\$\{\{\s*inputs\.exact_sha\s*\}\}/gu
          ) ?? []
        ).length === 4 &&
        !/ref:\s*main\s*$/mu.test(demoVideoWorkflow) &&
        /Validate exact hosted release evidence and live proof[\s\S]*?encoded_token[\s\S]*?require_no_grep_match -F[\s\S]*?DEMO_VIDEO_RELEASE_RECEIPT/u.test(
          demoVideoWorkflow
        ) &&
        demoVideoWorkflow.includes('receipt_base64="$(') &&
        demoVideoWorkflow.includes('mktemp --tmpdir="${receipt_dir}"') &&
        demoVideoWorkflow.includes("base64 --decode") &&
        demoVideoWorkflow.includes('test ! -L "${receipt_temp}"') &&
        demoVideoWorkflow.includes(
          'mv -n -- "${receipt_temp}" "${DEMO_VIDEO_RELEASE_RECEIPT}"'
        ) &&
        /demo-video-release-gate\.ts/u.test(demoVideoWorkflow) &&
        /capture-production\.mjs/u.test(demoVideoWorkflow) &&
        /generate-narration\.mjs/u.test(demoVideoWorkflow) &&
        /install-pinned-ffmpeg-linux\.sh/u.test(
          demoVideoWorkflow
        ) &&
        /verify-video\.mjs/u.test(demoVideoWorkflow) &&
        /assert-video-receipt\.mjs/u.test(demoVideoWorkflow) &&
        /video-gate:/u.test(ci) &&
        /media-gate-selftest\.mjs/u.test(ci) &&
        /Initialize runner-temp media root[\s\S]*?DEMO_VIDEO_ROOT=\$\{RUNNER_TEMP\}\/archon-demo-video-selftest[\s\S]*?GITHUB_ENV/u.test(
          ci
        ) &&
        !/DEMO_VIDEO_ROOT:\s*\$\{\{\s*runner\.temp/u.test(ci) &&
        /\$\{\{\s*runner\.temp\s*\}\}\/archon-demo-video/u.test(
          demoVideoWorkflow
        ) &&
        !/DEMO_VIDEO_(?:ROOT|RELEASE_RECEIPT):\s*\$\{\{\s*runner\.temp/u.test(
          demoVideoWorkflow
        ) &&
        (
          demoVideoWorkflow.match(
            /echo "DEMO_VIDEO_ROOT=\$\{RUNNER_TEMP\}\/archon-demo-video" >>"\$\{GITHUB_ENV\}"/gu
          ) ?? []
        ).length === 4 &&
        (
          demoVideoWorkflow.match(
            /echo "DEMO_VIDEO_RELEASE_RECEIPT=\$\{RUNNER_TEMP\}\/archon-demo-video\/release\/video-release-binding\.json" >>"\$\{GITHUB_ENV\}"/gu
          ) ?? []
        ).length === 2 &&
        /retention-days:\s*14/u.test(demoVideoWorkflow) &&
        /compression-level:\s*0/u.test(demoVideoWorkflow) &&
        /archon\.demo-video-publication/u.test(demoVideoWorkflow) &&
        /archon-demo-video-provenance-\$\{\{\s*inputs\.exact_sha\s*\}\}-\$\{\{\s*github\.run_id\s*\}\}-\$\{\{\s*github\.run_attempt\s*\}\}/u.test(
          demoVideoWorkflow
        ) &&
        /Upload verified review package[\s\S]*?Create canonical publication provenance[\s\S]*?Upload canonical publication provenance[\s\S]*?Revalidate exact main after artifact publication/u.test(
          demoVideoWorkflow
        ) &&
        /Create canonical publication provenance[\s\S]*?archon\.demo-video-publication[\s\S]*?require_no_grep_match -i -E -e[\s\S]*?Upload canonical publication provenance/u.test(
          demoVideoWorkflow
        ) &&
        /package_artifact_digest="sha256:\$\{ARTIFACT_DIGEST\}"/u.test(
          demoVideoWorkflow
        ) &&
        /--arg packageArtifactDigest "\$\{package_artifact_digest\}"/u.test(
          demoVideoWorkflow
        ) &&
        (
          demoVideoWorkflow.match(
            /\[\[ "\$\{(?:ARTIFACT_DIGEST|PROVENANCE_ARTIFACT_DIGEST)\}" =~ \^\[0-9a-f\]\{64\}\$ \]\]/gu
          ) ?? []
        ).length === 3 &&
        !/!\s+(?:grep|rg)\b/u.test(demoVideoWorkflow) &&
        !/\brg\b/u.test(demoVideoWorkflow) &&
        (
          demoVideoWorkflow.match(/if grep --quiet "\$@"; then/gu) ?? []
        ).length === 5 &&
        (
          demoVideoWorkflow.match(
            /require_no_grep_match -i -E -e/gu
          ) ?? []
        ).length === 4 &&
        (
          demoVideoWorkflow.match(
            /artifact_run_attempt:\s*\$\{\{\s*steps\.artifact_attempt\.outputs\.artifact_run_attempt\s*\}\}/gu
          ) ?? []
        ).length === 3 &&
        /demo-video-release-\$\{\{\s*inputs\.exact_sha\s*\}\}-\$\{\{\s*github\.run_id\s*\}\}-\$\{\{\s*needs\.source-gate\.outputs\.artifact_run_attempt\s*\}\}/u.test(
          demoVideoWorkflow
        ) &&
        /demo-video-narration-\$\{\{\s*inputs\.exact_sha\s*\}\}-\$\{\{\s*github\.run_id\s*\}\}-\$\{\{\s*needs\.narrate\.outputs\.artifact_run_attempt\s*\}\}/u.test(
          demoVideoWorkflow
        ) &&
        /demo-video-capture-\$\{\{\s*inputs\.exact_sha\s*\}\}-\$\{\{\s*github\.run_id\s*\}\}-\$\{\{\s*needs\.capture\.outputs\.artifact_run_attempt\s*\}\}/u.test(
          demoVideoWorkflow
        ) &&
        /Validate producer artifact attempt bindings/u.test(
          demoVideoWorkflow
        ) &&
        /Prove all eight hash-bound screenshots are package inputs/u.test(
          demoVideoWorkflow
        ) &&
        (
          demoVideoWorkflow.match(
            /-mindepth 1 -maxdepth 1 -print0/gu
          ) ?? []
        ).length === 2 &&
        (
          demoVideoWorkflow.match(
            /od -An -tx1 -j12 -N4 -- "\$\{screenshot\}"/gu
          ) ?? []
        ).length === 2 &&
        (
          demoVideoWorkflow.match(
            /od -An -tx1 -j16 -N8 -- "\$\{screenshot\}"/gu
          ) ?? []
        ).length === 2 &&
        [
          "01-hook.png",
          "02-scope-architecture.png",
          "03-recall-grounding.png",
          "04-audit-conflict.png",
          "05-audit-absence.png",
          "06-proof-ledger.png",
          "07-managed-mcp.png",
          "08-close.png",
        ].every(
          (name) =>
            demoVideoWorkflow.includes(
              `runner.temp }}/archon-demo-video/capture/${name}`
            )
        ) &&
        /EXPECTED_CAPTURE_SCREENSHOTS/u.test(demoVideoLibrary) &&
        /Capture receipt must bind the eight canonical screenshots/u.test(
          demoVideoLibrary
        ) &&
        /DEMO_VIDEO_SOURCE_GATE_ATTEMPT/u.test(
          demoVideoReleaseGate
        ) &&
        /workflowRunsPath\("deploy-aws\.yml",\s*"push",\s*sha\)/u.test(
          demoVideoReleaseGate
        ) &&
        !/workflowRunsPath\("security-dast\.yml"/u.test(
          demoVideoReleaseGate
        ) &&
        /requireDemoVideoDeployContract\(/u.test(
          demoVideoReleaseGate
        ) &&
        demoVideoReleaseGate.includes(
          "Reconcile CockroachDB memory release / Schema, runtime RLS, C-SPANN, and resolution-loop execution proof"
        ) &&
        /hosted-dast-\$\{sha\}-\$\{deployRun\.id\}-\$\{deployRun\.run_attempt\}/u.test(
          demoVideoReleaseGate
        ) &&
        demoVideoReleaseGate.includes("fsConstants.O_NOFOLLOW") &&
        demoVideoReleaseGate.includes(
          'throw new Error("This runner cannot enforce no-follow receipt reads")'
        ) &&
        demoVideoReleaseGate.includes("fstatSync(descriptor, { bigint: true })") &&
        demoVideoReleaseGate.includes("process.stdout.write(receiptHandoff)") &&
        !demoVideoReleaseGate.includes("readFileSync(path") &&
        /voiceRightsAttested:\s*true/u.test(demoVideoWorkflow) &&
        /managed-mcp-proof-\$\{\{\s*github\.run_id\s*\}\}-\$\{\{\s*github\.run_attempt\s*\}\}/u.test(
          managedMcpWorkflow
        ) &&
        /managed-mcp-proof-\$\{runs\.mcp\.id\}-\$\{runs\.mcp\.run_attempt\}/u.test(
          demoVideoReleaseGate
        ) &&
        /archon\.demo-video-plan/u.test(videoScenePlan) &&
        /"targetDurationSeconds":\s*170/u.test(videoScenePlan) &&
        [
          "hook",
          "scope-architecture",
          "recall-grounding",
          "audit",
          "proof",
          "managed-mcp",
          "close",
        ].every((scene) => videoScenePlan.includes(`"id": "${scene}"`)) &&
        /RUNNER_TEMP/u.test(demoVideoLibrary) &&
        /realpath|lstat|symlink/iu.test(demoVideoLibrary) &&
        /with-timestamps/u.test(demoVideoNarration) &&
        /ELEVENLABS_API_KEY/u.test(demoVideoNarration) &&
        demoVideoNarration.includes("const CANONICAL_VOICE") &&
        demoVideoNarration.includes(
          "NARRATION_MAX_WORDS_PER_MINUTE = 85"
        ) &&
        demoVideoNarration.includes("canonicalNarrationForScene") &&
        demoVideoNarration.includes("requireCanonicalVoice") &&
        demoVideoNarration.includes("validateNarrationWordBudgets(plan)") &&
        demoVideoTests.includes(
          "narration prevalidates the final scene before secrets, files, or requests"
        ) &&
        demoVideoTests.includes(
          "canonical narration stays within the deterministic eighty-five-WPM budget"
        ) &&
        !/edge-tts/iu.test(demoVideoNarration) &&
        /async function ensureCaptureOverlay/u.test(demoVideoCapture) &&
        /getImageData\(0, 0, 1, 1\)/u.test(demoVideoCapture) &&
        /style\.setProperty\([\s\S]*?"background-color"[\s\S]*?"important"/u.test(
          demoVideoCapture
        ) &&
        /marker failed computed-RGBA geometry verification/u.test(
          demoVideoCapture
        ) &&
        demoVideoCapture.includes(
          "export async function resolveCanonicalAuditLocators(page)"
        ) &&
        demoVideoCapture.includes(
          "The capture highlight target was not unique."
        ) &&
        demoVideoCapture.includes('.filter({ hasText: "€15,375" })') &&
        demoVideoCapture.includes('.filter({ hasText: "€6,775" })') &&
        !demoVideoCapture.includes(
          'getByRole("heading", { name: /INV-2043/u })'
        ) &&
        /Verify video marker, strict scene locators, and DOM reinjection in Chromium[\s\S]*?working-directory:\s*web[\s\S]*?node video\/capture-marker-selftest\.mjs/u.test(
          ci
        ) &&
        /activateScene\(page, SCENES\[0\], CARD\)[\s\S]*?document\.getElementById\(id\)\?\.remove\(\)[\s\S]*?activateScene\(page, SCENES\[1\], CARD\)/u.test(
          demoVideoCaptureMarkerSelfTest
        ) &&
        demoVideoCaptureMarkerSelfTest.includes(
          "The strict audit-locator fixture did not reproduce the ambiguous heading"
        ) &&
        demoVideoCaptureMarkerSelfTest.includes(
          "resolveCanonicalAuditLocators(page)"
        ) &&
        /libx264/u.test(demoVideoBuilder) &&
        /loudnorm/u.test(demoVideoBuilder) &&
        /yuv420p/u.test(demoVideoBuilder) &&
        /fullDecodePassed|full decode/iu.test(demoVideoVerifier) &&
        /caption/iu.test(demoVideoVerifier) &&
        /scene/iu.test(demoVideoVerifier) &&
        /mis-?order|scene/iu.test(demoVideoMediaSelfTest) &&
        /caption/iu.test(demoVideoMediaSelfTest) &&
        /mismatch|tamper/iu.test(demoVideoMediaSelfTest) &&
        /sha256/iu.test(demoVideoReceiptGate) &&
        /autobuild-2026-07-19-13-12/u.test(
          demoVideoFfmpegInstaller
        ) &&
        /b8ed29dc71fe17f05f43e2d9dbfde89edf43270c3de13ce3c4d70f5df1f47e61/u.test(
          demoVideoFfmpegInstaller
        ) &&
        demoVideoCapture.includes(
          'const CANONICAL_ORIGIN = "https://d2s5v0o0eg2aaw.cloudfront.net";'
        ) &&
        /INV-2043/u.test(demoVideoCapture) &&
        /PAY-118/u.test(demoVideoCapture) &&
        /C-SPANN/u.test(demoVideoCapture) &&
        /9\s*\/\s*9\s*\/\s*9/u.test(demoVideoCapture) &&
        /function sanitizedFailureMessage\(error\)/u.test(
          demoVideoCapture
        ) &&
        /Production capture failed closed in the hosted CI runner: \$\{sanitizedFailureMessage\(/u.test(
          demoVideoCapture
        ) &&
        /\.slice\(0, 500\)/u.test(demoVideoCapture) &&
        !/console\.error\(\s*error\s*\)/u.test(demoVideoCapture) &&
        /env\.GITHUB_SHA !== sourceSha/u.test(
          demoVideoNarration
        ) &&
        /rejects a GITHUB_SHA mismatch before secrets, files, or API calls/u.test(
          demoVideoTests
        ) &&
        /wrong|reject|tamper|mismatch/iu.test(demoVideoTests) &&
        /demo-video\.test\.ts/u.test(packageSource),
      "The exact-release browser demo is generated, narrated, composed, and independently media-gated only in hosted CI with runner-temp outputs.",
      "The CI-only exact-release video pipeline, media verifier, or negative regression coverage is incomplete."
    ),
    sourceCheck(
      "product.hosted-submission-boundary",
      "Production Readiness",
      hasExactSubmissionWorkflowContract(submissionWorkflow) &&
        !/configure-aws-credentials|secrets\./u.test(
          submissionWorkflow
        ) &&
        /const WORKFLOW_REF =\s+`\$\{REPOSITORY\}\/\.github\/workflows\/submission-readiness\.yml@refs\/heads\/main`/u.test(
          finalSubmissionGate
        ) &&
        /selectSuccessfulRun\([\s\S]*?"CI"[\s\S]*?"CodeQL"[\s\S]*?"Deploy AWS"[\s\S]*?"Cockroach Cloud Managed MCP Audit"[\s\S]*?"Recover AWS"/u.test(
          finalSubmissionGate
        ) &&
        /DAST must belong to Deploy AWS and all independent audits must start after deploy completes/u.test(
          finalSubmissionGate
        ) &&
        !/selectedRuns\.hostedDast/u.test(finalSubmissionGate) &&
        /selectedRuns\.demoVideo = toSelectedRun\(demoVideoRun\)/u.test(
          finalSubmissionGate
        ) &&
        /selectBoundSuccessfulDemoVideoRun\(/u.test(
          finalSubmissionGate
        ) &&
        (
          finalSubmissionGate.match(
            /requireSuccessfulDemoVideoJobs\(/gu
          ) ?? []
        ).length >= 3 &&
        (
          finalSubmissionGate.match(
            /selectExactDemoVideoArtifacts\(/gu
          ) ?? []
        ).length >= 3 &&
        /githubDemoVideoPublication\(/u.test(finalSubmissionGate) &&
        /export async function readBoundedResponseBody\(/u.test(
          finalSubmissionGate
        ) &&
        /response body exceeds its byte bound/u.test(
          finalSubmissionGate
        ) &&
        !/response\.arrayBuffer\(\)/u.test(finalSubmissionGate) &&
        /SUBMISSION_VIDEO_UPLOADED_FROM_CI_ARTIFACT_ATTESTED/u.test(
          finalSubmissionGate
        ) &&
        /selectedArtifacts\.demoVideoPackage = toSelectedArtifact/u.test(
          finalSubmissionGate
        ) &&
        /selectedArtifacts\.demoVideoProvenance = toSelectedArtifact/u.test(
          finalSubmissionGate
        ) &&
        /selectedArtifacts\.demoVideoRelease = toSelectedArtifact/u.test(
          finalSubmissionGate
        ) &&
        /selectedArtifacts\.demoVideoNarration = toSelectedArtifact/u.test(
          finalSubmissionGate
        ) &&
        /selectedArtifacts\.demoVideoCapture = toSelectedArtifact/u.test(
          finalSubmissionGate
        ) &&
        /Demo-video producer, package, or provenance artifact changed while the gate was running/u.test(
          finalSubmissionGate
        ) &&
        /Exact-SHA \$\{key\} run metadata changed while the gate was running/u.test(
          finalSubmissionGate
        ) &&
        (
          finalSubmissionGate.match(
            /jobs\?filter=all&per_page=100/gu
          ) ?? []
        ).length === 2 &&
        /job\.run_attempt/u.test(finalSubmissionGate) &&
        /Demo-video producer job attempts changed while the gate was running/u.test(
          finalSubmissionGate
        ) &&
        (
          finalSubmissionGate.match(
            /requireSuccessfulHostedDastJobs\(/gu
          ) ?? []
        ).length >= 3 &&
        (
          finalSubmissionGate.match(
            /requireSuccessfulDeployJobs\(/gu
          ) ?? []
        ).length >= 3 &&
        /actions\/runs\/\$\{deployRun\.id\}\/attempts\/\$\{deployRun\.run_attempt\}\/jobs\?per_page=100/u.test(
          finalSubmissionGate
        ) &&
        /selectExactHostedDastArtifact\(/u.test(finalSubmissionGate) &&
        /requireExactHostedDastReceipt\(/u.test(finalSubmissionGate) &&
        /selectedArtifacts\.hostedDastZap = toSelectedArtifact/u.test(
          finalSubmissionGate
        ) &&
        /terminalHostedDastZapArtifact\.digest !==/u.test(
          finalSubmissionGate
        ) &&
        /hosted-dast-\$\{sha\}-\$\{deployRun\.id\}-\$\{deployRun\.run_attempt\}/u.test(
          finalSubmissionGate
        ) &&
        /terminalHostedDastArtifact\.digest !== hostedDastArtifact\.digest/u.test(
          finalSubmissionGate
        ) &&
        /requireSuccessfulRecoveryAuditJobs/u.test(finalSubmissionGate) &&
        /Terminal exact Deploy AWS jobs/u.test(finalSubmissionGate) &&
        /Terminal exact Deploy AWS artifacts containing Hosted DAST/u.test(
          finalSubmissionGate
        ) &&
        /must have completed within 24 hours/u.test(finalSubmissionGate) &&
        /release\?\.commitSha !== sha/u.test(finalSubmissionGate) &&
        /\^archon_production_\[0-9a-f\]\{10\}\$/u.test(
          finalSubmissionGate
        ) &&
        /Post-submit must chain to a successful pre-submit gate from the last 24 hours/u.test(
          finalSubmissionGate
        ) &&
        /\/api\/health[\s\S]*?\/api\/proof[\s\S]*?\/api\/recall[\s\S]*?\/api\/audit/u.test(
          finalSubmissionGate
        ) &&
        hasExactTrimmedLine(
          finalSubmissionGate,
          'const YOUTUBE_OEMBED_ENDPOINT = "https://www.youtube.com/oembed";'
        ) &&
        hasExactTrimmedLine(
          finalSubmissionGate,
          'const VIMEO_OEMBED_ENDPOINT = "https://vimeo.com/api/oembed.json";'
        ) &&
        includesEvery(finalSubmissionGate, [
          'import { parse } from "parse5";',
          "const document = parse(html, {",
          "scriptingEnabled: true,",
          "const oembedUrl = new URL(",
          "? YOUTUBE_OEMBED_ENDPOINT",
          ": VIMEO_OEMBED_ENDPOINT",
          'oembedUrl.searchParams.set("url", identity.canonicalUrl);',
          'oembedUrl.searchParams.set("format", "json");',
          "await fetchJson(oembedUrl.href,",
        ]) &&
        /"parse5":\s*"7\.3\.0"/u.test(packageSource) &&
        /submission-readiness-receipt\.json/u.test(
          finalSubmissionGate
        ),
      "A manual, read-only pre/post submission gate re-proves exact-main CI, deployment, exact-release DAST jobs, independent audits, live contracts, public video, thumbnail, and final Devpost state with a sanitized runner-temp receipt.",
      "The hosted final submission boundary is incomplete or can bypass its evidence contract."
    ),
    sourceCheck(
      "product.versioned-submission-package",
      "Production Readiness",
      /^status: submission-copy-complete$/mu.test(devpostSubmission) &&
        /^# Archon Memory$/mu.test(devpostSubmission) &&
        /^## Inspiration$/mu.test(devpostSubmission) &&
        /^## What it does$/mu.test(devpostSubmission) &&
        /^## How we used CockroachDB$/mu.test(devpostSubmission) &&
        /Distributed Vector Indexing/u.test(devpostSubmission) &&
        /CockroachDB Cloud Managed MCP/u.test(devpostSubmission) &&
        /^## How we used AWS$/mu.test(devpostSubmission) &&
        /^## Prior-work disclosure$/mu.test(devpostSubmission) &&
        /1 July 2026/u.test(devpostSubmission) &&
        /^## What's next$/mu.test(devpostSubmission) &&
        !/\b(?:TODO|TBD|PENDING)\b/iu.test(devpostSubmission) &&
        /^Target runtime: \*\*2:50 \(170 seconds\)\*\*[ \t]*\r?$/mu.test(
          videoPlan
        ) &&
        /^Hard limit: \*\*strictly under 3:00\*\*[ \t]*\r?$/mu.test(
          videoPlan
        ) &&
        /separate deterministic release controller uses CockroachDB Cloud Managed MCP/u.test(
          videoPlan
        ) &&
        /No generated video, frames, audio, or editing output belongs in this repository/u.test(
          videoPlan
        ) &&
        validSubmissionThumbnail() !== undefined,
      "The English Devpost copy, final recording plan, and owned 3:2 thumbnail are complete and versioned without local video output.",
      "The versioned submission copy, recording plan, or owned thumbnail is incomplete."
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

export type SubmissionVideoProvider = "youtube" | "vimeo";

export interface SubmissionVideoIdentity {
  provider: SubmissionVideoProvider;
  id: string;
  canonicalUrl: string;
}

export interface SubmissionThumbnailMetadata {
  width: number;
  height: number;
  bytes: number;
}

export interface ValidatedSubmissionThumbnail
  extends SubmissionThumbnailMetadata {
  sha256: string;
}

const PNG_CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

function pngCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = PNG_CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function parseCanonicalSubmissionVideoUrl(
  value: string | undefined
): SubmissionVideoIdentity | undefined {
  if (!value || value.trim() !== value) return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.port !== "" ||
      url.hash !== ""
    ) {
      return undefined;
    }

    const host = url.hostname.toLowerCase();
    const youtubeId = /^[A-Za-z0-9_-]{11}$/u;
    if (
      host === "www.youtube.com" &&
      url.pathname === "/watch" &&
      [...url.searchParams.keys()].length === 1 &&
      url.searchParams.has("v")
    ) {
      const id = url.searchParams.get("v") ?? "";
      const canonicalUrl = `https://www.youtube.com/watch?v=${id}`;
      return youtubeId.test(id) && value === canonicalUrl
        ? { provider: "youtube", id, canonicalUrl }
        : undefined;
    }

    if (
      host === "youtu.be" &&
      url.search === "" &&
      youtubeId.test(url.pathname.slice(1)) &&
      /^\/[A-Za-z0-9_-]{11}$/u.test(url.pathname)
    ) {
      const id = url.pathname.slice(1);
      const identity = {
        provider: "youtube",
        id,
        canonicalUrl: `https://youtu.be/${id}`,
      } as const;
      return value === identity.canonicalUrl ? identity : undefined;
    }

    if (
      host === "vimeo.com" &&
      url.search === "" &&
      /^\/[1-9][0-9]*$/u.test(url.pathname)
    ) {
      const id = url.pathname.slice(1);
      const identity = {
        provider: "vimeo",
        id,
        canonicalUrl: `https://vimeo.com/${id}`,
      } as const;
      return value === identity.canonicalUrl ? identity : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function validSubmissionVideoDuration(
  value: string | undefined
): boolean {
  if (!value || value.trim() !== value || !/^[1-9][0-9]{0,2}$/u.test(value)) {
    return false;
  }
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds < 180;
}

export function validDevpostSubmissionUrl(
  value: string | undefined
): boolean {
  if (!value || value.trim() !== value) return false;
  try {
    const url = new URL(value);
    const canonical =
      `https://devpost.com${url.pathname}`;
    return (
      value === canonical &&
      url.protocol === "https:" &&
      url.hostname.toLowerCase() === "devpost.com" &&
      /^\/software\/[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(url.pathname) &&
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

export function inspectSubmissionThumbnail(
  bytes: Uint8Array
): SubmissionThumbnailMetadata | undefined {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (
    buffer.length < 57 ||
    buffer.length > MAX_SUBMISSION_THUMBNAIL_BYTES ||
    signature.some((value, index) => buffer[index] !== value)
  ) {
    return undefined;
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  let sawHeader = false;
  let sawImageData = false;
  let sawEnd = false;
  let imageDataClosed = false;
  const compressedParts: Buffer[] = [];
  try {
    while (offset < buffer.length) {
      if (offset + 12 > buffer.length) return undefined;
      const length = buffer.readUInt32BE(offset);
      const typeStart = offset + 4;
      const dataStart = offset + 8;
      const dataEnd = dataStart + length;
      const chunkEnd = dataEnd + 4;
      if (dataEnd < dataStart || chunkEnd > buffer.length) return undefined;
      const type = buffer.toString("ascii", typeStart, dataStart);
      if (!/^[A-Za-z]{4}$/u.test(type)) return undefined;
      const expectedCrc = buffer.readUInt32BE(dataEnd);
      if (
        pngCrc32(buffer.subarray(typeStart, dataEnd)) !== expectedCrc
      ) {
        return undefined;
      }

      if (!sawHeader) {
        if (type !== "IHDR" || length !== 13) return undefined;
        width = buffer.readUInt32BE(dataStart);
        height = buffer.readUInt32BE(dataStart + 4);
        const bitDepth = buffer[dataStart + 8];
        const colorType = buffer[dataStart + 9];
        const compression = buffer[dataStart + 10];
        const filter = buffer[dataStart + 11];
        const interlace = buffer[dataStart + 12];
        if (
          width < 1200 ||
          height < 800 ||
          width > 4096 ||
          height > 4096 ||
          width * 2 !== height * 3 ||
          bitDepth !== 8 ||
          (colorType !== 2 && colorType !== 6) ||
          compression !== 0 ||
          filter !== 0 ||
          interlace !== 0
        ) {
          return undefined;
        }
        channels = colorType === 2 ? 3 : 4;
        sawHeader = true;
      } else if (type === "IHDR") {
        return undefined;
      } else if (type === "IDAT") {
        if (sawEnd || imageDataClosed || length === 0) return undefined;
        sawImageData = true;
        compressedParts.push(buffer.subarray(dataStart, dataEnd));
      } else if (type === "IEND") {
        if (!sawImageData || length !== 0 || chunkEnd !== buffer.length) {
          return undefined;
        }
        sawEnd = true;
      } else {
        if (sawImageData) imageDataClosed = true;
        // Reject unknown critical chunks; ancillary metadata remains allowed.
        if ((type.charCodeAt(0) & 0x20) === 0 && type !== "PLTE") {
          return undefined;
        }
      }
      offset = chunkEnd;
    }

    if (!sawHeader || !sawImageData || !sawEnd || offset !== buffer.length) {
      return undefined;
    }
    const rowBytes = width * channels;
    const expectedInflatedBytes = (rowBytes + 1) * height;
    if (
      !Number.isSafeInteger(expectedInflatedBytes) ||
      expectedInflatedBytes > 64 * 1024 * 1024
    ) {
      return undefined;
    }
    const inflated = inflateSync(Buffer.concat(compressedParts), {
      maxOutputLength: expectedInflatedBytes,
    });
    if (inflated.length !== expectedInflatedBytes) return undefined;
    for (let row = 0; row < height; row += 1) {
      if (inflated[row * (rowBytes + 1)]! > 4) return undefined;
    }
  } catch {
    return undefined;
  }
  return { width, height, bytes: buffer.length };
}

export function validatedSubmissionThumbnail(
  root = ROOT
): ValidatedSubmissionThumbnail | undefined {
  const thumbnailPath = join(root, SUBMISSION_THUMBNAIL_PATH);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      thumbnailPath,
      constants.O_RDONLY |
        (typeof constants.O_NOFOLLOW === "number"
          ? constants.O_NOFOLLOW
          : 0)
    );
    const opened = fstatSync(descriptor);
    const current = lstatSync(thumbnailPath);
    if (
      !opened.isFile() ||
      !Number.isSafeInteger(opened.size) ||
      opened.size < 57 ||
      opened.size > MAX_SUBMISSION_THUMBNAIL_BYTES ||
      !current.isFile() ||
      current.isSymbolicLink() ||
      opened.dev !== current.dev ||
      opened.ino !== current.ino
    ) {
      return undefined;
    }
    const file = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < file.length) {
      const bytesRead = readSync(
        descriptor,
        file,
        offset,
        file.length - offset,
        offset
      );
      if (bytesRead === 0) return undefined;
      offset += bytesRead;
    }
    if (
      readSync(descriptor, Buffer.alloc(1), 0, 1, file.length) !== 0
    ) {
      return undefined;
    }
    const terminal = fstatSync(descriptor);
    if (
      terminal.size !== opened.size ||
      terminal.mtimeMs !== opened.mtimeMs ||
      terminal.ctimeMs !== opened.ctimeMs
    ) {
      return undefined;
    }
    const metadata = inspectSubmissionThumbnail(file);
    return metadata
      ? {
          ...metadata,
          sha256: createHash("sha256").update(file).digest("hex"),
        }
      : undefined;
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function validSubmissionThumbnail(
  root = ROOT
): SubmissionThumbnailMetadata | undefined {
  const validated = validatedSubmissionThumbnail(root);
  return validated
    ? {
        width: validated.width,
        height: validated.height,
        bytes: validated.bytes,
      }
    : undefined;
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
  const videoUrl = process.env.SUBMISSION_VIDEO_URL;
  const videoDuration = process.env.SUBMISSION_VIDEO_DURATION_SECONDS;
  const videoAttestations =
    process.env.SUBMISSION_VIDEO_PUBLIC_EMBEDDABLE_ATTESTED === "true" &&
    process.env.SUBMISSION_VIDEO_CAPTIONS_ATTESTED === "true";
  const devpostUrl = process.env.DEVPOST_SUBMISSION_URL;
  const publicRepoUrl =
    process.env.SUBMISSION_PUBLIC_REPO_URL?.trim() ||
    "https://github.com/upgradedev/archon-cockroach-memory";
  const thumbnail = validSubmissionThumbnail();

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
        parseCanonicalSubmissionVideoUrl(videoUrl) &&
          validSubmissionVideoDuration(videoDuration) &&
          videoAttestations
      ),
      `Canonical public video supplied with operator-verified duration, visibility, embed, and English captions at ${videoDuration}s: ${videoUrl}`,
      "Set the canonical URL, integer duration, and both video attestations only after the final public, embeddable, captioned <3-minute demo is uploaded."
    ),
    requirement(
      "submission-thumbnail",
      thumbnail !== undefined,
      `Owned ${thumbnail?.width}x${thumbnail?.height} 3:2 PNG is versioned under the 5 MB boundary.`,
      `Add the owned 3:2 PNG at ${SUBMISSION_THUMBNAIL_PATH}.`
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
      process.env.DEVPOST_SUBMITTED === "1" &&
        validDevpostSubmissionUrl(devpostUrl),
      `Operator confirmed the public Devpost submission: ${devpostUrl}`,
      "Set DEVPOST_SUBMITTED=1 with a canonical DEVPOST_SUBMISSION_URL only after the final form has been submitted."
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
