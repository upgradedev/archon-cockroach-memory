#!/usr/bin/env bash
set -euo pipefail

mode="${1:-discover}"

fail() {
  printf 'alarm-routing proof failed: %s\n' "$1" >&2
  exit 1
}

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    fail "required environment variable ${name} is missing"
  fi
}

run_aws() {
  local operation="$1"
  local output
  shift
  if ! output="$(aws "$@" 2>/dev/null)"; then
    fail "${operation} request was rejected"
  fi
  if ! jq -e -s \
    'length == 1 and (.[0] | type == "object")' \
    <<<"$output" >/dev/null; then
    fail "${operation} returned a non-canonical JSON response"
  fi
  printf '%s\n' "$output"
}

require_jq() {
  local message="$1"
  local payload="$2"
  shift 2
  if ! jq -e "$@" <<<"$payload" >/dev/null; then
    fail "$message"
  fi
}

case "$mode" in
  discover|verify) ;;
  *) fail "mode must be discover or verify" ;;
esac

for required in APP_NAME AWS_ACCOUNT_ID AWS_REGION ENVIRONMENT; do
  require_env "$required"
done

[[ "$APP_NAME" =~ ^[a-z][a-z0-9-]{2,16}$ ]] ||
  fail "APP_NAME is outside the foundation naming contract"
[[ "$AWS_ACCOUNT_ID" =~ ^[0-9]{12}$ ]] ||
  fail "AWS_ACCOUNT_ID must be a 12-digit account id"
[ "$AWS_REGION" = "eu-west-1" ] ||
  fail "alarm routing is fixed to eu-west-1"
case "$ENVIRONMENT" in
  staging|production) ;;
  *) fail "ENVIRONMENT must be staging or production" ;;
esac

prove_alarm_configuration() {
  local action_state="$1"
  local expected_topic_arn="$2"
  local failure_message
  local alarms

  case "$action_state" in
    disabled)
      failure_message="CloudWatch alarms retain actions while alarm routing is inactive"
      ;;
    routed)
      failure_message="CloudWatch alarms are not exclusively wired to the discovered topic"
      ;;
    *) fail "internal alarm action state is invalid" ;;
  esac

  alarms="$(
    run_aws \
      "CloudWatch alarm discovery" \
      cloudwatch describe-alarms \
      --alarm-name-prefix "${APP_NAME}-${ENVIRONMENT}-" \
      --alarm-types MetricAlarm \
      --region "$AWS_REGION" \
      --output json \
      --no-cli-pager
  )"
  require_jq \
    "$failure_message" \
    "$alarms" \
    --arg actionState "$action_state" \
    --arg app "$APP_NAME" \
    --arg environment "$ENVIRONMENT" \
    --arg topicArn "$expected_topic_arn" \
    '
      . as $root
      | ($app + "-staging-routing-drill") as $drillName
      | [
          ($app + "-" + $environment + "-lambda-errors"),
          ($app + "-" + $environment + "-lambda-throttles"),
          ($app + "-" + $environment + "-api-5xx")
        ] as $staticNames
      | ("^" + $app + "-" + $environment
          + "-lambda-canary-errors-v[0-9]+$") as $canaryPattern
      | (.MetricAlarms // []) as $allAlarms
      | [$allAlarms[] | select(.AlarmName != $drillName)]
          as $deploymentAlarms
      | [$allAlarms[] | select(.AlarmName == $drillName)]
          as $drillAlarms
      | (
          if $actionState == "routed" and $environment == "staging"
          then 1
          else 0
          end
        ) as $expectedDrillCount
      | ($allAlarms | type == "array")
      and ((.CompositeAlarms // []) | length == 0)
      and ($allAlarms | length) == (4 + $expectedDrillCount)
      and ([$allAlarms[].AlarmName] | unique | length)
        == (4 + $expectedDrillCount)
      and ($deploymentAlarms | length) == 4
      and ($drillAlarms | length) == $expectedDrillCount
      and all(
        $staticNames[];
        . as $name
        | [$deploymentAlarms[].AlarmName] | index($name) != null
      )
      and (
        [$deploymentAlarms[].AlarmName | select(test($canaryPattern))]
        | length
      ) == 1
      and all(
        $deploymentAlarms[];
        .ActionsEnabled == true
        and (.AlarmActions | type == "array")
        and (.OKActions | type == "array" and length == 0)
        and (
          .InsufficientDataActions
          | type == "array" and length == 0
        )
        and (
          if $actionState == "routed"
          then .AlarmActions == [$topicArn]
          else .AlarmActions == []
          end
        )
      )
      and all(
        $drillAlarms[];
        .ActionsEnabled == true
        and .AlarmActions == [$topicArn]
        and (.OKActions | type == "array" and length == 0)
        and (
          .InsufficientDataActions
          | type == "array" and length == 0
        )
      )
    '
}

foundation_stack_name="${APP_NAME}-delivery-bootstrap"
foundation_stack_prefix="arn:aws:cloudformation:${AWS_REGION}:${AWS_ACCOUNT_ID}:stack/${foundation_stack_name}/"
foundation="$(
  run_aws \
    "foundation stack discovery" \
    cloudformation describe-stacks \
    --stack-name "$foundation_stack_name" \
    --region "$AWS_REGION" \
    --output json \
    --no-cli-pager
)"

require_jq \
  "foundation stack identity, state, or termination protection is invalid" \
  "$foundation" \
  --arg account "$AWS_ACCOUNT_ID" \
  --arg app "$APP_NAME" \
  --arg stack "$foundation_stack_name" \
  --arg prefix "$foundation_stack_prefix" \
  '
    (.Stacks | type == "array" and length == 1)
    and .Stacks[0].StackName == $stack
    and (.Stacks[0].StackId | type == "string" and startswith($prefix))
    and (
      .Stacks[0].StackStatus == "CREATE_COMPLETE"
      or .Stacks[0].StackStatus == "UPDATE_COMPLETE"
      or .Stacks[0].StackStatus == "UPDATE_ROLLBACK_COMPLETE"
    )
    and .Stacks[0].EnableTerminationProtection == true
    and (
      (.Stacks[0].RoleARN // null) == null
      or .Stacks[0].RoleARN == (
        "arn:aws:iam::" + $account + ":role/" + $app
        + "-alarm-routing-cloudformation-execution"
      )
    )
  '

foundation_stack_id="$(jq -er '.Stacks[0].StackId' <<<"$foundation")"
foundation_stack_status="$(jq -er '.Stacks[0].StackStatus' <<<"$foundation")"
parameter_values="$(
  jq -c \
    '[
      .Stacks[0].Parameters[]?
      | select(.ParameterKey == "AlarmRoutingEnabled")
      | .ParameterValue
    ]' <<<"$foundation"
)"
case "$(jq -r 'length' <<<"$parameter_values")" in
  0) alarm_parameter_state="missing" ;;
  1)
    alarm_parameter_state="$(jq -er '.[0]' <<<"$parameter_values")"
    case "$alarm_parameter_state" in
      true|false) ;;
      *) fail "AlarmRoutingEnabled has an invalid value" ;;
    esac
    ;;
  *) fail "AlarmRoutingEnabled is duplicated" ;;
