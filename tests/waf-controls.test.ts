import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string): string =>
  readFileSync(join(root, path), "utf8");

test("CloudFront WAF IaC is explicit, bounded, and us-east-1 control-plane only", () => {
  const template = read("aws/edge-waf.yaml");
  assert.match(
    template,
    /CloudFrontWafControlPlaneRegion:[\s\S]*?Assert:\s*!Equals\s*\[!Ref "AWS::Region", us-east-1\]/u
  );
  assert.match(template, /Scope:\s*CLOUDFRONT/u);
  for (const group of [
    "AWSManagedRulesAmazonIpReputationList",
    "AWSManagedRulesKnownBadInputsRuleSet",
    "AWSManagedRulesCommonRuleSet",
  ]) {
    assert.match(template, new RegExp(`Name:\\s*${group}`, "u"));
  }
  assert.match(
    template,
    /Name:\s*ApiAggregateRate[\s\S]*?RateBasedStatement:[\s\S]*?EvaluationWindowSec:\s*300[\s\S]*?Limit:\s*!Ref ApiAggregateRateLimit[\s\S]*?SearchString:\s*\/api\//u
  );
  assert.match(
    template,
    /Name:\s*ResolutionCreateRate[\s\S]*?RateBasedStatement:[\s\S]*?Limit:\s*!Ref ResolutionCreateRateLimit[\s\S]*?SearchString:\s*\/api\/resolution\/session[\s\S]*?SearchString:\s*POST/u
  );
  assert.doesNotMatch(template, /us-west-2/iu);
  assert.match(
    template,
    /ApprovalBoundary[\s\S]*?explicit-live-activation-required/u
  );
  assert.match(
    template,
    /ArchonCloudFrontWebAcl:[\s\S]*?DeletionPolicy:\s*RetainExceptOnCreate[\s\S]*?UpdateReplacePolicy:\s*Retain/u
  );
  const stackPolicy = read("aws/edge-stack-policy.json");
  assert.match(stackPolicy, /LogicalResourceId\/ArchonCloudFrontWebAcl/u);
  assert.match(stackPolicy, /"Update:Delete"/u);
  assert.match(stackPolicy, /"Update:Replace"/u);
  for (const logicalId of [
    "ApiAggregateRateAlarm",
    "EdgeAlarmArchiveLogGroup",
    "EdgeAlarmArchiveLogPolicy",
    "EdgeAlarmStateEventRule",
    "ResolutionCreateRateAlarm",
    "WafBlockLogGroup",
    "WafBlockLoggingConfiguration",
    "WebAclBlockedRequestsAlarm",
  ]) {
    assert.match(
      stackPolicy,
      new RegExp(`LogicalResourceId/${logicalId}`, "u")
    );
  }
});

test("WAF evidence is BLOCK-only, redacted, service-encrypted, durable, and alarmed", () => {
  const template = read("aws/edge-waf.yaml");

  assert.equal(
    template.match(/SampledRequestsEnabled:\s*false/gu)?.length,
    6
  );
  assert.doesNotMatch(template, /SampledRequestsEnabled:\s*true/u);
  assert.match(
    template,
    /WafBlockLoggingConfiguration:[\s\S]*?Type:\s*AWS::WAFv2::LoggingConfiguration[\s\S]*?DefaultBehavior:\s*DROP[\s\S]*?Behavior:\s*KEEP[\s\S]*?Action:\s*BLOCK[\s\S]*?Requirement:\s*MEETS_ALL/u
  );
  assert.match(
    template,
    /LogGroupName:\s*!Sub "aws-waf-logs-\$\{AppName\}-\$\{Environment\}-blocked"[\s\S]*?RetentionInDays:\s*30/u
  );
  for (const field of [
    "authorization",
    "cookie",
    "referer",
    "x-api-key",
    "x-archon-origin-verify",
  ]) {
    assert.match(template, new RegExp(`Name:\\s*${field}`, "u"));
  }
  assert.match(template, /RedactedFields:[\s\S]*?QueryString:\s*\{\}/u);

  assert.doesNotMatch(
    template,
    /AWS::KMS::Key|AWS::KMS::Alias|AWS::SNS::Topic|AWS::SNS::Subscription|AWS::SQS::Queue|KmsKeyId|KmsMasterKeyId|SqsManagedSseEnabled/u
  );
  const logGroup =
    template.match(
      /  WafBlockLogGroup:[\s\S]*?(?=\n  WafBlockLoggingConfiguration:)/u
    )?.[0] ?? "";
  assert.match(logGroup, /LogGroupClass:\s*STANDARD/u);
  assert.doesNotMatch(logGroup, /KmsKeyId/u);
  const alarmArchiveLogGroup =
    template.match(
      /  EdgeAlarmArchiveLogGroup:[\s\S]*?(?=\n  EdgeAlarmArchiveLogPolicy:)/u
    )?.[0] ?? "";
  assert.match(alarmArchiveLogGroup, /Type:\s*AWS::Logs::LogGroup/u);
  assert.match(alarmArchiveLogGroup, /LogGroupClass:\s*STANDARD/u);
  assert.match(
    alarmArchiveLogGroup,
    /\/aws\/events\/\$\{AppName\}-\$\{Environment\}-edge-waf-alarm-archive/u
  );
  assert.match(alarmArchiveLogGroup, /RetentionInDays:\s*14/u);
  assert.doesNotMatch(alarmArchiveLogGroup, /KmsKeyId/u);

  const alarmArchiveLogPolicy =
    template.match(
      /  EdgeAlarmArchiveLogPolicy:[\s\S]*?(?=\n  EdgeAlarmStateEventRule:)/u
    )?.[0] ?? "";
  for (const expected of [
    "Type: AWS::Logs::ResourcePolicy",
    '"Sid": "AllowExactEventBridgeAlarmArchive"',
    '"delivery.logs.amazonaws.com"',
    '"events.amazonaws.com"',
    '"logs:CreateLogStream"',
    '"logs:PutLogEvents"',
    '"Resource": "arn:${AWS::Partition}:logs:us-east-1:${AWS::AccountId}:log-group:/aws/events/${AppName}-${Environment}-edge-waf-alarm-archive:*"',
    '"aws:SourceArn": "arn:${AWS::Partition}:events:us-east-1:${AWS::AccountId}:rule/${AppName}-${Environment}-edge-waf-alarm-events"',
    '"aws:SourceAccount": "${AWS::AccountId}"',
  ]) {
    assert.ok(alarmArchiveLogPolicy.includes(expected), expected);
  }

  const alarmEventRule =
    template.match(
      /  EdgeAlarmStateEventRule:[\s\S]*?(?=\n  ArchonCloudFrontWebAcl:)/u
    )?.[0] ?? "";
  assert.match(
    alarmEventRule,
    /Type:\s*AWS::Events::Rule[\s\S]*?source:[\s\S]*?- aws\.cloudwatch[\s\S]*?detail-type:[\s\S]*?- CloudWatch Alarm State Change[\s\S]*?resources:[\s\S]*?waf-any-block[\s\S]*?waf-api-rate-block[\s\S]*?waf-resolution-rate-block[\s\S]*?alarmName:[\s\S]*?waf-any-block[\s\S]*?waf-api-rate-block[\s\S]*?waf-resolution-rate-block[\s\S]*?value:[\s\S]*?- ALARM[\s\S]*?- OK/u
  );
  assert.match(
    alarmEventRule,
    /Targets:[\s\S]*?Arn:\s*!Sub\s*>-[\s\S]*?arn:\$\{AWS::Partition\}:logs:us-east-1:\$\{AWS::AccountId\}:log-group:\/aws\/events\/\$\{AppName\}-\$\{Environment\}-edge-waf-alarm-archive[\s\S]*?Id:\s*EdgeAlarmArchiveLogGroup/u
  );
  assert.doesNotMatch(alarmEventRule, /RoleArn:/u);

  const alarmSection = template.slice(
    template.indexOf("  WebAclBlockedRequestsAlarm:"),
    template.indexOf("Outputs:")
  );
  assert.equal(
    alarmSection.match(/Type:\s*AWS::CloudWatch::Alarm/gu)?.length,
    3
  );
  for (const alarmName of [
    "waf-any-block",
    "waf-api-rate-block",
    "waf-resolution-rate-block",
  ]) {
    assert.match(alarmSection, new RegExp(`AlarmName:.*${alarmName}`, "u"));
  }
  assert.equal(
    alarmSection.match(/MetricName:\s*BlockedRequests/gu)?.length,
    3
  );
  assert.equal(
    alarmSection.match(/TreatMissingData:\s*notBreaching/gu)?.length,
    3
  );
  assert.equal(alarmSection.match(/ActionsEnabled:\s*false/gu)?.length, 3);
  assert.doesNotMatch(alarmSection, /AlarmActions:|OKActions:/u);
  assert.doesNotMatch(alarmSection, /- Name:\s*Region/u);
});

