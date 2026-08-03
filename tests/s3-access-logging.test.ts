import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parse as parseYaml } from "yaml";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BOOTSTRAP = readFileSync(
  join(ROOT, "aws", "bootstrap-oidc.yaml"),
  "utf8"
);
const WORKFLOW = readFileSync(
  join(ROOT, ".github", "workflows", "bootstrap-aws.yml"),
  "utf8"
);
const FOUNDATION_MIGRATION_WORKFLOW = readFileSync(
  join(ROOT, ".github", "workflows", "foundation-migration.yml"),
  "utf8"
);
const FOUNDATION_MIGRATION_AUTHORITY_SCRIPT = join(
  ROOT,
  "aws",
  "foundation-migration-authority.sh"
);
const FOUNDATION_MIGRATION_AUTHORITY_SOURCE = readFileSync(
  FOUNDATION_MIGRATION_AUTHORITY_SCRIPT,
  "utf8"
);
const DEPLOY_WORKFLOW = readFileSync(
  join(ROOT, ".github", "workflows", "deploy-aws.yml"),
  "utf8"
);
const EDGE_CONTROLS_WORKFLOW = readFileSync(
  join(ROOT, ".github", "workflows", "edge-controls.yml"),
  "utf8"
);
const RECOVERY_WORKFLOW = readFileSync(
  join(ROOT, ".github", "workflows", "recover-aws.yml"),
  "utf8"
);
const CI_WORKFLOW = readFileSync(
  join(ROOT, ".github", "workflows", "ci.yml"),
  "utf8"
);
const CONTROL_PLANE_FENCE_SCRIPT = join(
  ROOT,
  ".github",
  "scripts",
  "revalidate-aws-control-plane-fence.sh"
);
const CONTROL_PLANE_FENCE_SOURCE = readFileSync(
  CONTROL_PLANE_FENCE_SCRIPT,
  "utf8"
);
const PROOF_SCRIPT = join(ROOT, "aws", "prove-s3-access-logging.sh");
const PROOF_SOURCE = readFileSync(PROOF_SCRIPT, "utf8");
const APPLICATION_PROOF_SCRIPT = join(
  ROOT,
  "aws",
  "prove-application-s3-access-logging.sh"
);
const APPLICATION_PROOF_SOURCE = readFileSync(
  APPLICATION_PROOF_SCRIPT,
  "utf8"
);
const FOUNDATION_STORAGE_PROOF_SOURCE = readFileSync(
  join(ROOT, "aws", "prove-foundation-storage-controls.sh"),
  "utf8"
);
const RECOVERY_SNAPSHOT_SOURCE = readFileSync(
  join(ROOT, "aws", "prove-recovery-snapshot.sh"),
  "utf8"
);
const STACK_RESTORE_SOURCE = readFileSync(
  join(ROOT, "aws", "restore-cloudformation-stack.sh"),
  "utf8"
);
const GREENFIELD_CLEANUP_SOURCE = readFileSync(
  join(ROOT, "aws", "delete-greenfield-stack.sh"),
  "utf8"
);
const STACK_POLICY = JSON.parse(
  readFileSync(join(ROOT, "aws", "bootstrap-stack-policy.json"), "utf8")
);

const APP = "archon-memory";
const ACCOUNT = "123456789012";
const REGION = "eu-west-1";
const ARCHIVE = `${APP}-s3-access-logs-${ACCOUNT}-${REGION}`;
const ARTIFACT = `${APP}-artifacts-${ACCOUNT}-${REGION}`;
const RULE_ARN =
  `arn:aws:securityhub:${REGION}:${ACCOUNT}:automation-rule/` +
  "11111111-2222-3333-4444-555555555555";

