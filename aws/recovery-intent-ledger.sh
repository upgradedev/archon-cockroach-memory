#!/usr/bin/env bash
# Environment-scoped deployment/recovery state machine stored in the private,
# encrypted, versioned artifact bucket:
#   terminal/absent -> ARMED -> COMMITTED
#                            -> RECOVERING -> RECOVERED
#
# Every transition is an S3 compare-and-swap using If-None-Match or If-Match.
# S3 provides strong read-after-write/list consistency, and the exact prior
# ETag prevents concurrent or stale writers from clearing the delivery fence.
set -euo pipefail
umask 077

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 [assert-clear|arm|read|claim|commit|recover]" >&2
  exit 1
fi
operation="$1"
case "$operation" in
  assert-clear|arm|read|claim|commit|recover) ;;
  *) exit 1 ;;
esac

for name in APP_NAME AWS_ACCOUNT_ID AWS_REGION RECOVERY_ENVIRONMENT; do
  if [ -z "${!name:-}" ]; then
    echo "$name is required for the recovery intent ledger." >&2
    exit 1
  fi
done
[[ "$APP_NAME" =~ ^[a-z0-9][a-z0-9-]*$ ]]
[[ "$AWS_ACCOUNT_ID" =~ ^[0-9]{12}$ ]]
test "$AWS_REGION" = "eu-west-1"
case "$RECOVERY_ENVIRONMENT" in
  staging|production) ;;
  *) exit 1 ;;
esac

artifact_bucket="${APP_NAME}-artifacts-${AWS_ACCOUNT_ID}-${AWS_REGION}"
storage_key_alias="arn:aws:kms:${AWS_REGION}:${AWS_ACCOUNT_ID}:alias/${APP_NAME}-storage"
ledger_key="candidates/recovery/${RECOVERY_ENVIRONMENT}/ledger.json"
state_file="$(mktemp)"
response_file="$(mktemp)"
error_file="$(mktemp)"
next_file="$(mktemp)"
cleanup_ledger_files() {
  rm -f -- "$state_file" "$response_file" "$error_file" "$next_file"
}
trap cleanup_ledger_files EXIT

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

validate_previous_ledger_provenance() {
  local input_file="$1"
  local armed_mode="${2:-read}"
  case "$armed_mode" in
    read|first-create|terminal-rearm) ;;
    *) return 1 ;;
  esac
  jq -e \
    --arg armedMode "$armed_mode" \
    '
      def null_previous_ledger:
        .previousLedgerEtag == null
        and .previousLedgerSha256 == null
        and .previousLedgerVersionId == null;
      def complete_previous_ledger:
        (
          .previousLedgerEtag
          | if type == "string"
            then test("^\"[0-9a-f]{32}\"$")
            else false
            end
        )
        and (
          .previousLedgerSha256
          | if type == "string"
            then test("^[0-9a-f]{64}$")
            else false
            end
        )
        and (
          .previousLedgerVersionId
          | if type == "string"
            then (
              length > 0
              and . != "null"
              and test("^[^[:space:]]+$")
            )
            else false
            end
        );
      if .state == "ARMED"
      then (
        if $armedMode == "first-create"
        then null_previous_ledger
        elif $armedMode == "terminal-rearm"
        then complete_previous_ledger
        elif $armedMode == "read"
        then (null_previous_ledger or complete_previous_ledger)
        else false
        end
      )
      else (
        $armedMode == "read"
        and complete_previous_ledger
      )
      end
    ' "$input_file" >/dev/null
}

