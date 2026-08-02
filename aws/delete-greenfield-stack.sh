#!/usr/bin/env bash
# Delete a failed first deployment and only the retained resources that are
# provably owned by the exact stack and workflow run.
set -euo pipefail

for name in \
  APP_NAME \
  ENVIRONMENT \
  AWS_ACCOUNT_ID \
  AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN \
  AWS_REGION \
  GREENFIELD_OWNER \
  RECOVERY_EXECUTION_ID \
  RECOVERY_INTENT_ID \
  STACK_NAME; do
  if [ -z "${!name:-}" ]; then
    echo "$name is required for greenfield cleanup." >&2
    exit 1
  fi
done

[[ "$APP_NAME" =~ ^[a-z0-9][a-z0-9-]*$ ]]
[[ "$AWS_ACCOUNT_ID" =~ ^[0-9]{12}$ ]]
[[ "$AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN" =~ ^arn:aws:iam::${AWS_ACCOUNT_ID}:role/[A-Za-z0-9+=,.@_/-]+$ ]]
[[ "$GREENFIELD_OWNER" =~ ^[0-9a-f]{64}$ ]]
[[ "$RECOVERY_INTENT_ID" =~ ^[0-9a-f]{64}$ ]]
[[ "$RECOVERY_EXECUTION_ID" =~ ^[A-Za-z0-9][A-Za-z0-9-]{0,63}$ ]]
if [ "$ENVIRONMENT" != "staging" ] &&
   [ "$ENVIRONMENT" != "production" ]; then
  echo "Greenfield cleanup is limited to staging or production." >&2
  exit 1
fi
if [ "$AWS_REGION" != "eu-west-1" ]; then
  echo "Greenfield cleanup is limited to eu-west-1." >&2
  exit 1
fi
if [ "$STACK_NAME" != "${APP_NAME}-${ENVIRONMENT}" ]; then
  echo "The stack name does not match the exact application environment." >&2
  exit 1
fi

read_bounded_poll_setting() {
  local setting_name="$1"
  local default_value="$2"
  local minimum_value="$3"
  local maximum_value="$4"
  local output_name="$5"
  local raw_value="${!setting_name:-$default_value}"
  if ! [[ "$raw_value" =~ ^[0-9]{1,4}$ ]] ||
     [ "$((10#$raw_value))" -lt "$minimum_value" ] ||
     [ "$((10#$raw_value))" -gt "$maximum_value" ]; then
    echo "$setting_name must be an integer from $minimum_value to $maximum_value." >&2
    exit 1
  fi
  printf -v "$output_name" '%s' "$((10#$raw_value))"
}

assert_poll_phase_budget() {
  local phase_name="$1"
  local attempts="$2"
  local interval_seconds="$3"
  local maximum_seconds="$4"
  if [ "$((attempts * interval_seconds))" -gt "$maximum_seconds" ]; then
    echo "$phase_name polling exceeds its $maximum_seconds-second phase budget." >&2
    exit 1
  fi
}

# Preserve ten minutes of the one-hour OIDC session even at the hard cap. The
# stabilization phase is intentionally short: a timed-out AWS-side transition
# remains durable and a later watchdog invocation resumes from its exact state.
greenfield_total_budget_seconds=""
greenfield_stabilize_poll_attempts=""
greenfield_stabilize_poll_interval_seconds=""
greenfield_delete_poll_attempts=""
greenfield_delete_poll_interval_seconds=""
read_bounded_poll_setting \
  ARCHON_GREENFIELD_TOTAL_BUDGET_SECONDS 2400 60 3000 \
  greenfield_total_budget_seconds
read_bounded_poll_setting \
  ARCHON_GREENFIELD_STABILIZE_POLL_ATTEMPTS 12 1 30 \
  greenfield_stabilize_poll_attempts
read_bounded_poll_setting \
  ARCHON_GREENFIELD_STABILIZE_POLL_INTERVAL_SECONDS 5 0 10 \
  greenfield_stabilize_poll_interval_seconds
read_bounded_poll_setting \
  ARCHON_GREENFIELD_DELETE_POLL_ATTEMPTS 120 1 180 \
  greenfield_delete_poll_attempts
read_bounded_poll_setting \
  ARCHON_GREENFIELD_DELETE_POLL_INTERVAL_SECONDS 10 0 15 \
  greenfield_delete_poll_interval_seconds
assert_poll_phase_budget \
  "Initial greenfield stabilization" \
  "$greenfield_stabilize_poll_attempts" \
  "$greenfield_stabilize_poll_interval_seconds" \
  300
assert_poll_phase_budget \
  "Final greenfield deletion" \
  "$greenfield_delete_poll_attempts" \
  "$greenfield_delete_poll_interval_seconds" \
  1800

current_epoch="$(date +%s)"
greenfield_started_epoch="${ARCHON_GREENFIELD_STARTED_EPOCH:-$current_epoch}"
if ! [[ "$greenfield_started_epoch" =~ ^[0-9]{1,12}$ ]] ||
   [ "$((10#$greenfield_started_epoch))" -gt "$current_epoch" ]; then
  echo "ARCHON_GREENFIELD_STARTED_EPOCH must be a non-future Unix timestamp." >&2
  exit 1
