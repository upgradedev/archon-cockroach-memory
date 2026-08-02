#!/usr/bin/env bash
# Create a checksum-bound, data-only recovery archive before any application
# stack or frontend mutation. The caller uploads the archive to the private,
# versioned delivery bucket and conditionally arms the S3 CAS intent ledger.
set -euo pipefail
umask 077

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 OUTPUT_TAR" >&2
  exit 1
fi
output_tar="$1"
if [ -e "$output_tar" ] || [ -L "$output_tar" ]; then
  echo "The durable recovery archive target must not already exist." >&2
  exit 1
fi

for name in \
  APP_NAME \
  ARTIFACT_BUCKET \
  AWS_ACCOUNT_ID \
  AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN \
  AWS_REGION \
  CANDIDATE_SHA \
  ENVIRONMENT \
  EXPECTED_PREFLIGHT_SHA256 \
  EXPECTED_PREVIOUS_RELEASE_SHA256 \
  GITHUB_REPOSITORY \
  HAS_PREVIOUS_STACK \
  RECOVERY_SNAPSHOT_PROOF_FILE \
  SOURCE_CI_RUN_ATTEMPT \
  SOURCE_CI_RUN_ID \
  SOURCE_DEPLOY_RUN_ATTEMPT \
  SOURCE_DEPLOY_RUN_ID \
  STACK_NAME \
  STACK_STATE; do
  if [ -z "${!name:-}" ]; then
    echo "$name is required for the durable recovery bundle." >&2
    exit 1
  fi
done

[[ "$APP_NAME" =~ ^[a-z0-9][a-z0-9-]*$ ]]
[[ "$AWS_ACCOUNT_ID" =~ ^[0-9]{12}$ ]]
[[ "$AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN" =~ ^arn:aws:iam::${AWS_ACCOUNT_ID}:role/[A-Za-z0-9+=,.@_/-]+$ ]]
[[ "$CANDIDATE_SHA" =~ ^[0-9a-f]{40}$ ]]
[[ "$EXPECTED_PREFLIGHT_SHA256" =~ ^[0-9a-f]{64}$ ]]
[[ "$EXPECTED_PREVIOUS_RELEASE_SHA256" =~ ^[0-9a-f]{64}$ ]]
[[ "$SOURCE_CI_RUN_ID" =~ ^[0-9]+$ ]]
[[ "$SOURCE_CI_RUN_ATTEMPT" =~ ^[1-9][0-9]*$ ]]
[[ "$SOURCE_DEPLOY_RUN_ID" =~ ^[0-9]+$ ]]
[[ "$SOURCE_DEPLOY_RUN_ATTEMPT" =~ ^[1-9][0-9]*$ ]]
if [ "$AWS_REGION" != "eu-west-1" ]; then
  echo "Durable recovery bundles are restricted to eu-west-1." >&2
  exit 1
fi
case "$ENVIRONMENT" in
  staging|production) ;;
  *)
    echo "Durable recovery bundles require staging or production." >&2
    exit 1
    ;;
esac
if [ "$STACK_NAME" != "${APP_NAME}-${ENVIRONMENT}" ]; then
  echo "The durable recovery stack name is not environment-bound." >&2
  exit 1
fi
if [ "$ARTIFACT_BUCKET" != \
  "${APP_NAME}-artifacts-${AWS_ACCOUNT_ID}-${AWS_REGION}" ]; then
  echo "The durable recovery bucket is not the exact delivery bucket." >&2
  exit 1
fi
if [ "$GITHUB_REPOSITORY" != "upgradedev/archon-cockroach-memory" ]; then
  echo "The durable recovery source repository is not trusted." >&2
  exit 1
fi

preflight_file="${APPLICATION_S3_ACCESS_LOGGING_PREFLIGHT_FILE:-application-s3-access-logging-preflight.json}"
if [ ! -f "$preflight_file" ] ||
   [ -L "$preflight_file" ] ||
   [ ! -f "$RECOVERY_SNAPSHOT_PROOF_FILE" ] ||
   [ -L "$RECOVERY_SNAPSHOT_PROOF_FILE" ]; then
  echo "The preflight and recovery proof inputs are required." >&2
  exit 1
fi

