#!/usr/bin/env bash
set -euo pipefail

# Pipeline-only, read-only engineering-intensity evidence. This script does
# not estimate carbon or emissions and deliberately never reads log contents,
# application data, CockroachDB data, or Lambda environment variables.

umask 077

fail() {
  printf 'Sustainability intensity audit failed: %s\n' "$1" >&2
  exit 1
}

require_env() {
  local name="$1"
  [ -n "${!name:-}" ] || fail "required environment variable ${name} is missing"
}

for required in \
  APP_NAME \
  APPROVAL_REFERENCE_DIGEST \
  AWS_ACCOUNT_ID \
  AWS_REGION \
  AWS_SUSTAINABILITY_AUDIT_ROLE_ARN \
  COMPARISON_MODE \
  GITHUB_REF \
  GITHUB_REPOSITORY \
  GITHUB_SHA \
  GITHUB_WORKFLOW_REF \
  HOSTED_LOAD_CONTRACT_MANIFEST_PATH \
  HOSTED_LOAD_RECEIPT_PATH \
  HOSTED_LOAD_RECEIPT_SHA256 \
  HOSTED_LOAD_RUN_ATTEMPT \
  HOSTED_LOAD_RUN_ID \
  HOSTED_LOAD_SUMMARY_PATH \
  PRIMARY_PROXY \
  RECEIPT_PATH \
  RUNNER_TEMP \
  SUSTAINABILITY_OWNER_DIGEST \
  TARGET_ENVIRONMENT \
  TARGET_REDUCTION_BPS \
  TARGET_SHA; do
  require_env "$required"
done

[ "$APP_NAME" = "archon-memory" ] || fail "APP_NAME is outside the workload contract"
[[ "$AWS_ACCOUNT_ID" =~ ^[0-9]{12}$ ]] || fail "AWS_ACCOUNT_ID must be a 12-digit account id"
[ "$AWS_REGION" = "eu-west-1" ] || fail "regional application telemetry is fixed to eu-west-1"
[[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] || fail "TARGET_SHA must be an exact lowercase commit SHA"
[ "$TARGET_SHA" = "$GITHUB_SHA" ] || fail "the checked-out source does not match TARGET_SHA"
[ "$GITHUB_REPOSITORY" = "upgradedev/archon-cockroach-memory" ] || fail "repository identity is outside the audit contract"
[ "$GITHUB_REF" = "refs/heads/main" ] || fail "the audit accepts current main only"
[ "$GITHUB_WORKFLOW_REF" = \
  "upgradedev/archon-cockroach-memory/.github/workflows/sustainability-intensity-evidence.yml@refs/heads/main" ] ||
  fail "the workflow source is not the protected main workflow"
[[ "$AWS_SUSTAINABILITY_AUDIT_ROLE_ARN" =~ ^arn:aws:iam::${AWS_ACCOUNT_ID}:role/[A-Za-z0-9+=,.@_/-]{1,512}$ ]] ||
  fail "the audit role is not bound to the approved account"
[[ "$SUSTAINABILITY_OWNER_DIGEST" =~ ^[0-9a-f]{64}$ ]] || fail "the owner approval digest is invalid"
[[ "$APPROVAL_REFERENCE_DIGEST" =~ ^[0-9a-f]{64}$ ]] || fail "the approval reference digest is invalid"
[[ "$HOSTED_LOAD_RECEIPT_SHA256" =~ ^[0-9a-f]{64}$ ]] || fail "the hosted-load receipt digest is invalid"
[[ "$HOSTED_LOAD_RUN_ID" =~ ^[1-9][0-9]*$ ]] || fail "the hosted-load run id is invalid"
[[ "$HOSTED_LOAD_RUN_ATTEMPT" =~ ^[1-9][0-9]*$ ]] || fail "the hosted-load run attempt is invalid"
[[ "$TARGET_REDUCTION_BPS" =~ ^[0-9]+$ ]] || fail "the approved reduction target must be basis points"
[ "$TARGET_REDUCTION_BPS" -ge 1 ] && [ "$TARGET_REDUCTION_BPS" -le 9000 ] ||
  fail "the approved reduction target must be from 1 through 9000 basis points"

case "$TARGET_ENVIRONMENT" in
  staging|production) ;;
  *) fail "the target environment must be staging or production" ;;
esac
case "$COMPARISON_MODE" in
  baseline|compare) ;;
  *) fail "the comparison mode must be baseline or compare" ;;
esac
case "$PRIMARY_PROXY" in
  lambda-configured-gb-seconds|api-data-processed-bytes|cloudfront-transfer-bytes) ;;
  *) fail "the primary proxy is outside the approved metric set" ;;
esac

expected_receipt="${RUNNER_TEMP%/}/sustainability-intensity-receipt.json"
[ "$RECEIPT_PATH" = "$expected_receipt" ] || fail "the receipt path must be the exact runner-temporary receipt"
[ -f "$RECEIPT_PATH" ] && [ ! -L "$RECEIPT_PATH" ] || fail "the fail-closed receipt was not initialized safely"
case "$HOSTED_LOAD_RECEIPT_PATH" in
  "${RUNNER_TEMP%/}"/*/hosted-load-receipt.json) ;;
  *) fail "the hosted-load receipt escaped RUNNER_TEMP" ;;
esac
[ -f "$HOSTED_LOAD_RECEIPT_PATH" ] && [ ! -L "$HOSTED_LOAD_RECEIPT_PATH" ] ||
  fail "the hosted-load receipt is missing or is a symbolic link"
[ "$(sha256sum "$HOSTED_LOAD_RECEIPT_PATH" | awk '{print $1}')" = "$HOSTED_LOAD_RECEIPT_SHA256" ] ||
  fail "the hosted-load receipt digest does not match the approved artifact"
case "$HOSTED_LOAD_CONTRACT_MANIFEST_PATH" in
  "${RUNNER_TEMP%/}"/*/hosted-load-contract.sha256) ;;
  *) fail "the hosted-load contract manifest escaped RUNNER_TEMP" ;;
