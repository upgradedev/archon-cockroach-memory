#!/usr/bin/env node

import {
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONTRACT_PATH = resolve(
  ROOT,
  "docs",
  "operations",
  "well-architected-contract.json",
);
const FOUNDATION_STORAGE_MIGRATION_POLICY_PATH = resolve(
  ROOT,
  "aws",
  "foundation-storage-migration-policy.json",
);
const INCREMENTAL_FIXED_COST_SCENARIOS = [
  "initial",
  "afterFirstBilledKmsRotation",
  "afterSecondBilledKmsRotation",
];
const EXPECTED_INCREMENTAL_FIXED_COST_TOTALS_CENTS = {
  initial: 2240,
  afterFirstBilledKmsRotation: 2340,
  afterSecondBilledKmsRotation: 2440,
};
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
];
const EXPECTED_INCREMENTAL_FIXED_COST_PRICING_URLS = {
  awsCloudWatch: "https://aws.amazon.com/cloudwatch/pricing/",
  awsKms: "https://aws.amazon.com/kms/pricing/",
  awsSecretsManager: "https://aws.amazon.com/secrets-manager/pricing/",
  awsWaf: "https://aws.amazon.com/waf/pricing/",
};
const EXPECTED_INCREMENTAL_FIXED_COST_VARIABLE_EXCLUSIONS = [
  "AWS WAF requests",
  "CloudWatch Logs ingestion and storage",
  "Amazon S3 storage and requests",
  "Amazon EventBridge events",
  "data transfer",
];
const EXPECTED_INCREMENTAL_FIXED_COST_EXTERNAL_EXCLUSIONS = [
  "taxes",
  "application compute, API, and network services",
  "CockroachDB Cloud",
  "model and inference services",
  "conditional regional alarm-routing control",
  "optional FinOps human notification route",
  "GitHub Actions",
];
const EXPECTED_OWNER_KEYS = [
  "finops",
  "operations",
  "security",
  "sustainability",
  "workload",
];
const EXPECTED_OBJECTIVE_KEYS = [
  "apiP95LatencyMs",
  "availabilityPercent",
  "requestErrorRatePercent",
  "rpoMinutes",
  "rtoMinutes",
];
const EXPECTED_OBJECTIVE_UNITS = {
  apiP95LatencyMs: "milliseconds",
  availabilityPercent: "percent",
  requestErrorRatePercent: "percent",
  rpoMinutes: "minutes",
  rtoMinutes: "minutes",
};
const EXPECTED_CONTROL_IDS = Array.from(
  { length: 10 },
  (_, index) => `WA-${String(index + 1).padStart(2, "0")}`,
);
const DEPLOYMENT_BOUNDARY_FILES = [
  ".github/workflows/bootstrap-aws.yml",
  ".github/workflows/database-release.yml",
  ".github/workflows/deploy-aws.yml",
  ".github/workflows/recover-aws.yml",
  "aws/bootstrap-oidc.yaml",
  "aws/template.yaml",
];
const EDGE_WAF_CONTROL_PLANE_FILE = "aws/edge-waf.yaml";
const FINOPS_CONTROL_PLANE_FILE = "aws/finops.yaml";
const ACCOUNT_SECURITY_BASELINE_FILES = [
  ".github/workflows/aws-security-baseline.yml",
  "aws/audit-account-security-baseline.sh",
  "aws/account-security-baseline-audit-policy.json",
  "docs/runbooks/aws-account-security-baseline.md",
];
const ALARM_ROUTING_CONTROL_FILES = [
  ".github/workflows/alarm-routing-controls.yml",
  "aws/bootstrap-oidc.yaml",
  "aws/bootstrap-stack-policy.json",
  "aws/prove-alarm-routing.sh",
  "docs/runbooks/alarm-response.md",
];
const EDGE_PROTECTION_CONTROL_FILES = [
  ".github/workflows/edge-controls.yml",
  "aws/edge-waf.yaml",
  "aws/edge-stack-policy.json",
  "tests/waf-controls.test.ts",
  "docs/runbooks/waf-abuse-response.md",
];
const FOUNDATION_LIFECYCLE_CONTROL_FILES = [
  ".github/scripts/revalidate-aws-control-plane-fence.sh",
  ".github/workflows/ci.yml",
  ".github/workflows/deploy-aws.yml",
  ".github/workflows/foundation-migration.yml",
  "aws/bootstrap-oidc.yaml",
  "aws/bootstrap-stack-policy.json",
  "aws/foundation-migration-authority.sh",
  "aws/foundation-storage-migration-policy.json",
  "aws/prove-foundation-storage-controls.sh",
  "docs/operations/FOUNDATION_STORAGE_MIGRATION.md",
  "tests/s3-access-logging.test.ts",
];
const SUSTAINABILITY_INTENSITY_FILES = [
  ".github/workflows/sustainability-intensity-evidence.yml",
  "aws/measure-sustainability-intensity.sh",
  "aws/sustainability-intensity-audit-policy.json",
  "docs/runbooks/sustainability-intensity.md",
];
const DATABASE_CREDENTIAL_ROTATION_FILES = [
  ".github/workflows/database-credential-rotation.yml",
  "scripts/rotate-runtime-secret.ts",
  "src/db/client.ts",
  "tests/database-credential-rotation.test.ts",
  "tests/db-client-rotation.test.ts",
  "docs/runbooks/credential-compromise.md",
];
const STAGING_RECOVERY_DRILL_FILES = [
  ".github/workflows/deploy-aws.yml",
  ".github/workflows/recover-aws.yml",
  "aws/template.yaml",
  "aws/bootstrap-oidc.yaml",
  "aws/bootstrap-stack-policy.json",
  "aws/classify-github-recovery-preflight.sh",
  "aws/classify-durable-recovery-source.sh",
  "aws/fetch-codedeploy-appspec-revision.sh",
  "aws/select-staging-codedeploy-rollback.mjs",
  "tests/staging-recovery-drill.test.ts",
  "tests/github-recovery-preflight.test.ts",
  "tests/recovery-watchdog.test.ts",
  "docs/runbooks/rollback-recovery.md",
];
const MANAGED_RESTORE_DRILL_FILES = [
  ".github/workflows/cockroach-restore-drill.yml",
  "scripts/cockroach-managed-restore-drill.ts",
  "tests/cockroach-managed-restore-drill.test.ts",
  "docs/runbooks/database-restore.md",
];
const HOSTED_PERFORMANCE_EVIDENCE_FILES = [
  ".github/workflows/hosted-load-evidence.yml",
  "load/hosted-recall.js",
  "load/hosted-recall-contract.js",
  "load/k6-summary-schema-smoke.js",
  "tests/hosted-load-evidence.test.ts",
];
const FINOPS_CONTROL_FILES = [
  ".github/workflows/finops-controls.yml",
  "aws/finops.yaml",
  "tests/finops-controls.test.ts",
  "docs/finops/COST_MODEL.md",
  "docs/runbooks/cost-anomaly.md",
];

function parseArguments(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error("Arguments must be supplied as --name value pairs.");
    }
    parsed[key.slice(2)] = value;
  }
  return parsed;
}

const args = parseArguments(process.argv.slice(2));
const mode = args.mode;
if (mode !== "repository" && mode !== "live-read-only") {
  throw new Error("Mode must be repository or live-read-only.");
}

const runnerTemp = process.env.RUNNER_TEMP;
if (!runnerTemp) {
  throw new Error("RUNNER_TEMP is required; this audit is CI-only.");
}
const receiptPath = resolve(args.receipt ?? "");
const resolvedRunnerTemp = resolve(runnerTemp);
if (
  !receiptPath ||
  (receiptPath !== resolvedRunnerTemp &&
    !receiptPath.startsWith(`${resolvedRunnerTemp}${sep}`))
) {
  throw new Error("The receipt path must remain under RUNNER_TEMP.");
}

const checks = [];
function check(id, condition, detail) {
  checks.push({
    id,
    status: condition ? "pass" : "fail",
    detail,
  });
}

function sortedKeys(value) {
  return Object.keys(value ?? {}).sort();
}