read_item() {
  : >"$state_file"
  : >"$response_file"
  : >"$error_file"
  if aws s3api get-object \
    --bucket "$artifact_bucket" \
    --key "$ledger_key" \
    --expected-bucket-owner "$AWS_ACCOUNT_ID" \
    --checksum-mode ENABLED \
    --region "$AWS_REGION" \
    --output json \
    "$state_file" >"$response_file" 2>"$error_file"; then
    require_single_json_object \
      "$state_file" \
      "The recovery ledger object"
    require_single_json_object \
      "$response_file" \
      "The recovery ledger S3 response"
    local expected_checksum
    local state_sha256
    state_sha256="$(sha256sum "$state_file" | awk '{print $1}')"
    expected_checksum="$(
      openssl dgst -sha256 -binary "$state_file" | base64 -w0
    )"
    jq -e \
      --arg checksum "$expected_checksum" \
      --arg environment "$RECOVERY_ENVIRONMENT" \
      --arg kmsPrefix \
        "arn:aws:kms:${AWS_REGION}:${AWS_ACCOUNT_ID}:key/" \
      --argjson bytes "$(wc -c <"$state_file")" \
      '
        (.VersionId | type == "string" and length > 0 and . != "null")
        and (.ETag | type == "string" and test("^\"[0-9a-f]{32}\"$"))
        and .ChecksumSHA256 == $checksum
        and (
          .ServerSideEncryption == "AES256"
          or (
            .ServerSideEncryption == "aws:kms"
            and (
              .SSEKMSKeyId
              | type == "string"
                and startswith($kmsPrefix)
            )
            and .BucketKeyEnabled == true
          )
        )
        and .ContentLength == $bytes
        and .ContentType == "application/json"
        and .Metadata == {
          "environment": $environment,
          "kind": "recovery-ledger"
        }
      ' "$response_file" >/dev/null
    jq -e \
      --arg bucket "$artifact_bucket" \
      --arg environment "$RECOVERY_ENVIRONMENT" \
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
        and (
          .state == "ARMED"
          or .state == "RECOVERING"
          or .state == "COMMITTED"
          or .state == "RECOVERED"
        )
        and (.intentId | test("^[0-9a-f]{64}$"))
        and (.candidateSha | test("^[0-9a-f]{40}$"))
        and (.manifestSha256 | test("^[0-9a-f]{64}$"))
        and .archiveBucket == $bucket
        and .archiveKey == (
          "candidates/recovery/" + $environment + "/" +
          .intentId + ".tar"
        )
        and (
          .archiveVersionId
          | type == "string"
            and length > 0
            and . != "null"
            and test("^[^[:space:]]+$")
        )
        and (.archiveSha256 | test("^[0-9a-f]{64}$"))
        and (.sourceCiRunId | test("^[0-9]+$"))
        and (.sourceCiRunAttempt | test("^[1-9][0-9]*$"))
        and (.sourceRunId | test("^[0-9]+$"))
        and (.sourceRunAttempt | test("^[1-9][0-9]*$"))
        and (.updatedAt | type == "number" and . > 0 and floor == .)
        and (
          if .state == "RECOVERED"
          then (
            .controlProofBucket == $bucket
            and .controlProofKey == (
              "candidates/recovery/" + $environment + "/controls/" +
              .intentId + "/" + .controlProofSha256 + ".json"
            )
            and (.controlProofSha256 | test("^[0-9a-f]{64}$"))
            and (
              .controlProofVersionId
              | type == "string"
                and length > 0
                and . != "null"
                and test("^[^[:space:]]+$")
            )
          )
          else (
            .controlProofBucket == null
            and .controlProofKey == null
            and .controlProofSha256 == null
            and .controlProofVersionId == null
          )
          end
        )
        and (
          (
            .state == "ARMED"
            and .leaseOwner == null
            and .leaseUntil == null
            and .receiptBucket == null
            and .receiptKey == null
            and .receiptSha256 == null
            and .receiptVersionId == null
          )
          or
          (
            .state == "RECOVERING"
            and (
              .leaseOwner
              | type == "string"
                and test("^[A-Za-z0-9][A-Za-z0-9-]{0,127}$")
            )
            and (
              .leaseUntil
              | type == "number"
                and floor == .
                and . > 0
            )
            and .leaseUntil > .updatedAt
            and .receiptBucket == null
            and .receiptKey == null
            and .receiptSha256 == null
            and .receiptVersionId == null
          )
          or
          (
            (.state == "COMMITTED" or .state == "RECOVERED")
            and .leaseOwner == null
            and .leaseUntil == null
            and .receiptBucket == $bucket
            and .receiptKey == (
              "candidates/recovery/" + $environment + "/receipts/" +
              .intentId + "/" + .receiptSha256 + ".json"
            )
            and (.receiptSha256 | test("^[0-9a-f]{64}$"))
            and (
              .receiptVersionId
              | type == "string"
                and length > 0
                and . != "null"
                and test("^[^[:space:]]+$")
            )
          )
        )
      ' "$state_file" >/dev/null
    validate_previous_ledger_provenance "$state_file" read
    jq \
      --arg etag "$(jq -er '.ETag' "$response_file")" \
      --arg ledgerSha256 "$state_sha256" \
      --arg ledgerVersionId "$(jq -er '.VersionId' "$response_file")" \
      '. + {
        exists: true,
        ledgerEtag: $etag,
        ledgerSha256: $ledgerSha256,
        ledgerVersionId: $ledgerVersionId
      }' "$state_file"
    return 0
  fi
  if grep -Eqi 'NoSuchKey|Not Found|\(404\)' "$error_file"; then
    jq -n \
      --arg environment "$RECOVERY_ENVIRONMENT" \
      '{
        environment: $environment,
        exists: false,
        state: null
      }'
    return 0
  fi
  sed 's/[[:cntrl:]]//g' "$error_file" >&2
  return 1
}