esac
[ -f "$HOSTED_LOAD_CONTRACT_MANIFEST_PATH" ] &&
  [ ! -L "$HOSTED_LOAD_CONTRACT_MANIFEST_PATH" ] ||
  fail "the hosted-load contract manifest is missing or is a symbolic link"
[ "$(wc -l <"$HOSTED_LOAD_CONTRACT_MANIFEST_PATH")" -eq 2 ] ||
  fail "the hosted-load contract manifest has an unexpected source count"
[ "$(awk 'NR == 1 {print $2}' "$HOSTED_LOAD_CONTRACT_MANIFEST_PATH")" = \
  "load/hosted-recall-contract.js" ] ||
  fail "the hosted-load contract manifest first path is not canonical"
[ "$(awk 'NR == 2 {print $2}' "$HOSTED_LOAD_CONTRACT_MANIFEST_PATH")" = \
  "load/hosted-recall.js" ] ||
  fail "the hosted-load contract manifest second path is not canonical"
sha256sum --check --strict "$HOSTED_LOAD_CONTRACT_MANIFEST_PATH" >/dev/null ||
  fail "the hosted-load contract manifest does not match the approved source"
hosted_contract_digest="$(
  sha256sum "$HOSTED_LOAD_CONTRACT_MANIFEST_PATH" | awk '{print $1}'
)"
case "$HOSTED_LOAD_SUMMARY_PATH" in
  "${RUNNER_TEMP%/}"/*/hosted-k6-summary.json) ;;
  *) fail "the hosted-load summary escaped RUNNER_TEMP" ;;
esac
[ -f "$HOSTED_LOAD_SUMMARY_PATH" ] && [ ! -L "$HOSTED_LOAD_SUMMARY_PATH" ] ||
  fail "the hosted-load summary is missing or is a symbolic link"
jq -e '
  type == "object"
  and .version == "1.0.0"
  and (.results | type) == "object"
  and (.results.metrics | type) == "array"
  and ([.results.metrics[].name] | length)
    == ([.results.metrics[].name] | unique | length)
' \
  "$HOSTED_LOAD_SUMMARY_PATH" >/dev/null ||
  fail "the hosted-load summary is not a machine-readable k6 summary"
hosted_summary_digest="$(
  sha256sum "$HOSTED_LOAD_SUMMARY_PATH" | awk '{print $1}'
)"

raw_dir="$(mktemp -d "${RUNNER_TEMP%/}/sustainability-intensity.XXXXXXXXXX")"
case "$raw_dir" in
  "${RUNNER_TEMP%/}"/sustainability-intensity.*) ;;
  *) fail "the raw response directory escaped RUNNER_TEMP" ;;
esac

cleanup() {
  case "$raw_dir" in
    "${RUNNER_TEMP%/}"/sustainability-intensity.*)
      rm -f -- "$raw_dir"/*
      rmdir -- "$raw_dir" 2>/dev/null || true
      ;;
  esac
}
trap cleanup EXIT

run_json() {
  local output_path="$1"
  shift
  aws "$@" --output json --no-cli-pager >"$output_path"
  jq -e 'type == "object"' "$output_path" >/dev/null
}

# The hosted evidence is the denominator and the authoritative workload
# window. Version 2 adds an exact successful-recall counter and timestamps;
# older artifacts are intentionally ineligible for intensity claims.
jq -e \
  --arg commit "$TARGET_SHA" \
  --arg environment "$TARGET_ENVIRONMENT" \
  --arg contractDigest "$hosted_contract_digest" \
  --arg summaryDigest "$hosted_summary_digest" \
  --argjson runId "$HOSTED_LOAD_RUN_ID" \
  --argjson runAttempt "$HOSTED_LOAD_RUN_ATTEMPT" \
  '
    .schema == "archon.hosted-load-evidence"
    and .version == 2
    and .ok == true
    and .result == "thresholds-satisfied"
    and .commitSha == $commit
    and .environment == $environment
    and .workflow == {runId: $runId, runAttempt: $runAttempt}
    and .target.path == "/api/recall"
    and .target.redirectsAllowed == false
    and .workload.dataMutation == false
    and .workload.corpus == "synthetic-public-demo"
    and .workload.contractSource == "load/hosted-recall.js"
    and .workload.contractSources == [
      "load/hosted-recall-contract.js",
      "load/hosted-recall.js"
    ]
    and .workload.contractDigestAlgorithm ==
      "sha256(canonical-sha256sum-manifest)"
    and .workload.contractSourceSha256 == $contractDigest
    and (.workload.iterations | type) == "number"
    and (.workload.virtualUsers | type) == "number"
    and (.observed.successfulRecalls | type) == "number"
    and .observed.successfulRecalls == .workload.iterations
    and .observed.completedIterations == .workload.iterations
    and .observed.httpRequests == (.workload.iterations + 1)
    and (.measurementWindow.startedAt | fromdateiso8601) > 0
    and (.measurementWindow.completedAt | fromdateiso8601) >
      (.measurementWindow.startedAt | fromdateiso8601)
    and (.measurementWindow.durationSeconds | type) == "number"
    and .measurementWindow.durationSeconds >= 1
    and .measurementWindow.durationSeconds <= 660
    and .rawSummary.sha256 == $summaryDigest
    and .rawSummary.schemaVersion == "1.0.0"
    and .rawSummary.layout ==
      "k6-machine-readable-results-metrics-array"
  ' "$HOSTED_LOAD_RECEIPT_PATH" >/dev/null ||
  fail "the hosted-load artifact is not an exact successful version-2 workload receipt"

hosted_iterations="$(
  jq -er '.workload.iterations' "$HOSTED_LOAD_RECEIPT_PATH"
)"
hosted_successful_recalls="$(
  jq -er '.observed.successfulRecalls' "$HOSTED_LOAD_RECEIPT_PATH"
)"
jq -e \
  --argjson iterations "$hosted_iterations" \
  --argjson successfulRecalls "$hosted_successful_recalls" \
  '
    (.results.metrics | map({key: .name, value: .}) | from_entries) as $metrics
    | $metrics.iterations.type == "counter"
      and $metrics.http_reqs.type == "counter"
      and $metrics.hosted_successful_recalls.type == "counter"
      and $metrics.hosted_recall_contract.type == "rate"
      and $metrics.hosted_grounded_citations.type == "rate"
      and $metrics.hosted_scope_isolation.type == "rate"
      and $metrics.iterations.values.count == $iterations
      and $metrics.http_reqs.values.count == ($iterations + 1)
      and $metrics.hosted_successful_recalls.values.count
        == $successfulRecalls
      and $metrics.hosted_recall_contract.values.rate == 1
      and $metrics.hosted_grounded_citations.values.rate == 1
      and $metrics.hosted_scope_isolation.values.rate == 1
  ' "$HOSTED_LOAD_SUMMARY_PATH" >/dev/null ||
  fail "the raw k6 summary does not match the successful hosted-load receipt"

window_start="$(jq -er '.measurementWindow.startedAt' "$HOSTED_LOAD_RECEIPT_PATH")"
window_end="$(jq -er '.measurementWindow.completedAt' "$HOSTED_LOAD_RECEIPT_PATH")"
window_start_epoch="$(date -u -d "$window_start" +%s)"
window_end_epoch="$(date -u -d "$window_end" +%s)"
now_epoch="$(date -u +%s)"
[ $((window_end_epoch - window_start_epoch)) -ge 1 ] || fail "the workload window is empty"
[ $((window_end_epoch - window_start_epoch)) -le 660 ] || fail "the workload window is not bounded"
[ "$window_end_epoch" -le $((now_epoch + 300)) ] || fail "the workload window is in the future"
[ "$window_end_epoch" -ge $((now_epoch - 1209600)) ] || fail "the workload window is older than the 14-day one-minute evidence horizon"

telemetry_start_epoch=$((window_start_epoch / 60 * 60))
telemetry_end_epoch=$(((window_end_epoch + 59) / 60 * 60))
[ "$telemetry_end_epoch" -gt "$telemetry_start_epoch" ] || telemetry_end_epoch=$((telemetry_start_epoch + 60))
telemetry_start="$(date -u -d "@$telemetry_start_epoch" +'%Y-%m-%dT%H:%M:%SZ')"
telemetry_end="$(date -u -d "@$telemetry_end_epoch" +'%Y-%m-%dT%H:%M:%SZ')"
telemetry_duration=$((telemetry_end_epoch - telemetry_start_epoch))
[ "$telemetry_duration" -le 780 ] || fail "the minute-aligned telemetry window is not bounded"

successful_recalls="$(jq -er '.observed.successfulRecalls' "$HOSTED_LOAD_RECEIPT_PATH")"
expected_http_requests="$(jq -er '.observed.httpRequests' "$HOSTED_LOAD_RECEIPT_PATH")"
source_deploy_run_id="$(jq -er '.sourceDeployment.runId' "$HOSTED_LOAD_RECEIPT_PATH")"
source_deploy_run_attempt="$(jq -er '.sourceDeployment.runAttempt' "$HOSTED_LOAD_RECEIPT_PATH")"

equivalence_payload="$raw_dir/equivalence.json"
jq -cS \
  '{
    environment,
    targetContract: {
      scheme: .target.scheme,
      path: .target.path,
      redirectsAllowed: .target.redirectsAllowed
    },
    workload,
    objectives
  }' "$HOSTED_LOAD_RECEIPT_PATH" >"$equivalence_payload"
equivalence_digest="$(sha256sum "$equivalence_payload" | awk '{print $1}')"

# Bind the OIDC role before any AWS read. The STS response stays ephemeral.
identity_file="$raw_dir/identity.json"
run_json "$identity_file" sts get-caller-identity --region "$AWS_REGION" || fail "STS identity could not be read"
expected_role_name="${AWS_SUSTAINABILITY_AUDIT_ROLE_ARN##*/}"
jq -e \
  --arg account "$AWS_ACCOUNT_ID" \
  --arg rolePrefix "arn:aws:sts::${AWS_ACCOUNT_ID}:assumed-role/${expected_role_name}/" \
  '.Account == $account and (.Arn | type == "string" and startswith($rolePrefix))' \
  "$identity_file" >/dev/null || fail "temporary credentials are not the approved sustainability audit role"

