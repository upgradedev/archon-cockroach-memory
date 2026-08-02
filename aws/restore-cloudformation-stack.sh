#!/usr/bin/env bash
# Restore an existing application stack from the exact pre-deployment template,
# parameter, and tag snapshots captured by the protected release job.
set -euo pipefail

for name in \
  STACK_NAME \
  AWS_ACCOUNT_ID \
  AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN \
  AWS_REGION \
  EXPECTED_PREVIOUS_STACK_ID \
  EXPECTED_PREVIOUS_STACK_TEMPLATE_SHA256 \
  EXPECTED_PREVIOUS_STACK_PARAMETERS_SHA256 \
  EXPECTED_PREVIOUS_STACK_TAGS_SHA256 \
  RECOVERY_INTENT_ID; do
  if [ -z "${!name:-}" ]; then
    echo "$name is required for CloudFormation recovery." >&2
    exit 1
  fi
done

[[ "$AWS_ACCOUNT_ID" =~ ^[0-9]{12}$ ]]
[[ "$AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN" =~ ^arn:aws:iam::${AWS_ACCOUNT_ID}:role/[A-Za-z0-9+=,.@_/-]+$ ]]
[[ "$RECOVERY_INTENT_ID" =~ ^[0-9a-f]{64}$ ]]
test "$AWS_REGION" = "eu-west-1"
expected_stack_prefix="arn:aws:cloudformation:${AWS_REGION}:${AWS_ACCOUNT_ID}:stack/${STACK_NAME}/"
[[ "$EXPECTED_PREVIOUS_STACK_ID" == "$expected_stack_prefix"* ]]

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

# The default wait budget is 40 minutes and the hard cap is 50 minutes, leaving
# at least ten minutes of the one-hour OIDC session for API calls, verification,
# and a later durable watchdog handoff. Phase products are capped independently
# so an override cannot turn a single poll loop into a service-waiter equivalent.
recovery_total_budget_seconds=""
recovery_stabilize_poll_attempts=""
recovery_stabilize_poll_interval_seconds=""
recovery_change_set_poll_attempts=""
recovery_change_set_poll_interval_seconds=""
recovery_final_poll_attempts=""
recovery_final_poll_interval_seconds=""
read_bounded_poll_setting \
  ARCHON_RECOVERY_TOTAL_BUDGET_SECONDS 2400 60 3000 \
  recovery_total_budget_seconds
read_bounded_poll_setting \
  ARCHON_RECOVERY_STABILIZE_POLL_ATTEMPTS 12 1 30 \
  recovery_stabilize_poll_attempts
read_bounded_poll_setting \
  ARCHON_RECOVERY_STABILIZE_POLL_INTERVAL_SECONDS 5 0 10 \
  recovery_stabilize_poll_interval_seconds
read_bounded_poll_setting \
  ARCHON_RECOVERY_CHANGE_SET_POLL_ATTEMPTS 60 1 90 \
  recovery_change_set_poll_attempts
read_bounded_poll_setting \
  ARCHON_RECOVERY_CHANGE_SET_POLL_INTERVAL_SECONDS 5 0 10 \
  recovery_change_set_poll_interval_seconds
read_bounded_poll_setting \
  ARCHON_RECOVERY_FINAL_POLL_ATTEMPTS 120 1 180 \
  recovery_final_poll_attempts
read_bounded_poll_setting \
  ARCHON_RECOVERY_FINAL_POLL_INTERVAL_SECONDS 10 0 15 \
  recovery_final_poll_interval_seconds
assert_poll_phase_budget \
  "Initial stabilization" \
  "$recovery_stabilize_poll_attempts" \
  "$recovery_stabilize_poll_interval_seconds" \
  300
assert_poll_phase_budget \
  "Change-set creation" \
  "$recovery_change_set_poll_attempts" \
  "$recovery_change_set_poll_interval_seconds" \
  600
assert_poll_phase_budget \
  "Final restore" \
  "$recovery_final_poll_attempts" \
  "$recovery_final_poll_interval_seconds" \
  1800

current_epoch="$(date +%s)"
recovery_started_epoch="${ARCHON_RECOVERY_STARTED_EPOCH:-$current_epoch}"
if ! [[ "$recovery_started_epoch" =~ ^[0-9]{1,12}$ ]] ||
   [ "$((10#$recovery_started_epoch))" -gt "$current_epoch" ]; then
  echo "ARCHON_RECOVERY_STARTED_EPOCH must be a non-future Unix timestamp." >&2
  exit 1
