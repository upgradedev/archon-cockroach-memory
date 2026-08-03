#!/usr/bin/env bash
# Fail-closed live proof for the centralized S3 server-access-log foundation.
#
# Usage:
#   prove-s3-access-logging.sh baseline
#   prove-s3-access-logging.sh verify
#
# baseline proves the safe first-deployment state: the archive and suppression
# rule are live, the stored migration parameter is false, and artifact logging
# is empty. verify proves the permanent state with exact EventTime logging.
set -euo pipefail

mode="${1:-verify}"
if [ "$mode" != "baseline" ] && [ "$mode" != "verify" ]; then
  echo "Usage: $0 [baseline|verify]" >&2
  exit 1
fi

for name in APP_NAME AWS_ACCOUNT_ID AWS_REGION; do
  if [ -z "${!name:-}" ]; then
    echo "$name is required for the S3 access-logging proof." >&2
    exit 1
  fi
done

if [ "$AWS_REGION" != "eu-west-1" ]; then
  echo "The S3 access-logging foundation is restricted to eu-west-1." >&2
  exit 1
fi
if ! [[ "$AWS_ACCOUNT_ID" =~ ^[0-9]{12}$ ]]; then
  echo "AWS_ACCOUNT_ID must be an exact 12-digit account id." >&2
  exit 1
fi
if ! [[ "$APP_NAME" =~ ^[a-z][a-z0-9-]{2,16}$ ]]; then
  echo "APP_NAME is not a valid deterministic bucket-name prefix." >&2
  exit 1
fi

stack_name="${APP_NAME}-delivery-bootstrap"
artifact_bucket="${APP_NAME}-artifacts-${AWS_ACCOUNT_ID}-${AWS_REGION}"
archive_bucket="${APP_NAME}-s3-access-logs-${AWS_ACCOUNT_ID}-${AWS_REGION}"
archive_arn="arn:aws:s3:::${archive_bucket}"
expected_parameter="true"
if [ "$mode" = "baseline" ]; then
  expected_parameter="false"
fi

aws_json() {
  local label="$1"
  shift
  local result
  if ! result="$(aws "$@" --output json 2>&1)"; then
    echo "Unable to inspect ${label}." >&2
    exit 1
  fi
  if [ -z "$result" ]; then
    result="{}"
  fi
  printf '%s\n' "$result"
}

stack="$(
  aws_json \
    "the delivery bootstrap stack" \
    cloudformation describe-stacks \
    --stack-name "$stack_name" \
    --region "$AWS_REGION"
)"

rule_arn="$(
  jq -er \
    --arg stack "$stack_name" \
    --arg mode "$mode" \
    --arg expectedParameter "$expected_parameter" \
    --arg archive "$archive_bucket" \
    --arg archiveArn "$archive_arn" \
    '
      .Stacks[0] as $current
      | (
          (.Stacks | length) == 1
          and $current.StackName == $stack
          and (
            (
              $mode == "verify"
              and $current.StackStatus == "UPDATE_COMPLETE"
            )
            or (
              $mode == "baseline"
              and (
                $current.StackStatus == "UPDATE_COMPLETE"
                or $current.StackStatus == "UPDATE_ROLLBACK_COMPLETE"
              )
            )
          )
          and (
            [$current.Parameters[]
              | select(.ParameterKey == "ArtifactAccessLoggingEnabled")
              | .ParameterValue] == [$expectedParameter]
          )
          and (
            [$current.Outputs[]
              | select(.OutputKey == "S3AccessLogArchiveName")
              | .OutputValue] == [$archive]
          )
          and (
            [$current.Outputs[]
              | select(.OutputKey == "S3AccessLogArchiveArn")
              | .OutputValue] == [$archiveArn]
          )
          and (
            [$current.Outputs[]
              | select(.OutputKey == "S3AccessLogArchiveSuppressionRuleArn")
              | .OutputValue] | length
          ) == 1
        ) as $valid
      | if $valid then
        [$current.Outputs[]
          | select(.OutputKey == "S3AccessLogArchiveSuppressionRuleArn")
          | .OutputValue][0]
      else
        error("bootstrap stack state does not match the requested proof mode")
      end
    ' <<<"$stack"
)"
stack_status="$(jq -er '.Stacks[0].StackStatus' <<<"$stack")"

