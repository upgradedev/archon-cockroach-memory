#!/usr/bin/env bash
# Validate, durably persist, read back, and atomically bind one recovery
# receipt to the RECOVERING -> RECOVERED ledger transition.
set -euo pipefail
umask 077

if [ "$#" -ne 4 ]; then
  echo \
    "Usage: $0 VERIFIED_BUNDLE_DIR RECOVERY_RECEIPT RECOVERY_EXECUTION CLOUDFORMATION_CONTROL_PROOF" \
    >&2
  exit 1
fi
bundle_dir="$1"
receipt_file="$2"
execution_file="$3"
control_proof_file="$4"

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
    echo "$name is required to finalize a durable recovery receipt." >&2
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
case "$RECOVERY_ENVIRONMENT" in
  staging|production) ;;
  *) exit 1 ;;
esac
test "$AWS_REGION" = "eu-west-1"
test "$GITHUB_REPOSITORY" = "upgradedev/archon-cockroach-memory"
test "$GITHUB_WORKFLOW_REF" = \
  "upgradedev/archon-cockroach-memory/.github/workflows/recover-aws.yml@refs/heads/main"
test "$STACK_NAME" = "${APP_NAME}-${RECOVERY_ENVIRONMENT}"

if [ ! -d "$bundle_dir" ] || [ -L "$bundle_dir" ]; then
  echo "The verified recovery bundle directory is invalid." >&2
  exit 1
fi
manifest_file="$bundle_dir/recovery-intent.json"
for input_file in \
  "$manifest_file" \
  "$receipt_file" \
  "$execution_file" \
  "$control_proof_file"; do
  if [ ! -f "$input_file" ] || [ -L "$input_file" ]; then
    echo "A durable recovery finalization input is invalid." >&2
    exit 1
  fi
done

require_single_json_object() {
  local input_file="$1"
  local description="$2"
  if ! jq -s -e \
    'length == 1 and (.[0] | type == "object")' \
    "$input_file" >/dev/null; then
    echo "$description must contain exactly one JSON object." >&2
    return 1
  fi
}

for input_file in \
  "$manifest_file" \
  "$receipt_file" \
  "$execution_file" \
  "$control_proof_file"; do
  require_single_json_object \
    "$input_file" \
    "A durable recovery finalization input"
done

receipt_sha256="$(sha256sum "$receipt_file" | awk '{print $1}')"
[[ "$receipt_sha256" =~ ^[0-9a-f]{64}$ ]]
control_proof_sha256="$(
  sha256sum "$control_proof_file" | awk '{print $1}'
)"
[[ "$control_proof_sha256" =~ ^[0-9a-f]{64}$ ]]
jq -e \
  --arg environment "$RECOVERY_ENVIRONMENT" \
  --arg intent "$RECOVERY_INTENT_ID" \
  --arg receiptSha "$receipt_sha256" \
  '
    keys == [
      "environment",
      "intentId",
      "ok",
      "receiptSha256",
      "schema",
      "version"
    ]
    and .ok == true
    and .schema == "archon.durable-recovery.execution"
    and .version == 2
    and .environment == $environment
    and .intentId == $intent
    and .receiptSha256 == $receiptSha
  ' "$execution_file" >/dev/null

work_parent="${RUNNER_TEMP:-$(dirname "$receipt_file")}"
test -d "$work_parent"
work_dir="$(
  mktemp -d "${work_parent%/}/archon-recovery-finalize.XXXXXX"
)"
cleanup_finalization_work() {
  rm -rf -- "$work_dir"
}
trap cleanup_finalization_work EXIT

current_ledger="$work_dir/current-ledger.json"
validation_ledger="$work_dir/validation-ledger.json"
historical_ledger="$work_dir/historical-ledger.json"
historical_get_response="$work_dir/historical-get-object-response.json"
receipt_validation="$work_dir/receipt-validation.json"
roundtrip_validation="$work_dir/roundtrip-validation.json"
object_proof="$work_dir/receipt-object.json"
roundtrip_receipt="$work_dir/roundtrip-receipt.json"
get_response="$work_dir/get-object-response.json"
control_put_response="$work_dir/control-put-response.json"
control_put_error="$work_dir/control-put-error.txt"
control_head_response="$work_dir/control-head-response.json"
roundtrip_control_proof="$work_dir/roundtrip-control-proof.json"
control_get_response="$work_dir/control-get-object-response.json"
terminal_file="$work_dir/terminal-ledger.json"
terminal_error="$work_dir/terminal-error.txt"
terminal_read="$work_dir/terminal-read.json"