# Read only the exact application stack. The raw stack response may contain
# identifiers and therefore never leaves RUNNER_TEMP.
stack_name="${APP_NAME}-${TARGET_ENVIRONMENT}"
stack_file="$raw_dir/stack.json"
run_json "$stack_file" cloudformation describe-stacks \
  --region "$AWS_REGION" \
  --stack-name "$stack_name" || fail "the exact application stack could not be described"
jq -e \
  --arg stackName "$stack_name" \
  --arg app "$APP_NAME" \
  --arg environment "$TARGET_ENVIRONMENT" \
  --arg commit "$TARGET_SHA" \
  '
    (.Stacks | length) == 1
    and .Stacks[0].StackName == $stackName
    and (.Stacks[0].StackStatus == "CREATE_COMPLETE" or .Stacks[0].StackStatus == "UPDATE_COMPLETE")
    and ([.Stacks[0].Tags[] | select(.Key == "Application") | .Value] == [$app])
    and ([.Stacks[0].Tags[] | select(.Key == "Environment") | .Value] == [$environment])
    and ([.Stacks[0].Parameters[] | select(.ParameterKey == "ReleaseCommitSha") | .ParameterValue] == [$commit])
    and ([.Stacks[0].Parameters[] | select(.ParameterKey == "LambdaMemoryMb") | .ParameterValue] | length) == 1
    and ([.Stacks[0].Outputs[] | select(.OutputKey == "FunctionName") | .OutputValue] | length) == 1
    and ([.Stacks[0].Outputs[] | select(.OutputKey == "DistributionId") | .OutputValue] | length) == 1
    and ([.Stacks[0].Outputs[] | select(.OutputKey == "ApiId") | .OutputValue] | length) == 1
    and ([.Stacks[0].Outputs[] | select(.OutputKey == "ApiStageName") | .OutputValue] | length) == 1
    and ([.Stacks[0].Outputs[] | select(.OutputKey == "ApiAccessLogGroupName") | .OutputValue] | length) == 1
  ' "$stack_file" >/dev/null || fail "the live stack is not the exact deployed release"