archive_location="$(
  aws_json \
    "the access-log archive location" \
    s3api get-bucket-location \
    --bucket "$archive_bucket" \
    --expected-bucket-owner "$AWS_ACCOUNT_ID" \
    --region "$AWS_REGION"
)"
archive_encryption="$(
  aws_json \
    "the access-log archive encryption" \
    s3api get-bucket-encryption \
    --bucket "$archive_bucket" \
    --expected-bucket-owner "$AWS_ACCOUNT_ID" \
    --region "$AWS_REGION"
)"
archive_ownership="$(
  aws_json \
    "the access-log archive ownership controls" \
    s3api get-bucket-ownership-controls \
    --bucket "$archive_bucket" \
    --expected-bucket-owner "$AWS_ACCOUNT_ID" \
    --region "$AWS_REGION"
)"
archive_public_access="$(
  aws_json \
    "the access-log archive public-access block" \
    s3api get-public-access-block \
    --bucket "$archive_bucket" \
    --expected-bucket-owner "$AWS_ACCOUNT_ID" \
    --region "$AWS_REGION"
)"
archive_versioning="$(
  aws_json \
    "the access-log archive versioning" \
    s3api get-bucket-versioning \
    --bucket "$archive_bucket" \
    --expected-bucket-owner "$AWS_ACCOUNT_ID" \
    --region "$AWS_REGION"
)"
archive_lifecycle="$(
  aws_json \
    "the access-log archive lifecycle" \
    s3api get-bucket-lifecycle-configuration \
    --bucket "$archive_bucket" \
    --expected-bucket-owner "$AWS_ACCOUNT_ID" \
    --region "$AWS_REGION"
)"
archive_policy="$(
  aws_json \
    "the access-log archive policy" \
    s3api get-bucket-policy \
    --bucket "$archive_bucket" \
    --expected-bucket-owner "$AWS_ACCOUNT_ID" \
    --region "$AWS_REGION"
)"
archive_logging="$(
  aws_json \
    "the access-log archive logging state" \
    s3api get-bucket-logging \
    --bucket "$archive_bucket" \
    --expected-bucket-owner "$AWS_ACCOUNT_ID" \
    --region "$AWS_REGION"
)"
artifact_logging="$(
  aws_json \
    "the artifact-bucket logging state" \
    s3api get-bucket-logging \
    --bucket "$artifact_bucket" \
    --expected-bucket-owner "$AWS_ACCOUNT_ID" \
    --region "$AWS_REGION"
)"

jq -e --arg region "$AWS_REGION" \
  '.LocationConstraint == $region' <<<"$archive_location" >/dev/null
