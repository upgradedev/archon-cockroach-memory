#!/usr/bin/env bash
# Classify durable-recovery candidates from GitHub metadata only.
# This preflight must never obtain AWS credentials or read/mutate the S3 ledger.
set -euo pipefail

for name in GH_TOKEN GITHUB_REPOSITORY; do
  if [ -z "${!name:-}" ]; then
    echo "$name is required for the GitHub recovery preflight." >&2
    exit 1
  fi
done
test "$GITHUB_REPOSITORY" = "upgradedev/archon-cockroach-memory"

readonly DEPLOY_WORKFLOW="deploy-aws.yml"
readonly MAX_DEPLOY_PAGES=10
readonly MAX_ARTIFACT_PAGES=10
readonly PAGE_SIZE=100
readonly STAGING_JOB="Deploy and smoke staging"
readonly PRODUCTION_JOB="Promote identical candidate to production"
readonly STAGING_ARM="Persist and arm the immutable staging recovery intent"
readonly PRODUCTION_ARM="Persist and arm the immutable production recovery intent"
readonly STAGING_COMMIT="Commit the receipt-bound staging recovery intent"
readonly PRODUCTION_COMMIT="Commit the receipt-bound production recovery intent"

work_dir="$(mktemp -d)"
cleanup_preflight() {
  rm -rf -- "$work_dir"
}
trap cleanup_preflight EXIT

die() {
  echo "$1" >&2
  exit 1
}

is_active_status() {
  case "$1" in
    queued|in_progress|pending|waiting|requested) return 0 ;;
    *) return 1 ;;
  esac
}

is_recoverable_conclusion() {
  case "$1" in
    failure|cancelled|timed_out|action_required|startup_failure|stale)
      return 0
      ;;
    *) return 1 ;;
  esac
}

validate_deploy_run() {
  local file="$1"
  local run_id="$2"
  local run_attempt="$3"
  jq -e \
    --arg repository "$GITHUB_REPOSITORY" \
    --argjson attempt "$run_attempt" \
    --argjson runId "$run_id" \
    '
      .id == $runId
      and .run_attempt == $attempt
      and (.workflow_id | type == "number" and . > 0 and floor == .)
      and .name == "Deploy AWS"
      and (
        .path == ".github/workflows/deploy-aws.yml"
        or .path == ".github/workflows/deploy-aws.yml@main"
        or .path == ".github/workflows/deploy-aws.yml@refs/heads/main"
      )
      and (
        .event == "push"
        or .event == "workflow_dispatch"
        or .event == "workflow_run"
      )
      and .head_branch == "main"
      and (.head_sha | type == "string" and test("^[0-9a-f]{40}$"))
      and .head_repository.full_name == $repository
      and .repository.full_name == $repository
      and (
        .status == "completed"
        or .status == "queued"
        or .status == "in_progress"
        or .status == "pending"
        or .status == "waiting"
        or .status == "requested"
      )
    ' "$file" >/dev/null
}

validate_recovery_run() {
  local file="$1"
  local run_id="$2"
  local run_attempt="$3"
  jq -e \
    --arg repository "$GITHUB_REPOSITORY" \
    --argjson attempt "$run_attempt" \
    --argjson runId "$run_id" \
    '
      .id == $runId
      and .run_attempt == $attempt
      and (.workflow_id | type == "number" and . > 0 and floor == .)
      and .name == "Recover AWS"
      and (
        .path == ".github/workflows/recover-aws.yml"
        or .path == ".github/workflows/recover-aws.yml@main"
        or .path == ".github/workflows/recover-aws.yml@refs/heads/main"
      )
      and (
        .event == "schedule"
        or .event == "workflow_dispatch"
        or .event == "workflow_run"
      )
      and .head_branch == "main"
      and .head_repository.full_name == $repository
      and .repository.full_name == $repository
      and .status == "completed"
      and .conclusion == "success"
    ' "$file" >/dev/null
}