fi
greenfield_started_epoch="$((10#$greenfield_started_epoch))"

ensure_greenfield_time_budget() {
  local phase_name="$1"
  local now
  local elapsed
  now="$(date +%s)"
  if [ "$now" -lt "$greenfield_started_epoch" ]; then
    echo "$phase_name observed a backwards wall clock." >&2
    return 1
  fi
  elapsed=$((now - greenfield_started_epoch))
  if [ "$elapsed" -ge "$greenfield_total_budget_seconds" ]; then
    echo "$phase_name exhausted the bounded greenfield cleanup time budget." >&2
    return 1
  fi
}

sleep_within_greenfield_budget() {
  local phase_name="$1"
  local interval_seconds="$2"
  local now
  local elapsed
  if [ "$interval_seconds" -eq 0 ]; then
    return 0
  fi
  now="$(date +%s)"
  if [ "$now" -lt "$greenfield_started_epoch" ]; then
    echo "$phase_name observed a backwards wall clock." >&2
    return 1
  fi
  elapsed=$((now - greenfield_started_epoch))
  if [ "$((elapsed + interval_seconds))" -ge \
       "$greenfield_total_budget_seconds" ]; then
    echo "$phase_name cannot sleep beyond the bounded cleanup time budget." >&2
    return 1
  fi
  sleep "$interval_seconds"
}

describe_exact_greenfield_stack_status() {
  local response
  if ! response="$(
    AWS_MAX_ATTEMPTS=1 aws \
      --cli-connect-timeout 5 \
      --cli-read-timeout 20 \
      cloudformation describe-stacks \
      --stack-name "$stack_id" \
      --region "$AWS_REGION" \
      --output json 2>&1
  )"; then
    echo "Unable to describe the exact greenfield StackId." >&2
    return 1
  fi
  jq -ser \
    --arg stack "$STACK_NAME" \
    --arg stackId "$stack_id" \
    --arg owner "$GREENFIELD_OWNER" \
    --arg app "$APP_NAME" \
    --arg environment "$ENVIRONMENT" \
    --arg role "$AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN" \
    '
      if (
        length == 1
        and (.[0] | type) == "object"
        and (.[0].Stacks | type) == "array"
        and (.[0].Stacks | length) == 1
        and .[0].Stacks[0].StackName == $stack
        and .[0].Stacks[0].StackId == $stackId
        and .[0].Stacks[0].RoleARN == $role
        and (
          (.[0].Stacks[0].Tags // [])
          | map({Key, Value})
          | sort_by(.Key)
        ) == (
          [
            {Key: "Application", Value: $app},
            {Key: "ArchonGreenfieldOwner", Value: $owner},
            {Key: "Environment", Value: $environment}
          ]
          | sort_by(.Key)
        )
        and (.[0].Stacks[0].StackStatus | type) == "string"
        and (.[0].Stacks[0].StackStatus | test("^[A-Z0-9_]+$"))
      )
      then .[0].Stacks[0].StackStatus
      else error("invalid exact greenfield stack status response")
      end
    ' <<<"$response"
}

poll_exact_greenfield_stack_status() {
  local phase_name="$1"
  local success_statuses="$2"
  local pending_statuses="$3"
  local attempt
  local status
  for ((
    attempt = 1;
    attempt <= greenfield_stabilize_poll_attempts;
    attempt++
  )); do
    ensure_greenfield_time_budget "$phase_name" || return 1
    if ! status="$(describe_exact_greenfield_stack_status)"; then
      echo "$phase_name received an invalid stack identity or JSON stream." >&2
      return 1
    fi
    case ",$success_statuses," in
      *",$status,"*) return 0 ;;
    esac
    case ",$pending_statuses," in
      *",$status,"*) ;;
      *)
        echo "$phase_name observed unexpected stack status $status." >&2
        return 1
        ;;
    esac
    if [ "$attempt" -eq "$greenfield_stabilize_poll_attempts" ]; then
      echo "$phase_name exceeded $greenfield_stabilize_poll_attempts bounded polling attempts." >&2
      return 1
    fi
    sleep_within_greenfield_budget \
      "$phase_name" \
      "$greenfield_stabilize_poll_interval_seconds" ||
      return 1
  done
}