output_parent="$(dirname "$output_tar")"
test -d "$output_parent"
bundle_dir="$(mktemp -d "${output_parent}/archon-recovery-bundle.XXXXXX")"
archive_tmp="$(mktemp "${output_parent}/archon-recovery-archive.XXXXXX")"
cleanup_bundle_dir() {
  rm -rf -- "$bundle_dir"
  rm -f -- "$archive_tmp"
}
trap cleanup_bundle_dir EXIT

preflight_copy="$bundle_dir/application-s3-access-logging-preflight.json"
snapshot_copy="$bundle_dir/recovery-snapshot-proof.json"
cp -- "$preflight_file" "$preflight_copy"
cp -- "$RECOVERY_SNAPSHOT_PROOF_FILE" "$snapshot_copy"
chmod 0600 "$preflight_copy" "$snapshot_copy"

test "$(
  sha256sum "$preflight_copy" | awk '{print $1}'
)" = "$EXPECTED_PREFLIGHT_SHA256"
APPLICATION_S3_ACCESS_LOGGING_PREFLIGHT_FILE="$preflight_copy" \
  EXPECTED_STACK_STATE="$STACK_STATE" \
  bash aws/prove-application-s3-access-logging.sh \
    validate-preflight >/dev/null
jq -e \
  --arg environment "$ENVIRONMENT" \
  --arg expected "$EXPECTED_PREVIOUS_RELEASE_SHA256" \
  '
    .ok == true
    and .schema == "archon.recovery-snapshot.proof"
    and .version == 1
    and .environment == $environment
    and .manifestSha256 == $expected
  ' "$snapshot_copy" >/dev/null

stack_id="${PREVIOUS_STACK_ID:-}"
stack_status="${PREVIOUS_STACK_STATUS:-}"
stack_revision="${PREVIOUS_STACK_REVISION:-}"
function_name="${PREVIOUS_FUNCTION_NAME:-}"
function_version="${PREVIOUS_FUNCTION_VERSION:-}"
application_url="${PREVIOUS_APPLICATION_URL:-}"
greenfield_owner="${EXPECTED_GREENFIELD_OWNER:-}"
bucket_name="${PREVIOUS_BUCKET_NAME:-}"
distribution_id="${PREVIOUS_DISTRIBUTION_ID:-}"
template_sha256=""
parameters_sha256=""
tags_sha256=""
had_previous_index=false
previous_index_version=""
previous_index_sha256=""