has_verified_recovery_artifact() {
  local environment="$1"
  local source_run_id="$2"
  local source_run_attempt="$3"
  local prefix
  local page
  local artifact_page
  local artifact_count
  local artifact_id
  local artifact_name
  local artifact_workflow_run_id
  local artifact_total
  local expected_artifact_count
  local expected_artifact_total
  local page_offset
  local recovery_run_id
  local recovery_run_attempt
  local recovery_run_file
  local seen_artifacts

  prefix="${environment}-recovery-receipt-${source_run_id}-${source_run_attempt}-"
  expected_artifact_total=""
  seen_artifacts="$work_dir/artifact-ids-${environment}-${source_run_id}-${source_run_attempt}.txt"
  : >"$seen_artifacts"
  page=1
  while [ "$page" -le "$MAX_ARTIFACT_PAGES" ]; do
    artifact_page="$work_dir/artifacts-${environment}-${source_run_id}-${source_run_attempt}-${page}.json"
    gh api \
      "repos/${GITHUB_REPOSITORY}/actions/artifacts?per_page=${PAGE_SIZE}&page=${page}" \
      >"$artifact_page"
    jq -e '
      (.total_count | type == "number" and . >= 0 and floor == .)
      and (.artifacts | type == "array")
      and all(.artifacts[];
        (.id | type == "number" and . > 0 and floor == .)
        and (.name | type == "string" and length > 0)
        and (.expired | type == "boolean")
      )
    ' "$artifact_page" >/dev/null ||
      die "The recovery artifact response is invalid."

    artifact_total="$(jq -er '.total_count' "$artifact_page")"
    if [ -z "$expected_artifact_total" ]; then
      expected_artifact_total="$artifact_total"
    else
      test "$artifact_total" -eq "$expected_artifact_total" ||
        die "The recovery artifact inventory changed during pagination."
    fi
    page_offset=$(((page - 1) * PAGE_SIZE))
    if [ "$artifact_total" -le "$page_offset" ]; then
      expected_artifact_count=0
    elif [ "$((artifact_total - page_offset))" -lt "$PAGE_SIZE" ]; then
      expected_artifact_count=$((artifact_total - page_offset))
    else
      expected_artifact_count=$PAGE_SIZE
    fi
    artifact_count="$(jq -er '.artifacts | length' "$artifact_page")"
    test "$artifact_count" -eq "$expected_artifact_count" ||
      die "The recovery artifact response is incomplete or ambiguous."
    while IFS= read -r artifact_id; do
      [ -n "$artifact_id" ] || continue
      if grep -Fxq -- "$artifact_id" "$seen_artifacts"; then
        die "The recovery artifact inventory contains duplicate pages."
      fi
      printf '%s\n' "$artifact_id" >>"$seen_artifacts"
    done < <(jq -r '.artifacts[] | .id | tostring' "$artifact_page")

    while IFS=$'\t' read -r \
      artifact_id artifact_name artifact_workflow_run_id; do
      [ -n "$artifact_id" ] || continue
      if [[ ! "$artifact_name" =~ ^${prefix}([1-9][0-9]*)-([1-9][0-9]*)$ ]]; then
        die "A recovery artifact prefix matched an invalid identity."
      fi
      recovery_run_id="${BASH_REMATCH[1]}"
      recovery_run_attempt="${BASH_REMATCH[2]}"
      test "$artifact_workflow_run_id" = "$recovery_run_id" ||
        die "A recovery artifact is not bound to its workflow run."
      recovery_run_file="$work_dir/recovery-run-${recovery_run_id}-${recovery_run_attempt}.json"
      gh api \
        "repos/${GITHUB_REPOSITORY}/actions/runs/${recovery_run_id}/attempts/${recovery_run_attempt}" \
        >"$recovery_run_file"
      validate_recovery_run \
        "$recovery_run_file" "$recovery_run_id" "$recovery_run_attempt" ||
        die "A recovery artifact is not bound to a successful trusted run."
      return 0
    done < <(
      jq -r \
        --arg prefix "$prefix" '
          .artifacts[]
          | select(.expired == false and (.name | startswith($prefix)))
          | [
              (.id | tostring),
              .name,
              (.workflow_run.id | tostring)
            ]
          | @tsv
        ' "$artifact_page"
    )

    if [ "$((page_offset + artifact_count))" -ge "$artifact_total" ]; then
      return 1
    fi
    page=$((page + 1))
  done
  die "Recovery artifact history exceeded the bounded preflight window."
}

