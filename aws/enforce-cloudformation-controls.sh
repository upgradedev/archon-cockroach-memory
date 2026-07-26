#!/usr/bin/env bash
# Fail-closed CloudFormation termination-protection and drift controls.
#
# Usage:
#   enforce-cloudformation-controls.sh preflight
#   enforce-cloudformation-controls.sh terminal
#   enforce-cloudformation-controls.sh recover
#   enforce-cloudformation-controls.sh audit
#
# All modes require APP_NAME, AWS_ACCOUNT_ID, AWS_REGION, ENVIRONMENT,
# STACK_NAME, and AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN. Existing-stack
# checks additionally require EXPECTED_STACK_ID, EXPECTED_STACK_REVISION,
# and EXPECTED_TAGS_SHA256. Recover also requires EXPECTED_STACK_STATE:
# existing proves the restored identity, while greenfield proves absence.
# CANDIDATE_SHA is optional provenance and, when supplied, must be a lowercase
# 40-character Git SHA.
set -euo pipefail

usage() {
  echo "Usage: $0 [preflight|terminal|recover|audit]" >&2
}

die() {
  echo "$1" >&2
  exit 1
}

require_single_json_object() {
  local payload="$1"
  local description="$2"
  if ! jq -s -e \
      'length == 1 and (.[0] | type == "object")' \
      <<<"$payload" >/dev/null 2>&1; then
    die "$description must contain exactly one JSON object."
  fi
}

if [ "$#" -ne 1 ]; then
  usage
  exit 1
fi

mode="$1"
case "$mode" in
  preflight|terminal|recover|audit) ;;
  *)
    usage
    exit 1
    ;;
esac

for name in \
  APP_NAME \
  AWS_ACCOUNT_ID \
  AWS_REGION \
  ENVIRONMENT \
  STACK_NAME \
  AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN; do
  if [ -z "${!name:-}" ]; then
    die "${name} is required for the CloudFormation controls proof."
  fi
done

if [ "$AWS_REGION" != "eu-west-1" ]; then
  die "CloudFormation controls are restricted to eu-west-1."
fi
if ! [[ "$AWS_ACCOUNT_ID" =~ ^[0-9]{12}$ ]]; then
  die "AWS_ACCOUNT_ID must be an exact 12-digit account id."
fi
if ! [[ "$APP_NAME" =~ ^[a-z][a-z0-9-]{2,24}$ ]]; then
  die "APP_NAME is invalid."
fi
case "$ENVIRONMENT" in
  staging|production) ;;
  *)
    die "ENVIRONMENT must be exactly staging or production."
    ;;
esac
if [ "$STACK_NAME" != "${APP_NAME}-${ENVIRONMENT}" ]; then
  die "STACK_NAME does not match the deterministic application target."
fi

execution_role_prefix="arn:aws:iam::${AWS_ACCOUNT_ID}:role/"
if [[ "$AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN" != \
  "$execution_role_prefix"* ]]; then
  die "AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN targets the wrong account."
fi
execution_role_suffix="${AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN#"$execution_role_prefix"}"
if [ "${#execution_role_suffix}" -gt 512 ] ||
   ! [[ "$execution_role_suffix" =~ \
     ^[A-Za-z0-9+=,.@_-]+(/[A-Za-z0-9+=,.@_-]+)*$ ]]; then
  die "AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN is invalid."
fi

candidate_sha="${CANDIDATE_SHA:-}"
if [ -n "$candidate_sha" ] &&
   ! [[ "$candidate_sha" =~ ^[0-9a-f]{40}$ ]]; then
  die "CANDIDATE_SHA must be a lowercase 40-character Git SHA."
fi

expected_stack_id="${EXPECTED_STACK_ID:-}"
expected_stack_revision="${EXPECTED_STACK_REVISION:-}"
expected_tags_sha256="${EXPECTED_TAGS_SHA256:-}"
expected_stack_state="${EXPECTED_STACK_STATE:-}"