fi
recovery_started_epoch="$((10#$recovery_started_epoch))"

ensure_recovery_time_budget() {
  local phase_name="$1"
  local now
  local elapsed
  now="$(date +%s)"
  if [ "$now" -lt "$recovery_started_epoch" ]; then
    echo "$phase_name observed a backwards wall clock." >&2
    return 1
  fi
  elapsed=$((now - recovery_started_epoch))
  if [ "$elapsed" -ge "$recovery_total_budget_seconds" ]; then
    echo "$phase_name exhausted the bounded recovery time budget." >&2
    return 1
  fi
}

sleep_within_recovery_budget() {
  local phase_name="$1"
  local interval_seconds="$2"
  local now
  local elapsed
  if [ "$interval_seconds" -eq 0 ]; then
    return 0
  fi
  now="$(date +%s)"
  if [ "$now" -lt "$recovery_started_epoch" ]; then
    echo "$phase_name observed a backwards wall clock." >&2
    return 1
  fi
  elapsed=$((now - recovery_started_epoch))
  if [ "$((elapsed + interval_seconds))" -ge \
       "$recovery_total_budget_seconds" ]; then
    echo "$phase_name cannot sleep beyond the bounded recovery time budget." >&2
    return 1
  fi
  sleep "$interval_seconds"
}

describe_exact_stack_status() {
  local response
  if ! response="$(
    AWS_MAX_ATTEMPTS=1 aws \
      --cli-connect-timeout 5 \
      --cli-read-timeout 20 \
      cloudformation describe-stacks \
      --stack-name "$EXPECTED_PREVIOUS_STACK_ID" \
      --region "$AWS_REGION" \
      --output json 2>&1
  )"; then
    echo "Unable to describe the exact recovery StackId." >&2
    return 1
  fi
  jq -ser \
    --arg stack "$STACK_NAME" \
    --arg stackId "$EXPECTED_PREVIOUS_STACK_ID" \
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
        and (.[0].Stacks[0].StackStatus | type) == "string"
        and (.[0].Stacks[0].StackStatus | test("^[A-Z0-9_]+$"))
      )
      then .[0].Stacks[0].StackStatus
      else error("invalid exact recovery stack status response")
      end
    ' <<<"$response"
}

poll_exact_stack_status() {
  local phase_name="$1"
  local success_statuses="$2"
  local pending_statuses="$3"
  local attempts="$4"
  local interval_seconds="$5"
  local attempt
  local status
  for ((attempt = 1; attempt <= attempts; attempt++)); do
    ensure_recovery_time_budget "$phase_name" || return 1
    if ! status="$(describe_exact_stack_status)"; then
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
    if [ "$attempt" -eq "$attempts" ]; then
      echo "$phase_name exceeded $attempts bounded polling attempts." >&2
      return 1
    fi
    sleep_within_recovery_budget "$phase_name" "$interval_seconds" ||
      return 1
  done
}

polled_change_set=""
poll_exact_change_set_creation() {
  local phase_name="Recovery change-set creation"
  local attempt
  local response
  local state
  local status
  local execution_status
  for ((
    attempt = 1;
    attempt <= recovery_change_set_poll_attempts;
    attempt++
  )); do
    ensure_recovery_time_budget "$phase_name" || return 1
    if ! response="$(
      AWS_MAX_ATTEMPTS=1 aws \
        --cli-connect-timeout 5 \
        --cli-read-timeout 20 \
        cloudformation describe-change-set \
        --stack-name "$stack_target" \
        --change-set-name "$change_set_id" \
        --region "$AWS_REGION" \
        --output json 2>&1
    )"; then
      echo "$phase_name could not describe the exact change set." >&2
      return 1
    fi
    if ! state="$(
      jq -ser \
        --arg id "$change_set_id" \
        --arg name "$change_set_name" \
        --arg stackId "$stack_target" \
        '
          if (
            length == 1
            and (.[0] | type) == "object"
            and .[0].ChangeSetId == $id
            and .[0].ChangeSetName == $name
            and .[0].StackId == $stackId
            and (.[0].Status | type) == "string"
            and (.[0].ExecutionStatus | type) == "string"
          )
          then [.[0].Status, .[0].ExecutionStatus] | @tsv
          else error("invalid exact recovery change-set response")
          end
        ' <<<"$response"
    )"; then
      echo "$phase_name received an invalid identity or JSON stream." >&2
      return 1
    fi
    IFS=$'\t' read -r status execution_status <<<"$state"
    case "$status:$execution_status" in
      CREATE_COMPLETE:AVAILABLE|\
      CREATE_COMPLETE:EXECUTE_COMPLETE|\
      CREATE_COMPLETE:OBSOLETE|\
      FAILED:UNAVAILABLE|\
      DELETE_COMPLETE:UNAVAILABLE|\
      DELETE_COMPLETE:OBSOLETE|\
      DELETE_FAILED:UNAVAILABLE|\
      DELETE_FAILED:OBSOLETE)
        polled_change_set="$response"
        return 0
        ;;
      CREATE_PENDING:UNAVAILABLE|CREATE_IN_PROGRESS:UNAVAILABLE) ;;
      *)
        echo "$phase_name observed unexpected state $status/$execution_status." >&2
        return 1
        ;;
    esac
    if [ "$attempt" -eq "$recovery_change_set_poll_attempts" ]; then
      echo "$phase_name exceeded $recovery_change_set_poll_attempts bounded polling attempts." >&2
      return 1
    fi
    sleep_within_recovery_budget \
      "$phase_name" \
      "$recovery_change_set_poll_interval_seconds" ||
      return 1
  done
}

