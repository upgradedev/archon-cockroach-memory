#!/usr/bin/env bash
# Validate an extracted durable recovery bundle as data. No file from the
# bundle is executed or sourced.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 EXTRACTED_BUNDLE_DIR" >&2
  exit 1
fi
bundle_dir="$1"
if [ ! -d "$bundle_dir" ] || [ -L "$bundle_dir" ]; then
  echo "The extracted recovery bundle directory is invalid." >&2
  exit 1
fi

for name in \
  APP_NAME \
  AWS_ACCOUNT_ID \
  AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN \
  AWS_REGION \
  EXPECTED_CANDIDATE_SHA \
  EXPECTED_INTENT_ID \
  EXPECTED_MANIFEST_SHA256 \
  EXPECTED_SOURCE_CI_RUN_ATTEMPT \
  EXPECTED_SOURCE_CI_RUN_ID \
  EXPECTED_SOURCE_DEPLOY_RUN_ATTEMPT \
  EXPECTED_SOURCE_DEPLOY_RUN_ID \
  GITHUB_REPOSITORY \
  RECOVERY_ENVIRONMENT \
  STACK_NAME; do
  if [ -z "${!name:-}" ]; then
    echo "$name is required to verify the durable recovery bundle." >&2
    exit 1
  fi
done

[[ "$AWS_ACCOUNT_ID" =~ ^[0-9]{12}$ ]]
[[ "$EXPECTED_CANDIDATE_SHA" =~ ^[0-9a-f]{40}$ ]]
[[ "$EXPECTED_INTENT_ID" =~ ^[0-9a-f]{64}$ ]]
[[ "$EXPECTED_MANIFEST_SHA256" =~ ^[0-9a-f]{64}$ ]]
[[ "$EXPECTED_SOURCE_CI_RUN_ID" =~ ^[0-9]+$ ]]
[[ "$EXPECTED_SOURCE_CI_RUN_ATTEMPT" =~ ^[1-9][0-9]*$ ]]
[[ "$EXPECTED_SOURCE_DEPLOY_RUN_ID" =~ ^[0-9]+$ ]]
[[ "$EXPECTED_SOURCE_DEPLOY_RUN_ATTEMPT" =~ ^[1-9][0-9]*$ ]]
[[ "$APP_NAME" =~ ^[a-z0-9][a-z0-9-]*$ ]]
[[ "$AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN" =~ ^arn:aws:iam::${AWS_ACCOUNT_ID}:role/[A-Za-z0-9+=,.@_/-]+$ ]]
case "$RECOVERY_ENVIRONMENT" in
  staging|production) ;;
  *) exit 1 ;;
esac
test "$AWS_REGION" = "eu-west-1"
test "$STACK_NAME" = "${APP_NAME}-${RECOVERY_ENVIRONMENT}"
test "$GITHUB_REPOSITORY" = "upgradedev/archon-cockroach-memory"

manifest_file="$bundle_dir/recovery-intent.json"
test -f "$manifest_file"
test ! -L "$manifest_file"
test "$(
  sha256sum "$manifest_file" | awk '{print $1}'
)" = "$EXPECTED_MANIFEST_SHA256"