poll_exact_greenfield_stack_deletion() {
  local phase_name="Final greenfield deletion"
  local attempt
  local response
  local status
  for ((attempt = 1; attempt <= greenfield_delete_poll_attempts; attempt++)); do
    ensure_greenfield_time_budget "$phase_name" || return 1
    if response="$(
      AWS_MAX_ATTEMPTS=1 aws \
        --cli-connect-timeout 5 \
        --cli-read-timeout 20 \
        cloudformation describe-stacks \
        --stack-name "$stack_id" \
        --region "$AWS_REGION" \
        --output json 2>&1
    )"; then
      if ! status="$(
        jq -ser \
          --arg stack "$STACK_NAME" \
          --arg stackId "$stack_id" \
          --arg owner "$GREENFIELD_OWNER" \
          --arg app "$APP_NAME" \
          --arg environment "$ENVIRONMENT" \
          --arg role "$AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN" \
          '
            if (
              length == 1
              and (.[0] | type) == "object"
              and (.[0].Stacks | type) == "array"
              and (.[0].Stacks | length) == 1
              and .[0].Stacks[0].StackName == $stack
              and .[0].Stacks[0].StackId == $stackId
              and .[0].Stacks[0].RoleARN == $role
              and (
                (.[0].Stacks[0].Tags // [])
                | map({Key, Value})
                | sort_by(.Key)
              ) == (
                [
                  {Key: "Application", Value: $app},
                  {Key: "ArchonGreenfieldOwner", Value: $owner},
                  {Key: "Environment", Value: $environment}
                ]
                | sort_by(.Key)
              )
              and (.[0].Stacks[0].StackStatus | type) == "string"
            )
            then .[0].Stacks[0].StackStatus
            else error("invalid exact deleting stack response")
            end
          ' <<<"$response"
      )"; then
        echo "$phase_name received an invalid stack identity or JSON stream." >&2
        return 1
      fi
      if [ "$status" != "DELETE_IN_PROGRESS" ]; then
        echo "$phase_name observed unexpected stack status $status." >&2
        return 1
      fi
    elif grep -Fq "ValidationError" <<<"$response" &&
         grep -Fq "does not exist" <<<"$response" &&
         grep -Fq "$stack_id" <<<"$response"; then
      return 0
    else
      echo "$phase_name could not prove exact StackId deletion." >&2
      return 1
    fi
    if [ "$attempt" -eq "$greenfield_delete_poll_attempts" ]; then
      echo "$phase_name exceeded $greenfield_delete_poll_attempts bounded polling attempts." >&2
      return 1
    fi
    sleep_within_greenfield_budget \
      "$phase_name" \
      "$greenfield_delete_poll_interval_seconds" ||
      return 1
  done
}

bucket="${APP_NAME}-${ENVIRONMENT}-web-${AWS_ACCOUNT_ID}-${AWS_REGION}"
legacy_api_log_group="/aws/apigateway/${APP_NAME}-${ENVIRONMENT}"
vended_api_log_group="/aws/vendedlogs/apigateway/${APP_NAME}-${ENVIRONMENT}"
lambda_log_group="/aws/lambda/${APP_NAME}-${ENVIRONMENT}-api"
legacy_api_log_arn="arn:aws:logs:${AWS_REGION}:${AWS_ACCOUNT_ID}:log-group:${legacy_api_log_group}"
vended_api_log_arn="arn:aws:logs:${AWS_REGION}:${AWS_ACCOUNT_ID}:log-group:${vended_api_log_group}"
lambda_log_arn="arn:aws:logs:${AWS_REGION}:${AWS_ACCOUNT_ID}:log-group:${lambda_log_group}"

bucket_owner_state() {
  local expected_stack_id="${1:-}"
  local result
  local resource_stack_id
  if result="$(
    aws s3api get-bucket-tagging \
      --bucket "$bucket" \
      --expected-bucket-owner "$AWS_ACCOUNT_ID" \
      --region "$AWS_REGION" \
      --output json 2>&1
  )"; then
    if resource_stack_id="$(
      jq -er \
      --arg owner "$GREENFIELD_OWNER" \
      --arg app "$APP_NAME" \
      --arg environment "$ENVIRONMENT" \
      --arg stack "$STACK_NAME" \
      --arg stackPrefix \
        "arn:aws:cloudformation:${AWS_REGION}:${AWS_ACCOUNT_ID}:stack/${STACK_NAME}/" \
      --arg expectedStackId "$expected_stack_id" \
      '
        def exact_tag($key; $value):
          [.TagSet[]? | select(.Key == $key) | .Value] == [$value];
        [
          .TagSet[]?
          | select(.Key == "aws:cloudformation:stack-id")
          | .Value
        ] as $stackIds
        | if (
            exact_tag("ArchonGreenfieldOwner"; $owner)
            and exact_tag("Application"; $app)
            and exact_tag("Environment"; $environment)
            and exact_tag("aws:cloudformation:stack-name"; $stack)
            and exact_tag("aws:cloudformation:logical-id"; "SpaBucket")
            and ($stackIds | length) == 1
            and ($stackIds[0] | startswith($stackPrefix))
            and (
              $expectedStackId == ""
              or $stackIds[0] == $expectedStackId
            )
          )
          then $stackIds[0]
          else error("invalid retained bucket identity")
          end
      ' <<<"$result" 2>/dev/null
    )"; then
      printf 'owned:%s\n' "$resource_stack_id"
      return 0
    fi
    echo "The retained bucket is not owned by this greenfield run." >&2
    return 1
  fi
  if [[ "$result" =~ (^|[^[:alnum:]])NoSuchBucket([^[:alnum:]]|$) ]]; then
    printf '%s\n' absent
    return 0
  fi
  echo "Unable to prove retained bucket ownership." >&2
  return 1
}