function resourceBlock(logicalId: string): string {
  const match = BOOTSTRAP.match(
    new RegExp(
      `(?:^|\\n)  ${logicalId}:\\r?\\n[\\s\\S]*?(?=\\r?\\n  [A-Za-z0-9]+:\\r?\\n|\\r?\\nOutputs:)`,
      "u"
    )
  );
  assert.ok(match, `missing ${logicalId}`);
  return match[0];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function workflowStep(source: string, name: string): string {
  return (
    source.match(
      new RegExp(
        `(?:^|\\r?\\n)      - name: ${escapeRegExp(name)}\\r?\\n[\\s\\S]*?(?=\\r?\\n      - name: |$)`,
        "u"
      )
    )?.[0] ?? ""
  );
}

function workflowJob(source: string, id: string): string {
  return (
    source.match(
      new RegExp(
        `(?:^|\\r?\\n)  ${escapeRegExp(id)}:\\r?\\n[\\s\\S]*?(?=\\r?\\n  [A-Za-z0-9_-]+:\\r?\\n|$)`,
        "u"
      )
    )?.[0] ?? ""
  );
}

test("AWS control-plane mutation jobs share one queued mutex", () => {
  const mutationJobs: Array<[string, string]> = [
    [WORKFLOW, "foundation"],
    [FOUNDATION_MIGRATION_WORKFLOW, "migrate"],
    [FOUNDATION_MIGRATION_WORKFLOW, "abort-authority"],
    [FOUNDATION_MIGRATION_WORKFLOW, "retire-authority"],
    [EDGE_CONTROLS_WORKFLOW, "edge"],
    [DEPLOY_WORKFLOW, "deploy-staging"],
    [DEPLOY_WORKFLOW, "deploy-production"],
    [RECOVERY_WORKFLOW, "recover-staging"],
    [RECOVERY_WORKFLOW, "recover-production"],
  ];
  const mutex =
    /    concurrency:\r?\n      group: aws-shared-control-plane-mutation\r?\n      cancel-in-progress: false\r?\n      queue: max/u;

  for (const [source, jobId] of mutationJobs) {
    const job = workflowJob(source, jobId);
    assert.ok(job.length > 0, jobId);
    assert.match(job, mutex, jobId);
  }
  assert.doesNotMatch(
    workflowJob(DEPLOY_WORKFLOW, "source-gate"),
    /aws-shared-control-plane-mutation/u
  );
});

test("S3 logging IaC retains and hardens the non-recursive archive", () => {
  assert.match(
    BOOTSTRAP,
    /ArtifactAccessLoggingEnabled:\r?\n\s+Type: String\r?\n\s+Default: "false"\r?\n\s+AllowedValues:\r?\n\s+- "true"\r?\n\s+- "false"/u
  );
  assert.match(
    BOOTSTRAP,
    /EnableArtifactAccessLogging: !Equals \[!Ref ArtifactAccessLoggingEnabled, "true"\]/u
  );

  const rule = resourceBlock("S3AccessLogArchiveS39Suppression");
  for (const expected of [
    "DeletionPolicy: RetainExceptOnCreate",
    "UpdateReplacePolicy: Retain",
    "RuleOrder: 1",
    "RuleStatus: ENABLED",
    "IsTerminal: true",
    "ComplianceSecurityControlId:",
    "Value: S3.9",
    "ComplianceStatus:",
    "Value: FAILED",
    "RecordState:",
    "Value: ACTIVE",
    "ResourceType:",
    "Value: AwsS3Bucket",
    "Status: SUPPRESSED",
  ]) {
    assert.ok(rule.includes(expected), expected);
  }
  assert.match(
    rule,
    /ResourceId:[\s\S]*?arn:\$\{AWS::Partition\}:s3:::\$\{AppName\}-s3-access-logs-\$\{AWS::AccountId\}-\$\{AWS::Region\}/u
  );
  assert.doesNotMatch(rule, /Title:/u);

  const archive = resourceBlock("S3AccessLogArchive");
  for (const expected of [
    "DependsOn: S3AccessLogArchiveS39Suppression",
    "DeletionPolicy: RetainExceptOnCreate",
    "UpdateReplacePolicy: Retain",
    'SSEAlgorithm: AES256',
    "ObjectOwnership: BucketOwnerEnforced",
    "BlockPublicAcls: true",
    "BlockPublicPolicy: true",
    "IgnorePublicAcls: true",
    "RestrictPublicBuckets: true",
    "Status: Enabled",
    "Id: RetireServerAccessLogs",
    "ExpirationInDays: 365",
    "NoncurrentDays: 30",
    "DaysAfterInitiation: 7",
  ]) {
    assert.ok(archive.includes(expected), expected);
  }
  assert.doesNotMatch(archive, /NewerNoncurrentVersions:/u);
  assert.doesNotMatch(archive, /LoggingConfiguration:/u);
  assert.doesNotMatch(archive, /aws:kms|ObjectLock|AccessControl|TargetGrants/u);

  const cloudFrontAccessLogs = resourceBlock("CloudFrontAccessLogBucket");
  assert.match(
    cloudFrontAccessLogs,
    /OwnershipControls:[\s\S]*?ObjectOwnership: BucketOwnerPreferred/u,
  );
  assert.match(
    cloudFrontAccessLogs,
    /BucketEncryption:[\s\S]*?SSEAlgorithm: AES256/u,
  );
  assert.doesNotMatch(
    cloudFrontAccessLogs,
    /KMSMasterKeyID|BucketKeyEnabled:\s*true/u,
  );
  assert.doesNotMatch(cloudFrontAccessLogs, /\n\s+AccessControl:/u);
  assert.doesNotMatch(
    BOOTSTRAP,
    /CloudFrontAccessLogKey(?:Alias|Arn|AliasArn)?:/u,
  );
  for (const expected of [
    'has("CloudFrontAccessLogKeyArn") | not',
    'has("CloudFrontAccessLogKeyAliasArn") | not',
    '== "AES256"',
    'schemaVersion: 2',
    'cloudFrontAccessLogEncryption:',
    'serviceManaged: true',
    'customerManagedKey: false',
    'lifecycleFixedMonthlyUsd: 0',
    'manage-exact-cloudfront-waf-stacks',
    'leastPrivilegePolicyVerified: true',
    'alarmArchive: "EventBridge-to-CloudWatch-Logs"',
    '"PlanAndApplyExactEdgeStacks"',
    '"CheckCloudFrontWebAclCapacity"',
  ]) {
    assert.ok(FOUNDATION_STORAGE_PROOF_SOURCE.includes(expected), expected);
  }
  assert.doesNotMatch(
    FOUNDATION_STORAGE_PROOF_SOURCE,
    /cloudFrontAccessLogKey:|cloudfront-logs/u,
  );
});

test("candidate and recovery objects have a bounded evidence lifecycle", () => {
  const artifactBucket = resourceBlock("ArtifactBucket");
  assert.match(
    artifactBucket,
    /Id: RetireCandidateAndRecoveryEvidence[\s\S]*?Prefix: candidates\/[\s\S]*?ExpirationInDays: 2555[\s\S]*?NoncurrentDays: 30[\s\S]*?NewerNoncurrentVersions: 5[\s\S]*?DaysAfterInitiation: 7/u
  );
});

test("foundation updates preserve the exact legacy and alarm-routing parameter contracts", () => {
  for (const workflow of [WORKFLOW, FOUNDATION_MIGRATION_WORKFLOW]) {
    assert.match(
      workflow,
      /\(\[\.Stacks\[0\]\.Parameters\[\]\.ParameterKey\] \| sort\) as \$keys[\s\S]*?\$keys == \[\s+"AppName",[\s\S]*?"GitHubRepositoryOwnerId"\s+\]\s+or \$keys == \[\s+"AlarmRoutingEnabled",[\s\S]*?"GitHubRepositoryOwnerId"\s+\]/u
    );
    assert.match(
      workflow,
      /\+ if \$keys \| index\("AlarmRoutingEnabled"\)[\s\S]*?then \[\][\s\S]*?ParameterKey: "AlarmRoutingEnabled",\s+ParameterValue: "false"/u
    );
    assert.match(
      workflow,
      /\.AlarmRoutingEnabled = \(\s+\.AlarmRoutingEnabled \/\/ "false"\s+\)/u
    );
    assert.equal(
      (workflow.match(/ParameterKey: "AlarmRoutingEnabled"/gu) ?? []).length,
      1
    );
  }
  assert.match(WORKFLOW, /and \$after == \$expected/u);
  assert.match(
    FOUNDATION_MIGRATION_WORKFLOW,
    /and \(\.Parameters \| parameter_map\) == \$expectedParameters/u
  );
});

test("foundation migration receipts hash account-bearing evidence locators", () => {
  assert.match(FOUNDATION_MIGRATION_WORKFLOW, /generatedAt:\s*\$generatedAt/u);
  assert.match(
    FOUNDATION_MIGRATION_WORKFLOW,
    /terminalStackStatus:\s*\$storage\[0\]\.stack\.status/u
  );
  assert.doesNotMatch(
    FOUNDATION_MIGRATION_WORKFLOW,
    /terminalStackStatus:\s*"UPDATE_COMPLETE"/u
  );
  assert.equal(
    (
      FOUNDATION_MIGRATION_WORKFLOW.match(
        /versionIdSha256:\s*\$[A-Za-z]+/gmu
      ) ?? []
    ).length,
    3
  );
  assert.doesNotMatch(
    FOUNDATION_MIGRATION_WORKFLOW,
    /(?:recoveryAnchor|templateObject):\s*\{[\s\S]*?\n\s+versionId:/u
  );
  for (const expected of [
    "nameSha256: $stackSha256",
    "bucketSha256: $archiveSha256",
    "bucketSha256: $artifactSha256",
    "targetBucketSha256:",
    "ruleArnSha256: $ruleArnSha256",
  ]) {
    assert.ok(PROOF_SOURCE.includes(expected), expected);
  }
  assert.doesNotMatch(
    PROOF_SOURCE,
    /\n\s+(?:name|bucket|targetBucket|ruleArn):\s*\$/u
  );
});

test("foundation migration cleanup and abort preserve authority for separate retirement", () => {
  const sameRunCleanup = workflowStep(
    FOUNDATION_MIGRATION_WORKFLOW,
    "Delete an unverified foundation migration plan"
  );
  const abortJob = workflowJob(
    FOUNDATION_MIGRATION_WORKFLOW,
    "abort-authority"
  );
  const abort = workflowStep(
    abortJob,
    "Prove stable foundation and clean only authorized unexecuted plans"
  );
  const abortFinalizer = workflowStep(
    abortJob,
    "Finalize any untrapped abort failure receipt"
  );
  assert.ok(sameRunCleanup.length > 0);
  assert.ok(abortJob.length > 0);
  assert.ok(abort.length > 0);
  assert.ok(abortFinalizer.length > 0);

  assert.match(sameRunCleanup, /always\(\)/u);
  assert.match(sameRunCleanup, /steps\.create_plan\.outcome == 'failure'/u);
  assert.match(sameRunCleanup, /steps\.load_plan\.outcome == 'failure'/u);
  assert.match(sameRunCleanup, /steps\.exact_plan\.outcome == 'failure'/u);
  assert.match(sameRunCleanup, /\.ExecutionStatus == "AVAILABLE"/u);
  assert.match(sameRunCleanup, /aws cloudformation delete-change-set/u);
  assert.match(sameRunCleanup, /changeSetArnSha256: \$arnSha256/u);
  assert.match(sameRunCleanup, /changeSetNameSha256: \$nameSha256/u);
  assert.match(sameRunCleanup, /descriptionSha256: \$descriptionSha256/u);
  assert.doesNotMatch(sameRunCleanup, /execute-change-set/u);

  assert.match(
    FOUNDATION_MIGRATION_AUTHORITY_SOURCE,
    /Sid: "ManageExactFoundationStack"[\s\S]*?"cloudformation:ListChangeSets"[\s\S]*?"cloudformation:ListStackResources"/u
  );
  assert.match(
    FOUNDATION_MIGRATION_AUTHORITY_SOURCE,
    /Sid: "InspectAuthorityStack"[\s\S]*?"cloudformation:DescribeStackEvents"[\s\S]*?"cloudformation:DescribeStacks"[\s\S]*?"cloudformation:GetTemplate"[\s\S]*?"cloudformation:ListStackResources"/u
  );
  const renderedAuthority = renderAuthorityJson("render-policy") as {
    Statement: Array<{
      Sid: string;
      Action: string | string[];
      Resource: string | string[];
    }>;
  };
  const renderedAuthorityPolicy = JSON.stringify(renderedAuthority);
  assert.ok(
    Buffer.byteLength(JSON.stringify(renderedAuthority), "utf8") <= 10_240,
    "FoundationMigrationRole aggregate inline policy exceeds 10,240 characters"
  );
  assert.doesNotMatch(
    renderedAuthorityPolicy,
    /cloudformation:DeleteStack|iam:PassRole/u
  );
  const newRoleAuthority = renderedAuthority.Statement.find(
    ({ Sid }) => Sid === "ManageExactNewFoundationRolesViaCloudFormation"
  );
  const existingRoleAuthority = renderedAuthority.Statement.find(
    ({ Sid }) => Sid === "ModifyExactExistingFoundationRolesViaCloudFormation"
  );
  const ownAuthorityInspection = renderedAuthority.Statement.find(
    ({ Sid }) => Sid === "InspectOwnAuthorityContract"
  );
  const authorityStackInspection = renderedAuthority.Statement.find(
    ({ Sid }) => Sid === "InspectAuthorityStack"
  );
  assert.ok(newRoleAuthority);
  assert.ok(existingRoleAuthority);
  assert.ok(ownAuthorityInspection);
  assert.ok(authorityStackInspection);
  const actionList = (statement: { Action: string | string[] }) =>
    Array.isArray(statement.Action) ? statement.Action : [statement.Action];
  const resourceList = (statement: { Resource: string | string[] }) =>
    Array.isArray(statement.Resource)
      ? statement.Resource
      : [statement.Resource];
  assert.ok(actionList(newRoleAuthority).includes("iam:CreateRole"));
  assert.ok(actionList(newRoleAuthority).includes("iam:DeleteRole"));
  assert.ok(
    resourceList(newRoleAuthority).some((resource) =>
      resource.endsWith("-foundation-authority-retirement-execution")
    )
  );
  assert.ok(
    resourceList(newRoleAuthority).every(
      (resource) => !resource.endsWith("-github-foundation-migration")
    )
  );
  assert.ok(!actionList(existingRoleAuthority).includes("iam:CreateRole"));
  assert.ok(!actionList(existingRoleAuthority).includes("iam:DeleteRole"));
  assert.ok(
    resourceList(existingRoleAuthority).some((resource) =>
      resource.endsWith("-github-foundation-promotion")
    )
  );
  assert.deepEqual([...actionList(ownAuthorityInspection)].sort(), [
    "iam:GetRole",
    "iam:GetRolePolicy",
    "iam:ListAttachedRolePolicies",
    "iam:ListInstanceProfilesForRole",
    "iam:ListRolePolicies",
  ]);
  assert.deepEqual([...actionList(authorityStackInspection)].sort(), [
    "cloudformation:DescribeStackEvents",
    "cloudformation:DescribeStacks",
    "cloudformation:GetTemplate",
    "cloudformation:ListStackResources",
  ]);
  assert.match(abortJob, /needs: authorize/u);
  assert.match(abortJob, /Configure exact one-time migration authority/u);
  assert.doesNotMatch(abortJob, /Configure permanent narrow foundation authority/u);
  assert.match(abort, /foundation-migration-authority\.sh verify-intrinsic/u);
  for (const field of [
    "recordedAuthorityTemplateSha256",
    "canonicalAuthorityTemplateSha256",
    "templateCanonicalization",
    "recordedTemplateTerminator",
  ]) {
    assert.ok(abort.includes(field), field);
  }
  assert.match(
    abort,
    /recordedTemplateTerminator \| IN\("none", "lf", "crlf"\)/u
  );
  assert.match(abort, /sourceFetchedAsData: true/u);
  assert.match(abort, /sourceExecuted: false/u);
  assert.match(abort, /liveTemplateDigestBound: true/u);
  assert.match(abort, /terminalLifecycleSafetyContractVersion: 2/u);
  assert.doesNotMatch(abort, /matchesRecordedAndLiveTemplate/u);
  assert.match(abort, /destructive_actions_started=false/u);
  assert.match(abort, /destructiveActionsStarted: \$destructiveActionsStarted/u);
  assert.match(abort, /partialChangeSetCleanup:/u);
  assert.match(abort, /attemptedCount: \(\$plans\[0\] \| length\)/u);
  assert.match(
    abort,
    /deletedCount: \(\s*\[\$plans\[0\]\[\] \| select\(\.deleted == true\)\] \| length\s*\)/u
  );
  assert.match(abort, /deletedCount: \$planCount/u);
  assert.match(
    abort,
    /all\(\s*\(\.Summaries \/\/ \[\]\)\[\];\s*\(\.ChangeSetName \| startswith\("foundation-storage-"\)\)\s*and \.Status == "CREATE_COMPLETE"\s*and \(\.ExecutionStatus \| IN\("AVAILABLE", "OBSOLETE"\)\)\s*and \(\(\.ImportExistingResources \/\/ false\) == false\)/u
  );
  assert.match(
    abort,
    /contents\/aws\/bootstrap-oidc\.yaml\?ref=\$\{plan_source\}/u
  );
  assert.match(abort, /aws cloudformation delete-change-set/u);
  assert.doesNotMatch(abort, /aws cloudformation delete-stack/u);
  for (const digest of [
    "target_projection_sha256",
    "target_policy_sha256",
    "target_resources_sha256",
  ]) {
    assert.ok(abort.includes(`)" = "$${digest}"`), digest);
  }
  assert.match(abort, /\)" = \\\r?\n\s+"\$target_template_sha256"/u);
  const digestGate = abort.indexOf("phase=authority-proof-contract");
  assert.ok(digestGate >= 0);
  assert.ok(digestGate < abort.indexOf("aws cloudformation delete-change-set"));
  assert.doesNotMatch(
    abort,
    /cloudformation (?:create|execute)-change-set|cloudformation set-stack-policy|cloudformation update-stack/u
  );
  for (const expected of [
    "record_failure()",
    "trap record_failure EXIT",
    "receiptRecoveryFallback: true",
    'plan_queue="${RUNNER_TEMP:?}/foundation-abort-plan-queue.jsonl"',
    "' \"$plans\" >\"$plan_queue\"",
    "while IFS= read -r encoded; do",
    'done <"$plan_queue"',
    "for ((attempt = 1; attempt <= 30; attempt++)); do",
    "deletionRequestStarted: true",
    "deleted: false",
    "absenceVerified: false",
    'error("missing in-flight plan journal")',
    ".[-1].deleted = true",
    ".[-1].absenceVerified = true",
  ]) {
    assert.ok(abort.includes(expected), expected);
  }
  assert.doesNotMatch(abort, /done < <\(/u);
  const journalStarted = abort.indexOf("deletionRequestStarted: true");
  const planDelete = abort.indexOf("aws cloudformation delete-change-set");
  const journalCompleted = abort.indexOf(".[-1].deleted = true");
  assert.ok(journalStarted >= 0 && journalStarted < planDelete);
  assert.ok(planDelete < journalCompleted);
  const receiptOffset = abort.lastIndexOf("          phase=receipt");
  assert.ok(receiptOffset >= 0);
  const receipt = abort.slice(receiptOffset);
  for (const expected of [
    "stackProjectionSha256: $targetProjectionSha256",
    "remainingCount: 0",
    'result: "migration-aborted-authority-retirement-required"',
    "changeSetCleanupOnly: true",
    "authorityMutationAttempted: false",
    "unchangedDuringAbort: true",
    "stackRetained: true",
    "roleRetained: true",
    "stackDeleted: false",
    "roleDeleted: false",
    "authorityRetired: false",
    "terminalRetirementEvidence: false",
    "externalRetirementRequired: true",
    "externalAdministratorRetirementRequired: null",
    "externalAdministratorRequirementKnown: false",
    "nonSelfDeletingExecutorAvailableBeforeApply: null",
    "permanentRetirementControllerAvailabilityKnown: false",
  ]) {
    assert.ok(receipt.includes(expected), expected);
  }
  assert.doesNotMatch(receipt, /AWS_ACCOUNT_ID|arn:aws:/u);
  assert.match(abortFinalizer, /if: always\(\)/u);
  assert.match(abortFinalizer, /\.result == "abort-pending"/u);
  assert.match(abortFinalizer, /result: "abort-failed"/u);
  assert.match(abortFinalizer, /destructiveActionsStarted: null/u);
  assert.match(abortFinalizer, /destructiveStateKnown: false/u);
  assert.match(
    abortFinalizer,
    /failure: \{phase: "pre-main-or-untrapped-failure"\}/u
  );
  assert.match(abortFinalizer, /pendingReceiptFinalized: true/u);
});

test("foundation destructive transitions use adjacent fresh fail-closed proofs", () => {
  const apply = workflowStep(
    FOUNDATION_MIGRATION_WORKFLOW,
    "Execute under rollback-safe policy and protect success immediately"
  );
  const finalizePolicy = workflowStep(
    FOUNDATION_MIGRATION_WORKFLOW,
    "Reconcile candidate and rollback-safe stack-policy state"
  );
  const cleanup = workflowStep(
    FOUNDATION_MIGRATION_WORKFLOW,
    "Delete an unverified foundation migration plan"
  );
  const abort = workflowStep(
    workflowJob(FOUNDATION_MIGRATION_WORKFLOW, "abort-authority"),
    "Prove stable foundation and clean only authorized unexecuted plans"
  );
  const retireJob = workflowJob(
    FOUNDATION_MIGRATION_WORKFLOW,
    "retire-authority"
  );
  const retire = workflowStep(
    retireJob,
    "Verify and retire the exact authority stack"
  );
  const retireFinalizer = workflowStep(
    retireJob,
    "Finalize any untrapped retirement failure receipt"
  );

  assert.ok(apply.length > 0);
  assert.ok(finalizePolicy.length > 0);
  assert.match(
    apply,
    /cloudformation get-stack-policy[\s\S]*?--slurpfile expected "\$CURRENT_STACK_POLICY_BODY_FILE"[\s\S]*?bootstrap-stack-policy\.pre-storage-migration\.json[\s\S]*?aws cloudformation execute-change-set[\s\S]*?UPDATE_COMPLETE[\s\S]*?cloudformation set-stack-policy[\s\S]*?file:\/\/aws\/bootstrap-stack-policy\.json/u
  );
  assert.match(
    finalizePolicy,
    /if: always\(\) && inputs\.operation == 'apply'[\s\S]*?for \(\(attempt = 1; attempt <= 120; attempt\+\+\)\)[\s\S]*?UPDATE_COMPLETE\|UPDATE_ROLLBACK_COMPLETE[\s\S]*?CANDIDATE_TEMPLATE_DIGEST[\s\S]*?policy_source=aws\/bootstrap-stack-policy\.pre-storage-migration\.json[\s\S]*?policy_source=aws\/bootstrap-stack-policy\.json[\s\S]*?aws cloudformation set-stack-policy[\s\S]*?\(\.StackPolicyBody \| fromjson\) == \$expected\[0\][\s\S]*?test "\$candidate_present" = "true"/u
  );
  assert.ok(
    FOUNDATION_MIGRATION_WORKFLOW.indexOf(
      "Execute under rollback-safe policy and protect success immediately"
    ) <
      FOUNDATION_MIGRATION_WORKFLOW.indexOf(
        "Reconcile candidate and rollback-safe stack-policy state"
      )
  );

  for (const step of [cleanup, abort]) {
    assert.match(
      step,
      /describe-change-set[\s\S]*?\.Status == "CREATE_COMPLETE"[\s\S]*?\.ExecutionStatus[\s\S]*?cloudformation delete-change-set/u
    );
  }
  assert.match(
    cleanup,
    /env\.CHANGE_SET_ID != '' \|\|[\s\S]*?steps\.create_plan\.outcome == 'failure'/u
  );
  for (const expected of [
    'cleanup_change_set_id="${CHANGE_SET_ID:-}"',
    '--change-set-name "$CHANGE_SET_NAME"',
    '($plans | length) == 1',
    'recoveredByDeterministicName:',
  ]) {
    assert.ok(cleanup.includes(expected), expected);
  }
  assert.match(
    abort,
    /phase=historical-source-fetch[\s\S]*?foundation-migration-authority\.sh\?ref=\$\{authority_source\}[\s\S]*?test -s "\$historical_authority_source"[\s\S]*?test ! -L "\$historical_authority_source"[\s\S]*?historical_authority_source_sha256[\s\S]*?\^\[0-9a-f\]\{64\}\$/u
  );
  assert.doesNotMatch(
    abort,
    /env -i|historical-template-render|(?:bash|source) "\$historical_authority_source"/u
  );
  assert.match(
    abort,
    /historicalAuthoritySource: \{[\s\S]*?sourceFileSha256: \$historicalAuthoritySourceSha256[\s\S]*?ancestorOfTarget: true[\s\S]*?sourceFetchedAsData: true[\s\S]*?sourceExecuted: false[\s\S]*?liveTemplateDigestBound: true[\s\S]*?terminalLifecycleSafetyContractVersion: 2/u
  );
  assert.ok(
    (abort.match(/\(\.Summaries \/\/ \[\]\) \| length == 0/gu) ?? [])
      .length >= 2
  );
  assert.equal(
    (abort.match(/aws cloudformation delete-stack/gu) ?? []).length,
    0
  );

  for (const expected of [
    "prove-foundation-storage-controls.sh",
    "detect-stack-resource-drift",
    'target_stack_id="$(jq -er',
    "--logical-resource-id FoundationPromotionRole",
    'StackResourceDriftStatus == "IN_SYNC"',
    '(.Summaries // []) | length == 0',
    "fresh_retirement_proof_sha256",
    "freshRetirementProofBound: true",
    "finalAuthorityProofSha256",
    "finalAuthorityProofBoundImmediatelyBeforeDeletion: true",
    "destructive_actions_started=false",
    "destructive_actions_started=true",
    "--stack-name \"$authority_stack_id\"",
    "--role-arn \"$execution_role_arn\"",
    "for ((attempt = 1; attempt <= 90; attempt++)); do",
    "for ((attempt = 1; attempt <= 30; attempt++)); do",
    "phase=controller-executor-persistence",
    '"$permanent_role_after"',
    '"$permanent_role_policy_after"',
    '"$execution_role_after"',
    '"$execution_role_policy_after"',
    "clientRequestTokenSha256: $clientTokenSha256",
    "controllerRoleArnSha256: $controllerRoleArnSha256",
    "cloudFormationExecutionRoleArnSha256:",
    "$executionRoleArnSha256",
    "authorityRoleArnSha256: $authorityRoleArnSha256",
    "cloudFormationServiceRoleBound: true",
    "controllerExecutionRoleSeparated: true",
    "nonSelfDeletingExecutor: true",
    "selfDeletion: false",
    "controllerPersistedAfterDeletion: true",
    "executionRolePersistedAfterDeletion: true",
    "bash aws/prove-foundation-storage-controls.sh retired",
    ".migrationAuthority.retired == true",
    "post_retirement_controls_sha256",
    "postRetirementControlsSha256:",
    "$postRetirementControlsSha256",
    "postRetirementControlsBound: true",
  ]) {
    assert.ok(retire.includes(expected), expected);
  }
  assert.ok(
    retire.indexOf('target_stack_id="$(jq -er') <
      retire.indexOf("--logical-resource-id FoundationPromotionRole"),
    "the permanent-role drift proof must not read target_stack_id before assignment"
  );
  assert.match(
    retireJob,
    /Configure permanent non-self-deleting retirement authority[\s\S]*?role-to-assume: arn:aws:iam::\$\{\{ env\.AWS_ACCOUNT_ID \}\}:role\/\$\{\{ env\.APP_NAME \}\}-github-foundation-promotion/u
  );
  assert.doesNotMatch(
    retireJob,
    /Configure exact one-time migration authority|role-to-assume: \$\{\{ env\.AWS_FOUNDATION_MIGRATION_ROLE_ARN \}\}/u
  );
  assert.match(
    retire,
    /authority_stack_id="\$\(\s*jq -ejr '\.Stacks\[0\]\.StackId' "\$authority_stack"\s*\)"/u
  );
  assert.match(
    retire,
    /destructive_actions_started=true[\s\S]*?aws cloudformation delete-stack \\\r?\n\s+--stack-name "\$authority_stack_id" \\\r?\n\s+--role-arn "\$execution_role_arn"/u
  );
  assert.doesNotMatch(retire, /--force-delete|FORCE_DELETE_STACK/u);
  assert.doesNotMatch(
    retire,
    /env -i|historical-template-render|(?:bash|source) "\$historical_authority_source"/u
  );
  for (const strategy of [
    "unclassified",
    "already-absent",
    "standard-delete-retry",
    "targeted-retain-orphan-reconciliation",
    "standard-delete",
  ]) {
    assert.ok(
      retire.includes(`retirement_strategy=${strategy}`),
      `retirement strategy ${strategy}`
    );
  }
  assert.match(retire, /failure: \{phase: \$phase, strategy: \$strategy\}/u);

  const alreadyAbsentReceiptStart = retire.indexOf(
    'result: "one-time-authority-already-retired"'
  );
  const alreadyAbsentReceiptEnd = retire.indexOf(
    "            exit 0",
    alreadyAbsentReceiptStart
  );
  assert.ok(alreadyAbsentReceiptStart >= 0);
  assert.ok(alreadyAbsentReceiptEnd > alreadyAbsentReceiptStart);
  const alreadyAbsentReceipt = retire.slice(
    alreadyAbsentReceiptStart,
    alreadyAbsentReceiptEnd
  );
  for (const expected of [
    "stackDeleted: false",
    "roleDeleted: false",
    "stackAbsent: true",
    "roleAbsent: true",
    "stackDeletedByThisRun: false",
    "roleDeletedByThisRun: false",
    "alreadyAbsentAtStart: true",
  ]) {
    assert.ok(alreadyAbsentReceipt.includes(expected), expected);
  }
  assert.equal((retire.match(/--deletion-mode STANDARD/gu) ?? []).length, 2);
  assert.equal((retire.match(/--retain-resources/gu) ?? []).length, 1);
  assert.match(
    retire,
    /verify-retirement-orphaned[\s\S]*?phase=orphaned-authority-final-role-absence[\s\S]*?--retain-resources FoundationMigrationRole/u
  );
  assert.match(
    retire.slice(retire.lastIndexOf("          phase=receipt")),
    /one-time-authority-orphaned-stack-reconciled[\s\S]*?targetedRetainReconciliationPerformed:[\s\S]*?retainedLogicalResourceIds:[\s\S]*?FoundationMigrationRole[\s\S]*?authorityRoleAbsentBeforeRequest:[\s\S]*?authorityRoleAbsentAfter: true[\s\S]*?authorityRoleDeletedByThisRun:[\s\S]*?physicalRoleRetained: false[\s\S]*?stackRecordDeleted: true/u
  );
  const retirementReceipt = retire.slice(
    retire.lastIndexOf("          phase=receipt")
  );
  assert.match(
    retirementReceipt,
    /authorityRoleAbsentBeforeRequest:\s+\$authorityRoleAbsentBeforeRequest[\s\S]*?authorityRoleAbsentAfter: true[\s\S]*?authorityRoleDeletedByThisRun:\s+\(\$orphanedReconciliation \| not\)[\s\S]*?physicalRoleRetained: false[\s\S]*?stackRecordDeleted: true/u
  );
  assert.match(
    retirementReceipt,
    /retiredAuthority: \([\s\S]*?stackDeleted: true[\s\S]*?roleDeleted: \(\$orphanedReconciliation \| not\)[\s\S]*?stackAbsent: true[\s\S]*?roleAbsent: true[\s\S]*?stackDeletedByThisRun: true[\s\S]*?roleDeletedByThisRun:\s+\(\$orphanedReconciliation \| not\)/u
  );
  assert.doesNotMatch(
    retire.slice(retire.lastIndexOf("          phase=receipt")),
    /clientRequestToken:|controllerRoleArn:|cloudFormationExecutionRoleArn:|authorityRoleArn:|AWS_ACCOUNT_ID|arn:aws:/u
  );
  assert.match(retireFinalizer, /if: always\(\)/u);
  assert.match(retireFinalizer, /\.result == "retire-pending"/u);
  assert.match(retireFinalizer, /result: "retire-failed"/u);
  assert.match(retireFinalizer, /destructiveActionsStarted: null/u);
  assert.match(retireFinalizer, /destructiveStateKnown: false/u);
  assert.match(
    retireFinalizer,
    /failure: \{phase: "pre-main-or-untrapped-failure"\}/u
  );
  assert.match(retireFinalizer, /pendingReceiptFinalized: true/u);
  assert.ok(
    retire.indexOf("phase=controller-executor-persistence") <
      retire.indexOf("phase=post-retirement-controls")
  );
  assert.ok(
    retire.indexOf("phase=post-retirement-controls") <
      retire.lastIndexOf("          phase=receipt")
  );
  const finalAuthorityProof = retire.lastIndexOf(
    "bash aws/foundation-migration-authority.sh"
  );
  const authorityDelete = retire.indexOf(
    "aws cloudformation delete-stack",
    finalAuthorityProof
  );
  assert.ok(finalAuthorityProof >= 0);
  assert.ok(authorityDelete > finalAuthorityProof);
  for (const field of [
    "recordedAuthorityTemplateSha256",
    "canonicalAuthorityTemplateSha256",
    "templateCanonicalization",
    "recordedTemplateTerminator",
  ]) {
    assert.ok(
      retire.slice(finalAuthorityProof, authorityDelete).includes(field),
      field
    );
  }
  assert.match(
    retire.slice(finalAuthorityProof, authorityDelete),
    /phase=final-authority-stack-binding[\s\S]*?aws cloudformation describe-stacks[\s\S]*?authority_stack_id="\$\(\s*jq -ejr '\.Stacks\[0\]\.StackId' "\$authority_stack"\s*\)"[\s\S]*?authority_stack_id_sha256/u
  );
  assert.doesNotMatch(
    retire.slice(finalAuthorityProof, authorityDelete),
    /\n\s+git\s|cloudformation (?:create|execute)-change-set|cloudformation set-stack-policy|cloudformation update-stack/u
  );
  assert.match(
    FOUNDATION_MIGRATION_AUTHORITY_SOURCE,
    /cloudformation:DetectStackResourceDrift/u
  );
});

test("foundation retirement service role is permanent and exact", () => {
  const executionRole = resourceBlock(
    "FoundationAuthorityRetirementExecutionRole"
  );
  assert.match(
    executionRole,
    /RoleName: !Sub "\$\{AppName\}-foundation-authority-retirement-execution"/u
  );
  assert.match(
    executionRole,
    /Principal:\s+Service: cloudformation\.amazonaws\.com\s+Action: sts:AssumeRole/u
  );
  assert.match(
    executionRole,
    /PolicyName: retire-one-time-foundation-authority/u
  );
  assert.match(
    executionRole,
    /Sid: DeleteOnlyOneTimeFoundationMigrationRole[\s\S]*?iam:DeleteRole[\s\S]*?iam:DeleteRolePolicy[\s\S]*?iam:GetRole[\s\S]*?iam:GetRolePolicy[\s\S]*?iam:ListAttachedRolePolicies[\s\S]*?iam:ListInstanceProfilesForRole[\s\S]*?iam:ListRolePolicies[\s\S]*?role\/\$\{AppName\}-github-foundation-migration/u
  );
  assert.doesNotMatch(
    executionRole,
    /cloudformation:|iam:CreateRole|iam:PassRole|Resource: "\*"|role\/\*/u
  );
  assert.match(
    executionRole,
    /Key: Lifecycle\s+Value: permanent-authority-retirement-execution/u
  );
});

type AuthorityDigestRepresentation =
  | "none"
  | "lf"
  | "crlf"
  | "space"
  | "cr"
  | "double-lf"
  | "tab"
  | "bom";

interface AuthorityProofFixture {
  mode:
    | "verify"
    | "verify-intrinsic"
    | "verify-retirement-retry"
    | "verify-retirement-orphaned";
  representation?: AuthorityDigestRepresentation;
  recordedDigest?: string;
  mutateTemplate?: boolean;
  extraInlinePolicy?: boolean;
  attachedPolicy?: boolean;
  instanceProfile?: boolean;
  orphanRoleState?:
    | "absent"
    | "present"
    | "access-denied"
    | "absent-then-present"
    | "absent-then-access-denied";
}

interface InlinePolicyDocument {
  Version: string;
  Statement: Array<{
    Sid: string;
    Effect: string;
    Action: string | string[];
    Resource: string | string[];
    Condition?: unknown;
  }>;
}

function renderedFoundationPromotionPolicy(): InlinePolicyDocument {
  const template = parseYaml(BOOTSTRAP) as {
    Resources: Record<
      string,
      {
        Properties?: {
          Policies?: Array<{
            PolicyName: string;
            PolicyDocument: InlinePolicyDocument;
          }>;
        };
      }
    >;
  };
  const policy = template.Resources.FoundationPromotionRole.Properties?.Policies
    ?.find(({ PolicyName }) => PolicyName === "promote-foundation-logging")
    ?.PolicyDocument;
  assert.ok(policy);

  const app = "a".repeat(17);
  const account = "123456789012";
  const region = "eu-west-1";
  const values: Record<string, string> = {
    "AWS::Partition": "aws",
    "AWS::AccountId": account,
    "AWS::Region": region,
    AppName: app,
    "ArtifactBucket.Arn": `arn:aws:s3:::${app}-artifacts-${account}-${region}`,
    "CloudFrontAccessLogBucket.Arn":
      `arn:aws:s3:::${app}-cloudfront-access-logs-${account}-${region}`,
    "S3AccessLogArchive.Arn":
      `arn:aws:s3:::${app}-s3-access-logs-${account}-${region}`,
    "ApplicationStorageKey.Arn":
      `arn:aws:kms:${region}:${account}:key/` +
      "11111111-2222-3333-4444-555555555555",
    "FoundationAuthorityRetirementExecutionRole.Arn":
      `arn:aws:iam::${account}:role/` +
      `${app}-foundation-authority-retirement-execution`,
    "S3AccessLogArchiveS39Suppression.RuleArn":
      `arn:aws:securityhub:${region}:${account}:automation-rule/` +
      "11111111-2222-3333-4444-555555555555",
    StagingOriginVerifySecret:
      `arn:aws:secretsmanager:${region}:${account}:secret:` +
      `${app}/staging/origin-verification-ABCDEF`,
    ProductionOriginVerifySecret:
      `arn:aws:secretsmanager:${region}:${account}:secret:` +
      `${app}/production/origin-verification-ABCDEF`,
  };

  const resolveIntrinsicValues = (value: unknown): unknown => {
    if (typeof value === "string") {
      const exact = values[value];
      if (exact !== undefined) return exact;
      return value.replace(/\$\{([^}]+)\}/gu, (_match, key: string) => {
        const replacement = values[key];
        assert.ok(replacement, `unresolved CloudFormation value ${key}`);
        return replacement;
      });
    }
    if (Array.isArray(value)) return value.map(resolveIntrinsicValues);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          key,
          resolveIntrinsicValues(entry),
        ])
      );
    }
    return value;
  };

  return resolveIntrinsicValues(policy) as InlinePolicyDocument;
}

const AUTHORITY_SOURCE_COMMIT = "a".repeat(40);

function authorityEnvironment() {
  return {
    ...process.env,
    APP_NAME: APP,
    AWS_ACCOUNT_ID: ACCOUNT,
    AWS_REGION: REGION,
    GITHUB_ORGANIZATION: "upgradedev",
    GITHUB_REPOSITORY_ID: "1285750381",
    GITHUB_REPOSITORY_NAME: "archon-cockroach-memory",
    GITHUB_REPOSITORY_OWNER_ID: "25751981",
    GITHUB_OIDC_PROVIDER_ARN:
      `arn:aws:iam::${ACCOUNT}:oidc-provider/` +
      "token.actions.githubusercontent.com",
  };
}

function renderAuthorityJson(
  mode: "render-trust" | "render-policy" | "render-template"
): Record<string, unknown> {
  const result = spawnSync(
    "bash",
    [FOUNDATION_MIGRATION_AUTHORITY_SCRIPT, mode],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: authorityEnvironment(),
    }
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    return `{${Object.keys(source)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(source[key])}`
      )
      .join(",")}}`;
  }
  const primitive = JSON.stringify(value);
  if (primitive === undefined) {
    throw new TypeError("canonical JSON fixture contains an invalid value");
  }
  return primitive;
}

function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function representedAuthorityBytes(
  canonical: string,
  representation: AuthorityDigestRepresentation
): string {
  switch (representation) {
    case "none":
      return canonical;
    case "lf":
      return `${canonical}\n`;
    case "crlf":
      return `${canonical}\r\n`;
    case "space":
      return `${canonical} `;
    case "cr":
      return `${canonical}\r`;
    case "double-lf":
      return `${canonical}\n\n`;
    case "tab":
      return `${canonical}\t`;
    case "bom":
      return `\uFEFF${canonical}`;
  }
}

function runAuthorityProof(fixture: AuthorityProofFixture) {
  const fakeBin = mkdtempSync(
    join(tmpdir(), "archon-foundation-authority-proof-")
  );
  try {
    const trust = renderAuthorityJson("render-trust");
    const policy = renderAuthorityJson("render-policy");
    const expectedTemplate = renderAuthorityJson("render-template");
    const liveTemplate = JSON.parse(
      JSON.stringify(expectedTemplate)
    ) as Record<string, unknown>;
    if (fixture.mutateTemplate) {
      liveTemplate.Description = `${String(liveTemplate.Description)} drift`;
    }
    const liveCanonical = canonicalJson(liveTemplate);
    const representation = fixture.representation ?? "none";
    const recordedDigest =
      fixture.recordedDigest ??
      sha256Utf8(representedAuthorityBytes(liveCanonical, representation));
    const roleName = `${APP}-github-foundation-migration`;
    const roleArn = `arn:aws:iam::${ACCOUNT}:role/${roleName}`;
    const roleId = "AROA11111111111111111";
    const stackName = `${APP}-foundation-migration-authority`;
    const stackId =
      `arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/${stackName}/` +
      "11111111-2222-3333-4444-555555555555";
    const role = {
      Role: {
        RoleName: roleName,
        RoleId: roleId,
        Arn: roleArn,
        MaxSessionDuration: 3600,
        AssumeRolePolicyDocument: trust,
        Tags: [
          { Key: "Application", Value: APP },
          { Key: "Environment", Value: "bootstrap" },
          { Key: "Lifecycle", Value: "one-time-migration-authority" },
          { Key: "ManagedBy", Value: "CloudFormation" },
          { Key: "SourceCommit", Value: AUTHORITY_SOURCE_COMMIT },
          {
            Key: "AuthorityTemplateSha256",
            Value: recordedDigest,
          },
        ],
      },
    };
    const rolePolicy = {
      RoleName: roleName,
      PolicyName: "protected-foundation-storage-migration",
      PolicyDocument: policy,
    };
    const inlinePolicies = {
      PolicyNames: fixture.extraInlinePolicy
        ? ["protected-foundation-storage-migration", "unexpected-policy"]
        : ["protected-foundation-storage-migration"],
      IsTruncated: false,
    };
    const attachedPolicies = {
      AttachedPolicies: fixture.attachedPolicy
        ? [
            {
              PolicyName: "unexpected-attached-policy",
              PolicyArn:
                `arn:aws:iam::${ACCOUNT}:policy/unexpected-attached-policy`,
            },
          ]
        : [],
      IsTruncated: false,
    };
    const instanceProfiles = {
      InstanceProfiles: fixture.instanceProfile
        ? [
            {
              InstanceProfileName: "unexpected-instance-profile",
              Arn:
                `arn:aws:iam::${ACCOUNT}:instance-profile/` +
                "unexpected-instance-profile",
            },
          ]
        : [],
      IsTruncated: false,
    };
    const stack = {
      Stacks: [
        {
          StackName: stackName,
          StackId: stackId,
          StackStatus:
            fixture.mode === "verify-retirement-retry" ||
            fixture.mode === "verify-retirement-orphaned"
              ? "DELETE_FAILED"
              : "CREATE_COMPLETE",
          ...(fixture.mode === "verify-retirement-retry" ||
            fixture.mode === "verify-retirement-orphaned"
            ? {
                RoleARN:
                  `arn:aws:iam::${ACCOUNT}:role/` +
                  `${APP}-foundation-authority-retirement-execution`,
              }
            : {}),
          EnableTerminationProtection: false,
          NotificationARNs: [],
          Capabilities: ["CAPABILITY_NAMED_IAM"],
          Parameters: [
            {
              ParameterKey: "SourceCommit",
              ParameterValue: AUTHORITY_SOURCE_COMMIT,
            },
            {
              ParameterKey: "AuthorityTemplateSha256",
              ParameterValue: recordedDigest,
            },
          ],
          Tags: [
            { Key: "SourceCommit", Value: AUTHORITY_SOURCE_COMMIT },
            {
              Key: "AuthorityTemplateSha256",
              Value: recordedDigest,
            },
          ],
          Outputs: [
            {
              OutputKey: "FoundationMigrationRoleArn",
              OutputValue: roleArn,
            },
            {
              OutputKey: "FoundationMigrationRoleId",
              OutputValue: roleId,
            },
          ],
        },
      ],
    };
    const resources = {
      StackResourceSummaries: [
        {
          LogicalResourceId: "FoundationMigrationRole",
          PhysicalResourceId: roleName,
          ResourceType: "AWS::IAM::Role",
          ResourceStatus:
            fixture.mode === "verify-retirement-retry" ||
            fixture.mode === "verify-retirement-orphaned"
              ? "DELETE_FAILED"
              : "CREATE_COMPLETE",
        },
      ],
    };
    const traceFile = join(fakeBin, "trace.log");
    const roleStateFile = join(fakeBin, "role-state.count");
    writeFileSync(traceFile, "", "utf8");
    writeFileSync(roleStateFile, "0", "utf8");
    executable(
      join(fakeBin, "aws"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >>"\${FAKE_AUTHORITY_TRACE:?}"
case "$*" in
  *"iam get-role-policy"*) printf '%s\\n' "\${FAKE_AUTHORITY_POLICY:?}" ;;
  *"iam list-role-policies"*) printf '%s\\n' "\${FAKE_AUTHORITY_INLINE_POLICIES:?}" ;;
  *"iam list-attached-role-policies"*) printf '%s\\n' "\${FAKE_AUTHORITY_ATTACHED_POLICIES:?}" ;;
  *"iam list-instance-profiles-for-role"*) printf '%s\\n' "\${FAKE_AUTHORITY_INSTANCE_PROFILES:?}" ;;
  *"iam get-role"*)
    role_state="\${FAKE_AUTHORITY_ROLE_STATE:-present}"
    case "$role_state" in
      absent-then-present|absent-then-access-denied)
        role_state_call="$(<"\${FAKE_AUTHORITY_ROLE_STATE_FILE:?}")"
        printf '%s' "$((role_state_call + 1))" >"$FAKE_AUTHORITY_ROLE_STATE_FILE"
        if [ "$role_state_call" -eq 0 ]; then
          role_state=absent
        elif [ "$role_state" = "absent-then-present" ]; then
          role_state=present
        else
          role_state=access-denied
        fi
        ;;
    esac
    case "$role_state" in
      absent)
        echo "An error occurred (NoSuchEntity) when calling the GetRole operation: The role with name \${FAKE_AUTHORITY_ROLE_NAME:?} cannot be found." >&2
        exit 254
        ;;
      access-denied)
        echo "An error occurred (AccessDenied) when calling the GetRole operation: denied for \${FAKE_AUTHORITY_ROLE_NAME:?}" >&2
        exit 254
        ;;
      present) printf '%s\\n' "\${FAKE_AUTHORITY_ROLE:?}" ;;
      *) exit 98 ;;
    esac
    ;;
  *"cloudformation describe-stacks"*) printf '%s\\n' "\${FAKE_AUTHORITY_STACK:?}" ;;
  *"cloudformation get-template"*) printf '%s\\n' "\${FAKE_AUTHORITY_TEMPLATE:?}" ;;
  *"cloudformation list-stack-resources"*) printf '%s\\n' "\${FAKE_AUTHORITY_RESOURCES:?}" ;;
  *) echo "Unexpected aws invocation" >&2; exit 97 ;;
esac
`
    );

    const execution = spawnSync(
      "bash",
      [FOUNDATION_MIGRATION_AUTHORITY_SCRIPT, fixture.mode],
      {
        cwd: ROOT,
        encoding: "utf8",
        env: {
          ...authorityEnvironment(),
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          AWS_FOUNDATION_MIGRATION_ROLE_ARN: roleArn,
          TARGET_SHA: AUTHORITY_SOURCE_COMMIT,
          FAKE_AUTHORITY_TRACE: traceFile,
          FAKE_AUTHORITY_ROLE_STATE_FILE: roleStateFile,
          FAKE_AUTHORITY_ROLE: JSON.stringify(role),
          FAKE_AUTHORITY_ROLE_NAME: roleName,
          FAKE_AUTHORITY_ROLE_STATE:
            fixture.orphanRoleState ??
            (fixture.mode === "verify-retirement-orphaned"
              ? "absent"
              : "present"),
          FAKE_AUTHORITY_POLICY: JSON.stringify(rolePolicy),
          FAKE_AUTHORITY_INLINE_POLICIES: JSON.stringify(inlinePolicies),
          FAKE_AUTHORITY_ATTACHED_POLICIES: JSON.stringify(
            attachedPolicies
          ),
          FAKE_AUTHORITY_INSTANCE_PROFILES: JSON.stringify(
            instanceProfiles
          ),
          FAKE_AUTHORITY_STACK: JSON.stringify(stack),
          FAKE_AUTHORITY_TEMPLATE: JSON.stringify({
            TemplateBody: liveTemplate,
          }),
          FAKE_AUTHORITY_RESOURCES: JSON.stringify(resources),
        },
      }
    );
    return {
      execution,
      trace: readFileSync(traceFile, "utf8"),
      recordedDigest,
      canonicalDigest: sha256Utf8(liveCanonical),
      stackIdDigest: sha256Utf8(stackId),
      stackIdDigestWithLf: sha256Utf8(`${stackId}\n`),
    };
  } finally {
    rmSync(fakeBin, { recursive: true, force: true });
  }
}

