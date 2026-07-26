import { spawnSync } from "node:child_process";
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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BOOTSTRAP = readFileSync(
  join(ROOT, "aws", "bootstrap-oidc.yaml"),
  "utf8"
);
const WORKFLOW = readFileSync(
  join(ROOT, ".github", "workflows", "bootstrap-aws.yml"),
  "utf8"
);
const DEPLOY_WORKFLOW = readFileSync(
  join(ROOT, ".github", "workflows", "deploy-aws.yml"),
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
});

test("S3 log delivery policy binds each source to only its own prefix", () => {
  const policy = resourceBlock("S3AccessLogArchivePolicy");
  assert.match(policy, /DeletionPolicy: RetainExceptOnCreate/u);
  assert.match(policy, /UpdateReplacePolicy: Retain/u);
  assert.equal(
    (policy.match(/Service: logging\.s3\.amazonaws\.com/gmu) ?? []).length,
    3
  );
  assert.equal((policy.match(/Action: s3:PutObject/gmu) ?? []).length, 3);
  assert.equal((policy.match(/aws:SourceAccount:/gmu) ?? []).length, 3);
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
  assert.doesNotMatch(policy, /s3:x-amz-acl|PutObjectAcl|TargetGrants/u);

  const artifact = resourceBlock("ArtifactBucket");
  assert.match(artifact, /DependsOn: S3AccessLogArchivePolicy/u);
  assert.match(
    artifact,
    /LoggingConfiguration: !If[\s\S]*?- EnableArtifactAccessLogging[\s\S]*?LogFilePrefix: artifacts\/[\s\S]*?PartitionDateSource: EventTime[\s\S]*?- !Ref AWS::NoValue/u
  );
});

test("foundation activation role and workflow are narrow and fail closed", () => {
  const role = resourceBlock("FoundationPromotionRole");
  for (const condition of [
    "token.actions.githubusercontent.com:aud: sts.amazonaws.com",
    "repo:${GitHubOrganization}/${GitHubRepository}:environment:bootstrap",
    "token.actions.githubusercontent.com:repository_id: !Ref GitHubRepositoryId",
    "token.actions.githubusercontent.com:repository_owner_id: !Ref GitHubRepositoryOwnerId",
    "token.actions.githubusercontent.com:ref: refs/heads/main",
    "token.actions.githubusercontent.com:environment: bootstrap",
    "token.actions.githubusercontent.com:workflow: Bootstrap AWS Foundation",
  ]) {
    assert.ok(role.includes(condition), condition);
  }
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
    /Sid: ResolveExactCloudFormationExecutionRoles[\s\S]*?Action: iam:GetRole\s+Resource:\s+- !Sub >-\s+arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:role\/\$\{AppName\}-staging-cloudformation\s+- !Sub >-\s+arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:role\/\$\{AppName\}-production-cloudformation\s+Condition:\s+"ForAnyValue:StringEquals":\s+aws:CalledVia: cloudformation\.amazonaws\.com/u
  );
  assert.match(
    role,
    /Sid: ResolveExactFoundationRoleAttributes[\s\S]*?Action: iam:GetRole\s+Resource:\s+- !Sub >-\s+arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:role\/\$\{AppName\}-staging-lambda-runtime\s+- !Sub >-\s+arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:role\/\$\{AppName\}-production-lambda-runtime\s+- !Sub >-\s+arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:role\/\$\{AppName\}-staging-codedeploy\s+- !Sub >-\s+arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:role\/\$\{AppName\}-production-codedeploy\s+- !Sub >-\s+arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:role\/\$\{AppName\}-github-database-operator\s+- !Sub >-\s+arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:role\/\$\{AppName\}-github-foundation-promotion\s+- !Sub >-\s+arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:role\/\$\{AppName\}-github-staging-deploy\s+- !Sub >-\s+arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:role\/\$\{AppName\}-github-production-deploy\s+Condition:\s+"ForAnyValue:StringEquals":\s+aws:CalledVia: cloudformation\.amazonaws\.com/u
  );
  assert.match(
    role,
    /Sid: ResolveExactFoundationAutomationRule[\s\S]*?Action: securityhub:ListTagsForResource\s+Resource: !GetAtt S3AccessLogArchiveS39Suppression\.RuleArn\s+Condition:\s+"ForAnyValue:StringEquals":\s+aws:CalledVia: cloudformation\.amazonaws\.com/u
  );
  assert.equal(
    (role.match(/Action: s3:PutBucketLogging/gmu) ?? []).length,
    1
  );
  assert.equal((role.match(/Action: iam:GetRole/gmu) ?? []).length, 2);
  assert.equal(
    (
      role.match(
        /arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:role\/\$\{AppName\}-[a-z-]+/gmu
      ) ?? []
    ).length,
    10
  );
  assert.equal(
    (role.match(/Action: securityhub:ListTagsForResource/gmu) ?? [])
      .length,
    1
  );
  assert.doesNotMatch(
    role,
    /iam:(?:Create|Delete|Update|Put|Attach|Detach|Pass|ListRoles|ListRolePolicies|GetRolePolicy|ListAttachedRolePolicies|ListRoleTags)|securityhub:(?:Create|BatchUpdate|BatchDelete|ListAutomationRules)|cloudformation:(?:DeleteStack|UpdateStack|SetStackPolicy)|role\/\*|automation-rule\/\*|Resource: "\*"/u
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
      "LogicalResourceId/ArtifactBucket",
      "LogicalResourceId/ArtifactBucketPolicy",
      "LogicalResourceId/FoundationPromotionRole",
      "LogicalResourceId/GitHubOidcProvider",
      "LogicalResourceId/S3AccessLogArchive",
      "LogicalResourceId/S3AccessLogArchivePolicy",
      "LogicalResourceId/S3AccessLogArchiveS39Suppression",
    ].sort()
  );
  assert.deepEqual(STACK_POLICY.Statement[1].Action, [
    "Update:Delete",
    "Update:Replace",
  ]);
});

test("environment deploy roles can prove but cannot mutate the logging foundation", () => {
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
  assert.equal(receipt.securityHub.workflow, "SUPPRESSED");
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
    'ArchonGreenfieldOwner=$GREENFIELD_OWNER',
    'GREENFIELD_OWNER="$EXPECTED_GREENFIELD_OWNER"',
    "bash aws/serialize-sam-stack-tags.sh",
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
    8
  );
  assert.equal(
    (
      DEPLOY_WORKFLOW.match(
        /bash aws\/serialize-sam-stack-tags\.sh \\\r?\n\s+previous-stack-tags\.json >"\$serialized_tags_file"/gmu
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