log_owner_state() {
  local log_arn="$1"
  local logical_id="$2"
  local expected_stack_id="${3:-}"
  local result
  local resource_stack_id
  if result="$(
    aws logs list-tags-for-resource \
      --resource-arn "$log_arn" \
      --region "$AWS_REGION" \
      --output json 2>&1
  )"; then
    if resource_stack_id="$(
      jq -er \
      --arg owner "$GREENFIELD_OWNER" \
      --arg app "$APP_NAME" \
      --arg environment "$ENVIRONMENT" \
      --arg stack "$STACK_NAME" \
      --arg logicalId "$logical_id" \
      --arg stackPrefix \
        "arn:aws:cloudformation:${AWS_REGION}:${AWS_ACCOUNT_ID}:stack/${STACK_NAME}/" \
      --arg expectedStackId "$expected_stack_id" \
      '
        if (
          .tags.ArchonGreenfieldOwner == $owner
          and .tags.Application == $app
          and .tags.Environment == $environment
          and .tags["aws:cloudformation:stack-name"] == $stack
          and .tags["aws:cloudformation:logical-id"] == $logicalId
          and (
            .tags["aws:cloudformation:stack-id"]
            | type == "string"
            and startswith($stackPrefix)
          )
          and (
            $expectedStackId == ""
            or .tags["aws:cloudformation:stack-id"] == $expectedStackId
          )
        )
        then .tags["aws:cloudformation:stack-id"]
        else error("invalid retained log-group identity")
        end
      ' <<<"$result" 2>/dev/null
    )"; then
      printf 'owned:%s\n' "$resource_stack_id"
      return 0
    fi
    echo "A retained log group is not owned by this greenfield run." >&2
    return 1
  fi
  if grep -qi "ResourceNotFoundException" <<<"$result"; then
    printf '%s\n' absent
    return 0
  fi
  echo "Unable to prove retained log-group ownership." >&2
  return 1
}

assert_bucket_absent() {
  local result
  if result="$(
    aws s3api get-bucket-location \
      --bucket "$bucket" \
      --expected-bucket-owner "$AWS_ACCOUNT_ID" \
      --region "$AWS_REGION" \
      --output json 2>&1
  )"; then
    echo "An unowned retained bucket exists; refusing cleanup." >&2
    return 1
  fi
  if ! [[ "$result" =~ (^|[^[:alnum:]])NoSuchBucket([^[:alnum:]]|$) ]]; then
    echo "Unable to prove that the retained bucket is absent." >&2
    return 1
  fi
}

assert_log_absent() {
  local log_arn="$1"
  local result
  if result="$(
    aws logs list-tags-for-resource \
      --resource-arn "$log_arn" \
      --region "$AWS_REGION" \
      --output json 2>&1
  )"; then
    echo "An unowned retained log group exists; refusing cleanup." >&2
    return 1
  fi
  if ! grep -qi "ResourceNotFoundException" <<<"$result"; then
    echo "Unable to prove that a retained log group is absent." >&2
    return 1
  fi
}

resource_is_stack_owned() {
  local resources="$1"
  local logical_id="$2"
  local resource_type="$3"
  local physical_id="$4"
  jq -er \
    --arg logicalId "$logical_id" \
    --arg resourceType "$resource_type" \
    --arg physicalId "$physical_id" \
    '
      [.StackResources[]?
        | select(.LogicalResourceId == $logicalId)] as $matches
      | if ($matches | length) == 0
        then "false"
        elif (
          ($matches | length) == 1
          and $matches[0].ResourceType == $resourceType
          and $matches[0].PhysicalResourceId == $physicalId
        )
        then "true"
        else error("invalid retained-resource stack membership")
        end
    ' <<<"$resources"
}