assert_archive_identity() {
  local item="$1"
  jq -e \
    --arg bucket "$artifact_bucket" \
    --arg environment "$RECOVERY_ENVIRONMENT" \
    '
      .exists == true
      and .environment == $environment
      and (.intentId | test("^[0-9a-f]{64}$"))
      and .archiveBucket == $bucket
      and .archiveKey == (
        "candidates/recovery/" + $environment + "/" +
        .intentId + ".tar"
      )
      and (
        .archiveVersionId
        | type == "string"
          and length > 0
          and . != "null"
          and test("^[^[:space:]]+$")
      )
      and (.archiveSha256 | test("^[0-9a-f]{64}$"))
      and (.candidateSha | test("^[0-9a-f]{40}$"))
      and (.manifestSha256 | test("^[0-9a-f]{64}$"))
      and (.sourceCiRunId | test("^[0-9]+$"))
      and (.sourceCiRunAttempt | test("^[1-9][0-9]*$"))
      and (.sourceRunId | test("^[0-9]+$"))
      and (.sourceRunAttempt | test("^[1-9][0-9]*$"))
    ' <<<"$item" >/dev/null
}

assert_terminal_item() {
  local item="$1"
  assert_archive_identity "$item"
  jq -e \
    --arg bucket "$artifact_bucket" \
    --arg environment "$RECOVERY_ENVIRONMENT" \
    '
      (.state == "COMMITTED" or .state == "RECOVERED")
      and .receiptBucket == $bucket
      and .receiptKey == (
        "candidates/recovery/" + $environment + "/receipts/" +
        .intentId + "/" + .receiptSha256 + ".json"
      )
      and (
        .receiptVersionId
        | type == "string"
          and length > 0
          and . != "null"
          and test("^[^[:space:]]+$")
      )
      and (.receiptSha256 | test("^[0-9a-f]{64}$"))
      and .leaseOwner == null
      and .leaseUntil == null
      and (
        if .state == "RECOVERED"
        then (
          .controlProofBucket == $bucket
          and .controlProofKey == (
            "candidates/recovery/" + $environment + "/controls/" +
            .intentId + "/" + .controlProofSha256 + ".json"
          )
          and (.controlProofSha256 | test("^[0-9a-f]{64}$"))
          and (
            .controlProofVersionId
            | type == "string"
              and length > 0
              and . != "null"
              and test("^[^[:space:]]+$")
          )
        )
        else (
          .controlProofBucket == null
          and .controlProofKey == null
          and .controlProofSha256 == null
          and .controlProofVersionId == null
        )
        end
      )
    ' <<<"$item" >/dev/null
}

validate_intent_id() {
  [[ "${RECOVERY_INTENT_ID:-}" =~ ^[0-9a-f]{64}$ ]]
}