jq -e '
  .ServerSideEncryptionConfiguration.Rules as $rules
  | ($rules | length) == 1
    and $rules[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm == "AES256"
    and (
      $rules[0].ApplyServerSideEncryptionByDefault
      | has("KMSMasterKeyID")
      | not
    )
    and (($rules[0].BucketKeyEnabled // false) == false)
' <<<"$archive_encryption" >/dev/null
jq -e '
  .OwnershipControls.Rules
  == [{"ObjectOwnership":"BucketOwnerEnforced"}]
' <<<"$archive_ownership" >/dev/null
jq -e '
  .PublicAccessBlockConfiguration
  == {
    "BlockPublicAcls": true,
    "IgnorePublicAcls": true,
    "BlockPublicPolicy": true,
    "RestrictPublicBuckets": true
  }
' <<<"$archive_public_access" >/dev/null
jq -e '
  .Status == "Enabled"
  and ((.MFADelete // "Disabled") != "Enabled")
' <<<"$archive_versioning" >/dev/null
jq -e '
  (.Rules | length) == 1
  and .Rules[0].ID == "RetireServerAccessLogs"
  and .Rules[0].Status == "Enabled"
  and ((.Rules[0].Filter.Prefix // .Rules[0].Prefix // "") == "")
  and .Rules[0].Expiration.Days == 365
  and .Rules[0].NoncurrentVersionExpiration.NoncurrentDays == 30
  and (
    .Rules[0].NoncurrentVersionExpiration
    | has("NewerNoncurrentVersions")
    | not
  )
  and .Rules[0].AbortIncompleteMultipartUpload.DaysAfterInitiation == 7
' <<<"$archive_lifecycle" >/dev/null
jq -e 'type == "object" and (keys | length) == 0' \
  <<<"$archive_logging" >/dev/null

jq -e \
  --arg archiveArn "$archive_arn" \
  --arg account "$AWS_ACCOUNT_ID" \
  --arg artifactArn "arn:aws:s3:::${artifact_bucket}" \
  --arg stagingArn "arn:aws:s3:::${APP_NAME}-staging-web-${AWS_ACCOUNT_ID}-${AWS_REGION}" \
  --arg productionArn "arn:aws:s3:::${APP_NAME}-production-web-${AWS_ACCOUNT_ID}-${AWS_REGION}" \
  '
    def only($value):
      if ($value | type) == "array" then $value else [$value] end;
    def exact_delivery($sid; $prefix; $source):
      [.Statement[] | select(.Sid == $sid)] as $statements
      | ($statements | length) == 1
        and $statements[0].Effect == "Allow"
        and $statements[0].Principal
          == {"Service":"logging.s3.amazonaws.com"}
        and only($statements[0].Action) == ["s3:PutObject"]
        and only($statements[0].Resource)
          == [($archiveArn + "/" + $prefix + "/*")]
        and $statements[0].Condition
          == {
            "ArnEquals": {"aws:SourceArn": $source},
            "StringEquals": {"aws:SourceAccount": $account}
          };
    .Policy
    | fromjson
    | (.Statement | length) == 4
      and (
        [.Statement[] | select(.Sid == "DenyInsecureTransport")] as $deny
        | ($deny | length) == 1
          and $deny[0].Effect == "Deny"
          and $deny[0].Principal == "*"
          and only($deny[0].Action) == ["s3:*"]
          and (only($deny[0].Resource) | sort)
            == ([$archiveArn, ($archiveArn + "/*")] | sort)
          and $deny[0].Condition
            == {"Bool":{"aws:SecureTransport":"false"}}
      )
      and exact_delivery(
        "AllowArtifactBucketServerAccessLogs";
        "artifacts";
        $artifactArn
      )
      and exact_delivery(
        "AllowStagingWebBucketServerAccessLogs";
        "staging-web";
        $stagingArn
      )
      and exact_delivery(
        "AllowProductionWebBucketServerAccessLogs";
        "production-web";
        $productionArn
      )
  ' <<<"$archive_policy" >/dev/null

if [ "$mode" = "baseline" ]; then
  jq -e 'type == "object" and (keys | length) == 0' \
    <<<"$artifact_logging" >/dev/null
else
  jq -e \
    --arg archive "$archive_bucket" \
    '
      . == {
        "LoggingEnabled": {
          "TargetBucket": $archive,
          "TargetPrefix": "artifacts/",
          "TargetObjectKeyFormat": {
            "PartitionedPrefix": {
              "PartitionDateSource": "EventTime"
            }
          }
        }
      }
    ' <<<"$artifact_logging" >/dev/null
fi

automation_rule="$(
  aws_json \
    "the Security Hub S3.9 suppression rule" \
    securityhub batch-get-automation-rules \
    --automation-rules-arns "$rule_arn" \
    --region "$AWS_REGION"
)"
jq -e \
  --arg ruleArn "$rule_arn" \
  --arg ruleName "${APP_NAME}-intentional-s3-log-archive-s39" \
  --arg account "$AWS_ACCOUNT_ID" \
  --arg region "$AWS_REGION" \
  --arg archiveArn "$archive_arn" \
  --arg productArn "arn:aws:securityhub:${AWS_REGION}::product/aws/securityhub" \
  --arg updatedBy "${APP_NAME}-delivery-bootstrap" \
  '
    def exact_filter($name; $value):
      (.[$name] | length) == 1
      and .[$name][0] == {"Value":$value,"Comparison":"EQUALS"};
    (.Rules | length) == 1
    and (.UnprocessedAutomationRules | length) == 0
    and .Rules[0].RuleArn == $ruleArn
    and .Rules[0].RuleName == $ruleName
    and .Rules[0].RuleOrder == 1
    and .Rules[0].RuleStatus == "ENABLED"
    and .Rules[0].IsTerminal == true
    and (
      .Rules[0].Criteria
      | (keys | sort) == ([
          "AwsAccountId",
          "ComplianceSecurityControlId",
          "ComplianceStatus",
          "ProductArn",
          "RecordState",
          "ResourceId",
          "ResourceRegion",
          "ResourceType"
        ] | sort)
        and exact_filter("AwsAccountId"; $account)
        and exact_filter("ComplianceSecurityControlId"; "S3.9")
        and exact_filter("ComplianceStatus"; "FAILED")
        and exact_filter("ProductArn"; $productArn)
        and exact_filter("RecordState"; "ACTIVE")
        and exact_filter("ResourceId"; $archiveArn)
        and exact_filter("ResourceRegion"; $region)
        and exact_filter("ResourceType"; "AwsS3Bucket")
    )
    and (
      .Rules[0].Actions
      == [{
        "Type":"FINDING_FIELDS_UPDATE",
        "FindingFieldsUpdate":{
          "Note":{
            "Text":"Intentional exception: an S3 server-access-log destination must not log to itself because that causes recursive log growth.",
            "UpdatedBy":$updatedBy
          },
          "Workflow":{"Status":"SUPPRESSED"}
        }
      }]
    )
  ' <<<"$automation_rule" >/dev/null

logging_enabled="true"
if [ "$mode" = "baseline" ]; then
  logging_enabled="false"
fi

sha256_text() {
  printf '%s' "$1" | sha256sum | awk '{print $1}'
}
stack_name_sha256="$(sha256_text "$stack_name")"
archive_bucket_sha256="$(sha256_text "$archive_bucket")"
artifact_bucket_sha256="$(sha256_text "$artifact_bucket")"
rule_arn_sha256="$(sha256_text "$rule_arn")"

jq -n \
  --arg mode "$mode" \
  --arg stackSha256 "$stack_name_sha256" \
  --arg stackStatus "$stack_status" \
  --arg parameter "$expected_parameter" \
  --arg archiveSha256 "$archive_bucket_sha256" \
  --arg artifactSha256 "$artifact_bucket_sha256" \
  --arg ruleArnSha256 "$rule_arn_sha256" \
  --argjson loggingEnabled "$logging_enabled" \
  '{
    ok: true,
    mode: $mode,
    evidence: "live-control-plane",
    stack: {
      nameSha256: $stackSha256,
      status: $stackStatus,
      artifactAccessLoggingEnabled: $parameter
    },
    archive: {
      bucketSha256: $archiveSha256,
      encryption: "AES256",
      ownership: "BucketOwnerEnforced",
      publicAccessBlocked: true,
      versioning: "Enabled",
      currentRetentionDays: 365,
      noncurrentRetentionDays: 30,
      selfLogging: false
    },
    artifact: {
      bucketSha256: $artifactSha256,
      loggingEnabled: $loggingEnabled,
      targetBucketSha256:
        (if $loggingEnabled then $archiveSha256 else null end),
      targetMatchesArchive: $loggingEnabled,
      targetPrefix: (if $loggingEnabled then "artifacts/" else null end),
      partitionDateSource: (if $loggingEnabled then "EventTime" else null end)
    },
    securityHub: {
      ruleArnSha256: $ruleArnSha256,
      controlId: "S3.9",
      status: "ENABLED",
      terminal: true,
      workflow: "SUPPRESSED"
    }
  }'