stack_deleted=false
stack_absent=false
stack_id=""
bucket_stack_owned=false
legacy_log_stack_owned=false
vended_log_stack_owned=false
lambda_log_stack_owned=false
if stack_state="$(
  aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --region "$AWS_REGION" \
    --output json 2>&1
)"; then
  stack_identity="$(
    jq -cs \
      --arg stack "$STACK_NAME" \
      --arg prefix \
        "arn:aws:cloudformation:${AWS_REGION}:${AWS_ACCOUNT_ID}:stack/${STACK_NAME}/" \
      --arg owner "$GREENFIELD_OWNER" \
      --arg app "$APP_NAME" \
      --arg environment "$ENVIRONMENT" \
      --arg role "$AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN" \
      '
        (
          if (
            length == 1
            and (.[0] | type) == "object"
            and (.[0].Stacks | type) == "array"
            and (.[0].Stacks | length) == 1
          )
          then .[0].Stacks[0]
          else error("invalid greenfield stack response stream")
          end
        ) as $candidate
        | (
          $candidate.StackName == $stack
          and ($candidate.StackId | startswith($prefix))
          and $candidate.RoleARN == $role
          and (
            $candidate.EnableTerminationProtection
            | type == "boolean"
          )
          and (
            $candidate.StackStatus == "REVIEW_IN_PROGRESS"
            or $candidate.StackStatus == "CREATE_IN_PROGRESS"
            or $candidate.StackStatus == "CREATE_COMPLETE"
            or $candidate.StackStatus == "CREATE_FAILED"
            or $candidate.StackStatus == "ROLLBACK_IN_PROGRESS"
            or $candidate.StackStatus == "ROLLBACK_COMPLETE"
            or $candidate.StackStatus == "ROLLBACK_FAILED"
            or $candidate.StackStatus == "UPDATE_IN_PROGRESS"
            or $candidate.StackStatus == "UPDATE_COMPLETE_CLEANUP_IN_PROGRESS"
            or $candidate.StackStatus == "UPDATE_COMPLETE"
            or $candidate.StackStatus == "UPDATE_FAILED"
            or $candidate.StackStatus == "UPDATE_ROLLBACK_IN_PROGRESS"
            or $candidate.StackStatus == "UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS"
            or $candidate.StackStatus == "UPDATE_ROLLBACK_COMPLETE"
            or $candidate.StackStatus == "UPDATE_ROLLBACK_FAILED"
            or $candidate.StackStatus == "DELETE_IN_PROGRESS"
            or $candidate.StackStatus == "DELETE_FAILED"
          )
          and (
            ($candidate.Tags // [])
            | map({Key, Value})
            | sort_by(.Key)
          ) == (
            [
              {Key: "Application", Value: $app},
              {Key: "ArchonGreenfieldOwner", Value: $owner},
              {Key: "Environment", Value: $environment}
            ]
            | sort_by(.Key)
          )
        )
        | if . then {
            stackId: $candidate.StackId,
            stackStatus: $candidate.StackStatus,
            terminationProtection:
              $candidate.EnableTerminationProtection
          }
          else error("invalid greenfield stack ownership")
          end
      ' <<<"$stack_state"
  )"
  stack_id="$(jq -er '.stackId' <<<"$stack_identity")"
  stack_status="$(jq -er '.stackStatus' <<<"$stack_identity")"
  termination_protection="$(
    jq -er \
      '.terminationProtection
       | if type == "boolean"
         then tostring
         else error("invalid termination-protection state")
         end' \
      <<<"$stack_identity"
  )"
  greenfield_wait_attempt="${ARCHON_GREENFIELD_WAIT_ATTEMPT:-0}"
  if ! [[ "$greenfield_wait_attempt" =~ ^[0-4]$ ]]; then
    echo "ARCHON_GREENFIELD_WAIT_ATTEMPT must be an integer from 0 to 4." >&2
    exit 1
  fi
  recovery_cancelled="${RECOVERY_CANCELLED:-false}"
  case "$recovery_cancelled" in
    true|false) ;;
    *)
      echo "RECOVERY_CANCELLED must be true or false." >&2
      exit 1
      ;;
  esac

  delete_greenfield_stack() {
    local status="$1"
    local delete_token="archon-delete-${RECOVERY_INTENT_ID:0:48}"
    local live_stack
    local live_protection
    local update_result
    if [ "$status" = "DELETE_FAILED" ]; then
      local retry_attempt="${ARCHON_GREENFIELD_WAIT_ATTEMPT:-0}"
      [[ "$retry_attempt" =~ ^[0-9]+$ ]]
      delete_token="archon-retry-${RECOVERY_INTENT_ID:0:32}-${RECOVERY_EXECUTION_ID:0:32}-${retry_attempt}"
    fi

    # A successful greenfield terminal gate may have enabled protection before
    # a later runner/watchdog interruption. Re-prove the exact owned stack,
    # disable protection only for that immutable StackId, and re-prove before
    # issuing the delete.
    live_stack="$(
      aws cloudformation describe-stacks \
        --stack-name "$stack_id" \
        --region "$AWS_REGION" \
        --output json
    )"
    live_protection="$(
      jq -er \
        --arg stack "$STACK_NAME" \
        --arg stackId "$stack_id" \
        --arg owner "$GREENFIELD_OWNER" \
        --arg app "$APP_NAME" \
        --arg environment "$ENVIRONMENT" \
        --arg role "$AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN" \
        '
          .Stacks[0] as $candidate
          | if (
              (.Stacks | length) == 1
              and $candidate.StackName == $stack
              and $candidate.StackId == $stackId
              and $candidate.RoleARN == $role
              and (
                $candidate.EnableTerminationProtection
                | type == "boolean"
              )
              and (
                ($candidate.Tags // [])
                | map({Key, Value})
                | sort_by(.Key)
              ) == (
                [
                  {Key: "Application", Value: $app},
                  {Key: "ArchonGreenfieldOwner", Value: $owner},
                  {Key: "Environment", Value: $environment}
                ]
                | sort_by(.Key)
              )
            )
            then ($candidate.EnableTerminationProtection | tostring)
            else error("invalid protected greenfield stack identity")
            end
        ' <<<"$live_stack"
    )"
    case "$live_protection" in
      true)
        update_result="$(
          aws cloudformation update-termination-protection \
            --stack-name "$stack_id" \
            --no-enable-termination-protection \
            --region "$AWS_REGION" \
            --output json
        )"
        jq -e \
          --arg stackId "$stack_id" \
          '.StackId == $stackId' <<<"$update_result" >/dev/null
        live_stack="$(
          aws cloudformation describe-stacks \
            --stack-name "$stack_id" \
            --region "$AWS_REGION" \
            --output json
        )"
        jq -e \
          --arg stack "$STACK_NAME" \
          --arg stackId "$stack_id" \
          --arg owner "$GREENFIELD_OWNER" \
          --arg app "$APP_NAME" \
          --arg environment "$ENVIRONMENT" \
          --arg role "$AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN" \
          '
            (.Stacks | length) == 1
            and .Stacks[0].StackName == $stack
            and .Stacks[0].StackId == $stackId
            and .Stacks[0].RoleARN == $role
            and .Stacks[0].EnableTerminationProtection == false
            and (
              (.Stacks[0].Tags // [])
              | map({Key, Value})
              | sort_by(.Key)
            ) == (
              [
                {Key: "Application", Value: $app},
                {Key: "ArchonGreenfieldOwner", Value: $owner},
                {Key: "Environment", Value: $environment}
              ]
              | sort_by(.Key)
            )
          ' <<<"$live_stack" >/dev/null
        termination_protection=false
        ;;
      false)
        termination_protection=false
        ;;
      *)
        echo "Invalid greenfield termination-protection state." >&2
        exit 1
        ;;
    esac
    test "$termination_protection" = "false"
    aws cloudformation delete-stack \
      --stack-name "$stack_id" \
      --region "$AWS_REGION" \
      --role-arn "$AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN" \
      --client-request-token "$delete_token"
  }

  retry_after_stack_stabilizes() {
    if [ "$greenfield_wait_attempt" -ge 4 ]; then
      echo "The greenfield stack did not reach a deletable state." >&2
      exit 1
    fi
    exec env \
      ARCHON_GREENFIELD_STARTED_EPOCH="$greenfield_started_epoch" \
      ARCHON_GREENFIELD_WAIT_ATTEMPT="$((greenfield_wait_attempt + 1))" \
      bash "$0"
  }

  intent_token="${RECOVERY_INTENT_ID:0:48}"
  cancel_token="archon-cancel-${intent_token}"
  rollback_token="archon-rollback-${intent_token}"
  continue_token="archon-continue-${intent_token}"

  # A cancelled GitHub job has only a short grace period. Start an AWS-side
  # operation that outlives the runner, then return without a service waiter.
  if [ "$recovery_cancelled" = "true" ]; then
    case "$stack_status" in
      UPDATE_IN_PROGRESS)
        aws cloudformation cancel-update-stack \
          --stack-name "$stack_id" \
          --client-request-token "$cancel_token" \
          --region "$AWS_REGION"
        ;;
      UPDATE_FAILED)
        aws cloudformation rollback-stack \
          --stack-name "$stack_id" \
          --role-arn "$AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN" \
          --client-request-token "$rollback_token" \
          --retain-except-on-create \
          --region "$AWS_REGION"
        ;;
      UPDATE_ROLLBACK_FAILED)
        aws cloudformation continue-update-rollback \
          --stack-name "$stack_id" \
          --role-arn "$AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN" \
          --client-request-token "$continue_token" \
          --region "$AWS_REGION"
        ;;
      CREATE_IN_PROGRESS|\
      REVIEW_IN_PROGRESS|\
      CREATE_COMPLETE|\
      CREATE_FAILED|\
      ROLLBACK_COMPLETE|\
      ROLLBACK_FAILED|\
      UPDATE_COMPLETE|\
      UPDATE_ROLLBACK_COMPLETE|\
      DELETE_FAILED)
        delete_greenfield_stack "$stack_status"
        ;;
      ROLLBACK_IN_PROGRESS|\
      UPDATE_COMPLETE_CLEANUP_IN_PROGRESS|\
      UPDATE_ROLLBACK_IN_PROGRESS|\
      UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS|\
      DELETE_IN_PROGRESS) ;;
      *)
        echo "The cancelled greenfield deployment is not safe to hand off." >&2
        exit 1
        ;;
    esac
    echo "Greenfield cancellation recovery was handed off durably."
    exit 0
  fi

  case "$stack_status" in
    UPDATE_IN_PROGRESS)
      aws cloudformation cancel-update-stack \
        --stack-name "$stack_id" \
        --client-request-token "$cancel_token" \
        --region "$AWS_REGION"
      if ! poll_exact_greenfield_stack_status \
        "Initial greenfield rollback stabilization" \
        "UPDATE_ROLLBACK_COMPLETE" \
        "UPDATE_ROLLBACK_IN_PROGRESS,UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS"; then
        echo "CloudFormation retains the rollback for a later watchdog retry." >&2
        exit 1
      fi
      retry_after_stack_stabilizes
      ;;
    UPDATE_COMPLETE_CLEANUP_IN_PROGRESS)
      if ! poll_exact_greenfield_stack_status \
        "Initial greenfield update cleanup stabilization" \
        "UPDATE_COMPLETE" \
        "UPDATE_COMPLETE_CLEANUP_IN_PROGRESS"; then
        echo "CloudFormation retains the update cleanup for a later watchdog retry." >&2
        exit 1
      fi
      retry_after_stack_stabilizes
      ;;
    UPDATE_FAILED)
      aws cloudformation rollback-stack \
        --stack-name "$stack_id" \
        --role-arn "$AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN" \
        --client-request-token "$rollback_token" \
        --retain-except-on-create \
        --region "$AWS_REGION"
      if ! poll_exact_greenfield_stack_status \
        "Initial greenfield explicit rollback stabilization" \
        "UPDATE_ROLLBACK_COMPLETE" \
        "UPDATE_ROLLBACK_IN_PROGRESS,UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS"; then
        echo "CloudFormation retains the rollback for a later watchdog retry." >&2
        exit 1
      fi
      retry_after_stack_stabilizes
      ;;
    ROLLBACK_IN_PROGRESS)
      if ! poll_exact_greenfield_stack_status \
        "Initial greenfield create rollback stabilization" \
        "ROLLBACK_COMPLETE" \
        "ROLLBACK_IN_PROGRESS"; then
        echo "CloudFormation retains the rollback for a later watchdog retry." >&2
        exit 1
      fi
      retry_after_stack_stabilizes
      ;;
    UPDATE_ROLLBACK_IN_PROGRESS|\
    UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS)
      if ! poll_exact_greenfield_stack_status \
        "Initial greenfield in-flight rollback stabilization" \
        "UPDATE_ROLLBACK_COMPLETE" \
        "UPDATE_ROLLBACK_IN_PROGRESS,UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS"; then
        echo "CloudFormation retains the rollback for a later watchdog retry." >&2
        exit 1
      fi
      retry_after_stack_stabilizes
      ;;
    UPDATE_ROLLBACK_FAILED)
      aws cloudformation continue-update-rollback \
        --stack-name "$stack_id" \
        --role-arn "$AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN" \
        --client-request-token "$continue_token" \
        --region "$AWS_REGION"
      if ! poll_exact_greenfield_stack_status \
        "Initial greenfield continued rollback stabilization" \
        "UPDATE_ROLLBACK_COMPLETE" \
        "UPDATE_ROLLBACK_IN_PROGRESS,UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS"; then
        echo "CloudFormation retains the rollback for a later watchdog retry." >&2
        exit 1
      fi
      retry_after_stack_stabilizes
      ;;
  esac

  stack_resources="$(
    aws cloudformation describe-stack-resources \
      --stack-name "$stack_id" \
      --region "$AWS_REGION" \
      --output json
  )"
  bucket_stack_owned="$(
    resource_is_stack_owned \
      "$stack_resources" \
      SpaBucket \
      AWS::S3::Bucket \
      "$bucket"
  )"
  legacy_log_stack_owned="$(
    resource_is_stack_owned \
      "$stack_resources" \
      ApiAccessLogGroup \
      AWS::Logs::LogGroup \
      "$legacy_api_log_group"
  )"
  vended_log_stack_owned="$(
    resource_is_stack_owned \
      "$stack_resources" \
      ApiVendedAccessLogGroup \
      AWS::Logs::LogGroup \
      "$vended_api_log_group"
  )"
  lambda_log_stack_owned="$(
    resource_is_stack_owned \
      "$stack_resources" \
      ArchonFunctionLogGroup \
      AWS::Logs::LogGroup \
      "$lambda_log_group"
  )"

  if [ "$bucket_stack_owned" = "true" ]; then
    bucket_state="$(bucket_owner_state "$stack_id")"
    test "$bucket_state" = "owned:$stack_id" ||
      test "$bucket_state" = "absent"
  fi
  if [ "$legacy_log_stack_owned" = "true" ]; then
    log_state="$(
      log_owner_state \
        "$legacy_api_log_arn" \
        ApiAccessLogGroup \
        "$stack_id"
    )"
    test "$log_state" = "owned:$stack_id" ||
      test "$log_state" = "absent"
  fi
  if [ "$vended_log_stack_owned" = "true" ]; then
    log_state="$(
      log_owner_state \
        "$vended_api_log_arn" \
        ApiVendedAccessLogGroup \
        "$stack_id"
    )"
    test "$log_state" = "owned:$stack_id" ||
      test "$log_state" = "absent"
  fi
  if [ "$lambda_log_stack_owned" = "true" ]; then
    log_state="$(
      log_owner_state \
        "$lambda_log_arn" \
        ArchonFunctionLogGroup \
        "$stack_id"
    )"
    test "$log_state" = "owned:$stack_id" ||
      test "$log_state" = "absent"
  fi

  if [ "$stack_status" != "DELETE_IN_PROGRESS" ]; then
    delete_greenfield_stack "$stack_status"
  fi
  if ! poll_exact_greenfield_stack_deletion; then
    echo "CloudFormation retains the deletion for a later watchdog retry." >&2
    exit 1
  fi
  stack_deleted=true
