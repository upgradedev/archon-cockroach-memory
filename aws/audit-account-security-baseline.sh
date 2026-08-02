#!/usr/bin/env bash
set -euo pipefail

umask 077

fail() {
  printf 'AWS account security baseline audit failed: %s\n' "$1" >&2
  exit 1
}

require_env() {
  local name="$1"
  [ -n "${!name:-}" ] || fail "required environment variable ${name} is missing"
}

for required in \
  AWS_ACCOUNT_ID \
  AWS_REGION \
  AWS_SECURITY_AUDIT_ROLE_ARN \
  GITHUB_REF \
  GITHUB_REPOSITORY \
  GITHUB_SHA \
  GITHUB_WORKFLOW_REF \
  RECEIPT_PATH \
  RUNNER_TEMP \
  TARGET_SHA; do
  require_env "$required"
done

[[ "$AWS_ACCOUNT_ID" =~ ^[0-9]{12}$ ]] ||
  fail "AWS_ACCOUNT_ID must be a 12-digit account id"
[[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] ||
  fail "TARGET_SHA must be an exact lowercase commit SHA"
[ "$TARGET_SHA" = "$GITHUB_SHA" ] ||
  fail "the checked-out commit does not match TARGET_SHA"
[ "$AWS_REGION" = "eu-west-1" ] ||
  fail "the account baseline audit is fixed to eu-west-1"
[ "$GITHUB_REPOSITORY" = "upgradedev/archon-cockroach-memory" ] ||
  fail "the repository identity is outside the audit contract"
[ "$GITHUB_REF" = "refs/heads/main" ] ||
  fail "the account baseline audit accepts current main only"
[ "$GITHUB_WORKFLOW_REF" = \
  "upgradedev/archon-cockroach-memory/.github/workflows/aws-security-baseline.yml@refs/heads/main" ] ||
  fail "the workflow source is not the protected main workflow"
[[ "$AWS_SECURITY_AUDIT_ROLE_ARN" =~ ^arn:aws:iam::${AWS_ACCOUNT_ID}:role/[A-Za-z0-9+=,.@_/-]{1,512}$ ]] ||
  fail "the configured audit role is not bound to the approved account"

expected_receipt="${RUNNER_TEMP%/}/aws-account-security-baseline-receipt.json"
[ "$RECEIPT_PATH" = "$expected_receipt" ] ||
  fail "the receipt path must be the exact runner-temporary audit receipt"
[ -f "$RECEIPT_PATH" ] || fail "the fail-closed receipt was not initialized"
[ ! -L "$RECEIPT_PATH" ] || fail "the receipt path must not be a symbolic link"

raw_dir="$(mktemp -d "${RUNNER_TEMP%/}/aws-security-baseline.XXXXXXXXXX")"
case "$raw_dir" in
  "${RUNNER_TEMP%/}"/aws-security-baseline.*) ;;
  *) fail "the raw response directory escaped RUNNER_TEMP" ;;
esac

cleanup() {
  case "$raw_dir" in
    "${RUNNER_TEMP%/}"/aws-security-baseline.*)
      rm -f -- "$raw_dir"/*.json
      rmdir -- "$raw_dir" 2>/dev/null || true
      ;;
  esac
}
trap cleanup EXIT

run_json() {
  local output_path="$1"
  shift
  if aws "$@" --output json --no-cli-pager >"$output_path" 2>/dev/null &&
    jq -e 'type == "object"' "$output_path" >/dev/null; then
    return 0
  fi
  printf '{}\n' >"$output_path"
  return 1
}

bool_json() {
  case "$1" in
    true|false) printf '%s' "$1" ;;
    *) fail "internal boolean state is invalid" ;;
  esac
}

add_control() {
  local id="$1"
  local ok="$2"
  local observed="$3"
  controls+=(
    "$(jq -cn \
      --arg id "$id" \
      --argjson ok "$(bool_json "$ok")" \
      --argjson observed "$observed" \
      '{id: $id, ok: $ok, observed: $observed}')"
  )
}

# Bind the temporary credentials before any account-wide inspection. Raw STS
# identity remains in RUNNER_TEMP and is never copied into the receipt.
identity_file="$raw_dir/identity.json"
run_json "$identity_file" sts get-caller-identity ||
  fail "the temporary OIDC credentials could not identify their account and role"
expected_role_name="${AWS_SECURITY_AUDIT_ROLE_ARN##*/}"
jq -e \
  --arg account "$AWS_ACCOUNT_ID" \
  --arg rolePrefix "arn:aws:sts::${AWS_ACCOUNT_ID}:assumed-role/${expected_role_name}/" \
  '.Account == $account and (.Arn | type == "string" and startswith($rolePrefix))' \
  "$identity_file" >/dev/null ||
  fail "the temporary OIDC credentials are not the approved account audit role"