declare -A action=(
  [staging]="searching"
  [production]="searching"
)
declare -A reason=(
  [staging]=""
  [production]=""
)
declare -A source_run_id=(
  [staging]=""
  [production]=""
)
declare -A source_run_attempt=(
  [staging]=""
  [production]=""
)
declare -A candidate_sha=(
  [staging]=""
  [production]=""
)

emit_result() {
  jq -n \
    --arg productionAction "${action[production]}" \
    --arg productionCandidateSha "${candidate_sha[production]}" \
    --arg productionReason "${reason[production]}" \
    --arg productionSourceRunAttempt "${source_run_attempt[production]}" \
    --arg productionSourceRunId "${source_run_id[production]}" \
    --arg stagingAction "${action[staging]}" \
    --arg stagingCandidateSha "${candidate_sha[staging]}" \
    --arg stagingReason "${reason[staging]}" \
    --arg stagingSourceRunAttempt "${source_run_attempt[staging]}" \
    --arg stagingSourceRunId "${source_run_id[staging]}" '
      def nullable($value): if $value == "" then null else $value end;
      {
        ok: true,
        schema: "archon.github-recovery-preflight",
        version: 1,
        classificationSource: "github-actions-metadata-only",
        awsCredentialsUsed: false,
        environments: {
          staging: {
            action: $stagingAction,
            reason: $stagingReason,
            sourceRunId: nullable($stagingSourceRunId),
            sourceRunAttempt: nullable($stagingSourceRunAttempt),
            candidateSha: nullable($stagingCandidateSha)
          },
          production: {
            action: $productionAction,
            reason: $productionReason,
            sourceRunId: nullable($productionSourceRunId),
            sourceRunAttempt: nullable($productionSourceRunAttempt),
            candidateSha: nullable($productionCandidateSha)
          }
        }
      }
    '
}

mark_noop() {
  local environment="$1"
  local noop_reason="$2"
  action["$environment"]="noop"
  reason["$environment"]="$noop_reason"
}

mark_recover() {
  local environment="$1"
  local run_id="$2"
  local run_attempt="$3"
  local sha="$4"
  action["$environment"]="recover"
  reason["$environment"]="uncommitted-armed-environment-job"
  source_run_id["$environment"]="$run_id"
  source_run_attempt["$environment"]="$run_attempt"
  candidate_sha["$environment"]="$sha"
}

