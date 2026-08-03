#!/usr/bin/env bash
set -euo pipefail

for name in \
  EXPECTED_SHA \
  EXPECTED_FOUNDATION_RUN_ID \
  EXPECTED_FOUNDATION_RUN_ATTEMPT \
  EXPECTED_STAGING_EDGE_RUN_ID \
  EXPECTED_STAGING_EDGE_RUN_ATTEMPT \
  EXPECTED_PRODUCTION_EDGE_RUN_ID \
  EXPECTED_PRODUCTION_EDGE_RUN_ATTEMPT \
  FENCE_ENVIRONMENT \
  FENCE_JOB_ID \
  FENCE_MUTEX_GROUP \
  GH_TOKEN \
  GITHUB_REPOSITORY \
  GITHUB_RUN_ATTEMPT \
  GITHUB_RUN_ID; do
  if [ -z "${!name:-}" ]; then
    echo "$name is required." >&2
    exit 1
  fi
done

[[ "$EXPECTED_SHA" =~ ^[0-9a-f]{40}$ ]]
test "$GITHUB_REPOSITORY" = "upgradedev/archon-cockroach-memory"
test "$FENCE_MUTEX_GROUP" = "aws-shared-control-plane-mutation"
case "$FENCE_ENVIRONMENT:$FENCE_JOB_ID" in
  staging:deploy-staging|production:deploy-production) ;;
  *)
    echo "Fence environment/job binding is invalid." >&2
    exit 1
    ;;
esac
for value in \
  "$GITHUB_RUN_ID" \
  "$GITHUB_RUN_ATTEMPT" \
  "$EXPECTED_FOUNDATION_RUN_ID" \
  "$EXPECTED_FOUNDATION_RUN_ATTEMPT" \
  "$EXPECTED_STAGING_EDGE_RUN_ID" \
  "$EXPECTED_STAGING_EDGE_RUN_ATTEMPT" \
  "$EXPECTED_PRODUCTION_EDGE_RUN_ID" \
  "$EXPECTED_PRODUCTION_EDGE_RUN_ATTEMPT"; do
  [[ "$value" =~ ^[1-9][0-9]*$ ]]
done

latest_foundation="$({
  gh api \
    --paginate \
    --slurp \
    "repos/$GITHUB_REPOSITORY/actions/workflows/foundation-migration.yml/runs?per_page=100"
} | jq -er \
  '
    [
      .[].workflow_runs[]
      | select(
          (.head_sha | test("^[0-9a-f]{40}$"))
          and .head_branch == "main"
          and .event == "workflow_dispatch"
          and .name == "Foundation Storage Migration"
          and .path == ".github/workflows/foundation-migration.yml"
          and (
            .head_sha as $head
            | .display_title == ("Foundation plan " + $head)
            or .display_title == ("Foundation apply " + $head)
            or .display_title == ("Foundation verify " + $head)
            or .display_title == ("Foundation abort " + $head)
            or .display_title == ("Foundation retire " + $head)
          )
        )
      | . + {evidenceOperation:(.display_title | split(" ")[1])}
    ]
    | sort_by(.updated_at, .run_number, .run_attempt)
    | last
    | select(. != null)
    | [
        .id,
        .run_attempt,
        (.conclusion // "pending"),
        .evidenceOperation,
        .head_sha
      ]
    | @tsv
  ')"
IFS=$'\t' read -r foundation_id foundation_attempt foundation_conclusion \
  foundation_operation foundation_sha <<<"$latest_foundation"
test "$foundation_id" = "$EXPECTED_FOUNDATION_RUN_ID"
test "$foundation_attempt" = "$EXPECTED_FOUNDATION_RUN_ATTEMPT"
test "$foundation_conclusion" = "success"
test "$foundation_operation" = "verify"
test "$foundation_sha" = "$EXPECTED_SHA"

edge_runs=
STAGING_EDGE_OPERATION=
PRODUCTION_EDGE_OPERATION=
prove_edge_fence() {
  local environment expected_attempt expected_id latest
  local actual_id actual_attempt actual_sha conclusion operation
  environment="$1"
  expected_id="$2"
  expected_attempt="$3"
  case "$environment" in
    staging|production) ;;
    *) return 1 ;;
  esac
  latest="$(
    jq -er \
      --arg environment "$environment" \
      '
        [
          .[].workflow_runs[]
          | select(
              (.head_sha | test("^[0-9a-f]{40}$"))
              and .head_branch == "main"
              and .event == "workflow_dispatch"
              and .name == "Manage AWS Edge Controls"
              and .path == ".github/workflows/edge-controls.yml"
              and (
                .head_sha as $head
                |
                .display_title ==
                  ("Edge " + $environment + " plan " + $head)
                or .display_title ==
                  ("Edge " + $environment + " apply " + $head)
                or .display_title ==
                  ("Edge " + $environment + " verify " + $head)
                or .display_title ==
                  ("Edge " + $environment + " cleanup " + $head)
                or .display_title ==
                  ("Edge " + $environment + " finalize " + $head)
              )
            )
          | . + {evidenceOperation:(.display_title | split(" ")[2])}
        ]
        | sort_by(.updated_at, .run_number, .run_attempt)
        | last
        | select(. != null)
        | [
            .id,
            .run_attempt,
            (.conclusion // "pending"),
            .evidenceOperation,
            .head_sha
          ]
        | @tsv
      ' <<<"$edge_runs"
  )"
  IFS=$'\t' read -r actual_id actual_attempt conclusion operation actual_sha \
    <<<"$latest"
  test "$actual_id" = "$expected_id"
  test "$actual_attempt" = "$expected_attempt"
  test "$conclusion" = "success"
  [[ "$operation" =~ ^(apply|verify)$ ]]
  test "$actual_sha" = "$EXPECTED_SHA"
  if [ "$environment" = "staging" ]; then
    STAGING_EDGE_OPERATION="$operation"
  else
    PRODUCTION_EDGE_OPERATION="$operation"
  fi
}