elif ! grep -qi "does not exist" <<<"$stack_state"; then
  echo "Unable to determine the failed greenfield stack state." >&2
  exit 1
else
  stack_absent=true
fi

if [ "$stack_absent" = "true" ]; then
  bucket_state="$(bucket_owner_state)"
  legacy_log_state="$(
    log_owner_state "$legacy_api_log_arn" ApiAccessLogGroup
  )"
  vended_log_state="$(
    log_owner_state "$vended_api_log_arn" ApiVendedAccessLogGroup
  )"
  lambda_log_state="$(
    log_owner_state "$lambda_log_arn" ArchonFunctionLogGroup
  )"
  for state in \
    "$bucket_state" \
    "$legacy_log_state" \
    "$vended_log_state" \
    "$lambda_log_state"; do
    case "$state" in
      absent) ;;
      owned:*)
        resource_stack_id="${state#owned:}"
        if [ -z "$stack_id" ]; then
          stack_id="$resource_stack_id"
        else
          test "$stack_id" = "$resource_stack_id"
        fi
        ;;
      *)
        echo "Invalid retained-resource ownership state." >&2
        exit 1
        ;;
    esac
  done
  if [[ "$bucket_state" == owned:* ]]; then
    bucket_stack_owned=true
  fi
  if [[ "$legacy_log_state" == owned:* ]]; then
    legacy_log_stack_owned=true
  fi
  if [[ "$vended_log_state" == owned:* ]]; then
    vended_log_stack_owned=true
  fi
  if [[ "$lambda_log_state" == owned:* ]]; then
    lambda_log_stack_owned=true
  fi