artifact_bucket="${APP_NAME}-artifacts-${AWS_ACCOUNT_ID}-${AWS_REGION}"
ledger_key="candidates/recovery/${RECOVERY_ENVIRONMENT}/ledger.json"
receipt_key="candidates/recovery/${RECOVERY_ENVIRONMENT}/receipts/${RECOVERY_INTENT_ID}/${receipt_sha256}.json"
control_proof_key="candidates/recovery/${RECOVERY_ENVIRONMENT}/controls/${RECOVERY_INTENT_ID}/${control_proof_sha256}.json"
checksum_base64="$(
  openssl dgst -sha256 -binary "$receipt_file" | base64 -w0
)"
control_checksum_base64="$(
  openssl dgst -sha256 -binary "$control_proof_file" | base64 -w0
)"
control_proof_bytes="$(wc -c <"$control_proof_file")"
receipt_recovering_etag="$(
  jq -er '.recoveringLedger.etag' "$receipt_file"
)"
receipt_recovering_sha256="$(
  jq -er '.recoveringLedger.sha256' "$receipt_file"
)"
receipt_recovering_version_id="$(
  jq -er '.recoveringLedger.versionId' "$receipt_file"
)"
receipt_recovering_updated_at="$(
  jq -er '.recoveringLedger.updatedAt | numbers' "$receipt_file"
)"
receipt_recovering_lease_until="$(
  jq -er '.recoveringLedger.leaseUntil | numbers' "$receipt_file"
)"
receipt_archive_bucket="$(jq -er '.archive.bucket' "$receipt_file")"
receipt_archive_key="$(jq -er '.archive.key' "$receipt_file")"
receipt_archive_sha256="$(jq -er '.archive.sha256' "$receipt_file")"
receipt_archive_version_id="$(jq -er '.archive.versionId' "$receipt_file")"
receipt_candidate_sha="$(jq -er '.candidateSha' "$receipt_file")"
receipt_manifest_sha256="$(jq -er '.manifestSha256' "$receipt_file")"
receipt_source_ci_run_id="$(jq -er '.sourceCiRunId' "$receipt_file")"
receipt_source_ci_run_attempt="$(
  jq -er '.sourceCiRunAttempt' "$receipt_file"
)"
receipt_source_deploy_run_id="$(
  jq -er '.sourceDeployRunId' "$receipt_file"
)"
receipt_source_deploy_run_attempt="$(
  jq -er '.sourceDeployRunAttempt' "$receipt_file"
)"

jq -e \
  --arg bucket "$artifact_bucket" \
  --arg environment "$RECOVERY_ENVIRONMENT" \
  --arg intent "$RECOVERY_INTENT_ID" \
  --arg ledgerKey "$ledger_key" \
  --arg owner "$RECOVERY_LEASE_OWNER" \
  '
    .ok == true
    and .schema == "archon.durable-recovery.receipt"
    and .version == 2
    and .environment == $environment
    and .intentId == $intent
    and .executor.leaseOwner == $owner
    and (
      .recoveringLedger
      | type == "object"
        and .bucket == $bucket
        and .key == $ledgerKey
        and .state == "RECOVERING"
        and (.etag | test("^\"[0-9a-f]{32}\"$"))
        and (.sha256 | test("^[0-9a-f]{64}$"))
        and (
          .versionId
          | type == "string"
            and length > 0
            and . != "null"
            and test("^[^[:space:]]+$")
        )
        and (.updatedAt | type == "number" and . > 0 and floor == .)
        and (.leaseUntil | type == "number" and floor == .)
        and .leaseUntil > .updatedAt
    )
  ' "$receipt_file" >/dev/null