test("foundation authority future digest is canonical and has no terminator", () => {
  const template = renderAuthorityJson("render-template");
  const digest = spawnSync(
    "bash",
    [FOUNDATION_MIGRATION_AUTHORITY_SCRIPT, "render-template-sha256"],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: authorityEnvironment(),
    }
  );
  assert.equal(digest.status, 0, digest.stderr);
  const canonical = canonicalJson(template);
  assert.equal(digest.stdout.trim(), sha256Utf8(canonical));
  assert.notEqual(digest.stdout.trim(), sha256Utf8(`${canonical}\n`));
  assert.notEqual(digest.stdout.trim(), sha256Utf8(`${canonical}\r\n`));
});

test("foundation intrinsic retirement accepts only exact none, LF, or CRLF bindings", () => {
  for (const representation of ["none", "lf", "crlf"] as const) {
    const result = runAuthorityProof({
      mode: "verify-intrinsic",
      representation,
    });
    assert.equal(result.execution.status, 0, result.execution.stderr);
    const proof = JSON.parse(result.execution.stdout);
    assert.equal(proof.schemaVersion, 2);
    assert.equal(proof.recordedAuthorityTemplateSha256, result.recordedDigest);
    assert.equal(proof.canonicalAuthorityTemplateSha256, result.canonicalDigest);
    assert.equal(proof.authorityStackIdSha256, result.stackIdDigest);
    assert.notEqual(proof.authorityStackIdSha256, result.stackIdDigestWithLf);
    assert.equal(proof.recordedTemplateTerminator, representation);
    assert.equal(
      proof.templateCanonicalization,
      "jq-sort-compact-no-terminator-v1"
    );
    assert.equal(proof.legacyTemplateDigestAccepted, representation !== "none");
    assert.equal(proof.roleAttachmentContractVerified, true);
    assert.equal(proof.terminalLifecycleSafetyContractVersion, 2);
    assert.equal(proof.standardDeleteRetryEligible, false);
    assert.match(proof.roleIdSha256, /^[0-9a-f]{64}$/u);
    for (const call of [
      "iam list-role-policies",
      "iam list-attached-role-policies",
      "iam list-instance-profiles-for-role",
    ]) {
      assert.ok(result.trace.includes(call), call);
    }
    assert.doesNotMatch(result.trace, /cloudformation delete-stack/u);
  }

  for (const representation of [
    "space",
    "cr",
    "double-lf",
    "tab",
    "bom",
  ] as const) {
    const result = runAuthorityProof({
      mode: "verify-intrinsic",
      representation,
    });
    assert.notEqual(result.execution.status, 0, representation);
    assert.match(result.execution.stderr, /template-digest-binding/u);
    assert.doesNotMatch(result.trace, /cloudformation delete-stack/u);
  }
});

test("foundation DELETE_FAILED retirement retry is intrinsic and standard-only eligible", () => {
  const result = runAuthorityProof({
    mode: "verify-retirement-retry",
    representation: "none",
  });
  assert.equal(result.execution.status, 0, result.execution.stderr);
  const proof = JSON.parse(result.execution.stdout);
  assert.equal(proof.verificationMode, "verify-retirement-retry");
  assert.equal(proof.stackStatus, "DELETE_FAILED");
  assert.equal(proof.liveContractExact, false);
  assert.equal(proof.cloudFormationCreationContractExact, false);
  assert.equal(proof.retirementRetryContractExact, true);
  assert.equal(proof.standardDeleteRetryEligible, true);
  assert.equal(proof.terminalLifecycleSafetyContractVersion, 2);
  assert.doesNotMatch(result.trace, /--deletion-mode|retain-resources/u);
});

test("foundation orphaned DELETE_FAILED proof is canonical, absence-fresh, and retain-only eligible", () => {
  const result = runAuthorityProof({
    mode: "verify-retirement-orphaned",
    representation: "none",
  });
  assert.equal(result.execution.status, 0, result.execution.stderr);
  const proof = JSON.parse(result.execution.stdout);
  assert.equal(proof.verificationMode, "verify-retirement-orphaned");
  assert.equal(proof.stackStatus, "DELETE_FAILED");
  assert.equal(proof.resourceStatus, "DELETE_FAILED");
  assert.equal(proof.authorityRolePresent, false);
  assert.equal(proof.roleAbsenceVerified, true);
  assert.equal(proof.roleAbsenceErrorCode, "NoSuchEntity");
  assert.equal(proof.roleAbsenceChecks, 2);
  assert.equal(proof.roleAbsenceFreshAtProofEmission, true);
  assert.equal(proof.roleIdentityEvidenceSource, "cloudformation-output");
  assert.equal(proof.roleIdLiveVerified, false);
  assert.equal(proof.trustPolicyEvidenceSource, "cloudformation-template");
  assert.equal(
    proof.permissionsPolicyEvidenceSource,
    "cloudformation-template"
  );
  assert.equal(proof.roleRuntimeContractVerified, false);
  assert.equal(proof.roleAttachmentContractVerified, false);
  assert.equal(proof.roleAttachmentInventorySha256, null);
  assert.equal(proof.retirementRetryContractExact, false);
  assert.equal(proof.standardDeleteRetryEligible, false);
  assert.equal(proof.orphanedRetirementContractExact, true);
  assert.equal(proof.targetedRetainReconciliationEligible, true);
  assert.deepEqual(proof.requiredRetainResources, [
    "FoundationMigrationRole",
  ]);
  assert.equal(proof.forceDeleteEligible, false);
  assert.equal(
    (result.trace.match(/iam get-role/gu) ?? []).length,
    2
  );
  assert.doesNotMatch(
    result.trace,
    /iam get-role-policy|iam list-role-policies|iam list-attached-role-policies|iam list-instance-profiles-for-role/u
  );
  assert.doesNotMatch(result.trace, /cloudformation delete-stack/u);
});

test("foundation orphaned proof rejects non-canonical, present, and ambiguous role states", () => {
  const legacy = runAuthorityProof({
    mode: "verify-retirement-orphaned",
    representation: "lf",
  });
  assert.notEqual(legacy.execution.status, 0);
  assert.match(legacy.execution.stderr, /orphaned-template-not-canonical/u);

  const present = runAuthorityProof({
    mode: "verify-retirement-orphaned",
    representation: "none",
    orphanRoleState: "present",
  });
  assert.notEqual(present.execution.status, 0);
  assert.match(present.execution.stderr, /orphaned-role-present/u);

  const denied = runAuthorityProof({
    mode: "verify-retirement-orphaned",
    representation: "none",
    orphanRoleState: "access-denied",
  });
  assert.notEqual(denied.execution.status, 0);
  assert.match(denied.execution.stderr, /orphaned-role-absence-unproven/u);
  assert.doesNotMatch(
    denied.trace,
    /iam get-role-policy|iam list-role-policies|iam list-attached-role-policies|iam list-instance-profiles-for-role/u
  );

  for (const transition of [
    {
      state: "absent-then-present",
      error: /orphaned-role-reappeared/u,
    },
    {
      state: "absent-then-access-denied",
      error: /final-orphaned-role-absence-unproven/u,
    },
  ] as const) {
    const result = runAuthorityProof({
      mode: "verify-retirement-orphaned",
      representation: "none",
      orphanRoleState: transition.state,
    });
    assert.notEqual(result.execution.status, 0, transition.state);
    assert.match(result.execution.stderr, transition.error);
    assert.equal(
      (result.trace.match(/iam get-role/gu) ?? []).length,
      2,
      transition.state
    );
    assert.doesNotMatch(
      result.trace,
      /iam get-role-policy|iam list-role-policies|iam list-attached-role-policies|iam list-instance-profiles-for-role|cloudformation delete-stack/u
    );
  }
});