fi

delete_file="$(mktemp)"
trap 'rm -f "$delete_file"' EXIT
bucket_deleted=false
if [ "$bucket_stack_owned" = "true" ]; then
  bucket_state="$(bucket_owner_state "$stack_id")"
  if [ "$bucket_state" = "owned:$stack_id" ]; then
    emptied=false
    for attempt in $(seq 1 101); do
      test "$(bucket_owner_state "$stack_id")" = "owned:$stack_id"
      inventory="$(
        aws s3api list-object-versions \
          --bucket "$bucket" \
          --expected-bucket-owner "$AWS_ACCOUNT_ID" \
          --max-keys 1000 \
          --no-paginate \
          --region "$AWS_REGION" \
          --output json
      )"
      object_count="$(
        jq -er \
          '[.Versions[]?, .DeleteMarkers[]?] | length' \
          <<<"$inventory"
      )"
      if [ "$object_count" -eq 0 ]; then
        emptied=true
        break
      fi
      if [ "$attempt" -eq 101 ]; then
        echo "Greenfield bucket cleanup exceeded 100 bounded batches." >&2
        exit 1
      fi
      jq -e \
        '{
          Objects: [
            (.Versions[]?, .DeleteMarkers[]?)
            | {Key: .Key, VersionId: .VersionId}
          ],
          Quiet: true
        }' <<<"$inventory" >"$delete_file"
      delete_result="$(
        aws s3api delete-objects \
          --bucket "$bucket" \
          --expected-bucket-owner "$AWS_ACCOUNT_ID" \
          --delete "file://${delete_file}" \
          --region "$AWS_REGION" \
          --output json
      )"
      jq -e '((.Errors // []) | length) == 0' \
        <<<"$delete_result" >/dev/null
    done
    if [ "$emptied" != "true" ]; then
      echo "The retained greenfield bucket was not emptied." >&2
      exit 1
    fi
    test "$(bucket_owner_state "$stack_id")" = "owned:$stack_id"
    aws s3api delete-bucket \
      --bucket "$bucket" \
      --expected-bucket-owner "$AWS_ACCOUNT_ID" \
      --region "$AWS_REGION"
    bucket_deleted=true
  fi
