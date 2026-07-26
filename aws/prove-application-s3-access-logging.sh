#!/usr/bin/env bash
# Fail-closed proof for staging/production web-bucket server access logging.
#
# Usage:
#   prove-application-s3-access-logging.sh preflight
#   APPLICATION_S3_ACCESS_LOGGING_PREFLIGHT_FILE=... \
#     prove-application-s3-access-logging.sh validate-preflight
#   APPLICATION_S3_ACCESS_LOGGING_PREFLIGHT_FILE=... \
#     prove-application-s3-access-logging.sh verify
#   APPLICATION_S3_ACCESS_LOGGING_PREFLIGHT_FILE=... \
#     prove-application-s3-access-logging.sh recover
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 [preflight|validate-preflight|verify|recover]" >&2
  exit 1
fi
mode="$1"
case "$mode" in
  preflight|validate-preflight|verify|recover) ;;
  *)
    echo "Usage: $0 [preflight|validate-preflight|verify|recover]" >&2
    exit 1
    ;;
esac

for name in APP_NAME AWS_ACCOUNT_ID AWS_REGION ENVIRONMENT; do
  if [ -z "${!name:-}" ]; then
    echo "$name is required for the application S3 access-logging proof." >&2
    exit 1
  fi
done

if [ "$AWS_REGION" != "eu-west-1" ]; then
  echo "Application S3 access logging is restricted to eu-west-1." >&2
  exit 1
fi
if ! [[ "$AWS_ACCOUNT_ID" =~ ^[0-9]{12}$ ]]; then
  echo "AWS_ACCOUNT_ID must be an exact 12-digit account id." >&2
  exit 1
fi
if ! [[ "$APP_NAME" =~ ^[a-z][a-z0-9-]{2,24}$ ]]; then
  echo "APP_NAME is not a valid deterministic bucket-name prefix." >&2
  exit 1
fi
case "$ENVIRONMENT" in
  staging|production) ;;
  *)
    echo "ENVIRONMENT must be exactly staging or production." >&2
    exit 1
    ;;
esac

# Every AWS-reading mode proves the permanent centralized foundation. The pure
# validator is intentionally available before a recovery handler makes any AWS
# call or mutation.
if [ "$mode" != "validate-preflight" ] &&
   ! bash aws/prove-s3-access-logging.sh verify >/dev/null 2>&1; then
  echo "Unable to prove the centralized S3 access-logging foundation." >&2
  exit 1
fi

schema="archon.application-s3-access-logging.preflight"
schema_version=1
source_bucket="${APP_NAME}-${ENVIRONMENT}-web-${AWS_ACCOUNT_ID}-${AWS_REGION}"
destination_bucket="${APP_NAME}-s3-access-logs-${AWS_ACCOUNT_ID}-${AWS_REGION}"
target_prefix="${ENVIRONMENT}-web/"

expected_config="$(
  jq -cnS \
    --arg destination "$destination_bucket" \
    --arg prefix "$target_prefix" \
    '{
      LoggingEnabled: {
        TargetBucket: $destination,
        TargetPrefix: $prefix,
        TargetObjectKeyFormat: {
          PartitionedPrefix: {
            PartitionDateSource: "EventTime"
          }
        }
      }
    }'
)"

aws_json() {
  local label="$1"
  shift
  local result
  if ! result="$(aws "$@" --output json 2>&1)"; then
    echo "Unable to inspect ${label}." >&2
    return 1
  fi
  if [ -z "$result" ]; then
    result="{}"
  fi
  printf '%s\n' "$result"
}

observed_state=""
observed_logging="null"
inspect_application_bucket() {
  local result
  if result="$(
    aws s3api get-bucket-logging \
      --bucket "$source_bucket" \
      --expected-bucket-owner "$AWS_ACCOUNT_ID" \
      --region "$AWS_REGION" \
      --output json 2>&1
  )"; then
    if [ -z "$result" ]; then
      result="{}"
    fi
    if jq -e \
        --argjson expected "$expected_config" \
        '. == $expected' <<<"$result" >/dev/null 2>&1; then
      observed_state="enabled"
      observed_logging="$expected_config"
      return 0
    fi
    if jq -e \
        'type == "object" and (keys | length) == 0' \
        <<<"$result" >/dev/null 2>&1; then
      observed_state="disabled"
      observed_logging="{}"
      return 0
    fi
    echo "The application web bucket logging state is ambiguous or drifted." >&2
    return 1
  fi

  if [[ "$result" =~ (^|[^[:alnum:]])NoSuchBucket([^[:alnum:]]|$) ]]; then
    observed_state="absent"
    observed_logging="null"
    return 0
  fi
  echo "Unable to inspect the application web bucket logging state." >&2
  return 1
}