validate_control_proof() {
  local proof_file="$1"
  jq -e \
    --arg account "$AWS_ACCOUNT_ID" \
    --arg app "$APP_NAME" \
    --arg environment "$RECOVERY_ENVIRONMENT" \
    --arg executionRoleArn "$AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN" \
    --arg region "$AWS_REGION" \
    --arg stack "$STACK_NAME" \
    --slurpfile receipt "$receipt_file" \
    '
      def exact_keys($expected):
        type == "object" and (keys | sort) == ($expected | sort);
      def nonblank:
        type == "string"
        and length > 0
        and test("^[^[:space:]]+$");
      def integer_at_least($minimum):
        type == "number" and floor == . and . >= $minimum;
      ($receipt | length) == 1
      and exact_keys([
        "drift",
        "evidence",
        "identity",
        "mode",
        "ok",
        "protection",
        "schema",
        "version"
      ])
      and .ok == true
      and .schema == "archon.cloudformation-controls.proof"
      and .version == 1
      and .mode == "recover"
      and .evidence == "live-control-plane"
      and (
        .identity
        | exact_keys([
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
          ])
          and .accountId == $account
          and .appName == $app
          and (
            .candidateSha == null
            or .candidateSha == $receipt[0].candidateSha
          )
          and .environment == $environment
          and .executionRoleArn == $executionRoleArn
          and .region == $region
          and .stackName == $stack
      )
      and (.protection | exact_keys(["action", "enabled"]))
      and (
        (
          $receipt[0].stackState == "greenfield"
          and .identity.state == "absent"
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
        or
        (
          $receipt[0].stackState == "existing"
          and .identity.state == "existing"
          and .identity.stackId == $receipt[0].proofs.stack.stackId
          and (
            .identity.stackRevision
            == $receipt[0].proofs.stack.stackRevision
          )
          and (
            .identity.stackStatus == "CREATE_COMPLETE"
            or .identity.stackStatus == "UPDATE_COMPLETE"
            or .identity.stackStatus == "UPDATE_ROLLBACK_COMPLETE"
          )
          and .identity.tagsSha256 == $receipt[0].proofs.stack.tagsSha256
          and .protection.enabled == true
          and (
            .protection.action == "verified"
            or .protection.action == "enabled"
          )
          and (
            .drift
            | exact_keys([
                "checkedResourceCount",
                "detectionId",
                "detectionStatus",
                "driftedResourceCount",
                "notCheckedResourceCount",
                "stackDriftStatus",
                "totalResourceCount"
              ])
              and (.detectionId | nonblank)
              and .detectionStatus == "DETECTION_COMPLETE"
              and .stackDriftStatus == "IN_SYNC"
              and (.driftedResourceCount | integer_at_least(0))
              and .driftedResourceCount == 0
              and (.checkedResourceCount | integer_at_least(1))
              and (.notCheckedResourceCount | integer_at_least(0))
              and (.totalResourceCount | integer_at_least(1))
              and .totalResourceCount == (
                .checkedResourceCount + .notCheckedResourceCount
              )
          )
        )
      )
    ' "$proof_file" >/dev/null
}

validate_control_proof "$control_proof_file"

validate_terminal_binding() {
  local ledger_file="$1"
  local expected_version="${2:-}"
  local expected_control_version="${3:-}"
  jq -e \
    --arg environment "$RECOVERY_ENVIRONMENT" \
    --arg intent "$RECOVERY_INTENT_ID" \
    --arg bucket "$artifact_bucket" \
    --arg key "$receipt_key" \
    --arg versionId "$expected_version" \
    --arg receiptSha "$receipt_sha256" \
    --arg controlBucket "$artifact_bucket" \
    --arg controlKey "$control_proof_key" \
    --arg controlSha "$control_proof_sha256" \
    --arg controlVersionId "$expected_control_version" \
    --arg previousEtag "$receipt_recovering_etag" \
    --arg previousSha "$receipt_recovering_sha256" \
    --arg previousVersion "$receipt_recovering_version_id" \
    --arg archiveBucket "$receipt_archive_bucket" \
    --arg archiveKey "$receipt_archive_key" \
    --arg archiveSha "$receipt_archive_sha256" \
    --arg archiveVersion "$receipt_archive_version_id" \
    --arg candidateSha "$receipt_candidate_sha" \
    --arg manifestSha "$receipt_manifest_sha256" \
    --arg sourceCiRunId "$receipt_source_ci_run_id" \
    --arg sourceCiRunAttempt "$receipt_source_ci_run_attempt" \
    --arg sourceDeployRunId "$receipt_source_deploy_run_id" \
    --arg sourceDeployRunAttempt "$receipt_source_deploy_run_attempt" \
    '
      .exists == true
      and .environment == $environment
      and .intentId == $intent
      and .state == "RECOVERED"
      and .receiptBucket == $bucket
      and .receiptKey == $key
      and (
        .receiptVersionId
        | type == "string"
          and length > 0
          and . != "null"
          and test("^[^[:space:]]+$")
      )
      and ($versionId == "" or .receiptVersionId == $versionId)
      and .receiptSha256 == $receiptSha
      and .controlProofBucket == $controlBucket
      and .controlProofKey == $controlKey
      and .controlProofSha256 == $controlSha
      and (
        .controlProofVersionId
        | type == "string"
          and length > 0
          and . != "null"
          and test("^[^[:space:]]+$")
      )
      and (
        $controlVersionId == ""
        or .controlProofVersionId == $controlVersionId
      )
      and .previousLedgerEtag == $previousEtag
      and .previousLedgerSha256 == $previousSha
      and .previousLedgerVersionId == $previousVersion
      and .archiveBucket == $archiveBucket
      and .archiveKey == $archiveKey
      and .archiveSha256 == $archiveSha
      and .archiveVersionId == $archiveVersion
      and .candidateSha == $candidateSha
      and .manifestSha256 == $manifestSha
      and .sourceCiRunId == $sourceCiRunId
      and .sourceCiRunAttempt == $sourceCiRunAttempt
      and .sourceRunId == $sourceDeployRunId
      and .sourceRunAttempt == $sourceDeployRunAttempt
      and .leaseOwner == null
      and .leaseUntil == null
      and (.ledgerEtag | test("^\"[0-9a-f]{32}\"$"))
      and (.ledgerSha256 | test("^[0-9a-f]{64}$"))
      and (
        .ledgerVersionId
        | type == "string"
          and length > 0
          and . != "null"
          and test("^[^[:space:]]+$")
      )
    ' "$ledger_file" >/dev/null
}

bash aws/recovery-intent-ledger.sh read >"$current_ledger"
require_single_json_object \
  "$current_ledger" \
  "The current recovery ledger read"
current_state="$(jq -er '.state' "$current_ledger")"
case "$current_state" in
  RECOVERING)
    cp -- "$current_ledger" "$validation_ledger"
    ;;

  RECOVERED)
    validate_terminal_binding "$current_ledger" ""
    receipt_version_id="$(
      jq -er '.receiptVersionId' "$current_ledger"
    )"
    control_proof_version_id="$(
      jq -er '.controlProofVersionId' "$current_ledger"
    )"
    historical_checksum_base64=""
    aws s3api get-object \
      --bucket "$artifact_bucket" \
      --key "$ledger_key" \
      --version-id "$receipt_recovering_version_id" \
      --expected-bucket-owner "$AWS_ACCOUNT_ID" \
      --checksum-mode ENABLED \
      --region "$AWS_REGION" \
      --output json \
      "$historical_ledger" >"$historical_get_response"
    require_single_json_object \
      "$historical_ledger" \
      "The historical RECOVERING ledger"
    require_single_json_object \
      "$historical_get_response" \
      "The historical ledger S3 response"
    historical_ledger_sha256="$(
      sha256sum "$historical_ledger" | awk '{print $1}'
    )"
    test "$historical_ledger_sha256" = "$receipt_recovering_sha256"
    historical_checksum_base64="$(
      openssl dgst -sha256 -binary "$historical_ledger" | base64 -w0
    )"
    historical_ledger_bytes="$(wc -c <"$historical_ledger")"
    jq -e \
      --arg checksum "$historical_checksum_base64" \
      --arg environment "$RECOVERY_ENVIRONMENT" \
      --arg etag "$receipt_recovering_etag" \
      --arg versionId "$receipt_recovering_version_id" \
      --argjson bytes "$historical_ledger_bytes" \
      '
        .VersionId == $versionId
        and .ETag == $etag
        and .ChecksumSHA256 == $checksum
        and .ServerSideEncryption == "AES256"
        and .ContentLength == $bytes
        and .ContentType == "application/json"
        and .Metadata == {
          "environment": $environment,
          "kind": "recovery-ledger"
        }
      ' "$historical_get_response" >/dev/null
    jq -e \
      --arg bucket "$artifact_bucket" \
      --arg environment "$RECOVERY_ENVIRONMENT" \
      --arg intent "$RECOVERY_INTENT_ID" \
      --arg owner "$RECOVERY_LEASE_OWNER" \
      --arg archiveBucket "$receipt_archive_bucket" \
      --arg archiveKey "$receipt_archive_key" \
      --arg archiveSha "$receipt_archive_sha256" \
      --arg archiveVersion "$receipt_archive_version_id" \
      --arg candidateSha "$receipt_candidate_sha" \
      --arg manifestSha "$receipt_manifest_sha256" \
      --arg sourceCiRunId "$receipt_source_ci_run_id" \
      --arg sourceCiRunAttempt "$receipt_source_ci_run_attempt" \
      --arg sourceDeployRunId "$receipt_source_deploy_run_id" \
      --arg sourceDeployRunAttempt "$receipt_source_deploy_run_attempt" \
      --argjson updatedAt "$receipt_recovering_updated_at" \
      --argjson leaseUntil "$receipt_recovering_lease_until" \
      '
        type == "object"
        and (keys | sort) == ([
          "archiveBucket",
          "archiveKey",
          "archiveSha256",
          "archiveVersionId",
          "candidateSha",
          "controlProofBucket",
          "controlProofKey",
          "controlProofSha256",
          "controlProofVersionId",
          "environment",
          "intentId",
          "leaseOwner",
          "leaseUntil",
          "manifestSha256",
          "previousLedgerEtag",
          "previousLedgerSha256",
          "previousLedgerVersionId",
          "receiptBucket",
          "receiptKey",
          "receiptSha256",
          "receiptVersionId",
          "schema",
          "sourceCiRunAttempt",
          "sourceCiRunId",
          "sourceRunAttempt",
          "sourceRunId",
          "state",
          "updatedAt",
          "version"
        ] | sort)
        and .schema == "archon.recovery-intent.ledger"
        and .version == 1
        and .environment == $environment
        and .state == "RECOVERING"
        and .intentId == $intent
        and .leaseOwner == $owner
        and .updatedAt == $updatedAt
        and .leaseUntil == $leaseUntil
        and .archiveBucket == $archiveBucket
        and .archiveBucket == $bucket
        and .archiveKey == $archiveKey
        and .archiveSha256 == $archiveSha
        and .archiveVersionId == $archiveVersion
        and .candidateSha == $candidateSha
        and .manifestSha256 == $manifestSha
        and .sourceCiRunId == $sourceCiRunId
        and .sourceCiRunAttempt == $sourceCiRunAttempt
        and .sourceRunId == $sourceDeployRunId
        and .sourceRunAttempt == $sourceDeployRunAttempt
        and .controlProofBucket == null
        and .controlProofKey == null
        and .controlProofSha256 == null
        and .controlProofVersionId == null
        and .receiptBucket == null
        and .receiptKey == null
        and .receiptSha256 == null
        and .receiptVersionId == null
        and (.previousLedgerEtag | test("^\"[0-9a-f]{32}\"$"))
        and (.previousLedgerSha256 | test("^[0-9a-f]{64}$"))
        and (
          .previousLedgerVersionId
          | type == "string"
            and length > 0
            and . != "null"
            and test("^[^[:space:]]+$")
        )
      ' "$historical_ledger" >/dev/null
    jq \
      --arg etag "$receipt_recovering_etag" \
      --arg ledgerSha256 "$receipt_recovering_sha256" \
      --arg ledgerVersionId "$receipt_recovering_version_id" \
      '. + {
        exists: true,
        ledgerEtag: $etag,
        ledgerSha256: $ledgerSha256,
        ledgerVersionId: $ledgerVersionId
      }' "$historical_ledger" >"$validation_ledger"
    ;;

  *)
    echo "The recovery ledger is not finalizable." >&2
    exit 1
    ;;