esac

expected_alarm_execution_role="arn:aws:iam::${AWS_ACCOUNT_ID}:role/${APP_NAME}-alarm-routing-cloudformation-execution"
foundation_execution_role="$(jq -r '.Stacks[0].RoleARN // ""' <<<"$foundation")"
if [ "$alarm_parameter_state" = "true" ]; then
  [ "$foundation_stack_status" = "UPDATE_COMPLETE" ] ||
    fail "active alarm routing is not in a terminal successful stack state"
  [ "$foundation_execution_role" = "$expected_alarm_execution_role" ] ||
    fail "active alarm routing is not bound to the dedicated CloudFormation execution role"
else
  if [ -n "$foundation_execution_role" ] &&
     [ "$foundation_execution_role" != "$expected_alarm_execution_role" ]; then
    fail "inactive alarm routing is bound to an unexpected CloudFormation execution role"
  fi
fi

alarm_output_keys="$(
  jq -cn '[
    "AlarmRoutingContractVersion",
    "AlarmNotificationsKeyArn",
    "StagingAlarmTopicArn",
    "ProductionAlarmTopicArn",
    "StagingAlarmArchiveQueueArn",
    "StagingAlarmRoutingDrillQueueArn",
    "ProductionAlarmArchiveQueueArn"
  ]'
)"
alarm_output_count="$(
  jq -r \
    --argjson keys "$alarm_output_keys" \
    '[
      .Stacks[0].Outputs[]?
      | select(.OutputKey as $key | $keys | index($key))
    ] | length' <<<"$foundation"
)"

if [ "$alarm_parameter_state" = "missing" ] &&
   [ "$alarm_output_count" = "0" ]; then
  jq -cn \
    --arg environment "$ENVIRONMENT" \
    --arg foundationStackId "$foundation_stack_id" \
    --arg mode "$mode" \
    '{
      schema: "archon.alarm-routing.proof",
      version: 1,
      ok: true,
      mode: $mode,
      state: "legacy-inactive-not-provisioned",
      contractVersion: null,
      environment: $environment,
      foundationStackId: $foundationStackId,
      keyArn: null,
      topicArn: null,
      archiveQueueArn: null,
      drillQueueArn: null,
      alarmCount: null
    }'
  exit 0
fi

if [ "$alarm_parameter_state" = "false" ] &&
   [ "$alarm_output_count" = "0" ]; then
  alarm_count="null"
  if [ "$mode" = "verify" ]; then
    prove_alarm_configuration disabled ""
    alarm_count="4"
  fi
  jq -cn \
    --arg environment "$ENVIRONMENT" \
    --arg foundationStackId "$foundation_stack_id" \
    --arg mode "$mode" \
    --argjson alarmCount "$alarm_count" \
    '{
      schema: "archon.alarm-routing.proof",
      version: 1,
      ok: true,
      mode: $mode,
      state: "inactive-not-provisioned",
      contractVersion: null,
      environment: $environment,
      foundationStackId: $foundationStackId,
      keyArn: null,
      topicArn: null,
      archiveQueueArn: null,
      drillQueueArn: null,
      alarmCount: $alarmCount
    }'
  exit 0