sha256_text() {
  printf '%s' "$1" | sha256sum | awk '{print $1}'
}

preflight_json=""
preflight_prior_state=""
preflight_integrity="null"
expected_stack_state=""
load_preflight() {
  local calculated canonical claimed path
  path="${APPLICATION_S3_ACCESS_LOGGING_PREFLIGHT_FILE:-}"
  if [ -z "$path" ] || [ ! -f "$path" ] || [ ! -r "$path" ]; then
    echo "A readable application S3 access-logging preflight receipt is required." >&2
    return 1
  fi

  preflight_json="$(<"$path")"
  if [ -z "$preflight_json" ] || [ "${#preflight_json}" -gt 16384 ]; then
    echo "The application S3 access-logging preflight receipt is invalid." >&2
    return 1
  fi

  if ! jq -e \
      --arg schema "$schema" \
      --arg environment "$ENVIRONMENT" \
      --arg source "$source_bucket" \
      --arg destination "$destination_bucket" \
      --argjson version "$schema_version" \
      --argjson expected "$expected_config" \
      '
        type == "object"
        and (keys | sort) == ([
          "destinationBucket",
          "environment",
          "evidence",
          "expected",
          "foundationVerified",
          "integrity",
          "mode",
          "ok",
          "priorState",
          "schema",
          "sourceBucket",
          "version"
        ] | sort)
        and .ok == true
        and .schema == $schema
        and .version == $version
        and .mode == "preflight"
        and .evidence == "live-control-plane"
        and .foundationVerified == true
        and .environment == $environment
        and .sourceBucket == $source
        and .destinationBucket == $destination
        and (
          .priorState == "absent"
          or .priorState == "disabled"
          or .priorState == "enabled"
        )
        and .expected == $expected
        and (
          .integrity
          | type == "object"
          and (keys | sort) == ([
            "algorithm",
            "canonicalization",
            "payloadSha256"
          ] | sort)
          and .algorithm == "sha256"
          and .canonicalization == "jq-cS-v1"
          and (
            .payloadSha256
            | type == "string"
            and test("^[0-9a-f]{64}$")
          )
        )
      ' <<<"$preflight_json" >/dev/null 2>&1; then
    echo "The application S3 access-logging preflight receipt is invalid." >&2
    return 1
  fi

  canonical="$(
    jq -cS 'del(.integrity)' <<<"$preflight_json" 2>/dev/null
  )" || {
    echo "The application S3 access-logging preflight receipt is invalid." >&2
    return 1
  }
  claimed="$(
    jq -er '.integrity.payloadSha256' <<<"$preflight_json" 2>/dev/null
  )" || {
    echo "The application S3 access-logging preflight receipt is invalid." >&2
    return 1
  }
  calculated="$(sha256_text "$canonical")"
  if [ "$claimed" != "$calculated" ]; then
    echo "The application S3 access-logging preflight integrity check failed." >&2
    return 1
  fi

  preflight_prior_state="$(
    jq -er '.priorState' <<<"$preflight_json" 2>/dev/null
  )"
  preflight_integrity="$(
    jq -c '.integrity' <<<"$preflight_json" 2>/dev/null
  )"

  expected_stack_state="${EXPECTED_STACK_STATE:-}"
  case "$expected_stack_state:$preflight_prior_state" in
    greenfield:absent|existing:disabled|existing:enabled) ;;
    *)
      echo "The application stack and bucket preflight states are inconsistent." >&2
      return 1
      ;;
  esac
}

