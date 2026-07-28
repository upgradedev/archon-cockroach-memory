#!/usr/bin/env bash
# Fail-closed post-deployment proof for the public HTTP API stage.
#
# Usage:
#   prove-api-stage-controls.sh preflight
#   prove-api-stage-controls.sh verify
#
# Preflight requires STACK_NAME, API_ACCESS_LOG_GROUP, and AWS_REGION. It proves
# the OIDC role can perform every read before SAM is allowed to mutate the stack.
# Verify additionally requires API_ID, API_STAGE_NAME, API_ENDPOINT,
# APPLICATION_URL, and AWS_ACCOUNT_ID.
set -euo pipefail

mode="${1:-verify}"
if [ "$mode" != "preflight" ] && [ "$mode" != "verify" ]; then
  echo "Usage: $0 [preflight|verify]" >&2
  exit 1
fi

for name in STACK_NAME API_ACCESS_LOG_GROUP AWS_REGION; do
  if [ -z "${!name:-}" ]; then
    echo "$name is required for the API stage proof." >&2
    exit 1
  fi
done

if [ "$mode" = "preflight" ]; then
  if ! current_stack="$(
    aws cloudformation describe-stacks \
      --stack-name "$STACK_NAME" \
      --region "$AWS_REGION" \
      --output json 2>&1
  )"; then
    if ! grep -qi "does not exist" <<<"$current_stack"; then
      echo "Unable to inspect the current stack during preflight." >&2
      exit 1
    fi
    jq -n '{
      ok: true,
      mode: "preflight",
      state: "greenfield",
      deferredToPostDeploy: true
    }'
    exit 0
  fi

  aws cloudformation get-template \
    --stack-name "$STACK_NAME" \
    --region "$AWS_REGION" \
    --template-stage Processed \
    --output json >/dev/null

  api_endpoint="$(
    jq -er \
      '.Stacks[0].Outputs[]
       | select(.OutputKey == "ApiEndpoint")
       | .OutputValue' <<<"$current_stack"
  )"
  api_id="$(sed -E 's#^https://([^.]+)\..*$#\1#' <<<"$api_endpoint")"
  if [ -z "$api_id" ] || [ "$api_id" = "$api_endpoint" ]; then
    echo "Unable to resolve the current API id from the stack output." >&2
    exit 1
  fi
  distribution_id="$(
    jq -er \
      '.Stacks[0].Outputs[]
       | select(.OutputKey == "DistributionId")
       | .OutputValue' <<<"$current_stack"
  )"
  aws cloudfront get-distribution \
    --id "$distribution_id" \
    --output json >/dev/null
  aws cloudfront get-distribution-config \
    --id "$distribution_id" \
    --output json >/dev/null
  deployed_log_group="$(
    jq -r \
      '[.Stacks[0].Outputs[]?
        | select(.OutputKey == "ApiAccessLogGroupName")
        | .OutputValue][0] // empty' <<<"$current_stack"
  )"
  if [ -n "$deployed_log_group" ]; then
    API_ACCESS_LOG_GROUP="$deployed_log_group"
  fi

  current_stage=""
  for candidate in live '$default'; do
    if stage_result="$(
      aws apigatewayv2 get-stage \
      --api-id "$api_id" \
      --stage-name "$candidate" \
      --region "$AWS_REGION" \
      --output json 2>&1
    )"; then
      current_stage="$candidate"
      break
    elif ! grep -Eqi 'NotFoundException|not found' <<<"$stage_result"; then
      echo "Unable to inspect the current API stage during preflight." >&2
      exit 1
    fi
  done
  if [ -z "$current_stage" ]; then
    echo "No current API stage could be read during preflight." >&2
    exit 1
  fi

  aws logs describe-log-streams \
    --log-group-name "$API_ACCESS_LOG_GROUP" \
    --max-items 1 \
    --region "$AWS_REGION" \
    --output json >/dev/null
  aws logs filter-log-events \
    --log-group-name "$API_ACCESS_LOG_GROUP" \
    --start-time "$((($(date +%s) - 60) * 1000))" \
    --limit 1 \
    --no-paginate \
    --region "$AWS_REGION" \
    --output json >/dev/null

  jq -n \
    --arg currentStage "$current_stage" \
    --arg logGroup "$API_ACCESS_LOG_GROUP" \
    '{
      ok: true,
      mode: "preflight",
      state: "existing",
      currentStage: $currentStage,
      accessLogGroup: $logGroup,
      permissions: [
        "cloudformation:GetTemplate",
        "apigateway:GET",
        "cloudfront:GetDistribution",
        "cloudfront:GetDistributionConfig",
        "logs:DescribeLogStreams",
        "logs:FilterLogEvents"
      ]
    }'
  exit 0