else
  assert_bucket_absent
fi

deleted_log_groups=0
delete_owned_log_group() {
  local stack_owned="$1"
  local log_group="$2"
  local log_arn="$3"
  local logical_id="$4"
  local state
  if [ "$stack_owned" != "true" ]; then
    assert_log_absent "$log_arn"
    return
  fi
  state="$(log_owner_state "$log_arn" "$logical_id" "$stack_id")"
  if [ "$state" = "absent" ]; then
    return
  fi
  test "$state" = "owned:$stack_id"
  aws logs delete-log-group \
    --log-group-name "$log_group" \
    --region "$AWS_REGION"
  deleted_log_groups=$((deleted_log_groups + 1))
}

delete_owned_log_group \
  "$legacy_log_stack_owned" \
  "$legacy_api_log_group" \
  "$legacy_api_log_arn" \
  ApiAccessLogGroup
delete_owned_log_group \
  "$vended_log_stack_owned" \
  "$vended_api_log_group" \
  "$vended_api_log_arn" \
  ApiVendedAccessLogGroup
delete_owned_log_group \
  "$lambda_log_stack_owned" \
  "$lambda_log_group" \
  "$lambda_log_arn" \
  ArchonFunctionLogGroup

result_state="greenfield-cleaned"
if [ "$stack_deleted" = "false" ] &&
   [ "$bucket_deleted" = "false" ] &&
   [ "$deleted_log_groups" -eq 0 ]; then
  result_state="greenfield-stack-absent"
fi

jq -n \
  --arg stack "$STACK_NAME" \
  --arg stackId "$stack_id" \
  --arg state "$result_state" \
  --argjson stackDeleted "$stack_deleted" \
  --argjson bucketDeleted "$bucket_deleted" \
  --argjson logGroupsDeleted "$deleted_log_groups" \
  '{
    ok: true,
    schema: "archon.greenfield-cleanup.proof",
    version: 1,
    state: $state,
    stack: $stack,
    stackId: (if $stackId == "" then null else $stackId end),
    stackDeleted: $stackDeleted,
    retainedBucketDeleted: $bucketDeleted,
    retainedLogGroupsDeleted: $logGroupsDeleted
  }'