fi

[ "$alarm_parameter_state" = "true" ] ||
  fail "alarm-routing outputs exist while the foundation switch is inactive"
[ "$alarm_output_count" = "7" ] ||
  fail "the active alarm-routing output contract is incomplete"

require_jq \
  "the active alarm-routing output contract contains duplicates" \
  "$foundation" \
  --argjson keys "$alarm_output_keys" \
  '
    [
      .Stacks[0].Outputs[]?
      | select(.OutputKey as $key | $keys | index($key))
      | .OutputKey
    ] as $present
    | ($present | length) == 7
      and ($present | unique | length) == 7
  '

output_value() {
  local key="$1"
  jq -er \
    --arg key "$key" \
    '
      [
        .Stacks[0].Outputs[]?
        | select(.OutputKey == $key)
        | .OutputValue
      ]
      | if length == 1 and (.[0] | type == "string" and length > 0)
        then .[0]
        else error("invalid output")
        end
    ' <<<"$foundation" ||
    fail "foundation output ${key} is invalid"
}

contract_version="$(output_value AlarmRoutingContractVersion)"
key_arn="$(output_value AlarmNotificationsKeyArn)"
staging_topic_arn="$(output_value StagingAlarmTopicArn)"
production_topic_arn="$(output_value ProductionAlarmTopicArn)"
staging_queue_arn="$(output_value StagingAlarmArchiveQueueArn)"
drill_queue_arn="$(output_value StagingAlarmRoutingDrillQueueArn)"
production_queue_arn="$(output_value ProductionAlarmArchiveQueueArn)"

[ "$contract_version" = "1" ] ||
  fail "unsupported alarm-routing contract version"
[ "$staging_topic_arn" = \
  "arn:aws:sns:${AWS_REGION}:${AWS_ACCOUNT_ID}:${APP_NAME}-staging-alarms" ] ||
  fail "staging topic ARN is not the deterministic foundation resource"
[ "$production_topic_arn" = \
  "arn:aws:sns:${AWS_REGION}:${AWS_ACCOUNT_ID}:${APP_NAME}-production-alarms" ] ||
  fail "production topic ARN is not the deterministic foundation resource"
[ "$staging_queue_arn" = \
  "arn:aws:sqs:${AWS_REGION}:${AWS_ACCOUNT_ID}:${APP_NAME}-staging-alarm-archive" ] ||
  fail "staging archive queue ARN is not the deterministic foundation resource"
[ "$drill_queue_arn" = \
  "arn:aws:sqs:${AWS_REGION}:${AWS_ACCOUNT_ID}:${APP_NAME}-staging-alarm-routing-drill" ] ||
  fail "staging drill queue ARN is not the deterministic foundation resource"
[ "$production_queue_arn" = \
  "arn:aws:sqs:${AWS_REGION}:${AWS_ACCOUNT_ID}:${APP_NAME}-production-alarm-archive" ] ||
  fail "production archive queue ARN is not the deterministic foundation resource"
[[ "$key_arn" =~ ^arn:aws:kms:eu-west-1:${AWS_ACCOUNT_ID}:key/[A-Za-z0-9-]{1,128}$ ]] ||
  fail "alarm notification key ARN is invalid"

if [ "$ENVIRONMENT" = "staging" ]; then
  topic_arn="$staging_topic_arn"
  queue_arn="$staging_queue_arn"
else
  topic_arn="$production_topic_arn"
  queue_arn="$production_queue_arn"
fi
queue_name="${APP_NAME}-${ENVIRONMENT}-alarm-archive"
expected_queue_url="https://sqs.${AWS_REGION}.amazonaws.com/${AWS_ACCOUNT_ID}/${queue_name}"

key_description="$(
  run_aws \
    "KMS key discovery" \
    kms describe-key \
    --key-id "$key_arn" \
    --region "$AWS_REGION" \
    --output json \
    --no-cli-pager
)"
require_jq \
  "KMS key metadata is outside the alarm-routing contract" \
  "$key_description" \
  --arg arn "$key_arn" \
  '
    .KeyMetadata.Arn == $arn
    and .KeyMetadata.Enabled == true
    and .KeyMetadata.KeyManager == "CUSTOMER"
    and .KeyMetadata.KeySpec == "SYMMETRIC_DEFAULT"
    and .KeyMetadata.KeyUsage == "ENCRYPT_DECRYPT"
    and .KeyMetadata.KeyState == "Enabled"
    and .KeyMetadata.MultiRegion == false
  '

key_rotation="$(
  run_aws \
    "KMS rotation discovery" \
    kms get-key-rotation-status \
    --key-id "$key_arn" \
    --region "$AWS_REGION" \
    --output json \
    --no-cli-pager
)"
require_jq \
  "KMS key rotation is not enabled" \
  "$key_rotation" \
  '.KeyRotationEnabled == true'