test("foundation strict verification rejects legacy or modified authority bindings", () => {
  const exact = runAuthorityProof({ mode: "verify", representation: "none" });
  assert.equal(exact.execution.status, 0, exact.execution.stderr);
  assert.equal(
    JSON.parse(exact.execution.stdout).recordedTemplateTerminator,
    "none"
  );

  for (const representation of ["lf", "crlf"] as const) {
    const legacy = runAuthorityProof({ mode: "verify", representation });
    assert.notEqual(legacy.execution.status, 0, representation);
    assert.doesNotMatch(legacy.trace, /cloudformation delete-stack/u);
  }

  const unrelated = runAuthorityProof({
    mode: "verify-intrinsic",
    recordedDigest: "0".repeat(64),
  });
  assert.notEqual(unrelated.execution.status, 0);
  assert.match(unrelated.execution.stderr, /template-digest-binding/u);
  assert.doesNotMatch(unrelated.trace, /cloudformation delete-stack/u);

  const modified = runAuthorityProof({
    mode: "verify-intrinsic",
    mutateTemplate: true,
  });
  assert.notEqual(modified.execution.status, 0);
  assert.doesNotMatch(modified.trace, /cloudformation delete-stack/u);
});

test("foundation authority rejects extra policies and instance profiles", () => {
  for (const fixture of [
    { extraInlinePolicy: true },
    { attachedPolicy: true },
    { instanceProfile: true },
  ]) {
    const result = runAuthorityProof({
      mode: "verify-intrinsic",
      representation: "none",
      ...fixture,
    });
    assert.notEqual(result.execution.status, 0, JSON.stringify(fixture));
    assert.doesNotMatch(result.trace, /cloudformation delete-stack/u);
  }
});

test("legacy foundation workflow receipts hash change-set ARNs and S3 version IDs", () => {
  assert.equal((WORKFLOW.match(/versionIdSha256:/gmu) ?? []).length, 2);
  assert.equal((WORKFLOW.match(/arnSha256:/gmu) ?? []).length, 5);
  for (const expected of [
    "--arg versionIdSha256",
    "--arg changeSetArnSha256",
    "--arg recoveryChangeSetArnSha256",
    "versionIdSha256: $versionIdSha256",
    "arnSha256: $changeSetArnSha256",
  ]) {
    assert.ok(WORKFLOW.includes(expected), expected);
  }
  assert.doesNotMatch(
    WORKFLOW,
    /--arg (?:version|changeSetId|recoveryChangeSetId)\s/u
  );
  assert.doesNotMatch(
    WORKFLOW,
    /(?:versionId|changeSetId|id):\s*\$(?:version|changeSetId|recoveryChangeSetId)/u
  );
});

test("AWS application names cannot overflow the longest generated S3 bucket", () => {
  const constrainedTemplates = [
    BOOTSTRAP,
    readFileSync(join(ROOT, "aws", "template.yaml"), "utf8"),
    readFileSync(join(ROOT, "aws", "edge-waf.yaml"), "utf8"),
  ];
  for (const source of constrainedTemplates) {
    assert.match(
      source,
      /AppName:\r?\n\s+Type: String\r?\n\s+Default: archon-memory\r?\n\s+MinLength: 3\r?\n\s+MaxLength: 17\r?\n\s+AllowedPattern: "\^\[a-z\]\[a-z0-9-\]\{2,16\}\$"/u
    );
  }

  const constrainedValidators = [
    PROOF_SOURCE,
    APPLICATION_PROOF_SOURCE,
    FOUNDATION_STORAGE_PROOF_SOURCE,
    readFileSync(join(ROOT, "aws", "prove-alarm-routing.sh"), "utf8"),
    readFileSync(
      join(ROOT, "aws", "merge-canonical-stack-tags.sh"),
      "utf8"
    ),
    readFileSync(
      join(ROOT, "aws", "enforce-cloudformation-controls.sh"),
      "utf8"
    ),
    readFileSync(
      join(ROOT, "scripts", "provision-runtime-secret.ts"),
      "utf8"
    ),
  ];
  for (const source of constrainedValidators) {
    assert.ok(source.includes("^[a-z][a-z0-9-]{2,16}$"));
    assert.ok(!source.includes("^[a-z][a-z0-9-]{2,24}$"));
  }

  const longestValidBucket =
    `${"a".repeat(17)}-cloudfront-access-logs-` +
    `${"1".repeat(12)}-eu-west-1`;
  const firstInvalidBucket =
    `${"a".repeat(18)}-cloudfront-access-logs-` +
    `${"1".repeat(12)}-eu-west-1`;
  assert.equal(longestValidBucket.length, 63);
  assert.equal(firstInvalidBucket.length, 64);
});

test("frontend rollback copies remain writable under the mandatory KMS policy", () => {
  const rollbackCopies = [
    ...DEPLOY_WORKFLOW.matchAll(
      /if ! aws s3api copy-object \\\r?\n[\s\S]*?--region "\$AWS_REGION" >\/dev\/null; then/gu
    ),
  ].map((match) => match[0]);
  assert.equal(rollbackCopies.length, 2);
  assert.equal(
    (
      DEPLOY_WORKFLOW.match(
        /^\s+storage_key_alias="arn:aws:kms:\$\{AWS_REGION\}:\$\{AWS_ACCOUNT_ID\}:alias\/\$\{APP_NAME\}-storage"$/gmu
      ) ?? []
    ).length,
    2
  );
  for (const copy of rollbackCopies) {
    assert.match(copy, /--server-side-encryption aws:kms/u);
    assert.match(copy, /--ssekms-key-id "\$storage_key_alias"/u);
    assert.match(copy, /--metadata-directive REPLACE/u);
  }
});

test("S3 log delivery policy binds each source to only its own prefix", () => {
  const policy = resourceBlock("S3AccessLogArchivePolicy");
  assert.match(policy, /DeletionPolicy: RetainExceptOnCreate/u);
  assert.match(policy, /UpdateReplacePolicy: Retain/u);
  assert.equal(
    (policy.match(/Service: logging\.s3\.amazonaws\.com/gmu) ?? []).length,
    4
  );
  assert.equal((policy.match(/Action: s3:PutObject/gmu) ?? []).length, 4);
  assert.equal((policy.match(/aws:SourceAccount:/gmu) ?? []).length, 4);
  assert.match(
    policy,
    /AllowArtifactBucketServerAccessLogs[\s\S]*?\/artifacts\/\*[\s\S]*?-artifacts-\$\{AWS::AccountId\}-\$\{AWS::Region\}/u
  );
  assert.match(
    policy,
    /AllowStagingWebBucketServerAccessLogs[\s\S]*?\/staging-web\/\*[\s\S]*?-staging-web-\$\{AWS::AccountId\}-\$\{AWS::Region\}/u
  );
  assert.match(
    policy,
    /AllowProductionWebBucketServerAccessLogs[\s\S]*?\/production-web\/\*[\s\S]*?-production-web-\$\{AWS::AccountId\}-\$\{AWS::Region\}/u
  );
  assert.match(
    policy,
    /AllowCloudFrontLogBucketServerAccessLogs[\s\S]*?\/cloudfront-log-bucket\/\*[\s\S]*?-cloudfront-access-logs-\$\{AWS::AccountId\}-\$\{AWS::Region\}/u
  );
  assert.doesNotMatch(policy, /s3:x-amz-acl|PutObjectAcl|TargetGrants/u);

  const artifact = resourceBlock("ArtifactBucket");
  assert.match(artifact, /DependsOn: S3AccessLogArchivePolicy/u);
  assert.match(
    artifact,
    /LoggingConfiguration: !If[\s\S]*?- EnableArtifactAccessLogging[\s\S]*?LogFilePrefix: artifacts\/[\s\S]*?PartitionDateSource: EventTime[\s\S]*?- !Ref AWS::NoValue/u
  );
});

