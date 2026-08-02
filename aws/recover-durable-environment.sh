#!/usr/bin/env bash
# Restore one claimed environment from a strictly verified durable bundle and
# emit a sanitized terminal receipt. The caller uploads the receipt and only
# then performs the RECOVERING -> RECOVERED ledger transition.
set -euo pipefail
umask 077

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 VERIFIED_BUNDLE_DIR OUTPUT_RECEIPT" >&2
  exit 1
fi
bundle_dir="$1"
output_receipt="$2"

for name in \
  APP_NAME \
  AWS_ACCOUNT_ID \
  AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN \
  AWS_REGION \
  GITHUB_REPOSITORY \
  GITHUB_WORKFLOW_REF \
  RECOVERY_CODE_SHA \
  RECOVERY_ENVIRONMENT \
  RECOVERY_EXECUTION_ID \
  RECOVERY_INTENT_ID \
  RECOVERY_LEASE_OWNER \
  STACK_NAME; do
  if [ -z "${!name:-}" ]; then
    echo "$name is required for durable environment recovery." >&2
    exit 1
  fi
done
[[ "$APP_NAME" =~ ^[a-z0-9][a-z0-9-]*$ ]]
[[ "$AWS_ACCOUNT_ID" =~ ^[0-9]{12}$ ]]
[[ "$AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN" =~ ^arn:aws:iam::${AWS_ACCOUNT_ID}:role/[A-Za-z0-9+=,.@_/-]+$ ]]
[[ "$RECOVERY_CODE_SHA" =~ ^[0-9a-f]{40}$ ]]
[[ "$RECOVERY_EXECUTION_ID" =~ ^[A-Za-z0-9][A-Za-z0-9-]{0,63}$ ]]
[[ "$RECOVERY_INTENT_ID" =~ ^[0-9a-f]{64}$ ]]
[[ "$RECOVERY_LEASE_OWNER" =~ ^[A-Za-z0-9][A-Za-z0-9-]{0,127}$ ]]
test "$AWS_REGION" = "eu-west-1"
test "$GITHUB_REPOSITORY" = "upgradedev/archon-cockroach-memory"
test "$GITHUB_WORKFLOW_REF" = \
  "upgradedev/archon-cockroach-memory/.github/workflows/recover-aws.yml@refs/heads/main"
test "$STACK_NAME" = "${APP_NAME}-${RECOVERY_ENVIRONMENT}"
storage_key_alias="arn:aws:kms:${AWS_REGION}:${AWS_ACCOUNT_ID}:alias/${APP_NAME}-storage"
test -d "$bundle_dir"
test ! -L "$bundle_dir"
if [ -e "$output_receipt" ] || [ -L "$output_receipt" ]; then
  echo "The durable recovery receipt target must not exist." >&2
  exit 1
fi
test -d "$(dirname "$output_receipt")"

recovery_cancelled="${RECOVERY_CANCELLED:-false}"
case "$recovery_cancelled" in
  true|false) ;;
  *) exit 1 ;;
esac

work_parent="${RUNNER_TEMP:-$(dirname "$output_receipt")}"
test -d "$work_parent"
work_dir="$(mktemp -d "${work_parent}/archon-durable-recovery.XXXXXX")"
receipt_tmp="$(mktemp "${work_parent}/archon-recovery-receipt.XXXXXX")"
cleanup_recovery_work() {
  rm -rf -- "$work_dir"
  rm -f -- "$receipt_tmp"
}
trap cleanup_recovery_work EXIT