esac
require_single_json_object \
  "$validation_ledger" \
  "The RECOVERING ledger validation input"

EXPECTED_RECOVERY_RECEIPT_SHA256="$receipt_sha256" \
RECOVERY_LEDGER_FILE="$validation_ledger" \
RECOVERY_MANIFEST_FILE="$manifest_file" \
  bash aws/verify-durable-recovery-receipt.sh "$receipt_file" \
    >"$receipt_validation"
require_single_json_object \
  "$receipt_validation" \
  "The recovery receipt validation result"
jq -e \
  --arg environment "$RECOVERY_ENVIRONMENT" \
  --arg intent "$RECOVERY_INTENT_ID" \
  --arg receiptSha "$receipt_sha256" \
  '
    keys == [
      "environment",
      "intentId",
      "ok",
      "receiptSha256",
      "schema",
      "version"
    ]
    and .ok == true
    and .schema == "archon.durable-recovery-receipt.validation"
    and .version == 1
    and .environment == $environment
    and .intentId == $intent
    and .receiptSha256 == $receiptSha
  ' "$receipt_validation" >/dev/null

publish_control_proof() {
  local put_complete=false
  local attempt
  local control_version=""
  for attempt in 1 2 3 4 5; do
    : >"$control_put_response"
    : >"$control_put_error"
    if aws s3api put-object \
      --bucket "$artifact_bucket" \
      --key "$control_proof_key" \
      --body "$control_proof_file" \
      --if-none-match '*' \
      --expected-bucket-owner "$AWS_ACCOUNT_ID" \
      --server-side-encryption AES256 \
      --checksum-algorithm SHA256 \
      --checksum-sha256 "$control_checksum_base64" \
      --content-type application/json \
      --metadata \
        "environment=${RECOVERY_ENVIRONMENT},intent-id=${RECOVERY_INTENT_ID},kind=control-proof" \
      --region "$AWS_REGION" \
      --output json >"$control_put_response" 2>"$control_put_error"; then
      require_single_json_object \
        "$control_put_response" \
        "The CloudFormation control proof S3 write response"
      jq -e \
        --arg checksum "$control_checksum_base64" \
        '
          (.VersionId | type == "string" and length > 0 and . != "null")
          and .ChecksumSHA256 == $checksum
          and .ServerSideEncryption == "AES256"
        ' "$control_put_response" >/dev/null
      control_version="$(jq -er '.VersionId' "$control_put_response")"
      put_complete=true
      break
    fi

    if grep -Eqi \
      'PreconditionFailed|status code: 412|ConditionalRequestConflict|status code: 409|RequestTimeout|InternalError|ServiceUnavailable|SlowDown|connection reset|Connection was closed|timed out|Could not connect to the endpoint' \
      "$control_put_error"; then
      : >"$control_head_response"
      if aws s3api head-object \
        --bucket "$artifact_bucket" \
        --key "$control_proof_key" \
        --expected-bucket-owner "$AWS_ACCOUNT_ID" \
        --checksum-mode ENABLED \
        --region "$AWS_REGION" \
        --output json >"$control_head_response" 2>/dev/null; then
        require_single_json_object \
          "$control_head_response" \
          "The existing CloudFormation control proof S3 response"
        jq -e \
          --arg checksum "$control_checksum_base64" \
          --arg environment "$RECOVERY_ENVIRONMENT" \
          --arg intent "$RECOVERY_INTENT_ID" \
          --argjson bytes "$control_proof_bytes" \
          '
            (.VersionId | type == "string" and length > 0 and . != "null")
            and .ChecksumSHA256 == $checksum
            and .ServerSideEncryption == "AES256"
            and .ContentLength == $bytes
            and .ContentType == "application/json"
            and .Metadata == {
              "environment": $environment,
              "intent-id": $intent,
              "kind": "control-proof"
            }
          ' "$control_head_response" >/dev/null
        control_version="$(jq -er '.VersionId' "$control_head_response")"
        put_complete=true
        break
      fi
      if grep -Eqi 'PreconditionFailed|status code: 412' \
        "$control_put_error"; then
        sed 's/[[:cntrl:]]//g' "$control_put_error" >&2
        return 1
      fi
      if [ "$attempt" -lt 5 ]; then
        sleep "$attempt"
        continue
      fi
    fi
    sed 's/[[:cntrl:]]//g' "$control_put_error" >&2
    return 1
  done
  test "$put_complete" = "true"
  control_proof_version_id="$control_version"
}