classify_environment_job() {
  local environment="$1"
  local jobs_file="$2"
  local run_id="$3"
  local run_attempt="$4"
  local sha="$5"
  local terminal_job_name
  local arm_step_name
  local commit_step_name
  local job_count
  local job_conclusion
  local arm_count
  local commit_count
  local arm_conclusion
  local commit_conclusion

  [ "${action[$environment]}" = "searching" ] || return 0
  case "$environment" in
    staging)
      terminal_job_name="$STAGING_JOB"
      arm_step_name="$STAGING_ARM"
      commit_step_name="$STAGING_COMMIT"
      ;;
    production)
      terminal_job_name="$PRODUCTION_JOB"
      arm_step_name="$PRODUCTION_ARM"
      commit_step_name="$PRODUCTION_COMMIT"
      ;;
    *) die "The preflight environment is invalid." ;;
  esac

  job_count="$(
    jq -r \
      --arg name "$terminal_job_name" \
      '[.jobs[] | select(.name == $name)] | length' \
      "$jobs_file"
  )"
  if [ "$job_count" -eq 0 ]; then
    return 0
  fi
  test "$job_count" -eq 1 ||
    die "The trusted deploy run has duplicate terminal jobs."

  job_conclusion="$(
    jq -er \
      --arg name "$terminal_job_name" \
      '.jobs[] | select(.name == $name) | .conclusion | strings' \
      "$jobs_file"
  )"
  arm_count="$(
    jq -r \
      --arg job "$terminal_job_name" \
      --arg step "$arm_step_name" '
        [.jobs[] | select(.name == $job) | .steps[]?
         | select(.name == $step)] | length
      ' "$jobs_file"
  )"
  commit_count="$(
    jq -r \
      --arg job "$terminal_job_name" \
      --arg step "$commit_step_name" '
        [.jobs[] | select(.name == $job) | .steps[]?
         | select(.name == $step)] | length
      ' "$jobs_file"
  )"
  test "$arm_count" -le 1 || die "The durable arm step is ambiguous."
  test "$commit_count" -le 1 || die "The durable commit step is ambiguous."

  arm_conclusion=""
  commit_conclusion=""
  if [ "$arm_count" -eq 1 ]; then
    arm_conclusion="$(
      jq -r \
        --arg job "$terminal_job_name" \
        --arg step "$arm_step_name" '
          .jobs[] | select(.name == $job) | .steps[]
          | select(.name == $step) | .conclusion // ""
        ' "$jobs_file"
    )"
  fi
  if [ "$commit_count" -eq 1 ]; then
    commit_conclusion="$(
      jq -r \
        --arg job "$terminal_job_name" \
        --arg step "$commit_step_name" '
          .jobs[] | select(.name == $job) | .steps[]
          | select(.name == $step) | .conclusion // ""
        ' "$jobs_file"
    )"
  fi

  if [ "$commit_conclusion" = "success" ]; then
    test "$arm_conclusion" = "success" ||
      die "A durable commit succeeded without a proved arm step."
    mark_noop "$environment" "terminal-commit-proved"
    return 0
  fi
  if [ "$arm_conclusion" != "success" ]; then
    return 0
  fi
  is_recoverable_conclusion "$job_conclusion" ||
    die "An armed uncommitted environment job is not recoverable."
  if has_verified_recovery_artifact \
    "$environment" "$run_id" "$run_attempt"; then
    mark_noop "$environment" "successful-recovery-receipt-proved"
    return 0
  fi
  mark_recover "$environment" "$run_id" "$run_attempt" "$sha"
}

