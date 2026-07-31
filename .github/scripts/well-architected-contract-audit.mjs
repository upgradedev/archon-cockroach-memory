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

const approvalGates = contract.approvalGates ?? [];
check(
  "approval-gates",
  sameStrings(
    approvalGates.map((gate) => gate.id).sort(),
    [
      "additional-region",
      "billable-or-account-wide-control-activation",
      "live-read-only-audit",
    ],
  ) &&
    approvalGates.every(
      (gate) =>
        gate.required === true &&
        gate.mutationAllowed === false &&
        Array.isArray(gate.conditions) &&
        gate.conditions.length > 0,
    ),
  "Live audit, billable/account-wide activation, and additional-region decisions have explicit non-mutating gates.",
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
