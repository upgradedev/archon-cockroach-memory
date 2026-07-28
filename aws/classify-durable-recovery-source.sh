#!/usr/bin/env bash
# Classify the exact Deploy AWS run/attempt bound by an environment ledger.
# This script is read-only: it never claims or mutates the recovery intent.
set -euo pipefail

for name in \
  APP_NAME \
  AWS_ACCOUNT_ID \
  AWS_REGION \
  GH_TOKEN \
  GITHUB_REPOSITORY \
  RECOVERY_ENVIRONMENT \
  TERMINAL_JOB_NAME; do
  if [ -z "${!name:-}" ]; then
    echo "$name is required to classify durable recovery." >&2
    exit 1
  fi
done
test "$GITHUB_REPOSITORY" = "upgradedev/archon-cockroach-memory"
case "$RECOVERY_ENVIRONMENT:$TERMINAL_JOB_NAME" in
  "staging:Deploy and smoke staging"|"production:Promote identical candidate to production") ;;
  *) exit 1 ;;
esac

ledger_file="$(mktemp)"
run_file="$(mktemp)"
jobs_file="$(mktemp)"
owner_run_file="$(mktemp)"
cleanup_classifier() {
  rm -f -- "$ledger_file" "$run_file" "$jobs_file" "$owner_run_file"
}
trap cleanup_classifier EXIT

bash aws/recovery-intent-ledger.sh read >"$ledger_file"
state="$(jq -r '.state // "absent"' "$ledger_file")"
case "$state" in
  absent|COMMITTED|RECOVERED)
    jq -n \
      --arg environment "$RECOVERY_ENVIRONMENT" \
      --arg state "$state" \
      '{
        ok: true,
        schema: "archon.durable-recovery.classification",
        version: 1,
        action: "noop",
        reason: "terminal-or-absent",
        environment: $environment,
        ledgerState: $state
      }'
    exit 0
    ;;
  ARMED|RECOVERING) ;;
  *)
    echo "The recovery ledger state is invalid." >&2
    exit 1
    ;;
esac

intent_id="$(jq -er '.intentId | select(test("^[0-9a-f]{64}$"))' "$ledger_file")"
previous_lease_owner=""
previous_owner_proved_dead=false
if [ "$state" = "RECOVERING" ]; then
  lease_until="$(jq -er '.leaseUntil | numbers' "$ledger_file")"
  lease_owner="$(jq -er '.leaseOwner | strings | select(length > 0)' "$ledger_file")"
  now="$(date +%s)"
  if [ "$lease_until" -ge "$now" ] &&
     [ "$lease_owner" != "${RECOVERY_LEASE_OWNER:-}" ]; then
    if [[ "$lease_owner" =~ ^watchdog-([0-9]+)-([1-9][0-9]*)-(staging|production)$ ]] &&
       [ "${BASH_REMATCH[3]}" = "$RECOVERY_ENVIRONMENT" ]; then
      owner_run_id="${BASH_REMATCH[1]}"
      owner_run_attempt="${BASH_REMATCH[2]}"
    else
      echo "The active recovery lease owner is not workflow-bound." >&2
      exit 1
    fi
    gh api \
      "repos/${GITHUB_REPOSITORY}/actions/runs/${owner_run_id}/attempts/${owner_run_attempt}" \
      >"$owner_run_file"
    jq -e \
      --arg repository "$GITHUB_REPOSITORY" \
      --argjson attempt "$owner_run_attempt" \
      --argjson runId "$owner_run_id" \
      '
        .id == $runId
        and .run_attempt == $attempt
        and (
          .workflow_id
          | type == "number" and . > 0 and floor == .
        )
        and .name == "Recover AWS"
        and (
          .path == ".github/workflows/recover-aws.yml"
          or .path == ".github/workflows/recover-aws.yml@main"
          or .path == ".github/workflows/recover-aws.yml@refs/heads/main"
        )
        and (
          .event == "workflow_run"
          or .event == "schedule"
          or .event == "workflow_dispatch"
        )
        and .head_branch == "main"
        and .head_repository.full_name == $repository
        and .repository.full_name == $repository
      ' "$owner_run_file" >/dev/null
    owner_status="$(jq -er '.status' "$owner_run_file")"
    if [ "$owner_status" != "completed" ]; then
      case "$owner_status" in
        queued|in_progress|pending|waiting|requested) ;;
        *)
          echo "The recovery lease owner run state is invalid." >&2
          exit 1
          ;;
      esac
      jq -n \
        --arg environment "$RECOVERY_ENVIRONMENT" \
        --arg intentId "$intent_id" \
        '{
          ok: true,
          schema: "archon.durable-recovery.classification",
          version: 1,
          action: "noop",
          reason: "active-recovery-lease",
          environment: $environment,
          intentId: $intentId,
          ledgerState: "RECOVERING"
        }'
      exit 0
    fi
    owner_conclusion="$(jq -er '.conclusion' "$owner_run_file")"
    case "$owner_conclusion" in
      failure|cancelled|timed_out|action_required|startup_failure|stale)
        previous_lease_owner="$lease_owner"
        previous_owner_proved_dead=true
        ;;
      success)
        echo "A successful recovery run cannot retain an active lease." >&2
        exit 1
        ;;
      *)
        echo "The completed recovery lease owner is not reclaimable." >&2
        exit 1
        ;;
    esac
  fi