template_file="${PREVIOUS_STACK_TEMPLATE_FILE:-previous-stack-template.yaml}"
parameters_file="${PREVIOUS_STACK_PARAMETERS_FILE:-previous-stack-parameters.json}"
tags_file="${PREVIOUS_STACK_TAGS_FILE:-previous-stack-tags.json}"
if [ ! -s "$template_file" ] ||
   [ ! -s "$parameters_file" ] ||
   [ ! -s "$tags_file" ]; then
  echo "The previous CloudFormation template, parameters, and tags are required." >&2
  exit 1
fi

[[ "$EXPECTED_PREVIOUS_STACK_TEMPLATE_SHA256" =~ ^[0-9a-f]{64}$ ]]
[[ "$EXPECTED_PREVIOUS_STACK_PARAMETERS_SHA256" =~ ^[0-9a-f]{64}$ ]]
[[ "$EXPECTED_PREVIOUS_STACK_TAGS_SHA256" =~ ^[0-9a-f]{64}$ ]]

# Copy once into private temporary files and use only those files for the AWS
# request and all later validation. A mutation of the workspace copies cannot
# alter the pending change set after their expected digests have been proved.
immutable_template_file="$(mktemp)"
immutable_parameters_file="$(mktemp)"
immutable_tags_file="$(mktemp)"
change_set_error_file="$(mktemp)"
restored_stack_file="$(mktemp)"
restored_template_file="$(mktemp)"
restored_parameters_file="$(mktemp)"
cleanup_recovery_files() {
  rm -f -- \
    "$immutable_template_file" \
    "$immutable_parameters_file" \
    "$immutable_tags_file" \
    "$change_set_error_file" \
    "$restored_stack_file" \
    "$restored_template_file" \
    "$restored_parameters_file"
}
trap cleanup_recovery_files EXIT
cp -- "$template_file" "$immutable_template_file"
cp -- "$parameters_file" "$immutable_parameters_file"
cp -- "$tags_file" "$immutable_tags_file"
chmod 0400 \
  "$immutable_template_file" \
  "$immutable_parameters_file" \
  "$immutable_tags_file"

assert_recovery_snapshot_integrity() {
  if [ ! -s "$immutable_template_file" ] ||
     [ ! -s "$immutable_parameters_file" ] ||
     [ ! -s "$immutable_tags_file" ]; then
    echo "The immutable recovery snapshot is missing." >&2
    return 1
  fi
  # TemplateBody has a hard 51,200-byte API limit.
  if [ "$(wc -c <"$immutable_template_file")" -gt 51200 ]; then
    echo "The captured recovery template exceeds CloudFormation TemplateBody limits." >&2
    return 1
  fi
  test "$(
    sha256sum "$immutable_template_file" | awk '{print $1}'
  )" = "$EXPECTED_PREVIOUS_STACK_TEMPLATE_SHA256"
  test "$(
    sha256sum "$immutable_parameters_file" | awk '{print $1}'
  )" = "$EXPECTED_PREVIOUS_STACK_PARAMETERS_SHA256"
  test "$(
    sha256sum "$immutable_tags_file" | awk '{print $1}'
  )" = "$EXPECTED_PREVIOUS_STACK_TAGS_SHA256"
  jq -e \
    'type == "array"
     and length > 0
     and all(.[];
       ((keys | sort) == ["ParameterKey", "ParameterValue"])
       and
       (.ParameterKey | type == "string" and length > 0)
       and (.ParameterValue | type == "string" and . != "****"))
     and ([.[].ParameterKey] | unique | length) == length' \
    "$immutable_parameters_file" >/dev/null
  jq -e \
    '
      type == "array"
      and all(.[];
        ((keys | sort) == ["Key", "Value"])
        and (.Key | type == "string" and length > 0)
        and (.Value | type == "string"))
      and ([.[].Key] | unique | length) == length
    ' "$immutable_tags_file" >/dev/null
}
assert_recovery_snapshot_integrity