case "$STACK_STATE:$HAS_PREVIOUS_STACK" in
  existing:true)
    for name in \
      PREVIOUS_STACK_ID \
      PREVIOUS_STACK_STATUS \
      PREVIOUS_STACK_REVISION \
      PREVIOUS_FUNCTION_NAME \
      PREVIOUS_FUNCTION_VERSION \
      PREVIOUS_APPLICATION_URL \
      PREVIOUS_BUCKET_NAME \
      PREVIOUS_DISTRIBUTION_ID \
      EXPECTED_TEMPLATE_SHA256 \
      EXPECTED_PARAMETERS_SHA256 \
      EXPECTED_TAGS_SHA256; do
      if [ -z "${!name:-}" ]; then
        echo "$name is required for an existing-stack recovery bundle." >&2
        exit 1
      fi
    done
    test -z "$greenfield_owner"
    [[ "$stack_id" == \
      "arn:aws:cloudformation:${AWS_REGION}:${AWS_ACCOUNT_ID}:stack/${STACK_NAME}/"* ]]
    case "$stack_status" in
      CREATE_COMPLETE|UPDATE_COMPLETE|UPDATE_ROLLBACK_COMPLETE) ;;
      *) exit 1 ;;
    esac
    [[ "$function_version" =~ ^[1-9][0-9]*$ ]]
    test "$function_name" = "${APP_NAME}-${ENVIRONMENT}-api"
    [[ "$application_url" =~ ^https:// ]]
    test "$bucket_name" = \
      "${APP_NAME}-${ENVIRONMENT}-web-${AWS_ACCOUNT_ID}-${AWS_REGION}"
    [[ "$distribution_id" =~ ^[A-Z0-9]+$ ]]
    for path in \
      previous-stack-template.yaml \
      previous-stack-parameters.json \
      previous-stack-tags.json; do
      test -f "$path"
      test ! -L "$path"
      cp -- "$path" "$bundle_dir/$path"
      chmod 0600 "$bundle_dir/$path"
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
    template_sha256="$(
      sha256sum "$bundle_dir/previous-stack-template.yaml" | awk '{print $1}'
    )"
    parameters_sha256="$(
      sha256sum "$bundle_dir/previous-stack-parameters.json" | awk '{print $1}'
    )"
    tags_sha256="$(
      sha256sum "$bundle_dir/previous-stack-tags.json" | awk '{print $1}'
    )"
    test "$template_sha256" = "$EXPECTED_TEMPLATE_SHA256"
    test "$parameters_sha256" = "$EXPECTED_PARAMETERS_SHA256"
    test "$tags_sha256" = "$EXPECTED_TAGS_SHA256"

    alias_file="$bundle_dir/previous-live-alias.json"
    aws lambda get-alias \
      --function-name "$function_name" \
      --name live \
      --region "$AWS_REGION" \
      --output json |
      jq -eS \
        --arg arn \
          "arn:aws:lambda:${AWS_REGION}:${AWS_ACCOUNT_ID}:function:${function_name}:live" \
        --arg version "$function_version" \
        '
          select(
            .AliasArn == $arn
            and .Name == "live"
            and .FunctionVersion == $version
            and ((.RoutingConfig.AdditionalVersionWeights // {}) == {})
            and (.RevisionId | type == "string" and length > 0)
          )
          | {
              AliasArn,
              FunctionVersion,
              Name,
              RevisionId,
              RoutingConfig: (.RoutingConfig // {})
            }
        ' >"$alias_file"

    index_head="$(
      aws s3api head-object \
        --bucket "$bucket_name" \
        --key index.html \
        --expected-bucket-owner "$AWS_ACCOUNT_ID" \
        --region "$AWS_REGION" \
        --output json 2>&1
    )" || {
      if grep -Eqi 'NoSuchKey|Not Found|\(404\)' <<<"$index_head"; then
        index_head=""
      else
        echo "Unable to capture the previous frontend index." >&2
        exit 1
      fi
    }
    if [ -n "$index_head" ]; then
      previous_index_version="$(
        jq -er '.VersionId | strings | select(length > 0 and . != "null")' \
          <<<"$index_head"
      )"
      index_get="$(
        aws s3api get-object \
          --bucket "$bucket_name" \
          --key index.html \
          --version-id "$previous_index_version" \
          --expected-bucket-owner "$AWS_ACCOUNT_ID" \
          --region "$AWS_REGION" \
          --output json \
          "$bundle_dir/previous-index.html"
      )"
      jq -e \
        --arg version "$previous_index_version" \
        --argjson head "$index_head" \
        '
          .VersionId == $version
          and .ETag == $head.ETag
          and .ContentLength == $head.ContentLength
          and .ContentType == $head.ContentType
          and .CacheControl == $head.CacheControl
        ' <<<"$index_get" >/dev/null
      previous_index_sha256="$(
        sha256sum "$bundle_dir/previous-index.html" | awk '{print $1}'
      )"
      had_previous_index=true
      jq -cnS \
        --arg bucket "$bucket_name" \
        --arg cacheControl "$(jq -r '.CacheControl // ""' <<<"$index_head")" \
        --arg contentType "$(jq -r '.ContentType // ""' <<<"$index_head")" \
        --arg distributionId "$distribution_id" \
        --arg etag "$(jq -er '.ETag' <<<"$index_head")" \
        --arg sha256 "$previous_index_sha256" \
        --arg versionId "$previous_index_version" \
        --argjson contentLength "$(jq -er '.ContentLength' <<<"$index_head")" \
        '{
          bucket: $bucket,
          cacheControl: $cacheControl,
          contentLength: $contentLength,
          contentType: $contentType,
          distributionId: $distributionId,
          etag: $etag,
          hadPreviousIndex: true,
          previousIndexSha256: $sha256,
          previousIndexVersionId: $versionId
        }' >"$bundle_dir/frontend-prestate.json"
    else
      jq -cnS \
        --arg bucket "$bucket_name" \
        --arg distributionId "$distribution_id" \
        '{
          bucket: $bucket,
          cacheControl: null,
          contentLength: null,
          contentType: null,
          distributionId: $distributionId,
          etag: null,
          hadPreviousIndex: false,
          previousIndexSha256: null,
          previousIndexVersionId: null
        }' >"$bundle_dir/frontend-prestate.json"
    fi
    ;;

  greenfield:false)
    for value in \
      "$stack_id" \
      "$stack_status" \
      "$stack_revision" \
      "$function_name" \
      "$function_version" \
      "$application_url" \
      "$bucket_name" \
      "$distribution_id"; do
      test -z "$value"
    done
    [[ "$greenfield_owner" =~ ^[0-9a-f]{64}$ ]]
    for path in \
      previous-stack-template.yaml \
      previous-stack-parameters.json \
      previous-stack-tags.json; do
      test ! -e "$path"
    done
    jq -cnS \
      --arg bucket \
        "${APP_NAME}-${ENVIRONMENT}-web-${AWS_ACCOUNT_ID}-${AWS_REGION}" \
      '{
        bucket: $bucket,
        cacheControl: null,
        contentLength: null,
        contentType: null,
        distributionId: null,
        etag: null,
        hadPreviousIndex: false,
        previousIndexSha256: null,
        previousIndexVersionId: null
      }' >"$bundle_dir/frontend-prestate.json"
    ;;

  *)
    echo "The durable recovery stack-state contract is inconsistent." >&2
    exit 1
    ;;
