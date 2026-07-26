#!/usr/bin/env bash
# Download the exact S3 object version bound by a claimed S3 CAS recovery
# intent, prove its checksum, and safely extract/verify its data-only payload.
set -euo pipefail
umask 077

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 OUTPUT_DIR" >&2
  exit 1
fi
output_dir="$1"

for name in \
  APP_NAME \
  AWS_ACCOUNT_ID \
  AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN \
  AWS_REGION \
  GITHUB_REPOSITORY \
  RECOVERY_ENVIRONMENT \
  RECOVERY_INTENT_ID \
  RECOVERY_LEASE_OWNER \
  STACK_NAME; do
  if [ -z "${!name:-}" ]; then
    echo "$name is required to download a durable recovery bundle." >&2
    exit 1
  fi
done
[[ "$RECOVERY_INTENT_ID" =~ ^[0-9a-f]{64}$ ]]
[[ "$RECOVERY_LEASE_OWNER" =~ ^[A-Za-z0-9][A-Za-z0-9-]{0,127}$ ]]
test "$AWS_REGION" = "eu-west-1"
test "$STACK_NAME" = "${APP_NAME}-${RECOVERY_ENVIRONMENT}"
if [ -e "$output_dir" ] || [ -L "$output_dir" ]; then
  echo "The durable recovery download target must not exist." >&2
  exit 1
fi

ledger_file="$(mktemp)"
archive_file="$(mktemp)"
response_file="$(mktemp)"
cleanup_download() {
  rm -f -- "$ledger_file" "$archive_file" "$response_file"
}
trap cleanup_download EXIT

bash aws/recovery-intent-ledger.sh read >"$ledger_file"
artifact_bucket="${APP_NAME}-artifacts-${AWS_ACCOUNT_ID}-${AWS_REGION}"
expected_key="candidates/recovery/${RECOVERY_ENVIRONMENT}/${RECOVERY_INTENT_ID}.tar"
jq -e \
  --arg bucket "$artifact_bucket" \
  --arg environment "$RECOVERY_ENVIRONMENT" \
  --arg intent "$RECOVERY_INTENT_ID" \
  --arg key "$expected_key" \
  --arg owner "$RECOVERY_LEASE_OWNER" \
  '
    .exists == true
    and .environment == $environment
    and .state == "RECOVERING"
    and .intentId == $intent
    and .leaseOwner == $owner
    and (.leaseUntil | type == "number")
    and .archiveBucket == $bucket
    and .archiveKey == $key
    and (
      .archiveVersionId
      | type == "string" and length > 0 and test("^[^[:space:]]+$")
    )
    and (.archiveSha256 | test("^[0-9a-f]{64}$"))
    and (.manifestSha256 | test("^[0-9a-f]{64}$"))
    and (.candidateSha | test("^[0-9a-f]{40}$"))
    and (.sourceCiRunId | test("^[0-9]+$"))
    and (.sourceCiRunAttempt | test("^[1-9][0-9]*$"))
    and (.sourceRunId | test("^[0-9]+$"))
    and (.sourceRunAttempt | test("^[1-9][0-9]*$"))
  ' "$ledger_file" >/dev/null

archive_version_id="$(jq -er '.archiveVersionId' "$ledger_file")"
archive_sha256="$(jq -er '.archiveSha256' "$ledger_file")"
manifest_sha256="$(jq -er '.manifestSha256' "$ledger_file")"
candidate_sha="$(jq -er '.candidateSha' "$ledger_file")"
source_ci_run_id="$(jq -er '.sourceCiRunId' "$ledger_file")"
source_ci_run_attempt="$(jq -er '.sourceCiRunAttempt' "$ledger_file")"
source_deploy_run_id="$(jq -er '.sourceRunId' "$ledger_file")"
source_deploy_run_attempt="$(jq -er '.sourceRunAttempt' "$ledger_file")"

aws s3api get-object \
  --bucket "$artifact_bucket" \
  --key "$expected_key" \
  --version-id "$archive_version_id" \
  --expected-bucket-owner "$AWS_ACCOUNT_ID" \
  --checksum-mode ENABLED \
  --region "$AWS_REGION" \
  --output json \
  "$archive_file" >"$response_file"
expected_checksum_base64="$(
  openssl dgst -sha256 -binary "$archive_file" | base64 -w0
)"
test "$(
  sha256sum "$archive_file" | awk '{print $1}'
)" = "$archive_sha256"
jq -e \
  --arg checksum "$expected_checksum_base64" \
  --arg version "$archive_version_id" \
  '
    .VersionId == $version
    and .ChecksumSHA256 == $checksum
  ' "$response_file" >/dev/null

EXPECTED_ARCHIVE_SHA256="$archive_sha256" \
EXPECTED_CANDIDATE_SHA="$candidate_sha" \
EXPECTED_INTENT_ID="$RECOVERY_INTENT_ID" \
EXPECTED_MANIFEST_SHA256="$manifest_sha256" \
EXPECTED_SOURCE_CI_RUN_ATTEMPT="$source_ci_run_attempt" \
EXPECTED_SOURCE_CI_RUN_ID="$source_ci_run_id" \
EXPECTED_SOURCE_DEPLOY_RUN_ATTEMPT="$source_deploy_run_attempt" \
EXPECTED_SOURCE_DEPLOY_RUN_ID="$source_deploy_run_id" \
  bash aws/extract-durable-recovery-bundle.sh \
    "$archive_file" \
    "$output_dir" >/dev/null

jq -n \
  --arg archiveKey "$expected_key" \
  --arg archiveSha256 "$archive_sha256" \
  --arg archiveVersionId "$archive_version_id" \
  --arg environment "$RECOVERY_ENVIRONMENT" \
  --arg intentId "$RECOVERY_INTENT_ID" \
  --arg manifestSha256 "$manifest_sha256" \
  '{
    ok: true,
    schema: "archon.durable-recovery-download.proof",
    version: 1,
    environment: $environment,
    intentId: $intentId,
    archiveKey: $archiveKey,
    archiveVersionId: $archiveVersionId,
    archiveSha256: $archiveSha256,
    manifestSha256: $manifestSha256
  }'