test("foundation promotion policy stays canonical, narrow, and within IAM quota", () => {
  const policy = renderedFoundationPromotionPolicy();
  const expectedSids = [
    "CreatePinnedBootstrapChangeSet",
    "ExecuteOnlyBootstrapLoggingChangeSets",
    "InspectBootstrapStackAndChangeSets",
    "InspectFoundationMigrationState",
    "InspectOneTimeFoundationMigrationAuthority",
    "RetireOneTimeFoundationMigrationAuthorityStack",
    "PassOnlyFoundationAuthorityRetirementExecutionRole",
    "PublishImmutableFoundationTemplate",
    "EncryptImmutableFoundationTemplate",
    "InspectOriginVerificationSecretMetadata",
    "InspectArtifactAndArchiveBuckets",
    "ActivateArtifactBucketLoggingWithoutReplacement",
    "InspectFoundationAutomationRule",
    "ResolveExactCloudFormationExecutionRoles",
    "ResolveExactFoundationRoleAttributes",
    "InspectPermanentControlRoleMetadata",
    "InspectPermanentControlRolePolicies",
    "InspectFoundationRetirementRoleMetadata",
    "InspectFoundationRetirementRolePolicies",
    "ResolveExactFoundationAutomationRule",
  ];
  assert.equal(policy.Version, "2012-10-17");
  assert.deepEqual(
    policy.Statement.map(({ Sid }) => Sid),
    expectedSids
  );
  assert.equal(new Set(expectedSids).size, expectedSids.length);
  assert.ok(policy.Statement.every(({ Effect }) => Effect === "Allow"));

  const actions = (statement: InlinePolicyDocument["Statement"][number]) =>
    Array.isArray(statement.Action) ? statement.Action : [statement.Action];
  const resources = (statement: InlinePolicyDocument["Statement"][number]) =>
    Array.isArray(statement.Resource)
      ? statement.Resource
      : [statement.Resource];
  assert.ok(
    policy.Statement.every(
      (statement) =>
        !actions(statement).some(
          (action) =>
            action === "*" ||
            action === "cloudformation:*" ||
            action === "iam:*" ||
            action.startsWith("iam:Delete")
        ) && !resources(statement).includes("*")
    )
  );

  const retirement = policy.Statement.find(
    ({ Sid }) => Sid === "RetireOneTimeFoundationMigrationAuthorityStack"
  );
  const passRole = policy.Statement.find(
    ({ Sid }) =>
      Sid === "PassOnlyFoundationAuthorityRetirementExecutionRole"
  );
  assert.ok(retirement);
  assert.ok(passRole);
  assert.deepEqual(actions(retirement), ["cloudformation:DeleteStack"]);
  assert.deepEqual(actions(passRole), ["iam:PassRole"]);
  assert.equal(
    policy.Statement.filter((statement) =>
      actions(statement).includes("cloudformation:DeleteStack")
    ).length,
    1
  );
  assert.equal(
    policy.Statement.filter((statement) =>
      actions(statement).includes("iam:PassRole")
    ).length,
    1
  );

  const compactPolicy = JSON.stringify(policy);
  assert.doesNotMatch(compactPolicy, /\$\{|Foundation[A-Za-z]+\.Arn/u);
  assert.ok(
    Buffer.byteLength(compactPolicy, "utf8") <= 10_240,
    "FoundationPromotionRole aggregate inline policy exceeds 10,240 characters"
  );
});

test("deploy gate rejects stale or superseded foundation and edge receipts", () => {
  const gate = workflowStep(
    DEPLOY_WORKFLOW,
    "Require exact-SHA foundation and edge-control receipts"
  );
  assert.ok(gate.length > 0);
  for (const expected of [
    "prove_foundation_receipt()",
    "prove_edge_receipt()",
    "EDGE_CONTROL_RUNS=",
    '<<<"$EDGE_CONTROL_RUNS"',
    '.head_sha as $head',
    '.display_title == ("Foundation plan " + $head)',
    '.display_title == ("Foundation apply " + $head)',
    '.display_title == ("Foundation verify " + $head)',
    '.display_title == ("Foundation abort " + $head)',
    '.display_title == ("Foundation retire " + $head)',
    '("Edge " + $environment + " cleanup " + $head)',
    '("Edge " + $environment + " finalize " + $head)',
    "actions/workflows/foundation-migration.yml/runs?per_page=100",
    "actions/workflows/edge-controls.yml/runs?per_page=100",
    "--paginate",
    "--slurp",
    "sort_by(.updated_at, .run_number, .run_attempt)",
    "CONTROL_RECEIPT_SUPERSEDED=true",
    'if [ "$CONTROL_RECEIPT_SUPERSEDED" = "true" ]; then',
    'gh api "repos/$GITHUB_REPOSITORY/git/ref/heads/main"',
    '.ref == "refs/heads/main"',
    '.object.sha == $sha',
    '[ "$operation" = "verify" ] || return 1',
    '[[ "$operation" =~ ^(verify|apply)$ ]] || return 1',
    'or .result == "apply-finalized-and-proved"',
    "controllerRoleIdSha256",
    "controllerPolicySha256",
    "controllerInventorySha256",
    "controllerDriftSha256",
    "executionRoleIdSha256",
    "executionPolicySha256",
    "executionInventorySha256",
    "executionDriftSha256",
  ]) {
    assert.ok(gate.includes(expected), expected);
  }
  assert.doesNotMatch(
    gate,
    /runs\?[^"\r\n]*(?:branch|event)=|--branch[ =]|--event[ =]/u
  );
  assert.equal((gate.match(/--paginate/gu) ?? []).length, 2);
  assert.equal((gate.match(/--slurp/gu) ?? []).length, 2);
  assert.equal(
    (gate.match(/foundation-migration\.yml\/runs\?per_page=100/gu) ?? [])
      .length,
    1
  );
  assert.equal(
    (gate.match(/edge-controls\.yml\/runs\?per_page=100/gu) ?? []).length,
    1
  );
  assert.equal((gate.match(/if ! runs="\$\(/gmu) ?? []).length, 1);
  assert.equal(
    (gate.match(/if ! EDGE_CONTROL_RUNS="\$\(/gmu) ?? []).length,
    1
  );
  assert.equal(
    (gate.match(/CONTROL_RECEIPT_SUPERSEDED=true/gmu) ?? []).length,
    2
  );
  assert.match(
    gate,
    /if \[ "\$CONTROL_RECEIPT_SUPERSEDED" = "true" \]; then[\s\S]*?superseded \$EXPECTED_SHA[\s\S]*?exit 1/u
  );
  assert.ok(
    gate.indexOf('current_main="$(') <
      gate.indexOf('echo "foundation_run_id=$PROVED_FOUNDATION_RUN_ID"')
  );
  assert.equal(
    (gate.match(/if ! gh run download "\$id"/gmu) ?? []).length,
    2
  );
  assert.equal(
    (
      gate.match(
        /gh run download "\$id" \\\r?\n\s+--repo "\$GITHUB_REPOSITORY"/gmu
      ) ?? []
    ).length,
    2
  );
  assert.equal((gate.match(/\[ "\$conclusion" = "success" \]/gmu) ?? []).length, 2);
});

type FenceControlOperation =
  | "plan"
  | "apply"
  | "verify"
  | "abort"
  | "retire"
  | "cleanup"
  | "finalize";

interface ControlPlaneFenceFixture {
  foundationRuns?: Array<Record<string, unknown>>;
  edgeRuns?: Array<Record<string, unknown>>;
  mainSha?: string;
  expectedFoundationRunId?: string;
  expectedFoundationRunAttempt?: string;
  expectedStagingRunId?: string;
  expectedStagingRunAttempt?: string;
  expectedProductionRunId?: string;
  expectedProductionRunAttempt?: string;
  environment?: "staging" | "production";
  jobId?: "deploy-staging" | "deploy-production";
}

const CONTROL_PLANE_FENCE_SHA = "b".repeat(40);

function foundationFenceRun({
  id,
  sha = CONTROL_PLANE_FENCE_SHA,
  attempt = 1,
  conclusion = "success",
  operation = "verify",
  updatedAt,
}: {
  id: number;
  sha?: string;
  attempt?: number;
  conclusion?: string | null;
  operation?: FenceControlOperation;
  updatedAt: string;
}): Record<string, unknown> {
  return {
    id,
    run_attempt: attempt,
    run_number: id,
    updated_at: updatedAt,
    conclusion,
    head_sha: sha,
    head_branch: "main",
    event: "workflow_dispatch",
    name: "Foundation Storage Migration",
    path: ".github/workflows/foundation-migration.yml",
    display_title: `Foundation ${operation} ${sha}`,
  };
}

function edgeFenceRun({
  id,
  environment,
  sha = CONTROL_PLANE_FENCE_SHA,
  attempt = 1,
  conclusion = "success",
  operation = "verify",
  updatedAt,
}: {
  id: number;
  environment: "staging" | "production";
  sha?: string;
  attempt?: number;
  conclusion?: string | null;
  operation?: FenceControlOperation;
  updatedAt: string;
}): Record<string, unknown> {
  return {
    id,
    run_attempt: attempt,
    run_number: id,
    updated_at: updatedAt,
    conclusion,
    head_sha: sha,
    head_branch: "main",
    event: "workflow_dispatch",
    name: "Manage AWS Edge Controls",
    path: ".github/workflows/edge-controls.yml",
    display_title: `Edge ${environment} ${operation} ${sha}`,
  };
}

function defaultFoundationFenceRuns(): Array<Record<string, unknown>> {
  return [
    foundationFenceRun({
      id: 90,
      sha: "a".repeat(40),
      updatedAt: "2026-07-31T23:59:59Z",
    }),
    foundationFenceRun({
      id: 101,
      attempt: 2,
      updatedAt: "2026-08-01T00:00:00Z",
    }),
  ];
}

function defaultEdgeFenceRuns(): Array<Record<string, unknown>> {
  return [
    edgeFenceRun({
      id: 190,
      environment: "staging",
      operation: "plan",
      updatedAt: "2026-07-31T23:59:58Z",
    }),
    edgeFenceRun({
      id: 201,
      environment: "staging",
      operation: "apply",
      updatedAt: "2026-08-01T00:00:01Z",
    }),
    edgeFenceRun({
      id: 301,
      environment: "production",
      attempt: 3,
      operation: "verify",
      updatedAt: "2026-08-01T00:00:02Z",
    }),
  ];
}

function runControlPlaneFence(fixture: ControlPlaneFenceFixture = {}) {
  const fakeBin = mkdtempSync(join(tmpdir(), "archon-control-plane-fence-"));
  try {
    const traceFile = join(fakeBin, "trace.log");
    writeFileSync(traceFile, "", "utf8");
    executable(
      join(fakeBin, "gh"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >>"\${FAKE_FENCE_TRACE:?}"
case "$*" in
  *"foundation-migration.yml/runs"*)
    printf '%s\\n' "\${FAKE_FOUNDATION_RUNS:?}"
    ;;
  *"edge-controls.yml/runs"*)
    printf '%s\\n' "\${FAKE_EDGE_RUNS:?}"
    ;;
  *"git/ref/heads/main"*)
    printf '%s\\n' "\${FAKE_MAIN_REF:?}"
    ;;
  *)
    echo "Unexpected gh invocation" >&2
    exit 97
    ;;
esac
`
    );
    const environment = fixture.environment ?? "staging";
    const jobId =
      fixture.jobId ??
      (environment === "staging" ? "deploy-staging" : "deploy-production");
    const execution = spawnSync("bash", [CONTROL_PLANE_FENCE_SCRIPT], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        EXPECTED_SHA: CONTROL_PLANE_FENCE_SHA,
        EXPECTED_FOUNDATION_RUN_ID:
          fixture.expectedFoundationRunId ?? "101",
        EXPECTED_FOUNDATION_RUN_ATTEMPT:
          fixture.expectedFoundationRunAttempt ?? "2",
        EXPECTED_STAGING_EDGE_RUN_ID:
          fixture.expectedStagingRunId ?? "201",
        EXPECTED_STAGING_EDGE_RUN_ATTEMPT:
          fixture.expectedStagingRunAttempt ?? "1",
        EXPECTED_PRODUCTION_EDGE_RUN_ID:
          fixture.expectedProductionRunId ?? "301",
        EXPECTED_PRODUCTION_EDGE_RUN_ATTEMPT:
          fixture.expectedProductionRunAttempt ?? "3",
        FENCE_ENVIRONMENT: environment,
        FENCE_JOB_ID: jobId,
        FENCE_MUTEX_GROUP: "aws-shared-control-plane-mutation",
        GH_TOKEN: "pipeline-test-token",
        GITHUB_REPOSITORY: "upgradedev/archon-cockroach-memory",
        GITHUB_RUN_ID: "9001",
        GITHUB_RUN_ATTEMPT: "4",
        FAKE_FENCE_TRACE: traceFile,
        FAKE_FOUNDATION_RUNS: JSON.stringify([
          {
            workflow_runs:
              fixture.foundationRuns ?? defaultFoundationFenceRuns(),
          },
        ]),
        FAKE_EDGE_RUNS: JSON.stringify([
          { workflow_runs: fixture.edgeRuns ?? defaultEdgeFenceRuns() },
        ]),
        FAKE_MAIN_REF: JSON.stringify({
          ref: "refs/heads/main",
          object: {
            type: "commit",
            sha: fixture.mainSha ?? CONTROL_PLANE_FENCE_SHA,
          },
        }),
      },
    });
    return {
      execution,
      trace: readFileSync(traceFile, "utf8"),
    };
  } finally {
    rmSync(fakeBin, { recursive: true, force: true });
  }
}

test("deploy receipt fence is globally latest, paginated, context-bound, and CI parsed", () => {
  assert.equal(
    (CONTROL_PLANE_FENCE_SOURCE.match(/--paginate/gu) ?? []).length,
    2
  );
  assert.equal(
    (CONTROL_PLANE_FENCE_SOURCE.match(/--slurp/gu) ?? []).length,
    2
  );
  for (const endpoint of [
    "actions/workflows/foundation-migration.yml/runs?per_page=100",
    "actions/workflows/edge-controls.yml/runs?per_page=100",
  ]) {
    assert.ok(CONTROL_PLANE_FENCE_SOURCE.includes(endpoint), endpoint);
    assert.equal(
      (CONTROL_PLANE_FENCE_SOURCE.match(
        new RegExp(endpoint.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "gu")
      ) ?? []).length,
      1,
      endpoint
    );
  }
  assert.equal(
    (CONTROL_PLANE_FENCE_SOURCE.match(/<<<"\$edge_runs"/gu) ?? []).length,
    1
  );
  assert.doesNotMatch(
    CONTROL_PLANE_FENCE_SOURCE,
    /runs\?[^"\r\n]*(?:branch|event)=|--branch[ =]|--event[ =]/u
  );
  assert.equal(
    (CONTROL_PLANE_FENCE_SOURCE.match(/\.\[\]\.workflow_runs\[\]/gu) ?? [])
      .length,
    2
  );
  assert.equal(
    (
      CONTROL_PLANE_FENCE_SOURCE.match(
        /sort_by\(\.updated_at, \.run_number, \.run_attempt\)[\s\S]*?\| last/gmu
      ) ?? []
    ).length,
    2
  );
  assert.doesNotMatch(
    CONTROL_PLANE_FENCE_SOURCE,
    /--arg sha "\$EXPECTED_SHA"/u
  );
  for (const expected of [
    '.head_sha as $head',
    '("Foundation verify " + $head)',
    '("Edge " + $environment + " cleanup " + $head)',
    'test "$foundation_id" = "$EXPECTED_FOUNDATION_RUN_ID"',
    'test "$foundation_attempt" = "$EXPECTED_FOUNDATION_RUN_ATTEMPT"',
    'test "$foundation_sha" = "$EXPECTED_SHA"',
    'test "$actual_id" = "$expected_id"',
    'test "$actual_attempt" = "$expected_attempt"',
    'test "$actual_sha" = "$EXPECTED_SHA"',
    'test "$(jq -er \'.object.sha\' <<<"$main_ref")" = "$EXPECTED_SHA"',
    'test "$FENCE_MUTEX_GROUP" = "aws-shared-control-plane-mutation"',
    "staging:deploy-staging|production:deploy-production",
    '[[ "$operation" =~ ^(apply|verify)$ ]]',
    'operation:$stagingEdgeOperation',
    'operation:$productionEdgeOperation',
    "edgeSnapshotShared:true",
    "jq -cS -n",
  ]) {
    assert.ok(CONTROL_PLANE_FENCE_SOURCE.includes(expected), expected);
  }
  assert.doesNotMatch(CONTROL_PLANE_FENCE_SOURCE, /(?:^|\n)\s*aws\s/u);
  assert.match(
    CI_WORKFLOW,
    /bash -n \.github\/scripts\/revalidate-aws-control-plane-fence\.sh/u
  );

  const result = runControlPlaneFence();
  assert.equal(result.execution.status, 0, result.execution.stderr);
  const proof = JSON.parse(result.execution.stdout);
  assert.equal(result.execution.stdout.trim(), canonicalJson(proof));
  assert.equal(proof.sourceSha, CONTROL_PLANE_FENCE_SHA);
  assert.equal(proof.mainHeadSha, CONTROL_PLANE_FENCE_SHA);
  assert.equal(proof.mainHeadRevalidated, true);
  assert.equal(proof.edgeSnapshotShared, true);
  assert.deepEqual(proof.mutex, {
    group: "aws-shared-control-plane-mutation",
    heldByCaller: true,
  });
  assert.deepEqual(proof.deployment, {
    environment: "staging",
    jobId: "deploy-staging",
    runAttempt: 4,
    runId: 9001,
  });
  assert.deepEqual(proof.foundation, {
    operation: "verify",
    runAttempt: 2,
    runId: 101,
  });
  assert.deepEqual(proof.edge, {
    production: { operation: "verify", runAttempt: 3, runId: 301 },
    staging: { operation: "apply", runAttempt: 1, runId: 201 },
  });
  assert.equal((result.trace.match(/--paginate --slurp/gu) ?? []).length, 2);
  assert.doesNotMatch(
    result.trace,
    /runs\?[^"\r\n]*(?:branch|event)=|--branch[ =]|--event[ =]/u
  );
  assert.equal((result.trace.match(/git\/ref\/heads\/main/gu) ?? []).length, 1);
});

test("deploy receipt fence fails closed on global supersession and binding drift", () => {
  const newerSha = "c".repeat(40);
  const cases: Array<[string, ReturnType<typeof runControlPlaneFence>]> = [
    [
      "newer foundation SHA",
      runControlPlaneFence({
        foundationRuns: [
          ...defaultFoundationFenceRuns(),
          foundationFenceRun({
            id: 401,
            sha: newerSha,
            operation: "plan",
            updatedAt: "2026-08-02T00:00:00Z",
          }),
        ],
      }),
    ],
    [
      "newer staging cleanup",
      runControlPlaneFence({
        edgeRuns: [
          ...defaultEdgeFenceRuns(),
          edgeFenceRun({
            id: 402,
            environment: "staging",
            operation: "cleanup",
            updatedAt: "2026-08-02T00:00:00Z",
          }),
        ],
      }),
    ],
    [
      "newer production finalize",
      runControlPlaneFence({
        edgeRuns: [
          ...defaultEdgeFenceRuns(),
          edgeFenceRun({
            id: 403,
            environment: "production",
            operation: "finalize",
            updatedAt: "2026-08-02T00:00:01Z",
          }),
        ],
      }),
    ],
    [
      "pending latest foundation verify",
      runControlPlaneFence({
        foundationRuns: [
          foundationFenceRun({
            id: 101,
            attempt: 2,
            conclusion: null,
            updatedAt: "2026-08-02T00:00:00Z",
          }),
        ],
      }),
    ],
    [
      "run-attempt mismatch",
      runControlPlaneFence({ expectedFoundationRunAttempt: "9" }),
    ],
    [
      "main-head mismatch",
      runControlPlaneFence({ mainSha: newerSha }),
    ],
  ];
  for (const [label, result] of cases) {
    assert.notEqual(result.execution.status, 0, label);
  }
});

test("deploy jobs revalidate exact source-gate outputs before release mutation and embed the canonical fence", () => {
  const sourceGate = workflowJob(DEPLOY_WORKFLOW, "source-gate");
  for (const expected of [
    "id: control_receipts",
    "foundation_control_run_id: ${{ steps.control_receipts.outputs.foundation_run_id }}",
    "foundation_control_run_attempt: ${{ steps.control_receipts.outputs.foundation_run_attempt }}",
    "staging_edge_control_run_id: ${{ steps.control_receipts.outputs.staging_edge_run_id }}",
    "staging_edge_control_run_attempt: ${{ steps.control_receipts.outputs.staging_edge_run_attempt }}",
    "production_edge_control_run_id: ${{ steps.control_receipts.outputs.production_edge_run_id }}",
    "production_edge_control_run_attempt: ${{ steps.control_receipts.outputs.production_edge_run_attempt }}",
    'echo "foundation_run_id=$PROVED_FOUNDATION_RUN_ID"',
    'echo "foundation_run_attempt=$PROVED_FOUNDATION_RUN_ATTEMPT"',
    'echo "staging_edge_run_id=$PROVED_STAGING_EDGE_RUN_ID"',
    'echo "staging_edge_run_attempt=$PROVED_STAGING_EDGE_RUN_ATTEMPT"',
    'echo "production_edge_run_id=$PROVED_PRODUCTION_EDGE_RUN_ID"',
    'echo "production_edge_run_attempt=$PROVED_PRODUCTION_EDGE_RUN_ATTEMPT"',
  ]) {
    assert.ok(sourceGate.includes(expected), expected);
  }
  assert.doesNotMatch(
    sourceGate,
    /revalidate-aws-control-plane-fence\.sh/u
  );

  const contracts = [
    {
      environment: "staging",
      jobId: "deploy-staging",
      revalidateName:
        "Revalidate staging control-plane fence before new release mutation",
      firstMutationName:
        "Enforce staging stack protection and fresh pre-deploy drift gate",
      receiptName: "Build and validate sanitized staging deployment receipt",
    },
    {
      environment: "production",
      jobId: "deploy-production",
      revalidateName:
        "Revalidate production control-plane fence before new release mutation",
      firstMutationName:
        "Enforce production stack protection and fresh pre-deploy drift gate",
      receiptName: "Build and validate sanitized production deployment receipt",
    },
  ] as const;
  assert.equal(
    (
      DEPLOY_WORKFLOW.match(
        /- name: Revalidate (?:staging|production) control-plane fence before new release mutation/gmu
      ) ?? []
    ).length,
    2
  );
  assert.equal(
    (
      DEPLOY_WORKFLOW.match(
        /bash \.github\/scripts\/revalidate-aws-control-plane-fence\.sh/gmu
      ) ?? []
    ).length,
    2
  );
  for (const contract of contracts) {
    const job = workflowJob(DEPLOY_WORKFLOW, contract.jobId);
    const revalidate = workflowStep(job, contract.revalidateName);
    const receipt = workflowStep(job, contract.receiptName);
    assert.ok(job.length > 0, contract.jobId);
    assert.match(
      job,
      /    concurrency:\r?\n      group: aws-shared-control-plane-mutation\r?\n      cancel-in-progress: false\r?\n      queue: max/u
    );
    assert.ok(revalidate.length > 0, contract.revalidateName);
    assert.ok(receipt.length > 0, contract.receiptName);
    assert.ok(
      job.indexOf(contract.revalidateName) <
        job.indexOf(contract.firstMutationName),
      contract.environment
    );
    for (const expected of [
      `FENCE_ENVIRONMENT: ${contract.environment}`,
      `FENCE_JOB_ID: ${contract.jobId}`,
      "FENCE_MUTEX_GROUP: aws-shared-control-plane-mutation",
      "bash .github/scripts/revalidate-aws-control-plane-fence.sh",
      'echo "CONTROL_PLANE_FENCE_FILE=$fence"',
      'echo "CONTROL_PLANE_FENCE_SHA256=$fence_sha256"',
    ]) {
      assert.ok(revalidate.includes(expected), expected);
    }
    for (const expected of [
      'test -f "$CONTROL_PLANE_FENCE_FILE"',
      'test ! -L "$CONTROL_PLANE_FENCE_FILE"',
      '--slurpfile controlPlaneFence "$CONTROL_PLANE_FENCE_FILE"',
      "$controlPlaneFence[0].mainHeadRevalidated == true",
      "$controlPlaneFence[0].latestEligibleRunsRevalidated == true",
      "$controlPlaneFence[0].edgeSnapshotShared == true",
      "$controlPlaneFence[0].mutationMutexHeldByCaller == true",
      'group:"aws-shared-control-plane-mutation"',
      `jobId:"${contract.jobId}"`,
      'operation:"verify"',
      'test("^(apply|verify)$")',
      "controlPlaneReceiptFence:",
      "$controlPlaneFence[0] + {",
      "sha256: $controlPlaneFenceSha256",
    ]) {
      assert.ok(receipt.includes(expected), expected);
    }
  }
  assert.equal(
    (DEPLOY_WORKFLOW.match(/--slurpfile controlPlaneFence/gu) ?? []).length,
    2
  );
  assert.equal(
    (DEPLOY_WORKFLOW.match(/controlPlaneReceiptFence:/gu) ?? []).length,
    2
  );
});

test("foundation activation role and workflow are narrow and fail closed", () => {
  const role = resourceBlock("FoundationPromotionRole");
  const policySource = role.match(
    /^      Policies:\r?\n(?<source>[\s\S]*?)(?=^      Tags:)/mu
  )?.groups?.source;
  assert.ok(policySource);
  assert.equal(
    sha256Utf8(policySource.replace(/\r\n/gu, "\n")),
    "531346397675b5653a29481ab37c26119f7436d95be47656365c88f2e900ea69"
  );
  for (const condition of [
    "token.actions.githubusercontent.com:aud: sts.amazonaws.com",
    "repo:${GitHubOrganization}/${GitHubRepository}:environment:bootstrap",
    "token.actions.githubusercontent.com:repository_id: !Ref GitHubRepositoryId",
    "token.actions.githubusercontent.com:repository_owner_id: !Ref GitHubRepositoryOwnerId",
    "token.actions.githubusercontent.com:ref: refs/heads/main",
    "token.actions.githubusercontent.com:environment: bootstrap",
  ]) {
    assert.ok(role.includes(condition), condition);
  }
  assert.match(
    role,
    /token\.actions\.githubusercontent\.com:workflow:\s+- Bootstrap AWS Foundation\s+- Foundation Storage Migration/u
  );
  assert.equal(
    (
      role.match(
        /^\s+- (?:Bootstrap AWS Foundation|Foundation Storage Migration)$/gmu
      ) ?? []
    ).length,
    2
  );
  assert.match(role, /Action: s3:PutBucketLogging/u);
  assert.match(
    role,
    /"ForAnyValue:StringEquals":[\s\S]*?aws:CalledVia: cloudformation\.amazonaws\.com/u
  );
  assert.match(role, /cloudformation:GetStackPolicy/u);
  assert.match(
    role,
    /Sid: InspectFoundationAutomationRule[\s\S]*?Action: securityhub:BatchGetAutomationRules[\s\S]*?Resource: !GetAtt S3AccessLogArchiveS39Suppression\.RuleArn/u
  );
  assert.match(
    role,
    /Sid: InspectOneTimeFoundationMigrationAuthority[\s\S]*?Action:\s+- iam:GetRole\s+- iam:GetRolePolicy\s+- iam:ListAttachedRolePolicies\s+- iam:ListInstanceProfilesForRole\s+- iam:ListRolePolicies\s+Resource: !Sub >-\s+arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:role\/\$\{AppName\}-github-foundation-migration/u
  );
  assert.match(
    role,
    /Sid: InspectBootstrapStackAndChangeSets[\s\S]*?cloudformation:DescribeChangeSet[\s\S]*?cloudformation:ListStackResources[\s\S]*?stack\/\$\{AppName\}-delivery-bootstrap\/\*[\s\S]*?stack\/\$\{AppName\}-foundation-migration-authority\/\*[\s\S]*?- Sid: InspectFoundationMigrationState/u
  );
  assert.match(
    role,
    /Sid: InspectFoundationMigrationState[\s\S]*?Action:\s+- cloudformation:DetectStackResourceDrift\s+- cloudformation:ListChangeSets\s+Resource: !Sub >-\s+arn:\$\{AWS::Partition\}:cloudformation:\$\{AWS::Region\}:\$\{AWS::AccountId\}:stack\/\$\{AppName\}-delivery-bootstrap\/\*/u
  );
  assert.match(
    role,
    /Sid: RetireOneTimeFoundationMigrationAuthorityStack[\s\S]*?Action: cloudformation:DeleteStack[\s\S]*?stack\/\$\{AppName\}-foundation-migration-authority\/\*[\s\S]*?ArnEquals:\s+cloudformation:RoleArn: !GetAtt FoundationAuthorityRetirementExecutionRole\.Arn/u
  );
  assert.match(
    role,
    /Sid: PassOnlyFoundationAuthorityRetirementExecutionRole[\s\S]*?Action: iam:PassRole[\s\S]*?Resource: !GetAtt FoundationAuthorityRetirementExecutionRole\.Arn[\s\S]*?iam:PassedToService: cloudformation\.amazonaws\.com/u
  );
  assert.match(
    role,
    /Sid: ResolveExactCloudFormationExecutionRoles[\s\S]*?Action: iam:GetRole\s+Resource:\s+- !Sub >-\s+arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:role\/\$\{AppName\}-staging-cloudformation\s+- !Sub >-\s+arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:role\/\$\{AppName\}-production-cloudformation\s+Condition:\s+"ForAnyValue:StringEquals":\s+aws:CalledVia: cloudformation\.amazonaws\.com/u
  );
  assert.match(
    role,
    /Sid: ResolveExactFoundationRoleAttributes[\s\S]*?Action: iam:GetRole[\s\S]*?- !GetAtt FoundationAuthorityRetirementExecutionRole\.Arn[\s\S]*?Condition:[\s\S]*?aws:CalledVia: cloudformation\.amazonaws\.com/u
  );
  assert.match(
    role,
    /Sid: InspectPermanentControlRoleMetadata[\s\S]*?Action: iam:GetRole[\s\S]*?github-alarm-routing-controls[\s\S]*?alarm-routing-cloudformation-execution[\s\S]*?- Sid: InspectPermanentControlRolePolicies/u
  );
  assert.match(
    role,
    /Sid: InspectPermanentControlRolePolicies[\s\S]*?Action: iam:GetRolePolicy[\s\S]*?github-alarm-routing-controls[\s\S]*?alarm-routing-cloudformation-execution[\s\S]*?- Sid: InspectFoundationRetirementRoleMetadata/u
  );
  assert.match(
    role,
    /Sid: InspectFoundationRetirementRoleMetadata[\s\S]*?Action:\s+- iam:GetRole\s+- iam:ListAttachedRolePolicies\s+- iam:ListInstanceProfilesForRole\s+- iam:ListRolePolicies[\s\S]*?github-foundation-promotion[\s\S]*?!GetAtt FoundationAuthorityRetirementExecutionRole\.Arn[\s\S]*?- Sid: InspectFoundationRetirementRolePolicies/u
  );
  assert.match(
    role,
    /Sid: InspectFoundationRetirementRolePolicies[\s\S]*?Action: iam:GetRolePolicy[\s\S]*?github-foundation-promotion[\s\S]*?!GetAtt FoundationAuthorityRetirementExecutionRole\.Arn[\s\S]*?- Sid: ResolveExactFoundationAutomationRule/u
  );
  assert.match(
    role,
    /Sid: ResolveExactFoundationAutomationRule[\s\S]*?Action: securityhub:ListTagsForResource\s+Resource: !GetAtt S3AccessLogArchiveS39Suppression\.RuleArn\s+Condition:\s+"ForAnyValue:StringEquals":\s+aws:CalledVia: cloudformation\.amazonaws\.com/u
  );
  assert.equal(
    (role.match(/Action: s3:PutBucketLogging/gmu) ?? []).length,
    1
  );
  assert.equal((role.match(/Action: iam:GetRole$/gmu) ?? []).length, 3);
  assert.equal((role.match(/Action: iam:GetRolePolicy$/gmu) ?? []).length, 2);
  assert.equal((role.match(/iam:ListRolePolicies/gmu) ?? []).length, 2);
  assert.equal((role.match(/iam:ListAttachedRolePolicies/gmu) ?? []).length, 2);
  assert.equal(
    (role.match(/iam:ListInstanceProfilesForRole/gmu) ?? []).length,
    2
  );
  assert.equal(
    (
      role.match(
        /arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:role\/\$\{AppName\}-[a-z-]+/gmu
      ) ?? []
    ).length,
    32
  );
  assert.equal(
    (role.match(/Action: securityhub:ListTagsForResource/gmu) ?? [])
      .length,
    1
  );
  assert.doesNotMatch(
    role,
    /iam:(?:Create|Delete|Update|Put|Attach|Detach|ListRoles|ListRoleTags)|securityhub:(?:Create|BatchUpdate|BatchDelete|ListAutomationRules)|cloudformation:(?:UpdateStack|SetStackPolicy)|role\/\*|automation-rule\/\*|Resource: "\*"/u
  );
  assert.equal((role.match(/Action: iam:PassRole/gmu) ?? []).length, 1);
  assert.equal(
    (role.match(/Action: cloudformation:DeleteStack/gmu) ?? []).length,
    1
  );
  assert.equal(
    (
      role.match(
        /Resource: !GetAtt S3AccessLogArchiveS39Suppression\.RuleArn/gmu
      ) ?? []
    ).length,
    2
  );
  assert.match(
    role,
    /cloudformation:TemplateUrl:[\s\S]*?https:\/\/\$\{AppName\}-artifacts-[\s\S]*?\/foundation\/\*/u
  );
  assert.match(
    role,
    /Sid: ExecuteOnlyBootstrapLoggingChangeSets[\s\S]*?cloudformation:ChangeSetName:[\s\S]*?- bootstrap-s3-\*[\s\S]*?changeSet\/bootstrap-s3-\*\/\*/u
  );
  assert.match(
    role,
    /"Null":[\s\S]*?cloudformation:RoleArn: "true"[\s\S]*?cloudformation:StackPolicyUrl: "true"/u
  );

  for (const expected of [
    "workflow_dispatch:",
    "operation:",
    "target_sha:",
    "ENABLE-ARTIFACT-S3-ACCESS-LOGGING",
    "test \"$GITHUB_REF\" = \"refs/heads/main\"",
    "test \"$GITHUB_SHA\" = \"$TARGET_SHA\"",
    "test \"$(git rev-parse origin/main)\" = \"$TARGET_SHA\"",
    "max_by([.run_number, .run_attempt])",
    "environment: bootstrap",
    "RoleARN // null",
    "UPDATE_ROLLBACK_COMPLETE",
    "cloudformation get-stack-policy",
    "StackPolicyBody | fromjson",
    "cloudformation delete-change-set",
    "CHANGE_SET_ID",
    ".ChangeSetId == $id",
    "Delete an unverified unexecuted activation plan",
    "steps.exact_plan.outcome == 'failure'",
    "env.ALREADY_ACTIVE != 'true'",
    "env.CHANGE_SET_ID != ''",
    '.Status == "CREATE_COMPLETE"',
    "--arg executionStatus",
    "deleted: $deleted",
    '"unverified-plan-cleanup-failed" false ""',
    '"unverified-plan-deleted" true "AVAILABLE"',
    'grep -Fq "ChangeSetNotFound"',
    '"ChangeSet [$CHANGE_SET_ID] does not exist"',
    'test "$deleted" = "true"',
    "wait_for_change_set_available",
    "wait_for_rollback_change_set",
    "--include-property-values",
    "--template-stage Original",
    "foundation-change-set-template.yaml",
    'ResourceChange.LogicalResourceId == "ArtifactBucket"',
    'ResourceChange.Replacement == "False"',
    '.Target.Name == "LoggingConfiguration"',
    "prove-s3-access-logging.sh baseline",
    "prove-s3-access-logging.sh verify",
    "apply-pending",
    "recover_to_baseline",
    "poll_activation_outcome",
    "wait_for_recovery_outcome",
    "--client-request-token",
    "live-proof-failed-rolled-back",
  ]) {
    assert.ok(WORKFLOW.includes(expected), expected);
  }
  assert.doesNotMatch(
    WORKFLOW,
    /cloudformation wait change-set-create-complete/u
  );
  assert.equal(
    (WORKFLOW.match(/--include-property-values/gmu) ?? []).length,
    4
  );
  assert.equal(
    (WORKFLOW.match(/--change-set-type UPDATE/gmu) ?? []).length,
    2
  );
  assert.match(
    WORKFLOW,
    /name: Delete an unverified unexecuted activation plan\s+if: \$\{\{ always\(\) && env\.ALREADY_ACTIVE != 'true' && steps\.exact_plan\.outcome == 'failure' && env\.CHANGE_SET_ID != '' \}\}[\s\S]*?\.ChangeSetId == \$id[\s\S]*?\.Status == "CREATE_COMPLETE"[\s\S]*?\.ExecutionStatus == "AVAILABLE"[\s\S]*?cloudformation delete-change-set[\s\S]*?--change-set-name "\$CHANGE_SET_ID"[\s\S]*?grep -Fq "ChangeSetNotFound"[\s\S]*?"ChangeSet \[\$CHANGE_SET_ID\] does not exist"[\s\S]*?test "\$deleted" = "true"[\s\S]*?record_cleanup "unverified-plan-deleted" true "AVAILABLE"/u
  );
  assert.doesNotMatch(WORKFLOW, /\.ChangeSetType/u);
  assert.equal((WORKFLOW.match(/RoleARN \/\/ null/gmu) ?? []).length, 2);
  assert.ok(
    (
      WORKFLOW.match(
        /--change-set-name "\$(?:CHANGE_SET_ID|rollback_id)"/gmu
      ) ?? []
    ).length >= 6
  );
  assert.doesNotMatch(
    WORKFLOW,
    /--role-arn|s3api put-bucket-logging|stack-update-rollback-complete|cloudformation (?:update-stack|delete-stack)/u
  );

  assert.deepEqual(STACK_POLICY.Statement[0], {
    Effect: "Allow",
    Principal: "*",
    Action: "Update:*",
    Resource: "*",
  });
  assert.deepEqual(
    [...STACK_POLICY.Statement[1].Resource].sort(),
    [
      "LogicalResourceId/AlarmArchiveQueuePolicy",
      "LogicalResourceId/AlarmNotificationsKey",
      "LogicalResourceId/AlarmNotificationsKeyAlias",
      "LogicalResourceId/AlarmRoutingCloudFormationExecutionRole",
      "LogicalResourceId/AlarmRoutingControlRole",
      "LogicalResourceId/AlarmStateInspectionPolicy",
      "LogicalResourceId/AlarmTopicPolicy",
      "LogicalResourceId/ApplicationStorageKey",
      "LogicalResourceId/ApplicationStorageKeyAlias",
      "LogicalResourceId/ArtifactBucket",
      "LogicalResourceId/ArtifactBucketPolicy",
      "LogicalResourceId/CloudFrontAccessLogBucket",
      "LogicalResourceId/CloudFrontAccessLogBucketPolicy",
      "LogicalResourceId/EdgeCleanupRole",
      "LogicalResourceId/EdgeControlRole",
      "LogicalResourceId/FinOpsCloudFormationExecutionRole",
      "LogicalResourceId/FinOpsControlRole",
      "LogicalResourceId/FoundationAuthorityRetirementExecutionRole",
      "LogicalResourceId/FoundationPromotionRole",
      "LogicalResourceId/GitHubOidcProvider",
      "LogicalResourceId/ProductionAlarmArchiveQueue",
      "LogicalResourceId/ProductionAlarmArchiveSubscription",
      "LogicalResourceId/ProductionAlarmRoutingInspectionPolicy",
      "LogicalResourceId/ProductionAlarmTopic",
      "LogicalResourceId/ProductionOriginVerifySecret",
      "LogicalResourceId/S3AccessLogArchive",
      "LogicalResourceId/S3AccessLogArchivePolicy",
      "LogicalResourceId/S3AccessLogArchiveS39Suppression",
      "LogicalResourceId/StagingAlarmArchiveQueue",
      "LogicalResourceId/StagingAlarmArchiveSubscription",
      "LogicalResourceId/StagingAlarmRoutingDrillQueue",
      "LogicalResourceId/StagingAlarmRoutingInspectionPolicy",
      "LogicalResourceId/StagingAlarmRoutingDrillAlarm",
      "LogicalResourceId/StagingAlarmRoutingDrillSubscription",
      "LogicalResourceId/StagingAlarmTopic",
      "LogicalResourceId/StagingCodeDeployInspectionPolicy",
      "LogicalResourceId/StagingOriginVerifySecret",
    ].sort()
  );
  assert.deepEqual(STACK_POLICY.Statement[1].Action, [
    "Update:Delete",
    "Update:Replace",
  ]);
});

test("environment deploy roles can prove but cannot mutate the logging foundation", () => {
  const legacyCandidatePath = new RegExp(
    `candidates/${"\\?".repeat(40)}/\\*`,
    "u"
  );
  assert.equal(
    (
      BOOTSTRAP.match(
        /Resource: !GetAtt S3AccessLogArchiveS39Suppression\.RuleArn/gmu
      ) ?? []
    ).length,
    4
  );
  assert.doesNotMatch(
    `${BOOTSTRAP}\n${PROOF_SOURCE}`,
    /ListAutomationRules|list-automation-rules|automation-rule\/\*/u
  );
  for (const logicalId of ["StagingDeployRole", "ProductionDeployRole"]) {
    const role = resourceBlock(logicalId);
    const environment =
      logicalId === "StagingDeployRole" ? "staging" : "production";
    const title =
      logicalId === "StagingDeployRole" ? "Staging" : "Production";
    assert.match(
      role,
      new RegExp(
        `Sid: Expand${title}ServerlessTransform[\\s\\S]*?` +
          "Action: cloudformation:CreateChangeSet[\\s\\S]*?" +
          "arn:\\$\\{AWS::Partition\\}:cloudformation:\\$\\{AWS::Region\\}:" +
          "aws:transform/Serverless-2016-10-31",
        "u"
      )
    );
    assert.match(
      role,
      new RegExp(
        `Sid: List${title}ArtifactNamespaces[\\s\\S]*?` +
          `s3:prefix:[\\s\\S]*?candidates/deployments/${environment}/\\*` +
          `[\\s\\S]*?candidates/recovery/${environment}/\\*`,
        "u"
      )
    );
    assert.match(role, /cloudformation:ContinueUpdateRollback/u);
    assert.doesNotMatch(
      role,
      /cloudformation:(?:CreateStack|UpdateStack)/u
    );
    assert.match(
      role,
      /Sid: InspectS3AccessLoggingFoundationStack[\s\S]*?Action: cloudformation:DescribeStacks[\s\S]*?stack\/\$\{AppName\}-delivery-bootstrap\/\*/u
    );
    assert.match(
      role,
      /Sid: InspectS3AccessLoggingFoundationRule[\s\S]*?Action: securityhub:BatchGetAutomationRules[\s\S]*?Resource: !GetAtt S3AccessLogArchiveS39Suppression\.RuleArn/u
    );
    assert.match(
      role,
      /Sid: AuditS3AccessLogArchive[\s\S]*?Action:\s+- s3:GetBucketLocation\s+- s3:GetBucketLogging\s+- s3:GetBucketOwnershipControls\s+- s3:GetBucketPolicy\s+- s3:GetBucketPublicAccessBlock\s+- s3:GetBucketVersioning\s+- s3:GetEncryptionConfiguration\s+- s3:GetLifecycleConfiguration\s+Resource: !GetAtt S3AccessLogArchive\.Arn/u
    );
    const executionPolicy = resourceBlock(
      `${title}CloudFormationResourcePolicy`
    );
    const executionRole = resourceBlock(`${title}ExecutionRole`);
    assert.doesNotMatch(role, /s3:(?:Get|Put)BucketAcl/u);
    assert.match(
      executionPolicy,
      new RegExp(
        `Sid: Manage${title}CloudFrontLoggingAcl[\\s\\S]*?` +
          "Action:\\s+- s3:GetBucketAcl\\s+- s3:PutBucketAcl\\s+" +
          "Resource: !GetAtt CloudFrontAccessLogBucket\\.Arn",
        "u",
      ),
    );
    assert.match(
      executionRole,
      new RegExp(
        `ManagedPolicyArns:[\\s\\S]*?- !Ref ${title}CloudFormationResourcePolicy`,
        "u"
      )
    );
    assert.match(
      role,
      new RegExp(
        `Action:\\s+- iam:PassRole\\s+Resource: !GetAtt ${title}ExecutionRole\\.Arn[\\s\\S]*?` +
          "iam:PassedToService: cloudformation\\.amazonaws\\.com",
        "u"
      )
    );
    assert.doesNotMatch(
      role,
      /securityhub:(?:Create|BatchUpdate|BatchDelete|ListAutomationRules)|cloudformation:(?:GetStackPolicy|SetStackPolicy)|s3:PutBucketLogging/u
    );
    assert.match(
      role,
      new RegExp(
        `Sid: DeleteFailed${title}GreenfieldRetainedLogs[\\s\\S]*?` +
          `log-group:/aws/apigateway/\\$\\{AppName\\}-${environment}"[\\s\\S]*?` +
          `log-group:/aws/vendedlogs/apigateway/\\$\\{AppName\\}-${environment}"[\\s\\S]*?` +
          `log-group:/aws/lambda/\\$\\{AppName\\}-${environment}-api"`,
        "u"
      )
    );
    assert.match(
      role,
      new RegExp(
        `Sid: InspectFailed${title}GreenfieldRetainedLogTags[\\s\\S]*?` +
          `log-group:/aws/apigateway/\\$\\{AppName\\}-${environment}"[\\s\\S]*?` +
          `log-group:/aws/lambda/\\$\\{AppName\\}-${environment}-api"`,
        "u"
      )
    );
    assert.match(
      role,
      new RegExp(
        `Sid: Publish${title}DeploymentArtifacts[\\s\\S]*?` +
          `candidates/deployments/${environment}/\\*`,
        "u"
      )
    );
    assert.match(
      role,
      new RegExp(
        `Sid: Manage${title}RecoveryArtifacts[\\s\\S]*?` +
          `candidates/recovery/${environment}/\\*`,
        "u"
      )
    );
    const oppositeEnvironment =
      environment === "staging" ? "production" : "staging";
    assert.doesNotMatch(
      role,
      new RegExp(
        `candidates/(?:deployments|recovery)/${oppositeEnvironment}/`,
        "u"
      )
    );
    assert.doesNotMatch(role, /ArtifactBucket\.Arn\}\/candidates\/\*/u);
    assert.doesNotMatch(role, legacyCandidatePath);
    assert.match(
      role,
      /Resource: !Sub "arn:\$\{AWS::Partition\}:cloudfront::\$\{AWS::AccountId\}:distribution\/\*"/u
    );
  }

  for (const environment of ["staging", "production"] as const) {
    const title = environment === "staging" ? "Staging" : "Production";
    const oppositeEnvironment =
      environment === "staging" ? "production" : "staging";
    for (const logicalId of [
      `${title}CodeDeployRole`,
      `${title}CloudFormationResourcePolicy`,
    ]) {
      const policy = resourceBlock(logicalId);
      assert.match(
        policy,
        new RegExp(
          `candidates/deployments/${environment}/\\*`,
          "u"
        )
      );
      assert.match(policy, legacyCandidatePath);
      assert.doesNotMatch(policy, /candidates\/recovery\//u);
      assert.doesNotMatch(
        policy,
        new RegExp(`candidates/deployments/${oppositeEnvironment}/`, "u")
      );
      assert.doesNotMatch(
        policy,
        /ArtifactBucket\.Arn\}\/candidates\/\*/u
      );
    }
  }
});

interface ProofFixture {
  mode?: "baseline" | "verify";
  parameter?: "false" | "true";
  stackStatus?: string;
  archiveAlgorithm?: string;
  archiveNewerNoncurrentVersions?: number;
  archiveLogging?: Record<string, unknown>;
  artifactLogging?: Record<string, unknown>;
  ruleControlId?: string;
  ruleName?: string;
  policyArtifactSource?: string;
  failCommand?: string;
}

function executable(path: string, content: string): void {
  writeFileSync(path, content, "utf8");
  chmodSync(path, 0o755);
}

function runProof(fixture: ProofFixture = {}) {
  const fakeBin = mkdtempSync(join(tmpdir(), "archon-s3-logging-proof-"));
  try {
    const mode = fixture.mode ?? "verify";
    const parameter =
      fixture.parameter ?? (mode === "baseline" ? "false" : "true");
    const archiveArn = `arn:aws:s3:::${ARCHIVE}`;
    const stack = {
      Stacks: [
        {
          StackName: `${APP}-delivery-bootstrap`,
          StackStatus: fixture.stackStatus ?? "UPDATE_COMPLETE",
          Parameters: [
            {
              ParameterKey: "ArtifactAccessLoggingEnabled",
              ParameterValue: parameter,
            },
          ],
          Outputs: [
            {
              OutputKey: "S3AccessLogArchiveName",
              OutputValue: ARCHIVE,
            },
            {
              OutputKey: "S3AccessLogArchiveArn",
              OutputValue: archiveArn,
            },
            {
              OutputKey: "S3AccessLogArchiveSuppressionRuleArn",
              OutputValue: RULE_ARN,
            },
          ],
        },
      ],
    };
    const policy = {
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "DenyInsecureTransport",
          Effect: "Deny",
          Principal: "*",
          Action: "s3:*",
          Resource: [archiveArn, `${archiveArn}/*`],
          Condition: { Bool: { "aws:SecureTransport": "false" } },
        },
        ...[
          {
            sid: "AllowArtifactBucketServerAccessLogs",
            prefix: "artifacts",
            source:
              fixture.policyArtifactSource ??
              `arn:aws:s3:::${ARTIFACT}`,
          },
          {
            sid: "AllowStagingWebBucketServerAccessLogs",
            prefix: "staging-web",
            source: `arn:aws:s3:::${APP}-staging-web-${ACCOUNT}-${REGION}`,
          },
          {
            sid: "AllowProductionWebBucketServerAccessLogs",
            prefix: "production-web",
            source: `arn:aws:s3:::${APP}-production-web-${ACCOUNT}-${REGION}`,
          },
        ].map(({ sid, prefix, source }) => ({
          Sid: sid,
          Effect: "Allow",
          Principal: { Service: "logging.s3.amazonaws.com" },
          Action: "s3:PutObject",
          Resource: `${archiveArn}/${prefix}/*`,
          Condition: {
            ArnEquals: { "aws:SourceArn": source },
            StringEquals: { "aws:SourceAccount": ACCOUNT },
          },
        })),
      ],
    };
    const criteria = Object.fromEntries(
      [
        ["AwsAccountId", ACCOUNT],
        [
          "ComplianceSecurityControlId",
          fixture.ruleControlId ?? "S3.9",
        ],
        ["ComplianceStatus", "FAILED"],
        [
          "ProductArn",
          `arn:aws:securityhub:${REGION}::product/aws/securityhub`,
        ],
        ["RecordState", "ACTIVE"],
        ["ResourceId", archiveArn],
        ["ResourceRegion", REGION],
        ["ResourceType", "AwsS3Bucket"],
      ].map(([key, value]) => [
        key,
        [{ Value: value, Comparison: "EQUALS" }],
      ])
    );
    const action = {
      Type: "FINDING_FIELDS_UPDATE",
      FindingFieldsUpdate: {
        Note: {
          Text:
            "Intentional exception: an S3 server-access-log destination must " +
            "not log to itself because that causes recursive log growth.",
          UpdatedBy: `${APP}-delivery-bootstrap`,
        },
        Workflow: { Status: "SUPPRESSED" },
      },
    };
    const exactArtifactLogging = {
      LoggingEnabled: {
        TargetBucket: ARCHIVE,
        TargetPrefix: "artifacts/",
        TargetObjectKeyFormat: {
          PartitionedPrefix: { PartitionDateSource: "EventTime" },
        },
      },
    };

    executable(
      join(fakeBin, "aws"),
      `#!/usr/bin/env bash
set -euo pipefail
if [ -n "\${FAKE_FAIL_COMMAND:-}" ] && [[ "$*" == *"$FAKE_FAIL_COMMAND"* ]]; then
  echo "AWS_SECRET_ACCESS_KEY=must-not-leak" >&2
  exit 254
fi
case "$*" in
  *"cloudformation describe-stacks"*) printf '%s\\n' "$FAKE_STACK" ;;
  *"s3api get-bucket-location"*) printf '%s\\n' "$FAKE_LOCATION" ;;
  *"s3api get-bucket-encryption"*) printf '%s\\n' "$FAKE_ENCRYPTION" ;;
  *"s3api get-bucket-ownership-controls"*) printf '%s\\n' "$FAKE_OWNERSHIP" ;;
  *"s3api get-public-access-block"*) printf '%s\\n' "$FAKE_PUBLIC_ACCESS" ;;
  *"s3api get-bucket-versioning"*) printf '%s\\n' "$FAKE_VERSIONING" ;;
  *"s3api get-bucket-lifecycle-configuration"*) printf '%s\\n' "$FAKE_LIFECYCLE" ;;
  *"s3api get-bucket-policy"*) printf '%s\\n' "$FAKE_POLICY" ;;
  *"s3api get-bucket-logging"*"$FAKE_ARCHIVE"*) printf '%s\\n' "$FAKE_ARCHIVE_LOGGING" ;;
  *"s3api get-bucket-logging"*"$FAKE_ARTIFACT"*) printf '%s\\n' "$FAKE_ARTIFACT_LOGGING" ;;
  *"securityhub batch-get-automation-rules"*) printf '%s\\n' "$FAKE_RULE" ;;
  *) echo "Unexpected aws invocation" >&2; exit 97 ;;
esac
`
    );

    return spawnSync("bash", [PROOF_SCRIPT, mode], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        APP_NAME: APP,
        AWS_ACCOUNT_ID: ACCOUNT,
        AWS_REGION: REGION,
        FAKE_FAIL_COMMAND: fixture.failCommand ?? "",
        FAKE_ARCHIVE: ARCHIVE,
        FAKE_ARTIFACT: ARTIFACT,
        FAKE_STACK: JSON.stringify(stack),
        FAKE_LOCATION: JSON.stringify({ LocationConstraint: REGION }),
        FAKE_ENCRYPTION: JSON.stringify({
          ServerSideEncryptionConfiguration: {
            Rules: [
              {
                ApplyServerSideEncryptionByDefault: {
                  SSEAlgorithm: fixture.archiveAlgorithm ?? "AES256",
                },
                BucketKeyEnabled: false,
              },
            ],
          },
        }),
        FAKE_OWNERSHIP: JSON.stringify({
          OwnershipControls: {
            Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }],
          },
        }),
        FAKE_PUBLIC_ACCESS: JSON.stringify({
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: true,
            IgnorePublicAcls: true,
            BlockPublicPolicy: true,
            RestrictPublicBuckets: true,
          },
        }),
        FAKE_VERSIONING: JSON.stringify({ Status: "Enabled" }),
        FAKE_LIFECYCLE: JSON.stringify({
          Rules: [
            {
              ID: "RetireServerAccessLogs",
              Filter: { Prefix: "" },
              Status: "Enabled",
              Expiration: { Days: 365 },
              NoncurrentVersionExpiration: {
                NoncurrentDays: 30,
                ...(fixture.archiveNewerNoncurrentVersions === undefined
                  ? {}
                  : {
                      NewerNoncurrentVersions:
                        fixture.archiveNewerNoncurrentVersions,
                    }),
              },
              AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
            },
          ],
        }),
        FAKE_POLICY: JSON.stringify({ Policy: JSON.stringify(policy) }),
        FAKE_ARCHIVE_LOGGING: JSON.stringify(
          fixture.archiveLogging ?? {}
        ),
        FAKE_ARTIFACT_LOGGING: JSON.stringify(
          fixture.artifactLogging ??
            (mode === "baseline" ? {} : exactArtifactLogging)
        ),
        FAKE_RULE: JSON.stringify({
          Rules: [
            {
              RuleArn: RULE_ARN,
              RuleName:
                fixture.ruleName ??
                `${APP}-intentional-s3-log-archive-s39`,
              RuleOrder: 1,
              RuleStatus: "ENABLED",
              IsTerminal: true,
              Criteria: criteria,
              Actions: [action],
            },
          ],
          UnprocessedAutomationRules: [],
        }),
      },
    });
  } finally {
    rmSync(fakeBin, { recursive: true, force: true });
  }
}