case "$mode" in
  validate-preflight)
    load_preflight
    jq -n \
      --arg environment "$ENVIRONMENT" \
      --arg priorState "$preflight_prior_state" \
      --arg stackState "$expected_stack_state" \
      --argjson integrity "$preflight_integrity" \
      '{
        ok: true,
        schema: "archon.application-s3-access-logging.preflight-validation",
        version: 1,
        environment: $environment,
        stackState: $stackState,
        priorState: $priorState,
        integrity: $integrity
      }'
    ;;

  preflight)
    inspect_application_bucket
    payload="$(
      jq -cnS \
        --arg schema "$schema" \
        --arg environment "$ENVIRONMENT" \
        --arg source "$source_bucket" \
        --arg destination "$destination_bucket" \
        --arg priorState "$observed_state" \
        --argjson version "$schema_version" \
        --argjson expected "$expected_config" \
        '{
          ok: true,
          schema: $schema,
          version: $version,
          mode: "preflight",
          evidence: "live-control-plane",
          foundationVerified: true,
          environment: $environment,
          sourceBucket: $source,
          destinationBucket: $destination,
          priorState: $priorState,
          expected: $expected
        }'
    )"
    payload_sha256="$(sha256_text "$payload")"
    jq -n \
      --argjson payload "$payload" \
      --arg digest "$payload_sha256" \
      '$payload + {
        integrity: {
          algorithm: "sha256",
          canonicalization: "jq-cS-v1",
          payloadSha256: $digest
        }
      }'
    ;;

  verify)
    load_preflight
    if [ -z "${STACK_NAME:-}" ] ||
       [ -z "${AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN:-}" ]; then
      echo "STACK_NAME and AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN are required for application logging verification." >&2
      exit 1
    fi
    [[ "$AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN" =~ ^arn:aws:iam::${AWS_ACCOUNT_ID}:role/[A-Za-z0-9+=,.@_/-]+$ ]]
    expected_stack_prefix="arn:aws:cloudformation:${AWS_REGION}:${AWS_ACCOUNT_ID}:stack/${STACK_NAME}/"
    application_stack="$(
      aws_json \
        "the application CloudFormation stack" \
        cloudformation describe-stacks \
        --stack-name "$STACK_NAME" \
        --region "$AWS_REGION"
    )"
    if ! jq -e \
        --arg stack "$STACK_NAME" \
        --arg app "$APP_NAME" \
        --arg environment "$ENVIRONMENT" \
        --arg source "$source_bucket" \
        --arg expectedStackState "$expected_stack_state" \
        --arg stackPrefix "$expected_stack_prefix" \
        --arg role "$AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN" \
        '
          (.Stacks | length) == 1
          and .Stacks[0].StackName == $stack
          and (.Stacks[0].StackId | startswith($stackPrefix))
          and .Stacks[0].RoleARN == $role
          and (
            (
              $expectedStackState == "greenfield"
              and .Stacks[0].StackStatus == "CREATE_COMPLETE"
            )
            or (
              $expectedStackState == "existing"
              and (
                .Stacks[0].StackStatus == "CREATE_COMPLETE"
                or .Stacks[0].StackStatus == "UPDATE_COMPLETE"
                or .Stacks[0].StackStatus == "UPDATE_ROLLBACK_COMPLETE"
              )
            )
          )
          and (
            [.Stacks[0].Parameters[]
              | select(.ParameterKey == "AppName")
              | .ParameterValue] == [$app]
          )
          and (
            [.Stacks[0].Parameters[]
              | select(.ParameterKey == "Environment")
              | .ParameterValue] == [$environment]
          )
          and (
            [.Stacks[0].Outputs[]
              | select(.OutputKey == "SpaBucketName")
              | .OutputValue] == [$source]
          )
        ' <<<"$application_stack" >/dev/null 2>&1; then
      echo "The application CloudFormation stack state is invalid." >&2
      exit 1
    fi
    stack_status="$(
      jq -er '.Stacks[0].StackStatus' <<<"$application_stack" 2>/dev/null
    )"
    stack_id="$(
      jq -er '.Stacks[0].StackId' <<<"$application_stack" 2>/dev/null
    )"
    stack_fingerprint="$(
      jq -cS '
        .Stacks[0]
        | {
            CreationTime,
            LastUpdatedTime,
            Outputs: ((.Outputs // []) | sort_by(.OutputKey)),
            Parameters: ((.Parameters // []) | sort_by(.ParameterKey)),
            RoleARN,
            StackId,
            StackName,
            StackStatus,
            Tags: ((.Tags // []) | sort_by(.Key))
          }
      ' <<<"$application_stack"
    )"

    processed_template="$(
      aws_json \
        "the processed application CloudFormation template" \
        cloudformation get-template \
        --stack-name "$stack_id" \
        --template-stage Processed \
        --region "$AWS_REGION"
    )"
    application_stack_recheck="$(
      aws_json \
        "the stable application CloudFormation stack" \
        cloudformation describe-stacks \
        --stack-name "$stack_id" \
        --region "$AWS_REGION"
    )"
    test "$(
      jq -cS '
        .Stacks[0]
        | {
            CreationTime,
            LastUpdatedTime,
            Outputs: ((.Outputs // []) | sort_by(.OutputKey)),
            Parameters: ((.Parameters // []) | sort_by(.ParameterKey)),
            RoleARN,
            StackId,
            StackName,
            StackStatus,
            Tags: ((.Tags // []) | sort_by(.Key))
          }
      ' <<<"$application_stack_recheck"
    )" = "$stack_fingerprint"
    if ! processed_template_body="$(
      jq -ce '
        .TemplateBody
        | if type == "object" then
            .
          elif type == "string" then
            fromjson
          else
            error("invalid processed template body")
          end
      ' <<<"$processed_template" 2>/dev/null
    )"; then
      echo "The processed application template body is invalid." >&2
      exit 1
    fi
    if ! jq -e \
        --arg destinationSub \
          '${AppName}-s3-access-logs-${AWS::AccountId}-${AWS::Region}' \
        --arg prefixSub '${Environment}-web/' \
        '
          .Resources.SpaBucket.Type == "AWS::S3::Bucket"
          and (
            .Resources.SpaBucket.Properties.LoggingConfiguration
            == {
              "DestinationBucketName": {"Fn::Sub": $destinationSub},
              "LogFilePrefix": {"Fn::Sub": $prefixSub},
              "TargetObjectKeyFormat": {
                "PartitionedPrefix": {
                  "PartitionDateSource": "EventTime"
                }
              }
            }
          )
        ' <<<"$processed_template_body" >/dev/null 2>&1; then
      echo "The processed application template does not own the exact logging configuration." >&2
      exit 1
    fi

    inspect_application_bucket
    if [ "$observed_state" != "enabled" ]; then
      echo "The application web bucket does not have the exact logging configuration." >&2
      exit 1
    fi
    jq -n \
      --arg environment "$ENVIRONMENT" \
      --arg source "$source_bucket" \
      --arg destination "$destination_bucket" \
      --arg priorState "$preflight_prior_state" \
      --arg stackState "$expected_stack_state" \
      --arg stackStatus "$stack_status" \
      --argjson expected "$expected_config" \
      --argjson integrity "$preflight_integrity" \
      '{
        ok: true,
        schema: "archon.application-s3-access-logging.proof",
        version: 1,
        mode: "verify",
        evidence: "live-control-plane",
        foundationVerified: true,
        processedTemplateManaged: true,
        environment: $environment,
        sourceBucket: $source,
        destinationBucket: $destination,
        stackState: $stackState,
        stackStatus: $stackStatus,
        priorState: $priorState,
        liveState: "enabled",
        expected: $expected,
        liveConfiguration: $expected,
        preflightIntegrity: $integrity
      }'
    ;;

  recover)
    load_preflight
    inspect_application_bucket
    if [ "$observed_state" != "$preflight_prior_state" ]; then
      echo "The application web bucket was not restored to its preflight state." >&2
      exit 1
    fi
    jq -n \
      --arg environment "$ENVIRONMENT" \
      --arg source "$source_bucket" \
      --arg destination "$destination_bucket" \
      --arg priorState "$preflight_prior_state" \
      --arg restoredState "$observed_state" \
      --arg stackState "$expected_stack_state" \
      --argjson expected "$expected_config" \
      --argjson restored "$observed_logging" \
      --argjson integrity "$preflight_integrity" \
      '{
        ok: true,
        schema: "archon.application-s3-access-logging.recovery",
        version: 1,
        mode: "recover",
        evidence: "live-control-plane",
        foundationVerified: true,
        environment: $environment,
        sourceBucket: $source,
        destinationBucket: $destination,
        stackState: $stackState,
        priorState: $priorState,
        restoredState: $restoredState,
        expected: $expected,
        restoredConfiguration: $restored,
        preflightIntegrity: $integrity
      }'
    ;;
esac