expected_run_total=""
seen_runs="$work_dir/deploy-run-ids.txt"
: >"$seen_runs"
page=1
history_exhausted=false
while [ "$page" -le "$MAX_DEPLOY_PAGES" ]; do
  runs_page="$work_dir/deploy-runs-${page}.json"
  gh api \
    "repos/${GITHUB_REPOSITORY}/actions/workflows/${DEPLOY_WORKFLOW}/runs?branch=main&per_page=${PAGE_SIZE}&page=${page}" \
    >"$runs_page"
  jq -e \
    --arg repository "$GITHUB_REPOSITORY" '
      (.total_count | type == "number" and . >= 0 and floor == .)
      and (.workflow_runs | type == "array")
      and all(.workflow_runs[];
        (.id | type == "number" and . > 0 and floor == .)
        and (.run_attempt | type == "number" and . > 0 and floor == .)
        and .name == "Deploy AWS"
        and (
          .path == ".github/workflows/deploy-aws.yml"
          or .path == ".github/workflows/deploy-aws.yml@main"
          or .path == ".github/workflows/deploy-aws.yml@refs/heads/main"
        )
        and (
          .event == "push"
          or .event == "workflow_dispatch"
          or .event == "workflow_run"
        )
        and .head_branch == "main"
        and (.head_sha | type == "string" and test("^[0-9a-f]{40}$"))
        and .head_repository.full_name == $repository
        and .repository.full_name == $repository
      )
    ' "$runs_page" >/dev/null ||
      die "The Deploy AWS workflow-runs response is invalid."

  run_total="$(jq -er '.total_count' "$runs_page")"
  if [ -z "$expected_run_total" ]; then
    expected_run_total="$run_total"
  else
    test "$run_total" -eq "$expected_run_total" ||
      die "Deploy AWS history changed during pagination."
  fi
  page_offset=$(((page - 1) * PAGE_SIZE))
  if [ "$run_total" -le "$page_offset" ]; then
    expected_run_count=0
  elif [ "$((run_total - page_offset))" -lt "$PAGE_SIZE" ]; then
    expected_run_count=$((run_total - page_offset))
  else
    expected_run_count=$PAGE_SIZE
  fi
  run_count="$(jq -er '.workflow_runs | length' "$runs_page")"
  test "$run_count" -eq "$expected_run_count" ||
    die "The Deploy AWS workflow-runs response is incomplete or ambiguous."
  while IFS= read -r listed_run_id; do
    [ -n "$listed_run_id" ] || continue
    if grep -Fxq -- "$listed_run_id" "$seen_runs"; then
      die "Deploy AWS history contains duplicate pages."
    fi
    printf '%s\n' "$listed_run_id" >>"$seen_runs"
  done < <(jq -r '.workflow_runs[] | .id | tostring' "$runs_page")

  while IFS=$'\t' read -r run_id latest_attempt listed_status; do
    [ -n "$run_id" ] || continue
    if is_active_status "$listed_status"; then
      mark_noop staging "source-deploy-active"
      mark_noop production "source-deploy-active"
      emit_result
      exit 0
    fi
    test "$listed_status" = "completed" ||
      die "The Deploy AWS run status is invalid."

    attempt="$latest_attempt"
    while [ "$attempt" -ge 1 ]; do
      run_file="$work_dir/deploy-run-${run_id}-${attempt}.json"
      gh api \
        "repos/${GITHUB_REPOSITORY}/actions/runs/${run_id}/attempts/${attempt}" \
        >"$run_file"
      validate_deploy_run "$run_file" "$run_id" "$attempt" ||
        die "The Deploy AWS attempt identity is invalid."
      run_status="$(jq -er '.status' "$run_file")"
      if is_active_status "$run_status"; then
        mark_noop staging "source-deploy-active"
        mark_noop production "source-deploy-active"
        emit_result
        exit 0
      fi
      test "$run_status" = "completed" ||
        die "The Deploy AWS attempt status is invalid."
      run_conclusion="$(jq -er '.conclusion | strings' "$run_file")"
      if [ "$run_conclusion" != "success" ] &&
         ! is_recoverable_conclusion "$run_conclusion"; then
        die "The completed Deploy AWS conclusion is ambiguous."
      fi

      jobs_file="$work_dir/deploy-jobs-${run_id}-${attempt}.json"
      gh api \
        "repos/${GITHUB_REPOSITORY}/actions/runs/${run_id}/attempts/${attempt}/jobs?per_page=${PAGE_SIZE}" \
        >"$jobs_file"
      jq -e '
        (.total_count | type == "number" and . >= 0 and floor == .)
        and (.jobs | type == "array")
        and .total_count == (.jobs | length)
        and .total_count <= 100
        and all(.jobs[];
          (.id | type == "number" and . > 0 and floor == .)
          and (.name | type == "string" and length > 0)
          and .status == "completed"
          and (.conclusion | type == "string" and length > 0)
          and ((.steps // []) | type == "array")
        )
      ' "$jobs_file" >/dev/null ||
        die "The Deploy AWS jobs response is incomplete or ambiguous."

      sha="$(jq -er '.head_sha' "$run_file")"
      run_event="$(jq -er '.event' "$run_file")"
      classify_environment_job staging \
        "$jobs_file" "$run_id" "$attempt" "$sha"
      if [ "$run_event" != "workflow_dispatch" ]; then
        classify_environment_job production \
          "$jobs_file" "$run_id" "$attempt" "$sha"
      fi
      if [ "${action[staging]}" != "searching" ] &&
         [ "${action[production]}" != "searching" ]; then
        emit_result
        exit 0
      fi
      attempt=$((attempt - 1))
    done
  done < <(
    jq -r '
      .workflow_runs[]
      | [(.id | tostring), (.run_attempt | tostring), .status]
      | @tsv
    ' "$runs_page"
  )

  if [ "$((page_offset + run_count))" -ge "$run_total" ]; then
    history_exhausted=true
    break
  fi
  page=$((page + 1))
done

[ "$history_exhausted" = "true" ] ||
  die "Deploy AWS history exceeded the bounded preflight window."
for environment in staging production; do
  if [ "${action[$environment]}" = "searching" ]; then
    mark_noop "$environment" "no-github-recovery-candidate"
  fi
done
emit_result
