#!/usr/bin/env bash
# Strictly validate one self-contained, sanitized durable recovery receipt.
set -euo pipefail
umask 077

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 RECOVERY_RECEIPT" >&2
  exit 1
fi
receipt_file="$1"
if [ ! -f "$receipt_file" ] || [ -L "$receipt_file" ]; then
  echo "The durable recovery receipt must be a regular file." >&2
  exit 1
fi
if [ "$(wc -c <"$receipt_file")" -gt 1048576 ]; then
  echo "The durable recovery receipt exceeds the bounded size." >&2
  exit 1
fi

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

require_single_json_object \
  "$receipt_file" \
  "The durable recovery receipt"

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
  RECOVERY_LEDGER_FILE \
  RECOVERY_MANIFEST_FILE \
  STACK_NAME; do
  if [ -z "${!name:-}" ]; then
    echo "$name is required to verify a durable recovery receipt." >&2
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

for evidence_file in "$RECOVERY_LEDGER_FILE" "$RECOVERY_MANIFEST_FILE"; do
  if [ ! -f "$evidence_file" ] || [ -L "$evidence_file" ]; then
    echo "A durable recovery receipt evidence input is invalid." >&2
    exit 1
  fi
  require_single_json_object \
    "$evidence_file" \
    "A durable recovery receipt evidence input"
done
frontend_prestate_file="$(
  dirname -- "$RECOVERY_MANIFEST_FILE"
)/frontend-prestate.json"
if [ ! -f "$frontend_prestate_file" ] || [ -L "$frontend_prestate_file" ]; then
  echo "The durable recovery frontend prestate is invalid." >&2
  exit 1
fi
require_single_json_object \
  "$frontend_prestate_file" \
  "The durable recovery frontend prestate"

receipt_sha256="$(sha256sum "$receipt_file" | awk '{print $1}')"
[[ "$receipt_sha256" =~ ^[0-9a-f]{64}$ ]]
if [ -n "${EXPECTED_RECOVERY_RECEIPT_SHA256:-}" ]; then
  [[ "$EXPECTED_RECOVERY_RECEIPT_SHA256" =~ ^[0-9a-f]{64}$ ]]
  test "$receipt_sha256" = "$EXPECTED_RECOVERY_RECEIPT_SHA256"
fi
manifest_sha256="$(
  sha256sum "$RECOVERY_MANIFEST_FILE" | awk '{print $1}'
)"
artifact_bucket="${APP_NAME}-artifacts-${AWS_ACCOUNT_ID}-${AWS_REGION}"
ledger_key="candidates/recovery/${RECOVERY_ENVIRONMENT}/ledger.json"

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
    and (.candidateSha | test("^[0-9a-f]{40}$"))
    and (.manifestSha256 | test("^[0-9a-f]{64}$"))
    and (.sourceCiRunId | test("^[0-9]+$"))
    and (.sourceCiRunAttempt | test("^[1-9][0-9]*$"))
    and (.sourceRunId | test("^[0-9]+$"))
    and (.sourceRunAttempt | test("^[1-9][0-9]*$"))
    and (.ledgerEtag | test("^\"[0-9a-f]{32}\"$"))
    and (.ledgerSha256 | test("^[0-9a-f]{64}$"))
    and (
      .ledgerVersionId
      | type == "string"
        and length > 0
        and . != "null"
        and test("^[^[:space:]]+$")
    )
    and (.updatedAt | type == "number" and . > 0 and floor == .)
    and (.leaseUntil | type == "number" and . > 0 and floor == .)
    and .leaseUntil > .updatedAt
  ' "$RECOVERY_LEDGER_FILE" >/dev/null

jq -e \
  --arg account "$AWS_ACCOUNT_ID" \
  --arg app "$APP_NAME" \
  --arg bucket "$artifact_bucket" \
  --arg environment "$RECOVERY_ENVIRONMENT" \
  --arg intent "$RECOVERY_INTENT_ID" \
  --arg repository "$GITHUB_REPOSITORY" \
  --arg role "$AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN" \
  --arg stack "$STACK_NAME" \
  '
    .schema == "archon.durable-recovery-intent"
    and .version == 1
    and .accountId == $account
    and .appName == $app
    and .artifactBucket == $bucket
    and .environment == $environment
    and .executionRoleArn == $role
    and .intentId == $intent
    and .region == "eu-west-1"
    and .repository == $repository
    and .stackName == $stack
    and (
      (
        .stackState == "greenfield"
        and .hasPreviousStack == false
      )
      or
      (
        .stackState == "existing"
        and .hasPreviousStack == true
      )
    )
  ' "$RECOVERY_MANIFEST_FILE" >/dev/null