function sameStrings(left, right) {
  return (
    Array.isArray(left) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactObjectKeys(value, expectedKeys) {
  return isRecord(value) && sameStrings(sortedKeys(value), [...expectedKeys].sort());
}

function usdToCents(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  const cents = Math.round(value * 100);
  return Math.abs(value - cents / 100) < Number.EPSILON * 100
    ? cents
    : null;
}

function evaluateIncrementalFixedCostContract(value) {
  const invalid = {
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
      Object.keys(EXPECTED_INCREMENTAL_FIXED_COST_PRICING_URLS),
    ) &&
    Object.entries(EXPECTED_INCREMENTAL_FIXED_COST_PRICING_URLS).every(
      ([key, expected]) => pricingUrls[key] === expected,
    );

  const totalsCents = Object.fromEntries(
    INCREMENTAL_FIXED_COST_SCENARIOS.map((scenario) => [scenario, 0]),
  );
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
    const hasScenarioUnits = Object.hasOwn(expected, "billedUnitsByScenario");
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
    const declaredBilledUnits = isRecord(item.billedUnitsByScenario)
      ? item.billedUnitsByScenario
      : {};
    lineItemsValid &&= hasExactObjectKeys(
      declaredMonthly,
      INCREMENTAL_FIXED_COST_SCENARIOS,
    );
    if (hasScenarioUnits) {
      lineItemsValid &&= hasExactObjectKeys(
        declaredBilledUnits,
        INCREMENTAL_FIXED_COST_SCENARIOS,
      );
    }

    for (const scenario of INCREMENTAL_FIXED_COST_SCENARIOS) {
      const billedUnits = hasScenarioUnits
        ? declaredBilledUnits[scenario]
        : item.quantity;
      const expectedBilledUnits = hasScenarioUnits
        ? expected.billedUnitsByScenario[scenario]
        : expected.quantity;
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
    contract.maximumExpectedMonthlyUsd,
  );
  const ceilingCents = usdToCents(contract.approvedCeilingMonthlyUsd);
  const maximumAndCeilingValid =
    declaredMaximumCents === maximumCents &&
    maximumCents === 2440 &&
    ceilingCents === 2600 &&
    maximumCents < ceilingCents &&
    contract.ceilingComparison === "strictly-less-than";
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
    sameStrings(
      contract.variableUsageChargesExcluded,
      EXPECTED_INCREMENTAL_FIXED_COST_VARIABLE_EXCLUSIONS,
    ) &&
    sameStrings(
      contract.externalAndOutOfScopeChargesExcluded,
      EXPECTED_INCREMENTAL_FIXED_COST_EXTERNAL_EXCLUSIONS,
    );

  return {
    valid,
    scenarioMonthlyUsd: Object.fromEntries(
      INCREMENTAL_FIXED_COST_SCENARIOS.map((scenario) => [
        scenario,
        totalsCents[scenario] / 100,
      ]),
    ),
    maximumMonthlyUsd: maximumCents / 100,
    approvedCeilingMonthlyUsd:
      ceilingCents === null ? null : ceilingCents / 100,
    headroomMonthlyUsd:
      ceilingCents === null ? null : (ceilingCents - maximumCents) / 100,
  };
}

function readRepositorySource(path) {
  try {
    return readFileSync(resolve(ROOT, path), "utf8");
  } catch {
    return "";
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function extractNamedWorkflowStep(source, name) {
  return (
    source.match(
      new RegExp(
        `(?:^|\\r?\\n)      - name: ${escapeRegExp(name)}\\r?\\n[\\s\\S]*?(?=\\r?\\n      - name: |$)`,
        "u",
      ),
    )?.[0] ?? ""
  );
}

function extractNamedWorkflowJob(source, id) {
  return (
    source.match(
      new RegExp(
        `(?:^|\\r?\\n)  ${escapeRegExp(id)}:\\r?\\n[\\s\\S]*?(?=\\r?\\n  [A-Za-z0-9_-]+:\\r?\\n|$)`,
        "u",
      ),
    )?.[0] ?? ""
  );
}

function isAssignedOwner(owner) {
  return (
    owner?.status === "assigned" &&
    typeof owner.value === "string" &&
    owner.value.trim().length > 0 &&
    !/^(tbd|todo|unknown|unassigned|n\/a)$/i.test(owner.value.trim())
  );
}

function isPendingOwner(owner) {
  return (
    owner?.status === "pending-human-assignment" &&
    owner.value === null &&
    owner.requiredForLiveActivation === true
  );
}

function isApprovedObjective(key, objective) {
  const numericValueIsValid =
    objective?.status === "approved" &&
    typeof objective.value === "number" &&
    Number.isFinite(objective.value) &&
    objective.unit === EXPECTED_OBJECTIVE_UNITS[key];
  if (!numericValueIsValid) {
    return false;
  }
  if (key === "availabilityPercent") {
    return objective.value > 0 && objective.value <= 100;
  }
  if (key === "requestErrorRatePercent") {
    return objective.value >= 0 && objective.value < 100;
  }
  if (key === "rpoMinutes") {
    return objective.value >= 0;
  }
  return objective.value > 0;
}

function isPendingObjective(key, objective) {
  return (
    objective?.status === "pending-human-decision" &&
    objective.value === null &&
    objective.unit === EXPECTED_OBJECTIVE_UNITS[key] &&
    objective.requiredForLiveActivation === true
  );
}

let contract = {};
try {
  contract = JSON.parse(readFileSync(CONTRACT_PATH, "utf8"));
  check(
    "contract-json",
    true,
    "The machine-readable contract is valid JSON.",
  );
} catch (error) {
  check(
    "contract-json",
    false,
    `The machine-readable contract could not be read: ${error.message}`,
  );
}

let foundationStorageMigrationPolicy = {};
let incrementalFixedCostContractJsonValid = false;
try {
  foundationStorageMigrationPolicy = JSON.parse(
    readFileSync(FOUNDATION_STORAGE_MIGRATION_POLICY_PATH, "utf8"),
  );
  incrementalFixedCostContractJsonValid = true;
  check(
    "incremental-fixed-cost-contract-json",
    true,
    "The foundation and edge lifecycle fixed-cost contract is valid JSON.",
  );
} catch (error) {
  check(
    "incremental-fixed-cost-contract-json",
    false,
    `The foundation and edge lifecycle fixed-cost contract could not be read: ${error.message}`,
  );
}
const incrementalFixedCostEvaluation =
  evaluateIncrementalFixedCostContract(foundationStorageMigrationPolicy);
check(
  "incremental-fixed-cost-contract-arithmetic",
  incrementalFixedCostContractJsonValid &&
    incrementalFixedCostEvaluation.valid,
  "The itemized incremental foundation + two edge stacks contract independently recomputes $22.40, $23.40, and $24.40, with the $24.40 maximum strictly below $26.00.",
);

check(
  "contract-identity",
  contract.schema === "archon.aws-well-architected.contract" &&
    contract.version === 1 &&
    contract.workload?.id === "archon-cockroach-memory" &&
    contract.workload?.repository ===
      "upgradedev/archon-cockroach-memory" &&
    contract.workload?.evidenceExecutionBoundary === "github-actions-only",
  "The schema, workload, repository, and CI-only evidence boundary are exact.",
);

check(
  "region-policy",
  contract.regionPolicy?.primaryRegion === "eu-west-1" &&
    sameStrings(contract.regionPolicy?.regionalWorkloadAllowlist, [
      "eu-west-1",
    ]) &&
    sameStrings(contract.regionPolicy?.explicitlyForbiddenRegions, [
      "us-west-2",
    ]) &&
    contract.regionPolicy?.globalFrontDoor === "cloudfront" &&
    contract.regionPolicy
      ?.additionalRegionalWorkloadRequiresExplicitHumanApproval === true &&
    contract.regionPolicy?.additionalRegionalWorkloadRequiresCostApproval ===
      true &&
    contract.regionPolicy?.additionalRegionalWorkloadRequiresTestedRtoRpoPlan ===
      true,
  "Regional workloads are fixed to eu-west-1, us-west-2 is forbidden, and CloudFront is the global front door.",
);

check(
  "non-mutating-activation",
  contract.activation?.defaultMode === "repository" &&
    contract.activation?.liveAuditMode === "live-read-only" &&
    contract.activation?.liveAuditEnvironment === "production-audit" &&
    contract.activation?.liveAuditRequiresExplicitApproval === true &&
    contract.activation?.awsMutationPermitted === false &&
    contract.activation?.provisioningPermitted === false,
  "The default and optional live audit modes are explicit and prohibit provisioning or mutation.",
);

const ownerKeys = sortedKeys(contract.owners);
check(
  "owner-shape",
  sameStrings(ownerKeys, EXPECTED_OWNER_KEYS),
  "All five accountable owner roles are present.",
);
let pendingOwnerCount = 0;
let assignedOwnerCount = 0;
let ownersConsistent = ownerKeys.length === EXPECTED_OWNER_KEYS.length;
for (const owner of Object.values(contract.owners ?? {})) {
  const pending = isPendingOwner(owner);
  const assigned = isAssignedOwner(owner);
  pendingOwnerCount += pending ? 1 : 0;
  assignedOwnerCount += assigned ? 1 : 0;
  ownersConsistent &&= pending || assigned;
}
check(
  "owner-values",
  ownersConsistent,
  "Every owner is either honestly pending or a non-placeholder assigned value.",
);

const objectiveKeys = sortedKeys(contract.objectives);
check(
  "objective-shape",
  sameStrings(objectiveKeys, EXPECTED_OBJECTIVE_KEYS),
  "Availability, latency, error-rate, RTO, and RPO objectives are present.",
);
let pendingObjectiveCount = 0;
let approvedObjectiveCount = 0;
let objectivesConsistent =
  objectiveKeys.length === EXPECTED_OBJECTIVE_KEYS.length;
for (const [key, objective] of Object.entries(contract.objectives ?? {})) {
  const pending = isPendingObjective(key, objective);
  const approved = isApprovedObjective(key, objective);
  pendingObjectiveCount += pending ? 1 : 0;
  approvedObjectiveCount += approved ? 1 : 0;
  objectivesConsistent &&= pending || approved;
}
check(
  "objective-values",
  objectivesConsistent,
  "Every objective is either honestly pending or an approved numeric value.",
);

if (mode === "live-read-only") {
  check(
    "live-owner-activation",
    assignedOwnerCount === EXPECTED_OWNER_KEYS.length,
    "A live audit requires every accountable owner to be assigned.",
  );
  check(
    "live-objective-activation",
    approvedObjectiveCount === EXPECTED_OBJECTIVE_KEYS.length,
    "A live audit requires approved availability, latency, error-rate, RTO, and RPO values.",
  );
} else {
  check(
    "repository-placeholders",
    pendingOwnerCount + assignedOwnerCount === EXPECTED_OWNER_KEYS.length &&
      pendingObjectiveCount + approvedObjectiveCount ===
        EXPECTED_OBJECTIVE_KEYS.length,
    "Repository mode preserves pending human decisions without fabricating values.",
  );
}

const controls = contract.controls ?? [];
const controlIds = controls.map((control) => control.id).sort();
check(
  "control-register",
  sameStrings(controlIds, EXPECTED_CONTROL_IDS) &&
    new Set(controlIds).size === EXPECTED_CONTROL_IDS.length,
  "The ten roadmap controls are unique and complete.",
);
check(
  "external-controls-dormant",
  controls.every((control) =>
    control.id === "WA-01"
      ? control.scope === "repository" &&
        control.state === "repository-implemented" &&
        control.requiresExternalApproval === false &&
        control.activatedByThisContract === true
      : control.requiresExternalApproval === true &&
        control.activatedByThisContract === false,
  ),
  "Only repository evidence is activated; external, billable, and account-wide controls remain approval-gated.",
);

const wa02 = controls.find((control) => control.id === "WA-02");
const alarmRoutingControlFilesValid =
  ALARM_ROUTING_CONTROL_FILES.every((file) => {
    const absolutePath = resolve(ROOT, file);
    return (
      existsSync(absolutePath) &&
      statSync(absolutePath).isFile() &&
      statSync(absolutePath).size > 0
    );
  });
check(
  "wa02-alarm-routing-control-loop-source",
  alarmRoutingControlFilesValid &&
    wa02?.state ===
      "repository-prepared-activation-and-human-paging-required" &&
    wa02?.requiresExternalApproval === true &&
    wa02?.activatedByThisContract === false &&
    wa02?.evidenceWorkflow ===
      ".github/workflows/alarm-routing-controls.yml" &&
    wa02?.foundationTemplate === "aws/bootstrap-oidc.yaml" &&
    wa02?.proofScript === "aws/prove-alarm-routing.sh" &&
    wa02?.runbook === "docs/runbooks/alarm-response.md" &&
    wa02?.protectedEnvironment === "alarm-routing-controls" &&
    wa02?.activationMutation ===
      "AlarmRoutingEnabled false-to-true only" &&
    wa02?.drillMutationBoundary ===
      "staging synthetic probe ALARM-to-OK only" &&
    wa02?.humanPagingEvidenceRequiredSeparately === true,
  "WA-02 binds dedicated protected activation and staging filtered-queue delivery evidence without claiming live activation or human paging.",
);

const wa03 = controls.find((control) => control.id === "WA-03");
const accountSecurityBaselineFilesValid =
  ACCOUNT_SECURITY_BASELINE_FILES.every((file) => {
    const absolutePath = resolve(ROOT, file);
    return (
      existsSync(absolutePath) &&
      statSync(absolutePath).isFile() &&
      statSync(absolutePath).size > 0
    );
  });
check(
  "wa03-account-security-baseline-source",
  accountSecurityBaselineFilesValid &&
    wa03?.state === "repository-prepared-live-audit-required" &&
    wa03?.requiresExternalApproval === true &&
    wa03?.activatedByThisContract === false &&
    wa03?.evidenceWorkflow ===
      ".github/workflows/aws-security-baseline.yml" &&
    wa03?.auditScript === "aws/audit-account-security-baseline.sh" &&
    wa03?.referencePolicy ===
      "aws/account-security-baseline-audit-policy.json" &&
    wa03?.runbook ===
      "docs/runbooks/aws-account-security-baseline.md" &&
    wa03?.protectedEnvironment === "security-audit" &&
    wa03?.roleVariable === "AWS_SECURITY_AUDIT_ROLE_ARN" &&
    wa03?.mutationPermitted === false,
  "WA-03 binds a non-mutating protected workflow, audit script, least-privilege reference policy, and activation runbook without claiming live evidence.",
);

const foundationLifecycleFilesValid =
  FOUNDATION_LIFECYCLE_CONTROL_FILES.every((file) => {
    const absolutePath = resolve(ROOT, file);
    return (
      existsSync(absolutePath) &&
      statSync(absolutePath).isFile() &&
      statSync(absolutePath).size > 0
    );
  });
const foundationMigrationWorkflowSource = readRepositorySource(
  ".github/workflows/foundation-migration.yml",
);
const foundationMigrationAuthoritySource = readRepositorySource(
  "aws/foundation-migration-authority.sh",
);
const foundationMigrationRunbookSource = readRepositorySource(
  "docs/operations/FOUNDATION_STORAGE_MIGRATION.md",
);
const foundationBootstrapSource = readRepositorySource("aws/bootstrap-oidc.yaml");
const foundationBootstrapStackPolicySource = readRepositorySource(
  "aws/bootstrap-stack-policy.json",
);
const foundationStorageMigrationPolicySource = readRepositorySource(
  "aws/foundation-storage-migration-policy.json",
);
const foundationStorageProofSource = readRepositorySource(
  "aws/prove-foundation-storage-controls.sh",
);
const deploymentWorkflowSource = readRepositorySource(
  ".github/workflows/deploy-aws.yml",
);
const deploymentControlPlaneFenceSource = readRepositorySource(
  ".github/scripts/revalidate-aws-control-plane-fence.sh",
);
const foundationCiWorkflowSource = readRepositorySource(
  ".github/workflows/ci.yml",
);
const bootstrapWorkflowSource = readRepositorySource(
  ".github/workflows/bootstrap-aws.yml",
);
const sharedEdgeWorkflowSource = readRepositorySource(
  ".github/workflows/edge-controls.yml",
);
const sharedRecoveryWorkflowSource = readRepositorySource(
  ".github/workflows/recover-aws.yml",
);
const foundationContractTestsSource = readRepositorySource(
  "tests/s3-access-logging.test.ts",
);
const foundationAuthorizeStep = extractNamedWorkflowStep(
  foundationMigrationWorkflowSource,
  "Fail closed unless the dispatch targets current green main",
);
const foundationFailedPlanCleanupStep = extractNamedWorkflowStep(
  foundationMigrationWorkflowSource,
  "Delete an unverified foundation migration plan",
);
const foundationProveAuthorityStep = extractNamedWorkflowStep(
  foundationMigrationWorkflowSource,
  "Prove exact one-time migration authority",
);
const foundationAbortJob = extractNamedWorkflowJob(
  foundationMigrationWorkflowSource,
  "abort-authority",
);
const foundationAbortStep = extractNamedWorkflowStep(
  foundationAbortJob,
  "Prove stable foundation and clean only authorized unexecuted plans",
);
const foundationAbortFailureFinalizerStep = extractNamedWorkflowStep(
  foundationAbortJob,
  "Finalize any untrapped abort failure receipt",
);
const foundationExecuteStep = extractNamedWorkflowStep(
  foundationMigrationWorkflowSource,
  "Execute under rollback-safe policy and protect success immediately",
);
const foundationPromotePolicyStep = extractNamedWorkflowStep(
  foundationMigrationWorkflowSource,
  "Reconcile candidate and rollback-safe stack-policy state",
);
const foundationAndEdgeReceiptGateStep = extractNamedWorkflowStep(
  deploymentWorkflowSource,
  "Require exact-SHA foundation and edge-control receipts",
);
const foundationDeployedControlsProofStep = extractNamedWorkflowStep(
  foundationMigrationWorkflowSource,
  "Prove exact deployed template and live storage controls",
);
const foundationRetirementReadinessStep = extractNamedWorkflowStep(
  foundationMigrationWorkflowSource,
  "Prove candidate foundation and permanent controls",
);
const foundationRetireJob = extractNamedWorkflowJob(
  foundationMigrationWorkflowSource,
  "retire-authority",
);
const deploymentStagingJobSource = extractNamedWorkflowJob(
  deploymentWorkflowSource,
  "deploy-staging",
);
const deploymentProductionJobSource = extractNamedWorkflowJob(
  deploymentWorkflowSource,
  "deploy-production",
);
const deploymentStagingFenceStep = extractNamedWorkflowStep(
  deploymentStagingJobSource,
  "Revalidate staging control-plane fence before new release mutation",
);
const deploymentProductionFenceStep = extractNamedWorkflowStep(
  deploymentProductionJobSource,
  "Revalidate production control-plane fence before new release mutation",
);
const foundationRetireStep = extractNamedWorkflowStep(
  foundationRetireJob,
  "Verify and retire the exact authority stack",
);
const foundationRetirementFailureFinalizerStep = extractNamedWorkflowStep(
  foundationRetireJob,
  "Finalize any untrapped retirement failure receipt",
);
const sharedAwsMutationConcurrencyPattern =
  /^    concurrency:\r?\n      group: aws-shared-control-plane-mutation\r?\n      cancel-in-progress: false\r?\n      queue: max$/gmu;
const sharedAwsMutationJobContracts = [
  { source: bootstrapWorkflowSource, jobIds: ["foundation"] },
  {
    source: foundationMigrationWorkflowSource,
    jobIds: ["migrate", "abort-authority", "retire-authority"],
  },
  { source: sharedEdgeWorkflowSource, jobIds: ["edge"] },
  {
    source: deploymentWorkflowSource,
    jobIds: ["deploy-staging", "deploy-production"],
  },
  {
    source: sharedRecoveryWorkflowSource,
    jobIds: ["recover-staging", "recover-production"],
  },
];
const sharedAwsMutationConcurrencyValid =
  (bootstrapWorkflowSource.match(sharedAwsMutationConcurrencyPattern) ?? [])
    .length === 1 &&
  (
    foundationMigrationWorkflowSource.match(
      sharedAwsMutationConcurrencyPattern,
    ) ?? []
  ).length === 3 &&
  (sharedEdgeWorkflowSource.match(sharedAwsMutationConcurrencyPattern) ?? [])
    .length === 1 &&
  (deploymentWorkflowSource.match(sharedAwsMutationConcurrencyPattern) ?? [])
    .length === 2 &&
  (
    sharedRecoveryWorkflowSource.match(sharedAwsMutationConcurrencyPattern) ??
    []
  ).length === 2 &&
  sharedAwsMutationJobContracts.every(({ source, jobIds }) =>
    jobIds.every(
      (jobId) =>
        (
          extractNamedWorkflowJob(source, jobId).match(
            sharedAwsMutationConcurrencyPattern,
          ) ?? []
        ).length === 1,
    ),
  ) &&
  !/aws-shared-control-plane-mutation/u.test(
    extractNamedWorkflowJob(deploymentWorkflowSource, "source-gate"),
  );
const foundationAbortReceiptOffset =
  foundationAbortStep.lastIndexOf("          phase=receipt");
const foundationAbortReceiptSource =
  foundationAbortReceiptOffset >= 0
    ? foundationAbortStep.slice(foundationAbortReceiptOffset)
    : "";
const foundationRetireReceiptOffset =
  foundationRetireStep.lastIndexOf("          phase=receipt");
const foundationRetireReceiptSource =
  foundationRetireReceiptOffset >= 0
    ? foundationRetireStep.slice(foundationRetireReceiptOffset)
    : "";
const foundationFinalAuthorityProofOffset = foundationRetireStep.lastIndexOf(
  "bash aws/foundation-migration-authority.sh",
);
const foundationAuthorityDeleteOffset = foundationRetireStep.indexOf(
  "aws cloudformation delete-stack",
  foundationFinalAuthorityProofOffset,
);
const foundationFinalAuthorityProofSource =
  foundationFinalAuthorityProofOffset >= 0 &&
  foundationAuthorityDeleteOffset > foundationFinalAuthorityProofOffset
    ? foundationRetireStep.slice(
        foundationFinalAuthorityProofOffset,
        foundationAuthorityDeleteOffset,
      )
    : "";
const foundationAuthorityRetirementExecutionRoleSource =
  foundationBootstrapSource.match(
    /(?:^|\r?\n)  FoundationAuthorityRetirementExecutionRole:\r?\n[\s\S]*?(?=\r?\n  FoundationPromotionRole:\r?\n|$)/u,
  )?.[0] ?? "";
const foundationPromotionRoleSource =
  foundationBootstrapSource.match(
    /(?:^|\r?\n)  FoundationPromotionRole:\r?\n[\s\S]*?(?=\r?\n  StagingDeployRole:\r?\n|$)/u,
  )?.[0] ?? "";
const foundationRequiredNewResourcesSource =
  foundationStorageMigrationPolicySource.match(
    /"requiredNewResources":\s*\[[\s\S]*?\](?=,\s*"allowedModifications")/u,
  )?.[0] ?? "";
const foundationAllowedModificationsSource =
  foundationStorageMigrationPolicySource.match(
    /"allowedModifications":\s*\[[\s\S]*?\](?=,\s*"forbiddenActions")/u,
  )?.[0] ?? "";
const foundationRetirementProofDigestFields = [
  "controllerRoleIdSha256",
  "controllerPolicySha256",
  "controllerInventorySha256",
  "controllerDriftSha256",
  "executionRoleIdSha256",
  "executionPolicySha256",
  "executionInventorySha256",
  "executionDriftSha256",
];
const foundationPolicyCanonicalAndQuotaValid =
  /const expectedSids = \[[\s\S]*?"InspectFoundationRetirementRoleMetadata"[\s\S]*?"InspectFoundationRetirementRolePolicies"[\s\S]*?\];/u.test(
    foundationContractTestsSource,
  ) &&
  /new Set\(expectedSids\)\.size, expectedSids\.length/u.test(
    foundationContractTestsSource,
  ) &&
  /action === "\*"[\s\S]*?action === "cloudformation:\*"[\s\S]*?action === "iam:\*"[\s\S]*?action\.startsWith\("iam:Delete"\)[\s\S]*?!resources\(statement\)\.includes\("\*"\)/u.test(
    foundationContractTestsSource,
  ) &&
  /Buffer\.byteLength\(compactPolicy, "utf8"\) <= 10_240/u.test(
    foundationContractTestsSource,
  ) &&
  /Buffer\.byteLength\(JSON\.stringify\(renderedAuthority\), "utf8"\) <= 10_240/u.test(
    foundationContractTestsSource,
  ) &&
  /PolicyDocument\.Statement \| map\(\.Sid\) \| sort[\s\S]*?"InspectFoundationRetirementRoleMetadata"[\s\S]*?"InspectFoundationRetirementRolePolicies"/u.test(
    foundationStorageProofSource,
  ) &&
  /select\(\s*\(normalized_actions \| index\("cloudformation:deletestack"\)\) != null[\s\S]*?\["RetireOneTimeFoundationMigrationAuthorityStack"\][\s\S]*?select\(\(normalized_actions \| index\("iam:passrole"\)\) != null\)[\s\S]*?\["PassOnlyFoundationAuthorityRetirementExecutionRole"\]/u.test(
    foundationStorageProofSource,
  );
const foundationProofIdentityContractValid =
  foundationRetirementProofDigestFields.every(
    (field) =>
      foundationStorageProofSource.includes(`${field}:`) &&
      foundationDeployedControlsProofStep.includes(`.${field}`) &&
      foundationRetirementReadinessStep.includes(`.${field}`) &&
      foundationRetireStep.includes(`.${field}`) &&
      foundationAndEdgeReceiptGateStep.includes(`.${field}`),
  ) &&
  [
    foundationDeployedControlsProofStep,
    foundationRetirementReadinessStep,
    foundationRetireStep,
    foundationAndEdgeReceiptGateStep,
  ].every((source) =>
    /cloudFormationDriftInSync[\s\S]*?== true/u.test(source),
  ) &&
  /FoundationPromotionRoleId:\r?\n\s+Value: !GetAtt FoundationPromotionRole\.RoleId/u.test(
    foundationBootstrapSource,
  ) &&
  /FoundationAuthorityRetirementExecutionRoleId:\r?\n\s+Value: !GetAtt FoundationAuthorityRetirementExecutionRole\.RoleId/u.test(
    foundationBootstrapSource,
  ) &&
  /FoundationMigrationRoleId:[\s\S]*?Fn::GetAtt[\s\S]*?FoundationMigrationRole[\s\S]*?RoleId/u.test(
    foundationMigrationAuthoritySource,
  ) &&
  /roleIdSha256: \$roleIdSha256/u.test(
    foundationMigrationAuthoritySource,
  ) &&
  /--no-paginate/u.test(foundationMigrationAuthoritySource) &&
  /--no-paginate/u.test(foundationStorageProofSource);
const foundationReceiptSelectionContractValid =
  foundationMigrationWorkflowSource.includes(
    "run-name: Foundation ${{ inputs.operation }} ${{ inputs.target_sha }}",
  ) &&
  readRepositorySource(".github/workflows/edge-controls.yml").includes(
    "run-name: Edge ${{ inputs.environment }} ${{ inputs.operation }} ${{ inputs.target_sha }}",
  ) &&
  /\.display_title == \("Foundation plan " \+ \$head\)[\s\S]*?Foundation apply[\s\S]*?Foundation verify[\s\S]*?Foundation abort[\s\S]*?Foundation retire/u.test(
    foundationAndEdgeReceiptGateStep,
  ) &&
  /Edge " \+ \$environment \+ " plan[\s\S]*?Edge " \+ \$environment \+ " apply[\s\S]*?Edge " \+ \$environment \+ " verify[\s\S]*?Edge " \+ \$environment \+ " cleanup[\s\S]*?Edge " \+ \$environment \+ " finalize/u.test(
    foundationAndEdgeReceiptGateStep,
  ) &&
  (foundationAndEdgeReceiptGateStep.match(
    /sort_by\(\.updated_at, \.run_number, \.run_attempt\)[\s\S]*?\| last/gmu,
  ) ?? []).length === 2 &&
  (foundationAndEdgeReceiptGateStep.match(
    /\(\.conclusion \/\/ "pending"\)/gmu,
  ) ?? []).length === 2 &&
  (foundationAndEdgeReceiptGateStep.match(
    /\[ "\$conclusion" = "success" \] \|\| return 1/gmu,
  ) ?? []).length === 2 &&
  /\[ "\$operation" = "verify" \] \|\| return 1/u.test(
    foundationAndEdgeReceiptGateStep,
  ) &&
  /\[\[ "\$operation" =~ \^\(verify\|apply\)\$ \]\] \|\| return 1/u.test(
    foundationAndEdgeReceiptGateStep,
  ) &&
  !/select\([^\n]*\.conclusion[^\n]*success/u.test(
    foundationAndEdgeReceiptGateStep,
  ) &&
  (foundationAndEdgeReceiptGateStep.match(
    /gh run download "\$id" \\\r?\n\s+--repo "\$GITHUB_REPOSITORY"/gmu,
  ) ?? []).length === 2 &&
  (foundationAndEdgeReceiptGateStep.match(/if ! gh run download/gmu) ?? [])
    .length === 2 &&
  (foundationAndEdgeReceiptGateStep.match(/if ! runs="\$\(/gmu) ?? [])
    .length === 1 &&
  /if ! EDGE_CONTROL_RUNS="\$\([\s\S]*?edge-controls\.yml\/runs\?per_page=100[\s\S]*?EDGE_CONTROL_RUNS='\[\]'/u.test(
    foundationAndEdgeReceiptGateStep,
  ) &&
  (foundationAndEdgeReceiptGateStep.match(/if ! candidate="\$\(/gmu) ?? [])
    .length === 2 &&
  (foundationAndEdgeReceiptGateStep.match(/if ! artifacts="\$\(/gmu) ?? [])
    .length === 2 &&
  (foundationAndEdgeReceiptGateStep.match(/if ! artifact="\$\(/gmu) ?? [])
    .length === 2 &&
  (foundationAndEdgeReceiptGateStep.match(/if ! destination="\$\(/gmu) ?? [])
    .length === 2 &&
  (foundationAndEdgeReceiptGateStep.match(/if ! jq -e/gmu) ?? []).length === 2;
const deploymentControlPlaneFenceContractValid =
  /for name in[\s\S]*?EXPECTED_SHA[\s\S]*?FENCE_ENVIRONMENT[\s\S]*?FENCE_JOB_ID[\s\S]*?FENCE_MUTEX_GROUP[\s\S]*?GITHUB_RUN_ATTEMPT[\s\S]*?GITHUB_RUN_ID/u.test(
    deploymentControlPlaneFenceSource,
  ) &&
  (deploymentControlPlaneFenceSource.match(/--paginate/gmu) ?? []).length ===
    2 &&
  (deploymentControlPlaneFenceSource.match(/--slurp/gmu) ?? []).length === 2 &&
  (deploymentControlPlaneFenceSource.match(/\/runs\?per_page=100/gmu) ?? [])
    .length === 2 &&
  !/\/runs\?[^"\r\n]*(?:branch|event)=/u.test(
    deploymentControlPlaneFenceSource,
  ) &&
  (deploymentControlPlaneFenceSource.match(
    /\.\[\]\.workflow_runs\[\]/gmu,
  ) ?? []).length === 2 &&
  (deploymentControlPlaneFenceSource.match(
    /sort_by\(\.updated_at, \.run_number, \.run_attempt\)[\s\S]*?\| last/gmu,
  ) ?? []).length === 2 &&
  !/\.head_sha == \$sha/u.test(deploymentControlPlaneFenceSource) &&
  /test "\$foundation_sha" = "\$EXPECTED_SHA"/u.test(
    deploymentControlPlaneFenceSource,
  ) &&
  /test "\$actual_sha" = "\$EXPECTED_SHA"/u.test(
    deploymentControlPlaneFenceSource,
  ) &&
  /git\/ref\/heads\/main[\s\S]*?\.object\.sha[\s\S]*?EXPECTED_SHA/u.test(
    deploymentControlPlaneFenceSource,
  ) &&
  /jq -cS -n/u.test(deploymentControlPlaneFenceSource) &&
  /edgeSnapshotShared:true/u.test(deploymentControlPlaneFenceSource) &&
  /checkedAt:\$checkedAt[\s\S]*?mainHeadRevalidated:true[\s\S]*?mutationMutexHeldByCaller:true[\s\S]*?latestEligibleRunsRevalidated:true[\s\S]*?mutex:[\s\S]*?deployment:[\s\S]*?foundation:[\s\S]*?operation:"verify"[\s\S]*?edge:[\s\S]*?operation:\$stagingEdgeOperation[\s\S]*?operation:\$productionEdgeOperation/u.test(
    deploymentControlPlaneFenceSource,
  ) &&
  !/(?:^|\r?\n)\s*aws\s|gh api[\s\S]*?(?:--method|-X)\s*(?:POST|PUT|PATCH|DELETE)/u.test(
    deploymentControlPlaneFenceSource,
  ) &&
  [
    ["foundation_control_run_id", "foundation_run_id"],
    ["foundation_control_run_attempt", "foundation_run_attempt"],
    ["staging_edge_control_run_id", "staging_edge_run_id"],
    ["staging_edge_control_run_attempt", "staging_edge_run_attempt"],
    ["production_edge_control_run_id", "production_edge_run_id"],
    ["production_edge_control_run_attempt", "production_edge_run_attempt"],
  ].every(
    ([output, emitted]) =>
      deploymentWorkflowSource.includes(`${output}:`) &&
      foundationAndEdgeReceiptGateStep.includes(`echo "${emitted}=`),
  ) &&
  (foundationAndEdgeReceiptGateStep.match(/--paginate/gmu) ?? []).length === 2 &&
  (foundationAndEdgeReceiptGateStep.match(/--slurp/gmu) ?? []).length === 2 &&
  (foundationAndEdgeReceiptGateStep.match(/\/runs\?per_page=100/gmu) ?? [])
    .length === 2 &&
  !/\/runs\?[^"\r\n]*(?:branch|event)=/u.test(
    foundationAndEdgeReceiptGateStep,
  ) &&
  (foundationAndEdgeReceiptGateStep.match(/\.\[\]\.workflow_runs\[\]/gmu) ?? [])
    .length === 2 &&
  (foundationAndEdgeReceiptGateStep.match(
    /if \[ "\$head_sha" != "\$EXPECTED_SHA" \]; then[\s\S]*?CONTROL_RECEIPT_SUPERSEDED=true[\s\S]*?return 1/gmu,
  ) ?? []).length === 2 &&
  /CONTROL_RECEIPT_SUPERSEDED=false[\s\S]*?if \[ "\$CONTROL_RECEIPT_SUPERSEDED" = "true" \]; then[\s\S]*?superseded \$EXPECTED_SHA[\s\S]*?exit 1/u.test(
    foundationAndEdgeReceiptGateStep,
  ) &&
  /git\/ref\/heads\/main[\s\S]*?\.object\.type == "commit"[\s\S]*?\.object\.sha == \$sha/u.test(
    foundationAndEdgeReceiptGateStep,
  ) &&
  [deploymentStagingFenceStep, deploymentProductionFenceStep].every(
    (step) =>
      step.length > 0 &&
      /bash \.github\/scripts\/revalidate-aws-control-plane-fence\.sh/u.test(
        step,
      ) &&
      /CONTROL_PLANE_FENCE_FILE=\$fence/u.test(step) &&
      /CONTROL_PLANE_FENCE_SHA256=\$fence_sha256/u.test(step) &&
      /\.mainHeadRevalidated == true/u.test(step) &&
      /\.latestEligibleRunsRevalidated == true/u.test(step) &&
      /\.edgeSnapshotShared == true/u.test(step) &&
      /\.edge\.staging\.operation \| test\("\^\(apply\|verify\)\$"\)/u.test(
        step,
      ) &&
      /\.edge\.production\.operation \| test\("\^\(apply\|verify\)\$"\)/u.test(
        step,
      ),
  ) &&
  deploymentStagingJobSource.indexOf(
    "Reconcile an interrupted same-run staging greenfield recovery",
  ) <
    deploymentStagingJobSource.indexOf(
      "Revalidate staging control-plane fence before new release mutation",
    ) &&
  deploymentStagingJobSource.indexOf(
    "Revalidate staging control-plane fence before new release mutation",
  ) <
    deploymentStagingJobSource.indexOf(
      "Enforce staging stack protection and fresh pre-deploy drift gate",
    ) &&
  deploymentProductionJobSource.indexOf(
    "Reconcile an interrupted same-run production greenfield recovery",
  ) <
    deploymentProductionJobSource.indexOf(
      "Revalidate production control-plane fence before new release mutation",
    ) &&
  deploymentProductionJobSource.indexOf(
    "Revalidate production control-plane fence before new release mutation",
  ) <
    deploymentProductionJobSource.indexOf(
      "Enforce production stack protection and fresh pre-deploy drift gate",
    ) &&
  (deploymentWorkflowSource.match(
    /--slurpfile controlPlaneFence "\$CONTROL_PLANE_FENCE_FILE"/gmu,
  ) ?? []).length === 2 &&
  (deploymentWorkflowSource.match(
    /test ! -L "\$CONTROL_PLANE_FENCE_FILE"/gmu,
  ) ?? []).length === 2 &&
  (deploymentWorkflowSource.match(
    /controlPlaneReceiptFence:\r?\n\s*\(\$controlPlaneFence\[0\] \+ \{[\s\S]*?sha256: \$controlPlaneFenceSha256/gmu,
  ) ?? []).length === 2 &&
  /bash -n \.github\/scripts\/revalidate-aws-control-plane-fence\.sh/u.test(
    foundationCiWorkflowSource,
  );
const foundationRetirementRetryAndIdempotencyValid =
  /verify-retirement-retry/u.test(foundationMigrationAuthoritySource) &&
  /verify-retirement-orphaned/u.test(foundationMigrationAuthoritySource) &&
  /expected_stack_status=DELETE_FAILED/u.test(
    foundationMigrationAuthoritySource,
  ) &&
  /retirementRetryContractExact: \$retryExact/u.test(
    foundationMigrationAuthoritySource,
  ) &&
  /standardDeleteRetryEligible: \$retryExact/u.test(
    foundationMigrationAuthoritySource,
  ) &&
  /authority_role_present=false[\s\S]*?NoSuchEntity[\s\S]*?authority_verification_mode=verify-intrinsic[\s\S]*?if \[ "\$authority_stack_status" = "DELETE_FAILED" \]; then[\s\S]*?if \[ "\$authority_role_present" = "true" \]; then[\s\S]*?authority_verification_mode=verify-retirement-retry[\s\S]*?authority_verification_mode=verify-retirement-orphaned[\s\S]*?else[\s\S]*?test "\$authority_stack_status" = "CREATE_COMPLETE"[\s\S]*?test "\$authority_role_present" = "true"/u.test(
    foundationRetireStep,
  ) &&
  /phase=already-retired-role-absence[\s\S]*?prove-foundation-storage-controls\.sh retired[\s\S]*?result: "one-time-authority-already-retired"[\s\S]*?destructiveActionsStarted: false/u.test(
    foundationRetireStep,
  ) &&
  /authority_stack_status" = "DELETE_FAILED"[\s\S]*?authority_verification_mode=verify-retirement-retry[\s\S]*?retrying_delete_failed=true/u.test(
    foundationRetireStep,
  ) &&
  /if \$mode == "verify-retirement-orphaned" then[\s\S]*?\.orphanedRetirementContractExact == true[\s\S]*?\.targetedRetainReconciliationEligible == true[\s\S]*?\.requiredRetainResources == \["FoundationMigrationRole"\][\s\S]*?\.authorityRolePresent == false[\s\S]*?\.roleAbsenceChecks == 2[\s\S]*?\.roleAttachmentInventorySha256 == null[\s\S]*?else[\s\S]*?if \$mode == "verify-retirement-retry" then[\s\S]*?\.retirementRetryContractExact == true[\s\S]*?\.standardDeleteRetryEligible == true/u.test(
    foundationRetireStep,
  ) &&
  /one-time-authority-retired-after-standard-retry/u.test(
    foundationRetireStep,
  ) &&
  /one-time-authority-orphaned-stack-reconciled/u.test(
    foundationRetireStep,
  ) &&
  /standardDeleteRetryPerformed: \$standardDeleteRetry[\s\S]*?deletionMode: "STANDARD"[\s\S]*?forceDeleteUsed: false[\s\S]*?retainedResourcesUsed: \$orphanedReconciliation[\s\S]*?targetedRetainReconciliationPerformed:[\s\S]*?\$orphanedReconciliation[\s\S]*?retainedLogicalResourceIds:[\s\S]*?FoundationMigrationRole[\s\S]*?authorityRoleDeletedByThisRun:[\s\S]*?\(\$orphanedReconciliation \| not\)[\s\S]*?physicalRoleRetained: false[\s\S]*?stackRecordDeleted: true/u.test(
    foundationRetireReceiptSource,
  ) &&
  /terminalLifecycleSafetyContractVersion: 2/u.test(
    foundationMigrationAuthoritySource,
  ) &&
  /phase=authority-historical-source-binding[\s\S]*?\.sourceCommit \| select\(test\("\^\[0-9a-f\]\{40\}\$"\)\)[\s\S]*?compare\/\$\{authority_source_sha\}\.\.\.\$\{TARGET_SHA\}[\s\S]*?\.merge_base_commit\.sha == \$base[\s\S]*?\.head_commit\.sha == \$head[\s\S]*?historical_authority_source_sha256[\s\S]*?\^\[0-9a-f\]\{64\}\$/u.test(
    foundationRetireStep,
  ) &&
  /historicalAuthoritySource: \{[\s\S]*?commit: \$authoritySourceSha[\s\S]*?ancestorOfTarget: true[\s\S]*?sourceFileSha256: \$historicalAuthoritySourceSha256[\s\S]*?recordedTemplateSha256:[\s\S]*?\$recordedAuthorityTemplateSha256[\s\S]*?sourceFetchedAsData: true[\s\S]*?sourceExecuted: false[\s\S]*?liveTemplateBound: true[\s\S]*?terminalLifecycleSafetyContractVersion: 2/u.test(
    foundationRetireReceiptSource,
  ) &&
  !/env -i[^\r\n]*historical_authority_source|(?:bash|source|\.)\s+"?\$historical_authority_source/u.test(
    foundationRetireStep,
  ) &&
  /result: "one-time-authority-already-retired"[\s\S]*?retiredAuthority: \{[\s\S]*?stackDeleted: false[\s\S]*?roleDeleted: false[\s\S]*?stackAbsent: true[\s\S]*?roleAbsent: true[\s\S]*?stackDeletedByThisRun: false[\s\S]*?roleDeletedByThisRun: false[\s\S]*?alreadyAbsentAtStart: true/u.test(
    foundationRetireStep,
  ) &&
  /failure: \{phase: \$phase, strategy: \$strategy\}/u.test(
    foundationRetireStep,
  ) &&
  /retirement_strategy=unclassified[\s\S]*?retirement_strategy=already-absent[\s\S]*?retirement_strategy=standard-delete-retry[\s\S]*?retirement_strategy=targeted-retain-orphan-reconciliation[\s\S]*?retirement_strategy=standard-delete/u.test(
    foundationRetireStep,
  ) &&
  /authorityRoleAbsentBeforeRequest:[\s\S]*?\$authorityRoleAbsentBeforeRequest[\s\S]*?authorityRoleDeletedByThisRun:[\s\S]*?\(\$orphanedReconciliation \| not\)[\s\S]*?stackRecordDeleted: true[\s\S]*?stackDeletedByThisRun: true[\s\S]*?roleDeletedByThisRun:[\s\S]*?\(\$orphanedReconciliation \| not\)/u.test(
    foundationRetireReceiptSource,
  ) &&
  !/--force-delete|FORCE_DELETE_STACK/u.test(foundationRetireStep) &&
  (foundationRetireStep.match(/--retain-resources/gu) ?? []).length === 1 &&
  (foundationRetireStep.match(/--deletion-mode STANDARD/gu) ?? []).length ===
    2;
const foundationPhaseZeroSource =
  foundationMigrationRunbookSource.match(
    /## Phase 0: create the one-time authority[\s\S]*?```bash\r?\n([\s\S]*?)\r?\n```/u,
  )?.[1] ?? "";
const foundationPhaseZeroContractValid =
  /test -z "\$\(git status --porcelain=v1\)"/u.test(
    foundationPhaseZeroSource,
  ) &&
  /SOURCE_COMMIT=\$\(git rev-parse HEAD\)/u.test(
    foundationPhaseZeroSource,
  ) &&
  /AUTHORITY_TEMPLATE_SHA256=\$\(\s*bash aws\/foundation-migration-authority\.sh render-template-sha256\s*\)/u.test(
    foundationPhaseZeroSource,
  ) &&
  /authority_template=\$\(\s*bash aws\/foundation-migration-authority\.sh render-template\s*\)/u.test(
    foundationPhaseZeroSource,
  ) &&
  /jq -Scj/u.test(foundationPhaseZeroSource) &&
  !/jq -Sc \./u.test(foundationPhaseZeroSource) &&
  /ParameterKey=SourceCommit,ParameterValue=\$\{SOURCE_COMMIT\}/u.test(
    foundationPhaseZeroSource,
  ) &&
  /ParameterKey=AuthorityTemplateSha256,ParameterValue=\$\{AUTHORITY_TEMPLATE_SHA256\}/u.test(
    foundationPhaseZeroSource,
  ) &&
  /Key=SourceCommit,Value=\$\{SOURCE_COMMIT\}/u.test(
    foundationPhaseZeroSource,
  ) &&
  /Key=AuthorityTemplateSha256,Value=\$\{AUTHORITY_TEMPLATE_SHA256\}/u.test(
    foundationPhaseZeroSource,
  ) &&
  /--capabilities CAPABILITY_NAMED_IAM/u.test(foundationPhaseZeroSource) &&
  /--on-failure ROLLBACK/u.test(foundationPhaseZeroSource) &&
  /--no-enable-termination-protection/u.test(foundationPhaseZeroSource) &&
  /unset authority_template/u.test(foundationPhaseZeroSource) &&
  !/--role-arn/u.test(foundationPhaseZeroSource) &&
  /render-template-sha256/u.test(foundationMigrationAuthoritySource) &&
  /RequiredStackTagKeys:[\s\S]*?"SourceCommit",[\s\S]*?"AuthorityTemplateSha256"/u.test(
    foundationMigrationAuthoritySource,
  ) &&
  /\(\$template\.Resources \| keys\) == \["FoundationMigrationRole"\]/u.test(
    foundationMigrationAuthoritySource,
  ) &&
  /\.Stacks\[0\]\.EnableTerminationProtection == false/u.test(
    foundationMigrationAuthoritySource,
  ) &&
  /\(\(\.Stacks\[0\]\.RoleARN \/\/ null\) == null\)/u.test(
    foundationMigrationAuthoritySource,
  ) &&
  /\(\(\.Stacks\[0\]\.Tags \/\/ \[\]\) \| tag_map\) == \{\s*SourceCommit: \$sourceCommit,\s*AuthorityTemplateSha256: \$templateSha256\s*\}/u.test(
    foundationMigrationAuthoritySource,
  ) &&
  /\(\.StackResourceSummaries \| length\) == 1/u.test(
    foundationMigrationAuthoritySource,
  ) &&
  /Repository[\s\S]*?source and CI never create this authority/u.test(
    foundationMigrationRunbookSource,
  ) &&
  /pre-binding contract cannot be[\s\S]*?administrator must delete it and[\s\S]*?recreate it from Phase 0/u.test(
    foundationMigrationRunbookSource,
  );
const foundationAuthorityTemplateDigestContractValid =
  /canonical_json_bytes\(\)[\s\S]*?jq -Scj -s[\s\S]*?length != 1[\s\S]*?type\) != "object"/u.test(
    foundationMigrationAuthoritySource,
  ) &&
  /canonical_template_body_bytes\(\)[\s\S]*?jq -Scj -s[\s\S]*?length != 1[\s\S]*?type\) != "object"/u.test(
    foundationMigrationAuthoritySource,
  ) &&
  /render-template-sha256\)\s*render_template \| canonical_json_sha256/u.test(
    foundationMigrationAuthoritySource,
  ) &&
  /live_template_digest="\$\(\s*canonical_template_body_sha256 "\$live_template"/u.test(
    foundationMigrationAuthoritySource,
  ) &&
  /--arg stackIdSha256 "\$\(\s*jq -ejr '\.Stacks\[0\]\.StackId' "\$live_stack" \|\s*sha256sum/u.test(
    foundationMigrationAuthoritySource,
  ) &&
  (foundationMigrationAuthoritySource.match(
    /legacy_lf_template_body_sha256/gu,
  ) ?? []).length === 2 &&
  (foundationMigrationAuthoritySource.match(
    /legacy_crlf_template_body_sha256/gu,
  ) ?? []).length === 2 &&
  /recorded_template_terminator="none"/u.test(
    foundationMigrationAuthoritySource,
  ) &&
  /recorded_template_terminator="lf"/u.test(
    foundationMigrationAuthoritySource,
  ) &&
  /recorded_template_terminator="crlf"/u.test(
    foundationMigrationAuthoritySource,
  ) &&
  /template_canonicalization="jq-sort-compact-no-terminator-v1"/u.test(
    foundationMigrationAuthoritySource,
  ) &&
  /template-digest-binding/u.test(foundationMigrationAuthoritySource) &&
  !/aws cloudformation delete-stack/u.test(
    foundationMigrationAuthoritySource,
  ) &&
  /all\(\s*\.PolicyDocument\.Statement\[\];[\s\S]*?index\("cloudformation:DeleteStack"\)\) == null[\s\S]*?index\("iam:PassRole"\)\) == null[\s\S]*?\)/u.test(
    foundationMigrationAuthoritySource,
  ) &&
  /Sid: "InspectAuthorityStack"/u.test(
    foundationMigrationAuthoritySource,
  ) &&
  !/Sid: "RetireAuthorityStack"/u.test(
    foundationMigrationAuthoritySource,
  ) &&
  /selfDeletionAllowed: false/u.test(foundationMigrationAuthoritySource) &&
  /permanentRetirementControllerRequired: true/u.test(
    foundationMigrationAuthoritySource,
  ) &&
  /\.Sid == "ManageExactNewFoundationRolesViaCloudFormation"[\s\S]*?\(\(\.Resource \| list\) \| index\(\$arn\)\) == null[\s\S]*?\(\(\.Resource \| list\) \| index\(\$executionArn\)\) != null[\s\S]*?index\("iam:CreateRole"\)\) != null[\s\S]*?index\("iam:DeleteRole"\)\) != null/u.test(
    foundationMigrationAuthoritySource,
  ) &&
  /\.Sid == "ModifyExactExistingFoundationRolesViaCloudFormation"[\s\S]*?\(\(\.Resource \| list\) \| index\(\$arn\)\) == null[\s\S]*?\(\(\.Resource \| list\) \| index\(\$promotionArn\)\) != null[\s\S]*?index\("iam:CreateRole"\)\) == null[\s\S]*?index\("iam:DeleteRole"\)\) == null/u.test(
    foundationMigrationAuthoritySource,
  ) &&
  /\.Sid == "InspectOwnAuthorityContract"[\s\S]*?index\("iam:ListAttachedRolePolicies"\)\) != null[\s\S]*?index\("iam:ListInstanceProfilesForRole"\)\) != null[\s\S]*?index\("iam:ListRolePolicies"\)\) != null/u.test(
    foundationMigrationAuthoritySource,
  ) &&
  /inlinePolicyNames: \$inline\[0\]\.PolicyNames[\s\S]*?inlinePoliciesTruncated: \(\$inline\[0\]\.IsTruncated \/\/ false\)[\s\S]*?attachedPolicies: \$attached\[0\]\.AttachedPolicies[\s\S]*?attachedPoliciesTruncated: \(\$attached\[0\]\.IsTruncated \/\/ false\)[\s\S]*?instanceProfiles: \$profiles\[0\]\.InstanceProfiles[\s\S]*?instanceProfilesTruncated: \(\$profiles\[0\]\.IsTruncated \/\/ false\)[\s\S]*?inlinePolicyNames: \[\$policy\][\s\S]*?inlinePoliciesTruncated: false[\s\S]*?attachedPolicies: \[\][\s\S]*?attachedPoliciesTruncated: false[\s\S]*?instanceProfiles: \[\][\s\S]*?instanceProfilesTruncated: false/u.test(
    foundationMigrationAuthoritySource,
  ) &&
  [
    "recordedAuthorityTemplateSha256",
    "canonicalAuthorityTemplateSha256",
    "templateCanonicalization",
    "recordedTemplateTerminator",
    "legacyTemplateDigestAccepted",
  ].every((field) => foundationMigrationAuthoritySource.includes(field)) &&
  /\.verificationMode == "verify"/u.test(foundationProveAuthorityStep) &&
  /\.recordedAuthorityTemplateSha256\s*== \.canonicalAuthorityTemplateSha256/u.test(
    foundationProveAuthorityStep,
  ) &&
  /\.recordedTemplateTerminator == "none"/u.test(
    foundationProveAuthorityStep,
  ) &&
  /\.legacyTemplateDigestAccepted == false/u.test(
    foundationProveAuthorityStep,
  ) &&
  /recordedTemplateTerminator \| IN\("none", "lf", "crlf"\)/u.test(
    foundationAbortStep,
  ) &&
  /legacyTemplateDigestAccepted[\s\S]*?recordedTemplateTerminator != "none"/u.test(
    foundationAbortStep,
  ) &&
  /phase=historical-source-fetch[\s\S]*?foundation-migration-authority\.sh\?ref=\$\{authority_source\}[\s\S]*?test -s "\$historical_authority_source"[\s\S]*?test ! -L "\$historical_authority_source"[\s\S]*?historical_authority_source_sha256[\s\S]*?\^\[0-9a-f\]\{64\}\$/u.test(
    foundationAbortStep,
  ) &&
  !/env -i|historical-template-render/u.test(foundationAbortStep) &&
  /historicalAuthoritySource: \{[\s\S]*?sourceFileSha256: \$historicalAuthoritySourceSha256[\s\S]*?ancestorOfTarget: true[\s\S]*?sourceFetchedAsData: true[\s\S]*?sourceExecuted: false[\s\S]*?liveTemplateDigestBound: true[\s\S]*?terminalLifecycleSafetyContractVersion: 2/u.test(
    foundationAbortReceiptSource,
  ) &&
  !/matchesRecordedAndLiveTemplate/u.test(foundationAbortReceiptSource) &&
  /destructive_actions_started=false/u.test(foundationAbortStep) &&
  /destructiveActionsStarted: \$destructiveActionsStarted/u.test(
    foundationAbortStep,
  ) &&
  /partialChangeSetCleanup:[\s\S]*?attemptedCount: \(\$plans\[0\] \| length\)[\s\S]*?select\(\.deleted == true\)/u.test(
    foundationAbortStep,
  ) &&
  foundationAbortStep.indexOf("phase=authority-proof-contract") >= 0 &&
  foundationAbortStep.indexOf("phase=authority-proof-contract") <
    foundationAbortStep.indexOf("aws cloudformation delete-change-set") &&
  !/aws cloudformation delete-stack|iam delete-role/u.test(
    foundationAbortStep,
  ) &&
  /schemaVersion == 2[\s\S]*?verificationMode == \$mode[\s\S]*?stackStatus == \$status[\s\S]*?retirementRetryContractExact[\s\S]*?standardDeleteRetryEligible[\s\S]*?terminalLifecycleSafetyContractVersion[\s\S]*?recordedTemplateTerminator/u.test(
    foundationRetireStep,
  );
const foundationSameRunCleanupValid =
  /always\(\)/u.test(foundationFailedPlanCleanupStep) &&
  /steps\.create_plan\.outcome == 'failure'/u.test(
    foundationFailedPlanCleanupStep,
  ) &&
  /steps\.load_plan\.outcome == 'failure'/u.test(
    foundationFailedPlanCleanupStep,
  ) &&
  /steps\.exact_plan\.outcome == 'failure'/u.test(
    foundationFailedPlanCleanupStep,
  ) &&
  /env\.CHANGE_SET_ID != ''/u.test(foundationFailedPlanCleanupStep) &&
  /\.Status == "CREATE_COMPLETE"/u.test(foundationFailedPlanCleanupStep) &&
  /\.ExecutionStatus == "AVAILABLE"/u.test(
    foundationFailedPlanCleanupStep,
  ) &&
  /\(\(\.ImportExistingResources \/\/ false\) == false\)/u.test(
    foundationFailedPlanCleanupStep,
  ) &&
  /sha256sum "\$template"[\s\S]*?CANDIDATE_TEMPLATE_DIGEST/u.test(
    foundationFailedPlanCleanupStep,
  ) &&
  /aws cloudformation delete-change-set/u.test(
    foundationFailedPlanCleanupStep,
  ) &&
  /test "\$absent" = "true"/u.test(foundationFailedPlanCleanupStep) &&
  /test "\$after_projection_sha256" = "\$before_projection_sha256"/u.test(
    foundationFailedPlanCleanupStep,
  ) &&
  /changeSetArnSha256: \$arnSha256/u.test(
    foundationFailedPlanCleanupStep,
  ) &&
  /changeSetNameSha256: \$nameSha256/u.test(
    foundationFailedPlanCleanupStep,
  ) &&
  /descriptionSha256: \$descriptionSha256/u.test(
    foundationFailedPlanCleanupStep,
  ) &&
  /env\.CHANGE_SET_ID != '' \|\|[\s\S]*?steps\.create_plan\.outcome == 'failure'/u.test(
    foundationFailedPlanCleanupStep,
  ) &&
  /cleanup_change_set_id="\$\{CHANGE_SET_ID:-\}"[\s\S]*?--change-set-name "\$CHANGE_SET_NAME"[\s\S]*?\(\$plans \| length\) == 1[\s\S]*?recoveredByDeterministicName/u.test(
    foundationFailedPlanCleanupStep,
  ) &&
  !/cloudformation execute-change-set/u.test(
    foundationFailedPlanCleanupStep,
  );
const foundationAbortContractValid =
  /options:\r?\n\s+- plan\r?\n\s+- apply\r?\n\s+- verify\r?\n\s+- abort\r?\n\s+- retire/u.test(
    foundationMigrationWorkflowSource,
  ) &&
  /ABORT-FOUNDATION-MIGRATION-CLEAN-PLANS/u.test(
    foundationAuthorizeStep,
  ) &&
  /test "\$GITHUB_SHA" = "\$TARGET_SHA"/u.test(foundationAuthorizeStep) &&
  /test "\$\(git rev-parse origin\/main\)" = "\$TARGET_SHA"/u.test(
    foundationAuthorizeStep,
  ) &&
  /needs: authorize/u.test(foundationAbortJob) &&
  /if: inputs\.operation == 'abort'/u.test(foundationAbortJob) &&
  /Configure exact one-time migration authority/u.test(foundationAbortJob) &&
  !/Configure permanent narrow foundation authority/u.test(
    foundationAbortJob,
  ) &&
  /foundation-migration-authority\.sh verify-intrinsic/u.test(
    foundationAbortStep,
  ) &&
  /\.verificationMode == "verify-intrinsic"/u.test(foundationAbortStep) &&
  /\.intrinsicSafetyContractVerified == true/u.test(foundationAbortStep) &&
  /\.creationBindingVerified == true/u.test(foundationAbortStep) &&
  /\.selfDeletionAllowed == false/u.test(foundationAbortStep) &&
  /\.permanentRetirementControllerRequired == true/u.test(
    foundationAbortStep,
  ) &&
  /\.resourceCount == 1/u.test(foundationAbortStep) &&
  /repos\/\$\{GITHUB_REPOSITORY\}\/commits\/\$\{authority_source\}/u.test(
    foundationAbortStep,
  ) &&
  /compare\/\$\{authority_source\}\.\.\.\$\{TARGET_SHA\}/u.test(
    foundationAbortStep,
  ) &&
  /\.Stacks\[0\]\.StackStatus[\s\S]*?"CREATE_COMPLETE",[\s\S]*?"UPDATE_COMPLETE",[\s\S]*?"UPDATE_ROLLBACK_COMPLETE"/u.test(
    foundationAbortStep,
  ) &&
  /aws cloudformation list-stack-resources/u.test(foundationAbortStep) &&
  /all\(\s*\(\.Summaries \/\/ \[\]\)\[\];\s*\(\.ChangeSetName \| startswith\("foundation-storage-"\)\)\s*and \.Status == "CREATE_COMPLETE"\s*and \(\.ExecutionStatus \| IN\("AVAILABLE", "OBSOLETE"\)\)\s*and \(\(\.ImportExistingResources \/\/ false\) == false\)/u.test(
    foundationAbortStep,
  ) &&
  /\.ExecutionStatus \| IN\("AVAILABLE", "OBSOLETE"\)/u.test(
    foundationAbortStep,
  ) &&
  /repos\/\$\{GITHUB_REPOSITORY\}\/contents\/aws\/bootstrap-oidc\.yaml\?ref=\$\{plan_source\}/u.test(
    foundationAbortStep,
  ) &&
  /sha256sum "\$source_template"[\s\S]*?plan_template_sha256/u.test(
    foundationAbortStep,
  ) &&
  /plan_queue="\$\{RUNNER_TEMP:\?\}\/foundation-abort-plan-queue\.jsonl"/u.test(
    foundationAbortStep,
  ) &&
  /sort_by\(\.ChangeSetName\)[\s\S]*?@base64[\s\S]*?' "\$plans" >"\$plan_queue"/u.test(
    foundationAbortStep,
  ) &&
  /done <"\$plan_queue"/u.test(foundationAbortStep) &&
  !/< <\(/u.test(foundationAbortStep) &&
  /deletionRequestStarted: null,[\s\S]*?deletionRequestAccepted: false,[\s\S]*?deletionRequestOutcomeKnown: false,[\s\S]*?deleted: false,[\s\S]*?absenceVerified: false/u.test(
    foundationAbortStep,
  ) &&
  foundationAbortStep.indexOf("destructive_actions_started=true") >= 0 &&
  foundationAbortStep.indexOf("destructive_actions_started=true") <
    foundationAbortStep.indexOf("deletionRequestStarted: null") &&
  foundationAbortStep.indexOf("deletionRequestStarted: null") <
    foundationAbortStep.indexOf("aws cloudformation delete-change-set") &&
  /\.\[-1\]\.deletionRequestStarted = true[\s\S]*?\.\[-1\]\.deletionRequestAccepted = true[\s\S]*?\.\[-1\]\.deletionRequestOutcomeKnown = true/u.test(
    foundationAbortStep,
  ) &&
  foundationAbortStep.indexOf("aws cloudformation delete-change-set") <
    foundationAbortStep.indexOf(".[-1].deletionRequestStarted = true") &&
  foundationAbortStep.indexOf(".[-1].deletionRequestStarted = true") <
    foundationAbortStep.indexOf(".[-1].deleted = true") &&
  /for \(\(attempt = 1; attempt <= 30; attempt\+\+\)\); do/u.test(
    foundationAbortStep,
  ) &&
  !/for attempt in \$\(seq/u.test(foundationAbortStep) &&
  /error\("missing in-flight plan journal"\)[\s\S]*?\.\[-1\]\.deleted = true[\s\S]*?\.\[-1\]\.absenceVerified = true/u.test(
    foundationAbortStep,
  ) &&
  /aws cloudformation delete-change-set/u.test(foundationAbortStep) &&
  /\.\[-1\]\.absenceVerified = true/u.test(foundationAbortStep) &&
  /remainingCount: 0/u.test(foundationAbortReceiptSource) &&
  /\)" = "\$target_projection_sha256"/u.test(foundationAbortStep) &&
  /\)" = \\\r?\n\s+"\$target_template_sha256"/u.test(
    foundationAbortStep,
  ) &&
  /\)" = "\$target_policy_sha256"/u.test(foundationAbortStep) &&
  /\)" = "\$target_resources_sha256"/u.test(foundationAbortStep) &&
  !/aws cloudformation delete-stack|iam delete-role/u.test(
    foundationAbortStep,
  ) &&
  foundationAbortReceiptOffset >= 0 &&
  /result: "migration-aborted-authority-retirement-required"/u.test(
    foundationAbortReceiptSource,
  ) &&
  /changeSetCleanupOnly: true/u.test(foundationAbortReceiptSource) &&
  /authorityMutationAttempted: false/u.test(foundationAbortReceiptSource) &&
  /unchangedDuringAbort: true/u.test(foundationAbortReceiptSource) &&
  /stackRetained: true/u.test(foundationAbortReceiptSource) &&
  /roleRetained: true/u.test(foundationAbortReceiptSource) &&
  /stackDeleted: false/u.test(foundationAbortReceiptSource) &&
  /roleDeleted: false/u.test(foundationAbortReceiptSource) &&
  /authorityRetired: false/u.test(foundationAbortReceiptSource) &&
  /terminalRetirementEvidence: false/u.test(
    foundationAbortReceiptSource,
  ) &&
  /externalAdministratorRetirementRequired: null/u.test(
    foundationAbortReceiptSource,
  ) &&
  /externalAdministratorRequirementKnown: false/u.test(
    foundationAbortReceiptSource,
  ) &&
  /nonSelfDeletingExecutorAvailableBeforeApply: null/u.test(
    foundationAbortReceiptSource,
  ) &&
  /permanentRetirementControllerAvailabilityKnown: false/u.test(
    foundationAbortReceiptSource,
  ) &&
  !/AWS_ACCOUNT_ID|arn:aws:/u.test(foundationAbortReceiptSource) &&
  !/cloudformation (?:create|execute)-change-set|cloudformation set-stack-policy|cloudformation update-stack/u.test(
    foundationAbortStep,
  ) &&
  /cloudformation:ListChangeSets/u.test(foundationMigrationAuthoritySource) &&
  /cloudformation:ListStackResources/u.test(
    foundationMigrationAuthoritySource,
  );
const foundationReceiptFailureSafetyValid =
  /record_failure\(\)[\s\S]*?failure_status="\$\?"[\s\S]*?trap - EXIT[\s\S]*?set \+e[\s\S]*?mv -f "\$receipt_next" "\$receipt"[\s\S]*?return "\$failure_status"/u.test(
    foundationAbortStep,
  ) &&
  /trap record_failure EXIT/u.test(foundationAbortStep) &&
  /record_failure\(\)[\s\S]*?failure_status="\$\?"[\s\S]*?trap - EXIT[\s\S]*?set \+e[\s\S]*?mv -f "\$receipt_next" "\$receipt"[\s\S]*?return "\$failure_status"/u.test(
    foundationRetireStep,
  ) &&
  /trap record_failure EXIT/u.test(foundationRetireStep) &&
  /if: always\(\)/u.test(foundationAbortFailureFinalizerStep) &&
  /\.result == "abort-pending"/u.test(foundationAbortFailureFinalizerStep) &&
  /result: "abort-failed"/u.test(foundationAbortFailureFinalizerStep) &&
  /destructiveActionsStarted: null/u.test(
    foundationAbortFailureFinalizerStep,
  ) &&
  /destructiveStateKnown: false/u.test(
    foundationAbortFailureFinalizerStep,
  ) &&
  /failure: \{phase: "pre-main-or-untrapped-failure"\}/u.test(
    foundationAbortFailureFinalizerStep,
  ) &&
  /pendingReceiptFinalized: true/u.test(
    foundationAbortFailureFinalizerStep,
  ) &&
  foundationAbortJob.indexOf(
    "Finalize any untrapped abort failure receipt",
  ) < foundationAbortJob.indexOf("Upload sanitized abort receipt") &&
  /if: always\(\)/u.test(foundationRetirementFailureFinalizerStep) &&
  /\.result == "retire-pending"/u.test(
    foundationRetirementFailureFinalizerStep,
  ) &&
  /result: "retire-failed"/u.test(
    foundationRetirementFailureFinalizerStep,
  ) &&
  /destructiveActionsStarted: null/u.test(
    foundationRetirementFailureFinalizerStep,
  ) &&
  /destructiveStateKnown: false/u.test(
    foundationRetirementFailureFinalizerStep,
  ) &&
  /failure: \{phase: "pre-main-or-untrapped-failure"\}/u.test(
    foundationRetirementFailureFinalizerStep,
  ) &&
  /pendingReceiptFinalized: true/u.test(
    foundationRetirementFailureFinalizerStep,
  ) &&
  foundationRetireJob.indexOf(
    "Finalize any untrapped retirement failure receipt",
  ) < foundationRetireJob.indexOf("Upload sanitized retirement receipt");
const foundationDestructiveTransitionsValid =
  /get-stack-policy[\s\S]*?CURRENT_STACK_POLICY_BODY_FILE[\s\S]*?bootstrap-stack-policy\.pre-storage-migration\.json[\s\S]*?aws cloudformation execute-change-set[\s\S]*?UPDATE_COMPLETE[\s\S]*?set-stack-policy[\s\S]*?file:\/\/aws\/bootstrap-stack-policy\.json[\s\S]*?foundation-immediate-protected-policy/u.test(
    foundationExecuteStep,
  ) &&
  foundationExecuteStep.indexOf("get-stack-policy") <
    foundationExecuteStep.indexOf("aws cloudformation execute-change-set") &&
  (foundationExecuteStep.match(/aws cloudformation set-stack-policy/gu) ?? [])
    .length === 2 &&
  /for \(\(attempt = 1; attempt <= 120; attempt\+\+\)\); do/u.test(
    foundationExecuteStep,
  ) &&
  /UPDATE_ROLLBACK_COMPLETE\)[\s\S]*?Foundation migration rolled back\.[\s\S]*?false/u.test(
    foundationExecuteStep,
  ) &&
  /if: always\(\) && inputs\.operation == 'apply'/u.test(
    foundationPromotePolicyStep,
  ) &&
  /case "\$stack_status" in[\s\S]*?UPDATE_COMPLETE\|UPDATE_ROLLBACK_COMPLETE\)[\s\S]*?terminal=true[\s\S]*?CANDIDATE_TEMPLATE_DIGEST[\s\S]*?\(\$live == \$legacy\[0\] or \$live == \$target\[0\]\)[\s\S]*?policy_source=aws\/bootstrap-stack-policy\.pre-storage-migration\.json[\s\S]*?if \[ "\$candidate_present" = "true" \]; then[\s\S]*?policy_source=aws\/bootstrap-stack-policy\.json[\s\S]*?aws cloudformation set-stack-policy[\s\S]*?\(\.StackPolicyBody \| fromjson\) == \$expected\[0\][\s\S]*?test "\$candidate_present" = "true"/u.test(
    foundationPromotePolicyStep,
  ) &&
  foundationMigrationWorkflowSource.indexOf(
    "Execute under rollback-safe policy and protect success immediately",
  ) <
    foundationMigrationWorkflowSource.indexOf(
      "Reconcile candidate and rollback-safe stack-policy state",
    ) &&
  !/env -i|historical-template-render/u.test(foundationAbortStep) &&
  (foundationAbortStep.match(/\(\.Summaries \/\/ \[\]\) \| length == 0/gu) ?? [])
    .length >= 2 &&
  /cloudformation:DetectStackResourceDrift/u.test(
    foundationMigrationAuthoritySource,
  ) &&
  /prove-foundation-storage-controls\.sh[\s\S]*?detect-stack-resource-drift[\s\S]*?StackResourceDriftStatus == "IN_SYNC"[\s\S]*?\(\.Summaries \/\/ \[\]\) \| length == 0[\s\S]*?fresh_retirement_proof_sha256[\s\S]*?aws cloudformation delete-stack/u.test(
    foundationRetireStep,
  ) &&
  foundationRetireStep.indexOf('target_stack_id="$(jq -er') >= 0 &&
  foundationRetireStep.indexOf('target_stack_id="$(jq -er') <
    foundationRetireStep.indexOf(
      "--logical-resource-id FoundationPromotionRole",
    ) &&
  /freshRetirementProofBound: true/u.test(foundationRetireStep) &&
  /finalAuthorityProofSha256/u.test(foundationRetireStep) &&
  /authority_stack_id="\$\([\s\S]*?jq -ejr '\.Stacks\[0\]\.StackId' "\$authority_stack"[\s\S]*?\)"[\s\S]*?printf '%s' "\$authority_stack_id"[\s\S]*?sha256sum/u.test(
    foundationRetireStep,
  ) &&
  /test "\$authority_stack_id_sha256" = \\\r?\n\s+"\$\(jq -er '\.authorityStackIdSha256' "\$final_authority_proof"\)"/u.test(
    foundationRetireStep,
  ) &&
  /phase=authority-delete[\s\S]*?destructive_actions_started=true[\s\S]*?aws cloudformation delete-stack \\\r?\n\s+--stack-name "\$authority_stack_id" \\\r?\n\s+--role-arn "\$execution_role_arn"/u.test(
    foundationRetireStep,
  ) &&
  /for \(\(attempt = 1; attempt <= 90; attempt\+\+\)\); do/u.test(
    foundationRetireStep,
  ) &&
  /for \(\(attempt = 1; attempt <= 30; attempt\+\+\)\); do/u.test(
    foundationRetireStep,
  ) &&
  !/for attempt in \$\(seq/u.test(foundationRetireStep) &&
  /phase=authority-role-absence[\s\S]*?NoSuchEntity[\s\S]*?test "\$role_absent" = "true"/u.test(
    foundationRetireStep,
  ) &&
  /phase=controller-executor-persistence[\s\S]*?permanent_role_after[\s\S]*?execution_role_after[\s\S]*?permanent_role_sha256[\s\S]*?execution_role_sha256/u.test(
    foundationRetireStep,
  ) &&
  foundationRetireReceiptOffset >= 0 &&
  /controllerRoleArnSha256[\s\S]*?cloudFormationExecutionRoleArnSha256[\s\S]*?authorityRoleArnSha256/u.test(
    foundationRetireReceiptSource,
  ) &&
  /cloudFormationServiceRoleBound: true/u.test(
    foundationRetireReceiptSource,
  ) &&
  /controllerExecutionRoleSeparated: true/u.test(
    foundationRetireReceiptSource,
  ) &&
  /nonSelfDeletingExecutor: true/u.test(foundationRetireReceiptSource) &&
  /selfDeletion: false/u.test(foundationRetireReceiptSource) &&
  /controllerPersistedAfterDeletion: true/u.test(
    foundationRetireReceiptSource,
  ) &&
  /executionRolePersistedAfterDeletion: true/u.test(
    foundationRetireReceiptSource,
  ) &&
  /phase=post-retirement-controls[\s\S]*?bash aws\/prove-foundation-storage-controls\.sh retired[\s\S]*?\.migrationAuthority\.retired == true[\s\S]*?\.migrationAuthority\.selfDeletionAllowed == false[\s\S]*?\.foundationAuthorityRetirement\.cloudFormationServiceRoleBound[\s\S]*?== true[\s\S]*?\.foundationAuthorityRetirement\.controllerExecutionRoleSeparated[\s\S]*?== true[\s\S]*?\.foundationAuthorityRetirement\.selfDeletion == false[\s\S]*?post_retirement_controls_sha256/u.test(
    foundationRetireStep,
  ) &&
  /postRetirementControlsSha256:[\s\S]*?\$postRetirementControlsSha256[\s\S]*?postRetirementControlsBound: true/u.test(
    foundationRetireReceiptSource,
  ) &&
  !/AWS_ACCOUNT_ID|arn:aws:/u.test(foundationRetireReceiptSource) &&
  /finalAuthorityProofBoundImmediatelyBeforeDeletion: true/u.test(
    foundationRetireStep,
  ) &&
  foundationFinalAuthorityProofOffset >= 0 &&
  foundationAuthorityDeleteOffset > foundationFinalAuthorityProofOffset &&
  /"\$authority_verification_mode" >"\$final_authority_proof"/u.test(
    foundationFinalAuthorityProofSource,
  ) &&
  /phase=final-authority-stack-binding[\s\S]*?aws cloudformation describe-stacks[\s\S]*?authority_stack_id_sha256/u.test(
    foundationFinalAuthorityProofSource,
  ) &&
  !/\n\s+git\s|cloudformation (?:create|execute)-change-set|cloudformation set-stack-policy|cloudformation update-stack/u.test(
    foundationFinalAuthorityProofSource,
  );
const foundationRetirementRolesValid =
  /RoleName: !Sub "\$\{AppName\}-foundation-authority-retirement-execution"/u.test(
    foundationAuthorityRetirementExecutionRoleSource,
  ) &&
  /MaxSessionDuration: 3600[\s\S]*?Principal:\s*\r?\n\s+Service: cloudformation\.amazonaws\.com\r?\n\s+Action: sts:AssumeRole/u.test(
    foundationAuthorityRetirementExecutionRoleSource,
  ) &&
  /PolicyName: retire-one-time-foundation-authority/u.test(
    foundationAuthorityRetirementExecutionRoleSource,
  ) &&
  /Sid: DeleteOnlyOneTimeFoundationMigrationRole[\s\S]*?Action:\s*\r?\n\s+- iam:DeleteRole\r?\n\s+- iam:DeleteRolePolicy\r?\n\s+- iam:GetRole\r?\n\s+- iam:GetRolePolicy\r?\n\s+- iam:ListAttachedRolePolicies\r?\n\s+- iam:ListInstanceProfilesForRole\r?\n\s+- iam:ListRolePolicies\r?\n\s+Resource: !Sub >-\r?\n\s+arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:role\/\$\{AppName\}-github-foundation-migration/u.test(
    foundationAuthorityRetirementExecutionRoleSource,
  ) &&
  (foundationAuthorityRetirementExecutionRoleSource.match(/PolicyName:/gu) ?? [])
    .length === 1 &&
  (foundationAuthorityRetirementExecutionRoleSource.match(/\n\s+- Sid:/gu) ?? [])
    .length === 1 &&
  !/iam:PassRole|cloudformation:DeleteStack|Resource:\s*"\*"|AssumeRoleWithWebIdentity/u.test(
    foundationAuthorityRetirementExecutionRoleSource,
  ) &&
  /Sid: RetireOneTimeFoundationMigrationAuthorityStack[\s\S]*?Action: cloudformation:DeleteStack[\s\S]*?stack\/\$\{AppName\}-foundation-migration-authority\/\*[\s\S]*?ArnEquals:\s*\r?\n\s+cloudformation:RoleArn: !GetAtt FoundationAuthorityRetirementExecutionRole\.Arn/u.test(
    foundationPromotionRoleSource,
  ) &&
  /Sid: PassOnlyFoundationAuthorityRetirementExecutionRole[\s\S]*?Action: iam:PassRole[\s\S]*?Resource: !GetAtt FoundationAuthorityRetirementExecutionRole\.Arn[\s\S]*?StringEquals:\s*\r?\n\s+iam:PassedToService: cloudformation\.amazonaws\.com/u.test(
    foundationPromotionRoleSource,
  ) &&
  /Sid: InspectOneTimeFoundationMigrationAuthority[\s\S]*?Action:\s*\r?\n\s+- iam:GetRole\r?\n\s+- iam:GetRolePolicy\r?\n\s+- iam:ListAttachedRolePolicies\r?\n\s+- iam:ListInstanceProfilesForRole\r?\n\s+- iam:ListRolePolicies[\s\S]*?role\/\$\{AppName\}-github-foundation-migration/u.test(
    foundationPromotionRoleSource,
  ) &&
  /Sid: InspectFoundationMigrationState[\s\S]*?Action:\s*\r?\n\s+- cloudformation:DetectStackResourceDrift\r?\n\s+- cloudformation:ListChangeSets\r?\n\s+Resource: !Sub >-\r?\n\s+arn:\$\{AWS::Partition\}:cloudformation:\$\{AWS::Region\}:\$\{AWS::AccountId\}:stack\/\$\{AppName\}-delivery-bootstrap\/\*/u.test(
    foundationPromotionRoleSource,
  ) &&
  (foundationPromotionRoleSource.match(/cloudformation:DeleteStack/gu) ?? [])
    .length === 1 &&
  (foundationPromotionRoleSource.match(/iam:PassRole/gu) ?? []).length === 1 &&
  !/iam:DeleteRole(?:Policy)?/u.test(foundationPromotionRoleSource) &&
  /FoundationAuthorityRetirementExecutionRoleArn:\r?\n\s+Value: !GetAtt FoundationAuthorityRetirementExecutionRole\.Arn/u.test(
    foundationBootstrapSource,
  );
const foundationRetirementProtectionAndProofValid =
  /"logicalResourceId": "FoundationAuthorityRetirementExecutionRole",\s*"resourceType": "AWS::IAM::Role"/u.test(
    foundationRequiredNewResourcesSource,
  ) &&
  (foundationRequiredNewResourcesSource.match(
    /FoundationAuthorityRetirementExecutionRole/gu,
  ) ?? []).length === 1 &&
  !/FoundationAuthorityRetirementExecutionRole/u.test(
    foundationAllowedModificationsSource,
  ) &&
  /"Action": \[[\s\S]*?"Update:Delete",\s*"Update:Replace"[\s\S]*?"LogicalResourceId\/FoundationAuthorityRetirementExecutionRole"/u.test(
    foundationBootstrapStackPolicySource,
  ) &&
  (foundationBootstrapStackPolicySource.match(
    /LogicalResourceId\/FoundationAuthorityRetirementExecutionRole/gu,
  ) ?? []).length === 1 &&
  /foundationAuthorityRetirement: \{[\s\S]*?cloudFormationServiceRoleBound: true,[\s\S]*?controllerExecutionRoleSeparated: true,[\s\S]*?directIamDeletionByController: false,[\s\S]*?unexpectedAttachmentsFailClosed: true,[\s\S]*?selfDeletion: false/u.test(
    foundationStorageProofSource,
  ) &&
  /statement\("InspectOneTimeFoundationMigrationAuthority"\)[\s\S]*?"iam:ListAttachedRolePolicies"[\s\S]*?"iam:ListInstanceProfilesForRole"[\s\S]*?"iam:ListRolePolicies"[\s\S]*?resources == \[\$authorityRoleArn\]/u.test(
    foundationStorageProofSource,
  ) &&
  /statement\("InspectFoundationMigrationState"\)[\s\S]*?"cloudformation:DetectStackResourceDrift"[\s\S]*?"cloudformation:ListChangeSets"[\s\S]*?stack\/" \+ \$app \+ "-delivery-bootstrap\/\*"/u.test(
    foundationStorageProofSource,
  ) &&
  /migrationAuthority: \{[\s\S]*?retirementRequired: true,[\s\S]*?selfDeletionAllowed: false,[\s\S]*?retired: \$migrationAuthorityRetired/u.test(
    foundationStorageProofSource,
  ) &&
  /\.proof\.storage\.migrationAuthority\.retired[\s\S]*?== true[\s\S]*?\.proof\.storage\.migrationAuthority\.selfDeletionAllowed[\s\S]*?== false[\s\S]*?\.proof\.storage\.foundationAuthorityRetirement\.cloudFormationServiceRoleBound[\s\S]*?== true[\s\S]*?\.proof\.storage\.foundationAuthorityRetirement\.controllerExecutionRoleSeparated[\s\S]*?== true[\s\S]*?\.proof\.storage\.foundationAuthorityRetirement\.selfDeletion[\s\S]*?== false/u.test(
    deploymentWorkflowSource,
  );
const foundationLifecycleSemanticsValid =
  foundationLifecycleFilesValid &&
  sharedAwsMutationConcurrencyValid &&
  foundationPolicyCanonicalAndQuotaValid &&
  foundationProofIdentityContractValid &&
  foundationReceiptSelectionContractValid &&
  deploymentControlPlaneFenceContractValid &&
  foundationRetirementRetryAndIdempotencyValid &&
  foundationPhaseZeroContractValid &&
  foundationAuthorityTemplateDigestContractValid &&
  foundationSameRunCleanupValid &&
  foundationAbortContractValid &&
  foundationReceiptFailureSafetyValid &&
  foundationDestructiveTransitionsValid &&
  foundationRetirementRolesValid &&
  foundationRetirementProtectionAndProofValid;
check(
  "foundation-migration-lifecycle-source",
  foundationLifecycleSemanticsValid,
  "The one-time authority cannot self-delete; abort only journals and cleans exact unexecuted plans, while a protected permanent controller passes a dedicated CloudFormation execution role for terminal retirement with fail-closed receipts.",
);

const wa04 = controls.find((control) => control.id === "WA-04");
const edgeProtectionFilesValid = EDGE_PROTECTION_CONTROL_FILES.every((file) => {
  const absolutePath = resolve(ROOT, file);
  return (
    existsSync(absolutePath) &&
    statSync(absolutePath).isFile() &&
    statSync(absolutePath).size > 0
  );
});
const edgeControlWorkflowSource = readRepositorySource(
  ".github/workflows/edge-controls.yml",
);
const edgeControlTemplateSource = readRepositorySource("aws/edge-waf.yaml");
const edgeControlTestSource = readRepositorySource("tests/waf-controls.test.ts");
const edgeInspectStackStep = extractNamedWorkflowStep(
  edgeControlWorkflowSource,
  "Inspect current edge stack state",
);
const edgeCleanupStep = extractNamedWorkflowStep(
  edgeControlWorkflowSource,
  "Clean up exact recoverable edge shell",
);
const edgeCleanupReceiptMarker =
  'receipt_next="${RUNNER_TEMP:?}/edge-cleanup-receipt.json"';
const edgeCleanupReceiptOffset = edgeCleanupStep.indexOf(
  edgeCleanupReceiptMarker,
);
const edgeCleanupReceiptSource =
  edgeCleanupReceiptOffset >= 0
    ? edgeCleanupStep.slice(edgeCleanupReceiptOffset)
    : "";
const edgeCreatePlanStep = extractNamedWorkflowStep(
  edgeControlWorkflowSource,
  "Create or reuse exact edge plan",
);
const edgeLoadPlanStep = extractNamedWorkflowStep(
  edgeControlWorkflowSource,
  "Load exact existing edge plan",
);
const edgeRequirePlanStep = extractNamedWorkflowStep(
  edgeControlWorkflowSource,
  "Require exact non-replacement WAF evidence plan",
);
const edgeExecutePlanStep = extractNamedWorkflowStep(
  edgeControlWorkflowSource,
  "Execute exact inspected edge plan",
);
const edgePreProtectionProofStep = extractNamedWorkflowStep(
  edgeControlWorkflowSource,
  "Prove exact deployed stack before lifecycle protection",
);
const edgeSetProtectionStep = extractNamedWorkflowStep(
  edgeControlWorkflowSource,
  "Set exact edge stack lifecycle protections",
);
const edgeLiveProofStep = extractNamedWorkflowStep(
  edgeControlWorkflowSource,
  "Prove exact deployed WAF controls",
);
const edgeHistoricalFinalizeStep = extractNamedWorkflowStep(
  edgeControlWorkflowSource,
  "Prove historical finalize protection without current-control claims",
);
const edgeOperationSurfaceValid =
  /options:\r?\n\s+- plan\r?\n\s+- apply\r?\n\s+- verify\r?\n\s+- cleanup\r?\n\s+- finalize/u.test(
    edgeControlWorkflowSource,
  ) &&
  /expected_confirmation="APPLY-\$\{environment_upper\}-EDGE-CONTROLS"/u.test(
    edgeControlWorkflowSource,
  ) &&
  /expected_confirmation="CLEANUP-\$\{environment_upper\}-EDGE-CONTROLS"/u.test(
    edgeControlWorkflowSource,
  ) &&
  /expected_confirmation="FINALIZE-\$\{environment_upper\}-EDGE-CONTROLS"/u.test(
    edgeControlWorkflowSource,
  ) &&
  /plan\|verify\)\r?\n\s+test -z "\$CONFIRMATION"/u.test(
    edgeControlWorkflowSource,
  );
const edgeCleanupLifecycleValid =
  /environment: \$\{\{ inputs\.operation == 'cleanup' && 'edge-cleanup' \|\| 'edge-controls' \}\}/u.test(
    edgeControlWorkflowSource,
  ) &&
  /github-edge-cleanup/u.test(edgeControlWorkflowSource) &&
  /^[ \t]+REVIEW_IN_PROGRESS\)\r?$/mu.test(edgeInspectStackStep) &&
  /^[ \t]+apply\|cleanup\) ;;\r?$/mu.test(edgeInspectStackStep) &&
  /EDGE_CLEANUP_PRIOR_STATUS=REVIEW_IN_PROGRESS/u.test(
    edgeInspectStackStep,
  ) &&
  /^[ \t]+ROLLBACK_COMPLETE\)\r?$/mu.test(edgeInspectStackStep) &&
  /test "\$OPERATION" = "cleanup"/u.test(edgeInspectStackStep) &&
  /EDGE_CLEANUP_PRIOR_STATUS=ROLLBACK_COMPLETE/u.test(
    edgeInspectStackStep,
  ) &&
  /if: inputs\.operation == 'cleanup'/u.test(edgeCleanupStep) &&
  /if \$priorStatus == "REVIEW_IN_PROGRESS"\s+then \(\.StackResourceSummaries \| length\) == 0\s+else \$priorStatus == "ROLLBACK_COMPLETE"\s+and all\(\s+\.StackResourceSummaries\[\];\s+\.ResourceStatus == "DELETE_COMPLETE"/u.test(
    edgeCleanupStep,
  ) &&
  /"arn:aws:cloudformation:us-east-1:" \+ \$account/u.test(
    edgeCleanupStep,
  ) &&
  /\.Stacks\[0\]\.StackName == \$stack/u.test(edgeCleanupStep) &&
  /\(\(\.Stacks\[0\]\.RoleARN \/\/ null\) == null\)/u.test(
    edgeCleanupStep,
  ) &&
  /\.Stacks\[0\]\.EnableTerminationProtection == false/u.test(
    edgeCleanupStep,
  ) &&
  /\(\(\.ImportExistingResources \/\/ false\) == false\)/u.test(
    edgeCleanupStep,
  ) &&
  /capture\(\s+"\^operation=edge-controls environment="/u.test(
    edgeCleanupStep,
  ) &&
  /git fetch --no-tags --depth=1 origin "\$cleanup_source_commit"/u.test(
    edgeCleanupStep,
  ) &&
  /"\$\{cleanup_source_commit\}:aws\/edge-waf\.yaml"/u.test(
    edgeCleanupStep,
  ) &&
  /sha256sum "\$cleanup_source_template"/u.test(edgeCleanupStep) &&
  /sha256sum "\$cleanup_template"/u.test(edgeCleanupStep) &&
  /final_stack[\s\S]*?final_resources[\s\S]*?final_change_sets[\s\S]*?final_change_set[\s\S]*?aws cloudformation delete-stack/u.test(
    edgeCleanupStep,
  ) &&
  /aws cloudformation delete-stack \\\r?\n\s+--stack-name "\$stack_id"/u.test(
    edgeCleanupStep,
  ) &&
  /grep -Fq "ValidationError" "\$cleanup_error"/u.test(
    edgeCleanupStep,
  ) &&
  /grep -Fq "does not exist" "\$cleanup_error"/u.test(
    edgeCleanupStep,
  ) &&
  edgeCleanupReceiptOffset >= 0 &&
  /stackDeletedAndNotFound: true/u.test(edgeCleanupReceiptSource) &&
  /stackIdSha256: \$stackIdSha256/u.test(edgeCleanupReceiptSource) &&
  /clientRequestTokenSha256: \$cleanupTokenSha256/u.test(
    edgeCleanupReceiptSource,
  ) &&
  /sourceRepositoryCommitBound: true/u.test(edgeCleanupReceiptSource) &&
  !/--arg stackId "\$stack_id"/u.test(edgeCleanupReceiptSource) &&
  !/AWS_ACCOUNT_ID|arn:aws:/u.test(edgeCleanupReceiptSource) &&
  !/(?:filter-log-events|get-log-events|start-query|set-alarm-state)/u.test(
    edgeCleanupStep,
  );
const edgeFinalizeLifecycleValid =
  /deployed_sha:/u.test(edgeControlWorkflowSource) &&
  /test "\$OPERATION" = "finalize"/u.test(edgeControlWorkflowSource) &&
  /gh api --paginate --slurp[\s\S]*?head_sha=\$\{sha\}[\s\S]*?\.\[\]\.workflow_runs\[\][\s\S]*?prove_green_sha "\$DEPLOYED_SHA"/u.test(
    edgeControlWorkflowSource,
  ) &&
  /repos\/\$GITHUB_REPOSITORY\/compare\/\$\{DEPLOYED_SHA\}\.\.\.\$\{TARGET_SHA\}/u.test(
    edgeControlWorkflowSource,
  ) &&
  /\.base_commit\.sha == \$deployed[\s\S]*?\.merge_base_commit\.sha == \$deployed[\s\S]*?\.head_commit\.sha == \$target[\s\S]*?\.status == "ahead"[\s\S]*?\.ahead_by > 0[\s\S]*?\.behind_by == 0/u.test(
    edgeControlWorkflowSource,
  ) &&
  /if \[ "\$OPERATION" = "finalize" \] \|\|/u.test(edgeInspectStackStep) &&
  /test "\$live_template_digest" = \\\r?\n\s+"\$EDGE_PROTECTION_TEMPLATE_DIGEST"/u.test(
    edgeInspectStackStep,
  ) &&
  /EDGE_APPLY_MODE=finalize/u.test(edgeInspectStackStep) &&
  /if: inputs\.operation == 'plan'/u.test(edgeCreatePlanStep) &&
  /if: inputs\.operation == 'apply' && env\.EDGE_APPLY_MODE == 'execute'/u.test(
    edgeLoadPlanStep,
  ) &&
  /if: inputs\.operation == 'plan' \|\| \(inputs\.operation == 'apply' && env\.EDGE_APPLY_MODE == 'execute'\)/u.test(
    edgeRequirePlanStep,
  ) &&
  /if: inputs\.operation == 'apply' && env\.EDGE_APPLY_MODE == 'execute'/u.test(
    edgeExecutePlanStep,
  ) &&
  /if: \(always\(\) && inputs\.operation == 'apply'\) \|\| \(success\(\) && inputs\.operation == 'finalize'\)/u.test(
    edgePreProtectionProofStep,
  ) &&
  /\(\.StackResourceSummaries \| length\) == 9/u.test(
    edgePreProtectionProofStep,
  ) &&
  /sha256sum "\$lifecycle_template"[\s\S]*?EDGE_PROTECTION_TEMPLATE_DIGEST/u.test(
    edgePreProtectionProofStep,
  ) &&
  /if: \(always\(\) && inputs\.operation == 'apply' && env\.EDGE_BOUND_STACK_ID != ''\) \|\| \(success\(\) && inputs\.operation == 'finalize'\)/u.test(
    edgeSetProtectionStep,
  ) &&
  /aws cloudformation set-stack-policy/u.test(edgeSetProtectionStep) &&
  /aws cloudformation update-termination-protection/u.test(
    edgeSetProtectionStep,
  ) &&
  /if: inputs\.operation == 'apply' \|\| inputs\.operation == 'verify' \|\| \(inputs\.operation == 'finalize' && env\.EDGE_CURRENT_SEMANTICS_MATCH == 'true'\)/u.test(
    edgeLiveProofStep,
  ) &&
  /\(\.StackResourceSummaries \| length\) == 9/u.test(edgeLiveProofStep) &&
  /aws cloudformation get-stack-policy/u.test(edgeLiveProofStep) &&
  /aws wafv2 get-web-acl/u.test(edgeLiveProofStep) &&
  /aws wafv2 get-logging-configuration/u.test(edgeLiveProofStep) &&
  /aws logs describe-log-groups/u.test(edgeLiveProofStep) &&
  /aws logs describe-resource-policies/u.test(edgeLiveProofStep) &&
  /aws events describe-rule/u.test(edgeLiveProofStep) &&
  /aws events list-targets-by-rule/u.test(edgeLiveProofStep) &&
  /aws cloudwatch describe-alarms/u.test(edgeLiveProofStep) &&
  /\$current\.EnableTerminationProtection == true/u.test(
    edgeLiveProofStep,
  ) &&
  /result="finalized-and-proved"/u.test(edgeLiveProofStep) &&
  /historical-finalized-protection-only/u.test(edgeHistoricalFinalizeStep) &&
  /currentLiveControlsProved:\s*false/u.test(edgeHistoricalFinalizeStep) &&
  !/git fetch|origin\/main/u.test(
    edgeExecutePlanStep.slice(
      edgeExecutePlanStep.indexOf("aws cloudformation execute-change-set"),
    ),
  ) &&
  /alarmDeliveryDrill: "not-run"/u.test(edgeLiveProofStep) &&
  /humanPagingDestination: "not-configured-by-this-stack"/u.test(
    edgeLiveProofStep,
  ) &&
  !/(?:filter-log-events|get-log-events|start-query|set-alarm-state)/u.test(
    `${edgeSetProtectionStep}\n${edgeLiveProofStep}`,
  ) &&
  !/cloudformation (?:create|describe|execute)-change-set/u.test(
    `${edgePreProtectionProofStep}\n${edgeSetProtectionStep}\n${edgeLiveProofStep}`,
  );
const edgeProtectionSemanticsValid =
  /^\s{2}workflow_dispatch:/mu.test(edgeControlWorkflowSource) &&
  edgeOperationSurfaceValid &&
  edgeCleanupLifecycleValid &&
  edgeFinalizeLifecycleValid &&
  /AWS_REGION:\s*us-east-1/u.test(edgeControlWorkflowSource) &&
  /sha256sum "\$pending_template"[\s\S]*?EDGE_TEMPLATE_DIGEST/u.test(
    edgeControlWorkflowSource,
  ) &&
  /AWS::WAFv2::LoggingConfiguration/u.test(edgeControlTemplateSource) &&
  /DefaultBehavior:\s*DROP[\s\S]*?Action:\s*BLOCK/u.test(
    edgeControlTemplateSource,
  ) &&
  /RedactedFields:/u.test(edgeControlTemplateSource) &&
  !/SampledRequestsEnabled:\s*true/u.test(edgeControlTemplateSource) &&
  !/Type:\s*AWS::SNS::Topic/u.test(edgeControlTemplateSource) &&
  !/Type:\s*AWS::SQS::Queue/u.test(edgeControlTemplateSource) &&
  /Type:\s*AWS::Events::Rule/u.test(edgeControlTemplateSource) &&
  /Type:\s*AWS::Logs::ResourcePolicy/u.test(edgeControlTemplateSource) &&
  /^\s+"delivery\.logs\.amazonaws\.com",?\s*$/mu.test(
    edgeControlTemplateSource,
  ) &&
  /^\s+"events\.amazonaws\.com",?\s*$/mu.test(
    edgeControlTemplateSource,
  ) &&
  !/AlarmActions:/u.test(edgeControlTemplateSource) &&
  /EdgeAlarmArchiveLogGroup:[\s\S]*?RetentionInDays:\s*14/u.test(
    edgeControlTemplateSource,
  ) &&
  /humanPagingDestination:\s*"not-configured-by-this-stack"/u.test(
    edgeControlWorkflowSource,
  ) &&
  /WAF evidence is BLOCK-only, redacted, service-encrypted, durable, and alarmed/u.test(
    edgeControlTestSource,
  ) &&
  !/us-west-2/u.test(edgeControlTemplateSource);
check(
  "wa04-edge-protection-control-plane-source",
  edgeProtectionFilesValid &&
    foundationLifecycleSemanticsValid &&
    edgeProtectionSemanticsValid &&
    wa04?.state === "repository-prepared-activation-required" &&
    wa04?.requiresExternalApproval === true &&
    wa04?.activatedByThisContract === false &&
    wa04?.evidenceWorkflow === ".github/workflows/edge-controls.yml" &&
    wa04?.controlPlaneTemplate === "aws/edge-waf.yaml" &&
    wa04?.stackPolicy === "aws/edge-stack-policy.json" &&
    wa04?.runbook === "docs/runbooks/waf-abuse-response.md" &&
    wa04?.protectedEnvironment === "edge-controls" &&
    wa04?.cleanupProtectedEnvironment === "edge-cleanup" &&
    wa04?.roleSeparation ===
      "EdgeControlRole cannot list change sets or delete stacks; EdgeCleanupRole cannot create, execute, or delete change sets, set stack policy, change termination protection, pass roles, or assume roles" &&
    wa04?.operations === "plan|apply|verify|cleanup|finalize" &&
    hasExactObjectKeys(wa04?.typedConfirmations, [
      "apply",
      "cleanup",
      "finalize",
    ]) &&
    wa04?.typedConfirmations?.apply ===
      "APPLY-{ENV}-EDGE-CONTROLS" &&
    wa04?.typedConfirmations?.cleanup ===
      "CLEANUP-{ENV}-EDGE-CONTROLS" &&
    wa04?.typedConfirmations?.finalize ===
      "FINALIZE-{ENV}-EDGE-CONTROLS" &&
    sameStrings(wa04?.cleanupEligibleStates, [
      "REVIEW_IN_PROGRESS with zero stack resources",
      "ROLLBACK_COMPLETE with every listed stack resource DELETE_COMPLETE",
    ]) &&
    wa04?.cleanupOldSourceValidation ===
      "change-set source commit and template digest independently re-proved" &&
    wa04?.cleanupTerminalProof ===
      "delete exact stack ID and prove stack name NotFound" &&
    wa04?.cleanupReceiptSanitized === true &&
    wa04?.cleanupFinalPreDeleteRevalidation === true &&
    wa04?.finalizeCreatesChangeSet === false &&
    wa04?.finalizeExactLiveProof === true &&
    wa04?.finalizeHistoricalSourceAllowed === true &&
    typeof wa04?.finalizeHistoricalRequirements === "string" &&
    wa04?.historicalFinalizeClaimsCurrentControls === false &&
    wa04?.postExecuteMutableMainRead === false &&
    Array.isArray(wa04?.updatePlanShapes) &&
    wa04.updatePlanShapes.length === 3 &&
    wa04?.restartSafeProtectionRepair === true &&
    wa04?.alarmDeliveryDrill === "not-run" &&
    wa04?.humanPagingClaimed === false &&
    wa04?.controlPlaneRegion === "us-east-1" &&
    wa04?.applicationWorkloadRegion === false &&
    incrementalFixedCostEvaluation.valid &&
    wa04?.initialFixedMonthlyUsd ===
      incrementalFixedCostEvaluation.scenarioMonthlyUsd.initial &&
    wa04?.maximumRotatedFixedMonthlyUsd ===
      incrementalFixedCostEvaluation.maximumMonthlyUsd &&
    wa04?.approvedFixedMonthlyUsdCeiling ===
      incrementalFixedCostEvaluation.approvedCeilingMonthlyUsd &&
    incrementalFixedCostEvaluation.maximumMonthlyUsd <
      incrementalFixedCostEvaluation.approvedCeilingMonthlyUsd &&
    wa04?.variableUsageExcluded === true,
  "WA-04 binds source-locked foundation creation/abort recovery plus protected plan/apply/verify/cleanup/finalize edge controls, exact recoverable-shell deletion, restart-safe lifecycle protection repair, BLOCK-only redacted service-encrypted WAF evidence, an exact EventBridge-to-CloudWatch-Logs alarm archive, a sub-$26 fixed envelope, and an honest no-delivery-or-human-paging boundary.",
);

const wa05 = controls.find((control) => control.id === "WA-05");
const databaseCredentialRotationFilesValid =
  DATABASE_CREDENTIAL_ROTATION_FILES.every((file) => {
    const absolutePath = resolve(ROOT, file);
    return (
      existsSync(absolutePath) &&
      statSync(absolutePath).isFile() &&
      statSync(absolutePath).size > 0
    );
  });
const databaseCredentialRotationWorkflowSource = readRepositorySource(
  ".github/workflows/database-credential-rotation.yml",
);
const databaseCredentialRotationScriptSource = readRepositorySource(
  "scripts/rotate-runtime-secret.ts",
);
const databaseClientSource = readRepositorySource("src/db/client.ts");
const databaseCredentialRotationTestSource = readRepositorySource(
  "tests/database-credential-rotation.test.ts",
);
const databaseClientRotationTestSource = readRepositorySource(
  "tests/db-client-rotation.test.ts",
);
const databaseCredentialRotationSemanticsValid =
  /^\s{2}workflow_dispatch:/mu.test(
    databaseCredentialRotationWorkflowSource,
  ) &&
  /environment:\s*production-db/u.test(
    databaseCredentialRotationWorkflowSource,
  ) &&
  /database-\?{6}/u.test(databaseCredentialRotationWorkflowSource) &&
  /cockroach-admin-\?{6}/u.test(
    databaseCredentialRotationWorkflowSource,
  ) &&
  !/(?:database|cockroach-admin)-\*/u.test(
    databaseCredentialRotationWorkflowSource,
  ) &&
  /ROTATION_INTERRUPTED_STATE_UNKNOWN/u.test(
    databaseCredentialRotationWorkflowSource,
  ) &&
  /Attest the sanitized exact-SHA rotation receipt\s+if: always\(\)/u.test(
    databaseCredentialRotationWorkflowSource,
  ) &&
  /export async function recoverFailedRotation/u.test(
    databaseCredentialRotationScriptSource,
  ) &&
  /new ListSecretVersionIdsCommand/u.test(
    databaseCredentialRotationScriptSource,
  ) &&
  /RuntimeCredentialRotationFailure/u.test(
    databaseCredentialRotationScriptSource,
  ) &&
  /createCredentialPoolController/u.test(databaseClientSource) &&
  /COCKROACH_SQL_DNS/u.test(databaseClientSource) &&
  /lost Put response reconciles/u.test(
    databaseCredentialRotationTestSource,
  ) &&
  /lost Update response requires exact current observation/u.test(
    databaseCredentialRotationTestSource,
  ) &&
  /stale cutover reads fail closed/u.test(
    databaseCredentialRotationTestSource,
  ) &&
  /injected rollback and cleanup failures/u.test(
    databaseCredentialRotationTestSource,
  ) &&
  /concurrent fake-pg refresh coalesces/u.test(
    databaseClientRotationTestSource,
  ) &&
  /failed fake-pg candidate never replaces/u.test(
    databaseClientRotationTestSource,
  );
check(
  "wa05-database-credential-rotation-source",
  databaseCredentialRotationFilesValid &&
    databaseCredentialRotationSemanticsValid &&
    wa05?.state === "repository-prepared-activation-required" &&
    wa05?.requiresExternalApproval === true &&
    wa05?.activatedByThisContract === false &&
    wa05?.evidenceWorkflow ===
      ".github/workflows/database-credential-rotation.yml" &&
    wa05?.runtimeRefresh === "src/db/client.ts" &&
    wa05?.rotationScript === "scripts/rotate-runtime-secret.ts" &&
    wa05?.runbook === "docs/runbooks/credential-compromise.md" &&
    wa05?.protectedEnvironment === "production-db" &&
    wa05?.mutationPermittedOnlyByEvidenceWorkflow === true,
  "WA-05 binds protected two-principal rotation, hot runtime refresh, explicit operator tooling, and its compromise runbook without claiming a live drill.",
);

const wa06 = controls.find((control) => control.id === "WA-06");
const stagingRecoveryDrillFilesValid = STAGING_RECOVERY_DRILL_FILES.every(
  (file) => {
    const absolutePath = resolve(ROOT, file);
    return (
      existsSync(absolutePath) &&
      statSync(absolutePath).isFile() &&
      statSync(absolutePath).size > 0
    );
  },
);
const stagingRecoveryDeploySource = readRepositorySource(
  ".github/workflows/deploy-aws.yml",
);
const stagingRecoveryWatchdogSource = readRepositorySource(
  ".github/workflows/recover-aws.yml",
);
const stagingRecoveryTemplateSource = readRepositorySource("aws/template.yaml");
const stagingRecoveryBootstrapSource = readRepositorySource(
  "aws/bootstrap-oidc.yaml",
);
const stagingRecoveryGitHubClassifierSource = readRepositorySource(
  "aws/classify-github-recovery-preflight.sh",
);
const stagingRecoveryDurableClassifierSource = readRepositorySource(
  "aws/classify-durable-recovery-source.sh",
);
const stagingRecoveryCodeDeploySelectorSource = readRepositorySource(
  "aws/select-staging-codedeploy-rollback.mjs",
);
const stagingRecoveryAppSpecFetcherSource = readRepositorySource(
  "aws/fetch-codedeploy-appspec-revision.sh",
);
const stagingRecoveryTestSource = readRepositorySource(
  "tests/staging-recovery-drill.test.ts",
);
const stagingRecoveryWatchdogTestSource = readRepositorySource(
  "tests/recovery-watchdog.test.ts",
);
const stagingRecoveryGitHubPreflightTestSource = readRepositorySource(
  "tests/github-recovery-preflight.test.ts",
);
const stagingCodeDeployPolicyStart = stagingRecoveryBootstrapSource.indexOf(
  "  StagingCodeDeployInspectionPolicy:",
);
const stagingCodeDeployPolicyEnd = stagingRecoveryBootstrapSource.indexOf(
  "  StagingAlarmRoutingInspectionPolicy:",
  stagingCodeDeployPolicyStart,
);
const stagingCodeDeployPolicySource =
  stagingCodeDeployPolicyStart >= 0 &&
  stagingCodeDeployPolicyEnd > stagingCodeDeployPolicyStart
    ? stagingRecoveryBootstrapSource.slice(
        stagingCodeDeployPolicyStart,
        stagingCodeDeployPolicyEnd,
      )
    : "";
const stagingCodeDeployActions = [
  ...stagingCodeDeployPolicySource.matchAll(
    /(?:Action:\s+|- )(codedeploy:[A-Za-z]+)$/gmu,
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
    ].sort(),
  );
const recoveryDrillGatePosition = stagingRecoveryDeploySource.indexOf(
  "Authorize the exact existing staging release for fault injection",
);
const recoveryDrillArmPosition = stagingRecoveryDeploySource.indexOf(
  "Persist and arm the immutable staging recovery intent",
);
const recoveryDrillDeployPosition = stagingRecoveryDeploySource.indexOf(
  "Deploy staging with recovery-safe SAM canary",
);
const stagingRecoverySemanticsValid =
  recoveryDrillGatePosition >= 0 &&
  recoveryDrillGatePosition < recoveryDrillArmPosition &&
  recoveryDrillArmPosition < recoveryDrillDeployPosition &&
  /-\s+staging-recovery-drill/u.test(stagingRecoveryDeploySource) &&
  /FAULT-INJECT-STAGING-RECOVERY-AND-REQUIRE-WATCHDOG/u.test(
    stagingRecoveryDeploySource,
  ) &&
  /test "\$HAS_PREVIOUS_STACK" = "true"/u.test(
    stagingRecoveryDeploySource,
  ) &&
  /exact_parameter\("ReleaseCommitSha"; \$release\)/u.test(
    stagingRecoveryDeploySource,
  ) &&
  /exact_parameter\("RecoveryDrillToken"; "disabled"\)/u.test(
    stagingRecoveryDeploySource,
  ) &&
  /database-release:[\s\S]*?if: github\.event_name == 'push'/u.test(
    stagingRecoveryDeploySource,
  ) &&
  /managed-mcp-production-audit:[\s\S]*?if: github\.event_name == 'push'/u.test(
    stagingRecoveryDeploySource,
  ) &&
  /needs\.database-release\.result == 'skipped'/u.test(
    stagingRecoveryDeploySource,
  ) &&
  /!cancelled\(\)/u.test(stagingRecoveryDeploySource) &&
  /needs\.managed-mcp-production-audit\.result == 'skipped'/u.test(
    stagingRecoveryDeploySource,
  ) &&
  /exact_parameter\("CockroachSqlDns"; \$cockroachSqlDns\)/u.test(
    stagingRecoveryDeploySource,
  ) &&
  /staging-deployment-receipt-/u.test(stagingRecoveryDeploySource) &&
  /recovery-drill-inaccessible-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}/u.test(
    stagingRecoveryDeploySource,
  ) &&
  /AdditionalVersionWeights[\s\S]*?\.value >= 0\.099[\s\S]*?\.value <= 0\.101/u.test(
    stagingRecoveryDeploySource,
  ) &&
  /source\.errorInformation\?\.code !== "ALARM_ACTIVE"/u.test(
    stagingRecoveryCodeDeploySelectorSource,
  ) &&
  /source\.status !== "Stopped"/u.test(
    stagingRecoveryCodeDeploySelectorSource,
  ) &&
  /source\.externalId !== stackId/u.test(
    stagingRecoveryCodeDeploySelectorSource,
  ) &&
  /revision\.currentVersion === previousVersion/u.test(
    stagingRecoveryCodeDeploySelectorSource,
  ) &&
  /revision\.targetVersion === candidateVersion/u.test(
    stagingRecoveryCodeDeploySelectorSource,
  ) &&
  /calculatedSha === requestedSha/u.test(
    stagingRecoveryCodeDeploySelectorSource,
  ) &&
  /sourceMatches\.length === 1/u.test(
    stagingRecoveryCodeDeploySelectorSource,
  ) &&
  /rollbackMatches\.length === 1/u.test(
    stagingRecoveryCodeDeploySelectorSource,
  ) &&
  /observed >= started/u.test(stagingRecoveryCodeDeploySelectorSource) &&
  /ended >= observed/u.test(stagingRecoveryCodeDeploySelectorSource) &&
  /created >= sourceCreated/u.test(stagingRecoveryCodeDeploySelectorSource) &&
  /staging-recovery-drill-started-epoch/u.test(
    stagingRecoveryDeploySource,
  ) &&
  /bash aws\/fetch-codedeploy-appspec-revision\.sh/u.test(
    stagingRecoveryDeploySource,
  ) &&
  /deploy get-application-revision/u.test(
    stagingRecoveryAppSpecFetcherSource,
  ) &&
  /appSpecContent: \{sha256: \$sha\}/u.test(
    stagingRecoveryAppSpecFetcherSource,
  ) &&
  /\.revision\.appSpecContent\.sha256 == \$sha/u.test(
    stagingRecoveryAppSpecFetcherSource,
  ) &&
  /sourceStatus: "Stopped"/u.test(stagingRecoveryDeploySource) &&
  /"UPDATE_ROLLBACK_COMPLETE"/u.test(stagingRecoveryDeploySource) &&
  /schema:\s*"archon\.staging-recovery-drill"[\s\S]*?version:\s*2/u.test(
    stagingRecoveryDeploySource,
  ) &&
  /behaviorFaultInjected:\s*true/u.test(stagingRecoveryDeploySource) &&
  /productionMutationPermitted:\s*false/u.test(
    stagingRecoveryDeploySource,
  ) &&
  /deploy-production:[\s\S]*?if: success\(\) && github\.event_name == 'push'/u.test(
    stagingRecoveryDeploySource,
  ) &&
  /\.state == "RECOVERED"/u.test(stagingRecoveryWatchdogSource) &&
  /successful-recovery-receipt-proved/u.test(
    stagingRecoveryGitHubClassifierSource,
  ) &&
  /if \[ "\$run_event" != "workflow_dispatch" \]; then[\s\S]*?classify_environment_job production/u.test(
    stagingRecoveryGitHubClassifierSource,
  ) &&
  /\.event == "workflow_run"/u.test(
    stagingRecoveryGitHubClassifierSource,
  ) &&
  /test "\$run_count" -eq "\$expected_run_count"/u.test(
    stagingRecoveryGitHubClassifierSource,
  ) &&
  /test "\$artifact_count" -eq "\$expected_artifact_count"/u.test(
    stagingRecoveryGitHubClassifierSource,
  ) &&
  /\.event == "workflow_dispatch" and \$environment == "staging"/u.test(
    stagingRecoveryDurableClassifierSource,
  ) &&
  /\.event == "workflow_run"/u.test(
    stagingRecoveryDurableClassifierSource,
  ) &&
  !/\.event == "workflow_dispatch" and \$environment == "production"/u.test(
    stagingRecoveryDurableClassifierSource,
  ) &&
  /queued\|in_progress\|pending\|waiting\|requested/u.test(
    stagingRecoveryDurableClassifierSource,
  ) &&
  /The Deploy AWS run status is invalid\./u.test(
    stagingRecoveryDurableClassifierSource,
  ) &&
  /\.total_count == \(\.jobs \| length\)/u.test(
    stagingRecoveryDurableClassifierSource,
  ) &&
  /classifier fails closed on an unknown Deploy AWS source status/u.test(
    stagingRecoveryWatchdogTestSource,
  ) &&
  /classifier fails closed on a truncated Deploy AWS jobs response/u.test(
    stagingRecoveryWatchdogTestSource,
  ) &&
  /classifier fails closed on an unknown prior watchdog owner status/u.test(
    stagingRecoveryWatchdogTestSource,
  ) &&
  /trusted legacy workflow-run sources/u.test(
    stagingRecoveryWatchdogTestSource,
  ) &&
  /GitHub preflight fails closed on an unknown listed deploy status/u.test(
    stagingRecoveryGitHubPreflightTestSource,
  ) &&
  /GitHub preflight fails closed on a truncated jobs response/u.test(
    stagingRecoveryGitHubPreflightTestSource,
  ) &&
  /GitHub preflight fails closed on a truncated workflow-runs response/u.test(
    stagingRecoveryGitHubPreflightTestSource,
  ) &&
  /GitHub preflight fails closed on a truncated recovery-artifact response/u.test(
    stagingRecoveryGitHubPreflightTestSource,
  ) &&
  /never promotes dispatch metadata into a production recovery candidate/u.test(
    stagingRecoveryGitHubPreflightTestSource,
  ) &&
  /trusted legacy workflow-run deploy history/u.test(
    stagingRecoveryGitHubPreflightTestSource,
  ) &&
  /RecoveryDrillToken:/u.test(stagingRecoveryTemplateSource) &&
  /RecoveryDrillIsStagingOnly:[\s\S]*?RuleCondition: !Not \[!Equals \[!Ref RecoveryDrillToken, disabled\]\][\s\S]*?Assert: !Equals \[!Ref Environment, staging\]/u.test(
    stagingRecoveryTemplateSource,
  ) &&
  /RECOVERY_DRILL_TOKEN:\s*!Ref RecoveryDrillToken/u.test(
    stagingRecoveryTemplateSource,
  ) &&
  exactStagingCodeDeployActions &&
  /application:\$\{AppName\}-staging-\*/u.test(
    stagingCodeDeployPolicySource,
  ) &&
  /deploymentgroup:\$\{AppName\}-staging-\*\/\*/u.test(
    stagingCodeDeployPolicySource,
  ) &&
  (stagingCodeDeployPolicySource.match(
    /aws:RequestedRegion: !Ref AWS::Region/gu,
  ) ?? []).length === 2 &&
  (stagingCodeDeployPolicySource.match(/Effect: Allow/gu) ?? []).length ===
    2 &&
  !/Resource: "\*"/u.test(stagingCodeDeployPolicySource) &&
  /CodeDeploy selector proves the exact stack, drill window, AppSpec, and rollback relation/u.test(
    stagingRecoveryTestSource,
  ) &&
  /receipt requires Stopped ALARM_ACTIVE, related successful rollback/u.test(
    stagingRecoveryTestSource,
  ) &&
  /AppSpec fetcher sends the exact deployment SHA in the documented AWS request shape/u.test(
    stagingRecoveryTestSource,
  ) &&
  /CodeDeploy selector rejects reversed runner and deployment chronology/u.test(
    stagingRecoveryTestSource,
  );
check(
  "wa06-fault-injected-recovery-source",
  stagingRecoveryDrillFilesValid &&
    stagingRecoverySemanticsValid &&
    wa06?.state === "repository-prepared-live-drill-required" &&
    wa06?.requiresExternalApproval === true &&
    wa06?.activatedByThisContract === false &&
    wa06?.evidenceWorkflow === ".github/workflows/deploy-aws.yml" &&
    wa06?.terminalizationWorkflow === ".github/workflows/recover-aws.yml" &&
    wa06?.applicationTemplate === "aws/template.yaml" &&
    wa06?.runbook === "docs/runbooks/rollback-recovery.md" &&
    wa06?.protectedEnvironment === "staging" &&
    wa06?.recoveryDrillTokenEnforcedStagingOnlyByTemplate === true &&
    wa06?.sourceDeploymentAlarmTerminalStatus === "Stopped" &&
    wa06?.sourceDeploymentBoundToExactStackAndDrillWindow === true &&
    wa06?.sourceDeploymentBoundToShaVerifiedLambdaAppSpec === true &&
    wa06?.appSpecFetchRequestBehaviorallyTested === true &&
    wa06?.codeDeployInspectionStagingResourceScoped === true &&
    wa06?.githubRecoveryPaginationCompleteAndLegacyCompatible === true &&
    wa06?.watchdogUnknownStatusAndIncompleteInventoryFailClosed === true &&
    wa06?.sharedProductionDatabaseReconciliationPermitted === false &&
    wa06?.sharedProductionManagedMcpAuditPermitted === false &&
    wa06?.productionFaultInjectionPermitted === false &&
    wa06?.liveTerminalRecoveryClaimedByRepository === false,
  "WA-06 binds a template-enforced staging-only fault to an observed 10% canary, exact-stack/time/AppSpec ALARM_ACTIVE CodeDeploy rollback, exact automatic prestate proof, durable ARMED handoff, fail-closed watchdog evidence, and subsequent no-op classification without claiming a live run.",
);

const wa07 = controls.find((control) => control.id === "WA-07");
const managedRestoreDrillFilesValid = MANAGED_RESTORE_DRILL_FILES.every(
  (file) => {
    const absolutePath = resolve(ROOT, file);
    return (
      existsSync(absolutePath) &&
      statSync(absolutePath).isFile() &&
      statSync(absolutePath).size > 0
    );
  },
);
const managedRestoreWorkflowSource = readRepositorySource(
  ".github/workflows/cockroach-restore-drill.yml",
);
const managedRestoreScriptSource = readRepositorySource(
  "scripts/cockroach-managed-restore-drill.ts",
);
const managedRestoreTestSource = readRepositorySource(
  "tests/cockroach-managed-restore-drill.test.ts",
);
const managedRestoreSemanticsValid =
  /^\s{2}workflow_dispatch:/mu.test(managedRestoreWorkflowSource) &&
  /name:\s*operations-drill/u.test(managedRestoreWorkflowSource) &&
  /name:\s*production-db/u.test(managedRestoreWorkflowSource) &&
  /test "\$RPO_OBJECTIVE_MINUTES" -ge 1440/u.test(
    managedRestoreWorkflowSource,
  ) &&
  /Attest the sanitized exact-SHA restore receipt/u.test(
    managedRestoreWorkflowSource,
  ) &&
  /pointInTimeRestore:\s*false/u.test(managedRestoreScriptSource) &&
  /cutoverPerformed:\s*false/u.test(managedRestoreScriptSource) &&
  /provisioningPerformed:\s*false/u.test(managedRestoreScriptSource) &&
  /const EXPECTED_REGION = "eu-west-1"/u.test(managedRestoreScriptSource) &&
  /regions\.some\(\(region\) => region\.name === "us-west-2"\)/u.test(
    managedRestoreScriptSource,
  ) &&
  /post-restore proof covers schema, grants, roles, RLS, C-SPANN, and canonical memory/u.test(
    managedRestoreTestSource,
  );
check(
  "wa07-managed-backup-restore-source",
  managedRestoreDrillFilesValid &&
    managedRestoreSemanticsValid &&
    wa07?.state === "repository-prepared-live-restore-required" &&
    wa07?.requiresExternalApproval === true &&
    wa07?.activatedByThisContract === false &&
    wa07?.evidenceWorkflow ===
      ".github/workflows/cockroach-restore-drill.yml" &&
    wa07?.drillScript === "scripts/cockroach-managed-restore-drill.ts" &&
    wa07?.runbook === "docs/runbooks/database-restore.md" &&
    wa07?.protectedAuthorizationEnvironment === "operations-drill" &&
    wa07?.protectedMutationEnvironment === "production-db" &&
    wa07?.pointInTimeRestoreClaimed === false &&
    wa07?.additionalRegionActivated === false,
  "WA-07 binds a protected exact-backup restore into an existing isolated destination, verifies database evidence, and makes no PITR, cutover, provisioning, or additional-region claim.",
);

const wa08 = controls.find((control) => control.id === "WA-08");
const hostedPerformanceEvidenceFilesValid =
  HOSTED_PERFORMANCE_EVIDENCE_FILES.every((file) => {
    const absolutePath = resolve(ROOT, file);
    return (
      existsSync(absolutePath) &&
      statSync(absolutePath).isFile() &&
      statSync(absolutePath).size > 0
    );
  });
const hostedPerformanceWorkflowSource = readRepositorySource(
  ".github/workflows/hosted-load-evidence.yml",
);
const hostedPerformanceWorkloadSource = readRepositorySource(
  "load/hosted-recall.js",
);
const hostedPerformanceContractSource = readRepositorySource(
  "load/hosted-recall-contract.js",
);
const hostedPerformanceTestSource = readRepositorySource(
  "tests/hosted-load-evidence.test.ts",
);
const hostedPerformanceSemanticsValid =
  /^\s{2}workflow_dispatch:/mu.test(hostedPerformanceWorkflowSource) &&
  /test "\$TOTAL_ITERATIONS" -ge 20/u.test(
    hostedPerformanceWorkflowSource,
  ) &&
  /test "\$TOTAL_ITERATIONS" -le 200/u.test(
    hostedPerformanceWorkflowSource,
  ) &&
  /test "\$VUS" -ge 2/u.test(hostedPerformanceWorkflowSource) &&
  /test "\$VUS" -le 10/u.test(hostedPerformanceWorkflowSource) &&
  /--new-machine-readable-summary/u.test(hostedPerformanceWorkflowSource) &&
  /\.version == "1\.0\.0"/u.test(hostedPerformanceWorkflowSource) &&
  /\.results\.metrics/u.test(hostedPerformanceWorkflowSource) &&
  /executor:\s*"shared-iterations"/u.test(hostedPerformanceWorkloadSource) &&
  /hosted_recall_contract:\s*\["rate>=1"\]/u.test(
    hostedPerformanceWorkloadSource,
  ) &&
  /HOSTED_RECALL_KIND = "payroll_event"/u.test(
    hostedPerformanceContractSource,
  ) &&
  /retrieval\.requestedKind === HOSTED_RECALL_KIND/u.test(
    hostedPerformanceContractSource,
  ) &&
  /citation\.kind === HOSTED_RECALL_KIND/u.test(
    hostedPerformanceContractSource,
  ) &&
  /wrongRequestedKind/u.test(hostedPerformanceTestSource) &&
  /wrongKind/u.test(hostedPerformanceTestSource);
check(
  "wa08-hosted-performance-evidence-source",
  hostedPerformanceEvidenceFilesValid &&
    hostedPerformanceSemanticsValid &&
    wa08?.state ===
      "repository-prepared-hosted-measurement-required" &&
    wa08?.requiresExternalApproval === true &&
    wa08?.activatedByThisContract === false &&
    wa08?.evidenceWorkflow ===
      ".github/workflows/hosted-load-evidence.yml" &&
    wa08?.workload === "load/hosted-recall.js" &&
    wa08?.responseContract === "load/hosted-recall-contract.js" &&
    wa08?.mutationPermitted === false &&
    wa08?.productionScaleClaimPermitted === false,
  "WA-08 binds an approval-gated bounded hosted measurement to the exact deployed green release, machine-readable k6 evidence, and the same fail-closed response validator used by the workload.",
);

const wa09 = controls.find((control) => control.id === "WA-09");
const finopsControlFilesValid = FINOPS_CONTROL_FILES.every((file) => {
  const absolutePath = resolve(ROOT, file);
  return (
    existsSync(absolutePath) &&
    statSync(absolutePath).isFile() &&
    statSync(absolutePath).size > 0
  );
});
const finopsWorkflowSource = readRepositorySource(
  ".github/workflows/finops-controls.yml",
);
const finopsTemplateSource = readRepositorySource("aws/finops.yaml");
const finopsTestSource = readRepositorySource("tests/finops-controls.test.ts");
const finopsSemanticsValid =
  /^\s{2}workflow_dispatch:/mu.test(finopsWorkflowSource) &&
  /environment:\s*finops-controls/u.test(finopsWorkflowSource) &&
  /-\s+plan[\s\S]*?-\s+apply[\s\S]*?-\s+verify/u.test(
    finopsWorkflowSource,
  ) &&
  /APPLY-WORKLOAD-FINOPS-CONTROLS-AND-ROUTING-TEST/u.test(
    finopsWorkflowSource,
  ) &&
  /AWS_REGION:\s*us-east-1/u.test(finopsWorkflowSource) &&
  /AWS::Budgets::Budget/u.test(finopsTemplateSource) &&
  /AWS::CE::AnomalyMonitor/u.test(finopsTemplateSource) &&
  /AWS::CE::AnomalySubscription/u.test(finopsTemplateSource) &&
  /not an application workload region/u.test(finopsTemplateSource) &&
  !/us-west-2/u.test(finopsTemplateSource) &&
  /plan and apply bind one immutable non-replacement change set/u.test(
    finopsTestSource,
  ) &&
  /apply-only routing test/u.test(finopsTestSource);
check(
  "wa09-finops-controls-source",
  finopsControlFilesValid &&
    finopsSemanticsValid &&
    wa09?.state === "repository-prepared-activation-required" &&
    wa09?.requiresExternalApproval === true &&
    wa09?.activatedByThisContract === false &&
    wa09?.evidenceWorkflow === ".github/workflows/finops-controls.yml" &&
    wa09?.controlPlaneTemplate === "aws/finops.yaml" &&
    wa09?.runbook === "docs/runbooks/cost-anomaly.md" &&
    wa09?.costModel === "docs/finops/COST_MODEL.md" &&
    wa09?.protectedEnvironment === "finops-controls" &&
    wa09?.operations === "plan|apply|verify" &&
    wa09?.controlPlaneRegion === "us-east-1" &&
    wa09?.applicationWorkloadRegion === false &&
    wa09?.humanApprovedInputsRequired === true,
  "WA-09 binds human-approved plan/apply/verify FinOps controls, immutable change-set identity, encrypted notification-route proof, and the billing-only us-east-1 boundary.",
);

const wa10 = controls.find((control) => control.id === "WA-10");
const sustainabilityIntensityFilesValid =
  SUSTAINABILITY_INTENSITY_FILES.every((file) => {
    const absolutePath = resolve(ROOT, file);
    return (
      existsSync(absolutePath) &&
      statSync(absolutePath).isFile() &&
      statSync(absolutePath).size > 0
    );
  });
check(
  "wa10-sustainability-intensity-source",
  sustainabilityIntensityFilesValid &&
    wa10?.state === "repository-prepared-live-measurement-required" &&
    wa10?.requiresExternalApproval === true &&
    wa10?.activatedByThisContract === false &&
    wa10?.evidenceWorkflow ===
      ".github/workflows/sustainability-intensity-evidence.yml" &&
    wa10?.auditScript === "aws/measure-sustainability-intensity.sh" &&
    wa10?.referencePolicy ===
      "aws/sustainability-intensity-audit-policy.json" &&
    wa10?.runbook === "docs/runbooks/sustainability-intensity.md" &&
    wa10?.protectedEnvironment === "sustainability-audit" &&
    wa10?.roleVariable === "AWS_SUSTAINABILITY_AUDIT_ROLE_ARN" &&
    wa10?.mutationPermitted === false &&
    wa10?.emissionsClaimPermitted === false,
  "WA-10 binds a protected read-only intensity workflow, exact hosted-load denominator, least-privilege reference policy, and honest non-emissions boundary without claiming live evidence.",
);

const approvalGates = contract.approvalGates ?? [];
check(
  "approval-gates",
  sameStrings(
    approvalGates.map((gate) => gate.id).sort(),
    [
      "account-security-baseline-audit",
      "additional-region",
      "billable-or-account-wide-control-activation",
      "live-read-only-audit",
      "staging-fault-injected-recovery",
      "sustainability-intensity-measurement",
    ],
  ) &&
    approvalGates.every(
      (gate) =>
        gate.required === true &&
        Array.isArray(gate.conditions) &&
        gate.conditions.length > 0,
    ) &&
    sameStrings(
      approvalGates
        .filter((gate) => gate.mutationAllowed === true)
        .map((gate) => gate.id),
      ["staging-fault-injected-recovery"],
    ) &&
    approvalGates
      .filter((gate) => gate.id !== "staging-fault-injected-recovery")
      .every((gate) => gate.mutationAllowed === false),
  "Live inventory, WA-03 account security, WA-10 intensity evidence, billable/account-wide activation, and additional-region decisions stay non-mutating; only the protected staging fault drill has bounded mutation authority.",
);

const requiredDocuments = contract.requiredDocuments ?? [];
let documentsValid =
  Array.isArray(requiredDocuments) &&
  requiredDocuments.length > 0 &&
  new Set(requiredDocuments).size === requiredDocuments.length;
for (const document of requiredDocuments) {
  const absolutePath = resolve(ROOT, document);
  const relativePath = relative(ROOT, absolutePath);
  const insideRepository =
    relativePath !== "" &&
    !relativePath.startsWith("..") &&
    !relativePath.startsWith(sep);
  documentsValid &&=
    insideRepository &&
    existsSync(absolutePath) &&
    statSync(absolutePath).isFile() &&
    statSync(absolutePath).size > 0;
}
check(
  "required-documents",
  documentsValid,
  "Every contract-bound operations, FinOps, sustainability, and runbook document exists and is nonempty.",
);

let deploymentBoundaryValid = true;
for (const file of DEPLOYMENT_BOUNDARY_FILES) {
  const contents = readFileSync(resolve(ROOT, file), "utf8");
  deploymentBoundaryValid &&=
    contents.includes("eu-west-1") && !contents.includes("us-west-2");
}
check(
  "deployment-source-region-boundary",
  deploymentBoundaryValid,
  "Application deployment sources name eu-west-1 and contain no us-west-2 deployment value.",
);

const edgeWafControlPlane = readFileSync(
  resolve(ROOT, EDGE_WAF_CONTROL_PLANE_FILE),
  "utf8",
);
check(
  "edge-waf-control-plane-boundary",
  edgeWafControlPlane.includes("AWS::WAFv2::WebACL") &&
    edgeWafControlPlane.includes("Scope: CLOUDFRONT") &&
    edgeWafControlPlane.includes("us-east-1") &&
    edgeWafControlPlane.includes("not an application workload region") &&
    !edgeWafControlPlane.includes("us-west-2"),
  "The optional CloudFront WAF control plane is isolated to us-east-1 and explicitly excluded from application workloads.",
);

const finopsControlPlane = readFileSync(
  resolve(ROOT, FINOPS_CONTROL_PLANE_FILE),
  "utf8",
);
check(
  "finops-control-plane-boundary",
  finopsControlPlane.includes("AWS::Budgets::Budget") &&
    finopsControlPlane.includes("AWS::CE::AnomalyMonitor") &&
    finopsControlPlane.includes("AWS::CE::AnomalySubscription") &&
    finopsControlPlane.includes("us-east-1") &&
    finopsControlPlane.includes("not an application workload region") &&
    finopsControlPlane.includes("explicit-live-activation-required") &&
    !finopsControlPlane.includes("us-west-2"),
  "The dormant budget and anomaly controls are isolated to the us-east-1 billing control plane and require explicit live activation.",
);

const passed = checks.every((item) => item.status === "pass");
const receipt = {
  schema: "archon.aws-well-architected.repository-audit",
  version: 1,
  generatedAt: new Date().toISOString(),
  repository:
    process.env.GITHUB_REPOSITORY ??
    contract.workload?.repository ??
    "unknown",
  commitSha: process.env.GITHUB_SHA ?? "",
  mode,
  passed,
  regionPolicy: {
    primaryRegion: contract.regionPolicy?.primaryRegion ?? "unknown",
    forbiddenRegion:
      contract.regionPolicy?.explicitlyForbiddenRegions?.[0] ?? "unknown",
    globalFrontDoor: contract.regionPolicy?.globalFrontDoor ?? "unknown",
  },
  activation: {
    awsMutationPermitted:
      contract.activation?.awsMutationPermitted ?? "unknown",
    provisioningPermitted:
      contract.activation?.provisioningPermitted ?? "unknown",
    pendingOwnerCount,
    pendingObjectiveCount,
  },
  checks,
};

writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
  encoding: "utf8",
  mode: 0o600,
});

if (!passed) {
  const failures = checks
    .filter((item) => item.status === "fail")
    .map((item) => item.id)
    .join(", ");
  console.error(`Well-Architected contract audit failed: ${failures}`);
  process.exitCode = 1;
} else {
  console.log(
    `Well-Architected contract audit passed in ${mode} mode (${checks.length} checks).`,
  );
}