key_policy="$(
  run_aws \
    "KMS key-policy discovery" \
    kms get-key-policy \
    --key-id "$key_arn" \
    --policy-name default \
    --region "$AWS_REGION" \
    --output json \
    --no-cli-pager
)"
require_jq \
  "KMS key policy does not preserve the scoped CloudWatch and SNS grants" \
  "$key_policy" \
  --arg account "$AWS_ACCOUNT_ID" \
  --arg rootArn "arn:aws:iam::${AWS_ACCOUNT_ID}:root" \
  --arg stagingSource \
    "arn:aws:cloudwatch:${AWS_REGION}:${AWS_ACCOUNT_ID}:alarm:${APP_NAME}-staging-*" \
  --arg productionSource \
    "arn:aws:cloudwatch:${AWS_REGION}:${AWS_ACCOUNT_ID}:alarm:${APP_NAME}-production-*" \
  '
    (.Policy | fromjson | .Statement) as $statements
    | ($statements | length) == 3
    and (
      [$statements[].Sid] | unique | sort
    ) == ([
      "AllowCloudWatchAlarmEncryption",
      "AllowSnsEncryptedQueueDelivery",
      "EnableAccountAdministration"
    ] | sort)
    and (
        [$statements[] | select(.Sid == "EnableAccountAdministration")]
        | length
      ) == 1
    and (
      $statements[]
      | select(.Sid == "EnableAccountAdministration")
      | .Effect == "Allow"
        and .Principal.AWS == $rootArn
        and .Action == "kms:*"
        and .Resource == "*"
    )
    and (
        [$statements[] | select(.Sid == "AllowCloudWatchAlarmEncryption")]
        | length
      ) == 1
    and (
      $statements[]
      | select(.Sid == "AllowCloudWatchAlarmEncryption")
      | .Effect == "Allow"
        and .Principal.Service == "cloudwatch.amazonaws.com"
        and (
          .Action
          | if type == "array" then . else [.] end
          | map(ascii_downcase)
          | sort
        ) == ["kms:decrypt", "kms:generatedatakey*"]
        and .Resource == "*"
        and (
          .Condition.StringEquals."aws:SourceAccount"
          // .Condition.StringEquals."AWS:SourceAccount"
        ) == $account
        and (
          (
            .Condition.ArnLike."aws:SourceArn"
            // .Condition.ArnLike."AWS:SourceArn"
          )
          | sort
        ) == ([$stagingSource, $productionSource] | sort)
    )
    and (
        [$statements[] | select(.Sid == "AllowSnsEncryptedQueueDelivery")]
        | length
      ) == 1
    and (
      $statements[]
      | select(.Sid == "AllowSnsEncryptedQueueDelivery")
      | .Effect == "Allow"
        and .Principal.Service == "sns.amazonaws.com"
        and (
          .Action
          | if type == "array" then . else [.] end
          | map(ascii_downcase)
          | sort
        ) == ["kms:decrypt", "kms:generatedatakey*"]
        and .Resource == "*"
        and (
          .Condition.StringEquals."aws:SourceAccount"
          // .Condition.StringEquals."AWS:SourceAccount"
        ) == $account
    )
  '

key_tags="$(
  run_aws \
    "KMS tag discovery" \
    kms list-resource-tags \
    --key-id "$key_arn" \
    --region "$AWS_REGION" \
    --output json \
    --no-cli-pager
)"
require_jq \
  "KMS key tags are incomplete or duplicated" \
  "$key_tags" \
  --arg app "$APP_NAME" \
  '
    (.Tags | type == "array") as $isArray
    | $isArray
      and ([.Tags[].TagKey] | unique | length) == (.Tags | length)
      and [.Tags[] | select(.TagKey == "Application") | .TagValue] == [$app]
      and [
        .Tags[]
        | select(.TagKey == "DataClassification")
        | .TagValue
      ] == ["alarm-notifications"]
      and [.Tags[] | select(.TagKey == "ManagedBy") | .TagValue]
        == ["CloudFormation"]
  '