validate_expected_identity() {
  local stack_id_prefix stack_id_suffix

  if [ -z "$expected_stack_id" ] ||
     [ -z "$expected_stack_revision" ] ||
     [ -z "$expected_tags_sha256" ]; then
    die "Exact expected stack identity is required."
  fi

  stack_id_prefix="$(
    printf 'arn:aws:cloudformation:%s:%s:stack/%s/' \
      "$AWS_REGION" \
      "$AWS_ACCOUNT_ID" \
      "$STACK_NAME"
  )"
  if [[ "$expected_stack_id" != "$stack_id_prefix"* ]]; then
    die "EXPECTED_STACK_ID targets the wrong stack."
  fi
  stack_id_suffix="${expected_stack_id#"$stack_id_prefix"}"
  if ! [[ "$stack_id_suffix" =~ ^[A-Za-z0-9-]{1,128}$ ]]; then
    die "EXPECTED_STACK_ID is invalid."
  fi
  if ! [[ "$expected_stack_revision" =~ \
    ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$ ]]; then
    die "EXPECTED_STACK_REVISION is invalid."
  fi
  if ! [[ "$expected_tags_sha256" =~ ^[0-9a-f]{64}$ ]]; then
    die "EXPECTED_TAGS_SHA256 must be a lowercase SHA-256 digest."
  fi
}

if [ "$mode" = "preflight" ]; then
  populated_expected_identity=0
  for value in \
    "$expected_stack_id" \
    "$expected_stack_revision" \
    "$expected_tags_sha256"; do
    if [ -n "$value" ]; then
      populated_expected_identity=$((populated_expected_identity + 1))
    fi
  done
  case "$populated_expected_identity" in
    0) ;;
    3) validate_expected_identity ;;
    *) die "Preflight expected stack identity must be complete or absent." ;;
  esac
elif [ "$mode" = "recover" ]; then
  case "$expected_stack_state" in
    existing)
      validate_expected_identity
      ;;
    greenfield)
      if [ -n "$expected_stack_id" ] ||
         [ -n "$expected_stack_revision" ] ||
         [ -n "$expected_tags_sha256" ]; then
        die "Greenfield recovery must not inherit an existing stack identity."
      fi
      ;;
    *)
      die "Recovery EXPECTED_STACK_STATE must be existing or greenfield."
      ;;
  esac
else
  validate_expected_identity
fi

drift_poll_attempts="${CFN_DRIFT_POLL_ATTEMPTS:-66}"
drift_poll_interval="${CFN_DRIFT_POLL_INTERVAL_SECONDS:-5}"
if ! [[ "$drift_poll_attempts" =~ ^[1-9][0-9]*$ ]] ||
   [ "$drift_poll_attempts" -gt 66 ]; then
  die "CFN_DRIFT_POLL_ATTEMPTS must be between 1 and 66."
fi
if ! [[ "$drift_poll_interval" =~ ^[0-9]+$ ]] ||
   [ "$drift_poll_interval" -gt 5 ]; then
  die "CFN_DRIFT_POLL_INTERVAL_SECONDS must be between 0 and 5."
fi
if [ $((drift_poll_attempts * drift_poll_interval)) -gt 330 ]; then
  die "The CloudFormation drift polling window exceeds 330 seconds."
fi

observed_stack_id=""
observed_stack_status=""
observed_stack_revision=""
observed_tags_sha256=""
observed_termination_protection=""