fi

source_run_id="$(jq -er '.sourceRunId | select(test("^[0-9]+$"))' "$ledger_file")"
source_run_attempt="$(
  jq -er '.sourceRunAttempt | select(test("^[1-9][0-9]*$"))' \
    "$ledger_file"
)"
candidate_sha="$(
  jq -er '.candidateSha | select(test("^[0-9a-f]{40}$"))' "$ledger_file"
)"

gh api \
  "repos/${GITHUB_REPOSITORY}/actions/runs/${source_run_id}/attempts/${source_run_attempt}" \
  >"$run_file"
jq -e \
  --arg candidate "$candidate_sha" \
  --arg repository "$GITHUB_REPOSITORY" \
  --argjson attempt "$source_run_attempt" \
  --argjson runId "$source_run_id" \
  '
    .id == $runId
    and .run_attempt == $attempt
    and (
      .workflow_id
      | type == "number" and . > 0 and floor == .
    )
    and .name == "Deploy AWS"
    and (
      .path == ".github/workflows/deploy-aws.yml"
      or .path == ".github/workflows/deploy-aws.yml@main"
      or .path == ".github/workflows/deploy-aws.yml@refs/heads/main"
    )
    and .event == "workflow_run"
    and .head_branch == "main"
    and .head_sha == $candidate
    and .head_repository.full_name == $repository
    and .repository.full_name == $repository
  ' "$run_file" >/dev/null

run_status="$(jq -er '.status' "$run_file")"
if [ "$run_status" != "completed" ]; then
  jq -n \
    --arg environment "$RECOVERY_ENVIRONMENT" \
    --arg intentId "$intent_id" \
    '{
      ok: true,
      schema: "archon.durable-recovery.classification",
      version: 1,
      action: "noop",
      reason: "source-run-active",
      environment: $environment,
      intentId: $intentId
    }'
  exit 0
fi
run_conclusion="$(jq -er '.conclusion' "$run_file")"
case "$run_conclusion" in
  failure|cancelled|timed_out|action_required|startup_failure|stale) ;;
  success)
    echo "A successful Deploy AWS run cannot retain an unresolved intent." >&2
    exit 1
    ;;
  *)
    echo "The completed Deploy AWS conclusion is not recoverable." >&2
    exit 1
    ;;
esac

gh api \
  "repos/${GITHUB_REPOSITORY}/actions/runs/${source_run_id}/attempts/${source_run_attempt}/jobs?per_page=100" \
  >"$jobs_file"
job_count="$(
  jq -r \
    --arg name "$TERMINAL_JOB_NAME" \
    '[.jobs[] | select(.name == $name)] | length' \
    "$jobs_file"
)"
test "$job_count" -eq 1
job_status="$(
  jq -er \
    --arg name "$TERMINAL_JOB_NAME" \
    '.jobs[] | select(.name == $name) | .status' \
    "$jobs_file"
)"
job_conclusion="$(
  jq -er \
    --arg name "$TERMINAL_JOB_NAME" \
    '.jobs[] | select(.name == $name) | .conclusion' \
    "$jobs_file"
)"
test "$job_status" = "completed"
case "$job_conclusion" in
  failure|cancelled|timed_out|action_required|startup_failure|stale) ;;
  success)
    echo "A successful environment job cannot retain an unresolved intent." >&2
    exit 1
    ;;
  *)
    echo "The environment job conclusion is not recoverable." >&2
    exit 1
    ;;
esac

jq -n \
  --arg candidateSha "$candidate_sha" \
  --arg environment "$RECOVERY_ENVIRONMENT" \
  --arg intentId "$intent_id" \
  --arg jobConclusion "$job_conclusion" \
  --arg previousLeaseOwner "$previous_lease_owner" \
  --arg sourceRunAttempt "$source_run_attempt" \
  --arg sourceRunId "$source_run_id" \
  --argjson previousOwnerProvedDead "$previous_owner_proved_dead" \
  '{
    ok: true,
    schema: "archon.durable-recovery.classification",
    version: 1,
    action: "recover",
    reason: "nonterminal-environment-job",
    environment: $environment,
    intentId: $intentId,
    candidateSha: $candidateSha,
    sourceRunId: $sourceRunId,
    sourceRunAttempt: $sourceRunAttempt,
    jobConclusion: $jobConclusion,
    previousLeaseOwner: (
      if $previousLeaseOwner == "" then null else $previousLeaseOwner end
    ),
    previousOwnerProvedDead: $previousOwnerProvedDead
  }'