test("regional stack conditionally binds a constrained WAF and a secret-backed origin verification", () => {
  const template = read("aws/template.yaml");
  const webAclParameter =
    template.match(
      /CloudFrontWebAclArn:\r?\n([\s\S]*?)\r?\nRules:/u
    )?.[1] ?? "";
  // Empty or a us-east-1 global WebACL ARN — nothing else. The empty default
  // exists so the stack can be created before the us-east-1 edge control plane
  // does; deploy-aws.yml still refuses to release without a real ARN.
  assert.match(
    webAclParameter,
    /AllowedPattern:\s*"\^\$\|\^arn:aws:wafv2:us-east-1:/u
  );
  assert.match(webAclParameter, /^ {4}Default: ""\r?$/mu);
  assert.doesNotMatch(template, /^\s{2}OriginVerifyToken:/mu);
  assert.doesNotMatch(template, /HasOriginVerifyToken/u);
  assert.match(
    template,
    /^  HasCloudFrontWebAcl: !Not \[!Equals \[!Ref CloudFrontWebAclArn, ""\]\]\r?$/mu
  );
  assert.match(
    template,
    /WebACLId:\s*!If \[HasCloudFrontWebAcl, !Ref CloudFrontWebAclArn, !Ref "AWS::NoValue"\]/u
  );
  assert.match(
    template,
    /HeaderName:\s*x-archon-origin-verify[\s\S]*?\{\{resolve:secretsmanager:\$\{AppName\}\/\$\{Environment\}\/origin-verification:SecretString:ORIGIN_VERIFY_TOKEN\}\}/u
  );
  assert.match(
    template,
    /ORIGIN_VERIFY_TOKEN:\s*!Sub[\s\S]*?\{\{resolve:secretsmanager:\$\{AppName\}\/\$\{Environment\}\/origin-verification:SecretString:ORIGIN_VERIFY_TOKEN\}\}/u
  );
  assert.match(
    template,
    /SpaBucket:[\s\S]*?KMSMasterKeyID:[\s\S]*?Fn::ImportValue:[\s\S]*?\$\{AppName\}-storage-kms-key-arn/u
  );
  assert.match(
    template,
    /DistributionConfig:[\s\S]*?Logging:[\s\S]*?\$\{AppName\}-cloudfront-access-logs-\$\{AWS::AccountId\}-\$\{AWS::Region\}\.s3\.amazonaws\.com/u
  );

  const deploy = read(".github/workflows/deploy-aws.yml");
  assert.equal((deploy.match(/edge-waf\.yaml/gmu) ?? []).length, 3);
  assert.equal(
    (deploy.match(/"aws\/edge-waf\.yaml"/gmu) ?? []).length,
    3
  );
  assert.doesNotMatch(
    deploy,
    /(?:--template-file|--template-body|--template-url)[^\r\n]*edge-waf\.yaml/u
  );
  assert.doesNotMatch(
    deploy,
    /CLOUDFRONT_WEB_ACL_ARN:\s*\$\{\{\s*vars\./u
  );
  assert.match(
    deploy,
    /Resolve the exact staging edge-stack handoff[\s\S]*?describe-stacks[\s\S]*?--region us-east-1[\s\S]*?Environment: "staging"/u
  );
  assert.match(
    deploy,
    /Resolve the exact production edge-stack handoff[\s\S]*?describe-stacks[\s\S]*?--region us-east-1[\s\S]*?Environment: "production"/u
  );
});

test("edge and foundation workflows preserve approval and authority boundaries", () => {
  const edge = read(".github/workflows/edge-controls.yml");
  assert.match(edge, /^name:\s*Manage AWS Edge Controls$/mu);
  assert.match(edge, /^\s{2}workflow_dispatch:/mu);
  assert.doesNotMatch(edge, /^\s{2}(push|pull_request|schedule):/mu);
  assert.match(
    edge,
    /(?:^|\r?\n)concurrency:\r?\n  group: aws-edge-controls\r?\n  cancel-in-progress: false\r?\n  queue: max/u
  );
  assert.match(
    edge,
    /environment:\s*\$\{\{ inputs\.operation == 'cleanup' && 'edge-cleanup' \|\| 'edge-controls' \}\}/u
  );
  assert.match(
    edge,
    /role-to-assume:[\s\S]*?inputs\.operation == 'cleanup'[\s\S]*?-github-edge-cleanup[\s\S]*?-github-edge-controls/u
  );
  assert.match(edge, /set-stack-policy/u);
  assert.match(edge, /update-termination-protection/u);
  assert.match(edge, /schemaVersion:\s*1/u);
  assert.match(edge, /changeSetArnSha256/u);
  assert.doesNotMatch(edge, /changeSet:\s*\{[\s\S]*?\bid:\s*\$changeSet/u);
  assert.match(
    edge,
    /Require exact non-replacement WAF evidence plan[\s\S]*?normalized_changes == \$expected\[0\]/u
  );
  for (const proofCommand of [
    "logs describe-log-groups",
    "logs describe-resource-policies",
    "wafv2 get-logging-configuration",
    "events describe-rule",
    "events list-targets-by-rule",
    "cloudwatch describe-alarms",
  ]) {
    assert.match(edge, new RegExp(proofCommand, "u"));
  }
  assert.match(edge, /alarmDeliveryDrill:\s*"not-run"/u);
  assert.match(
    edge,
    /humanPagingDestination:\s*"not-configured-by-this-stack"/u
  );
  assert.match(edge, /humanAcknowledgement:\s*"not-claimed"/u);
  assert.doesNotMatch(edge, /\bsqs\s+|receive-message|delete-message/iu);

  const bootstrap = read("aws/bootstrap-oidc.yaml");
  assert.match(
    bootstrap,
    /StagingOriginVerifySecret:\r?\n\s+Type: AWS::SecretsManager::Secret\r?\n\s+DependsOn: ApplicationStorageKeyAlias[\s\S]*?Name:\s*!Sub "\$\{AppName\}\/staging\/origin-verification"[\s\S]*?PasswordLength:\s*64/u
  );
  assert.match(
    bootstrap,
    /ProductionOriginVerifySecret:\r?\n\s+Type: AWS::SecretsManager::Secret\r?\n\s+DependsOn: ApplicationStorageKeyAlias[\s\S]*?Name:\s*!Sub "\$\{AppName\}\/production\/origin-verification"[\s\S]*?PasswordLength:\s*64/u
  );
  assert.match(
    bootstrap,
    /EdgeControlRole:[\s\S]*?environment:edge-controls[\s\S]*?workflow:\s*Manage AWS Edge Controls/u
  );
  assert.match(
    bootstrap,
    /EdgeCleanupRole:[\s\S]*?environment:edge-cleanup[\s\S]*?workflow:\s*Manage AWS Edge Controls/u
  );
  const edgeRole =
    bootstrap.match(/  EdgeControlRole:[\s\S]*?\n  EdgeCleanupRole:/u)?.[0] ?? "";
  const cleanupRole =
    bootstrap.match(/  EdgeCleanupRole:[\s\S]*?\n  FinOpsCloudFormationExecutionRole:/u)?.[0] ?? "";
  const expectedEdgePolicySids = [
    "CheckCloudFrontWebAclCapacity",
    "ConfigureOnlyCloudFormationEdgeLogDelivery",
    "DescribeOnlyUsEastOneEdgeLogs",
    "InspectExactCloudFrontWebAcls",
    "InspectOnlyNamedEdgeAlarmEventRules",
    "InspectOnlyNamedEdgeLogGroups",
    "InspectOnlyNamedEdgeWafAlarms",
    "ManageExactCloudFrontWebAcls",
    "ManageOnlyNamedEdgeAlarmEventRules",
    "ManageOnlyNamedEdgeLogGroups",
    "ManageOnlyNamedEdgeWafAlarms",
    "PlanAndApplyExactEdgeStacks",
    "PutOnlyExactEdgeAlarmEventRules",
    "PutTargetsOnlyExactEdgeAlarmArchives",
    "TagOnlyNamedEdgeLogGroups",
  ].sort();
  assert.deepEqual(
    [...edgeRole.matchAll(/^ {14}- Sid: ([A-Za-z0-9]+)\r?$/gmu)]
      .map((match) => match[1])
      .sort(),
    expectedEdgePolicySids
  );
  for (const permission of [
    "wafv2:PutLoggingConfiguration",
    "logs:CreateLogDelivery",
    "logs:PutResourcePolicy",
    "logs:DeleteResourcePolicy",
    "events:PutRule",
    "events:PutTargets",
    "cloudwatch:PutMetricAlarm",
  ]) {
    assert.match(edgeRole, new RegExp(permission, "u"));
  }
  assert.match(
    edgeRole,
    /aws:CalledVia:\s*cloudformation.amazonaws.com/u
  );
  assert.match(edgeRole, /aws:RequestedRegion:\s*us-east-1/u);
  const planAndApply =
    edgeRole.match(
      /- Sid: PlanAndApplyExactEdgeStacks[\s\S]*?(?=\n {14}- Sid: ManageExactCloudFrontWebAcls)/u
    )?.[0] ?? "";
  assert.deepEqual(
    [...planAndApply.matchAll(/^ {18}- (cloudformation:[A-Za-z]+)\r?$/gmu)]
      .map((match) => match[1])
      .sort(),
    [
      "cloudformation:CreateChangeSet",
      "cloudformation:DeleteChangeSet",
      "cloudformation:DescribeChangeSet",
      "cloudformation:DescribeStackEvents",
      "cloudformation:DescribeStacks",
      "cloudformation:ExecuteChangeSet",
      "cloudformation:GetStackPolicy",
      "cloudformation:GetTemplate",
      "cloudformation:ListStackResources",
      "cloudformation:SetStackPolicy",
      "cloudformation:UpdateTerminationProtection",
    ].sort()
  );
  assert.doesNotMatch(
    planAndApply,
    /cloudformation:(?:DeleteStack|ListChangeSets)/u
  );
  assert.doesNotMatch(edgeRole, /cloudformation:(?:DeleteStack|ListChangeSets)/u);
  assert.deepEqual(
    [...cleanupRole.matchAll(/^ {14}- Sid: ([A-Za-z0-9]+)\r?$/gmu)]
      .map((match) => match[1])
      .sort(),
    [
      "DeleteOnlyExactEdgeStacks",
      "InspectExactEdgeCleanupSources",
      "InspectExactEdgeCleanupStacks",
    ].sort()
  );
  for (const forbidden of [
    "CreateChangeSet",
    "DeleteChangeSet",
    "ExecuteChangeSet",
    "SetStackPolicy",
    "UpdateTerminationProtection",
    "iam:PassRole",
  ]) {
    assert.doesNotMatch(cleanupRole, new RegExp(forbidden, "u"));
  }
  assert.doesNotMatch(cleanupRole, /^\s+- sts:AssumeRole\s*$/mu);
  assert.match(cleanupRole, /cloudformation:DeleteStack/u);
  assert.match(cleanupRole, /cloudformation:ListChangeSets/u);
  assert.equal(cleanupRole.match(/changeSet\/edge-controls-\*\/\*/gu)?.length, 1);
  const manageLogGroups =
    edgeRole.match(
      /- Sid: ManageOnlyNamedEdgeLogGroups[\s\S]*?(?=\n {14}- Sid: TagOnlyNamedEdgeLogGroups)/u
    )?.[0] ?? "";
  assert.deepEqual(
    [...manageLogGroups.matchAll(/^ {18}- (logs:[A-Za-z]+)\r?$/gmu)]
      .map((match) => match[1])
      .sort(),
    [
      "logs:CreateLogGroup",
      "logs:DeleteLogGroup",
      "logs:DeleteRetentionPolicy",
      "logs:PutRetentionPolicy",
    ].sort()
  );
  const tagLogGroups =
    edgeRole.match(
      /- Sid: TagOnlyNamedEdgeLogGroups[\s\S]*?(?=\n {14}- Sid: InspectOnlyNamedEdgeLogGroups)/u
    )?.[0] ?? "";
  assert.deepEqual(
    [...tagLogGroups.matchAll(/^ {18}- (logs:[A-Za-z]+)\r?$/gmu)]
      .map((match) => match[1])
      .sort(),
    ["logs:TagResource", "logs:UntagResource"].sort()
  );
  assert.doesNotMatch(tagLogGroups, /:\*/u);

  for (const environment of ["staging", "production"]) {
    assert.match(
      edgeRole,
      new RegExp(`webacl/\\$\\{AppName\\}-${environment}-cloudfront/\\*`, "u")
    );
    for (const logGroupName of [
      `aws-waf-logs-\\$\\{AppName\\}-${environment}-blocked`,
      `/aws/events/\\$\\{AppName\\}-${environment}-edge-waf-alarm-archive`,
    ]) {
      assert.match(edgeRole, new RegExp(`log-group:${logGroupName}:\\*`, "u"));
      assert.match(
        edgeRole,
        new RegExp(`log-group:${logGroupName}(?:\\r?\\n|$)`, "u")
      );
    }
    assert.match(
      edgeRole,
      new RegExp(`rule/\\$\\{AppName\\}-${environment}-edge-waf-alarm-events`, "u")
    );
    for (const alarmName of [
      "waf-any-block",
      "waf-api-rate-block",
      "waf-resolution-rate-block",
    ]) {
      assert.match(
        edgeRole,
        new RegExp(
          `alarm:\\$\\{AppName\\}-${environment}-${alarmName}(?:\\r?\\n|$)`,
          "u"
        )
      );
    }
  }
  const putRule =
    edgeRole.match(
      /- Sid: PutOnlyExactEdgeAlarmEventRules[\s\S]*?(?=\n {14}- Sid: PutTargetsOnlyExactEdgeAlarmArchives)/u
    )?.[0] ?? "";
  assert.match(putRule, /Action:\s*events:PutRule/u);
  assert.match(
    putRule,
    /"ForAllValues:StringEquals":[\s\S]*?events:source:\s*aws\.cloudwatch[\s\S]*?events:detail-type:\s*CloudWatch Alarm State Change/u
  );
  assert.match(
    putRule,
    /"Null":[\s\S]*?events:source:\s*"false"[\s\S]*?events:detail-type:\s*"false"/u
  );
  assert.match(
    putRule,
    /"ForAnyValue:StringEquals":[\s\S]*?aws:CalledVia:\s*cloudformation\.amazonaws\.com/u
  );
  const putTargets =
    edgeRole.match(
      /- Sid: PutTargetsOnlyExactEdgeAlarmArchives[\s\S]*?(?=\n {14}- Sid: ManageOnlyNamedEdgeAlarmEventRules)/u
    )?.[0] ?? "";
  assert.match(putTargets, /Action:\s*events:PutTargets/u);
  assert.match(
    putTargets,
    /"ForAllValues:ArnEquals":[\s\S]*?events:TargetArn:/u
  );
  assert.match(putTargets, /"Null":[\s\S]*?events:TargetArn:\s*"false"/u);
  assert.match(
    putTargets,
    /"ForAnyValue:StringEquals":[\s\S]*?aws:CalledVia:\s*cloudformation\.amazonaws\.com/u
  );
  assert.doesNotMatch(
    edgeRole,
    /webacl\/\$\{AppName\}-\*|aws-waf-logs-\$\{AppName\}-\*|\/aws\/events\/\$\{AppName\}-\*|alarm:\$\{AppName\}-\*-waf-/u
  );
  assert.doesNotMatch(edgeRole, /(?:kms|sns|sqs):/u);

  const foundationProof = read("aws/prove-foundation-storage-controls.sh");
  assert.match(
    foundationProof,
    /\.PolicyDocument\.Statement \| length\) == 15/u
  );
  assert.match(foundationProof, /inlinePolicyStatementCount:\s*15/u);
  assert.match(foundationProof, /cleanupInlinePolicyStatementCount:\s*3/u);
  assert.match(foundationProof, /destructiveRoleSeparation:\s*true/u);
  assert.match(
    foundationProof,
    /exactEnvironmentScope:\s*\["staging", "production"\]/u
  );
  assert.match(foundationProof, /eventPatternConstrained:\s*true/u);
  assert.match(foundationProof, /eventTargetsConstrained:\s*true/u);
  assert.match(
    foundationProof,
    /cleanupStackScope:\s*"staging-production-only"/u
  );
  for (const sid of expectedEdgePolicySids) {
    assert.match(foundationProof, new RegExp(`"${sid}"`, "u"));
  }
  assert.match(
    foundationProof,
    /statement\("DeleteOnlyExactEdgeStacks"\)[\s\S]*?cloudformation:DeleteStack[\s\S]*?edge_stacks/u
  );
  assert.match(
    foundationProof,
    /statement\("ManageExactCloudFrontWebAcls"\)[\s\S]*?web_acls/u
  );
  assert.match(
    foundationProof,
    /statement\("InspectExactCloudFrontWebAcls"\)[\s\S]*?web_acls/u
  );
  assert.match(
    foundationProof,
    /statement\("ManageOnlyNamedEdgeLogGroups"\)[\s\S]*?log_groups_iam/u
  );
  assert.match(
    foundationProof,
    /statement\("TagOnlyNamedEdgeLogGroups"\)[\s\S]*?log_groups_tag/u
  );
  assert.match(
    foundationProof,
    /statement\("PutOnlyExactEdgeAlarmEventRules"\)[\s\S]*?"events:PutRule"[\s\S]*?"events:source": "aws\.cloudwatch"[\s\S]*?"events:detail-type": "CloudWatch Alarm State Change"[\s\S]*?"events:source": "false"[\s\S]*?"events:detail-type": "false"/u
  );
  assert.match(
    foundationProof,
    /statement\("PutTargetsOnlyExactEdgeAlarmArchives"\)[\s\S]*?"events:PutTargets"[\s\S]*?"ForAllValues:ArnEquals"[\s\S]*?alarm_archives[\s\S]*?"events:TargetArn"\] == "false"/u
  );
  assert.match(
    foundationProof,
    /statement\("ManageOnlyNamedEdgeWafAlarms"\)[\s\S]*?waf_alarms/u
  );
  assert.match(
    foundationProof,
    /statement\("InspectOnlyNamedEdgeWafAlarms"\)[\s\S]*?waf_alarms/u
  );
  assert.doesNotMatch(
    foundationProof,
    /global\/webacl\/" \+ \$app \+ "-\*|log-group:aws-waf-logs-" \+ \$app \+ "-\*|:alarm:" \+ \$app \+ "-\*-waf-/u
  );
});

test("edge cleanup and finalize lifecycle is source-bound and restart-safe", () => {
  const edge = read(".github/workflows/edge-controls.yml");
  assert.match(
    edge,
    /options:\r?\n\s+- plan\r?\n\s+- apply\r?\n\s+- verify\r?\n\s+- cleanup\r?\n\s+- finalize/u
  );
  assert.match(edge, /deployed_sha:[\s\S]*?accepted only by finalize/u);
  assert.match(
    edge,
    /if \[ -n "\$DEPLOYED_SHA" \]; then[\s\S]*?test "\$OPERATION" = "finalize"[\s\S]*?\[\[ "\$DEPLOYED_SHA" =~ \^\[0-9a-f\]\{40\}\$ \]\]/u
  );
  assert.match(
    edge,
    /gh api --paginate --slurp[\s\S]*?head_sha=\$\{sha\}[\s\S]*?\.\[\]\.workflow_runs\[\][\s\S]*?prove_green_sha "\$DEPLOYED_SHA"/u
  );

  const authorization =
    edge.match(
      /case "\$OPERATION" in[\s\S]*?(?=\n\s+git fetch --no-tags --depth=1 origin main)/u
    )?.[0] ?? "";
  for (const [operation, confirmation] of [
    ["apply", "APPLY-\\$\\{environment_upper\\}-EDGE-CONTROLS"],
    ["cleanup", "CLEANUP-\\$\\{environment_upper\\}-EDGE-CONTROLS"],
    ["finalize", "FINALIZE-\\$\\{environment_upper\\}-EDGE-CONTROLS"],
  ]) {
    assert.match(
      authorization,
      new RegExp(
        `${operation}\\)[\\s\\S]*?expected_confirmation="${confirmation}"[\\s\\S]*?test "\\$CONFIRMATION" = "\\$expected_confirmation"`,
        "u"
      )
    );
  }
  assert.match(
    authorization,
    /plan\|verify\)[\s\S]*?test -z "\$CONFIRMATION"/u
  );
  assert.match(
    edge,
    /environment_upper="\$\([\s\S]*?tr '\[:lower:\]' '\[:upper:\]' <<<"\$EDGE_ENVIRONMENT"[\s\S]*?\)"/u
  );

  const inspectState =
    edge.match(
      /      - name: Inspect current edge stack state[\s\S]*?(?=\n      - name: Clean up exact recoverable edge shell)/u
    )?.[0] ?? "";
  assert.match(
    inspectState,
    /CREATE_COMPLETE\|UPDATE_COMPLETE\|UPDATE_ROLLBACK_COMPLETE\)[\s\S]*?test "\$OPERATION" != "cleanup"/u
  );
  assert.match(
    inspectState,
    /REVIEW_IN_PROGRESS\)[\s\S]*?case "\$OPERATION" in[\s\S]*?apply\|cleanup\)[\s\S]*?\.Stacks\[0\]\.EnableTerminationProtection == false[\s\S]*?EDGE_CLEANUP_PRIOR_STATUS=REVIEW_IN_PROGRESS/u
  );
  const pendingApply =
    inspectState.match(
      /# A CREATE change set materializes a shell stack[\s\S]*?EDGE_APPLY_MODE=execute/u
    )?.[0] ?? "";
  assert.match(
    pendingApply,
    /test "\$GITHUB_SHA" = "\$TARGET_SHA"[\s\S]*?git rev-parse HEAD[\s\S]*?= "\$TARGET_SHA"[\s\S]*?expected_change_set="edge-controls-\$\{EDGE_ENVIRONMENT\}-\$\{TARGET_SHA:0:12\}-\$\{EDGE_TEMPLATE_DIGEST:0:12\}"[\s\S]*?test "\$CHANGE_SET_NAME" = "\$expected_change_set"/u
  );
  assert.match(
    pendingApply,
    /describe-change-set[\s\S]*?--change-set-name "\$CHANGE_SET_NAME"[\s\S]*?get-template[\s\S]*?--change-set-name "\$CHANGE_SET_NAME"[\s\S]*?sha256sum "\$pending_template"[\s\S]*?"\$EDGE_TEMPLATE_DIGEST"/u
  );
  assert.match(
    pendingApply,
    /\.ChangeSetName == \$changeSetName[\s\S]*?\.ChangeSetId == \([\s\S]*?:changeSet\/[\s\S]*?\.StackId == \$stackId[\s\S]*?\.Description == \$description[\s\S]*?\.ChangeSetType == "CREATE"[\s\S]*?\.Status == "CREATE_COMPLETE"[\s\S]*?\.ExecutionStatus == "AVAILABLE"/u
  );
  assert.match(
    pendingApply,
    /\.RoleARN == null[\s\S]*?\.Capabilities \/\/ \[\]\) == \[\][\s\S]*?\.NotificationARNs == \[\][\s\S]*?\.RollbackConfiguration == \{\}[\s\S]*?\.IncludeNestedStacks \/\/ false\) == false[\s\S]*?\.ImportExistingResources \/\/ false\) == false[\s\S]*?\.Tags \/\/ \[\]\) == \[\]/u
  );
  assert.match(
    pendingApply,
    /\.Parameters \| parameter_map\) == \{[\s\S]*?AppName: \$app[\s\S]*?Environment: \$environment[\s\S]*?ApiAggregateRateLimit: "1000"[\s\S]*?ResolutionCreateRateLimit: "100"/u
  );
  assert.match(
    pendingApply,
    /\.Stacks\[0\]\.StackId == \$stackId[\s\S]*?\.Stacks\[0\]\.StackStatus == "REVIEW_IN_PROGRESS"[\s\S]*?\.Stacks\[0\]\.RoleARN \/\/ null\) == null[\s\S]*?EnableTerminationProtection == false[\s\S]*?\.Stacks\[0\]\.Tags \/\/ \[\]\) == \[\][\s\S]*?EDGE_STACK_EXISTS=false[\s\S]*?CHANGE_SET_TYPE=CREATE[\s\S]*?EDGE_APPLY_MODE=execute/u
  );
  assert.match(
    inspectState,
    /ROLLBACK_COMPLETE\)[\s\S]*?test "\$OPERATION" = "cleanup"[\s\S]*?\.Stacks\[0\]\.EnableTerminationProtection == false[\s\S]*?EDGE_CLEANUP_PRIOR_STATUS=ROLLBACK_COMPLETE/u
  );
  assert.match(
    inspectState,
    /grep -Fq "does not exist" "\$error"[\s\S]*?case "\$OPERATION" in[\s\S]*?plan\|apply\)[\s\S]*?\*\) exit 1/u
  );

  const completeState =
    inspectState.match(
      /CREATE_COMPLETE\|UPDATE_COMPLETE\|UPDATE_ROLLBACK_COMPLETE\)[\s\S]*?(?=\n {14}REVIEW_IN_PROGRESS\))/u
    )?.[0] ?? "";
  assert.match(
    completeState,
    /if \[ "\$OPERATION" = "finalize" \] \|\| \{[\s\S]*?\[ "\$OPERATION" = "apply" \][\s\S]*?\[ "\$live_template_digest" = "\$EDGE_TEMPLATE_DIGEST" \]/u
  );
  assert.match(
    completeState,
    /test "\$live_template_digest" =[\s\S]*?"\$EDGE_PROTECTION_TEMPLATE_DIGEST"[\s\S]*?if \[ "\$OPERATION" = "apply" \][\s\S]*?EDGE_APPLY_MODE=finalize/u
  );
  assert.match(
    completeState,
    /\.Stacks\[0\]\.EnableTerminationProtection == true[\s\S]*?get-stack-policy[\s\S]*?\(\.StackPolicyBody \| fromjson\) == \$expected\[0\][\s\S]*?EDGE_APPLY_MODE=execute/u
  );

  const cleanupStep =
    edge.match(
      /      - name: Clean up exact recoverable edge shell[\s\S]*?(?=\n      - name: Create or reuse exact edge plan)/u
    )?.[0] ?? "";
  assert.match(cleanupStep, /if: inputs\.operation == 'cleanup'/u);
  assert.match(
    cleanupStep,
    /\.Stacks\[0\]\.StackId == \$stackId[\s\S]*?\.Stacks\[0\]\.StackStatus == \$priorStatus[\s\S]*?\$priorStatus == "REVIEW_IN_PROGRESS"[\s\S]*?\$priorStatus == "ROLLBACK_COMPLETE"/u
  );
  assert.match(
    cleanupStep,
    /\.Stacks\[0\]\.RoleARN \/\/ null\) == null[\s\S]*?EnableTerminationProtection == false[\s\S]*?\.Stacks\[0\]\.Tags \/\/ \[\]\) == \[\][\s\S]*?\.Stacks\[0\]\.NotificationARNs \/\/ \[\]\) == \[\][\s\S]*?\.Stacks\[0\]\.Capabilities \/\/ \[\]\) == \[\]/u
  );
  assert.match(
    cleanupStep,
    /\.Stacks\[0\]\.Parameters \| parameter_map\) == \{[\s\S]*?AppName: \$app[\s\S]*?Environment: \$environment[\s\S]*?ApiAggregateRateLimit: "1000"[\s\S]*?ResolutionCreateRateLimit: "100"/u
  );
  assert.match(
    cleanupStep,
    /if \$priorStatus == "REVIEW_IN_PROGRESS"[\s\S]*?\.StackResourceSummaries \| length\) == 0[\s\S]*?else \$priorStatus == "ROLLBACK_COMPLETE"[\s\S]*?all\([\s\S]*?\.StackResourceSummaries\[\];[\s\S]*?\.ResourceStatus == "DELETE_COMPLETE"/u
  );
  assert.match(
    cleanupStep,
    /list-change-sets[\s\S]*?\.Summaries \| length\) == 1[\s\S]*?\.StackId == \$stackId[\s\S]*?\^edge-controls-[\s\S]*?\[0-9a-f\]\{12\}[\s\S]*?ImportExistingResources \/\/ false\) == false/u
  );
  assert.match(
    cleanupStep,
    /capture\([\s\S]*?commit=\(\?<commit>\[0-9a-f\]\{40\}\)[\s\S]*?template_sha256=\(\?<digest>\[0-9a-f\]\{64\}\)\$[\s\S]*?\.ChangeSetName == \([\s\S]*?\$source\.commit\[0:12\][\s\S]*?\$source\.digest\[0:12\]/u
  );
  assert.match(
    cleanupStep,
    /\.ChangeSetId == \([\s\S]*?:changeSet\/[\s\S]*?\.ChangeSetName[\s\S]*?\.StackName == \$stack[\s\S]*?\.StackId == \$stackId[\s\S]*?\.ChangeSetType == "CREATE"/u
  );
  assert.match(
    cleanupStep,
    /if \$priorStatus == "REVIEW_IN_PROGRESS"[\s\S]*?\.Status == "CREATE_COMPLETE"[\s\S]*?\.ExecutionStatus == "AVAILABLE"[\s\S]*?else \([\s\S]*?\.Status == "CREATE_COMPLETE"[\s\S]*?\.Status == "DELETE_COMPLETE"[\s\S]*?\.ExecutionStatus == "EXECUTE_COMPLETE"[\s\S]*?\.ExecutionStatus == "EXECUTE_FAILED"[\s\S]*?\.ExecutionStatus == "UNAVAILABLE"/u
  );
  assert.match(
    cleanupStep,
    /normalized_changes == \([\s\S]*?logicalResourceId: "ArchonCloudFrontWebAcl"[\s\S]*?logicalResourceId: "EdgeAlarmStateEventRule"[\s\S]*?logicalResourceId: "WafBlockLoggingConfiguration"[\s\S]*?all\([\s\S]*?\.Action == "Add"[\s\S]*?\.Replacement == null/u
  );
  assert.match(
    cleanupStep,
    /git fetch --no-tags --depth=1 origin "\$cleanup_source_commit"[\s\S]*?git rev-parse FETCH_HEAD[\s\S]*?"\$\{cleanup_source_commit\}:aws\/edge-waf\.yaml"[\s\S]*?sha256sum "\$cleanup_source_template"[\s\S]*?"\$cleanup_source_template_digest"/u
  );
  const cleanupTemplateSelection =
    cleanupStep.match(
      /if \[ "\$EDGE_CLEANUP_PRIOR_STATUS" = "REVIEW_IN_PROGRESS" \]; then[\s\S]*?\n          fi/u
    )?.[0] ?? "";
  assert.match(
    cleanupTemplateSelection,
    /get-template[\s\S]*?--stack-name "\$EDGE_STACK_NAME"[\s\S]*?--change-set-name "\$cleanup_change_set_id"[\s\S]*?--template-stage Original[\s\S]*?else[\s\S]*?get-template[\s\S]*?--stack-name "\$EDGE_STACK_NAME"[\s\S]*?--template-stage Original/u
  );
  assert.match(
    cleanupStep,
    /sha256sum "\$cleanup_template"[\s\S]*?"\$cleanup_source_template_digest"[\s\S]*?cleanup_template_bound=true/u
  );
  assert.match(
    cleanupStep,
    /git fetch --no-tags --depth=1 origin main[\s\S]*?git rev-parse origin\/main[\s\S]*?= "\$TARGET_SHA"/u
  );
  assert.match(
    cleanupStep,
    /git fetch --no-tags --depth=1 origin main[\s\S]*?git rev-parse origin\/main[\s\S]*?final_stack=[\s\S]*?describe-stacks[\s\S]*?--stack-name "\$stack_id"[\s\S]*?final_resources[\s\S]*?final_change_sets[\s\S]*?final_change_set[\s\S]*?final_template_response[\s\S]*?cleanup_final_revalidation=true[\s\S]*?delete-stack/u
  );
  const finalRevalidationToDelete =
    cleanupStep.match(
      /cleanup_final_revalidation=true[\s\S]*?(?=\n          aws cloudformation delete-stack)/u
    )?.[0] ?? "";
  assert.doesNotMatch(finalRevalidationToDelete, /\b(?:aws|git)\s/u);

  const cleanupDelete =
    cleanupStep.match(
      /aws cloudformation delete-stack[\s\S]*?--region "\$AWS_REGION"/u
    )?.[0] ?? "";
  assert.match(cleanupDelete, /--stack-name "\$stack_id"/u);
  assert.match(
    cleanupDelete,
    /--client-request-token "\$cleanup_token"/u
  );
  assert.doesNotMatch(cleanupDelete, /--stack-name "\$EDGE_STACK_NAME"/u);
  assert.match(
    cleanupStep,
    /deleted=false[\s\S]*?describe-stacks[\s\S]*?\.Stacks\[0\]\.StackId == \$stackId[\s\S]*?StackStatus == "DELETE_IN_PROGRESS"[\s\S]*?StackStatus == "DELETE_COMPLETE"[\s\S]*?grep -Fq "ValidationError"[\s\S]*?grep -Fq "does not exist"[\s\S]*?deleted=true[\s\S]*?test "\$deleted" = "true"/u
  );

  const cleanupReceipt =
    cleanupStep.match(
      /receipt_next="\$\{RUNNER_TEMP:\?\}\/edge-cleanup-receipt\.json"[\s\S]*?mv "\$receipt_next" "\$RECEIPT_FILE"/u
    )?.[0] ?? "";
  for (const receiptClaim of [
    "clientRequestTokenSha256: $cleanupTokenSha256",
    "stackIdSha256: $stackIdSha256",
    "sourceCommit: $sourceCommit",
    "sourceTemplateSha256: $sourceTemplateSha256",
    "sourceChangeSetName: $sourceChangeSetName",
    "sourceRepositoryCommitBound: true",
    "exactAccountRegionAndName: true",
    "terminationProtection: false",
    "stackTags: []",
    "importedResources: false",
    "resourceCount: $resourceCount",
    "changeSetMetadataBound: $changeSetBound",
    "templateBound: $templateBound",
    "finalPreDeleteRevalidation: $finalRevalidation",
    "stackDeletedAndNotFound: true",
  ]) {
    assert.ok(cleanupReceipt.includes(receiptClaim), receiptClaim);
  }
  assert.doesNotMatch(
    cleanupReceipt,
    /clientRequestToken:\s*\$cleanupToken|stackId:\s*\$stackId|changeSetId:|changeSetArn:/u
  );
  assert.match(
    cleanupReceipt,
    /allListedResourcesDeleteComplete:\s*\([\s\S]*?if \$priorStatus == "ROLLBACK_COMPLETE"[\s\S]*?then true[\s\S]*?else null/u
  );

  const createPlan =
    edge.match(
      /      - name: Create or reuse exact edge plan[\s\S]*?(?=\n      - name: Load exact existing edge plan)/u
    )?.[0] ?? "";
  const loadPlan =
    edge.match(
      /      - name: Load exact existing edge plan[\s\S]*?(?=\n      - name: Require exact non-replacement WAF evidence plan)/u
    )?.[0] ?? "";
  const requirePlan =
    edge.match(
      /      - name: Require exact non-replacement WAF evidence plan[\s\S]*?(?=\n      - name: Execute exact inspected edge plan)/u
    )?.[0] ?? "";
  const executePlan =
    edge.match(
      /      - name: Execute exact inspected edge plan[\s\S]*?(?=\n      - name: Prove exact deployed stack before lifecycle protection)/u
    )?.[0] ?? "";
  assert.match(createPlan, /if: inputs\.operation == 'plan'/u);
  assert.match(
    loadPlan,
    /if: inputs\.operation == 'apply' && env\.EDGE_APPLY_MODE == 'execute'/u
  );
  assert.match(
    requirePlan,
    /if: inputs\.operation == 'plan' \|\| \(inputs\.operation == 'apply' && env\.EDGE_APPLY_MODE == 'execute'\)/u
  );
  assert.match(
    executePlan,
    /if: inputs\.operation == 'apply' && env\.EDGE_APPLY_MODE == 'execute'/u
  );
  for (const planStep of [createPlan, loadPlan, requirePlan, executePlan]) {
    assert.doesNotMatch(planStep, /inputs\.operation == 'finalize'/u);
  }
  assert.equal(edge.match(/aws cloudformation create-change-set/gu)?.length, 1);
  assert.equal(edge.match(/aws cloudformation execute-change-set/gu)?.length, 1);
  assert.doesNotMatch(
    edge.slice(edge.indexOf("aws cloudformation execute-change-set")),
    /origin\/main/u
  );
  assert.match(
    requirePlan,
    /update_shape="create"[\s\S]*?legacy-bootstrap[\s\S]*?steady-state[\s\S]*?unexpected existing edge inventory/u
  );
  assert.match(
    requirePlan,
    /\$updateShape == "legacy-bootstrap"[\s\S]*?map\(select\(\.action == "Add"\)\)[\s\S]*?== 8[\s\S]*?\$updateShape == "steady-state"[\s\S]*?\$change\.action == "Modify"[\s\S]*?RequiresRecreation == "Never"/u
  );

  const lifecycleProof =
    edge.match(
      /      - name: Prove exact deployed stack before lifecycle protection[\s\S]*?(?=\n      - name: Set exact edge stack lifecycle protections)/u
    )?.[0] ?? "";
  assert.match(
    lifecycleProof,
    /if: \(always\(\) && inputs\.operation == 'apply'\) \|\| \(success\(\) && inputs\.operation == 'finalize'\)/u
  );
  assert.match(
    lifecycleProof,
    /git rev-parse HEAD[\s\S]*?= "\$TARGET_SHA"[\s\S]*?EDGE_PROTECTION_TEMPLATE[\s\S]*?EDGE_PROTECTION_POLICY/u
  );
  assert.doesNotMatch(lifecycleProof, /origin\/main/u);
  assert.match(
    lifecycleProof,
    /\.Stacks\[0\]\.StackId == \$stackId[\s\S]*?\.Stacks\[0\]\.RoleARN \/\/ null\) == null[\s\S]*?\.Stacks\[0\]\.Tags \/\/ \[\]\) == \[\][\s\S]*?\.Stacks\[0\]\.NotificationARNs \/\/ \[\]\) == \[\][\s\S]*?\.Stacks\[0\]\.Capabilities \/\/ \[\]\) == \[\]/u
  );
  assert.match(
    lifecycleProof,
    /\.Stacks\[0\]\.StackStatus == "CREATE_COMPLETE"[\s\S]*?\.Stacks\[0\]\.StackStatus == "UPDATE_COMPLETE"[\s\S]*?\.Stacks\[0\]\.StackStatus[\s\S]*?== "UPDATE_ROLLBACK_COMPLETE"/u
  );
  assert.match(
    lifecycleProof,
    /\.Stacks\[0\]\.Parameters \| parameter_map\) == \{[\s\S]*?AppName: \$app[\s\S]*?Environment: \$environment[\s\S]*?ApiAggregateRateLimit: "1000"[\s\S]*?ResolutionCreateRateLimit: "100"/u
  );
  assert.match(
    lifecycleProof,
    /get-template[\s\S]*?--stack-name "\$lifecycle_stack_id"[\s\S]*?--template-stage Original[\s\S]*?sha256sum "\$lifecycle_template"[\s\S]*?"\$EDGE_PROTECTION_TEMPLATE_DIGEST"/u
  );
  for (const logicalId of [
    "ApiAggregateRateAlarm",
    "ArchonCloudFrontWebAcl",
    "EdgeAlarmArchiveLogGroup",
    "EdgeAlarmArchiveLogPolicy",
    "EdgeAlarmStateEventRule",
    "ResolutionCreateRateAlarm",
    "WafBlockLogGroup",
    "WafBlockLoggingConfiguration",
    "WebAclBlockedRequestsAlarm",
  ]) {
    assert.match(
      lifecycleProof,
      new RegExp(`logicalResourceId: "${logicalId}"`, "u")
    );
  }
  assert.match(
    lifecycleProof,
    /normalized_inventory == \([\s\S]*?\.StackResourceSummaries \| length\) == 9[\s\S]*?\.ResourceStatus \| startswith\("IMPORT_"\) \| not/u
  );
  assert.match(
    lifecycleProof,
    /EDGE_BOUND_STACK_ID=\$lifecycle_stack_id[\s\S]*?EDGE_BOUND_STACK_ID_SHA256=\$lifecycle_stack_id_sha256/u
  );

  const lifecycleMutation =
    edge.match(
      /      - name: Set exact edge stack lifecycle protections[\s\S]*?(?=\n      - name: Prove exact deployed WAF controls)/u
    )?.[0] ?? "";
  assert.match(
    lifecycleMutation,
    /if: \(always\(\) && inputs\.operation == 'apply' && env\.EDGE_BOUND_STACK_ID != ''\) \|\| \(success\(\) && inputs\.operation == 'finalize'\)/u
  );
  assert.match(
    lifecycleMutation,
    /describe-stacks[\s\S]*?--stack-name "\$EDGE_BOUND_STACK_ID"[\s\S]*?\.Stacks\[0\]\.StackId == \$stackId/u
  );
  assert.match(
    lifecycleMutation,
    /set-stack-policy[\s\S]*?--stack-name "\$EDGE_BOUND_STACK_ID"[\s\S]*?--stack-policy-body "file:\/\/\$\{EDGE_PROTECTION_POLICY\}"/u
  );
  assert.match(
    lifecycleMutation,
    /update-termination-protection[\s\S]*?--stack-name "\$EDGE_BOUND_STACK_ID"[\s\S]*?--enable-termination-protection/u
  );
  assert.doesNotMatch(
    lifecycleMutation,
    /--no-enable-termination-protection/u
  );

  const historicalProtection =
    edge.match(
      /      - name: Prove historical finalize protection without current-control claims[\s\S]*?(?=\n      - name: Prove exact deployed WAF controls)/u
    )?.[0] ?? "";
  assert.match(
    historicalProtection,
    /EDGE_HISTORICAL_FINALIZE == 'true'[\s\S]*?EDGE_CURRENT_SEMANTICS_MATCH == 'false'/u
  );
  assert.match(
    historicalProtection,
    /historical-finalized-protection-only[\s\S]*?currentLiveControlsProved:false[\s\S]*?currentPlanApplyRequired:true/u
  );
  assert.doesNotMatch(historicalProtection, /accountId:|stackId:\$stackId/u);

  const liveProof =
    edge.match(
      /      - name: Prove exact deployed WAF controls[\s\S]*?(?=\n      - name: Upload sanitized edge-control receipt)/u
    )?.[0] ?? "";
  assert.match(
    liveProof,
    /if: inputs\.operation == 'apply' \|\| inputs\.operation == 'verify' \|\| \(inputs\.operation == 'finalize' && env\.EDGE_CURRENT_SEMANTICS_MATCH == 'true'\)/u
  );
  assert.match(
    liveProof,
    /EnableTerminationProtection == true[\s\S]*?get-stack-policy[\s\S]*?\(\.StackPolicyBody \| fromjson\) == \$expected\[0\]/u
  );
  assert.match(
    liveProof,
    /EDGE_APPLY_MODE:-\}" = "finalize"[\s\S]*?result="apply-finalized-and-proved"[\s\S]*?elif \[ "\$OPERATION" = "finalize" \][\s\S]*?result="finalized-and-proved"/u
  );
  assert.match(
    liveProof,
    /--arg lifecycleMode "\$\{EDGE_APPLY_MODE:-\$OPERATION\}"[\s\S]*?mode: \$lifecycleMode[\s\S]*?if \$clientToken == ""[\s\S]*?then null/u
  );
  assert.ok(
    edge.indexOf("- name: Prove exact deployed stack before lifecycle protection") <
      edge.indexOf("- name: Set exact edge stack lifecycle protections")
  );
  assert.ok(
    edge.indexOf("- name: Set exact edge stack lifecycle protections") <
      edge.indexOf("- name: Prove exact deployed WAF controls")
  );
  assert.match(
    edge,
    /- name: Upload sanitized edge-control receipt[\s\S]*?if: always\(\)[\s\S]*?edge-controls-\$\{\{ inputs\.environment \}\}-\$\{\{ inputs\.operation \}\}-\$\{\{ inputs\.target_sha \}\}/u
  );
});