controls=()
add_control \
  "audit-identity-binding" \
  true \
  '{"accountMatch":true,"roleMatch":true,"sourceShaMatch":true}'

# Account-level S3 Block Public Access.
s3_file="$raw_dir/s3-public-access.json"
s3_readable=false
s3_block_acls=false
s3_ignore_acls=false
s3_block_policy=false
s3_restrict_buckets=false
if run_json \
  "$s3_file" \
  s3control get-public-access-block \
  --account-id "$AWS_ACCOUNT_ID" \
  --region "$AWS_REGION"; then
  s3_readable=true
  s3_block_acls="$(jq -r '.PublicAccessBlockConfiguration.BlockPublicAcls == true' "$s3_file")"
  s3_ignore_acls="$(jq -r '.PublicAccessBlockConfiguration.IgnorePublicAcls == true' "$s3_file")"
  s3_block_policy="$(jq -r '.PublicAccessBlockConfiguration.BlockPublicPolicy == true' "$s3_file")"
  s3_restrict_buckets="$(jq -r '.PublicAccessBlockConfiguration.RestrictPublicBuckets == true' "$s3_file")"
fi
s3_ok=false
if [ "$s3_readable" = true ] &&
   [ "$s3_block_acls" = true ] &&
   [ "$s3_ignore_acls" = true ] &&
   [ "$s3_block_policy" = true ] &&
   [ "$s3_restrict_buckets" = true ]; then
  s3_ok=true
fi
add_control \
  "s3-account-public-access-block" \
  "$s3_ok" \
  "$(jq -cn \
    --argjson apiReadable "$s3_readable" \
    --argjson blockPublicAcls "$s3_block_acls" \
    --argjson ignorePublicAcls "$s3_ignore_acls" \
    --argjson blockPublicPolicy "$s3_block_policy" \
    --argjson restrictPublicBuckets "$s3_restrict_buckets" \
    '{
      apiReadable: $apiReadable,
      blockPublicAcls: $blockPublicAcls,
      ignorePublicAcls: $ignorePublicAcls,
      blockPublicPolicy: $blockPublicPolicy,
      restrictPublicBuckets: $restrictPublicBuckets
    }')"

# Root credential posture. AccountSummary intentionally exposes counts only.
summary_file="$raw_dir/iam-account-summary.json"
summary_readable=false
root_mfa=false
root_access_keys_absent=false
if run_json "$summary_file" iam get-account-summary --region "$AWS_REGION"; then
  summary_readable=true
  root_mfa="$(jq -r '.SummaryMap.AccountMFAEnabled == 1' "$summary_file")"
  root_access_keys_absent="$(jq -r '.SummaryMap.AccountAccessKeysPresent == 0' "$summary_file")"
fi
root_ok=false
if [ "$summary_readable" = true ] &&
   [ "$root_mfa" = true ] &&
   [ "$root_access_keys_absent" = true ]; then
  root_ok=true
fi
add_control \
  "root-credential-posture" \
  "$root_ok" \
  "$(jq -cn \
    --argjson apiReadable "$summary_readable" \
    --argjson mfaEnabled "$root_mfa" \
    --argjson accessKeysAbsent "$root_access_keys_absent" \
    '{
      apiReadable: $apiReadable,
      mfaEnabled: $mfaEnabled,
      accessKeysAbsent: $accessKeysAbsent
    }')"