validate_stack_document() {
  local stack_json="$1"
  local canonical_tags

  require_single_json_object \
    "$stack_json" \
    "The live CloudFormation stack response"
  if ! jq -e \
      --arg stackId "$expected_stack_id" \
      --arg stackName "$STACK_NAME" \
      --arg roleArn "$AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN" \
      --arg revision "$expected_stack_revision" \
      '
        type == "object"
        and (.Stacks | type == "array" and length == 1)
        and .Stacks[0].StackId == $stackId
        and .Stacks[0].StackName == $stackName
        and .Stacks[0].RoleARN == $roleArn
        and (
          (.Stacks[0].LastUpdatedTime // .Stacks[0].CreationTime)
          == $revision
        )
        and (
          .Stacks[0].StackStatus == "CREATE_COMPLETE"
          or .Stacks[0].StackStatus == "UPDATE_COMPLETE"
          or .Stacks[0].StackStatus == "UPDATE_ROLLBACK_COMPLETE"
        )
        and (
          (.Stacks[0].EnableTerminationProtection | type)
          == "boolean"
        )
      ' <<<"$stack_json" >/dev/null 2>&1; then
    die "The live CloudFormation stack identity is invalid or unstable."
  fi

  if ! canonical_tags="$(
    jq -eS \
      '
        (.Stacks[0].Tags // []) as $tags
        | if (
            ($tags | type) == "array"
            and all($tags[];
              type == "object"
              and (.Key | type == "string" and length > 0)
              and (.Value | type == "string")
            )
            and (
              [$tags[].Key] as $keys
              | ($keys | unique | length) == ($keys | length)
            )
          )
          then ($tags | map({Key, Value}) | sort_by(.Key))
          else error("invalid stack tags")
          end
      ' <<<"$stack_json" 2>/dev/null
  )"; then
    die "The live CloudFormation stack tags are invalid."
  fi

  observed_tags_sha256="$(
    printf '%s\n' "$canonical_tags" | sha256sum | awk '{print $1}'
  )"
  if [ "$observed_tags_sha256" != "$expected_tags_sha256" ]; then
    die "The live CloudFormation stack tags do not match the expected identity."
  fi

  observed_stack_id="$(
    jq -er '.Stacks[0].StackId' <<<"$stack_json" 2>/dev/null
  )"
  observed_stack_status="$(
    jq -er '.Stacks[0].StackStatus' <<<"$stack_json" 2>/dev/null
  )"
  observed_stack_revision="$(
    jq -er \
      '.Stacks[0].LastUpdatedTime // .Stacks[0].CreationTime' \
      <<<"$stack_json" \
      2>/dev/null
  )"
  observed_termination_protection="$(
    jq -er \
      '.Stacks[0].EnableTerminationProtection
       | if type == "boolean"
         then tostring
         else error("invalid termination-protection state")
         end' \
      <<<"$stack_json" \
      2>/dev/null
  )"
}

drift_detection_id=""
drift_detection_status=""
stack_drift_status=""
drifted_resource_count=0
checked_resource_count=0
not_checked_resource_count=0
total_resource_count=0