test("approved edge fixed-cost envelope remains below its lifecycle ceiling", () => {
  const scenarioIds = [
    "initial",
    "afterFirstBilledKmsRotation",
    "afterSecondBilledKmsRotation",
  ] as const;
  type ScenarioId = (typeof scenarioIds)[number];
  type ScenarioValues = Record<ScenarioId, number>;
  const policy = JSON.parse(
    read("aws/foundation-storage-migration-policy.json")
  ) as {
    incrementalFixedCostContract: {
      schema: string;
      schemaVersion: number;
      scope: string;
      currency: string;
      billingPeriod: string;
      pricingAsOf: string;
      officialPricingUrls: Record<string, string>;
      lineItems: Array<{
        id: string;
        quantity: number;
        unitMonthlyUsd: number;
        pricingSource: string;
        billedUnitsByScenario?: ScenarioValues;
        monthlyUsdByScenario: ScenarioValues;
      }>;
      scenarios: Array<{
        id: ScenarioId;
        expectedMonthlyUsd: number;
      }>;
      maximumExpectedMonthlyUsd: number;
      approvedCeilingMonthlyUsd: number;
      ceilingComparison: string;
      variableUsageChargesExcluded: string[];
      externalAndOutOfScopeChargesExcluded: string[];
    };
  };
  const cost = policy.incrementalFixedCostContract;
  assert.deepEqual(
    {
      schema: cost.schema,
      schemaVersion: cost.schemaVersion,
      scope: cost.scope,
      currency: cost.currency,
      billingPeriod: cost.billingPeriod,
      pricingAsOf: cost.pricingAsOf,
      officialPricingUrls: cost.officialPricingUrls,
      approvedCeilingMonthlyUsd: cost.approvedCeilingMonthlyUsd,
      ceilingComparison: cost.ceilingComparison,
    },
    {
      schema: "archon.aws.incremental-fixed-monthly-cost-contract",
      schemaVersion: 1,
      scope: "incremental foundation + two edge stacks; not total application cost",
      currency: "USD",
      billingPeriod: "month",
      pricingAsOf: "2026-08-03",
      officialPricingUrls: {
        awsCloudWatch: "https://aws.amazon.com/cloudwatch/pricing/",
        awsKms: "https://aws.amazon.com/kms/pricing/",
        awsSecretsManager: "https://aws.amazon.com/secrets-manager/pricing/",
        awsWaf: "https://aws.amazon.com/waf/pricing/",
      },
      approvedCeilingMonthlyUsd: 26,
      ceilingComparison: "strictly-less-than",
    }
  );
  assert.deepEqual(
    cost.lineItems.map((item) => ({
      id: item.id,
      quantity: item.quantity,
      unitMonthlyUsd: item.unitMonthlyUsd,
      pricingSource: item.pricingSource,
      billedUnitsByScenario: item.billedUnitsByScenario ?? null,
    })),
    [
      {
        id: "cloudfront-web-acls",
        quantity: 2,
        unitMonthlyUsd: 5,
        pricingSource: "awsWaf",
        billedUnitsByScenario: null,
      },
      {
        id: "web-acl-rules",
        quantity: 10,
        unitMonthlyUsd: 1,
        pricingSource: "awsWaf",
        billedUnitsByScenario: null,
      },
      {
        id: "standard-cloudwatch-alarm-metrics",
        quantity: 6,
        unitMonthlyUsd: 0.1,
        pricingSource: "awsCloudWatch",
        billedUnitsByScenario: null,
      },
      {
        id: "secrets-manager-secrets",
        quantity: 2,
        unitMonthlyUsd: 0.4,
        pricingSource: "awsSecretsManager",
        billedUnitsByScenario: null,
      },
      {
        id: "application-customer-managed-kms-key",
        quantity: 1,
        unitMonthlyUsd: 1,
        pricingSource: "awsKms",
        billedUnitsByScenario: {
          initial: 1,
          afterFirstBilledKmsRotation: 2,
          afterSecondBilledKmsRotation: 3,
        },
      },
    ]
  );

  const totalsCents = Object.fromEntries(
    scenarioIds.map((scenario) => [scenario, 0])
  ) as Record<ScenarioId, number>;
  for (const item of cost.lineItems) {
    const unitMonthlyCents = Math.round(item.unitMonthlyUsd * 100);
    for (const scenario of scenarioIds) {
      const billedUnits = item.billedUnitsByScenario?.[scenario] ?? item.quantity;
      const computedLineItemCents = billedUnits * unitMonthlyCents;
      assert.equal(
        Math.round(item.monthlyUsdByScenario[scenario] * 100),
        computedLineItemCents,
        `${item.id}/${scenario}`
      );
      totalsCents[scenario] += computedLineItemCents;
    }
  }
  assert.deepEqual(totalsCents, {
    initial: 2240,
    afterFirstBilledKmsRotation: 2340,
    afterSecondBilledKmsRotation: 2440,
  });
  assert.deepEqual(
    cost.scenarios,
    scenarioIds.map((id) => ({
      id,
      expectedMonthlyUsd: totalsCents[id] / 100,
    }))
  );
  const maximumCents = Math.max(...Object.values(totalsCents));
  assert.equal(Math.round(cost.maximumExpectedMonthlyUsd * 100), maximumCents);
  assert.ok(maximumCents < Math.round(cost.approvedCeilingMonthlyUsd * 100));
  assert.deepEqual(cost.variableUsageChargesExcluded, [
    "AWS WAF requests",
    "CloudWatch Logs ingestion and storage",
    "Amazon S3 storage and requests",
    "Amazon EventBridge events",
    "data transfer",
  ]);
  assert.deepEqual(cost.externalAndOutOfScopeChargesExcluded, [
    "taxes",
    "application compute, API, and network services",
    "CockroachDB Cloud",
    "model and inference services",
    "conditional regional alarm-routing control",
    "optional FinOps human notification route",
    "GitHub Actions",
  ]);
});

test("Lambda requires the origin capability in every deployed environment", () => {
  const lambda = read("src/lambda.ts");
  assert.match(lambda, /timingSafeEqual/u);
  assert.match(
    lambda,
    /environment !== "staging" && environment !== "production"/u
  );
  assert.match(
    lambda,
    /originCapabilityMatches\(header\("x-archon-origin-verify"\)\)[\s\S]*?return json\(403, \{ error: "forbidden" \}\)/u
  );
  const tests = read("tests/lambda.test.ts");
  assert.match(
    tests,
    /fail closed against direct origin bypass[\s\S]*?statusCode, 403[\s\S]*?statusCode, 200/u
  );
  assert.match(
    tests,
    /deployed environments reject missing, blank, or malformed origin capability/u
  );
});