if [ "$current_state" = "RECOVERING" ]; then
  bash aws/put-durable-recovery-object.sh \
    "$receipt_file" \
    "$receipt_key" >"$object_proof"
  require_single_json_object \
    "$object_proof" \
    "The recovery receipt object proof"
  jq -e \
    --arg bucket "$artifact_bucket" \
    --arg checksum "$checksum_base64" \
    --arg environment "$RECOVERY_ENVIRONMENT" \
    --arg intent "$RECOVERY_INTENT_ID" \
    --arg key "$receipt_key" \
    --arg receiptSha "$receipt_sha256" \
    '
      keys == [
        "bucket",
        "checksumSha256",
        "environment",
        "intentId",
        "key",
        "kind",
        "ok",
        "schema",
        "sha256",
        "version",
        "versionId"
      ]
      and .ok == true
      and .schema == "archon.durable-recovery-object.proof"
      and .version == 1
      and .environment == $environment
      and .intentId == $intent
      and .kind == "receipt"
      and .bucket == $bucket
      and .key == $key
      and (
        .versionId
        | type == "string"
          and length > 0
          and . != "null"
          and test("^[^[:space:]]+$")
      )
      and .sha256 == $receiptSha
      and .checksumSha256 == $checksum
  ' "$object_proof" >/dev/null
  receipt_version_id="$(jq -er '.versionId' "$object_proof")"
  publish_control_proof