fi

for name in API_ID API_STAGE_NAME API_ENDPOINT APPLICATION_URL AWS_ACCOUNT_ID DISTRIBUTION_ID; do
  if [ -z "${!name:-}" ]; then
    echo "$name is required for the API stage proof." >&2
    exit 1
  fi
done

if [ "$API_STAGE_NAME" != "live" ]; then
  echo "The protected API stage must be the named live stage." >&2
  exit 1
fi

expected_api_endpoint="https://${API_ID}.execute-api.${AWS_REGION}.amazonaws.com/${API_STAGE_NAME}"
if [ "$API_ENDPOINT" != "$expected_api_endpoint" ]; then
  echo "The direct API endpoint is not bound to the protected named stage." >&2
  exit 1
fi

processed_template="$(
  aws cloudformation get-template \
    --stack-name "$STACK_NAME" \
    --region "$AWS_REGION" \
    --template-stage Processed \
    --output json
)"

jq -e \
  --arg stage "$API_STAGE_NAME" \
  '
    [
      .TemplateBody.Resources
      | to_entries[]
      | select(.value.Type == "AWS::ApiGatewayV2::Stage")
      | {
          logicalId: .key,
          properties: .value.Properties
        }
    ] as $stages
    | [
        .TemplateBody.Resources
        | to_entries[]
        | select(.value.Type == "AWS::CloudFront::Distribution")
        | .value.Properties.DistributionConfig.Origins[]
        | select(.Id == "ApiOrigin")
      ] as $apiOrigins
    | .TemplateBody.Parameters.HttpApiStageName.Type == "String"
      and .TemplateBody.Parameters.HttpApiStageName.Default == $stage
      and .TemplateBody.Parameters.HttpApiStageName.AllowedValues == [$stage]
      and ($stages | length) == 1
      and $stages[0].logicalId != "ServerlessHttpApiApiGatewayDefaultStage"
      and ($stages[0].logicalId | startswith("ArchonHttpApi"))
      and $stages[0].properties.ApiId.Ref == "ArchonHttpApi"
      and $stages[0].properties.StageName.Ref == "HttpApiStageName"
      and $stages[0].properties.AutoDeploy == true
      and $stages[0].properties.DefaultRouteSettings.DetailedMetricsEnabled == true
      and $stages[0].properties.DefaultRouteSettings.ThrottlingBurstLimit.Ref == "ApiThrottleBurst"
      and $stages[0].properties.DefaultRouteSettings.ThrottlingRateLimit.Ref == "ApiThrottleRate"
      and (($stages[0].properties.RouteSettings // {}) | length) == 0
      and $stages[0].properties.AccessLogSettings.DestinationArn."Fn::Sub"
        == "arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:log-group:${ApiVendedAccessLogGroup}"
      and ($stages[0].properties.AccessLogSettings.Format | contains("$context.requestId"))
      and ($stages[0].properties.AccessLogSettings.Format | contains("$context.stage"))
      and ($stages[0].properties.AccessLogSettings.Format | contains("$context.routeKey"))
      and ($stages[0].properties.AccessLogSettings.Format | contains("$context.status"))
      and ($apiOrigins | length) == 1
      and $apiOrigins[0].OriginPath."Fn::Join"[0] == ""
      and $apiOrigins[0].OriginPath."Fn::Join"[1][0] == "/"
      and $apiOrigins[0].OriginPath."Fn::Join"[1][1].Ref
        == $stages[0].logicalId
  ' <<<"$processed_template" >/dev/null

live_stage="$(
  aws apigatewayv2 get-stage \
    --api-id "$API_ID" \
    --stage-name "$API_STAGE_NAME" \
    --region "$AWS_REGION" \
    --output json
)"
if legacy_stage="$(
  aws apigatewayv2 get-stage \
    --api-id "$API_ID" \
    --stage-name '$default' \
    --region "$AWS_REGION" \
    --output json 2>&1
)"; then
  echo "The legacy unscoped default API stage still exists." >&2
  exit 1
elif ! grep -Eqi 'NotFoundException|not found' <<<"$legacy_stage"; then
  echo "Unable to prove that the legacy default API stage is absent." >&2
  exit 1
fi
#
# Source and runtime use the same canonical log-group ARN. A LogGroup.Arn
# GetAtt would append ":*", which API Gateway strips and CloudFormation then
# reports as perpetual drift.
expected_log_arn="arn:aws:logs:${AWS_REGION}:${AWS_ACCOUNT_ID}:log-group:${API_ACCESS_LOG_GROUP}"