ledger_file="$work_dir/ledger.json"
bash aws/recovery-intent-ledger.sh read >"$ledger_file"
artifact_bucket="${APP_NAME}-artifacts-${AWS_ACCOUNT_ID}-${AWS_REGION}"
jq -e \
  --arg bucket "$artifact_bucket" \
  --arg environment "$RECOVERY_ENVIRONMENT" \
  --arg intent "$RECOVERY_INTENT_ID" \
  --arg owner "$RECOVERY_LEASE_OWNER" \
  '
    .exists == true
    and .environment == $environment
    and .state == "RECOVERING"
    and .intentId == $intent
    and .leaseOwner == $owner
    and .archiveBucket == $bucket
    and .archiveKey == (
      "candidates/recovery/" + $environment + "/" + $intent + ".tar"
    )
    and (.archiveVersionId | type == "string" and length > 0)
    and (.archiveSha256 | test("^[0-9a-f]{64}$"))
    and (.manifestSha256 | test("^[0-9a-f]{64}$"))
    and (.candidateSha | test("^[0-9a-f]{40}$"))
    and (.sourceCiRunId | test("^[0-9]+$"))
    and (.sourceCiRunAttempt | test("^[1-9][0-9]*$"))
    and (.sourceRunId | test("^[0-9]+$"))
    and (.sourceRunAttempt | test("^[1-9][0-9]*$"))
    and (
      .updatedAt
      | type == "number"
        and . > 0
        and floor == .
    )
    and (
      .leaseUntil
      | type == "number"
        and . > 0
        and floor == .
    )
    and .leaseUntil > .updatedAt
    and (.ledgerEtag | test("^\"[0-9a-f]{32}\"$"))
    and (.ledgerSha256 | test("^[0-9a-f]{64}$"))
    and (
      .ledgerVersionId
      | type == "string"
        and length > 0
        and test("^[^[:space:]]+$")
    )
  ' "$ledger_file" >/dev/null

candidate_sha="$(jq -er '.candidateSha' "$ledger_file")"
manifest_sha256="$(jq -er '.manifestSha256' "$ledger_file")"
recovering_ledger_etag="$(jq -er '.ledgerEtag' "$ledger_file")"
recovering_ledger_lease_until="$(jq -er '.leaseUntil' "$ledger_file")"
recovering_ledger_sha256="$(jq -er '.ledgerSha256' "$ledger_file")"
recovering_ledger_updated_at="$(jq -er '.updatedAt' "$ledger_file")"
recovering_ledger_version_id="$(jq -er '.ledgerVersionId' "$ledger_file")"
source_ci_run_id="$(jq -er '.sourceCiRunId' "$ledger_file")"
source_ci_run_attempt="$(jq -er '.sourceCiRunAttempt' "$ledger_file")"
source_deploy_run_id="$(jq -er '.sourceRunId' "$ledger_file")"
source_deploy_run_attempt="$(jq -er '.sourceRunAttempt' "$ledger_file")"
EXPECTED_CANDIDATE_SHA="$candidate_sha" \
EXPECTED_INTENT_ID="$RECOVERY_INTENT_ID" \
EXPECTED_MANIFEST_SHA256="$manifest_sha256" \
EXPECTED_SOURCE_CI_RUN_ATTEMPT="$source_ci_run_attempt" \
EXPECTED_SOURCE_CI_RUN_ID="$source_ci_run_id" \
EXPECTED_SOURCE_DEPLOY_RUN_ATTEMPT="$source_deploy_run_attempt" \
EXPECTED_SOURCE_DEPLOY_RUN_ID="$source_deploy_run_id" \
  bash aws/verify-durable-recovery-bundle.sh "$bundle_dir" >/dev/null

manifest_file="$bundle_dir/recovery-intent.json"
stack_state="$(jq -er '.stackState' "$manifest_file")"
has_previous_stack="$(
  jq -er \
    '.hasPreviousStack
     | if type == "boolean"
       then tostring
       else error("invalid previous-stack state")
       end' \
    "$manifest_file"
)"
expected_preflight_sha256="$(
  jq -er \
    '.files[] |
     select(.path == "application-s3-access-logging-preflight.json") |
     .sha256' \
    "$manifest_file"
)"
preflight_file="$bundle_dir/application-s3-access-logging-preflight.json"