topic="$(
  run_aws \
    "SNS topic discovery" \
    sns get-topic-attributes \
    --topic-arn "$topic_arn" \
    --region "$AWS_REGION" \
    --output json \
    --no-cli-pager
)"
require_jq \
  "SNS topic attributes or policy are outside the alarm-routing contract" \
  "$topic" \
  --arg account "$AWS_ACCOUNT_ID" \
  --arg arn "$topic_arn" \
  --arg environment "$ENVIRONMENT" \
  --arg keyArn "$key_arn" \
  --arg rootArn "arn:aws:iam::${AWS_ACCOUNT_ID}:root" \
  --arg stagingArn "$staging_topic_arn" \
  --arg productionArn "$production_topic_arn" \
  --arg stagingSource \
    "arn:aws:cloudwatch:${AWS_REGION}:${AWS_ACCOUNT_ID}:alarm:${APP_NAME}-staging-*" \
  --arg productionSource \
    "arn:aws:cloudwatch:${AWS_REGION}:${AWS_ACCOUNT_ID}:alarm:${APP_NAME}-production-*" \
  '
    def action_list:
      if type == "array" then . else [.] end
      | map(ascii_downcase)
      | sort;
    def exact_keys($expected):
      (keys | sort) == ($expected | sort);
    (.Attributes.Policy | fromjson | .Statement) as $statements
    | ($statements | length) == 4
    and (
      [$statements[].Sid] | unique | sort
    ) == ([
      "AllowAccountTopicAdministration",
      "AllowProductionCloudWatchAlarmPublish",
      "AllowStagingCloudWatchAlarmPublish",
      "DenyInsecureTransport"
    ] | sort)
    and .Attributes.TopicArn == $arn
    and .Attributes.Owner == $account
    and .Attributes.KmsMasterKeyId == $keyArn
    and .Attributes.SubscriptionsConfirmed == (
      if $environment == "staging" then "2" else "1" end
    )
    and .Attributes.SubscriptionsPending == "0"
    and .Attributes.SubscriptionsDeleted == "0"
    and (
      $statements[]
      | select(.Sid == "AllowAccountTopicAdministration")
      | exact_keys(["Action", "Effect", "Principal", "Resource", "Sid"])
        and .Effect == "Allow"
        and (
          .Principal
          | exact_keys(["AWS"])
            and .AWS == $rootArn
        )
        and (
          .Action
          | action_list
        ) == ([
          "sns:addpermission",
          "sns:deletetopic",
          "sns:gettopicattributes",
          "sns:listsubscriptionsbytopic",
          "sns:publish",
          "sns:removepermission",
          "sns:settopicattributes",
          "sns:subscribe"
        ] | sort)
        and (
          .Resource
          | if type == "array" then sort else [] end
        ) == ([$stagingArn, $productionArn] | sort)
    )
    and (
      $statements[]
      | select(.Sid == "AllowStagingCloudWatchAlarmPublish")
      | exact_keys([
          "Action",
          "Condition",
          "Effect",
          "Principal",
          "Resource",
          "Sid"
        ])
        and .Effect == "Allow"
        and (
          .Principal
          | exact_keys(["Service"])
            and .Service == "cloudwatch.amazonaws.com"
        )
        and (.Action | action_list) == ["sns:publish"]
        and .Resource == $stagingArn
        and (
          .Condition
          | exact_keys(["ArnLike", "StringEquals"])
            and (
              .StringEquals
              | exact_keys(["aws:SourceAccount"])
                and ."aws:SourceAccount" == $account
            )
            and (
              .ArnLike
              | exact_keys(["aws:SourceArn"])
                and ."aws:SourceArn" == $stagingSource
            )
        )
    )
    and (
      $statements[]
      | select(.Sid == "AllowProductionCloudWatchAlarmPublish")
      | exact_keys([
          "Action",
          "Condition",
          "Effect",
          "Principal",
          "Resource",
          "Sid"
        ])
        and .Effect == "Allow"
        and (
          .Principal
          | exact_keys(["Service"])
            and .Service == "cloudwatch.amazonaws.com"
        )
        and (.Action | action_list) == ["sns:publish"]
        and .Resource == $productionArn
        and (
          .Condition
          | exact_keys(["ArnLike", "StringEquals"])
            and (
              .StringEquals
              | exact_keys(["aws:SourceAccount"])
                and ."aws:SourceAccount" == $account
            )
            and (
              .ArnLike
              | exact_keys(["aws:SourceArn"])
                and ."aws:SourceArn" == $productionSource
            )
        )
    )
    and (
      $statements[]
      | select(.Sid == "DenyInsecureTransport")
      | exact_keys([
          "Action",
          "Condition",
          "Effect",
          "Principal",
          "Resource",
          "Sid"
        ])
        and .Effect == "Deny"
        and .Principal == "*"
        and (.Action | action_list) == ["sns:*"]
        and (
          .Resource
          | if type == "array" then sort else [] end
        ) == ([$stagingArn, $productionArn] | sort)
        and (
          .Condition
          | exact_keys(["Bool"])
            and (
              .Bool
              | exact_keys(["aws:SecureTransport"])
                and ."aws:SecureTransport" == "false"
            )
        )
    )
  '

topic_tags="$(
  run_aws \
    "SNS tag discovery" \
    sns list-tags-for-resource \
    --resource-arn "$topic_arn" \
    --region "$AWS_REGION" \
    --output json \
    --no-cli-pager
)"
require_jq \
  "SNS topic tags are incomplete or duplicated" \
  "$topic_tags" \
  --arg app "$APP_NAME" \
  --arg environment "$ENVIRONMENT" \
  '
    (.Tags | type == "array") as $isArray
    | $isArray
      and ([.Tags[].Key] | unique | length) == (.Tags | length)
      and [.Tags[] | select(.Key == "Application") | .Value] == [$app]
      and [.Tags[] | select(.Key == "Environment") | .Value]
        == [$environment]
      and [
        .Tags[]
        | select(.Key == "DataClassification")
        | .Value
      ] == ["alarm-notifications"]
      and [.Tags[] | select(.Key == "ManagedBy") | .Value]
        == ["CloudFormation"]
  '