run_fresh_drift_detection() {
  local detect_response detection_response detection_status
  local attempt resource_summary
  local resource_response

  if ! detect_response="$(
    aws cloudformation detect-stack-drift \
      --stack-name "$expected_stack_id" \
      --region "$AWS_REGION" \
      --output json 2>&1
  )"; then
    die "Unable to start a fresh CloudFormation drift detection."
  fi
  require_single_json_object \
    "$detect_response" \
    "The CloudFormation drift detection response"
  if ! drift_detection_id="$(
    jq -er \
      '.StackDriftDetectionId
       | select(type == "string" and length > 0)' \
      <<<"$detect_response" \
      2>/dev/null
  )" ||
     ! [[ "$drift_detection_id" =~ ^[A-Za-z0-9-]{1,128}$ ]]; then
    die "CloudFormation returned an invalid drift detection identity."
  fi

  detection_response=""
  for attempt in $(seq 1 "$drift_poll_attempts"); do
    if ! detection_response="$(
      aws cloudformation describe-stack-drift-detection-status \
        --stack-drift-detection-id "$drift_detection_id" \
        --region "$AWS_REGION" \
        --output json 2>&1
    )"; then
      die "Unable to inspect the CloudFormation drift detection."
    fi
    require_single_json_object \
      "$detection_response" \
      "The CloudFormation drift detection status response"
    if ! jq -e \
        --arg detectionId "$drift_detection_id" \
        --arg stackId "$expected_stack_id" \
        '
          type == "object"
          and .StackDriftDetectionId == $detectionId
          and .StackId == $stackId
          and (.DetectionStatus | type == "string")
        ' <<<"$detection_response" >/dev/null 2>&1; then
      die "CloudFormation returned an invalid drift detection status."
    fi
    detection_status="$(
      jq -er '.DetectionStatus' <<<"$detection_response" 2>/dev/null
    )"
    case "$detection_status" in
      DETECTION_IN_PROGRESS)
        if [ "$attempt" -lt "$drift_poll_attempts" ]; then
          sleep "$drift_poll_interval"
        fi
        ;;
      DETECTION_COMPLETE)
        if ! jq -e \
            '
              .StackDriftStatus == "IN_SYNC"
              and .DriftedStackResourceCount == 0
            ' <<<"$detection_response" >/dev/null 2>&1; then
          die "The CloudFormation stack is drifted."
        fi
        drift_detection_status="DETECTION_COMPLETE"
        stack_drift_status="IN_SYNC"
        drifted_resource_count=0
        break
        ;;
      DETECTION_FAILED)
        die "CloudFormation drift detection failed."
        ;;
      *)
        die "CloudFormation returned an unsupported drift detection status."
        ;;
    esac
  done

  if [ "$drift_detection_status" != "DETECTION_COMPLETE" ]; then
    die "CloudFormation drift detection exceeded the bounded polling window."
  fi

  if ! resource_response="$(
    aws cloudformation describe-stack-resource-drifts \
      --stack-name "$expected_stack_id" \
      --region "$AWS_REGION" \
      --output json 2>/dev/null
  )"; then
    die "Unable to inspect the CloudFormation resource drift state."
  fi
  require_single_json_object \
    "$resource_response" \
    "The CloudFormation resource drift response"
  if ! resource_summary="$(
    jq -ce \
        '
          if (
            type == "object"
            and (.StackResourceDrifts | type == "array")
            and all(.StackResourceDrifts[];
              type == "object"
              and (
                .StackResourceDriftStatus == "IN_SYNC"
                or .StackResourceDriftStatus == "NOT_CHECKED"
              )
            )
            and (
              [
                .StackResourceDrifts[]
                | select(.StackResourceDriftStatus == "IN_SYNC")
              ]
              | length
            ) > 0
          )
          then {
            checkedResourceCount: (
              [
                .StackResourceDrifts[]
                | select(.StackResourceDriftStatus == "IN_SYNC")
              ]
              | length
            ),
            notCheckedResourceCount: (
              [
                .StackResourceDrifts[]
                | select(.StackResourceDriftStatus == "NOT_CHECKED")
              ]
              | length
            ),
            totalResourceCount: (.StackResourceDrifts | length)
          }
          else error("invalid resource drift proof")
          end
        ' <<<"$resource_response"
  )"; then
    die "Unable to prove the CloudFormation resource drift state."
  fi

  checked_resource_count="$(
    jq -er '.checkedResourceCount' <<<"$resource_summary"
  )"
  not_checked_resource_count="$(
    jq -er '.notCheckedResourceCount' <<<"$resource_summary"
  )"
  total_resource_count="$(
    jq -er '.totalResourceCount' <<<"$resource_summary"
  )"
}

