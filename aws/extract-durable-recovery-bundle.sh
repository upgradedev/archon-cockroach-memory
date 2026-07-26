#!/usr/bin/env bash
# Validate an immutable recovery tar before extracting it, then apply the
# strict data-only bundle verifier. Nothing from the archive is executed.
set -euo pipefail
umask 077

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 ARCHIVE_TAR OUTPUT_DIR" >&2
  exit 1
fi
archive_file="$1"
output_dir="$2"

if [ ! -f "$archive_file" ] || [ -L "$archive_file" ]; then
  echo "The durable recovery archive is not a regular private file." >&2
  exit 1
fi
if [ -e "$output_dir" ] || [ -L "$output_dir" ]; then
  echo "The durable recovery extraction target must not exist." >&2
  exit 1
fi
test -d "$(dirname "$output_dir")"

if [ -z "${EXPECTED_ARCHIVE_SHA256:-}" ]; then
  echo "EXPECTED_ARCHIVE_SHA256 is required." >&2
  exit 1
fi
[[ "$EXPECTED_ARCHIVE_SHA256" =~ ^[0-9a-f]{64}$ ]]
test "$(
  sha256sum "$archive_file" | awk '{print $1}'
)" = "$EXPECTED_ARCHIVE_SHA256"

archive_bytes="$(wc -c <"$archive_file")"
if [ "$archive_bytes" -le 0 ] || [ "$archive_bytes" -gt 16777216 ]; then
  echo "The durable recovery archive exceeds its bounded size." >&2
  exit 1
fi

members_file="$(mktemp)"
verbose_file="$(mktemp)"
cleanup_extract() {
  rm -f -- "$members_file" "$verbose_file"
  if [ "${extraction_complete:-false}" != "true" ]; then
    rm -rf -- "$output_dir"
  fi
}
trap cleanup_extract EXIT

tar -tf "$archive_file" >"$members_file"
tar -tvf "$archive_file" >"$verbose_file"
member_count="$(wc -l <"$members_file")"
if [ "$member_count" -lt 4 ] || [ "$member_count" -gt 9 ]; then
  echo "The durable recovery archive has an invalid member count." >&2
  exit 1
fi
if [ "$(sort "$members_file" | uniq | wc -l)" -ne "$member_count" ]; then
  echo "The durable recovery archive contains duplicate members." >&2
  exit 1
fi
if grep -Ev \
    '^(application-s3-access-logging-preflight\.json|frontend-prestate\.json|previous-index\.html|previous-live-alias\.json|previous-stack-parameters\.json|previous-stack-tags\.json|previous-stack-template\.yaml|recovery-intent\.json|recovery-snapshot-proof\.json)$' \
    "$members_file" |
  grep -q .; then
  echo "The durable recovery archive contains an unsafe member name." >&2
  exit 1
fi
if [ "$(grep -Fxc recovery-intent.json "$members_file")" -ne 1 ]; then
  echo "The durable recovery manifest member is missing." >&2
  exit 1
fi
if grep -Ev '^-' "$verbose_file" | grep -q .; then
  echo "The durable recovery archive contains a non-regular member." >&2
  exit 1
fi

mkdir -- "$output_dir"
chmod 0700 "$output_dir"
tar \
  --extract \
  --file "$archive_file" \
  --directory "$output_dir" \
  --no-same-owner \
  --no-same-permissions

validation="$(
  bash aws/verify-durable-recovery-bundle.sh "$output_dir"
)"
jq -e \
  --arg environment "$RECOVERY_ENVIRONMENT" \
  --arg intent "$EXPECTED_INTENT_ID" \
  --arg manifest "$EXPECTED_MANIFEST_SHA256" \
  '
    .ok == true
    and .schema == "archon.durable-recovery-bundle.validation"
    and .version == 1
    and .environment == $environment
    and .intentId == $intent
    and .manifestSha256 == $manifest
  ' <<<"$validation" >/dev/null
extraction_complete=true
printf '%s\n' "$validation"