subscriptions="$(
  run_aws \
    "SNS subscription discovery" \
    sns list-subscriptions-by-topic \
    --topic-arn "$topic_arn" \
    --region "$AWS_REGION" \
    --output json \
    --no-cli-pager
)"
require_jq \
  "SNS topic subscriptions are outside the archive and drill contract" \
  "$subscriptions" \
  --arg drillQueueArn "$drill_queue_arn" \
  --arg environment "$ENVIRONMENT" \
  --arg topicArn "$topic_arn" \
  --arg queueArn "$queue_arn" \
  '
    (.Subscriptions | type == "array")
    and (.Subscriptions | length) == (
      if $environment == "staging" then 2 else 1 end
    )
    and all(
      .Subscriptions[];
      .TopicArn == $topicArn
      and .Protocol == "sqs"
      and (
        .SubscriptionArn
        | type == "string"
          and . != "PendingConfirmation"
          and . != "Deleted"
          and startswith("arn:aws:sns:")
      )
    )
    and ([.Subscriptions[].Endpoint] | sort) == (
      if $environment == "staging"
      then ([$queueArn, $drillQueueArn] | sort)
      else [$queueArn]
      end
    )
  '
subscription_arn="$(
  jq -er \
    --arg endpoint "$queue_arn" \
    '[.Subscriptions[] | select(.Endpoint == $endpoint)]
     | if length == 1 then .[0].SubscriptionArn else error("invalid") end' \
    <<<"$subscriptions"
)"
subscription="$(
  run_aws \
    "SNS subscription-attribute discovery" \
    sns get-subscription-attributes \
    --subscription-arn "$subscription_arn" \
    --region "$AWS_REGION" \
    --output json \
    --no-cli-pager
)"
require_jq \
  "SNS archive subscription attributes are outside the contract" \
  "$subscription" \
  --arg account "$AWS_ACCOUNT_ID" \
  --arg subscriptionArn "$subscription_arn" \
  --arg topicArn "$topic_arn" \
  --arg queueArn "$queue_arn" \
  '
    .Attributes.SubscriptionArn == $subscriptionArn
    and .Attributes.TopicArn == $topicArn
    and .Attributes.Protocol == "sqs"
    and .Attributes.Endpoint == $queueArn
    and .Attributes.Owner == $account
    and .Attributes.RawMessageDelivery == "false"
  '

if [ "$ENVIRONMENT" = "staging" ]; then
  drill_subscription_arn="$(
    jq -er \
      --arg endpoint "$drill_queue_arn" \
      '[.Subscriptions[] | select(.Endpoint == $endpoint)]
       | if length == 1 then .[0].SubscriptionArn else error("invalid") end' \
      <<<"$subscriptions"
  )"
  drill_subscription="$(
    run_aws \
      "SNS drill subscription-attribute discovery" \
      sns get-subscription-attributes \
      --subscription-arn "$drill_subscription_arn" \
      --region "$AWS_REGION" \
      --output json \
      --no-cli-pager
  )"
  require_jq \
    "SNS drill subscription filter is outside the exact AlarmName contract" \
    "$drill_subscription" \
    --arg account "$AWS_ACCOUNT_ID" \
    --arg alarmName "${APP_NAME}-staging-routing-drill" \
    --arg queueArn "$drill_queue_arn" \
    --arg subscriptionArn "$drill_subscription_arn" \
    --arg topicArn "$staging_topic_arn" \
    '
      .Attributes.SubscriptionArn == $subscriptionArn
      and .Attributes.TopicArn == $topicArn
      and .Attributes.Protocol == "sqs"
      and .Attributes.Endpoint == $queueArn
      and .Attributes.Owner == $account
      and .Attributes.RawMessageDelivery == "false"
      and .Attributes.FilterPolicyScope == "MessageBody"
      and (.Attributes.FilterPolicy | fromjson)
        == {AlarmName:[$alarmName]}
    '
fi

queue_url_response="$(
  run_aws \
    "SQS queue-url discovery" \
    sqs get-queue-url \
    --queue-name "$queue_name" \
    --queue-owner-aws-account-id "$AWS_ACCOUNT_ID" \
    --region "$AWS_REGION" \
    --output json \
    --no-cli-pager
)"
require_jq \
  "SQS queue URL is not the deterministic archive resource" \
  "$queue_url_response" \
  --arg url "$expected_queue_url" \
  '.QueueUrl == $url'
queue_url="$(jq -er '.QueueUrl' <<<"$queue_url_response")"

