#!/usr/bin/env bash
# Canonically bind the exact pre-deployment recovery inputs before any AWS
# mutation. The same contract is re-evaluated immediately before SAM and at the
# first line of recovery.
set -euo pipefail

source_deploy_run_id="${SOURCE_DEPLOY_RUN_ID:-${GITHUB_RUN_ID:-}}"
source_deploy_run_attempt="${SOURCE_DEPLOY_RUN_ATTEMPT:-${GITHUB_RUN_ATTEMPT:-}}"
source_repository="${SOURCE_REPOSITORY:-${GITHUB_REPOSITORY:-}}"

for name in \
  APP_NAME \
  ENVIRONMENT \
  AWS_ACCOUNT_ID \
  AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN \
  AWS_REGION \
  STACK_NAME \
  STACK_STATE \
  HAS_PREVIOUS_STACK \
  CANDIDATE_SHA; do
  if [ -z "${!name:-}" ]; then
    echo "$name is required for recovery snapshot proof." >&2
    exit 1
  fi
done

[[ "$APP_NAME" =~ ^[a-z0-9][a-z0-9-]*$ ]]
[[ "$AWS_ACCOUNT_ID" =~ ^[0-9]{12}$ ]]
[[ "$AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN" =~ ^arn:aws:iam::${AWS_ACCOUNT_ID}:role/[A-Za-z0-9+=,.@_/-]+$ ]]
[[ "$CANDIDATE_SHA" =~ ^[0-9a-f]{40}$ ]]
[[ "$source_deploy_run_id" =~ ^[0-9]+$ ]]
[[ "$source_deploy_run_attempt" =~ ^[1-9][0-9]*$ ]]
[[ "$source_repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]
if [ "$ENVIRONMENT" != "staging" ] &&
   [ "$ENVIRONMENT" != "production" ]; then
  echo "Recovery snapshot proof is limited to staging or production." >&2
  exit 1
fi
if [ "$AWS_REGION" != "eu-west-1" ]; then
  echo "Recovery snapshot proof is limited to eu-west-1." >&2
  exit 1
fi
if [ "$STACK_NAME" != "${APP_NAME}-${ENVIRONMENT}" ]; then
  echo "The stack name does not match the recovery environment." >&2
  exit 1
fi

template_file="${PREVIOUS_STACK_TEMPLATE_FILE:-previous-stack-template.yaml}"
parameters_file="${PREVIOUS_STACK_PARAMETERS_FILE:-previous-stack-parameters.json}"
tags_file="${PREVIOUS_STACK_TAGS_FILE:-previous-stack-tags.json}"
stack_id="${PREVIOUS_STACK_ID:-}"
stack_status="${PREVIOUS_STACK_STATUS:-}"
stack_revision="${PREVIOUS_STACK_REVISION:-}"
function_name="${PREVIOUS_FUNCTION_NAME:-}"
function_version="${PREVIOUS_FUNCTION_VERSION:-}"
application_url="${PREVIOUS_APPLICATION_URL:-}"
greenfield_owner=""
template_sha256=""
parameters_sha256=""
tags_sha256=""

case "$STACK_STATE:$HAS_PREVIOUS_STACK" in
  existing:true)
    if [ ! -s "$template_file" ] ||
       [ ! -s "$parameters_file" ] ||
       [ ! -s "$tags_file" ]; then
      echo "The existing-stack recovery files are required." >&2
      exit 1
    fi
    if [ "$(wc -c <"$template_file")" -gt 51200 ]; then
      echo "The recovery template exceeds CloudFormation TemplateBody limits." >&2
      exit 1
    fi
    jq -e \
      'type == "array"
       and length > 0
       and all(.[];
         ((keys | sort) == ["ParameterKey", "ParameterValue"])
         and (.ParameterKey | type == "string" and length > 0)
         and (.ParameterValue | type == "string" and . != "****"))
       and ([.[].ParameterKey] | unique | length) == length' \
      "$parameters_file" >/dev/null
    jq -e \
      '
        type == "array"
        and all(.[];
          ((keys | sort) == ["Key", "Value"])
          and (.Key | type == "string" and length > 0)
          and (.Value | type == "string"))
        and ([.[].Key] | unique | length) == length
      ' "$tags_file" >/dev/null
    template_sha256="$(sha256sum "$template_file" | awk '{print $1}')"
    parameters_sha256="$(sha256sum "$parameters_file" | awk '{print $1}')"
    tags_sha256="$(sha256sum "$tags_file" | awk '{print $1}')"
    [[ "$template_sha256" =~ ^[0-9a-f]{64}$ ]]
    [[ "$parameters_sha256" =~ ^[0-9a-f]{64}$ ]]
    [[ "$tags_sha256" =~ ^[0-9a-f]{64}$ ]]
    expected_stack_prefix="arn:aws:cloudformation:${AWS_REGION}:${AWS_ACCOUNT_ID}:stack/${STACK_NAME}/"
    [[ "$stack_id" == "$expected_stack_prefix"* ]]
    case "$stack_status" in
      CREATE_COMPLETE|UPDATE_COMPLETE|UPDATE_ROLLBACK_COMPLETE) ;;
      *)
        echo "The recoverable stack status is not stable." >&2
        exit 1
        ;;
    esac
    test -n "$stack_revision"
    test "$function_name" = "${APP_NAME}-${ENVIRONMENT}-api"
    [[ "$function_version" =~ ^[1-9][0-9]*$ ]]
    [[ "$application_url" =~ ^https:// ]]
    test -z "${EXPECTED_GREENFIELD_OWNER:-}"
    ;;

  greenfield:false)
    for value in \
      "$stack_id" \
      "$stack_status" \
      "$stack_revision" \
      "$function_name" \
      "$function_version" \
      "$application_url"; do
      test -z "$value"
    done
    if [ -e "$template_file" ] ||
       [ -e "$parameters_file" ] ||
       [ -e "$tags_file" ]; then
      echo "Greenfield recovery must not inherit existing-stack files." >&2
      exit 1
    fi
    # A GitHub rerun keeps the run ID and candidate but advances the attempt.
    # Keep ownership stable for exact-run cleanup; the manifest retains attempt.
    owner_payload="$(
      jq -cnS \
        --arg account "$AWS_ACCOUNT_ID" \
        --arg app "$APP_NAME" \
        --arg region "$AWS_REGION" \
        --arg repository "$source_repository" \
        --arg stack "$STACK_NAME" \
        --arg environment "$ENVIRONMENT" \
        --arg runId "$source_deploy_run_id" \
        --arg candidate "$CANDIDATE_SHA" \
        '{
          account: $account,
          app: $app,
          candidate: $candidate,
          environment: $environment,
          region: $region,
          repository: $repository,
          runId: $runId,
          stack: $stack
        }'
    )"
    greenfield_owner="$(
      printf '%s' "$owner_payload" | sha256sum | awk '{print $1}'
    )"
    [[ "$greenfield_owner" =~ ^[0-9a-f]{64}$ ]]
    if [ -n "${EXPECTED_GREENFIELD_OWNER:-}" ]; then
      test "$greenfield_owner" = "$EXPECTED_GREENFIELD_OWNER"
    fi
    ;;

  *)
    echo "The stack-state and previous-stack flags are inconsistent." >&2
    exit 1
    ;;