test("S3 access-logging proof accepts only the exact baseline and live state", () => {
  const baseline = runProof({ mode: "baseline" });
  assert.equal(baseline.status, 0, baseline.stderr);
  assert.equal(JSON.parse(baseline.stdout).artifact.loggingEnabled, false);

  const recoveredBaseline = runProof({
    mode: "baseline",
    stackStatus: "UPDATE_ROLLBACK_COMPLETE",
  });
  assert.equal(recoveredBaseline.status, 0, recoveredBaseline.stderr);
  assert.equal(
    JSON.parse(recoveredBaseline.stdout).stack.status,
    "UPDATE_ROLLBACK_COMPLETE"
  );

  const live = runProof({ mode: "verify" });
  assert.equal(live.status, 0, live.stderr);
  const receipt = JSON.parse(live.stdout);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.archive.selfLogging, false);
  assert.equal(receipt.artifact.partitionDateSource, "EventTime");
  assert.equal(receipt.artifact.targetMatchesArchive, true);
  assert.equal(receipt.securityHub.workflow, "SUPPRESSED");
  for (const digest of [
    receipt.stack.nameSha256,
    receipt.archive.bucketSha256,
    receipt.artifact.bucketSha256,
    receipt.artifact.targetBucketSha256,
    receipt.securityHub.ruleArnSha256,
  ]) {
    assert.match(digest, /^[0-9a-f]{64}$/u);
  }
  assert.doesNotMatch(live.stdout, new RegExp(ACCOUNT, "u"));
  assert.doesNotMatch(live.stdout, new RegExp(RULE_ARN, "u"));
});

