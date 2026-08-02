#!/usr/bin/env bash
# Conditionally publish one immutable recovery archive or terminal receipt to
# the private, encrypted, versioned delivery bucket and prove the exact object.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 FILE OBJECT_KEY" >&2
  exit 1
fi
source_file="$1"
object_key="$2"

for name in \
  APP_NAME \
  AWS_ACCOUNT_ID \
  AWS_REGION \
  RECOVERY_ENVIRONMENT \
  RECOVERY_INTENT_ID; do
  if [ -z "${!name:-}" ]; then
    echo "$name is required to publish a durable recovery object." >&2
    exit 1
  fi
done
if [ ! -f "$source_file" ] || [ -L "$source_file" ]; then
  echo "The durable recovery object source must be a regular file." >&2
  exit 1
fi
[[ "$APP_NAME" =~ ^[a-z0-9][a-z0-9-]*$ ]]
[[ "$AWS_ACCOUNT_ID" =~ ^[0-9]{12}$ ]]
[[ "$RECOVERY_INTENT_ID" =~ ^[0-9a-f]{64}$ ]]
test "$AWS_REGION" = "eu-west-1"
case "$RECOVERY_ENVIRONMENT" in
  staging|production) ;;
  *) exit 1 ;;
esac

object_sha256="$(sha256sum "$source_file" | awk '{print $1}')"
[[ "$object_sha256" =~ ^[0-9a-f]{64}$ ]]
archive_key="candidates/recovery/${RECOVERY_ENVIRONMENT}/${RECOVERY_INTENT_ID}.tar"
receipt_key="candidates/recovery/${RECOVERY_ENVIRONMENT}/receipts/${RECOVERY_INTENT_ID}/${object_sha256}.json"
case "$object_key" in
  "$archive_key")
    content_type="application/x-tar"
    object_kind="intent"
    ;;
  "$receipt_key")
    content_type="application/json"
    object_kind="receipt"
    ;;
  *)
    echo "The durable recovery object key is not intent-bound." >&2
    exit 1
    ;;
esac

bucket="${APP_NAME}-artifacts-${AWS_ACCOUNT_ID}-${AWS_REGION}"
storage_key_alias="arn:aws:kms:${AWS_REGION}:${AWS_ACCOUNT_ID}:alias/${APP_NAME}-storage"
checksum_base64="$(
  openssl dgst -sha256 -binary "$source_file" | base64 -w0
)"
response_file="$(mktemp)"
error_file="$(mktemp)"
cleanup_put_files() {
  rm -f -- "$response_file" "$error_file"
}
trap cleanup_put_files EXIT

head_current_object() {
  aws s3api head-object \
    --bucket "$bucket" \
    --key "$object_key" \
    --expected-bucket-owner "$AWS_ACCOUNT_ID" \
    --checksum-mode ENABLED \
    --region "$AWS_REGION" \
    --output json >"$response_file" 2>/dev/null
}

put_complete=false
for attempt in 1 2 3 4 5; do
  : >"$response_file"
  : >"$error_file"
  if aws s3api put-object \
    --bucket "$bucket" \
    --key "$object_key" \
    --body "$source_file" \
    --if-none-match '*' \
    --expected-bucket-owner "$AWS_ACCOUNT_ID" \
    --server-side-encryption aws:kms \
    --ssekms-key-id "$storage_key_alias" \
    --checksum-algorithm SHA256 \
    --checksum-sha256 "$checksum_base64" \
    --content-type "$content_type" \
    --metadata \
      "environment=${RECOVERY_ENVIRONMENT},intent-id=${RECOVERY_INTENT_ID},kind=${object_kind}" \
    --region "$AWS_REGION" \
    --output json >"$response_file" 2>"$error_file"; then
    put_complete=true
    break
  fi
  if grep -Eqi 'PreconditionFailed|status code: 412' "$error_file"; then
    if head_current_object; then
      put_complete=true
      break
    fi
    sed 's/[[:cntrl:]]//g' "$error_file" >&2
    exit 1
  fi
  if grep -Eqi \
      'ConditionalRequestConflict|status code: 409|RequestTimeout|InternalError|ServiceUnavailable|SlowDown|connection reset|Connection was closed|timed out|Could not connect to the endpoint' \
      "$error_file"; then
    if head_current_object; then
      put_complete=true
      break
    fi
    if [ "$attempt" -lt 5 ]; then
      sleep "$attempt"
      continue
    fi
  fi
  sed 's/[[:cntrl:]]//g' "$error_file" >&2
  exit 1
done
test "$put_complete" = "true"

version_id="$(jq -er \
  '.VersionId | strings | select(length > 0 and . != "null")' \
  "$response_file"
)"
aws s3api head-object \
  --bucket "$bucket" \
  --key "$object_key" \
  --version-id "$version_id" \
  --expected-bucket-owner "$AWS_ACCOUNT_ID" \
  --checksum-mode ENABLED \
  --region "$AWS_REGION" \
  --output json >"$response_file"

file_bytes="$(wc -c <"$source_file")"
jq -e \
  --arg checksum "$checksum_base64" \
  --arg contentType "$content_type" \
  --arg environment "$RECOVERY_ENVIRONMENT" \
  --arg intent "$RECOVERY_INTENT_ID" \
  --arg kmsPrefix \
    "arn:aws:kms:${AWS_REGION}:${AWS_ACCOUNT_ID}:key/" \
  --arg kind "$object_kind" \
  --argjson bytes "$file_bytes" \
  '
    (.VersionId | type == "string" and length > 0 and . != "null")
    and .ChecksumSHA256 == $checksum
    and .ServerSideEncryption == "aws:kms"
    and (
      .SSEKMSKeyId
      | type == "string"
        and startswith($kmsPrefix)
    )
    and .BucketKeyEnabled == true
    and .ContentLength == $bytes
    and .ContentType == $contentType
    and .Metadata == {
        "environment": $environment,
        "intent-id": $intent,
        "kind": $kind
      }
  ' "$response_file" >/dev/null

jq -n \
  --arg bucket "$bucket" \
  --arg checksumSha256 "$checksum_base64" \
  --arg environment "$RECOVERY_ENVIRONMENT" \
  --arg intentId "$RECOVERY_INTENT_ID" \
  --arg key "$object_key" \
  --arg kind "$object_kind" \
  --arg sha256 "$object_sha256" \
  --arg versionId "$version_id" \
  '{
    ok: true,
    schema: "archon.durable-recovery-object.proof",
    version: 1,
    environment: $environment,
    intentId: $intentId,
    kind: $kind,
    bucket: $bucket,
    key: $key,
    versionId: $versionId,
    sha256: $sha256,
    checksumSha256: $checksumSha256
  }'