fi

aws s3api get-object \
  --bucket "$artifact_bucket" \
  --key "$receipt_key" \
  --version-id "$receipt_version_id" \
  --expected-bucket-owner "$AWS_ACCOUNT_ID" \
  --checksum-mode ENABLED \
  --region "$AWS_REGION" \
  --output json \
  "$roundtrip_receipt" >"$get_response"
test -f "$roundtrip_receipt"
test ! -L "$roundtrip_receipt"
require_single_json_object \
  "$roundtrip_receipt" \
  "The round-tripped recovery receipt"
require_single_json_object \
  "$get_response" \
  "The recovery receipt S3 response"
cmp -s -- "$receipt_file" "$roundtrip_receipt"
test "$(
  sha256sum "$roundtrip_receipt" | awk '{print $1}'
)" = "$receipt_sha256"
receipt_bytes="$(wc -c <"$roundtrip_receipt")"
jq -e \
  --arg checksum "$checksum_base64" \
  --arg environment "$RECOVERY_ENVIRONMENT" \
  --arg intent "$RECOVERY_INTENT_ID" \
  --arg versionId "$receipt_version_id" \
  --argjson bytes "$receipt_bytes" \
  '
    .VersionId == $versionId
    and .ChecksumSHA256 == $checksum
    and .ServerSideEncryption == "AES256"
    and .ContentLength == $bytes
    and .ContentType == "application/json"
    and .Metadata == {
      "environment": $environment,
      "intent-id": $intent,
      "kind": "receipt"
    }
  ' "$get_response" >/dev/null