artifact_bucket="${APP_NAME}-artifacts-${AWS_ACCOUNT_ID}-${AWS_REGION}"
jq -e \
  --arg account "$AWS_ACCOUNT_ID" \
  --arg app "$APP_NAME" \
  --arg bucket "$artifact_bucket" \
  --arg candidate "$EXPECTED_CANDIDATE_SHA" \
  --arg environment "$RECOVERY_ENVIRONMENT" \
  --arg intent "$EXPECTED_INTENT_ID" \
  --arg sourceCiRunAttempt "$EXPECTED_SOURCE_CI_RUN_ATTEMPT" \
  --arg sourceCiRunId "$EXPECTED_SOURCE_CI_RUN_ID" \
  --arg repository "$GITHUB_REPOSITORY" \
  --arg role "$AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN" \
  --arg runAttempt "$EXPECTED_SOURCE_DEPLOY_RUN_ATTEMPT" \
  --arg runId "$EXPECTED_SOURCE_DEPLOY_RUN_ID" \
  --arg stack "$STACK_NAME" \
  '
    type == "object"
    and (keys | sort) == ([
      "accountId",
      "appName",
      "applicationUrl",
      "artifactBucket",
      "candidateSha",
      "environment",
      "executionRoleArn",
      "files",
      "functionName",
      "functionVersion",
      "greenfieldOwner",
      "hasPreviousStack",
      "intentId",
      "parametersSha256",
      "previousReleaseSha256",
      "region",
      "repository",
      "schema",
      "sourceCiRunAttempt",
      "sourceCiRunId",
      "sourceDeployRunAttempt",
      "sourceDeployRunId",
      "stackId",
      "stackName",
      "stackRevision",
      "stackState",
      "stackStatus",
      "tagsSha256",
      "templateSha256",
      "version"
    ] | sort)
    and .schema == "archon.durable-recovery-intent"
    and .version == 1
    and .accountId == $account
    and .appName == $app
    and .artifactBucket == $bucket
    and .candidateSha == $candidate
    and .environment == $environment
    and .executionRoleArn == $role
    and .intentId == $intent
    and .region == "eu-west-1"
    and .repository == $repository
    and .sourceDeployRunId == $runId
    and .sourceDeployRunAttempt == $runAttempt
    and .sourceCiRunId == $sourceCiRunId
    and .sourceCiRunAttempt == $sourceCiRunAttempt
    and .stackName == $stack
    and (.previousReleaseSha256 | test("^[0-9a-f]{64}$"))
    and (
      .files
      | type == "array"
      and length >= 3
      and all(.[];
        ((keys | sort) == ["bytes", "path", "sha256"])
        and (.bytes | type == "number" and . >= 0 and floor == .)
        and (
          .path
          | type == "string"
            and test("^[a-z0-9][a-z0-9.-]*$")
            and (contains("..") | not)
        )
        and (.sha256 | type == "string" and test("^[0-9a-f]{64}$")))
      and ([.[].path] | unique | length) == length
      and ([.[].path] == ([.[].path] | sort))
    )
    and (
      (
        .stackState == "existing"
        and .hasPreviousStack == true
        and (.stackId | type == "string" and startswith(
          "arn:aws:cloudformation:eu-west-1:" + $account + ":stack/" + $stack + "/"
        ))
        and (
          .stackStatus == "CREATE_COMPLETE"
          or .stackStatus == "UPDATE_COMPLETE"
          or .stackStatus == "UPDATE_ROLLBACK_COMPLETE"
        )
        and (.stackRevision | type == "string" and length > 0)
        and .functionName == ($app + "-" + $environment + "-api")
        and (.functionVersion | test("^[1-9][0-9]*$"))
        and (.applicationUrl | type == "string" and startswith("https://"))
        and .greenfieldOwner == null
        and (.templateSha256 | test("^[0-9a-f]{64}$"))
        and (.parametersSha256 | test("^[0-9a-f]{64}$"))
        and (.tagsSha256 | test("^[0-9a-f]{64}$"))
      )
      or
      (
        .stackState == "greenfield"
        and .hasPreviousStack == false
        and .stackId == null
        and .stackStatus == null
        and .stackRevision == null
        and .functionName == null
        and .functionVersion == null
        and .applicationUrl == null
        and (.greenfieldOwner | test("^[0-9a-f]{64}$"))
        and .templateSha256 == null
        and .parametersSha256 == null
        and .tagsSha256 == null
      )
    )
  ' "$manifest_file" >/dev/null