esac

component_paths=(
  application-s3-access-logging-preflight.json
  frontend-prestate.json
  recovery-snapshot-proof.json
)
if [ "$STACK_STATE" = "existing" ]; then
  component_paths+=(
    previous-live-alias.json
    previous-stack-parameters.json
    previous-stack-tags.json
    previous-stack-template.yaml
  )
  if [ "$had_previous_index" = "true" ]; then
    component_paths+=(previous-index.html)
  fi
fi
mapfile -t component_paths < <(
  printf '%s\n' "${component_paths[@]}" | LC_ALL=C sort
)
files_json='[]'
for relative_path in "${component_paths[@]}"; do
  absolute_path="$bundle_dir/$relative_path"
  test -f "$absolute_path"
  file_size="$(wc -c <"$absolute_path")"
  file_sha256="$(sha256sum "$absolute_path" | awk '{print $1}')"
  files_json="$(
    jq -cnS \
      --argjson current "$files_json" \
      --arg path "$relative_path" \
      --arg sha256 "$file_sha256" \
      --argjson bytes "$file_size" \
      '$current + [{bytes: $bytes, path: $path, sha256: $sha256}]'
  )"
done

intent_payload="$(
  jq -cnS \
    --arg accountId "$AWS_ACCOUNT_ID" \
    --arg candidateSha "$CANDIDATE_SHA" \
    --arg environment "$ENVIRONMENT" \
    --arg previousReleaseSha256 "$EXPECTED_PREVIOUS_RELEASE_SHA256" \
    --arg repository "$GITHUB_REPOSITORY" \
    --arg sourceDeployRunAttempt "$SOURCE_DEPLOY_RUN_ATTEMPT" \
    --arg sourceDeployRunId "$SOURCE_DEPLOY_RUN_ID" \
    --arg stackName "$STACK_NAME" \
    '{
      accountId: $accountId,
      candidateSha: $candidateSha,
      environment: $environment,
      previousReleaseSha256: $previousReleaseSha256,
      repository: $repository,
      sourceDeployRunAttempt: $sourceDeployRunAttempt,
      sourceDeployRunId: $sourceDeployRunId,
      stackName: $stackName
    }'
)"
intent_id="$(
  printf '%s' "$intent_payload" | sha256sum | awk '{print $1}'
)"
[[ "$intent_id" =~ ^[0-9a-f]{64}$ ]]

