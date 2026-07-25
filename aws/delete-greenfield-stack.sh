#!/usr/bin/env bash
# Delete a failed first deployment and the three deterministic resources whose
# retention policies intentionally outlive normal stack deletion.
set -euo pipefail

for name in \
  APP_NAME \
  ENVIRONMENT \
  AWS_ACCOUNT_ID \
  AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN \
  AWS_REGION \
  STACK_NAME; do
  if [ -z "${!name:-}" ]; then
    echo "$name is required for greenfield cleanup." >&2
    exit 1
  fi
done

[[ "$APP_NAME" =~ ^[a-z0-9][a-z0-9-]*$ ]]
[[ "$AWS_ACCOUNT_ID" =~ ^[0-9]{12}$ ]]
if [ "$ENVIRONMENT" != "staging" ] &&
   [ "$ENVIRONMENT" != "production" ]; then
  echo "Greenfield cleanup is limited to staging or production." >&2
  exit 1
fi
if [ "$AWS_REGION" != "eu-west-1" ]; then
  echo "Greenfield cleanup is limited to eu-west-1." >&2
  exit 1
fi
if [ "$STACK_NAME" != "${APP_NAME}-${ENVIRONMENT}" ]; then
  echo "The stack name does not match the exact application environment." >&2
  exit 1
fi

bucket="${APP_NAME}-${ENVIRONMENT}-web-${AWS_ACCOUNT_ID}-${AWS_REGION}"
legacy_api_log_group="/aws/apigateway/${APP_NAME}-${ENVIRONMENT}"
lambda_log_group="/aws/lambda/${APP_NAME}-${ENVIRONMENT}-api"

stack_deleted=false
if stack_state="$(
  aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --region "$AWS_REGION" \
    --output json 2>&1
)"; then
  aws cloudformation delete-stack \
    --stack-name "$STACK_NAME" \
    --region "$AWS_REGION" \
    --role-arn "$AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN"
  aws cloudformation wait stack-delete-complete \
    --stack-name "$STACK_NAME" \
    --region "$AWS_REGION"
  stack_deleted=true
elif ! grep -qi "does not exist" <<<"$stack_state"; then
  echo "Unable to determine the failed greenfield stack state." >&2
  exit 1
fi

delete_file="$(mktemp)"
trap 'rm -f "$delete_file"' EXIT
bucket_deleted=false
if bucket_state="$(
  aws s3api get-bucket-location \
    --bucket "$bucket" \
    --region "$AWS_REGION" \
    --output json 2>&1
)"; then
  emptied=false
  for attempt in $(seq 1 101); do
    inventory="$(
      aws s3api list-object-versions \
        --bucket "$bucket" \
        --max-keys 1000 \
        --no-paginate \
        --region "$AWS_REGION" \
        --output json
    )"
    object_count="$(
      jq -er \
        '[.Versions[]?, .DeleteMarkers[]?] | length' \
        <<<"$inventory"
    )"
    if [ "$object_count" -eq 0 ]; then
      emptied=true
      break
    fi
    if [ "$attempt" -eq 101 ]; then
      echo "Greenfield bucket cleanup exceeded 100 bounded batches." >&2
      exit 1
    fi
    jq -e \
      '{
        Objects: [
          (.Versions[]?, .DeleteMarkers[]?)
          | {Key: .Key, VersionId: .VersionId}
        ],
        Quiet: true
      }' <<<"$inventory" >"$delete_file"
    delete_result="$(
      aws s3api delete-objects \
        --bucket "$bucket" \
        --delete "file://${delete_file}" \
        --region "$AWS_REGION" \
        --output json
    )"
    jq -e '((.Errors // []) | length) == 0' \
      <<<"$delete_result" >/dev/null
  done
  if [ "$emptied" != "true" ]; then
    echo "The retained greenfield bucket was not emptied." >&2
    exit 1
  fi

  aws s3api delete-bucket \
    --bucket "$bucket" \
    --region "$AWS_REGION"
  bucket_deleted=true
elif ! grep -Eqi 'NoSuchBucket|Not Found|\(404\)' <<<"$bucket_state"; then
  echo "Unable to determine the retained greenfield bucket state." >&2
  exit 1
fi

deleted_log_groups=0
delete_log_group_if_present() {
  local log_group="$1"
  local delete_result
  if delete_result="$(
    aws logs delete-log-group \
      --log-group-name "$log_group" \
      --region "$AWS_REGION" 2>&1
  )"; then
    deleted_log_groups=$((deleted_log_groups + 1))
  elif ! grep -qi "ResourceNotFoundException" <<<"$delete_result"; then
    echo "Unable to delete an exact retained greenfield log group." >&2
    return 1
  fi
}

delete_log_group_if_present "$legacy_api_log_group"
delete_log_group_if_present "$lambda_log_group"

jq -n \
  --arg stack "$STACK_NAME" \
  --argjson stackDeleted "$stack_deleted" \
  --argjson bucketDeleted "$bucket_deleted" \
  --argjson logGroupsDeleted "$deleted_log_groups" \
  '{
    ok: true,
    state: "greenfield-cleaned",
    stack: $stack,
    stackDeleted: $stackDeleted,
    retainedBucketDeleted: $bucketDeleted,
    retainedLogGroupsDeleted: $logGroupsDeleted
  }'