lambda_memory_mb="$(jq -er '.Stacks[0].Parameters[] | select(.ParameterKey == "LambdaMemoryMb") | .ParameterValue | tonumber' "$stack_file")"
[ "$lambda_memory_mb" -ge 256 ] && [ "$lambda_memory_mb" -le 3008 ] || fail "Lambda memory is outside the template contract"
function_name="$(jq -er '.Stacks[0].Outputs[] | select(.OutputKey == "FunctionName") | .OutputValue' "$stack_file")"
distribution_id="$(jq -er '.Stacks[0].Outputs[] | select(.OutputKey == "DistributionId") | .OutputValue' "$stack_file")"
api_id="$(jq -er '.Stacks[0].Outputs[] | select(.OutputKey == "ApiId") | .OutputValue' "$stack_file")"
api_stage="$(jq -er '.Stacks[0].Outputs[] | select(.OutputKey == "ApiStageName") | .OutputValue' "$stack_file")"
api_log_group="$(jq -er '.Stacks[0].Outputs[] | select(.OutputKey == "ApiAccessLogGroupName") | .OutputValue' "$stack_file")"
[ "$function_name" = "${APP_NAME}-${TARGET_ENVIRONMENT}-api" ] || fail "the Lambda identity is outside the exact stack"
[[ "$distribution_id" =~ ^[A-Z0-9]{12,20}$ ]] || fail "the CloudFront distribution id is invalid"
[[ "$api_id" =~ ^[a-z0-9]{10}$ ]] || fail "the HTTP API id is invalid"
[[ "$api_stage" =~ ^[A-Za-z0-9_-]{1,128}$ ]] || fail "the HTTP API stage is invalid"
[ "$api_log_group" = "/aws/vendedlogs/apigateway/${APP_NAME}-${TARGET_ENVIRONMENT}" ] || fail "the API log group is outside the exact stack"

regional_queries="$raw_dir/regional-queries.json"
jq -n \
  --arg functionName "$function_name" \
  --arg apiId "$api_id" \
  --arg apiStage "$api_stage" \
  '[
    {Id:"lambda_invocations",MetricStat:{Metric:{Namespace:"AWS/Lambda",MetricName:"Invocations",Dimensions:[{Name:"FunctionName",Value:$functionName}]},Period:60,Stat:"Sum"},ReturnData:true},
    {Id:"lambda_errors",MetricStat:{Metric:{Namespace:"AWS/Lambda",MetricName:"Errors",Dimensions:[{Name:"FunctionName",Value:$functionName}]},Period:60,Stat:"Sum"},ReturnData:true},
    {Id:"lambda_duration_ms",MetricStat:{Metric:{Namespace:"AWS/Lambda",MetricName:"Duration",Dimensions:[{Name:"FunctionName",Value:$functionName}]},Period:60,Stat:"Sum"},ReturnData:true},
    {Id:"api_requests",MetricStat:{Metric:{Namespace:"AWS/ApiGateway",MetricName:"Count",Dimensions:[{Name:"ApiId",Value:$apiId},{Name:"Stage",Value:$apiStage}]},Period:60,Stat:"Sum"},ReturnData:true},
    {Id:"api_4xx",MetricStat:{Metric:{Namespace:"AWS/ApiGateway",MetricName:"4xx",Dimensions:[{Name:"ApiId",Value:$apiId},{Name:"Stage",Value:$apiStage}]},Period:60,Stat:"Sum"},ReturnData:true},
    {Id:"api_5xx",MetricStat:{Metric:{Namespace:"AWS/ApiGateway",MetricName:"5xx",Dimensions:[{Name:"ApiId",Value:$apiId},{Name:"Stage",Value:$apiStage}]},Period:60,Stat:"Sum"},ReturnData:true},
    {Id:"api_data_bytes",MetricStat:{Metric:{Namespace:"AWS/ApiGateway",MetricName:"DataProcessed",Dimensions:[{Name:"ApiId",Value:$apiId},{Name:"Stage",Value:$apiStage}]},Period:60,Stat:"Sum"},ReturnData:true}
  ]' >"$regional_queries"