validate_receipt_identity() {
  for name in \
    RECOVERY_RECEIPT_BUCKET \
    RECOVERY_RECEIPT_KEY \
    RECOVERY_RECEIPT_SHA256 \
    RECOVERY_RECEIPT_VERSION_ID; do
    if [ -z "${!name:-}" ]; then
      echo "$name is required to finalize a recovery intent." >&2
      exit 1
    fi
  done
  test "$RECOVERY_RECEIPT_BUCKET" = "$artifact_bucket"
  test "$RECOVERY_RECEIPT_KEY" = \
    "candidates/recovery/${RECOVERY_ENVIRONMENT}/receipts/${RECOVERY_INTENT_ID}/${RECOVERY_RECEIPT_SHA256}.json"
  [[ "$RECOVERY_RECEIPT_SHA256" =~ ^[0-9a-f]{64}$ ]]
  [[ "$RECOVERY_RECEIPT_VERSION_ID" =~ ^[^[:space:]]+$ ]]
  test "$RECOVERY_RECEIPT_VERSION_ID" != "null"
}

validate_control_proof_identity() {
  for name in \
    RECOVERY_CONTROL_PROOF_BUCKET \
    RECOVERY_CONTROL_PROOF_KEY \
    RECOVERY_CONTROL_PROOF_SHA256 \
    RECOVERY_CONTROL_PROOF_VERSION_ID; do
    if [ -z "${!name:-}" ]; then
      echo "$name is required to finish a recovered intent." >&2
      exit 1
    fi
  done
  test "$RECOVERY_CONTROL_PROOF_BUCKET" = "$artifact_bucket"
  test "$RECOVERY_CONTROL_PROOF_KEY" = \
    "candidates/recovery/${RECOVERY_ENVIRONMENT}/controls/${RECOVERY_INTENT_ID}/${RECOVERY_CONTROL_PROOF_SHA256}.json"
  [[ "$RECOVERY_CONTROL_PROOF_SHA256" =~ ^[0-9a-f]{64}$ ]]
  [[ "$RECOVERY_CONTROL_PROOF_VERSION_ID" =~ ^[^[:space:]]+$ ]]
  test "$RECOVERY_CONTROL_PROOF_VERSION_ID" != "null"
}