EXPECTED_RECOVERY_RECEIPT_SHA256="$receipt_sha256" \
RECOVERY_LEDGER_FILE="$validation_ledger" \
RECOVERY_MANIFEST_FILE="$manifest_file" \
  bash aws/verify-durable-recovery-receipt.sh "$roundtrip_receipt" \
    >"$roundtrip_validation"
require_single_json_object \
  "$roundtrip_validation" \
  "The round-trip receipt validation result"
cmp -s -- "$receipt_validation" "$roundtrip_validation"

aws s3api get-object \
  --bucket "$artifact_bucket" \
  --key "$control_proof_key" \
  --version-id "$control_proof_version_id" \
  --expected-bucket-owner "$AWS_ACCOUNT_ID" \
  --checksum-mode ENABLED \
  --region "$AWS_REGION" \
  --output json \
  "$roundtrip_control_proof" >"$control_get_response"
require_single_json_object \
  "$roundtrip_control_proof" \
  "The round-tripped CloudFormation control proof"
require_single_json_object \
  "$control_get_response" \
  "The CloudFormation control proof S3 response"
cmp -s -- "$control_proof_file" "$roundtrip_control_proof"
test "$(
  sha256sum "$roundtrip_control_proof" | awk '{print $1}'
)" = "$control_proof_sha256"
jq -e \
  --arg checksum "$control_checksum_base64" \
  --arg environment "$RECOVERY_ENVIRONMENT" \
  --arg intent "$RECOVERY_INTENT_ID" \
  --arg versionId "$control_proof_version_id" \
  --argjson bytes "$control_proof_bytes" \
  '
    .VersionId == $versionId
    and .ChecksumSHA256 == $checksum
    and .ServerSideEncryption == "AES256"
    and .ContentLength == $bytes
    and .ContentType == "application/json"
    and .Metadata == {
      "environment": $environment,
      "intent-id": $intent,
      "kind": "control-proof"
    }
  ' "$control_get_response" >/dev/null
validate_control_proof "$roundtrip_control_proof"

if [ "$current_state" = "RECOVERED" ]; then
  cp -- "$current_ledger" "$terminal_file"