manifest="$(
  jq -cnS \
    --arg accountId "$AWS_ACCOUNT_ID" \
    --arg appName "$APP_NAME" \
    --arg applicationUrl "$application_url" \
    --arg artifactBucket "$ARTIFACT_BUCKET" \
    --arg candidateSha "$CANDIDATE_SHA" \
    --arg environment "$ENVIRONMENT" \
    --arg executionRoleArn "$AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN" \
    --arg functionName "$function_name" \
    --arg functionVersion "$function_version" \
    --arg greenfieldOwner "$greenfield_owner" \
    --arg intentId "$intent_id" \
    --arg parametersSha256 "$parameters_sha256" \
    --arg previousReleaseSha256 "$EXPECTED_PREVIOUS_RELEASE_SHA256" \
    --arg region "$AWS_REGION" \
    --arg repository "$GITHUB_REPOSITORY" \
    --arg schema "archon.durable-recovery-intent" \
    --arg sourceCiRunAttempt "$SOURCE_CI_RUN_ATTEMPT" \
    --arg sourceCiRunId "$SOURCE_CI_RUN_ID" \
    --arg sourceDeployRunAttempt "$SOURCE_DEPLOY_RUN_ATTEMPT" \
    --arg sourceDeployRunId "$SOURCE_DEPLOY_RUN_ID" \
    --arg stackId "$stack_id" \
    --arg stackName "$STACK_NAME" \
    --arg stackRevision "$stack_revision" \
    --arg stackState "$STACK_STATE" \
    --arg stackStatus "$stack_status" \
    --arg tagsSha256 "$tags_sha256" \
    --arg templateSha256 "$template_sha256" \
    --argjson files "$files_json" \
    --argjson hasPreviousStack "$HAS_PREVIOUS_STACK" \
    --argjson version 1 \
    '
      def nullable: if . == "" then null else . end;
      {
        accountId: $accountId,
        appName: $appName,
        applicationUrl: ($applicationUrl | nullable),
        artifactBucket: $artifactBucket,
        candidateSha: $candidateSha,
        environment: $environment,
        executionRoleArn: $executionRoleArn,
        files: $files,
        functionName: ($functionName | nullable),
        functionVersion: ($functionVersion | nullable),
        greenfieldOwner: ($greenfieldOwner | nullable),
        hasPreviousStack: $hasPreviousStack,
        intentId: $intentId,
        parametersSha256: ($parametersSha256 | nullable),
        previousReleaseSha256: $previousReleaseSha256,
        region: $region,
        repository: $repository,
        schema: $schema,
        sourceCiRunAttempt: $sourceCiRunAttempt,
        sourceCiRunId: $sourceCiRunId,
        sourceDeployRunAttempt: $sourceDeployRunAttempt,
        sourceDeployRunId: $sourceDeployRunId,
        stackId: ($stackId | nullable),
        stackName: $stackName,
        stackRevision: ($stackRevision | nullable),
        stackState: $stackState,
        stackStatus: ($stackStatus | nullable),
        tagsSha256: ($tagsSha256 | nullable),
        templateSha256: ($templateSha256 | nullable),
        version: $version
      }
    '
)"
printf '%s\n' "$manifest" >"$bundle_dir/recovery-intent.json"
chmod 0600 "$bundle_dir/recovery-intent.json"
manifest_sha256="$(
  sha256sum "$bundle_dir/recovery-intent.json" | awk '{print $1}'
)"
[[ "$manifest_sha256" =~ ^[0-9a-f]{64}$ ]]

tar \
  --format=ustar \
  --sort=name \
  --mtime='UTC 1970-01-01' \
  --owner=0 \
  --group=0 \
  --numeric-owner \
  -cf "$archive_tmp" \
  -C "$bundle_dir" \
  recovery-intent.json \
  "${component_paths[@]}"
archive_sha256="$(sha256sum "$archive_tmp" | awk '{print $1}')"
[[ "$archive_sha256" =~ ^[0-9a-f]{64}$ ]]
ln -- "$archive_tmp" "$output_tar"
rm -f -- "$archive_tmp"

jq -n \
  --arg archiveSha256 "$archive_sha256" \
  --arg environment "$ENVIRONMENT" \
  --arg intentId "$intent_id" \
  --arg manifestSha256 "$manifest_sha256" \
  --arg previousIndexSha256 "$previous_index_sha256" \
  --arg previousIndexVersionId "$previous_index_version" \
  --argjson hadPreviousIndex "$had_previous_index" \
  'def nullable: if . == "" then null else . end;
   {
    ok: true,
    schema: "archon.durable-recovery-bundle.proof",
    version: 1,
    environment: $environment,
    intentId: $intentId,
    manifestSha256: $manifestSha256,
    archiveSha256: $archiveSha256,
    hadPreviousIndex: $hadPreviousIndex,
    previousIndexSha256: ($previousIndexSha256 | nullable),
    previousIndexVersionId: ($previousIndexVersionId | nullable)
  }'