publish_state() {
  local prior_exists="$1"
  local prior_etag="$2"
  local next_checksum
  next_checksum="$(
    openssl dgst -sha256 -binary "$next_file" | base64 -w0
  )"
  put_args=(
    s3api put-object
    --bucket "$artifact_bucket"
    --key "$ledger_key"
    --body "$next_file"
    --expected-bucket-owner "$AWS_ACCOUNT_ID"
    --server-side-encryption aws:kms
    --ssekms-key-id "$storage_key_alias"
    --checksum-algorithm SHA256
    --checksum-sha256 "$next_checksum"
    --content-type application/json
    --metadata
      "environment=${RECOVERY_ENVIRONMENT},kind=recovery-ledger"
    --region "$AWS_REGION"
    --output json
  )
  if [ "$prior_exists" = "true" ]; then
    [[ "$prior_etag" =~ ^\"[0-9a-f]{32}\"$ ]]
    put_args+=(--if-match "$prior_etag")
  else
    put_args+=(--if-none-match '*')
  fi
  aws "${put_args[@]}" >"$response_file"
  require_single_json_object \
    "$response_file" \
    "The recovery ledger S3 write response"
  jq -e \
    --arg checksum "$next_checksum" \
    --arg kmsPrefix \
      "arn:aws:kms:${AWS_REGION}:${AWS_ACCOUNT_ID}:key/" \
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
    ' "$response_file" >/dev/null
}

case "$operation" in
  read)
    read_item
    ;;

  assert-clear)
    item="$(read_item)"
    state="$(jq -r '.state // "absent"' <<<"$item")"
    case "$state" in
      absent) ;;
      COMMITTED|RECOVERED)
        assert_terminal_item "$item"
        ;;
      ARMED|RECOVERING)
        echo "An earlier delivery recovery intent is unresolved." >&2
        exit 1
        ;;
      *)
        echo "The delivery recovery ledger state is invalid." >&2
        exit 1
        ;;
    esac
    jq \
      '. + {
        ok: true,
        schema: "archon.recovery-intent.clear",
        version: 1
      }' <<<"$item"
    ;;

  arm)
    for name in \
      CANDIDATE_SHA \
      RECOVERY_ARCHIVE_BUCKET \
      RECOVERY_ARCHIVE_KEY \
      RECOVERY_ARCHIVE_SHA256 \
      RECOVERY_ARCHIVE_VERSION_ID \
      RECOVERY_INTENT_ID \
      RECOVERY_MANIFEST_SHA256 \
      SOURCE_CI_RUN_ATTEMPT \
      SOURCE_CI_RUN_ID \
      SOURCE_DEPLOY_RUN_ATTEMPT \
      SOURCE_DEPLOY_RUN_ID; do
      if [ -z "${!name:-}" ]; then
        echo "$name is required to arm a recovery intent." >&2
        exit 1
      fi
    done
    [[ "$CANDIDATE_SHA" =~ ^[0-9a-f]{40}$ ]]
    [[ "$RECOVERY_ARCHIVE_SHA256" =~ ^[0-9a-f]{64}$ ]]
    validate_intent_id
    [[ "$RECOVERY_MANIFEST_SHA256" =~ ^[0-9a-f]{64}$ ]]
    [[ "$RECOVERY_ARCHIVE_VERSION_ID" =~ ^[^[:space:]]+$ ]]
    test "$RECOVERY_ARCHIVE_VERSION_ID" != "null"
    [[ "$SOURCE_CI_RUN_ID" =~ ^[0-9]+$ ]]
    [[ "$SOURCE_CI_RUN_ATTEMPT" =~ ^[1-9][0-9]*$ ]]
    [[ "$SOURCE_DEPLOY_RUN_ID" =~ ^[0-9]+$ ]]
    [[ "$SOURCE_DEPLOY_RUN_ATTEMPT" =~ ^[1-9][0-9]*$ ]]
    test "$RECOVERY_ARCHIVE_BUCKET" = "$artifact_bucket"
    test "$RECOVERY_ARCHIVE_KEY" = \
      "candidates/recovery/${RECOVERY_ENVIRONMENT}/${RECOVERY_INTENT_ID}.tar"
    current="$(read_item)"
    current_state="$(jq -r '.state // "absent"' <<<"$current")"
    case "$current_state" in
      absent)
        prior_exists=false
        prior_etag=""
        ;;
      COMMITTED|RECOVERED)
        assert_terminal_item "$current"
        prior_exists=true
        prior_etag="$(jq -er '.ledgerEtag' <<<"$current")"
        ;;
      *)
        echo "The current recovery ledger is not armable." >&2
        exit 1
        ;;
    esac
    if [ "$prior_exists" = "true" ]; then
      previous_ledger_etag="$(jq -er '.ledgerEtag' <<<"$current")"
      previous_ledger_sha256="$(jq -er '.ledgerSha256' <<<"$current")"
      previous_ledger_version_id="$(
        jq -er '.ledgerVersionId' <<<"$current"
      )"
    else
      previous_ledger_etag=""
      previous_ledger_sha256=""
      previous_ledger_version_id=""
    fi
    jq -nS \
      --arg archiveBucket "$RECOVERY_ARCHIVE_BUCKET" \
      --arg archiveKey "$RECOVERY_ARCHIVE_KEY" \
      --arg archiveSha256 "$RECOVERY_ARCHIVE_SHA256" \
      --arg archiveVersionId "$RECOVERY_ARCHIVE_VERSION_ID" \
      --arg candidateSha "$CANDIDATE_SHA" \
      --arg environment "$RECOVERY_ENVIRONMENT" \
      --arg intentId "$RECOVERY_INTENT_ID" \
      --arg manifestSha256 "$RECOVERY_MANIFEST_SHA256" \
      --arg previousLedgerEtag "$previous_ledger_etag" \
      --arg previousLedgerSha256 "$previous_ledger_sha256" \
      --arg previousLedgerVersionId "$previous_ledger_version_id" \
      --arg sourceCiRunAttempt "$SOURCE_CI_RUN_ATTEMPT" \
      --arg sourceCiRunId "$SOURCE_CI_RUN_ID" \
      --arg sourceRunAttempt "$SOURCE_DEPLOY_RUN_ATTEMPT" \
      --arg sourceRunId "$SOURCE_DEPLOY_RUN_ID" \
      --argjson updatedAt "$(date +%s)" \
      'def nullable: if . == "" then null else . end;
      {
        schema: "archon.recovery-intent.ledger",
        version: 1,
        environment: $environment,
        state: "ARMED",
        intentId: $intentId,
        candidateSha: $candidateSha,
        controlProofBucket: null,
        controlProofKey: null,
        controlProofSha256: null,
        controlProofVersionId: null,
        manifestSha256: $manifestSha256,
        archiveBucket: $archiveBucket,
        archiveKey: $archiveKey,
        archiveVersionId: $archiveVersionId,
        archiveSha256: $archiveSha256,
        sourceCiRunId: $sourceCiRunId,
        sourceCiRunAttempt: $sourceCiRunAttempt,
        sourceRunId: $sourceRunId,
        sourceRunAttempt: $sourceRunAttempt,
        previousLedgerEtag: ($previousLedgerEtag | nullable),
        previousLedgerSha256: ($previousLedgerSha256 | nullable),
        previousLedgerVersionId: ($previousLedgerVersionId | nullable),
        leaseOwner: null,
        leaseUntil: null,
        receiptBucket: null,
        receiptKey: null,
        receiptVersionId: null,
        receiptSha256: null,
        updatedAt: $updatedAt
      }' >"$next_file"
    if [ "$prior_exists" = "true" ]; then
      armed_provenance_mode="terminal-rearm"
    else
      armed_provenance_mode="first-create"
    fi
    validate_previous_ledger_provenance \
      "$next_file" \
      "$armed_provenance_mode"
    publish_state "$prior_exists" "$prior_etag"
    item="$(read_item)"
    assert_archive_identity "$item"
    jq -e \
      --arg intent "$RECOVERY_INTENT_ID" \
      '.state == "ARMED" and .intentId == $intent' \
      <<<"$item" >/dev/null
    printf '%s\n' "$item"
    ;;

  claim)
    for name in RECOVERY_INTENT_ID RECOVERY_LEASE_OWNER; do
      if [ -z "${!name:-}" ]; then
        echo "$name is required to claim a recovery intent." >&2
        exit 1
      fi
    done
    validate_intent_id
    [[ "$RECOVERY_LEASE_OWNER" =~ ^[A-Za-z0-9][A-Za-z0-9-]{0,127}$ ]]
    previous_owner_proved_dead="${RECOVERY_PREVIOUS_OWNER_PROVED_DEAD:-false}"
    case "$previous_owner_proved_dead" in
      true)
        if [ -z "${RECOVERY_PREVIOUS_LEASE_OWNER:-}" ]; then
          echo "RECOVERY_PREVIOUS_LEASE_OWNER is required for early reclaim." >&2
          exit 1
        fi
        [[ "$RECOVERY_PREVIOUS_LEASE_OWNER" =~ ^watchdog-[0-9]+-[1-9][0-9]*-(staging|production)$ ]]
        [[ "$RECOVERY_PREVIOUS_LEASE_OWNER" == *-"$RECOVERY_ENVIRONMENT" ]]
        ;;
      false)
        test -z "${RECOVERY_PREVIOUS_LEASE_OWNER:-}"
        ;;
      *) exit 1 ;;
    esac
    current="$(read_item)"
    assert_archive_identity "$current"
    test "$(jq -er '.intentId' <<<"$current")" = "$RECOVERY_INTENT_ID"
    current_state="$(jq -er '.state' <<<"$current")"
    now="$(date +%s)"
    case "$current_state" in
      ARMED) ;;
      RECOVERING)
        current_owner="$(jq -er '.leaseOwner' <<<"$current")"
        current_until="$(jq -er '.leaseUntil' <<<"$current")"
        if [ "$current_owner" != "$RECOVERY_LEASE_OWNER" ] &&
           [ "$current_until" -ge "$now" ]; then
          if [ "$previous_owner_proved_dead" != "true" ] ||
             [ "$current_owner" != "$RECOVERY_PREVIOUS_LEASE_OWNER" ]; then
            echo "The durable recovery lease is still active." >&2
            exit 1
          fi
        fi
        ;;
      *) exit 1 ;;
    esac
    previous_ledger_etag="$(jq -er '.ledgerEtag' <<<"$current")"
    previous_ledger_sha256="$(jq -er '.ledgerSha256' <<<"$current")"
    previous_ledger_version_id="$(
      jq -er '.ledgerVersionId' <<<"$current"
    )"
    jq -S \
      --arg owner "$RECOVERY_LEASE_OWNER" \
      --arg previousLedgerEtag "$previous_ledger_etag" \
      --arg previousLedgerSha256 "$previous_ledger_sha256" \
      --arg previousLedgerVersionId "$previous_ledger_version_id" \
      --argjson leaseUntil "$((now + 7200))" \
      --argjson updatedAt "$now" \
      '
        del(.exists, .ledgerEtag, .ledgerSha256, .ledgerVersionId)
        | .state = "RECOVERING"
        | .previousLedgerEtag = $previousLedgerEtag
        | .previousLedgerSha256 = $previousLedgerSha256
        | .previousLedgerVersionId = $previousLedgerVersionId
        | .leaseOwner = $owner
        | .leaseUntil = $leaseUntil
        | .updatedAt = $updatedAt
      ' <<<"$current" >"$next_file"
    publish_state true "$(jq -er '.ledgerEtag' <<<"$current")"
    item="$(read_item)"
    jq -e \
      --arg intent "$RECOVERY_INTENT_ID" \
      --arg owner "$RECOVERY_LEASE_OWNER" \
      '
        .state == "RECOVERING"
        and .intentId == $intent
        and .leaseOwner == $owner
      ' <<<"$item" >/dev/null
    printf '%s\n' "$item"
    ;;

  commit|recover)
    validate_intent_id
    validate_receipt_identity
    if [ "$operation" = "recover" ]; then
      validate_control_proof_identity
      for name in \
        RECOVERY_EXPECTED_LEDGER_ETAG \
        RECOVERY_EXPECTED_LEDGER_LEASE_UNTIL \
        RECOVERY_EXPECTED_LEDGER_SHA256 \
        RECOVERY_EXPECTED_LEDGER_UPDATED_AT \
        RECOVERY_EXPECTED_LEDGER_VERSION_ID; do
        if [ -z "${!name:-}" ]; then
          echo "$name is required to finish recovery." >&2
          exit 1
        fi
      done
      [[ "$RECOVERY_EXPECTED_LEDGER_ETAG" =~ ^\"[0-9a-f]{32}\"$ ]]
      [[ "$RECOVERY_EXPECTED_LEDGER_SHA256" =~ ^[0-9a-f]{64}$ ]]
      [[ "$RECOVERY_EXPECTED_LEDGER_VERSION_ID" =~ ^[^[:space:]]+$ ]]
      test "$RECOVERY_EXPECTED_LEDGER_VERSION_ID" != "null"
      [[ "$RECOVERY_EXPECTED_LEDGER_UPDATED_AT" =~ ^[0-9]+$ ]]
      [[ "$RECOVERY_EXPECTED_LEDGER_LEASE_UNTIL" =~ ^[0-9]+$ ]]
      test "$RECOVERY_EXPECTED_LEDGER_UPDATED_AT" -gt 0
      test "$RECOVERY_EXPECTED_LEDGER_LEASE_UNTIL" -gt \
        "$RECOVERY_EXPECTED_LEDGER_UPDATED_AT"
    fi
    current="$(read_item)"
    assert_archive_identity "$current"
    test "$(jq -er '.intentId' <<<"$current")" = "$RECOVERY_INTENT_ID"
    if [ "$operation" = "commit" ]; then
      test "$(jq -er '.state' <<<"$current")" = "ARMED"
      target_state="COMMITTED"
    else
      if [ -z "${RECOVERY_LEASE_OWNER:-}" ]; then
        echo "RECOVERY_LEASE_OWNER is required to finish recovery." >&2
        exit 1
      fi
      [[ "$RECOVERY_LEASE_OWNER" =~ ^[A-Za-z0-9][A-Za-z0-9-]{0,127}$ ]]
      test "$(jq -er '.state' <<<"$current")" = "RECOVERING"
      test "$(jq -er '.leaseOwner' <<<"$current")" = \
        "$RECOVERY_LEASE_OWNER"
      test "$(jq -er '.ledgerEtag' <<<"$current")" = \
        "$RECOVERY_EXPECTED_LEDGER_ETAG"
      test "$(jq -er '.ledgerSha256' <<<"$current")" = \
        "$RECOVERY_EXPECTED_LEDGER_SHA256"
      test "$(jq -er '.ledgerVersionId' <<<"$current")" = \
        "$RECOVERY_EXPECTED_LEDGER_VERSION_ID"
      test "$(jq -er '.updatedAt' <<<"$current")" = \
        "$RECOVERY_EXPECTED_LEDGER_UPDATED_AT"
      test "$(jq -er '.leaseUntil' <<<"$current")" = \
        "$RECOVERY_EXPECTED_LEDGER_LEASE_UNTIL"
      recovery_now="$(date +%s)"
      test "$RECOVERY_EXPECTED_LEDGER_LEASE_UNTIL" -gt "$recovery_now"
      target_state="RECOVERED"
    fi
    previous_ledger_etag="$(jq -er '.ledgerEtag' <<<"$current")"
    previous_ledger_sha256="$(jq -er '.ledgerSha256' <<<"$current")"
    previous_ledger_version_id="$(
      jq -er '.ledgerVersionId' <<<"$current"
    )"
    jq -S \
      --arg previousLedgerEtag "$previous_ledger_etag" \
      --arg previousLedgerSha256 "$previous_ledger_sha256" \
      --arg previousLedgerVersionId "$previous_ledger_version_id" \
      --arg controlProofBucket "${RECOVERY_CONTROL_PROOF_BUCKET:-}" \
      --arg controlProofKey "${RECOVERY_CONTROL_PROOF_KEY:-}" \
      --arg controlProofSha256 "${RECOVERY_CONTROL_PROOF_SHA256:-}" \
      --arg controlProofVersionId "${RECOVERY_CONTROL_PROOF_VERSION_ID:-}" \
      --arg receiptBucket "$RECOVERY_RECEIPT_BUCKET" \
      --arg receiptKey "$RECOVERY_RECEIPT_KEY" \
      --arg receiptSha256 "$RECOVERY_RECEIPT_SHA256" \
      --arg receiptVersionId "$RECOVERY_RECEIPT_VERSION_ID" \
      --arg state "$target_state" \
      --argjson updatedAt "$(date +%s)" \
      '
        del(.exists, .ledgerEtag, .ledgerSha256, .ledgerVersionId)
        | .state = $state
        | .previousLedgerEtag = $previousLedgerEtag
        | .previousLedgerSha256 = $previousLedgerSha256
        | .previousLedgerVersionId = $previousLedgerVersionId
        | .controlProofBucket = (
            if $state == "RECOVERED" then $controlProofBucket else null end
          )
        | .controlProofKey = (
            if $state == "RECOVERED" then $controlProofKey else null end
          )
        | .controlProofSha256 = (
            if $state == "RECOVERED" then $controlProofSha256 else null end
          )
        | .controlProofVersionId = (
            if $state == "RECOVERED" then $controlProofVersionId else null end
          )
        | .leaseOwner = null
        | .leaseUntil = null
        | .receiptBucket = $receiptBucket
        | .receiptKey = $receiptKey
        | .receiptVersionId = $receiptVersionId
        | .receiptSha256 = $receiptSha256
        | .updatedAt = $updatedAt
      ' <<<"$current" >"$next_file"
    publish_state true "$(jq -er '.ledgerEtag' <<<"$current")"
    item="$(read_item)"
    assert_terminal_item "$item"
    jq \
      '. + {
        ok: true,
        schema: "archon.recovery-intent.terminal",
        version: 1
      }' <<<"$item"
    ;;
esac