cloudfront_queries="$raw_dir/cloudfront-queries.json"
jq -n \
  --arg distributionId "$distribution_id" \
  '[
    {Id:"cloudfront_requests",MetricStat:{Metric:{Namespace:"AWS/CloudFront",MetricName:"Requests",Dimensions:[{Name:"DistributionId",Value:$distributionId},{Name:"Region",Value:"Global"}]},Period:60,Stat:"Sum"},ReturnData:true},
    {Id:"cloudfront_downloaded_bytes",MetricStat:{Metric:{Namespace:"AWS/CloudFront",MetricName:"BytesDownloaded",Dimensions:[{Name:"DistributionId",Value:$distributionId},{Name:"Region",Value:"Global"}]},Period:60,Stat:"Sum"},ReturnData:true},
    {Id:"cloudfront_uploaded_bytes",MetricStat:{Metric:{Namespace:"AWS/CloudFront",MetricName:"BytesUploaded",Dimensions:[{Name:"DistributionId",Value:$distributionId},{Name:"Region",Value:"Global"}]},Period:60,Stat:"Sum"},ReturnData:true}
  ]' >"$cloudfront_queries"

regional_metrics="$raw_dir/regional-metrics.json"
cloudfront_metrics="$raw_dir/cloudfront-metrics.json"
telemetry_ready=false
for attempt in $(seq 1 12); do
  run_json "$regional_metrics" cloudwatch get-metric-data \
    --region "$AWS_REGION" \
    --metric-data-queries "file://${regional_queries}" \
    --start-time "$telemetry_start" \
    --end-time "$telemetry_end" \
    --scan-by TimestampAscending || fail "regional CloudWatch metrics could not be read"
  # us-east-1 is CloudFront's global telemetry/control plane; it is not a
  # regional application workload and no resource is created there.
  run_json "$cloudfront_metrics" cloudwatch get-metric-data \
    --region us-east-1 \
    --metric-data-queries "file://${cloudfront_queries}" \
    --start-time "$telemetry_start" \
    --end-time "$telemetry_end" \
    --scan-by TimestampAscending || fail "global CloudFront metrics could not be read"

  if jq -e '
      ([.MetricDataResults[].Id] | sort) == [
        "api_4xx", "api_5xx", "api_data_bytes", "api_requests",
        "lambda_duration_ms", "lambda_errors", "lambda_invocations"
      ]
      and all(.MetricDataResults[]; .StatusCode == "Complete")
    ' "$regional_metrics" >/dev/null &&
    jq -e '
      ([.MetricDataResults[].Id] | sort) == [
        "cloudfront_downloaded_bytes", "cloudfront_requests", "cloudfront_uploaded_bytes"
      ]
      and all(.MetricDataResults[]; .StatusCode == "Complete")
    ' "$cloudfront_metrics" >/dev/null &&
    [ "$(jq -r '[.MetricDataResults[] | select(.Id == "lambda_invocations") | .Values[]] | add // 0' "$regional_metrics")" -eq "$expected_http_requests" ] &&
    [ "$(jq -r '[.MetricDataResults[] | select(.Id == "api_requests") | .Values[]] | add // 0' "$regional_metrics")" -eq "$expected_http_requests" ] &&
    [ "$(jq -r '[.MetricDataResults[] | select(.Id == "cloudfront_requests") | .Values[]] | add // 0' "$cloudfront_metrics")" -eq "$expected_http_requests" ]; then
    telemetry_ready=true
    break
  fi
  [ "$attempt" -eq 12 ] || sleep 30
done
[ "$telemetry_ready" = true ] || fail "CloudWatch did not publish complete bounded-window metrics within the retry budget"

sum_metric() {
  local file="$1"
  local id="$2"
  jq -er --arg id "$id" '[.MetricDataResults[] | select(.Id == $id) | .Values[]] | add // 0' "$file"
}

lambda_invocations="$(sum_metric "$regional_metrics" lambda_invocations)"
lambda_errors="$(sum_metric "$regional_metrics" lambda_errors)"
lambda_duration_ms="$(sum_metric "$regional_metrics" lambda_duration_ms)"
api_requests="$(sum_metric "$regional_metrics" api_requests)"
api_4xx="$(sum_metric "$regional_metrics" api_4xx)"
api_5xx="$(sum_metric "$regional_metrics" api_5xx)"
api_data_bytes="$(sum_metric "$regional_metrics" api_data_bytes)"
cloudfront_requests="$(sum_metric "$cloudfront_metrics" cloudfront_requests)"
cloudfront_downloaded_bytes="$(sum_metric "$cloudfront_metrics" cloudfront_downloaded_bytes)"
cloudfront_uploaded_bytes="$(sum_metric "$cloudfront_metrics" cloudfront_uploaded_bytes)"