queue="$(
  run_aws \
    "SQS queue-attribute discovery" \
    sqs get-queue-attributes \
    --queue-url "$queue_url" \
    --attribute-names All \
    --region "$AWS_REGION" \
    --output json \
    --no-cli-pager
)"
require_jq \
  "SQS archive queue attributes or policy are outside the contract" \
  "$queue" \
  --arg account "$AWS_ACCOUNT_ID" \
  --arg arn "$queue_arn" \
  --arg keyArn "$key_arn" \
  --arg drillQueueArn "$drill_queue_arn" \
  --arg stagingQueueArn "$staging_queue_arn" \
  --arg productionQueueArn "$production_queue_arn" \
  --arg stagingTopicArn "$staging_topic_arn" \
  --arg productionTopicArn "$production_topic_arn" \
  '
    def action_list:
      if type == "array" then . else [.] end
      | map(ascii_downcase)
      | sort;
    def exact_keys($expected):
      (keys | sort) == ($expected | sort);
    (.Attributes.Policy | fromjson | .Statement) as $statements
    | ($statements | length) == 7
    and (
      [$statements[].Sid] | unique | sort
    ) == ([
      "AllowProductionAlarmArchiveDelivery",
      "AllowStagingAlarmArchiveDelivery",
      "AllowStagingAlarmRoutingDrillDelivery",
      "DenyProductionAlarmArchiveInjection",
      "DenyStagingAlarmArchiveInjection",
      "DenyStagingAlarmRoutingDrillInjection",
      "DenyInsecureTransport"
    ] | sort)
    and .Attributes.QueueArn == $arn
    and .Attributes.KmsMasterKeyId == $keyArn
    and .Attributes.KmsDataKeyReusePeriodSeconds == "300"
    and .Attributes.MessageRetentionPeriod == "1209600"
    and .Attributes.ReceiveMessageWaitTimeSeconds == "20"
    and .Attributes.VisibilityTimeout == "60"
    and (
      $statements[]
      | select(.Sid == "AllowStagingAlarmArchiveDelivery")
      | exact_keys([
          "Action",
          "Condition",
          "Effect",
          "Principal",
          "Resource",
          "Sid"
        ])
        and .Effect == "Allow"
        and (
          .Principal
          | exact_keys(["Service"])
            and .Service == "sns.amazonaws.com"
        )
        and (.Action | action_list) == ["sqs:sendmessage"]
        and .Resource == $stagingQueueArn
        and (
          .Condition
          | exact_keys(["ArnEquals", "StringEquals"])
            and (
              .StringEquals
              | exact_keys(["aws:SourceAccount"])
                and ."aws:SourceAccount" == $account
            )
            and (
              .ArnEquals
              | exact_keys(["aws:SourceArn"])
                and ."aws:SourceArn" == $stagingTopicArn
            )
        )
    )
    and (
      $statements[]
      | select(.Sid == "AllowProductionAlarmArchiveDelivery")
      | exact_keys([
          "Action",
          "Condition",
          "Effect",
          "Principal",
          "Resource",
          "Sid"
        ])
        and .Effect == "Allow"
        and (
          .Principal
          | exact_keys(["Service"])
            and .Service == "sns.amazonaws.com"
        )
        and (.Action | action_list) == ["sqs:sendmessage"]
        and .Resource == $productionQueueArn
        and (
          .Condition
          | exact_keys(["ArnEquals", "StringEquals"])
            and (
              .StringEquals
              | exact_keys(["aws:SourceAccount"])
                and ."aws:SourceAccount" == $account
            )
            and (
              .ArnEquals
              | exact_keys(["aws:SourceArn"])
                and ."aws:SourceArn" == $productionTopicArn
            )
        )
    )
    and (
      $statements[]
      | select(.Sid == "AllowStagingAlarmRoutingDrillDelivery")
      | exact_keys([
          "Action",
          "Condition",
          "Effect",
          "Principal",
          "Resource",
          "Sid"
        ])
        and .Effect == "Allow"
        and (
          .Principal
          | exact_keys(["Service"])
            and .Service == "sns.amazonaws.com"
        )
        and (.Action | action_list) == ["sqs:sendmessage"]
        and .Resource == $drillQueueArn
        and (
          .Condition
          | exact_keys(["ArnEquals", "StringEquals"])
            and .StringEquals."aws:SourceAccount" == $account
            and .ArnEquals."aws:SourceArn" == $stagingTopicArn
        )
    )
    and (
      $statements[]
      | select(.Sid == "DenyStagingAlarmArchiveInjection")
      | exact_keys([
          "Action",
          "Condition",
          "Effect",
          "Principal",
          "Resource",
          "Sid"
        ])
        and .Effect == "Deny"
        and .Principal == "*"
        and (.Action | action_list) == ["sqs:sendmessage"]
        and .Resource == $stagingQueueArn
        and (
          .Condition
          | exact_keys(["ArnNotLike"])
            and (
              .ArnNotLike
              | exact_keys(["aws:SourceArn"])
                and ."aws:SourceArn" == $stagingTopicArn
            )
        )
    )
    and (
      $statements[]
      | select(.Sid == "DenyStagingAlarmRoutingDrillInjection")
      | exact_keys([
          "Action",
          "Condition",
          "Effect",
          "Principal",
          "Resource",
          "Sid"
        ])
        and .Effect == "Deny"
        and .Principal == "*"
        and (.Action | action_list) == ["sqs:sendmessage"]
        and .Resource == $drillQueueArn
        and (
          .Condition
          | exact_keys(["ArnNotLike"])
            and .ArnNotLike."aws:SourceArn" == $stagingTopicArn
        )
    )
    and (
      $statements[]
      | select(.Sid == "DenyProductionAlarmArchiveInjection")
      | exact_keys([
          "Action",
          "Condition",
          "Effect",
          "Principal",
          "Resource",
          "Sid"
        ])
        and .Effect == "Deny"
        and .Principal == "*"
        and (.Action | action_list) == ["sqs:sendmessage"]
        and .Resource == $productionQueueArn
        and (
          .Condition
          | exact_keys(["ArnNotLike"])
            and (
              .ArnNotLike
              | exact_keys(["aws:SourceArn"])
                and ."aws:SourceArn" == $productionTopicArn
            )
        )
    )
    and (
      $statements[]
      | select(.Sid == "DenyInsecureTransport")
      | exact_keys([
          "Action",
          "Condition",
          "Effect",
          "Principal",
          "Resource",
          "Sid"
        ])
        and .Effect == "Deny"
        and .Principal == "*"
        and (.Action | action_list) == ["sqs:*"]
        and (
          .Resource
          | if type == "array" then sort else [] end
        ) == ([$stagingQueueArn, $drillQueueArn, $productionQueueArn] | sort)
        and (
          .Condition
          | exact_keys(["Bool"])
            and (
              .Bool
              | exact_keys(["aws:SecureTransport"])
                and ."aws:SecureTransport" == "false"
            )
        )
    )
  '

