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
const PROOF_SCRIPT = join(ROOT, "aws", "prove-s3-access-logging.sh");
const PROOF_SOURCE = readFileSync(PROOF_SCRIPT, "utf8");
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
    /Sid: ResolveExactFoundationAutomationRule[\s\S]*?Action: securityhub:ListTagsForResource\s+Resource: !GetAtt S3AccessLogArchiveS39Suppression\.RuleArn\s+Condition:\s+"ForAnyValue:StringEquals":\s+aws:CalledVia: cloudformation\.amazonaws\.com/u
  );
  assert.equal(
    (role.match(/Action: s3:PutBucketLogging/gmu) ?? []).length,
    1
  );
  assert.equal((role.match(/Action: iam:GetRole/gmu) ?? []).length, 1);
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