edge_runs="$(
  gh api \
    --paginate \
    --slurp \
    "repos/$GITHUB_REPOSITORY/actions/workflows/edge-controls.yml/runs?per_page=100"
)"
prove_edge_fence \
  staging \
  "$EXPECTED_STAGING_EDGE_RUN_ID" \
  "$EXPECTED_STAGING_EDGE_RUN_ATTEMPT"
prove_edge_fence \
  production \
  "$EXPECTED_PRODUCTION_EDGE_RUN_ID" \
  "$EXPECTED_PRODUCTION_EDGE_RUN_ATTEMPT"
[[ "$STAGING_EDGE_OPERATION" =~ ^(apply|verify)$ ]]
[[ "$PRODUCTION_EDGE_OPERATION" =~ ^(apply|verify)$ ]]

main_ref="$(
  gh api "repos/$GITHUB_REPOSITORY/git/ref/heads/main"
)"
test "$(jq -er '.ref' <<<"$main_ref")" = "refs/heads/main"
test "$(jq -er '.object.type' <<<"$main_ref")" = "commit"
test "$(jq -er '.object.sha' <<<"$main_ref")" = "$EXPECTED_SHA"
checked_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
[[ "$checked_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]

jq -cS -n \
  --arg checkedAt "$checked_at" \
  --arg deploymentEnvironment "$FENCE_ENVIRONMENT" \
  --arg deploymentJobId "$FENCE_JOB_ID" \
  --arg deploymentRunId "$GITHUB_RUN_ID" \
  --arg deploymentRunAttempt "$GITHUB_RUN_ATTEMPT" \
  --arg mutexGroup "$FENCE_MUTEX_GROUP" \
  --arg sourceSha "$EXPECTED_SHA" \
  --arg foundationRunId "$EXPECTED_FOUNDATION_RUN_ID" \
  --arg foundationRunAttempt "$EXPECTED_FOUNDATION_RUN_ATTEMPT" \
  --arg stagingEdgeRunId "$EXPECTED_STAGING_EDGE_RUN_ID" \
  --arg stagingEdgeRunAttempt "$EXPECTED_STAGING_EDGE_RUN_ATTEMPT" \
  --arg stagingEdgeOperation "$STAGING_EDGE_OPERATION" \
  --arg productionEdgeRunId "$EXPECTED_PRODUCTION_EDGE_RUN_ID" \
  --arg productionEdgeRunAttempt \
    "$EXPECTED_PRODUCTION_EDGE_RUN_ATTEMPT" \
  --arg productionEdgeOperation "$PRODUCTION_EDGE_OPERATION" \
  '{
    schema:"archon.aws.control-plane-receipt-fence",
    schemaVersion:1,
    ok:true,
    checkedAt:$checkedAt,
    sourceSha:$sourceSha,
    mainHeadSha:$sourceSha,
    mainHeadRevalidated:true,
    mutationMutexHeldByCaller:true,
    latestEligibleRunsRevalidated:true,
    edgeSnapshotShared:true,
    mutex:{
      group:$mutexGroup,
      heldByCaller:true
    },
    deployment:{
      environment:$deploymentEnvironment,
      jobId:$deploymentJobId,
      runId:($deploymentRunId | tonumber),
      runAttempt:($deploymentRunAttempt | tonumber)
    },
    foundation:{
      runId:($foundationRunId | tonumber),
      runAttempt:($foundationRunAttempt | tonumber),
      operation:"verify"
    },
    edge:{
      staging:{
        runId:($stagingEdgeRunId | tonumber),
        runAttempt:($stagingEdgeRunAttempt | tonumber),
        operation:$stagingEdgeOperation
      },
      production:{
        runId:($productionEdgeRunId | tonumber),
        runAttempt:($productionEdgeRunAttempt | tonumber),
        operation:$productionEdgeOperation
      }
    }
  }'