prove_logging_recovery() {
  local proof_file="$1"
  test "$(
    sha256sum "$preflight_file" | awk '{print $1}'
  )" = "$expected_preflight_sha256"
  APPLICATION_S3_ACCESS_LOGGING_PREFLIGHT_FILE="$preflight_file" \
  EXPECTED_STACK_STATE="$stack_state" \
  ENVIRONMENT="$RECOVERY_ENVIRONMENT" \
    bash aws/prove-application-s3-access-logging.sh recover >"$proof_file"
  jq -e \
    --slurpfile preflight "$preflight_file" \
    --arg stackState "$stack_state" \
    '
      ($preflight | length) == 1
      and .ok == true
      and .schema == "archon.application-s3-access-logging.recovery"
      and .version == 1
      and .mode == "recover"
      and .evidence == "live-control-plane"
      and .foundationVerified == true
      and .environment == $preflight[0].environment
      and .stackState == $stackState
      and .sourceBucket == $preflight[0].sourceBucket
      and .destinationBucket == $preflight[0].destinationBucket
      and .priorState == $preflight[0].priorState
      and .restoredState == $preflight[0].priorState
      and .preflightIntegrity == $preflight[0].integrity
      and (
        (
          .restoredState == "absent"
          and .restoredConfiguration == null
        )
        or
        (
          .restoredState == "disabled"
          and .restoredConfiguration == {}
        )
        or
        (
          .restoredState == "enabled"
          and .restoredConfiguration == .expected
        )
      )
    ' "$proof_file" >/dev/null
}

prove_stack_absent() {
  local result
  if result="$(
    aws cloudformation describe-stacks \
      --stack-name "$STACK_NAME" \
      --region "$AWS_REGION" 2>&1
  )"; then
    echo "The failed greenfield stack still exists." >&2
    return 1
  fi
  grep -qi "does not exist" <<<"$result"
}

prove_bucket_absent() {
  local bucket="$1"
  local result
  if result="$(
    aws s3api get-bucket-location \
      --bucket "$bucket" \
      --expected-bucket-owner "$AWS_ACCOUNT_ID" \
      --region "$AWS_REGION" 2>&1
  )"; then
    echo "The failed greenfield bucket still exists." >&2
    return 1
  fi
  [[ "$result" =~ (^|[^[:alnum:]])NoSuchBucket([^[:alnum:]]|$) ]]
}

prove_log_absent() {
  local log_arn="$1"
  local result
  if result="$(
    aws logs list-tags-for-resource \
      --resource-arn "$log_arn" \
      --region "$AWS_REGION" 2>&1
  )"; then
    echo "A failed greenfield log group still exists." >&2
    return 1
  fi
  grep -qi "ResourceNotFoundException" <<<"$result"
}

logging_proof="$work_dir/application-s3-logging-recovery.json"
stack_proof="$work_dir/stack-recovery-proof.json"
frontend_proof="$work_dir/frontend-recovery-proof.json"
alias_proof="$work_dir/alias-recovery-proof.json"
live_proof="$work_dir/live-recovery-proof.json"