test("S3 access-logging proof rejects drift and redacts AWS failures", () => {
  for (const fixture of [
    { archiveAlgorithm: "aws:kms" },
    { archiveNewerNoncurrentVersions: 1 },
    { archiveLogging: { LoggingEnabled: {} } },
    { artifactLogging: {} },
    { parameter: "false" },
    { stackStatus: "UPDATE_ROLLBACK_COMPLETE" },
    { ruleControlId: "S3.8" },
    { ruleName: "wrong-rule" },
    { policyArtifactSource: "arn:aws:s3:::wrong-source" },
  ] satisfies ProofFixture[]) {
    const result = runProof(fixture);
    assert.notEqual(result.status, 0, JSON.stringify(fixture));
  }

  const denied = runProof({ failCommand: "get-bucket-encryption" });
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /Unable to inspect/u);
  assert.doesNotMatch(denied.stderr, /must-not-leak|AWS_SECRET_ACCESS_KEY/u);
});

type ApplicationEnvironment = "staging" | "production";

interface ApplicationProofFixture {
  mode?: "preflight" | "validate-preflight" | "verify" | "recover";
  environment?: ApplicationEnvironment;
  expectedStackState?: "greenfield" | "existing";
  logging?: Record<string, unknown>;
  awsErrorCode?: string;
  cloudFormationErrorCommand?: "describe-stacks" | "get-template";
  foundationFails?: boolean;
  preflightContent?: string;
  processedTemplate?: Record<string, unknown>;
  stackAppName?: string;
  stackBucket?: string;
  stackCount?: number;
  stackEnvironment?: string;
  stackId?: string;
  stackName?: string;
  stackRoleArn?: string;
  stackStatus?: string;
}

function exactApplicationLogging(environment: ApplicationEnvironment) {
  return {
    LoggingEnabled: {
      TargetBucket: `${APP}-s3-access-logs-${ACCOUNT}-${REGION}`,
      TargetPrefix: `${environment}-web/`,
      TargetObjectKeyFormat: {
        PartitionedPrefix: {
          PartitionDateSource: "EventTime",
        },
      },
    },
  };
}

function applicationProcessedTemplate(
  prefixSub = '${Environment}-web/',
  destinationSub =
    '${AppName}-s3-access-logs-${AWS::AccountId}-${AWS::Region}'
): { TemplateBody: Record<string, unknown> | string } {
  return {
    TemplateBody: {
      Resources: {
        SpaBucket: {
          Type: "AWS::S3::Bucket",
          Properties: {
            LoggingConfiguration: {
              DestinationBucketName: {
                "Fn::Sub": destinationSub,
              },
              LogFilePrefix: {
                "Fn::Sub": prefixSub,
              },
              TargetObjectKeyFormat: {
                PartitionedPrefix: {
                  PartitionDateSource: "EventTime",
                },
              },
            },
          },
        },
      },
    },
  };
}

function runApplicationProof(fixture: ApplicationProofFixture = {}) {
  const fakeBin = mkdtempSync(
    join(tmpdir(), "archon-application-s3-logging-proof-")
  );
  try {
    const environment = fixture.environment ?? "staging";
    const sourceBucket =
      `${APP}-${environment}-web-${ACCOUNT}-${REGION}`;
    const stackName =
      fixture.stackName === undefined
        ? `${APP}-${environment}`
        : fixture.stackName;
    const stackId =
      fixture.stackId ??
      `arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/${stackName}/` +
        "11111111-2222-3333-4444-555555555555";
    const executionRoleArn =
      `arn:aws:iam::${ACCOUNT}:role/${APP}-${environment}-cloudformation`;
    const stackDescription = {
      StackId: stackId,
      StackName: stackName,
      RoleARN: fixture.stackRoleArn ?? executionRoleArn,
      StackStatus: fixture.stackStatus ?? "UPDATE_COMPLETE",
      Parameters: [
        {
          ParameterKey: "AppName",
          ParameterValue: fixture.stackAppName ?? APP,
        },
        {
          ParameterKey: "Environment",
          ParameterValue: fixture.stackEnvironment ?? environment,
        },
      ],
      Outputs: [
        {
          OutputKey: "SpaBucketName",
          OutputValue: fixture.stackBucket ?? sourceBucket,
        },
      ],
    };
    const stack = {
      Stacks: Array.from(
        { length: fixture.stackCount ?? 1 },
        () => ({
          ...stackDescription,
        })
      ),
    };
    const traceFile = join(fakeBin, "trace.log");
    writeFileSync(traceFile, "", "utf8");
    const preflightFile = join(fakeBin, "preflight.json");
    if (fixture.preflightContent !== undefined) {
      writeFileSync(preflightFile, fixture.preflightContent, "utf8");
    }

    executable(
      join(fakeBin, "bash"),
      `#!/bin/bash
set -euo pipefail
printf 'foundation:%s\\n' "$*" >>"\${FAKE_TRACE:?}"
if [ "$#" -eq 2 ] &&
    [ "$1" = "aws/prove-s3-access-logging.sh" ] &&
    [ "$2" = "verify" ]; then
  if [ "\${FAKE_FOUNDATION_FAIL:-false}" = "true" ]; then
    echo "AWS_SECRET_ACCESS_KEY=foundation-must-not-leak" >&2
    exit 42
  fi
  exit 0
fi
echo "Unexpected nested bash invocation" >&2
exit 98
`
    );
    executable(
      join(fakeBin, "aws"),
      `#!/bin/bash
set -euo pipefail
printf 'aws:%s\\n' "$*" >>"\${FAKE_TRACE:?}"
case "$*" in
  *"cloudformation describe-stacks"*)
    if [ "\${FAKE_CFN_ERROR_COMMAND:-}" = "describe-stacks" ]; then
      echo "An error occurred (AccessDenied) when calling DescribeStacks: AWS_SECRET_ACCESS_KEY=application-must-not-leak" >&2
      exit 254
    fi
    printf '%s\\n' "\${FAKE_APP_STACK:?}"
    ;;
  *"cloudformation get-template"*)
    if [ "\${FAKE_CFN_ERROR_COMMAND:-}" = "get-template" ]; then
      echo "An error occurred (AccessDenied) when calling GetTemplate: AWS_SECRET_ACCESS_KEY=application-must-not-leak" >&2
      exit 254
    fi
    printf '%s\\n' "\${FAKE_PROCESSED_TEMPLATE:?}"
    ;;
  *"s3api get-bucket-logging"*)
    if [ -n "\${FAKE_APP_ERROR_CODE:-}" ]; then
      echo "An error occurred (\${FAKE_APP_ERROR_CODE}) when calling GetBucketLogging: AWS_SECRET_ACCESS_KEY=application-must-not-leak" >&2
      exit 254
    fi
    printf '%s\\n' "\${FAKE_APP_LOGGING:?}"
    ;;
  *)
    echo "Unexpected aws invocation" >&2
    exit 97
    ;;
esac
`
    );

    const execution = spawnSync(
      "/bin/bash",
      [APPLICATION_PROOF_SCRIPT, fixture.mode ?? "preflight"],
      {
        cwd: ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          APP_NAME: APP,
          AWS_ACCOUNT_ID: ACCOUNT,
          AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN: executionRoleArn,
          AWS_REGION: REGION,
          ENVIRONMENT: environment,
          EXPECTED_STACK_STATE:
            fixture.expectedStackState ?? "existing",
          STACK_NAME: stackName,
          APPLICATION_S3_ACCESS_LOGGING_PREFLIGHT_FILE:
            fixture.preflightContent === undefined ? "" : preflightFile,
          FAKE_TRACE: traceFile,
          FAKE_FOUNDATION_FAIL: fixture.foundationFails ? "true" : "false",
          FAKE_APP_ERROR_CODE: fixture.awsErrorCode ?? "",
          FAKE_CFN_ERROR_COMMAND:
            fixture.cloudFormationErrorCommand ?? "",
          FAKE_APP_LOGGING: JSON.stringify(fixture.logging ?? {}),
          FAKE_APP_STACK: JSON.stringify(stack),
          FAKE_PROCESSED_TEMPLATE: JSON.stringify(
            fixture.processedTemplate ??
              applicationProcessedTemplate()
          ),
        },
      }
    );
    const trace = readFileSync(traceFile, "utf8")
      .trim()
      .split(/\r?\n/u)
      .filter(Boolean);
    return { process: execution, trace };
  } finally {
    rmSync(fakeBin, { recursive: true, force: true });
  }
}

test("application S3 logging proof has an exact integrity-bound contract", () => {
  for (const expected of [
    "preflight|validate-preflight|verify|recover",
    "bash aws/prove-s3-access-logging.sh verify",
    'AWS_REGION" != "eu-west-1',
    "staging|production",
    '${APP_NAME}-${ENVIRONMENT}-web-${AWS_ACCOUNT_ID}-${AWS_REGION}',
    '${APP_NAME}-s3-access-logs-${AWS_ACCOUNT_ID}-${AWS_REGION}',
    '${ENVIRONMENT}-web/',
    "TargetObjectKeyFormat",
    "PartitionedPrefix",
    'PartitionDateSource: "EventTime"',
    "APPLICATION_S3_ACCESS_LOGGING_PREFLIGHT_FILE",
    "EXPECTED_STACK_STATE",
    "NoSuchBucket",
    "jq-cS-v1",
    "sha256sum",
    "STACK_NAME",
    "AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN",
    "expected_stack_prefix",
    "stack_fingerprint",
    "cloudformation describe-stacks",
    "cloudformation get-template",
    "--template-stage Processed",
    "SpaBucketName",
    '${AppName}-s3-access-logs-${AWS::AccountId}-${AWS::Region}',
    '${Environment}-web/',
    "foundationVerified: true",
    ".foundationVerified == true",
    "processedTemplateManaged: true",
    "CREATE_COMPLETE",
    "UPDATE_COMPLETE",
    "fromjson",
  ]) {
    assert.ok(APPLICATION_PROOF_SOURCE.includes(expected), expected);
  }
  assert.equal(
    (
      APPLICATION_PROOF_SOURCE.match(
        /bash aws\/prove-s3-access-logging\.sh verify/gmu
      ) ?? []
    ).length,
    1
  );
  assert.ok(
    APPLICATION_PROOF_SOURCE.indexOf(
      "bash aws/prove-s3-access-logging.sh verify"
    ) < APPLICATION_PROOF_SOURCE.lastIndexOf('case "$mode" in')
  );
  assert.match(
    APPLICATION_PROOF_SOURCE,
    /s3api get-bucket-logging[\s\S]*?--expected-bucket-owner "\$AWS_ACCOUNT_ID"/u
  );
  assert.doesNotMatch(APPLICATION_PROOF_SOURCE, /head-bucket/u);
});