recomputed_intent_payload="$(
  jq -cS \
    '{
      accountId,
      candidateSha,
      environment,
      previousReleaseSha256,
      repository,
      sourceDeployRunAttempt,
      sourceDeployRunId,
      stackName
    }' "$manifest_file"
)"
recomputed_intent_id="$(
  printf '%s' "$recomputed_intent_payload" |
    sha256sum |
    awk '{print $1}'
)"
test "$recomputed_intent_id" = "$EXPECTED_INTENT_ID"

mapfile -t declared_paths < <(jq -r '.files[].path' "$manifest_file")
mapfile -t actual_paths < <(
  find "$bundle_dir" \
    -mindepth 1 \
    -maxdepth 1 \
    -type f \
    -printf '%f\n' |
    sort
)
expected_paths=(recovery-intent.json "${declared_paths[@]}")
IFS=$'\n' expected_paths=($(printf '%s\n' "${expected_paths[@]}" | sort))
unset IFS
if [ "${#actual_paths[@]}" -ne "${#expected_paths[@]}" ]; then
  echo "The recovery bundle has an unexpected file count." >&2
  exit 1
fi
for index in "${!actual_paths[@]}"; do
  test "${actual_paths[$index]}" = "${expected_paths[$index]}"
done
if find "$bundle_dir" \
    -mindepth 1 \
    -maxdepth 1 \
    ! -type f \
    -print -quit |
  grep -q .; then
  echo "The recovery bundle contains a non-file entry." >&2
  exit 1
fi

for relative_path in "${declared_paths[@]}"; do
  absolute_path="$bundle_dir/$relative_path"
  test -f "$absolute_path"
  test ! -L "$absolute_path"
  expected_size="$(
    jq -er --arg path "$relative_path" \
      '.files[] | select(.path == $path) | .bytes' \
      "$manifest_file"
  )"
  expected_sha256="$(
    jq -er --arg path "$relative_path" \
      '.files[] | select(.path == $path) | .sha256' \
      "$manifest_file"
  )"
  test "$(wc -c <"$absolute_path")" -eq "$expected_size"
  test "$(
    sha256sum "$absolute_path" | awk '{print $1}'
  )" = "$expected_sha256"
done