esac

if [ -n "${EXPECTED_TEMPLATE_SHA256:-}" ]; then
  test "$template_sha256" = "$EXPECTED_TEMPLATE_SHA256"
fi
if [ -n "${EXPECTED_PARAMETERS_SHA256:-}" ]; then
  test "$parameters_sha256" = "$EXPECTED_PARAMETERS_SHA256"
fi
if [ -n "${EXPECTED_TAGS_SHA256:-}" ]; then
  test "$tags_sha256" = "$EXPECTED_TAGS_SHA256"
fi

manifest="$(
  jq -cnS \
    --arg accountId "$AWS_ACCOUNT_ID" \
    --arg appName "$APP_NAME" \
    --arg candidateSha "$CANDIDATE_SHA" \
    --arg executionRoleArn "$AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN" \
    --arg schema "archon.recovery-snapshot" \
    --argjson version 1 \
    --arg environment "$ENVIRONMENT" \
    --arg stackName "$STACK_NAME" \
    --arg stackState "$STACK_STATE" \
    --argjson hasPreviousStack "$HAS_PREVIOUS_STACK" \
    --arg stackId "$stack_id" \
    --arg stackStatus "$stack_status" \
    --arg stackRevision "$stack_revision" \
    --arg templateSha256 "$template_sha256" \
    --arg parametersSha256 "$parameters_sha256" \
    --arg tagsSha256 "$tags_sha256" \
    --arg functionName "$function_name" \
    --arg functionVersion "$function_version" \
    --arg applicationUrl "$application_url" \
    --arg greenfieldOwner "$greenfield_owner" \
    --arg region "$AWS_REGION" \
    --arg runAttempt "$source_deploy_run_attempt" \
    --arg runId "$source_deploy_run_id" \
    'def nullable: if . == "" then null else . end;
     {
       accountId: $accountId,
       appName: $appName,
       applicationUrl: ($applicationUrl | nullable),
       candidateSha: $candidateSha,
       environment: $environment,
       executionRoleArn: $executionRoleArn,
       functionName: ($functionName | nullable),
       functionVersion: ($functionVersion | nullable),
       greenfieldOwner: ($greenfieldOwner | nullable),
       hasPreviousStack: $hasPreviousStack,
       parametersSha256: ($parametersSha256 | nullable),
       region: $region,
       runAttempt: $runAttempt,
       runId: $runId,
       schema: $schema,
       stackId: ($stackId | nullable),
       stackName: $stackName,
       stackRevision: ($stackRevision | nullable),
       stackState: $stackState,
       stackStatus: ($stackStatus | nullable),
       tagsSha256: ($tagsSha256 | nullable),
       templateSha256: ($templateSha256 | nullable),
       version: $version
     }'
)"
manifest_sha256="$(
  printf '%s' "$manifest" | sha256sum | awk '{print $1}'
)"
[[ "$manifest_sha256" =~ ^[0-9a-f]{64}$ ]]
if [ -n "${EXPECTED_PREVIOUS_RELEASE_SHA256:-}" ]; then
  test "$manifest_sha256" = "$EXPECTED_PREVIOUS_RELEASE_SHA256"
fi

jq -n \
  --arg environment "$ENVIRONMENT" \
  --arg stackName "$STACK_NAME" \
  --arg stackState "$STACK_STATE" \
  --argjson hasPreviousStack "$HAS_PREVIOUS_STACK" \
  --arg manifestSha256 "$manifest_sha256" \
  --arg templateSha256 "$template_sha256" \
  --arg parametersSha256 "$parameters_sha256" \
  --arg tagsSha256 "$tags_sha256" \
  --arg greenfieldOwner "$greenfield_owner" \
  '{
    ok: true,
    schema: "archon.recovery-snapshot.proof",
    version: 1,
    environment: $environment,
    stackName: $stackName,
    stackState: $stackState,
    hasPreviousStack: $hasPreviousStack,
    manifestSha256: $manifestSha256,
    templateSha256: (
      if $templateSha256 == "" then null else $templateSha256 end
    ),
    parametersSha256: (
      if $parametersSha256 == "" then null else $parametersSha256 end
    ),
    tagsSha256: (
      if $tagsSha256 == "" then null else $tagsSha256 end
    ),
    greenfieldOwner: (
      if $greenfieldOwner == "" then null else $greenfieldOwner end
    )
  }'
