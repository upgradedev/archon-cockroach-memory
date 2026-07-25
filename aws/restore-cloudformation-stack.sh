#!/usr/bin/env bash
# Restore an existing application stack from the exact pre-deployment template
# and parameter snapshots captured by the protected release job.
set -euo pipefail

for name in STACK_NAME AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN AWS_REGION; do
  if [ -z "${!name:-}" ]; then
    echo "$name is required for CloudFormation recovery." >&2
    exit 1
  fi
done

template_file="${PREVIOUS_STACK_TEMPLATE_FILE:-previous-stack-template.yaml}"
parameters_file="${PREVIOUS_STACK_PARAMETERS_FILE:-previous-stack-parameters.json}"
if [ ! -s "$template_file" ] || [ ! -s "$parameters_file" ]; then
  echo "The previous CloudFormation template and parameters are required." >&2
  exit 1
fi

# TemplateBody has a hard 51,200-byte API limit. The release captures and checks
# this before mutation as well, so recovery never discovers an unusable snapshot
# only after the stack has changed.
if [ "$(wc -c <"$template_file")" -gt 51200 ]; then
  echo "The captured recovery template exceeds CloudFormation TemplateBody limits." >&2
  exit 1
fi

jq -e \
  'type == "array"
   and length > 0
   and all(.[];
     ((keys | sort) == ["ParameterKey", "ParameterValue"])
     and
     (.ParameterKey | type == "string" and length > 0)
     and (.ParameterValue | type == "string"))' \
  "$parameters_file" >/dev/null

change_set_name="archon-recovery-${GITHUB_RUN_ID:-manual}-${GITHUB_RUN_ATTEMPT:-1}-${RANDOM}"
aws cloudformation create-change-set \
  --stack-name "$STACK_NAME" \
  --change-set-name "$change_set_name" \
  --change-set-type UPDATE \
  --template-body "file://${template_file}" \
  --parameters "file://${parameters_file}" \
  --capabilities CAPABILITY_AUTO_EXPAND \
  --role-arn "$AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN" \
  --description "Restore the exact pre-deployment Archon application stack" \
  --region "$AWS_REGION" \
  --output json >/dev/null

if ! aws cloudformation wait change-set-create-complete \
  --stack-name "$STACK_NAME" \
  --change-set-name "$change_set_name" \
  --region "$AWS_REGION"; then
  change_set="$(
    aws cloudformation describe-change-set \
      --stack-name "$STACK_NAME" \
      --change-set-name "$change_set_name" \
      --region "$AWS_REGION" \
      --output json
  )"
  if jq -e \
    '.Status == "FAILED"
     and (.StatusReason | contains("contain changes"))' \
    <<<"$change_set" >/dev/null; then
    aws cloudformation delete-change-set \
      --stack-name "$STACK_NAME" \
      --change-set-name "$change_set_name" \
      --region "$AWS_REGION"
    exit 0
  fi
  echo "The recovery change set could not be created." >&2
  exit 1
fi

aws cloudformation execute-change-set \
  --stack-name "$STACK_NAME" \
  --change-set-name "$change_set_name" \
  --region "$AWS_REGION"
aws cloudformation wait stack-update-complete \
  --stack-name "$STACK_NAME" \
  --region "$AWS_REGION"