jq -en \
  --argjson duration "$lambda_duration_ms" \
  --argjson apiBytes "$api_data_bytes" \
  --argjson cfDown "$cloudfront_downloaded_bytes" \
  --argjson cfUp "$cloudfront_uploaded_bytes" \
  '$duration > 0 and $apiBytes > 0 and ($cfDown + $cfUp) > 0' >/dev/null ||
  fail "the telemetry window lacks duration or transfer evidence"

# Point-in-time storage context is metadata only. No log event is queried.
lambda_logs="$raw_dir/lambda-log-groups.json"
api_logs="$raw_dir/api-log-groups.json"
run_json "$lambda_logs" logs describe-log-groups \
  --region "$AWS_REGION" \
  --log-group-name-prefix "/aws/lambda/${function_name}" || fail "Lambda log storage metadata could not be read"
run_json "$api_logs" logs describe-log-groups \
  --region "$AWS_REGION" \
  --log-group-name-prefix "$api_log_group" || fail "API log storage metadata could not be read"
jq -e --arg name "/aws/lambda/${function_name}" '([.logGroups[] | select(.logGroupName == $name)] | length) == 1' "$lambda_logs" >/dev/null || fail "the exact Lambda log group was not found"
jq -e --arg name "$api_log_group" '([.logGroups[] | select(.logGroupName == $name)] | length) == 1' "$api_logs" >/dev/null || fail "the exact API log group was not found"
lambda_log_bytes="$(jq -er --arg name "/aws/lambda/${function_name}" '.logGroups[] | select(.logGroupName == $name) | .storedBytes // 0' "$lambda_logs")"
lambda_log_retention="$(jq -er --arg name "/aws/lambda/${function_name}" '.logGroups[] | select(.logGroupName == $name) | .retentionInDays // 0' "$lambda_logs")"
api_log_bytes="$(jq -er --arg name "$api_log_group" '.logGroups[] | select(.logGroupName == $name) | .storedBytes // 0' "$api_logs")"
api_log_retention="$(jq -er --arg name "$api_log_group" '.logGroups[] | select(.logGroupName == $name) | .retentionInDays // 0' "$api_logs")"

lambda_configured_gb_seconds="$(jq -n --argjson duration "$lambda_duration_ms" --argjson memory "$lambda_memory_mb" '$duration / 1000 * ($memory / 1024)')"
lambda_per_success="$(jq -n --argjson total "$lambda_configured_gb_seconds" --argjson success "$successful_recalls" '$total / $success')"
api_bytes_per_success="$(jq -n --argjson total "$api_data_bytes" --argjson success "$successful_recalls" '$total / $success')"
cloudfront_transfer_bytes="$(jq -n --argjson down "$cloudfront_downloaded_bytes" --argjson up "$cloudfront_uploaded_bytes" '$down + $up')"
cloudfront_bytes_per_success="$(jq -n --argjson total "$cloudfront_transfer_bytes" --argjson success "$successful_recalls" '$total / $success')"

case "$PRIMARY_PROXY" in
  lambda-configured-gb-seconds) primary_value="$lambda_per_success" ;;
  api-data-processed-bytes) primary_value="$api_bytes_per_success" ;;
  cloudfront-transfer-bytes) primary_value="$cloudfront_bytes_per_success" ;;
esac