stack_state="$(jq -er '.stackState' "$manifest_file")"
has_previous_stack="$(jq -er '.hasPreviousStack' "$manifest_file")"
case "$stack_state:$has_previous_stack" in
  existing:true)
    expected_existing=(
      application-s3-access-logging-preflight.json
      frontend-prestate.json
      previous-live-alias.json
      previous-stack-parameters.json
      previous-stack-tags.json
      previous-stack-template.yaml
      recovery-snapshot-proof.json
    )
    had_previous_index="$(
      jq -er '.hadPreviousIndex' "$bundle_dir/frontend-prestate.json"
    )"
    if [ "$had_previous_index" = "true" ]; then
      expected_existing+=(previous-index.html)
    elif [ "$had_previous_index" != "false" ]; then
      exit 1
    fi
    IFS=$'\n' expected_existing=($(printf '%s\n' "${expected_existing[@]}" | sort))
    unset IFS
    test "${#declared_paths[@]}" -eq "${#expected_existing[@]}"
    for index in "${!declared_paths[@]}"; do
      test "${declared_paths[$index]}" = "${expected_existing[$index]}"
    done
    jq -e \
      '
        type == "array"
        and length > 0
        and all(.[];
          ((keys | sort) == ["ParameterKey", "ParameterValue"])
          and (.ParameterKey | type == "string" and length > 0)
          and (
            .ParameterValue
            | type == "string"
              and . != "****"
          ))
        and ([.[].ParameterKey] | unique | length) == length
      ' "$bundle_dir/previous-stack-parameters.json" >/dev/null
    case "$had_previous_index" in
      true)
        printf '%s\n' "${declared_paths[@]}" |
          grep -Fxq previous-index.html
        test "$(
          sha256sum "$bundle_dir/previous-index.html" | awk '{print $1}'
        )" = "$(
          jq -er '.previousIndexSha256' \
            "$bundle_dir/frontend-prestate.json"
        )"
        ;;
      false)
        if printf '%s\n' "${declared_paths[@]}" |
          grep -Fxq previous-index.html; then
          exit 1
        fi
        ;;
      *) exit 1 ;;
    esac
    jq -e \
      --arg account "$AWS_ACCOUNT_ID" \
      --arg app "$APP_NAME" \
      --arg environment "$RECOVERY_ENVIRONMENT" \
      --arg functionVersion "$(jq -er '.functionVersion' "$manifest_file")" \
      '
        (keys | sort) == ([
          "AliasArn",
          "FunctionVersion",
          "Name",
          "RevisionId",
          "RoutingConfig"
        ] | sort)
        and .AliasArn == (
          "arn:aws:lambda:eu-west-1:" + $account + ":function:" +
          $app + "-" + $environment + "-api:live"
        )
        and .Name == "live"
        and .FunctionVersion == $functionVersion
        and (.RevisionId | type == "string" and length > 0)
        and ((.RoutingConfig.AdditionalVersionWeights // {}) == {})
      ' "$bundle_dir/previous-live-alias.json" >/dev/null
    jq -e \
      --arg account "$AWS_ACCOUNT_ID" \
      --arg app "$APP_NAME" \
      --arg environment "$RECOVERY_ENVIRONMENT" \
      '
        (keys | sort) == ([
          "bucket",
          "cacheControl",
          "contentLength",
          "contentType",
          "distributionId",
          "etag",
          "hadPreviousIndex",
          "previousIndexSha256",
          "previousIndexVersionId"
        ] | sort)
        and .bucket == (
          $app + "-" + $environment + "-web-" + $account + "-eu-west-1"
        )
        and (.distributionId | type == "string" and test("^[A-Z0-9]+$"))
        and (
          (
            .hadPreviousIndex == true
            and (.cacheControl | type == "string")
            and (.contentLength | type == "number" and . >= 0 and floor == .)
            and (.contentType | type == "string")
            and (.etag | type == "string" and length > 0)
            and (.previousIndexSha256 | test("^[0-9a-f]{64}$"))
            and (
              .previousIndexVersionId
              | type == "string" and length > 0 and test("^[^[:space:]]+$")
            )
          )
          or
          (
            .hadPreviousIndex == false
            and .cacheControl == null
            and .contentLength == null
            and .contentType == null
            and .etag == null
            and .previousIndexSha256 == null
            and .previousIndexVersionId == null
          )
        )
      ' "$bundle_dir/frontend-prestate.json" >/dev/null
    ;;
  greenfield:false)
    test "${#declared_paths[@]}" -eq 3
    test "${declared_paths[0]}" = \
      application-s3-access-logging-preflight.json
    test "${declared_paths[1]}" = frontend-prestate.json
    test "${declared_paths[2]}" = recovery-snapshot-proof.json
    jq -e \
      --arg account "$AWS_ACCOUNT_ID" \
      --arg app "$APP_NAME" \
      --arg environment "$RECOVERY_ENVIRONMENT" \
      '
       (keys | sort) == ([
         "bucket",
         "cacheControl",
         "contentLength",
         "contentType",
         "distributionId",
         "etag",
         "hadPreviousIndex",
         "previousIndexSha256",
         "previousIndexVersionId"
       ] | sort)
       and .bucket == (
         $app + "-" + $environment + "-web-" + $account + "-eu-west-1"
       )
       and .distributionId == null
       and .cacheControl == null
       and .contentLength == null
       and .contentType == null
       and .etag == null
       and .hadPreviousIndex == false
       and .previousIndexSha256 == null
       and .previousIndexVersionId == null' \
      "$bundle_dir/frontend-prestate.json" >/dev/null
    ;;
  *) exit 1 ;;
esac