assert_restored_stack_terminal() {
  aws cloudformation describe-stacks \
    --stack-name "$stack_target" \
    --region "$AWS_REGION" \
    --output json >"$restored_stack_file" ||
    return 1
  jq -se \
    --slurpfile expectedTags "$immutable_tags_file" \
    --arg stackId "$stack_target" \
    --arg role "$AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN" \
    '
      length == 1
      and (.[0] | type) == "object"
      and (.[0].Stacks | type) == "array"
      and (.[0].Stacks | length) == 1
      and .[0].Stacks[0].StackId == $stackId
      and .[0].Stacks[0].RoleARN == $role
      and (
        ((.[0].Stacks[0].Tags // []) | map({Key, Value}) | sort_by(.Key))
        ==
        ($expectedTags[0] | sort_by(.Key))
      )
      and (
        .[0].Stacks[0].StackStatus == "CREATE_COMPLETE"
        or .[0].Stacks[0].StackStatus == "UPDATE_COMPLETE"
        or .[0].Stacks[0].StackStatus == "UPDATE_ROLLBACK_COMPLETE"
      )
    ' "$restored_stack_file" >/dev/null ||
    return 1
  aws cloudformation get-template \
    --stack-name "$stack_target" \
    --template-stage Original \
    --region "$AWS_REGION" \
    --output json |
    jq -er \
      '.TemplateBody | if type == "string" then . else tojson end' \
      >"$restored_template_file" ||
    return 1
  jq -s \
    '.[0].Stacks[0].Parameters
     | map({ParameterKey, ParameterValue})
     | sort_by(.ParameterKey)' \
    "$restored_stack_file" >"$restored_parameters_file" ||
    return 1
  test "$(
    sha256sum "$restored_template_file" | awk '{print $1}'
  )" = "$EXPECTED_PREVIOUS_STACK_TEMPLATE_SHA256" ||
    return 1
  test "$(
    sha256sum "$restored_parameters_file" | awk '{print $1}'
  )" = "$EXPECTED_PREVIOUS_STACK_PARAMETERS_SHA256" ||
    return 1
}

current_stack="$(
  aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --region "$AWS_REGION" \
    --output json
)"
current_status="$(
  jq -ser \
  --arg stack "$STACK_NAME" \
  --arg stackId "$EXPECTED_PREVIOUS_STACK_ID" \
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
      and (.[0].Stacks[0].StackStatus | type) == "string"
      and (.[0].Stacks[0].StackStatus | test("^[A-Z0-9_]+$"))
    )
    then .[0].Stacks[0].StackStatus
    else error("invalid recovery stack identity")
    end
  ' <<<"$current_stack"
)"
stack_target="$EXPECTED_PREVIOUS_STACK_ID"
recovery_wait_attempt="${ARCHON_RECOVERY_WAIT_ATTEMPT:-0}"
if ! [[ "$recovery_wait_attempt" =~ ^[0-4]$ ]]; then
  echo "ARCHON_RECOVERY_WAIT_ATTEMPT must be an integer from 0 to 4." >&2
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

intent_token="${RECOVERY_INTENT_ID:0:48}"
cancel_token="archon-cancel-${intent_token}"
rollback_token="archon-rollback-${intent_token}"
continue_token="archon-continue-${intent_token}"