test("application logging workflow cross-binds stack state and immutable receipts", () => {
  for (const expected of [
    "EXPECTED_STACK_STATE: ${{ steps.api_preflight.outputs.stack_state }}",
    'echo "stack_state=$EXPECTED_STACK_STATE"',
    "id: application_s3_verify",
    "EXPECTED_PREFLIGHT_SHA256: ${{ steps.application_s3_preflight.outputs.receipt_sha256 }}",
    "EXPECTED_PROOF_SHA256: ${{ steps.application_s3_verify.outputs.receipt_sha256 }}",
    "sha256sum application-s3-access-logging-preflight.json",
    "sha256sum application-s3-access-logging-proof.json",
    '$stackState == "greenfield"',
    '$stackState == "existing"',
    "bash aws/prove-recovery-snapshot.sh",
    'validate-preflight >/dev/null',
    'GREENFIELD_OWNER="$GREENFIELD_OWNER"',
    'GREENFIELD_OWNER="$EXPECTED_GREENFIELD_OWNER"',
    "bash aws/merge-canonical-stack-tags.sh",
    "bash aws/serialize-sam-stack-tags.sh",
    "TARGET_STACK_TAGS_SHA256: ${{ steps.deploy.outputs.target_tags_sha256 }}",
    'post_sam_tags="${RUNNER_TEMP:?}',
    ".Stacks[0].StackId == $previousStackId",
    "terminalLiveReproved: true",
    'cmp --silent \\\n            application-s3-access-logging-proof.json',
  ]) {
    assert.ok(DEPLOY_WORKFLOW.includes(expected), expected);
  }
  assert.equal(
    (
      DEPLOY_WORKFLOW.match(
        /EXPECTED_STACK_STATE: \$\{\{ steps\.api_preflight\.outputs\.stack_state \}\}/gmu
      ) ?? []
    ).length,
    10
  );
  assert.equal(
    (DEPLOY_WORKFLOW.match(/id: application_s3_verify/gmu) ?? []).length,
    2
  );
  assert.equal(
    (
      DEPLOY_WORKFLOW.match(
        /EXPECTED_PROOF_SHA256: \$\{\{ steps\.application_s3_verify\.outputs\.receipt_sha256 \}\}/gmu
      ) ?? []
    ).length,
    2
  );
  assert.equal(
    (
      DEPLOY_WORKFLOW.match(
        /prove_application_s3_recovery\(\) \{[\s\S]*?sha256sum application-s3-access-logging-preflight\.json[\s\S]*?prove-application-s3-access-logging\.sh recover/gmu
      ) ?? []
    ).length,
    2
  );
  assert.equal(
    (
      DEPLOY_WORKFLOW.match(
        /bash aws\/prove-application-s3-access-logging\.sh verify/gmu
      ) ?? []
    ).length,
    4
  );
  assert.equal(
    (
      DEPLOY_WORKFLOW.match(
        /bash aws\/serialize-sam-stack-tags\.sh \\\r?\n\s+"\$target_tags" >"\$serialized_tags_file"/gmu
      ) ?? []
    ).length,
    2
  );
  assert.equal(
    (
      DEPLOY_WORKFLOW.match(
        /bash aws\/merge-canonical-stack-tags\.sh \\\r?\n\s+"\$prior_tags" >"\$target_tags"/gmu
      ) ?? []
    ).length,
    2
  );
  assert.equal(
    (
      DEPLOY_WORKFLOW.match(
        /TARGET_STACK_TAGS_SHA256: \$\{\{ steps\.deploy\.outputs\.target_tags_sha256 \}\}/gmu
      ) ?? []
    ).length,
    2
  );
  assert.equal(
    (
      DEPLOY_WORKFLOW.match(
        /post_sam_tags="\$\{RUNNER_TEMP:\?\}\/(?:staging|production)-tags-after-sam\.json"/gmu
      ) ?? []
    ).length,
    2
  );
  assert.equal(
    (
      DEPLOY_WORKFLOW.match(
        /bash aws\/prove-application-s3-access-logging\.sh \\\r?\n\s+validate-preflight/gmu
      ) ?? []
    ).length,
    2
  );
  assert.equal(
    (
      DEPLOY_WORKFLOW.match(
        /Build and validate sanitized (?:staging|production) deployment receipt/gmu
      ) ?? []
    ).length,
    2
  );
  for (const environment of ["staging", "production"]) {
    const terminal = DEPLOY_WORKFLOW.indexOf(
      `Build and validate sanitized ${environment} deployment receipt`
    );
    const recovery = DEPLOY_WORKFLOW.indexOf(
      `Refresh short-lived AWS credentials for ${environment} recovery`
    );
    const upload = DEPLOY_WORKFLOW.indexOf(
      `Upload ${environment} receipt`
    );
    assert.ok(terminal >= 0, `missing ${environment} terminal receipt`);
    assert.ok(
      recovery > terminal,
      `${environment} recovery must be armed after terminal validation`
    );
    assert.ok(
      upload > recovery,
      `${environment} receipt upload must follow recovery handlers`
    );
    const recoveryEnd = DEPLOY_WORKFLOW.indexOf(
      `Upload ${environment} receipt`,
      recovery
    );
    const recoveryBlock = DEPLOY_WORKFLOW.slice(recovery, recoveryEnd);
    const preflightValidation = recoveryBlock.indexOf("validate-preflight");
    const snapshotValidation = recoveryBlock.indexOf(
      "bash aws/prove-recovery-snapshot.sh"
    );
    const firstRecoveryMutation = recoveryBlock.indexOf("RECOVERY_FAILED=0");
    assert.ok(
      preflightValidation >= 0 &&
        firstRecoveryMutation >= 0 &&
        preflightValidation < firstRecoveryMutation,
      `${environment} must validate the preflight before recovery`
    );
    assert.ok(
      snapshotValidation >= 0 &&
        firstRecoveryMutation >= 0 &&
        snapshotValidation < firstRecoveryMutation,
      `${environment} must validate the recovery snapshot before mutation`
    );
  }
});

test("preflight validation is pure and rejects integrity tampering before AWS", () => {
  const preflight = runApplicationProof({
    mode: "preflight",
    logging: exactApplicationLogging("staging"),
  });
  assert.equal(preflight.process.status, 0, preflight.process.stderr);

  const validation = runApplicationProof({
    mode: "validate-preflight",
    preflightContent: preflight.process.stdout,
  });
  assert.equal(validation.process.status, 0, validation.process.stderr);
  assert.deepEqual(validation.trace, []);

  const tamperedReceipt = JSON.parse(preflight.process.stdout);
  tamperedReceipt.priorState = "disabled";
  const tampered = runApplicationProof({
    mode: "validate-preflight",
    preflightContent: JSON.stringify(tamperedReceipt),
  });
  assert.notEqual(tampered.process.status, 0);
  assert.deepEqual(tampered.trace, []);
});

test("recovery helpers bind immutable snapshots and greenfield ownership", () => {
  for (const expected of [
    "AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN",
    "CANDIDATE_SHA",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_ATTEMPT",
    "templateSha256",
    "parametersSha256",
    "tagsSha256",
    "stackRevision",
    "greenfieldOwner",
    "manifestSha256",
  ]) {
    assert.ok(RECOVERY_SNAPSHOT_SOURCE.includes(expected), expected);
  }
  const candidateBinding = RECOVERY_SNAPSHOT_SOURCE.indexOf(
    "--arg candidateSha"
  );
  const manifestHashing = RECOVERY_SNAPSHOT_SOURCE.indexOf("manifest_sha256=");
  assert.ok(candidateBinding >= 0);
  assert.ok(manifestHashing > candidateBinding);
  for (const expected of [
    "EXPECTED_PREVIOUS_STACK_ID",
    "EXPECTED_PREVIOUS_STACK_TEMPLATE_SHA256",
    "EXPECTED_PREVIOUS_STACK_PARAMETERS_SHA256",
    "EXPECTED_PREVIOUS_STACK_TAGS_SHA256",
    '--tags "file://${immutable_tags_file}"',
    ".Stacks[0].StackId == $stackId",
    ".Stacks[0].RoleARN == $role",
    'stack_target="$EXPECTED_PREVIOUS_STACK_ID"',
  ]) {
    assert.ok(STACK_RESTORE_SOURCE.includes(expected), expected);
  }
  const templateIntegrity = STACK_RESTORE_SOURCE.indexOf(
    'sha256sum "$immutable_template_file"'
  );
  const parameterIntegrity = STACK_RESTORE_SOURCE.indexOf(
    'sha256sum "$immutable_parameters_file"'
  );
  const tagIntegrity = STACK_RESTORE_SOURCE.indexOf(
    'sha256sum "$immutable_tags_file"'
  );
  const latestIntegrityCheck = Math.max(
    templateIntegrity,
    parameterIntegrity,
    tagIntegrity
  );
  const describeStack = STACK_RESTORE_SOURCE.indexOf(
    "cloudformation describe-stacks",
    latestIntegrityCheck
  );
  const createChangeSet = STACK_RESTORE_SOURCE.indexOf(
    "cloudformation create-change-set"
  );
  const executeChangeSet = STACK_RESTORE_SOURCE.indexOf(
    "cloudformation execute-change-set"
  );
  for (const integrityCheck of [
    templateIntegrity,
    parameterIntegrity,
    tagIntegrity,
  ]) {
    assert.ok(integrityCheck >= 0);
    assert.ok(integrityCheck < describeStack);
    assert.ok(integrityCheck < createChangeSet);
    assert.ok(integrityCheck < executeChangeSet);
  }
  assert.ok(describeStack >= 0);
  assert.ok(createChangeSet > describeStack);
  assert.ok(executeChangeSet > createChangeSet);
  for (const expected of [
    "GREENFIELD_OWNER",
    "ArchonGreenfieldOwner",
    ".EnableTerminationProtection == false",
    'result_state="greenfield-stack-absent"',
    '--stack-name "$stack_id"',
  ]) {
    assert.ok(GREENFIELD_CLEANUP_SOURCE.includes(expected), expected);
  }
  const cleanupDescribe = GREENFIELD_CLEANUP_SOURCE.indexOf(
    "cloudformation describe-stacks"
  );
  const cleanupDelete = GREENFIELD_CLEANUP_SOURCE.indexOf(
    "cloudformation delete-stack"
  );
  assert.ok(cleanupDescribe >= 0);
  assert.ok(cleanupDelete > cleanupDescribe);
  const cleanupOwnerProof = GREENFIELD_CLEANUP_SOURCE.indexOf(
    "ArchonGreenfieldOwner"
  );
  assert.ok(cleanupOwnerProof >= 0);
  assert.ok(cleanupOwnerProof < cleanupDelete);
});

test("application logging preflight accepts only absent, disabled, or exact enabled state", () => {
  for (const fixture of [
    {
      environment: "staging",
      awsErrorCode: "NoSuchBucket",
      priorState: "absent",
    },
    {
      environment: "staging",
      logging: {},
      priorState: "disabled",
    },
    {
      environment: "production",
      logging: exactApplicationLogging("production"),
      priorState: "enabled",
    },
  ] satisfies Array<
    ApplicationProofFixture & {
      environment: ApplicationEnvironment;
      priorState: "absent" | "disabled" | "enabled";
    }
  >) {
    const result = runApplicationProof({
      mode: "preflight",
      ...fixture,
    });
    assert.equal(result.process.status, 0, result.process.stderr);
    const receipt = JSON.parse(result.process.stdout);
    assert.equal(
      receipt.schema,
      "archon.application-s3-access-logging.preflight"
    );
    assert.equal(receipt.version, 1);
    assert.equal(receipt.mode, "preflight");
    assert.equal(receipt.foundationVerified, true);
    assert.equal(receipt.environment, fixture.environment);
    assert.equal(
      receipt.sourceBucket,
      `${APP}-${fixture.environment}-web-${ACCOUNT}-${REGION}`
    );
    assert.equal(receipt.destinationBucket, ARCHIVE);
    assert.equal(receipt.priorState, fixture.priorState);
    assert.deepEqual(
      receipt.expected,
      exactApplicationLogging(fixture.environment)
    );
    assert.deepEqual(
      {
        algorithm: receipt.integrity.algorithm,
        canonicalization: receipt.integrity.canonicalization,
      },
      {
        algorithm: "sha256",
        canonicalization: "jq-cS-v1",
      }
    );
    assert.match(receipt.integrity.payloadSha256, /^[0-9a-f]{64}$/u);
    assert.deepEqual(
      Object.keys(receipt).sort(),
      [
        "destinationBucket",
        "environment",
        "evidence",
        "expected",
        "foundationVerified",
        "integrity",
        "mode",
        "ok",
        "priorState",
        "schema",
        "sourceBucket",
        "version",
      ].sort()
    );
    assert.equal(
      result.trace[0],
      "foundation:aws/prove-s3-access-logging.sh verify"
    );
    assert.equal(result.trace.length, 2);
    assert.match(result.trace[1], /aws:s3api get-bucket-logging/u);
    assert.doesNotMatch(
      `${result.process.stdout}\n${result.process.stderr}`,
      /must-not-leak|AWS_SECRET_ACCESS_KEY/u
    );
  }

  for (const fixture of [
    { awsErrorCode: "NotFound" },
    { awsErrorCode: "NoSuchBucketPolicy" },
    {
      logging: {
        LoggingEnabled: {
          TargetBucket: ARCHIVE,
          TargetPrefix: "wrong/",
        },
      },
    },
  ] satisfies ApplicationProofFixture[]) {
    const result = runApplicationProof({ mode: "preflight", ...fixture });
    assert.notEqual(result.process.status, 0);
    assert.doesNotMatch(
      result.process.stderr,
      /NotFound|wrong|must-not-leak|AWS_SECRET_ACCESS_KEY/u
    );
  }
});

test("application logging verify binds the preflight and exact live configuration", () => {
  const preflight = runApplicationProof({
    mode: "preflight",
    environment: "staging",
    logging: {},
  });
  assert.equal(preflight.process.status, 0, preflight.process.stderr);

  const verified = runApplicationProof({
    mode: "verify",
    environment: "staging",
    logging: exactApplicationLogging("staging"),
    preflightContent: preflight.process.stdout,
  });
  assert.equal(verified.process.status, 0, verified.process.stderr);
  const proof = JSON.parse(verified.process.stdout);
  assert.equal(
    proof.schema,
    "archon.application-s3-access-logging.proof"
  );
  assert.equal(proof.mode, "verify");
  assert.equal(proof.foundationVerified, true);
  assert.equal(proof.processedTemplateManaged, true);
  assert.equal(proof.stackState, "existing");
  assert.equal(proof.stackStatus, "UPDATE_COMPLETE");
  assert.equal(proof.priorState, "disabled");
  assert.equal(proof.liveState, "enabled");
  assert.deepEqual(
    proof.liveConfiguration,
    exactApplicationLogging("staging")
  );
  assert.equal(
    proof.preflightIntegrity.payloadSha256,
    JSON.parse(preflight.process.stdout).integrity.payloadSha256
  );
  assert.deepEqual(verified.trace, [
    "foundation:aws/prove-s3-access-logging.sh verify",
    `aws:cloudformation describe-stacks --stack-name ${APP}-staging --region ${REGION} --output json`,
    `aws:cloudformation get-template --stack-name arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/${APP}-staging/11111111-2222-3333-4444-555555555555 --template-stage Processed --region ${REGION} --output json`,
    `aws:cloudformation describe-stacks --stack-name arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/${APP}-staging/11111111-2222-3333-4444-555555555555 --region ${REGION} --output json`,
    `aws:s3api get-bucket-logging --bucket ${APP}-staging-web-${ACCOUNT}-${REGION} --expected-bucket-owner ${ACCOUNT} --region ${REGION} --output json`,
  ]);

  const rollbackComplete = runApplicationProof({
    mode: "verify",
    environment: "staging",
    stackStatus: "UPDATE_ROLLBACK_COMPLETE",
    logging: exactApplicationLogging("staging"),
    preflightContent: preflight.process.stdout,
  });
  assert.equal(
    rollbackComplete.process.status,
    0,
    rollbackComplete.process.stderr
  );

  const stringTemplateBody = applicationProcessedTemplate();
  stringTemplateBody.TemplateBody = JSON.stringify(
    stringTemplateBody.TemplateBody
  );
  const verifiedStringTemplate = runApplicationProof({
    mode: "verify",
    environment: "staging",
    logging: exactApplicationLogging("staging"),
    preflightContent: preflight.process.stdout,
    processedTemplate: stringTemplateBody,
  });
  assert.equal(
    verifiedStringTemplate.process.status,
    0,
    verifiedStringTemplate.process.stderr
  );

  const greenfieldPreflight = runApplicationProof({
    mode: "preflight",
    environment: "staging",
    awsErrorCode: "NoSuchBucket",
  });
  assert.equal(
    greenfieldPreflight.process.status,
    0,
    greenfieldPreflight.process.stderr
  );
  const greenfieldVerified = runApplicationProof({
    mode: "verify",
    environment: "staging",
    expectedStackState: "greenfield",
    stackStatus: "CREATE_COMPLETE",
    logging: exactApplicationLogging("staging"),
    preflightContent: greenfieldPreflight.process.stdout,
  });
  assert.equal(
    greenfieldVerified.process.status,
    0,
    greenfieldVerified.process.stderr
  );
  assert.equal(
    JSON.parse(greenfieldVerified.process.stdout).stackState,
    "greenfield"
  );
  assert.equal(
    JSON.parse(greenfieldVerified.process.stdout).stackStatus,
    "CREATE_COMPLETE"
  );

  const tamperedReceipt = JSON.parse(preflight.process.stdout);
  tamperedReceipt.priorState = "enabled";
  const tampered = runApplicationProof({
    mode: "verify",
    logging: exactApplicationLogging("staging"),
    preflightContent: JSON.stringify(tamperedReceipt),
  });
  assert.notEqual(tampered.process.status, 0);
  assert.deepEqual(tampered.trace, [
    "foundation:aws/prove-s3-access-logging.sh verify",
  ]);

  const crossEnvironment = runApplicationProof({
    mode: "verify",
    environment: "production",
    logging: exactApplicationLogging("production"),
    preflightContent: preflight.process.stdout,
  });
  assert.notEqual(crossEnvironment.process.status, 0);

  const drifted = runApplicationProof({
    mode: "verify",
    logging: {
      LoggingEnabled: {
        ...exactApplicationLogging("staging").LoggingEnabled,
        TargetPrefix: "wrong/",
      },
    },
    preflightContent: preflight.process.stdout,
  });
  assert.notEqual(drifted.process.status, 0);

  for (const fixture of [
    { stackCount: 2 },
    { stackStatus: "UPDATE_ROLLBACK_FAILED" },
    { stackStatus: "CREATE_IN_PROGRESS" },
    {
      stackId:
        `arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/wrong-stack/` +
        "11111111-2222-3333-4444-555555555555",
    },
    { stackRoleArn: `arn:aws:iam::${ACCOUNT}:role/wrong-role` },
    { stackAppName: "wrong-application" },
    { stackEnvironment: "production" },
    { stackBucket: "wrong-source-bucket" },
  ] satisfies ApplicationProofFixture[]) {
    const stackDrift = runApplicationProof({
      mode: "verify",
      logging: exactApplicationLogging("staging"),
      preflightContent: preflight.process.stdout,
      ...fixture,
    });
    assert.notEqual(stackDrift.process.status, 0, JSON.stringify(fixture));
  }

  const templateDrift = runApplicationProof({
    mode: "verify",
    logging: exactApplicationLogging("staging"),
    preflightContent: preflight.process.stdout,
    processedTemplate: applicationProcessedTemplate("wrong-prefix/"),
  });
  assert.notEqual(templateDrift.process.status, 0);

  const greenfieldWithExistingBucket = runApplicationProof({
    mode: "verify",
    expectedStackState: "greenfield",
    stackStatus: "CREATE_COMPLETE",
    logging: exactApplicationLogging("staging"),
    preflightContent: preflight.process.stdout,
  });
  assert.notEqual(greenfieldWithExistingBucket.process.status, 0);

  const existingWithAbsentBucket = runApplicationProof({
    mode: "verify",
    expectedStackState: "existing",
    logging: exactApplicationLogging("staging"),
    preflightContent: greenfieldPreflight.process.stdout,
  });
  assert.notEqual(existingWithAbsentBucket.process.status, 0);

  const missingStackName = runApplicationProof({
    mode: "verify",
    logging: exactApplicationLogging("staging"),
    preflightContent: preflight.process.stdout,
    stackName: "",
  });
  assert.notEqual(missingStackName.process.status, 0);
  assert.deepEqual(missingStackName.trace, [
    "foundation:aws/prove-s3-access-logging.sh verify",
  ]);

  const denied = runApplicationProof({
    mode: "verify",
    awsErrorCode: "AccessDenied",
    preflightContent: preflight.process.stdout,
  });
  assert.notEqual(denied.process.status, 0);
  assert.doesNotMatch(
    denied.process.stderr,
    /AccessDenied|must-not-leak|AWS_SECRET_ACCESS_KEY/u
  );

  const cloudFormationDenied = runApplicationProof({
    mode: "verify",
    cloudFormationErrorCommand: "get-template",
    logging: exactApplicationLogging("staging"),
    preflightContent: preflight.process.stdout,
  });
  assert.notEqual(cloudFormationDenied.process.status, 0);
  assert.doesNotMatch(
    cloudFormationDenied.process.stderr,
    /AccessDenied|must-not-leak|AWS_SECRET_ACCESS_KEY/u
  );

  const foundationFailure = runApplicationProof({
    mode: "preflight",
    foundationFails: true,
  });
  assert.notEqual(foundationFailure.process.status, 0);
  assert.deepEqual(foundationFailure.trace, [
    "foundation:aws/prove-s3-access-logging.sh verify",
  ]);
  assert.doesNotMatch(
    foundationFailure.process.stderr,
    /must-not-leak|AWS_SECRET_ACCESS_KEY/u
  );
});

test("application logging recover proves the exact preflight state", () => {
  const scenarios = [
    {
      priorState: "absent",
      preflight: { awsErrorCode: "NoSuchBucket" },
      recovered: {
        awsErrorCode: "NoSuchBucket",
        expectedStackState: "greenfield",
      },
      restoredConfiguration: null,
      stackState: "greenfield",
    },
    {
      priorState: "disabled",
      preflight: { logging: {} },
      recovered: { logging: {} },
      restoredConfiguration: {},
      stackState: "existing",
    },
    {
      priorState: "enabled",
      preflight: { logging: exactApplicationLogging("staging") },
      recovered: { logging: exactApplicationLogging("staging") },
      restoredConfiguration: exactApplicationLogging("staging"),
      stackState: "existing",
    },
  ] satisfies Array<{
    priorState: "absent" | "disabled" | "enabled";
    preflight: ApplicationProofFixture;
    recovered: ApplicationProofFixture;
    restoredConfiguration: unknown;
    stackState: "greenfield" | "existing";
  }>;

  const receipts = new Map<string, string>();
  for (const scenario of scenarios) {
    const preflight = runApplicationProof({
      mode: "preflight",
      ...scenario.preflight,
    });
    assert.equal(preflight.process.status, 0, preflight.process.stderr);
    receipts.set(scenario.priorState, preflight.process.stdout);

    const recovered = runApplicationProof({
      mode: "recover",
      ...scenario.recovered,
      preflightContent: preflight.process.stdout,
    });
    assert.equal(recovered.process.status, 0, recovered.process.stderr);
    const receipt = JSON.parse(recovered.process.stdout);
    assert.equal(
      receipt.schema,
      "archon.application-s3-access-logging.recovery"
    );
    assert.equal(receipt.mode, "recover");
    assert.equal(receipt.foundationVerified, true);
    assert.equal(receipt.stackState, scenario.stackState);
    assert.equal(receipt.priorState, scenario.priorState);
    assert.equal(receipt.restoredState, scenario.priorState);
    assert.deepEqual(
      receipt.restoredConfiguration,
      scenario.restoredConfiguration
    );
    assert.equal(
      recovered.trace[0],
      "foundation:aws/prove-s3-access-logging.sh verify"
    );
    assert.equal(recovered.trace.length, 2);
    assert.match(recovered.trace[1], /aws:s3api get-bucket-logging/u);
  }

  const wrongRecovery = runApplicationProof({
    mode: "recover",
    expectedStackState: "greenfield",
    logging: {},
    preflightContent: receipts.get("absent"),
  });
  assert.notEqual(wrongRecovery.process.status, 0);

  const missingReceipt = runApplicationProof({
    mode: "recover",
    logging: {},
  });
  assert.notEqual(missingReceipt.process.status, 0);
  assert.deepEqual(missingReceipt.trace, [
    "foundation:aws/prove-s3-access-logging.sh verify",
  ]);
});