jq -e \
  --slurpfile manifest "$manifest_file" \
  '
    .ok == true
    and .schema == "archon.recovery-snapshot.proof"
    and .version == 1
    and .environment == $manifest[0].environment
    and .stackName == $manifest[0].stackName
    and .stackState == $manifest[0].stackState
    and .hasPreviousStack == $manifest[0].hasPreviousStack
    and .manifestSha256 == $manifest[0].previousReleaseSha256
    and .templateSha256 == $manifest[0].templateSha256
    and .parametersSha256 == $manifest[0].parametersSha256
    and .tagsSha256 == $manifest[0].tagsSha256
    and .greenfieldOwner == $manifest[0].greenfieldOwner
  ' "$bundle_dir/recovery-snapshot-proof.json" >/dev/null

if [ "$stack_state" = "existing" ]; then
  jq -e \
    --slurpfile manifest "$manifest_file" \
    '
      def digest($path):
        .files[] | select(.path == $path) | .sha256;
      digest("previous-stack-template.yaml") ==
        $manifest[0].templateSha256
      and digest("previous-stack-parameters.json") ==
        $manifest[0].parametersSha256
      and digest("previous-stack-tags.json") ==
        $manifest[0].tagsSha256
    ' "$manifest_file" >/dev/null
fi

expected_previous_release="$(
  jq -er '.previousReleaseSha256' "$manifest_file"
)"
ENVIRONMENT="$RECOVERY_ENVIRONMENT" \
STACK_STATE="$stack_state" \
HAS_PREVIOUS_STACK="$has_previous_stack" \
PREVIOUS_STACK_TEMPLATE_FILE="$bundle_dir/previous-stack-template.yaml" \
PREVIOUS_STACK_PARAMETERS_FILE="$bundle_dir/previous-stack-parameters.json" \
PREVIOUS_STACK_TAGS_FILE="$bundle_dir/previous-stack-tags.json" \
PREVIOUS_STACK_ID="$(jq -r '.stackId // ""' "$manifest_file")" \
PREVIOUS_STACK_STATUS="$(jq -r '.stackStatus // ""' "$manifest_file")" \
PREVIOUS_STACK_REVISION="$(jq -r '.stackRevision // ""' "$manifest_file")" \
PREVIOUS_FUNCTION_NAME="$(jq -r '.functionName // ""' "$manifest_file")" \
PREVIOUS_FUNCTION_VERSION="$(jq -r '.functionVersion // ""' "$manifest_file")" \
PREVIOUS_APPLICATION_URL="$(jq -r '.applicationUrl // ""' "$manifest_file")" \
EXPECTED_GREENFIELD_OWNER="$(jq -r '.greenfieldOwner // ""' "$manifest_file")" \
EXPECTED_PREVIOUS_RELEASE_SHA256="$expected_previous_release" \
SOURCE_DEPLOY_RUN_ID="$EXPECTED_SOURCE_DEPLOY_RUN_ID" \
SOURCE_DEPLOY_RUN_ATTEMPT="$EXPECTED_SOURCE_DEPLOY_RUN_ATTEMPT" \
CANDIDATE_SHA="$EXPECTED_CANDIDATE_SHA" \
  bash aws/prove-recovery-snapshot.sh >/dev/null

EXPECTED_STACK_STATE="$stack_state" \
APPLICATION_S3_ACCESS_LOGGING_PREFLIGHT_FILE="$bundle_dir/application-s3-access-logging-preflight.json" \
ENVIRONMENT="$RECOVERY_ENVIRONMENT" \
  bash aws/prove-application-s3-access-logging.sh \
    validate-preflight >/dev/null

jq -n \
  --arg environment "$RECOVERY_ENVIRONMENT" \
  --arg intentId "$EXPECTED_INTENT_ID" \
  --arg manifestSha256 "$EXPECTED_MANIFEST_SHA256" \
  '{
    ok: true,
    schema: "archon.durable-recovery-bundle.validation",
    version: 1,
    environment: $environment,
    intentId: $intentId,
    manifestSha256: $manifestSha256
  }'