# GitHub force-terminates cancelled workflows after a short grace period. In
# that path, hand the transition to CloudFormation and return immediately:
# CancelUpdateStack and both rollback APIs continue independently of the
# runner. A later delivery run then observes only the resulting stable state.
if [ "$recovery_cancelled" = "true" ]; then
  case "$current_status" in
    UPDATE_IN_PROGRESS)
      aws cloudformation cancel-update-stack \
        --stack-name "$stack_target" \
        --client-request-token "$cancel_token" \
        --region "$AWS_REGION"
      ;;
    UPDATE_FAILED)
      aws cloudformation rollback-stack \
        --stack-name "$stack_target" \
        --role-arn "$AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN" \
        --client-request-token "$rollback_token" \
        --retain-except-on-create \
        --region "$AWS_REGION"
      ;;
    UPDATE_ROLLBACK_FAILED)
      aws cloudformation continue-update-rollback \
        --stack-name "$stack_target" \
        --role-arn "$AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN" \
        --client-request-token "$continue_token" \
        --region "$AWS_REGION"
      ;;
    UPDATE_COMPLETE_CLEANUP_IN_PROGRESS|\
    UPDATE_ROLLBACK_IN_PROGRESS|\
    UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS|\
    CREATE_COMPLETE|UPDATE_COMPLETE|UPDATE_ROLLBACK_COMPLETE) ;;
    *)
      echo "The cancelled deployment is not in a safe handoff state." >&2
      exit 1
      ;;
  esac
  echo "CloudFormation cancellation recovery was handed off durably."
  exit 0
fi

retry_after_stack_stabilizes() {
  if [ "$recovery_wait_attempt" -ge 4 ]; then
    echo "The application stack did not reach a recoverable state." >&2
    exit 1
  fi
  cleanup_recovery_files
  exec env \
    ARCHON_RECOVERY_STARTED_EPOCH="$recovery_started_epoch" \
    ARCHON_RECOVERY_WAIT_ATTEMPT="$((recovery_wait_attempt + 1))" \
    bash "$0"
}

case "$current_status" in
  UPDATE_IN_PROGRESS)
    aws cloudformation cancel-update-stack \
      --stack-name "$stack_target" \
      --client-request-token "$cancel_token" \
      --region "$AWS_REGION"
    if ! poll_exact_stack_status \
      "Initial rollback stabilization" \
      "UPDATE_ROLLBACK_COMPLETE" \
      "UPDATE_ROLLBACK_IN_PROGRESS,UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS" \
      "$recovery_stabilize_poll_attempts" \
      "$recovery_stabilize_poll_interval_seconds"; then
      echo "CloudFormation retains the rollback for a later watchdog retry." >&2
      exit 1
    fi
    retry_after_stack_stabilizes
    ;;
  UPDATE_COMPLETE_CLEANUP_IN_PROGRESS)
    if ! poll_exact_stack_status \
      "Initial update cleanup stabilization" \
      "UPDATE_COMPLETE" \
      "UPDATE_COMPLETE_CLEANUP_IN_PROGRESS" \
      "$recovery_stabilize_poll_attempts" \
      "$recovery_stabilize_poll_interval_seconds"; then
      echo "CloudFormation retains the update cleanup for a later watchdog retry." >&2
      exit 1
    fi
    retry_after_stack_stabilizes
    ;;
  UPDATE_FAILED)
    aws cloudformation rollback-stack \
      --stack-name "$stack_target" \
      --role-arn "$AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN" \
      --client-request-token "$rollback_token" \
      --retain-except-on-create \
      --region "$AWS_REGION"
    if ! poll_exact_stack_status \
      "Initial explicit rollback stabilization" \
      "UPDATE_ROLLBACK_COMPLETE" \
      "UPDATE_ROLLBACK_IN_PROGRESS,UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS" \
      "$recovery_stabilize_poll_attempts" \
      "$recovery_stabilize_poll_interval_seconds"; then
      echo "CloudFormation retains the rollback for a later watchdog retry." >&2
      exit 1
    fi
    retry_after_stack_stabilizes
    ;;
  UPDATE_ROLLBACK_IN_PROGRESS|UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS)
    if ! poll_exact_stack_status \
      "Initial in-flight rollback stabilization" \
      "UPDATE_ROLLBACK_COMPLETE" \
      "UPDATE_ROLLBACK_IN_PROGRESS,UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS" \
      "$recovery_stabilize_poll_attempts" \
      "$recovery_stabilize_poll_interval_seconds"; then
      echo "CloudFormation retains the rollback for a later watchdog retry." >&2
      exit 1
    fi
    retry_after_stack_stabilizes
    ;;
  UPDATE_ROLLBACK_FAILED)
    aws cloudformation continue-update-rollback \
      --stack-name "$stack_target" \
      --role-arn "$AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN" \
      --client-request-token "$continue_token" \
      --region "$AWS_REGION"
    if ! poll_exact_stack_status \
      "Initial continued rollback stabilization" \
      "UPDATE_ROLLBACK_COMPLETE" \
      "UPDATE_ROLLBACK_IN_PROGRESS,UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS" \
      "$recovery_stabilize_poll_attempts" \
      "$recovery_stabilize_poll_interval_seconds"; then
      echo "CloudFormation retains the rollback for a later watchdog retry." >&2
      exit 1
    fi
    retry_after_stack_stabilizes
    ;;
  CREATE_COMPLETE|UPDATE_COMPLETE|UPDATE_ROLLBACK_COMPLETE) ;;
  *)
    echo "The application stack is not in a recoverable stable state." >&2
    exit 1
    ;;
