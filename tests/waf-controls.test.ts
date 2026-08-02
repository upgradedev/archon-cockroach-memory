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
    "EdgeAlarmArchiveQueue",
    "EdgeAlarmTopic",
    "EdgeEvidenceKey",
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

test("WAF evidence is BLOCK-only, redacted, encrypted, durable, and alarmed", () => {
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

  assert.match(
    template,
    /EdgeEvidenceKey:[\s\S]*?Type:\s*AWS::KMS::Key[\s\S]*?EnableKeyRotation:\s*true[\s\S]*?MultiRegion:\s*false/u
  );
  for (const service of [
    "logs.us-east-1.amazonaws.com",
    "cloudwatch.amazonaws.com",
    "sns.amazonaws.com",
  ]) {
    assert.match(template, new RegExp(`Service:\\s*${service}`, "u"));
  }
  assert.match(
    template,
    /EdgeAlarmTopic:[\s\S]*?Type:\s*AWS::SNS::Topic[\s\S]*?KmsMasterKeyId:\s*!GetAtt EdgeEvidenceKey.Arn/u
  );
  assert.match(
    template,
    /EdgeAlarmArchiveQueue:[\s\S]*?Type:\s*AWS::SQS::Queue[\s\S]*?KmsMasterKeyId:\s*!GetAtt EdgeEvidenceKey.Arn[\s\S]*?MessageRetentionPeriod:\s*1209600/u
  );
  assert.match(
    template,
    /AllowOnlyExactAlarmTopic[\s\S]*?Service:\s*sns.amazonaws.com[\s\S]*?Action:\s*sqs:SendMessage[\s\S]*?aws:SourceAccount/u
  );
  assert.match(
    template,
    /EdgeAlarmArchiveSubscription:[\s\S]*?Protocol:\s*sqs[\s\S]*?RawMessageDelivery:\s*false/u
  );

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
  assert.equal(
    alarmSection.match(/AlarmActions:[\s\S]*?- !Ref EdgeAlarmTopic/gu)?.length,
    3
  );
  assert.doesNotMatch(alarmSection, /- Name:\s*Region/u);
});

test("regional stack fails closed on mandatory WAF and secret-backed origin verification", () => {
  const template = read("aws/template.yaml");
  const webAclParameter =
    template.match(
      /CloudFrontWebAclArn:\r?\n([\s\S]*?)\r?\nRules:/u
    )?.[1] ?? "";
  assert.match(
    webAclParameter,
    /AllowedPattern:\s*"\^arn:aws:wafv2:us-east-1:/u
  );
  assert.doesNotMatch(webAclParameter, /Default:/u);
  assert.doesNotMatch(template, /^\s{2}OriginVerifyToken:/mu);
  assert.doesNotMatch(template, /HasCloudFrontWebAcl|HasOriginVerifyToken/u);
  assert.match(
    template,
    /WebACLId:\s*!Ref CloudFrontWebAclArn/u
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
  assert.doesNotMatch(deploy, /edge-waf\.yaml/u);
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
  assert.doesNotMatch(edge, /^\s+queue:/mu);
  assert.match(edge, /environment:\s*edge-controls/u);
  assert.match(
    edge,
    /role-to-assume:\s*arn:aws:iam::\$\{\{\s*env\.AWS_ACCOUNT_ID\s*\}\}:role\/\$\{\{\s*env\.APP_NAME\s*\}\}-github-edge-controls/u
  );
  assert.match(edge, /set-stack-policy/u);
  assert.match(edge, /update-termination-protection/u);
  assert.match(
    edge,
    /REVIEW_IN_PROGRESS\)[\s\S]*?test "\$OPERATION" = "apply"[\s\S]*?\.ChangeSetType == "CREATE"[\s\S]*?\.Status == "CREATE_COMPLETE"[\s\S]*?\.ExecutionStatus == "AVAILABLE"/u
  );
  assert.match(
    edge,
    /REVIEW_IN_PROGRESS\)[\s\S]*?sha256sum "\$pending_template"[\s\S]*?EDGE_TEMPLATE_DIGEST[\s\S]*?\.Description == \$description[\s\S]*?\.Parameters \| parameter_map/u
  );
  assert.match(
    edge,
    /\.Stacks\[0\]\.StackId == \$stackId[\s\S]*?\.Stacks\[0\]\.StackStatus == "REVIEW_IN_PROGRESS"[\s\S]*?CHANGE_SET_TYPE=CREATE/u
  );
  assert.match(edge, /schemaVersion:\s*1/u);
  assert.match(edge, /changeSetArnSha256/u);
  assert.doesNotMatch(edge, /changeSet:\s*\{[\s\S]*?\bid:\s*\$changeSet/u);
  assert.match(
    edge,
    /Require exact non-replacement WAF evidence plan[\s\S]*?normalized_changes == \$expected\[0\]/u
  );
  for (const proofCommand of [
    "kms describe-key",
    "kms get-key-policy",
    "logs describe-log-groups",
    "wafv2 get-logging-configuration",
    "sns get-topic-attributes",
    "sns list-subscriptions-by-topic",
    "sqs get-queue-attributes",
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
  assert.doesNotMatch(edge, /receive-message|delete-message/iu);

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
  const edgeRole =
    bootstrap.match(/  EdgeControlRole:[\s\S]*?\n  FinOpsCloudFormationExecutionRole:/u)?.[0] ?? "";
  for (const permission of [
    "wafv2:PutLoggingConfiguration",
    "logs:CreateLogDelivery",
    "kms:CreateKey",
    "sns:CreateTopic",
    "sqs:CreateQueue",
    "cloudwatch:PutMetricAlarm",
  ]) {
    assert.match(edgeRole, new RegExp(permission, "u"));
  }
  assert.match(
    edgeRole,
    /aws:CalledVia:\s*cloudformation.amazonaws.com/u
  );
  assert.match(edgeRole, /aws:RequestedRegion:\s*us-east-1/u);
  assert.match(edgeRole, /aws-waf-logs-\$\{AppName\}-\*-blocked/u);
  assert.match(edgeRole, /\$\{AppName\}-\*-edge-waf-alarms/u);
  assert.match(edgeRole, /\$\{AppName\}-\*-edge-waf-alarm-archive/u);
  assert.doesNotMatch(edgeRole, /sqs:(ReceiveMessage|DeleteMessage)/u);
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