queue_tags="$(
  run_aws \
    "SQS tag discovery" \
    sqs list-queue-tags \
    --queue-url "$queue_url" \
    --region "$AWS_REGION" \
    --output json \
    --no-cli-pager
)"
require_jq \
  "SQS archive queue tags are incomplete" \
  "$queue_tags" \
  --arg app "$APP_NAME" \
  --arg environment "$ENVIRONMENT" \
  '
    (.Tags | type == "object")
    and .Tags.Application == $app
    and .Tags.Environment == $environment
    and .Tags.DataClassification == "alarm-notifications"
    and .Tags.ManagedBy == "CloudFormation"
  '

drill_queue_proven=false
if [ "$ENVIRONMENT" = "staging" ]; then
  drill_queue_name="${APP_NAME}-staging-alarm-routing-drill"
  expected_drill_queue_url="https://sqs.${AWS_REGION}.amazonaws.com/${AWS_ACCOUNT_ID}/${drill_queue_name}"
  drill_queue_url_response="$(
    run_aws \
      "SQS drill queue-url discovery" \
      sqs get-queue-url \
      --queue-name "$drill_queue_name" \
      --queue-owner-aws-account-id "$AWS_ACCOUNT_ID" \
      --region "$AWS_REGION" \
      --output json \
      --no-cli-pager
  )"
  require_jq \
    "SQS drill queue URL is not deterministic" \
    "$drill_queue_url_response" \
    --arg url "$expected_drill_queue_url" \
    '.QueueUrl == $url'
  drill_queue_url="$(jq -er '.QueueUrl' <<<"$drill_queue_url_response")"
  drill_queue="$(
    run_aws \
      "SQS drill queue-attribute discovery" \
      sqs get-queue-attributes \
      --queue-url "$drill_queue_url" \
      --attribute-names All \
      --region "$AWS_REGION" \
      --output json \
      --no-cli-pager
  )"
  archive_policy="$(jq -cer '.Attributes.Policy | fromjson | tojson' <<<"$queue")"
  require_jq \
    "SQS drill queue is outside the encrypted short-retention contract" \
    "$drill_queue" \
    --arg arn "$drill_queue_arn" \
    --arg expectedPolicy "$archive_policy" \
    --arg keyArn "$key_arn" \
    '
      .Attributes.QueueArn == $arn
      and .Attributes.KmsMasterKeyId == $keyArn
      and .Attributes.KmsDataKeyReusePeriodSeconds == "300"
      and .Attributes.MessageRetentionPeriod == "300"
      and .Attributes.ReceiveMessageWaitTimeSeconds == "20"
      and .Attributes.VisibilityTimeout == "60"
      and (.Attributes.Policy | fromjson)
        == ($expectedPolicy | fromjson)
    '
  drill_queue_tags="$(
    run_aws \
      "SQS drill queue tag discovery" \
      sqs list-queue-tags \
      --queue-url "$drill_queue_url" \
      --region "$AWS_REGION" \
      --output json \
      --no-cli-pager
  )"
  require_jq \
    "SQS drill queue tags are incomplete" \
    "$drill_queue_tags" \
    --arg app "$APP_NAME" \
    '
      (.Tags | type == "object")
      and .Tags.Application == $app
      and .Tags.Environment == "staging"
      and .Tags.DataClassification == "synthetic-operational-evidence"
      and .Tags.ManagedBy == "CloudFormation"
    '
  drill_queue_proven=true
fi

alarm_count="null"
if [ "$mode" = "verify" ]; then
  prove_alarm_configuration routed "$topic_arn"
  alarm_count="4"
fi

jq -cn \
  --arg archiveQueueArn "$queue_arn" \
  --arg contractVersion "$contract_version" \
  --arg environment "$ENVIRONMENT" \
  --arg foundationStackId "$foundation_stack_id" \
  --arg keyArn "$key_arn" \
  --arg mode "$mode" \
  --arg topicArn "$topic_arn" \
  --arg drillQueueArn "$drill_queue_arn" \
  --argjson alarmCount "$alarm_count" \
  --argjson drillQueueProven "$drill_queue_proven" \
  '{
    schema: "archon.alarm-routing.proof",
    version: 1,
    ok: true,
    mode: $mode,
    state: "active",
    contractVersion: $contractVersion,
    environment: $environment,
    foundationStackId: $foundationStackId,
    keyArn: $keyArn,
    topicArn: $topicArn,
    archiveQueueArn: $archiveQueueArn,
    drillQueueArn: $drillQueueArn,
    dedicatedDrillQueueProven: $drillQueueProven,
    alarmCount: $alarmCount
  }'