esac

change_set_generation="${ARCHON_RECOVERY_CHANGESET_GENERATION:-0}"
[[ "$change_set_generation" =~ ^[0-9]+$ ]]
if [ "$change_set_generation" -gt 4 ]; then
  echo "Recovery exhausted its bounded deterministic change-set generations." >&2
  exit 1
fi
change_set_name="archon-recovery-${intent_token}-${change_set_generation}"
change_set_description="Restore the exact pre-deployment Archon application stack"
if change_set_request="$(
  aws cloudformation create-change-set \
    --stack-name "$stack_target" \
    --change-set-name "$change_set_name" \
    --client-token "$change_set_name" \
    --change-set-type UPDATE \
    --template-body "file://${immutable_template_file}" \
    --parameters "file://${immutable_parameters_file}" \
    --tags "file://${immutable_tags_file}" \
    --capabilities CAPABILITY_AUTO_EXPAND \
    --role-arn "$AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN" \
    --description "$change_set_description" \
    --region "$AWS_REGION" \
    --output json 2>"$change_set_error_file"
)"; then
  change_set_id="$(
    jq -er \
      --arg stackId "$stack_target" \
      --arg prefix \
        "arn:aws:cloudformation:${AWS_REGION}:${AWS_ACCOUNT_ID}:changeSet/${change_set_name}/" \
      '
        if (
          .StackId == $stackId
          and (.Id | type == "string" and startswith($prefix))
        )
        then .Id
        else error("invalid recovery change-set identity")
        end
      ' <<<"$change_set_request"
  )"
elif grep -Eqi 'AlreadyExistsException|already exists' \
  "$change_set_error_file"; then
  change_set_request="$(
    aws cloudformation describe-change-set \
      --stack-name "$stack_target" \
      --change-set-name "$change_set_name" \
      --region "$AWS_REGION" \
      --output json
  )"
  change_set_id="$(
    jq -er \
      --arg stackId "$stack_target" \
      --arg prefix \
        "arn:aws:cloudformation:${AWS_REGION}:${AWS_ACCOUNT_ID}:changeSet/${change_set_name}/" \
      '
        if (
          .StackId == $stackId
          and (.ChangeSetId | type == "string" and startswith($prefix))
        )
        then .ChangeSetId
        else error("invalid existing recovery change-set identity")
        end
      ' <<<"$change_set_request"
  )"
else
  sed 's/[[:cntrl:]]//g' "$change_set_error_file" >&2
  exit 1
fi
assert_recovery_snapshot_integrity

if ! poll_exact_change_set_creation; then
  echo "The recovery change set remains available for a later watchdog retry." >&2
  exit 1