if ! jq -e \
  --arg stage "$API_STAGE_NAME" \
  --arg logArn "$expected_log_arn" \
  '
    .StageName == $stage
      and .AutoDeploy == true
      and .DefaultRouteSettings.DetailedMetricsEnabled == true
      and .DefaultRouteSettings.ThrottlingRateLimit == 5
      and .DefaultRouteSettings.ThrottlingBurstLimit == 10
      and ((.RouteSettings // {}) | length) == 0
      and .AccessLogSettings.DestinationArn == $logArn
      and (.AccessLogSettings.Format | contains("$context.requestId"))
      and (.AccessLogSettings.Format | contains("$context.stage"))
      and (.AccessLogSettings.Format | contains("$context.routeKey"))
      and (.AccessLogSettings.Format | contains("$context.status"))
  ' <<<"$live_stage" >/dev/null; then
  echo "The live API stage does not match the protected runtime control and access-log contract." >&2
  exit 1
fi

aws cloudfront wait distribution-deployed \
  --id "$DISTRIBUTION_ID"
distribution_status="$(
  aws cloudfront get-distribution \
    --id "$DISTRIBUTION_ID" \
    --query 'Distribution.Status' \
    --output text
)"
if [ "$distribution_status" != "Deployed" ]; then
  echo "CloudFront did not reach the deployed state." >&2
  exit 1
fi
cloudfront_config="$(
  aws cloudfront get-distribution-config \
    --id "$DISTRIBUTION_ID" \
    --output json
)"
expected_origin_domain="${API_ID}.execute-api.${AWS_REGION}.amazonaws.com"
jq -e \
  --arg originPath "/${API_STAGE_NAME}" \
  --arg originDomain "$expected_origin_domain" \
  '
    [
      .DistributionConfig.Origins.Items[]
      | select(.Id == "ApiOrigin")
    ] as $apiOrigins
    | ($apiOrigins | length) == 1
      and $apiOrigins[0].OriginPath == $originPath
      and $apiOrigins[0].DomainName == $originDomain
  ' <<<"$cloudfront_config" >/dev/null

direct_health="$(
  curl --fail --silent --show-error \
    --retry 3 --retry-delay 2 --retry-all-errors \
    --max-time 30 \
    "$API_ENDPOINT/api/health"
)"
jq -e '.ok == true and .status == "reachable"' \
  <<<"$direct_health" >/dev/null

start_ms="$((($(date +%s) - 2) * 1000))"
same_origin_health="$(
  curl --fail --silent --show-error \
    --retry 3 --retry-delay 2 --retry-all-errors \
    --max-time 30 \
    "$APPLICATION_URL/api/health"
)"
jq -e '.ok == true and .status == "reachable"' \
  <<<"$same_origin_health" >/dev/null

for attempt in $(seq 1 12); do
  streams="$(
    aws logs describe-log-streams \
      --log-group-name "$API_ACCESS_LOG_GROUP" \
      --order-by LastEventTime \
      --descending \
      --max-items 1 \
      --region "$AWS_REGION" \
      --output json
  )"
  events="$(
    aws logs filter-log-events \
      --log-group-name "$API_ACCESS_LOG_GROUP" \
      --start-time "$start_ms" \
      --limit 100 \
      --no-paginate \
      --region "$AWS_REGION" \
      --output json
  )"

  if jq -e '.logStreams | length > 0' <<<"$streams" >/dev/null &&
    jq -e \
      '
        [
          .events[].message
          | fromjson?
          | select(
              .stage == "live"
              and .routeKey == "GET /api/health"
              and (.status | tostring) == "200"
              and (.requestId | type == "string" and length > 0)
            )
        ]
        | length > 0
      ' <<<"$events" >/dev/null; then
    jq -n \
      --arg stage "$API_STAGE_NAME" \
      --arg logGroup "$API_ACCESS_LOG_GROUP" \
      '{
        ok: true,
        stage: $stage,
        legacyDefaultStageAbsent: true,
        detailedMetrics: true,
        throttlingRate: 5,
        throttlingBurst: 10,
        cloudFrontStatus: "Deployed",
        cloudFrontOriginPath: "/live",
        directStageHealth: "GET /live/api/health 200",
        sameOriginHealth: "GET /api/health 200",
        accessLogGroup: $logGroup,
        accessLogEvent: "GET /api/health 200"
      }'
    exit 0
  fi

  if [ "$attempt" -lt 12 ]; then
    sleep 5
  fi
done

echo "No matching API Gateway access-log event arrived within 60 seconds." >&2
exit 1