comparison_ok=true
comparison_result="baseline-recorded-no-improvement-claim"
baseline_digest_json=null
baseline_commit_json=null
baseline_value_json=null
reduction_bps_json=null
if [ "$COMPARISON_MODE" = compare ]; then
  for required in BASELINE_COMMIT_SHA BASELINE_RECEIPT_PATH BASELINE_RECEIPT_SHA256 BASELINE_RUN_ATTEMPT BASELINE_RUN_ID; do
    require_env "$required"
  done
  [[ "$BASELINE_COMMIT_SHA" =~ ^[0-9a-f]{40}$ ]] || fail "the baseline commit SHA is invalid"
  [ "$BASELINE_COMMIT_SHA" != "$TARGET_SHA" ] || fail "before and after releases must be different commits"
  [[ "$BASELINE_RECEIPT_SHA256" =~ ^[0-9a-f]{64}$ ]] || fail "the baseline receipt digest is invalid"
  case "$BASELINE_RECEIPT_PATH" in
    "${RUNNER_TEMP%/}"/*/sustainability-intensity-receipt.json) ;;
    *) fail "the baseline receipt escaped RUNNER_TEMP" ;;
  esac
  [ -f "$BASELINE_RECEIPT_PATH" ] && [ ! -L "$BASELINE_RECEIPT_PATH" ] || fail "the baseline receipt is missing or unsafe"
  [ "$(sha256sum "$BASELINE_RECEIPT_PATH" | awk '{print $1}')" = "$BASELINE_RECEIPT_SHA256" ] || fail "the baseline receipt digest does not match"
  jq -e \
    --arg environment "$TARGET_ENVIRONMENT" \
    --arg commit "$BASELINE_COMMIT_SHA" \
    --arg equivalence "$equivalence_digest" \
    --arg owner "$SUSTAINABILITY_OWNER_DIGEST" \
    --arg proxy "$PRIMARY_PROXY" \
    --argjson successes "$successful_recalls" \
    --argjson target "$TARGET_REDUCTION_BPS" \
    '
      .schema == "archon.sustainability-intensity-evidence"
      and .version == 1
      and .ok == true
      and .evidenceClass == "engineering-intensity-proxy-not-emissions"
      and .environment == $environment
      and .commitSha == $commit
      and .equivalentWorkload.sha256 == $equivalence
      and .equivalentWorkload.successfulRecalls == $successes
      and .equivalentWorkload.oneMinuteRequestCountsExact == true
      and .approval.ownerDigest == $owner
      and .primaryProxy.id == $proxy
      and .primaryProxy.valuePerSuccessfulRecall > 0
      and .comparison.mode == "baseline"
      and .comparison.approvedTargetReductionBps == $target
    ' "$BASELINE_RECEIPT_PATH" >/dev/null || fail "the baseline is not an equivalent approved source receipt"
  baseline_value_json="$(jq -er '.primaryProxy.valuePerSuccessfulRecall' "$BASELINE_RECEIPT_PATH")"
  reduction_bps_json="$(jq -n --argjson before "$baseline_value_json" --argjson after "$primary_value" '($before - $after) / $before * 10000')"
  if ! jq -en --argjson reduction "$reduction_bps_json" --argjson target "$TARGET_REDUCTION_BPS" '$reduction >= $target' >/dev/null; then
    comparison_ok=false
    comparison_result="approved-reduction-target-not-met"
  else
    comparison_result="approved-reduction-target-met"
  fi
  baseline_digest_json="\"$BASELINE_RECEIPT_SHA256\""
  baseline_commit_json="\"$BASELINE_COMMIT_SHA\""
fi

stack_digest="$(sha256sum "$stack_file" | awk '{print $1}')"
regional_metrics_digest="$(sha256sum "$regional_metrics" | awk '{print $1}')"
cloudfront_metrics_digest="$(sha256sum "$cloudfront_metrics" | awk '{print $1}')"
log_metadata_digest="$(cat "$lambda_logs" "$api_logs" | sha256sum | awk '{print $1}')"
function_digest="$(printf '%s' "$function_name" | sha256sum | awk '{print $1}')"
distribution_digest="$(printf '%s' "$distribution_id" | sha256sum | awk '{print $1}')"
api_digest="$(printf '%s:%s' "$api_id" "$api_stage" | sha256sum | awk '{print $1}')"
generated_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
final_receipt="$raw_dir/final-receipt.json"

jq -n \
  --arg generatedAt "$generated_at" \
  --arg repository "$GITHUB_REPOSITORY" \
  --arg commit "$TARGET_SHA" \
  --arg environment "$TARGET_ENVIRONMENT" \
  --arg ownerDigest "$SUSTAINABILITY_OWNER_DIGEST" \
  --arg approvalDigest "$APPROVAL_REFERENCE_DIGEST" \
  --arg workloadStartedAt "$window_start" \
  --arg workloadCompletedAt "$window_end" \
  --arg telemetryStartedAt "$telemetry_start" \
  --arg telemetryCompletedAt "$telemetry_end" \
  --arg equivalenceDigest "$equivalence_digest" \
  --arg hostedReceiptDigest "$HOSTED_LOAD_RECEIPT_SHA256" \
  --arg functionDigest "$function_digest" \
  --arg distributionDigest "$distribution_digest" \
  --arg apiDigest "$api_digest" \
  --arg stackDigest "$stack_digest" \
  --arg regionalMetricsDigest "$regional_metrics_digest" \
  --arg cloudFrontMetricsDigest "$cloudfront_metrics_digest" \
  --arg logMetadataDigest "$log_metadata_digest" \
  --arg primaryProxy "$PRIMARY_PROXY" \
  --arg comparisonMode "$COMPARISON_MODE" \
  --arg comparisonResult "$comparison_result" \
  --argjson ok "$comparison_ok" \
  --argjson workloadDuration "$((window_end_epoch - window_start_epoch))" \
  --argjson telemetryDuration "$telemetry_duration" \
  --argjson hostedRunId "$HOSTED_LOAD_RUN_ID" \
  --argjson hostedRunAttempt "$HOSTED_LOAD_RUN_ATTEMPT" \
  --argjson deployRunId "$source_deploy_run_id" \
  --argjson deployRunAttempt "$source_deploy_run_attempt" \
  --argjson successfulRecalls "$successful_recalls" \
  --argjson expectedRequests "$expected_http_requests" \
  --argjson lambdaMemory "$lambda_memory_mb" \
  --argjson lambdaInvocations "$lambda_invocations" \
  --argjson lambdaErrors "$lambda_errors" \
  --argjson lambdaDuration "$lambda_duration_ms" \
  --argjson lambdaGbSeconds "$lambda_configured_gb_seconds" \
  --argjson lambdaPerSuccess "$lambda_per_success" \
  --argjson apiRequests "$api_requests" \
  --argjson api4xx "$api_4xx" \
  --argjson api5xx "$api_5xx" \
  --argjson apiBytes "$api_data_bytes" \
  --argjson apiBytesPerSuccess "$api_bytes_per_success" \
  --argjson cloudFrontRequests "$cloudfront_requests" \
  --argjson cloudFrontDownloaded "$cloudfront_downloaded_bytes" \
  --argjson cloudFrontUploaded "$cloudfront_uploaded_bytes" \
  --argjson cloudFrontTransfer "$cloudfront_transfer_bytes" \
  --argjson cloudFrontPerSuccess "$cloudfront_bytes_per_success" \
  --argjson lambdaLogBytes "$lambda_log_bytes" \
  --argjson lambdaLogRetention "$lambda_log_retention" \
  --argjson apiLogBytes "$api_log_bytes" \
  --argjson apiLogRetention "$api_log_retention" \
  --argjson primaryValue "$primary_value" \
  --argjson targetBps "$TARGET_REDUCTION_BPS" \
  --argjson baselineDigest "$baseline_digest_json" \
  --argjson baselineCommit "$baseline_commit_json" \
  --argjson baselineValue "$baseline_value_json" \
  --argjson reductionBps "$reduction_bps_json" \
  '{
    schema: "archon.sustainability-intensity-evidence",
    version: 1,
    ok: $ok,
    evidenceClass: "engineering-intensity-proxy-not-emissions",
    generatedAt: $generatedAt,
    repository: $repository,
    commitSha: $commit,
    environment: $environment,
    regionPolicy: {
      applicationRegion: "eu-west-1",
      cloudFrontTelemetryControlPlane: "us-east-1",
      additionalRegionalWorkloadCreated: false
    },
    approval: {
      protectedEnvironment: "sustainability-audit",
      ownerDigest: $ownerDigest,
      approvalReferenceDigest: $approvalDigest,
      targetReductionBps: $targetBps
    },
    sourceDeployment: {
      runId: $deployRunId,
      runAttempt: $deployRunAttempt,
      stackDescriptionSha256: $stackDigest,
      resourceIdentityDigests: {
        function: $functionDigest,
        distribution: $distributionDigest,
        apiAndStage: $apiDigest
      }
    },
    workloadEvidence: {
      runId: $hostedRunId,
      runAttempt: $hostedRunAttempt,
      receiptSha256: $hostedReceiptDigest,
      corpus: "synthetic-public-demo",
      productionScaleClaimed: false
    },
    measurementWindow: {
      workloadStartedAt: $workloadStartedAt,
      workloadCompletedAt: $workloadCompletedAt,
      workloadDurationSeconds: $workloadDuration,
      telemetryStartedAt: $telemetryStartedAt,
      telemetryCompletedAt: $telemetryCompletedAt,
      telemetryDurationSeconds: $telemetryDuration,
      cloudWatchPeriodSeconds: 60
    },
    equivalentWorkload: {
      sha256: $equivalenceDigest,
      successfulRecalls: $successfulRecalls,
      expectedHostedRequests: $expectedRequests,
      oneMinuteRequestCountsExact: true,
      sameCorpusConcurrencyCorrectnessAndObjectivesRequired: true
    },
    metrics: {
      lambda: {
        configuredMemoryMb: $lambdaMemory,
        invocations: $lambdaInvocations,
        errors: $lambdaErrors,
        durationMs: $lambdaDuration,
        configuredMemoryGbSeconds: $lambdaGbSeconds,
        configuredMemoryGbSecondsPerSuccessfulRecall: $lambdaPerSuccess,
        billedGbSecondsClaimed: false
      },
      apiGateway: {
        requests: $apiRequests,
        errors4xx: $api4xx,
        errors5xx: $api5xx,
        dataProcessedBytes: $apiBytes,
        dataProcessedBytesPerSuccessfulRecall: $apiBytesPerSuccess
      },
      cloudFront: {
        requests: $cloudFrontRequests,
        downloadedBytes: $cloudFrontDownloaded,
        uploadedBytes: $cloudFrontUploaded,
        transferBytes: $cloudFrontTransfer,
        transferBytesPerSuccessfulRecall: $cloudFrontPerSuccess
      },
      storageContextAtCollection: {
        lambdaLogStoredBytes: $lambdaLogBytes,
        lambdaLogRetentionDays: $lambdaLogRetention,
        apiAccessLogStoredBytes: $apiLogBytes,
        apiAccessLogRetentionDays: $apiLogRetention,
        normalizedPerRecall: false
      }
    },
    primaryProxy: {
      id: $primaryProxy,
      valuePerSuccessfulRecall: $primaryValue
    },
    comparison: {
      mode: $comparisonMode,
      result: $comparisonResult,
      approvedTargetReductionBps: $targetBps,
      baselineReceiptSha256: $baselineDigest,
      baselineCommitSha: $baselineCommit,
      baselineValuePerSuccessfulRecall: $baselineValue,
      observedReductionBps: $reductionBps
    },
    rawEvidenceDigests: {
      regionalMetricDataSha256: $regionalMetricsDigest,
      cloudFrontMetricDataSha256: $cloudFrontMetricsDigest,
      logStorageMetadataSha256: $logMetadataDigest,
      rawResponsesUploaded: false
    },
    claims: {
      emissionsMeasured: false,
      carbonReductionClaimed: false,
      productionScaleClaimed: false,
      ccftUsed: false
    },
    limitations: [
      "Lambda, API, and CloudFront request counts must exactly equal the hosted workload; any detected concurrent request in the same one-minute bins fails the run.",
      "Configured-memory GB-seconds use Lambda Duration and configured memory; they are not billed-duration or emissions measurements.",
      "Log storedBytes values are point-in-time context, not workload-window attribution.",
      "The workload is bounded and synthetic; no production-scale or business-impact claim is made."
    ]
  }' >"$final_receipt"

mv -f -- "$final_receipt" "$RECEIPT_PATH"