fi
change_set="$polled_change_set"
assert_recovery_snapshot_integrity
if jq -e \
  --slurpfile expected "$immutable_parameters_file" \
  --slurpfile expectedTags "$immutable_tags_file" \
  --arg id "$change_set_id" \
  --arg name "$change_set_name" \
  --arg stackId "$stack_target" \
  --arg description "$change_set_description" \
  '
    .ChangeSetId == $id
    and .ChangeSetName == $name
    and .StackId == $stackId
    and .Description == $description
    and ((.Capabilities // []) | sort) == ["CAPABILITY_AUTO_EXPAND"]
    and (
      (.Parameters | map({ParameterKey, ParameterValue}) | sort_by(.ParameterKey))
      ==
      ($expected[0] | sort_by(.ParameterKey))
    )
    and (
      ((.Tags // []) | map({Key, Value}) | sort_by(.Key))
      ==
      ($expectedTags[0] | sort_by(.Key))
    )
    and .Status == "FAILED"
    and .ExecutionStatus == "UNAVAILABLE"
    and (.Changes | type == "array" and length == 0)
    and (
      .StatusReason == "No updates are to be performed."
      or
      .StatusReason == "The submitted information did not contain changes."
      or
      .StatusReason ==
        "The submitted information didn\u0027t contain changes. Submit different information to create a change set."
    )
  ' \
  <<<"$change_set" >/dev/null; then
  aws cloudformation delete-change-set \
    --stack-name "$stack_target" \
    --change-set-name "$change_set_id" \
    --region "$AWS_REGION"
  assert_restored_stack_terminal
  exit 0
fi
existing_execution_status="$(
  jq -er '.ExecutionStatus' <<<"$change_set"
)"
if [ "$existing_execution_status" = "OBSOLETE" ] ||
   [ "$(jq -r '.Status' <<<"$change_set")" = "DELETE_COMPLETE" ]; then
  aws cloudformation delete-change-set \
    --stack-name "$stack_target" \
    --change-set-name "$change_set_id" \
    --region "$AWS_REGION" 2>/dev/null || true
  cleanup_recovery_files
  exec env \
    ARCHON_RECOVERY_STARTED_EPOCH="$recovery_started_epoch" \
    ARCHON_RECOVERY_CHANGESET_GENERATION="$((change_set_generation + 1))" \
    bash "$0"
fi
if jq -e \
  --slurpfile expected "$immutable_parameters_file" \
  --slurpfile expectedTags "$immutable_tags_file" \
  --arg id "$change_set_id" \
  --arg name "$change_set_name" \
  --arg stackId "$stack_target" \
  --arg description "$change_set_description" \
  '
    .ChangeSetId == $id
    and .ChangeSetName == $name
    and .StackId == $stackId
    and .Description == $description
    and ((.Capabilities // []) | sort) == ["CAPABILITY_AUTO_EXPAND"]
    and (
      (.Parameters | map({ParameterKey, ParameterValue}) | sort_by(.ParameterKey))
      ==
      ($expected[0] | sort_by(.ParameterKey))
    )
    and (
      ((.Tags // []) | map({Key, Value}) | sort_by(.Key))
      ==
      ($expectedTags[0] | sort_by(.Key))
    )
    and .Status == "CREATE_COMPLETE"
    and .ExecutionStatus == "AVAILABLE"
  ' <<<"$change_set" >/dev/null; then
  :
elif jq -e \
  --arg id "$change_set_id" \
  --arg name "$change_set_name" \
  --arg stackId "$stack_target" \
  '
    .ChangeSetId == $id
    and .ChangeSetName == $name
    and .StackId == $stackId
    and .Status == "CREATE_COMPLETE"
    and .ExecutionStatus == "EXECUTE_COMPLETE"
  ' <<<"$change_set" >/dev/null; then
  if assert_restored_stack_terminal; then
    exit 0
  fi
  if [ "$change_set_generation" -ge 4 ]; then
    echo "Executed recovery change sets did not restore the bound snapshot." >&2
    exit 1
  fi
  cleanup_recovery_files
  exec env \
    ARCHON_RECOVERY_STARTED_EPOCH="$recovery_started_epoch" \
    ARCHON_RECOVERY_CHANGESET_GENERATION="$((change_set_generation + 1))" \
    bash "$0"
else
  echo "The exact recovery change set is not executable." >&2
  exit 1
fi

assert_recovery_snapshot_integrity
execute_token="execute-${change_set_name}"
aws cloudformation execute-change-set \
  --stack-name "$stack_target" \
  --change-set-name "$change_set_id" \
  --client-request-token "$execute_token" \
  --no-disable-rollback \
  --retain-except-on-create \
  --region "$AWS_REGION"
if ! poll_exact_stack_status \
  "Final recovery restore" \
  "UPDATE_COMPLETE" \
  "UPDATE_IN_PROGRESS,UPDATE_COMPLETE_CLEANUP_IN_PROGRESS" \
  "$recovery_final_poll_attempts" \
  "$recovery_final_poll_interval_seconds"; then
  echo "CloudFormation retains the restore for a later watchdog retry." >&2
  exit 1
fi
assert_restored_stack_terminal