emit_proof() {
  local identity_state="$1"
  local protection_action="$2"
  local protection_enabled_json="$3"
  local drift_json="$4"
  local proof

  proof="$(
    jq -cnS \
      --arg mode "$mode" \
      --arg state "$identity_state" \
      --arg accountId "$AWS_ACCOUNT_ID" \
      --arg appName "$APP_NAME" \
      --arg candidateSha "$candidate_sha" \
      --arg environment "$ENVIRONMENT" \
      --arg executionRoleArn \
        "$AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN" \
      --arg region "$AWS_REGION" \
      --arg stackId "$observed_stack_id" \
      --arg stackName "$STACK_NAME" \
      --arg stackRevision "$observed_stack_revision" \
      --arg stackStatus "$observed_stack_status" \
      --arg tagsSha256 "$observed_tags_sha256" \
      --arg protectionAction "$protection_action" \
      --argjson protectionEnabled "$protection_enabled_json" \
      --argjson drift "$drift_json" \
      '
        def nullable: if . == "" then null else . end;
        {
          drift: $drift,
          evidence: "live-control-plane",
          identity: {
            accountId: $accountId,
            appName: $appName,
            candidateSha: ($candidateSha | nullable),
            environment: $environment,
            executionRoleArn: $executionRoleArn,
            region: $region,
            stackId: ($stackId | nullable),
            stackName: $stackName,
            stackRevision: ($stackRevision | nullable),
            stackStatus: ($stackStatus | nullable),
            state: $state,
            tagsSha256: ($tagsSha256 | nullable)
          },
          mode: $mode,
          ok: true,
          protection: {
            action: $protectionAction,
            enabled: $protectionEnabled
          },
          schema: "archon.cloudformation-controls.proof",
          version: 1
        }
      '
  )"

  if ! jq -e \
      --arg mode "$mode" \
      '
        type == "object"
        and (keys | sort) == ([
          "drift",
          "evidence",
          "identity",
          "mode",
          "ok",
          "protection",
          "schema",
          "version"
        ] | sort)
        and .schema == "archon.cloudformation-controls.proof"
        and .version == 1
        and .ok == true
        and .mode == $mode
        and .evidence == "live-control-plane"
        and (.identity | type) == "object"
        and (.identity | keys | sort) == ([
            "accountId",
            "appName",
            "candidateSha",
            "environment",
            "executionRoleArn",
            "region",
            "stackId",
            "stackName",
            "stackRevision",
            "stackStatus",
            "state",
            "tagsSha256"
          ] | sort)
        and (
          .identity.candidateSha == null
          or (
            (.identity.candidateSha | type) == "string"
            and (
              .identity.candidateSha
              | test("^[0-9a-f]{40}$")
            )
          )
        )
        and (.protection | type) == "object"
        and (.protection | keys | sort) == ["action", "enabled"]
        and (
          if .identity.state == "absent"
          then (
            (
              .mode == "preflight"
              or .mode == "recover"
            )
            and .identity.stackId == null
            and .identity.stackRevision == null
            and .identity.stackStatus == null
            and .identity.tagsSha256 == null
            and .protection == {
              action: "not-applicable",
              enabled: null
            }
            and .drift == null
          )
          elif .identity.state == "existing"
          then (
            (.identity.stackId | type) == "string"
            and (.identity.stackRevision | type) == "string"
            and (
              .identity.stackStatus == "CREATE_COMPLETE"
              or .identity.stackStatus == "UPDATE_COMPLETE"
              or .identity.stackStatus == "UPDATE_ROLLBACK_COMPLETE"
            )
            and (
              (.identity.tagsSha256 | type) == "string"
              and (
                .identity.tagsSha256
                | test("^[0-9a-f]{64}$")
              )
            )
            and .protection.enabled == true
            and (
              .protection.action == "verified"
              or .protection.action == "enabled"
            )
            and (.drift | type) == "object"
            and (.drift | keys | sort) == ([
                "checkedResourceCount",
                "detectionId",
                "detectionStatus",
                "driftedResourceCount",
                "notCheckedResourceCount",
                "stackDriftStatus",
                "totalResourceCount"
              ] | sort)
            and .drift.detectionStatus == "DETECTION_COMPLETE"
            and .drift.stackDriftStatus == "IN_SYNC"
            and .drift.driftedResourceCount == 0
            and (
              (.drift.checkedResourceCount | type) == "number"
              and (
                .drift.checkedResourceCount
                | floor
              ) == .drift.checkedResourceCount
              and .drift.checkedResourceCount >= 1
            )
            and (
              (.drift.notCheckedResourceCount | type)
              == "number"
              and (
                .drift.notCheckedResourceCount
                | floor
              ) == .drift.notCheckedResourceCount
              and .drift.notCheckedResourceCount >= 0
            )
            and (
              .drift.totalResourceCount
              == (
                .drift.checkedResourceCount
                + .drift.notCheckedResourceCount
              )
            )
          )
          else false
          end
        )
      ' <<<"$proof" >/dev/null 2>&1; then
    die "The CloudFormation controls proof failed validation."
  fi

  printf '%s\n' "$proof"
}