else
  terminal_complete=false
  for attempt in 1 2 3 4 5; do
    : >"$terminal_error"
    if RECOVERY_CONTROL_PROOF_BUCKET="$artifact_bucket" \
       RECOVERY_CONTROL_PROOF_KEY="$control_proof_key" \
       RECOVERY_CONTROL_PROOF_SHA256="$control_proof_sha256" \
       RECOVERY_CONTROL_PROOF_VERSION_ID="$control_proof_version_id" \
       RECOVERY_EXPECTED_LEDGER_ETAG="$receipt_recovering_etag" \
       RECOVERY_EXPECTED_LEDGER_LEASE_UNTIL="$receipt_recovering_lease_until" \
       RECOVERY_EXPECTED_LEDGER_SHA256="$receipt_recovering_sha256" \
       RECOVERY_EXPECTED_LEDGER_UPDATED_AT="$receipt_recovering_updated_at" \
       RECOVERY_EXPECTED_LEDGER_VERSION_ID="$receipt_recovering_version_id" \
       RECOVERY_RECEIPT_BUCKET="$artifact_bucket" \
       RECOVERY_RECEIPT_KEY="$receipt_key" \
       RECOVERY_RECEIPT_SHA256="$receipt_sha256" \
       RECOVERY_RECEIPT_VERSION_ID="$receipt_version_id" \
         bash aws/recovery-intent-ledger.sh recover \
           >"$terminal_file" 2>"$terminal_error"; then
      require_single_json_object \
        "$terminal_file" \
        "The terminal recovery ledger result"
      terminal_complete=true
      break
    fi
    if bash aws/recovery-intent-ledger.sh read \
         >"$terminal_read" 2>/dev/null &&
       require_single_json_object \
         "$terminal_read" \
         "The terminal recovery ledger read" &&
       validate_terminal_binding \
         "$terminal_read" \
         "$receipt_version_id" \
         "$control_proof_version_id"; then
      cp -- "$terminal_read" "$terminal_file"
      terminal_complete=true
      break
    fi
    if [ "$attempt" -lt 5 ]; then
      sleep "$attempt"
    fi
  done
  if [ "$terminal_complete" != "true" ]; then
    sed 's/[[:cntrl:]]//g' "$terminal_error" >&2
    exit 1
  fi
fi
require_single_json_object \
  "$terminal_file" \
  "The exact terminal recovery ledger"

validate_terminal_binding \
  "$terminal_file" \
  "$receipt_version_id" \
  "$control_proof_version_id"

jq -n \
  --arg environment "$RECOVERY_ENVIRONMENT" \
  --arg intentId "$RECOVERY_INTENT_ID" \
  --arg bucket "$artifact_bucket" \
  --arg key "$receipt_key" \
  --arg receiptSha256 "$receipt_sha256" \
  --arg receiptVersionId "$receipt_version_id" \
  --arg checksumSha256 "$checksum_base64" \
  --arg controlBucket "$artifact_bucket" \
  --arg controlKey "$control_proof_key" \
  --arg controlSha256 "$control_proof_sha256" \
  --arg controlVersionId "$control_proof_version_id" \
  --arg controlChecksumSha256 "$control_checksum_base64" \
  --arg controlSchema "$(jq -er '.schema' "$control_proof_file")" \
  --arg controlMode "$(jq -er '.mode' "$control_proof_file")" \
  --arg controlEvidence "$(jq -er '.evidence' "$control_proof_file")" \
  --arg controlIdentityState "$(
    jq -er '.identity.state' "$control_proof_file"
  )" \
  --argjson controlSchemaVersion "$(
    jq -er '.version | numbers' "$control_proof_file"
  )" \
  --arg ledgerEtag "$(jq -er '.ledgerEtag' "$terminal_file")" \
  --arg ledgerSha256 "$(jq -er '.ledgerSha256' "$terminal_file")" \
  --arg ledgerVersionId "$(jq -er '.ledgerVersionId' "$terminal_file")" \
  --arg previousLedgerEtag "$receipt_recovering_etag" \
  --arg previousLedgerSha256 "$receipt_recovering_sha256" \
  --arg previousLedgerVersionId "$receipt_recovering_version_id" \
  '{
    ok: true,
    schema: "archon.durable-recovery.finalization",
    version: 1,
    environment: $environment,
    intentId: $intentId,
    receipt: {
      bucket: $bucket,
      key: $key,
      versionId: $receiptVersionId,
      sha256: $receiptSha256,
      checksumSha256: $checksumSha256
    },
    controlProof: {
      object: {
        bucket: $controlBucket,
        key: $controlKey,
        versionId: $controlVersionId,
        sha256: $controlSha256,
        checksumSha256: $controlChecksumSha256
      },
      proof: {
        schema: $controlSchema,
        version: $controlSchemaVersion,
        mode: $controlMode,
        evidence: $controlEvidence,
        identityState: $controlIdentityState
      }
    },
    terminalLedger: {
      state: "RECOVERED",
      versionId: $ledgerVersionId,
      etag: $ledgerEtag,
      sha256: $ledgerSha256,
      previousVersionId: $previousLedgerVersionId,
      previousEtag: $previousLedgerEtag,
      previousSha256: $previousLedgerSha256
    }
  }'