# IAM console password policy. This fails closed when the account has no policy.
password_file="$raw_dir/iam-password-policy.json"
password_observed='{
  "apiReadable": false,
  "minimumPasswordLength": 0,
  "maxPasswordAge": 0,
  "passwordReusePrevention": 0,
  "complexityRequirements": 0,
  "allowUsersToChangePassword": false,
  "hardExpiryDisabled": false
}'
password_ok=false
if run_json "$password_file" iam get-account-password-policy --region "$AWS_REGION"; then
  password_observed="$(jq -c '
    .PasswordPolicy as $p
    | {
        apiReadable: true,
        minimumPasswordLength: ($p.MinimumPasswordLength // 0),
        maxPasswordAge: ($p.MaxPasswordAge // 0),
        passwordReusePrevention: ($p.PasswordReusePrevention // 0),
        complexityRequirements: ([
          $p.RequireSymbols,
          $p.RequireNumbers,
          $p.RequireUppercaseCharacters,
          $p.RequireLowercaseCharacters
        ] | map(select(. == true)) | length),
        allowUsersToChangePassword: ($p.AllowUsersToChangePassword == true),
        hardExpiryDisabled: ($p.HardExpiry == false)
      }' "$password_file")"
  password_ok="$(jq -r '
    .PasswordPolicy as $p
    | ($p.MinimumPasswordLength // 0) >= 14
      and $p.RequireSymbols == true
      and $p.RequireNumbers == true
      and $p.RequireUppercaseCharacters == true
      and $p.RequireLowercaseCharacters == true
      and $p.AllowUsersToChangePassword == true
      and $p.ExpirePasswords == true
      and ($p.MaxPasswordAge // 0) >= 1
      and ($p.MaxPasswordAge // 0) <= 90
      and ($p.PasswordReusePrevention // 0) >= 24
      and $p.HardExpiry == false
    ' "$password_file")"
fi
add_control "iam-password-policy" "$password_ok" "$password_observed"

# Multi-region CloudTrail with global events, log validation, active delivery,
# and active digest delivery. Trail names/ARNs stay in the raw directory.
trails_file="$raw_dir/cloudtrail-trails.json"
trails_readable=false
eligible_trail_count=0
logging_validated_trail_count=0
if run_json \
  "$trails_file" \
  cloudtrail describe-trails \
  --include-shadow-trails \
  --region "$AWS_REGION"; then
  trails_readable=true
  mapfile -t eligible_trails < <(
    jq -r \
      '.trailList[]?
       | select(
           .IsMultiRegionTrail == true
           and .IncludeGlobalServiceEvents == true
           and .LogFileValidationEnabled == true
           and (.TrailARN | type == "string")
           and (.HomeRegion | type == "string")
         )
       | [.TrailARN, .HomeRegion]
       | tojson
       | @base64' \
      "$trails_file"
  )
  eligible_trail_count="${#eligible_trails[@]}"
  trail_index=0
  for encoded_trail in "${eligible_trails[@]}"; do
    trail_index=$((trail_index + 1))
    trail_arn="$(jq -rn --arg encoded "$encoded_trail" '$encoded | @base64d | fromjson | .[0]')"
    trail_home_region="$(jq -rn --arg encoded "$encoded_trail" '$encoded | @base64d | fromjson | .[1]')"
    [[ "$trail_home_region" =~ ^[a-z]{2}-[a-z]+-[0-9]+$ ]] || continue
    status_file="$raw_dir/cloudtrail-status-${trail_index}.json"
    if run_json \
      "$status_file" \
      cloudtrail get-trail-status \
      --name "$trail_arn" \
      --region "$trail_home_region" &&
      jq -e '
        .IsLogging == true
        and .LatestDeliveryTime != null
        and .LatestDigestDeliveryTime != null
        and ((.LatestDeliveryError // "") == "")
        and ((.LatestDigestDeliveryError // "") == "")
      ' "$status_file" >/dev/null; then
      logging_validated_trail_count=$((logging_validated_trail_count + 1))
    fi
  done
fi
cloudtrail_ok=false
if [ "$trails_readable" = true ] &&
   [ "$logging_validated_trail_count" -ge 1 ]; then
  cloudtrail_ok=true
fi
add_control \
  "cloudtrail-multi-region-validation" \
  "$cloudtrail_ok" \
  "$(jq -cn \
    --argjson apiReadable "$trails_readable" \
    --argjson eligibleTrailCount "$eligible_trail_count" \
    --argjson loggingValidatedTrailCount "$logging_validated_trail_count" \
    '{
      apiReadable: $apiReadable,
      eligibleTrailCount: $eligibleTrailCount,
      loggingValidatedTrailCount: $loggingValidatedTrailCount
    }')"

# GuardDuty has at most one detector per region; require exactly one enabled
# detector and retain only counts in the receipt.
detectors_file="$raw_dir/guardduty-detectors.json"
guardduty_readable=false
detector_count=0
enabled_detector_count=0
if run_json \
  "$detectors_file" \
  guardduty list-detectors \
  --region "$AWS_REGION"; then
  guardduty_readable=true
  mapfile -t detector_ids < <(jq -r '.DetectorIds[]?' "$detectors_file")
  detector_count="${#detector_ids[@]}"
  detector_index=0
  for detector_id in "${detector_ids[@]}"; do
    detector_index=$((detector_index + 1))
    detector_file="$raw_dir/guardduty-detector-${detector_index}.json"
    if run_json \
      "$detector_file" \
      guardduty get-detector \
      --detector-id "$detector_id" \
      --region "$AWS_REGION" &&
      jq -e '.Status == "ENABLED"' "$detector_file" >/dev/null; then
      enabled_detector_count=$((enabled_detector_count + 1))
    fi
  done
fi
guardduty_ok=false
if [ "$guardduty_readable" = true ] &&
   [ "$detector_count" -eq 1 ] &&
   [ "$enabled_detector_count" -eq 1 ]; then
  guardduty_ok=true
fi
add_control \
  "guardduty-detector" \
  "$guardduty_ok" \
  "$(jq -cn \
    --argjson apiReadable "$guardduty_readable" \
    --argjson detectorCount "$detector_count" \
    --argjson enabledDetectorCount "$enabled_detector_count" \
    '{
      apiReadable: $apiReadable,
      detectorCount: $detectorCount,
      enabledDetectorCount: $enabledDetectorCount
    }')"

# Security Hub must be enabled with both AWS Foundational Security Best
# Practices and a ready CIS AWS Foundations Benchmark standard.
hub_file="$raw_dir/security-hub.json"
standards_file="$raw_dir/security-hub-standards.json"
hub_readable=false
standards_readable=false
ready_standard_count=0
foundational_standard_ready=false
cis_standard_ready=false
if run_json "$hub_file" securityhub describe-hub --region "$AWS_REGION"; then
  hub_readable=true
fi
if run_json \
  "$standards_file" \
  securityhub get-enabled-standards \
  --region "$AWS_REGION"; then
  standards_readable=true
  ready_standard_count="$(jq '[.StandardsSubscriptions[]? | select(.StandardsStatus == "READY")] | length' "$standards_file")"
  foundational_standard_ready="$(jq -r '
    any(.StandardsSubscriptions[]?;
      .StandardsStatus == "READY"
      and ((.StandardsArn // "") | endswith("/standards/aws-foundational-security-best-practices/v/1.0.0"))
    )' "$standards_file")"
  cis_standard_ready="$(jq -r '
    any(.StandardsSubscriptions[]?;
      .StandardsStatus == "READY"
      and ((.StandardsArn // "") | contains("/standards/cis-aws-foundations-benchmark/v/"))
    )' "$standards_file")"
fi
security_hub_ok=false
if [ "$hub_readable" = true ] &&
   [ "$standards_readable" = true ] &&
   [ "$foundational_standard_ready" = true ] &&
   [ "$cis_standard_ready" = true ]; then
  security_hub_ok=true
fi
add_control \
  "security-hub-standards" \
  "$security_hub_ok" \
  "$(jq -cn \
    --argjson hubReadable "$hub_readable" \
    --argjson standardsReadable "$standards_readable" \
    --argjson readyStandardCount "$ready_standard_count" \
    --argjson foundationalStandardReady "$foundational_standard_ready" \
    --argjson cisStandardReady "$cis_standard_ready" \
    '{
      hubReadable: $hubReadable,
      standardsReadable: $standardsReadable,
      readyStandardCount: $readyStandardCount,
      foundationalStandardReady: $foundationalStandardReady,
      cisStandardReady: $cisStandardReady
    }')"

# AWS Config requires a continuously recording, all-supported recorder with
# global IAM resources and a healthy delivery channel. Names stay raw.
recorders_file="$raw_dir/config-recorders.json"
recorder_status_file="$raw_dir/config-recorder-status.json"
channels_file="$raw_dir/config-channels.json"
channel_status_file="$raw_dir/config-channel-status.json"
config_readable=false
healthy_recorder_count=0
healthy_channel_count=0
if run_json \
  "$recorders_file" \
  configservice describe-configuration-recorders \
  --region "$AWS_REGION" &&
   run_json \
  "$recorder_status_file" \
  configservice describe-configuration-recorder-status \
  --region "$AWS_REGION" &&
   run_json \
  "$channels_file" \
  configservice describe-delivery-channels \
  --region "$AWS_REGION" &&
   run_json \
  "$channel_status_file" \
  configservice describe-delivery-channel-status \
  --region "$AWS_REGION"; then
  config_readable=true
  healthy_recorder_count="$(jq -n \
    --slurpfile recorders "$recorders_file" \
    --slurpfile statuses "$recorder_status_file" \
    '[
      $recorders[0].ConfigurationRecorders[]? as $recorder
      | $statuses[0].ConfigurationRecordersStatus[]?
      | select(.name == $recorder.name)
      | select(
          .recording == true
          and .lastStatus == "SUCCESS"
          and ((.lastErrorCode // "") == "")
          and ((.lastErrorMessage // "") == "")
          and $recorder.recordingGroup.allSupported == true
          and $recorder.recordingGroup.includeGlobalResourceTypes == true
          and (($recorder.recordingMode.recordingFrequency // "CONTINUOUS") == "CONTINUOUS")
        )
    ] | length')"
  healthy_channel_count="$(jq -n \
    --slurpfile channels "$channels_file" \
    --slurpfile statuses "$channel_status_file" \
    '[
      $channels[0].DeliveryChannels[]? as $channel
      | $statuses[0].DeliveryChannelsStatus[]?
      | select(.name == $channel.name)
      | select(
          .configHistoryDeliveryInfo.lastStatus == "SUCCESS"
          and ((.configHistoryDeliveryInfo.lastErrorCode // "") == "")
          and ((.configHistoryDeliveryInfo.lastErrorMessage // "") == "")
        )
    ] | length')"
fi
config_ok=false
if [ "$config_readable" = true ] &&
   [ "$healthy_recorder_count" -ge 1 ] &&
   [ "$healthy_channel_count" -ge 1 ]; then
  config_ok=true
fi
add_control \
  "aws-config-recorder-channel" \
  "$config_ok" \
  "$(jq -cn \
    --argjson apiReadable "$config_readable" \
    --argjson healthyRecorderCount "$healthy_recorder_count" \
    --argjson healthyChannelCount "$healthy_channel_count" \
    '{
      apiReadable: $apiReadable,
      healthyRecorderCount: $healthyRecorderCount,
      healthyChannelCount: $healthyChannelCount
    }')"

# Require an active account- or organization-scope Access Analyzer.
account_analyzers_file="$raw_dir/access-analyzers-account.json"
organization_analyzers_file="$raw_dir/access-analyzers-organization.json"
analyzers_readable=false
account_analyzers_readable=false
organization_analyzers_readable=false
active_analyzer_count=0
if run_json \
  "$account_analyzers_file" \
  accessanalyzer list-analyzers \
  --type ACCOUNT \
  --region "$AWS_REGION"; then
  account_analyzers_readable=true
fi
if run_json \
  "$organization_analyzers_file" \
  accessanalyzer list-analyzers \
  --type ORGANIZATION \
  --region "$AWS_REGION"; then
  organization_analyzers_readable=true
fi
if [ "$account_analyzers_readable" = true ] ||
   [ "$organization_analyzers_readable" = true ]; then
  analyzers_readable=true
  active_analyzer_count="$(jq -n \
    --slurpfile account "$account_analyzers_file" \
    --slurpfile organization "$organization_analyzers_file" \
    '[
      ($account[0].analyzers[]?, $organization[0].analyzers[]?)
      | select(.status == "ACTIVE" and (.type == "ACCOUNT" or .type == "ORGANIZATION"))
    ] | length')"
fi
analyzer_ok=false
if [ "$analyzers_readable" = true ] &&
   [ "$active_analyzer_count" -ge 1 ]; then
  analyzer_ok=true
fi
add_control \
  "iam-access-analyzer" \
  "$analyzer_ok" \
  "$(jq -cn \
    --argjson apiReadable "$analyzers_readable" \
    --argjson accountApiReadable "$account_analyzers_readable" \
    --argjson organizationApiReadable "$organization_analyzers_readable" \
    --argjson activeAnalyzerCount "$active_analyzer_count" \
    '{
      apiReadable: $apiReadable,
      accountApiReadable: $accountApiReadable,
      organizationApiReadable: $organizationApiReadable,
      activeAnalyzerCount: $activeAnalyzerCount
    }')"

# Default EBS encryption is regional and must be enabled in eu-west-1.
ebs_file="$raw_dir/ebs-encryption.json"
ebs_readable=false
ebs_enabled=false
if run_json \
  "$ebs_file" \
  ec2 get-ebs-encryption-by-default \
  --region "$AWS_REGION"; then
  ebs_readable=true
  ebs_enabled="$(jq -r '.EbsEncryptionByDefault == true' "$ebs_file")"
fi
ebs_ok=false
if [ "$ebs_readable" = true ] && [ "$ebs_enabled" = true ]; then
  ebs_ok=true
fi
add_control \
  "ebs-default-encryption" \
  "$ebs_ok" \
  "$(jq -cn \
    --argjson apiReadable "$ebs_readable" \
    --argjson enabled "$ebs_enabled" \
    '{apiReadable: $apiReadable, enabled: $enabled}')"

controls_json="$(printf '%s\n' "${controls[@]}" | jq -s 'sort_by(.id)')"
passed_count="$(jq '[.[] | select(.ok == true)] | length' <<<"$controls_json")"
failed_count=$((10 - passed_count))
overall_ok=false
if [ "$passed_count" -eq 10 ]; then
  overall_ok=true
fi

final_receipt="$raw_dir/final-receipt.json"
jq -n \
  --arg repository "$GITHUB_REPOSITORY" \
  --arg commit "$TARGET_SHA" \
  --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson ok "$overall_ok" \
  --argjson passed "$passed_count" \
  --argjson failed "$failed_count" \
  --argjson controls "$controls_json" \
  '{
    schema: "archon.aws.account-security-baseline",
    schemaVersion: 1,
    ok: $ok,
    mode: "live-read-only",
    repository: $repository,
    commit: $commit,
    generatedAt: $generatedAt,
    region: "eu-west-1",
    identity: {
      accountBound: true,
      accountIdentifierRedacted: true,
      roleIdentifierRedacted: true
    },
    summary: {total: 10, passed: $passed, failed: $failed},
    controls: $controls,
    limitations: [
      "This is a point-in-time read-only snapshot of the approved AWS account and eu-west-1.",
      "The audit neither activates nor remediates account-wide controls and proves no future posture.",
      "Inspector coverage and organization delegated-administrator posture are outside this WA-03 receipt."
    ]
  }' >"$final_receipt"

jq -e \
  --arg repository "$GITHUB_REPOSITORY" \
  --arg commit "$TARGET_SHA" \
  '
    (keys | sort) == [
      "commit", "controls", "generatedAt", "identity", "limitations",
      "mode", "ok", "region", "repository", "schema", "schemaVersion",
      "summary"
    ]
    and .schema == "archon.aws.account-security-baseline"
    and .schemaVersion == 1
    and .mode == "live-read-only"
    and .repository == $repository
    and .commit == $commit
    and .region == "eu-west-1"
    and .identity == {
      accountBound: true,
      accountIdentifierRedacted: true,
      roleIdentifierRedacted: true
    }
    and .summary.total == 10
    and .summary.passed + .summary.failed == 10
    and (.controls | length) == 10
    and all(.controls[];
      (keys | sort) == ["id", "observed", "ok"]
      and (.ok | type) == "boolean"
      and (.observed | type) == "object"
    )
    and (.limitations | length) == 3
  ' "$final_receipt" >/dev/null ||
  fail "the sanitized receipt failed its internal schema contract"
! grep -Eqi \
  'arn:(aws|aws-cn|aws-us-gov):|:assumed-role/|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}' \
  "$final_receipt" ||
  fail "the sanitized receipt contains a raw identifier"

mv -f -- "$final_receipt" "$RECEIPT_PATH"
printf 'AWS account security baseline audit finalized: %s/10 controls passed.\n' \
  "$passed_count"
