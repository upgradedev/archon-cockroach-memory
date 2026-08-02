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

function readRepositorySource(path) {
  try {
    return readFileSync(resolve(ROOT, path), "utf8");
  } catch {
    return "";
  }
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
const edgeProtectionSemanticsValid =
  /^\s{2}workflow_dispatch:/mu.test(edgeControlWorkflowSource) &&
  /-\s+plan[\s\S]*?-\s+apply[\s\S]*?-\s+verify/u.test(
    edgeControlWorkflowSource,
  ) &&
  /environment:\s*edge-controls/u.test(edgeControlWorkflowSource) &&
  /AWS_REGION:\s*us-east-1/u.test(edgeControlWorkflowSource) &&
  /REVIEW_IN_PROGRESS\)[\s\S]*?test "\$OPERATION" = "apply"[\s\S]*?\.ChangeSetType == "CREATE"/u.test(
    edgeControlWorkflowSource,
  ) &&
  /sha256sum "\$pending_template"[\s\S]*?EDGE_TEMPLATE_DIGEST/u.test(
    edgeControlWorkflowSource,
  ) &&
  /AWS::WAFv2::LoggingConfiguration/u.test(edgeControlTemplateSource) &&
  /DefaultBehavior:\s*DROP[\s\S]*?Action:\s*BLOCK/u.test(
    edgeControlTemplateSource,
  ) &&
  /RedactedFields:/u.test(edgeControlTemplateSource) &&
  !/SampledRequestsEnabled:\s*true/u.test(edgeControlTemplateSource) &&
  /Type:\s*AWS::SNS::Topic/u.test(edgeControlTemplateSource) &&
  /Type:\s*AWS::SQS::Queue/u.test(edgeControlTemplateSource) &&
  /MessageRetentionPeriod:\s*1209600/u.test(edgeControlTemplateSource) &&
  /humanPagingDestination:\s*"not-configured-by-this-stack"/u.test(
    edgeControlWorkflowSource,
  ) &&
  /WAF evidence is BLOCK-only, redacted, encrypted, durable, and alarmed/u.test(
    edgeControlTestSource,
  ) &&
  !/us-west-2/u.test(edgeControlTemplateSource);
check(
  "wa04-edge-protection-control-plane-source",
  edgeProtectionFilesValid &&
    edgeProtectionSemanticsValid &&
    wa04?.state === "repository-prepared-activation-required" &&
    wa04?.requiresExternalApproval === true &&
    wa04?.activatedByThisContract === false &&
    wa04?.evidenceWorkflow === ".github/workflows/edge-controls.yml" &&
    wa04?.controlPlaneTemplate === "aws/edge-waf.yaml" &&
    wa04?.stackPolicy === "aws/edge-stack-policy.json" &&
    wa04?.runbook === "docs/runbooks/waf-abuse-response.md" &&
    wa04?.protectedEnvironment === "edge-controls" &&
    wa04?.operations === "plan|apply|verify" &&
    wa04?.controlPlaneRegion === "us-east-1" &&
    wa04?.applicationWorkloadRegion === false,
  "WA-04 binds protected plan/apply/verify edge controls, BLOCK-only redacted encrypted WAF evidence, durable encrypted alarm evidence, and an honest no-human-paging boundary.",
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