jq -e \
  --arg account "$AWS_ACCOUNT_ID" \
  --arg app "$APP_NAME" \
  --arg bucket "$artifact_bucket" \
  --arg codeSha "$RECOVERY_CODE_SHA" \
  --arg environment "$RECOVERY_ENVIRONMENT" \
  --arg executionId "$RECOVERY_EXECUTION_ID" \
  --arg executionRoleArn "$AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN" \
  --arg intent "$RECOVERY_INTENT_ID" \
  --arg leaseOwner "$RECOVERY_LEASE_OWNER" \
  --arg ledgerKey "$ledger_key" \
  --arg manifestSha256 "$manifest_sha256" \
  --arg repository "$GITHUB_REPOSITORY" \
  --arg stack "$STACK_NAME" \
  --arg workflowRef "$GITHUB_WORKFLOW_REF" \
  --argjson nowEpoch "$(date +%s)" \
  --slurpfile frontendPrestate "$frontend_prestate_file" \
  --slurpfile ledger "$RECOVERY_LEDGER_FILE" \
  --slurpfile manifest "$RECOVERY_MANIFEST_FILE" \
  '
    def exact_keys($expected):
      type == "object" and (keys | sort) == ($expected | sort);
    def nonblank:
      type == "string"
      and length > 0
      and . != "null"
      and test("^[^[:space:]]+$");
    def sha256:
      type == "string" and test("^[0-9a-f]{64}$");
    def iso8601_timestamp:
      type == "string"
      and test(
        "^[0-9]{4}-[0-9]{2}-[0-9]{2}T" +
        "[0-9]{2}:[0-9]{2}:[0-9]{2}" +
        "(\\.[0-9]{1,9})?" +
        "(Z|[+-](0[0-9]|1[0-3]):[0-5][0-9]|[+-]14:00)$"
      )
      and (
        (
          capture(
            "^(?<base>[0-9]{4}-[0-9]{2}-[0-9]{2}T" +
            "[0-9]{2}:[0-9]{2}:[0-9]{2})"
          ).base + "Z"
          | try fromdateiso8601 catch null
        )
        | type == "number"
      );
    def not_applicable:
      exact_keys(["ok", "state"])
      and .ok == true
      and .state == "not-applicable-greenfield";
    def valid_logging:
      exact_keys([
        "destinationBucket",
        "environment",
        "evidence",
        "expected",
        "foundationVerified",
        "mode",
        "ok",
        "preflightIntegrity",
        "priorState",
        "restoredConfiguration",
        "restoredState",
        "schema",
        "sourceBucket",
        "stackState",
        "version"
      ])
      and .ok == true
      and .schema == "archon.application-s3-access-logging.recovery"
      and .version == 1
      and .mode == "recover"
      and .evidence == "live-control-plane"
      and .foundationVerified == true
      and .environment == $environment
      and .sourceBucket == (
        $app + "-" + $environment + "-web-" + $account + "-eu-west-1"
      )
      and .destinationBucket == (
        $app + "-s3-access-logs-" + $account + "-eu-west-1"
      )
      and .stackState == $manifest[0].stackState
      and (
        .priorState == "absent"
        or .priorState == "disabled"
        or .priorState == "enabled"
      )
      and .restoredState == .priorState
      and .expected == {
        LoggingEnabled: {
          TargetBucket: (
            $app + "-s3-access-logs-" + $account + "-eu-west-1"
          ),
          TargetObjectKeyFormat: {
            PartitionedPrefix: {
              PartitionDateSource: "EventTime"
            }
          },
          TargetPrefix: ($environment + "-web/")
        }
      }
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
      and (
        .preflightIntegrity
        | exact_keys(["algorithm", "canonicalization", "payloadSha256"])
        and .algorithm == "sha256"
        and .canonicalization == "jq-cS-v1"
        and (.payloadSha256 | sha256)
      );
    ($frontendPrestate | length) == 1
    and ($ledger | length) == 1
    and ($manifest | length) == 1
    and
    exact_keys([
      "archive",
      "candidateSha",
      "completedAt",
      "environment",
      "executor",
      "intentId",
      "manifestSha256",
      "ok",
      "proofs",
      "recoveringLedger",
      "result",
      "schema",
      "sourceCiRunAttempt",
      "sourceCiRunId",
      "sourceDeployRunAttempt",
      "sourceDeployRunId",
      "stackState",
      "target",
      "version"
    ])
    and .ok == true
    and .schema == "archon.durable-recovery.receipt"
    and .version == 2
    and .environment == $environment
    and .intentId == $intent
    and .candidateSha == $ledger[0].candidateSha
    and .candidateSha == $manifest[0].candidateSha
    and .sourceCiRunId == $ledger[0].sourceCiRunId
    and .sourceCiRunId == $manifest[0].sourceCiRunId
    and .sourceCiRunAttempt == $ledger[0].sourceCiRunAttempt
    and .sourceCiRunAttempt == $manifest[0].sourceCiRunAttempt
    and .sourceDeployRunId == $ledger[0].sourceRunId
    and .sourceDeployRunId == $manifest[0].sourceDeployRunId
    and .sourceDeployRunAttempt == $ledger[0].sourceRunAttempt
    and .sourceDeployRunAttempt == $manifest[0].sourceDeployRunAttempt
    and .manifestSha256 == $manifestSha256
    and .manifestSha256 == $ledger[0].manifestSha256
    and .stackState == $manifest[0].stackState
    and .result == "RECOVERED"
    and (
      .completedAt
      | type == "string"
        and test(
          "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"
        )
    )
    and ((.completedAt | fromdateiso8601) >= $ledger[0].updatedAt)
    and ((.completedAt | fromdateiso8601) <= ($nowEpoch + 300))
    and (
      .target
      | exact_keys([
          "accountId",
          "appName",
          "executionRoleArn",
          "region",
          "stackName"
        ])
        and .accountId == $account
        and .appName == $app
        and .executionRoleArn == $executionRoleArn
        and .region == "eu-west-1"
        and .stackName == $stack
    )
    and (
      .executor
      | exact_keys([
          "codeSha",
          "executionId",
          "leaseOwner",
          "repository",
          "workflowRef"
        ])
        and .codeSha == $codeSha
        and .executionId == $executionId
        and .leaseOwner == $leaseOwner
        and .repository == $repository
        and .workflowRef == $workflowRef
    )
    and (
      .recoveringLedger
      | exact_keys([
          "bucket",
          "etag",
          "key",
          "leaseUntil",
          "sha256",
          "state",
          "updatedAt",
          "versionId"
        ])
        and .bucket == $bucket
        and .key == $ledgerKey
        and .state == "RECOVERING"
        and .etag == $ledger[0].ledgerEtag
        and .leaseUntil == $ledger[0].leaseUntil
        and .sha256 == $ledger[0].ledgerSha256
        and .updatedAt == $ledger[0].updatedAt
        and .versionId == $ledger[0].ledgerVersionId
    )
    and ((.completedAt | fromdateiso8601) <= .recoveringLedger.leaseUntil)
    and (
      .archive
      | exact_keys(["bucket", "key", "sha256", "versionId"])
        and .bucket == $bucket
        and .bucket == $ledger[0].archiveBucket
        and .key == (
          "candidates/recovery/" + $environment + "/" + $intent + ".tar"
        )
        and .key == $ledger[0].archiveKey
        and .sha256 == $ledger[0].archiveSha256
        and (.sha256 | sha256)
        and .versionId == $ledger[0].archiveVersionId
        and (.versionId | nonblank)
    )
    and (
      .proofs
      | exact_keys(["alias", "frontend", "live", "s3AccessLogging", "stack"])
    )
    and (.proofs.s3AccessLogging | valid_logging)
    and (
      (
        .stackState == "greenfield"
        and .proofs.s3AccessLogging.priorState == "absent"
        and (
          .proofs.stack
          | exact_keys([
              "absence",
              "cleanup",
              "ok",
              "retainedResources",
              "stackName",
              "state"
            ])
            and .ok == true
            and .stackName == $stack
            and .state == "absent"
            and .retainedResources == "absent"
            and (
              .absence
              | exact_keys([
                  "bucket",
                  "lambdaLog",
                  "legacyApiLog",
                  "stack",
                  "vendedApiLog"
                ])
                and all(.[]; . == true)
            )
            and (
              .cleanup
              | exact_keys([
                  "ok",
                  "retainedBucketDeleted",
                  "retainedLogGroupsDeleted",
                  "schema",
                  "stack",
                  "stackDeleted",
                  "stackId",
                  "state",
                  "version"
                ])
                and .ok == true
                and .schema == "archon.greenfield-cleanup.proof"
                and .version == 1
                and .stack == $stack
                and (
                  .state == "greenfield-cleaned"
                  or .state == "greenfield-stack-absent"
                )
                and (.stackDeleted | type == "boolean")
                and (.retainedBucketDeleted | type == "boolean")
                and (
                  .retainedLogGroupsDeleted
                  | type == "number"
                    and . >= 0
                    and . <= 3
                    and floor == .
                )
                and (
                  .stackId == null
                  or (
                    .stackId
                    | type == "string"
                      and startswith(
                        "arn:aws:cloudformation:eu-west-1:" + $account +
                        ":stack/" + $stack + "/"
                      )
                  )
                )
            )
        )
        and (.proofs.frontend | not_applicable)
        and (.proofs.alias | not_applicable)
        and (.proofs.live | not_applicable)
      )
      or
      (
        .stackState == "existing"
        and (
          .proofs.s3AccessLogging.priorState == "disabled"
          or .proofs.s3AccessLogging.priorState == "enabled"
        )
        and (
          .proofs.stack
          | exact_keys([
              "ok",
              "parametersSha256",
              "stackId",
              "stackRevision",
              "state",
              "tagsSha256",
              "templateSha256"
            ])
            and .ok == true
            and .state == "restored"
            and .stackId == $manifest[0].stackId
            and (.stackRevision | iso8601_timestamp)
            and .templateSha256 == $manifest[0].templateSha256
            and .parametersSha256 == $manifest[0].parametersSha256
            and .tagsSha256 == $manifest[0].tagsSha256
        )
        and (
          (
            $frontendPrestate[0].hadPreviousIndex == true
            and (
              .proofs.frontend
              | exact_keys([
                  "hadPreviousIndex",
                  "ok",
                  "restoredVersionId",
                  "sha256",
                  "state"
                ])
                and .ok == true
                and .state == "restored"
                and .hadPreviousIndex == true
                and .sha256 == $frontendPrestate[0].previousIndexSha256
                and (.sha256 | sha256)
                and (.restoredVersionId | nonblank)
            )
          )
          or
          (
            $frontendPrestate[0].hadPreviousIndex == false
            and (
              .proofs.frontend
              | exact_keys(["hadPreviousIndex", "ok", "state"])
                and .ok == true
                and .state == "absent"
                and .hadPreviousIndex == false
            )
          )
        )
        and (
          .proofs.alias
          | exact_keys(["AliasArn", "FunctionVersion", "Name", "RoutingConfig"])
            and .AliasArn == (
              "arn:aws:lambda:eu-west-1:" + $account + ":function:" +
              $manifest[0].functionName + ":live"
            )
            and .Name == "live"
            and .FunctionVersion == $manifest[0].functionVersion
            and ((.RoutingConfig.AdditionalVersionWeights // {}) == {})
        )
        and (
          .proofs.live
          | exact_keys(["applicationUrl", "health", "memory", "ok"])
            and .ok == true
            and .applicationUrl == $manifest[0].applicationUrl
            and (
              .health
              | exact_keys(["ok", "status"])
                and .ok == true
                and .status == "reachable"
            )
            and (
              .memory
              | exact_keys(["persisted", "storeVerified"])
                and .storeVerified == true
                and .persisted == 9
            )
        )
      )
    )
  ' "$receipt_file" >/dev/null

jq -n \
  --arg environment "$RECOVERY_ENVIRONMENT" \
  --arg intentId "$RECOVERY_INTENT_ID" \
  --arg receiptSha256 "$receipt_sha256" \
  '{
    ok: true,
    schema: "archon.durable-recovery-receipt.validation",
    version: 1,
    environment: $environment,
    intentId: $intentId,
    receiptSha256: $receiptSha256
  }'