initial_stack=""
if ! initial_stack="$(
  aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --region "$AWS_REGION" \
    --output json 2>&1
)"; then
  if (
       [ "$mode" = "preflight" ] ||
       {
         [ "$mode" = "recover" ] &&
         [ "$expected_stack_state" = "greenfield" ]
       }
     ) &&
     [[ "$initial_stack" == *"ValidationError"* ]] &&
     [[ "$initial_stack" == *"does not exist"* ]]; then
    if [ -n "$expected_stack_id" ] ||
       [ -n "$expected_stack_revision" ] ||
       [ -n "$expected_tags_sha256" ]; then
      die "The expected CloudFormation stack is absent."
    fi
    emit_proof "absent" "not-applicable" "null" "null"
    exit 0
  fi
  die "Unable to inspect the CloudFormation stack."
fi

if [ "$mode" = "recover" ] &&
   [ "$expected_stack_state" = "greenfield" ]; then
  die "Greenfield recovery requires the CloudFormation stack to be absent."
fi
if [ "$mode" = "preflight" ] && [ -z "$expected_stack_id" ]; then
  die "An existing stack requires exact expected identity inputs."
fi
validate_stack_document "$initial_stack"

protection_action="verified"
case "$mode:$observed_termination_protection" in
  preflight:true|terminal:true|recover:true|audit:true) ;;
  audit:false)
    die "CloudFormation audit requires termination protection."
    ;;
  preflight:false|terminal:false|recover:false)
    update_response=""
    if ! update_response="$(
      aws cloudformation update-termination-protection \
        --enable-termination-protection \
        --stack-name "$expected_stack_id" \
        --region "$AWS_REGION" \
        --output json 2>&1
    )"; then
      die "Unable to enable CloudFormation termination protection."
    fi
    require_single_json_object \
      "$update_response" \
      "The CloudFormation termination-protection update response"
    if ! jq -e \
        --arg stackId "$expected_stack_id" \
        'type == "object" and .StackId == $stackId' \
        <<<"$update_response" >/dev/null 2>&1; then
      die "CloudFormation returned an invalid protection update identity."
    fi
    protection_action="enabled"
    ;;
  *)
    die "The CloudFormation termination-protection state is invalid."
    ;;
esac

protected_stack=""
if ! protected_stack="$(
  aws cloudformation describe-stacks \
    --stack-name "$expected_stack_id" \
    --region "$AWS_REGION" \
    --output json 2>&1
)"; then
  die "Unable to verify the protected CloudFormation stack."
fi
validate_stack_document "$protected_stack"
if [ "$observed_termination_protection" != "true" ]; then
  die "CloudFormation termination protection is not enabled."
fi

run_fresh_drift_detection

final_stack=""
if ! final_stack="$(
  aws cloudformation describe-stacks \
    --stack-name "$expected_stack_id" \
    --region "$AWS_REGION" \
    --output json 2>&1
)"; then
  die "Unable to revalidate the CloudFormation stack after drift detection."
fi
validate_stack_document "$final_stack"
if [ "$observed_termination_protection" != "true" ]; then
  die "CloudFormation termination protection changed during drift detection."
fi

drift_proof="$(
  jq -cnS \
    --arg detectionId "$drift_detection_id" \
    --arg detectionStatus "$drift_detection_status" \
    --arg stackDriftStatus "$stack_drift_status" \
    --argjson driftedResourceCount "$drifted_resource_count" \
    --argjson checkedResourceCount "$checked_resource_count" \
    --argjson notCheckedResourceCount "$not_checked_resource_count" \
    --argjson totalResourceCount "$total_resource_count" \
    '{
      checkedResourceCount: $checkedResourceCount,
      detectionId: $detectionId,
      detectionStatus: $detectionStatus,
      driftedResourceCount: $driftedResourceCount,
      notCheckedResourceCount: $notCheckedResourceCount,
      stackDriftStatus: $stackDriftStatus,
      totalResourceCount: $totalResourceCount
    }'
)"
emit_proof "existing" "$protection_action" "true" "$drift_proof"