case "$stack_state:$has_previous_stack" in
  greenfield:false)
    greenfield_owner="$(jq -er '.greenfieldOwner' "$manifest_file")"
    cleanup_proof="$work_dir/greenfield-cleanup.json"
    GREENFIELD_OWNER="$greenfield_owner" \
    ENVIRONMENT="$RECOVERY_ENVIRONMENT" \
    RECOVERY_CANCELLED="$recovery_cancelled" \
      bash aws/delete-greenfield-stack.sh >"$cleanup_proof"
    if [ "$recovery_cancelled" = "true" ]; then
      jq -n \
        --arg environment "$RECOVERY_ENVIRONMENT" \
        --arg intentId "$RECOVERY_INTENT_ID" \
        '{
          ok: true,
          state: "aws-native-handoff",
          environment: $environment,
          intentId: $intentId
        }'
      exit 0
    fi
    jq -e \
      '
        .ok == true
        and .schema == "archon.greenfield-cleanup.proof"
        and .version == 1
        and (
          .state == "greenfield-cleaned"
          or .state == "greenfield-stack-absent"
        )
      ' "$cleanup_proof" >/dev/null
    bucket="$(jq -er '.bucket' "$bundle_dir/frontend-prestate.json")"
    legacy_log_arn="arn:aws:logs:${AWS_REGION}:${AWS_ACCOUNT_ID}:log-group:/aws/apigateway/${APP_NAME}-${RECOVERY_ENVIRONMENT}"
    vended_log_arn="arn:aws:logs:${AWS_REGION}:${AWS_ACCOUNT_ID}:log-group:/aws/vendedlogs/apigateway/${APP_NAME}-${RECOVERY_ENVIRONMENT}"
    lambda_log_arn="arn:aws:logs:${AWS_REGION}:${AWS_ACCOUNT_ID}:log-group:/aws/lambda/${APP_NAME}-${RECOVERY_ENVIRONMENT}-api"
    prove_stack_absent
    prove_bucket_absent "$bucket"
    prove_log_absent "$legacy_log_arn"
    prove_log_absent "$vended_log_arn"
    prove_log_absent "$lambda_log_arn"
    prove_logging_recovery "$logging_proof"
    jq -n \
      --arg stackName "$STACK_NAME" \
      --slurpfile cleanup "$cleanup_proof" \
      '{
        ok: true,
        stackName: $stackName,
        state: "absent",
        retainedResources: "absent",
        cleanup: $cleanup[0],
        absence: {
          stack: true,
          bucket: true,
          legacyApiLog: true,
          vendedApiLog: true,
          lambdaLog: true
        }
      }' >"$stack_proof"
    jq -n \
      '{ok: true, state: "not-applicable-greenfield"}' >"$frontend_proof"
    jq -n \
      '{ok: true, state: "not-applicable-greenfield"}' >"$alias_proof"
    jq -n \
      '{ok: true, state: "not-applicable-greenfield"}' >"$live_proof"
    ;;

  existing:true)
    previous_stack_id="$(jq -er '.stackId' "$manifest_file")"
    template_sha256="$(jq -er '.templateSha256' "$manifest_file")"
    parameters_sha256="$(jq -er '.parametersSha256' "$manifest_file")"
    tags_sha256="$(jq -er '.tagsSha256' "$manifest_file")"
    EXPECTED_PREVIOUS_STACK_ID="$previous_stack_id" \
    EXPECTED_PREVIOUS_STACK_TEMPLATE_SHA256="$template_sha256" \
    EXPECTED_PREVIOUS_STACK_PARAMETERS_SHA256="$parameters_sha256" \
    EXPECTED_PREVIOUS_STACK_TAGS_SHA256="$tags_sha256" \
    PREVIOUS_STACK_TEMPLATE_FILE="$bundle_dir/previous-stack-template.yaml" \
    PREVIOUS_STACK_PARAMETERS_FILE="$bundle_dir/previous-stack-parameters.json" \
    PREVIOUS_STACK_TAGS_FILE="$bundle_dir/previous-stack-tags.json" \
    RECOVERY_CANCELLED="$recovery_cancelled" \
      bash aws/restore-cloudformation-stack.sh
    if [ "$recovery_cancelled" = "true" ]; then
      jq -n \
        --arg environment "$RECOVERY_ENVIRONMENT" \
        --arg intentId "$RECOVERY_INTENT_ID" \
        '{
          ok: true,
          state: "aws-native-handoff",
          environment: $environment,
          intentId: $intentId
        }'
      exit 0
    fi

    prove_logging_recovery "$logging_proof"
    restored_stack="$work_dir/restored-stack.json"
    restored_template="$work_dir/restored-template.yaml"
    restored_parameters="$work_dir/restored-parameters.json"
    restored_tags="$work_dir/restored-tags.json"
    aws cloudformation describe-stacks \
      --stack-name "$previous_stack_id" \
      --region "$AWS_REGION" \
      --output json >"$restored_stack"
    aws cloudformation get-template \
      --stack-name "$previous_stack_id" \
      --template-stage Original \
      --region "$AWS_REGION" \
      --output json |
      jq -er \
        '.TemplateBody | if type == "string" then . else tojson end' \
        >"$restored_template"
    jq \
      '.Stacks[0].Parameters |
       map({ParameterKey, ParameterValue}) |
       sort_by(.ParameterKey)' \
      "$restored_stack" >"$restored_parameters"
    jq \
      '(.Stacks[0].Tags // []) |
       map({Key, Value}) |
       sort_by(.Key)' \
      "$restored_stack" >"$restored_tags"
    expected_parameters="$work_dir/expected-parameters.json"
    expected_tags="$work_dir/expected-tags.json"
    jq 'sort_by(.ParameterKey)' \
      "$bundle_dir/previous-stack-parameters.json" >"$expected_parameters"
    jq 'sort_by(.Key)' \
      "$bundle_dir/previous-stack-tags.json" >"$expected_tags"
    cmp --silent "$restored_parameters" "$expected_parameters"
    cmp --silent "$restored_tags" "$expected_tags"
    test "$(
      sha256sum "$restored_template" | awk '{print $1}'
    )" = "$template_sha256"
    jq -e \
      --arg app "$APP_NAME" \
      --arg environment "$RECOVERY_ENVIRONMENT" \
      --arg expectedUrl "$(jq -er '.applicationUrl' "$manifest_file")" \
      --arg function "$(jq -er '.functionName' "$manifest_file")" \
      --arg role "$AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN" \
      --arg stackId "$previous_stack_id" \
      '
        (.Stacks | length) == 1
        and .Stacks[0].StackId == $stackId
        and .Stacks[0].RoleARN == $role
        and (
          .Stacks[0].StackStatus == "CREATE_COMPLETE"
          or .Stacks[0].StackStatus == "UPDATE_COMPLETE"
          or .Stacks[0].StackStatus == "UPDATE_ROLLBACK_COMPLETE"
        )
        and (
          [.Stacks[0].Outputs[] |
           select(.OutputKey == "FunctionName") |
           .OutputValue] == [$function]
        )
        and (
          [.Stacks[0].Outputs[] |
           select(.OutputKey == "ApplicationUrl") |
           .OutputValue] == [$expectedUrl]
        )
        and (
          [.Stacks[0].Outputs[] |
           select(.OutputKey == "SpaBucketName") |
           .OutputValue] == [
             $app + "-" + $environment + "-web-" + env.AWS_ACCOUNT_ID +
             "-" + env.AWS_REGION
           ]
        )
        and (
          [.Stacks[0].Outputs[] |
           select(.OutputKey == "DistributionId") |
           .OutputValue |
           select(test("^[A-Z0-9]+$"))] | length
        ) == 1
      ' "$restored_stack" >/dev/null
    bucket="$(
      jq -er \
        '.Stacks[0].Outputs[] |
         select(.OutputKey == "SpaBucketName") |
         .OutputValue' \
        "$restored_stack"
    )"
    distribution_id="$(
      jq -er \
        '.Stacks[0].Outputs[] |
         select(.OutputKey == "DistributionId") |
         .OutputValue' \
        "$restored_stack"
    )"
    test "$bucket" = "$(jq -er '.bucket' "$bundle_dir/frontend-prestate.json")"
    test "$distribution_id" = \
      "$(jq -er '.distributionId' "$bundle_dir/frontend-prestate.json")"
    jq -n \
      --arg parametersSha256 "$(
        sha256sum "$restored_parameters" | awk '{print $1}'
      )" \
      --arg stackId "$previous_stack_id" \
      --arg stackRevision "$(
        jq -er \
          '.Stacks[0].LastUpdatedTime // .Stacks[0].CreationTime' \
          "$restored_stack"
      )" \
      --arg tagsSha256 "$(
        sha256sum "$restored_tags" | awk '{print $1}'
      )" \
      --arg templateSha256 "$template_sha256" \
      '{
        ok: true,
        stackId: $stackId,
        stackRevision: $stackRevision,
        state: "restored",
        templateSha256: $templateSha256,
        parametersSha256: $parametersSha256,
        tagsSha256: $tagsSha256
      }' >"$stack_proof"

    had_previous_index="$(
      jq -er \
        '.hadPreviousIndex
         | if type == "boolean"
           then tostring
           else error("invalid previous-index state")
           end' \
        "$bundle_dir/frontend-prestate.json"
    )"
    if [ "$had_previous_index" = "true" ]; then
      previous_index="$bundle_dir/previous-index.html"
      previous_index_sha256="$(
        jq -er '.previousIndexSha256' "$bundle_dir/frontend-prestate.json"
      )"
      content_type="$(
        jq -er '.contentType | strings' \
          "$bundle_dir/frontend-prestate.json"
      )"
      cache_control="$(
        jq -er '.cacheControl | strings' \
          "$bundle_dir/frontend-prestate.json"
      )"
      checksum_base64="$(
        openssl dgst -sha256 -binary "$previous_index" | base64 -w0
      )"
      put_index="$work_dir/put-index.json"
      put_index_args=(
        s3api put-object
        --bucket "$bucket"
        --key index.html
        --body "$previous_index"
        --expected-bucket-owner "$AWS_ACCOUNT_ID"
        --server-side-encryption aws:kms
        --ssekms-key-id "$storage_key_alias"
        --checksum-algorithm SHA256
        --checksum-sha256 "$checksum_base64"
        --region "$AWS_REGION"
        --output json
      )
      if [ -n "$content_type" ]; then
        put_index_args+=(--content-type "$content_type")
      fi
      if [ -n "$cache_control" ]; then
        put_index_args+=(--cache-control "$cache_control")
      fi
      aws "${put_index_args[@]}" >"$put_index"
      restored_index_version="$(
        jq -er '.VersionId | strings | select(length > 0 and . != "null")' \
          "$put_index"
      )"
      restored_index="$work_dir/restored-index.html"
      get_index="$work_dir/get-index.json"
      aws s3api get-object \
        --bucket "$bucket" \
        --key index.html \
        --version-id "$restored_index_version" \
        --expected-bucket-owner "$AWS_ACCOUNT_ID" \
        --checksum-mode ENABLED \
        --region "$AWS_REGION" \
        --output json \
        "$restored_index" >"$get_index"
      test "$(
        sha256sum "$restored_index" | awk '{print $1}'
      )" = "$previous_index_sha256"
      jq -e \
        --arg cacheControl "$cache_control" \
        --arg checksum "$checksum_base64" \
        --arg contentType "$content_type" \
        --arg kmsPrefix \
          "arn:aws:kms:${AWS_REGION}:${AWS_ACCOUNT_ID}:key/" \
        --arg version "$restored_index_version" \
        --argjson length "$(wc -c <"$previous_index")" \
        '
          .VersionId == $version
          and .ChecksumSHA256 == $checksum
          and .ServerSideEncryption == "aws:kms"
          and (
            .SSEKMSKeyId
            | type == "string"
              and startswith($kmsPrefix)
          )
          and .BucketKeyEnabled == true
          and .ContentLength == $length
          and (.ContentType // "") == $contentType
          and (.CacheControl // "") == $cacheControl
        ' "$get_index" >/dev/null
      jq -n \
        --arg sha256 "$previous_index_sha256" \
        --arg versionId "$restored_index_version" \
        '{
          ok: true,
          state: "restored",
          hadPreviousIndex: true,
          sha256: $sha256,
          restoredVersionId: $versionId
        }' >"$frontend_proof"
    else
      current_index=""
      if current_index="$(
        aws s3api head-object \
          --bucket "$bucket" \
          --key index.html \
          --expected-bucket-owner "$AWS_ACCOUNT_ID" \
          --region "$AWS_REGION" \
          --output json 2>&1
      )"; then
        aws s3api delete-object \
          --bucket "$bucket" \
          --key index.html \
          --expected-bucket-owner "$AWS_ACCOUNT_ID" \
          --region "$AWS_REGION" >/dev/null
      elif ! grep -Eqi 'NoSuchKey|Not Found|\(404\)' <<<"$current_index"; then
        echo "Unable to inspect the recovered frontend index." >&2
        exit 1
      fi
      if current_index="$(
        aws s3api head-object \
          --bucket "$bucket" \
          --key index.html \
          --expected-bucket-owner "$AWS_ACCOUNT_ID" \
          --region "$AWS_REGION" \
          --output json 2>&1
      )"; then
        echo "The recovered frontend index should be absent." >&2
        exit 1
      fi
      grep -Eqi 'NoSuchKey|Not Found|\(404\)' <<<"$current_index"
      jq -n \
        '{
          ok: true,
          state: "absent",
          hadPreviousIndex: false
        }' >"$frontend_proof"
    fi

    function_name="$(jq -er '.functionName' "$manifest_file")"
    function_version="$(jq -er '.functionVersion' "$manifest_file")"
    alias_before="$work_dir/alias-before.json"
    alias_after="$work_dir/alias-after.json"
    aws lambda get-alias \
      --function-name "$function_name" \
      --name live \
      --region "$AWS_REGION" \
      --output json >"$alias_before"
    alias_revision="$(
      jq -er \
        --arg arn \
          "arn:aws:lambda:${AWS_REGION}:${AWS_ACCOUNT_ID}:function:${function_name}:live" \
        '
          select(
            .AliasArn == $arn
            and .Name == "live"
            and (.FunctionVersion | test("^[1-9][0-9]*$"))
            and (.RevisionId | type == "string" and length > 0)
          ) |
          .RevisionId
        ' "$alias_before"
    )"
    if ! jq -e \
      --arg version "$function_version" \
      '
        .FunctionVersion == $version
        and ((.RoutingConfig.AdditionalVersionWeights // {}) == {})
      ' "$alias_before" >/dev/null; then
      aws lambda update-alias \
        --function-name "$function_name" \
        --name live \
        --function-version "$function_version" \
        --routing-config '{"AdditionalVersionWeights":{}}' \
        --revision-id "$alias_revision" \
        --region "$AWS_REGION" \
        --output json >/dev/null
    fi
    aws lambda get-alias \
      --function-name "$function_name" \
      --name live \
      --region "$AWS_REGION" \
      --output json >"$alias_after"
    jq -e \
      --arg arn \
        "arn:aws:lambda:${AWS_REGION}:${AWS_ACCOUNT_ID}:function:${function_name}:live" \
      --arg version "$function_version" \
      '
        .AliasArn == $arn
        and .Name == "live"
        and .FunctionVersion == $version
        and ((.RoutingConfig.AdditionalVersionWeights // {}) == {})
        and (.RevisionId | type == "string" and length > 0)
      ' "$alias_after" >/dev/null
    jq -cS \
      '{AliasArn, FunctionVersion, Name, RoutingConfig}' \
      "$alias_after" >"$alias_proof"

    invalidation_id="$(
      aws cloudfront create-invalidation \
        --distribution-id "$distribution_id" \
        --paths '/*' \
        --query 'Invalidation.Id' \
        --output text
    )"
    [[ "$invalidation_id" =~ ^[A-Z0-9]+$ ]]
    aws cloudfront wait invalidation-completed \
      --distribution-id "$distribution_id" \
      --id "$invalidation_id"

    application_url="$(jq -er '.applicationUrl' "$manifest_file")"
    health_file="$work_dir/health.json"
    memory_file="$work_dir/memory-proof.json"
    curl --fail --silent --show-error \
      --retry 12 --retry-delay 5 --retry-all-errors \
      --max-time 30 \
      "$application_url/api/health" >"$health_file"
    jq -e '.ok == true and .status == "reachable"' \
      "$health_file" >/dev/null
    curl --fail --silent --show-error \
      --retry 6 --retry-delay 5 --retry-all-errors \
      --max-time 30 \
      "$application_url/api/proof" >"$memory_file"
    jq -e \
      '.memory.storeVerified == true and .memory.persisted == 9' \
      "$memory_file" >/dev/null
    jq -n \
      --arg applicationUrl "$application_url" \
      --slurpfile health "$health_file" \
      --slurpfile memory "$memory_file" \
      '{
        ok: true,
        applicationUrl: $applicationUrl,
        health: {
          ok: $health[0].ok,
          status: $health[0].status
        },
        memory: {
          storeVerified: $memory[0].memory.storeVerified,
          persisted: $memory[0].memory.persisted
        }
      }' >"$live_proof"
    ;;

  *)
    echo "The durable recovery stack-state contract is invalid." >&2
    exit 1
    ;;
esac

for proof in \
  "$logging_proof" \
  "$stack_proof" \
  "$frontend_proof" \
  "$alias_proof" \
  "$live_proof"; do
  test -s "$proof"
done

completed_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
jq -nS \
  --arg accountId "$AWS_ACCOUNT_ID" \
  --arg appName "$APP_NAME" \
  --arg archiveBucket "$(jq -er '.archiveBucket' "$ledger_file")" \
  --arg archiveKey "$(jq -er '.archiveKey' "$ledger_file")" \
  --arg archiveSha256 "$(jq -er '.archiveSha256' "$ledger_file")" \
  --arg archiveVersionId "$(jq -er '.archiveVersionId' "$ledger_file")" \
  --arg candidateSha "$candidate_sha" \
  --arg codeSha "$RECOVERY_CODE_SHA" \
  --arg completedAt "$completed_at" \
  --arg environment "$RECOVERY_ENVIRONMENT" \
  --arg executionId "$RECOVERY_EXECUTION_ID" \
  --arg executionRoleArn "$AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN" \
  --arg intentId "$RECOVERY_INTENT_ID" \
  --arg leaseOwner "$RECOVERY_LEASE_OWNER" \
  --arg manifestSha256 "$manifest_sha256" \
  --arg recoveringLedgerBucket "$artifact_bucket" \
  --arg recoveringLedgerEtag "$recovering_ledger_etag" \
  --arg recoveringLedgerKey \
    "candidates/recovery/${RECOVERY_ENVIRONMENT}/ledger.json" \
  --argjson recoveringLedgerLeaseUntil "$recovering_ledger_lease_until" \
  --arg recoveringLedgerSha256 "$recovering_ledger_sha256" \
  --argjson recoveringLedgerUpdatedAt "$recovering_ledger_updated_at" \
  --arg recoveringLedgerVersionId "$recovering_ledger_version_id" \
  --arg region "$AWS_REGION" \
  --arg repository "$GITHUB_REPOSITORY" \
  --arg sourceCiRunAttempt "$source_ci_run_attempt" \
  --arg sourceCiRunId "$source_ci_run_id" \
  --arg sourceDeployRunAttempt "$source_deploy_run_attempt" \
  --arg sourceDeployRunId "$source_deploy_run_id" \
  --arg stackName "$STACK_NAME" \
  --arg stackState "$stack_state" \
  --arg workflowRef "$GITHUB_WORKFLOW_REF" \
  --slurpfile aliasProof "$alias_proof" \
  --slurpfile frontendProof "$frontend_proof" \
  --slurpfile liveProof "$live_proof" \
  --slurpfile loggingProof "$logging_proof" \
  --slurpfile stackProof "$stack_proof" \
  '{
    ok: true,
    schema: "archon.durable-recovery.receipt",
    version: 2,
    environment: $environment,
    intentId: $intentId,
    candidateSha: $candidateSha,
    sourceCiRunId: $sourceCiRunId,
    sourceCiRunAttempt: $sourceCiRunAttempt,
    sourceDeployRunId: $sourceDeployRunId,
    sourceDeployRunAttempt: $sourceDeployRunAttempt,
    archive: {
      bucket: $archiveBucket,
      key: $archiveKey,
      versionId: $archiveVersionId,
      sha256: $archiveSha256
    },
    target: {
      appName: $appName,
      accountId: $accountId,
      region: $region,
      stackName: $stackName,
      executionRoleArn: $executionRoleArn
    },
    executor: {
      repository: $repository,
      workflowRef: $workflowRef,
      codeSha: $codeSha,
      executionId: $executionId,
      leaseOwner: $leaseOwner
    },
    recoveringLedger: {
      bucket: $recoveringLedgerBucket,
      key: $recoveringLedgerKey,
      state: "RECOVERING",
      versionId: $recoveringLedgerVersionId,
      etag: $recoveringLedgerEtag,
      sha256: $recoveringLedgerSha256,
      updatedAt: $recoveringLedgerUpdatedAt,
      leaseUntil: $recoveringLedgerLeaseUntil
    },
    manifestSha256: $manifestSha256,
    stackState: $stackState,
    proofs: {
      stack: $stackProof[0],
      s3AccessLogging: $loggingProof[0],
      frontend: $frontendProof[0],
      alias: $aliasProof[0],
      live: $liveProof[0]
    },
    completedAt: $completedAt,
    result: "RECOVERED"
  }' >"$receipt_tmp"
chmod 0600 "$receipt_tmp"
RECOVERY_LEDGER_FILE="$ledger_file" \
RECOVERY_MANIFEST_FILE="$manifest_file" \
  bash aws/verify-durable-recovery-receipt.sh "$receipt_tmp" >/dev/null
ln -- "$receipt_tmp" "$output_receipt"
rm -f -- "$receipt_tmp"

jq -n \
  --arg environment "$RECOVERY_ENVIRONMENT" \
  --arg intentId "$RECOVERY_INTENT_ID" \
  --arg receiptSha256 "$(
    sha256sum "$output_receipt" | awk '{print $1}'
  )" \
  '{
    ok: true,
    schema: "archon.durable-recovery.execution",
    version: 2,
    environment: $environment,
    intentId: $intentId,
    receiptSha256: $receiptSha256
  }'
