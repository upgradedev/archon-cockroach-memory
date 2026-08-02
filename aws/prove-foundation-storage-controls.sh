#!/usr/bin/env bash
set -euo pipefail

authority_state="${1:-ignore}"
case "$authority_state" in
  ignore|retired) ;;
  *)
    echo "Usage: $0 [ignore|retired]" >&2
    exit 1
    ;;
esac

: "${APP_NAME:?}"
: "${AWS_ACCOUNT_ID:?}"
: "${AWS_REGION:?}"
: "${GITHUB_REPOSITORY:?}"
: "${GITHUB_REPOSITORY_ID:?}"
: "${GITHUB_REPOSITORY_OWNER_ID:?}"

test "$AWS_REGION" = "eu-west-1"
[[ "$AWS_ACCOUNT_ID" =~ ^[0-9]{12}$ ]]
[[ "$APP_NAME" =~ ^[a-z][a-z0-9-]{2,16}$ ]]
[[ "$GITHUB_REPOSITORY_ID" =~ ^[1-9][0-9]*$ ]]
[[ "$GITHUB_REPOSITORY_OWNER_ID" =~ ^[1-9][0-9]*$ ]]
test "$GITHUB_REPOSITORY" = "upgradedev/archon-cockroach-memory"

stack_name="${APP_NAME}-delivery-bootstrap"
artifact_bucket="${APP_NAME}-artifacts-${AWS_ACCOUNT_ID}-${AWS_REGION}"
archive_bucket="${APP_NAME}-s3-access-logs-${AWS_ACCOUNT_ID}-${AWS_REGION}"
cloudfront_log_bucket="${APP_NAME}-cloudfront-access-logs-${AWS_ACCOUNT_ID}-${AWS_REGION}"

work_dir="$(mktemp -d)"
cleanup() {
  rm -rf -- "$work_dir"
}
trap cleanup EXIT

stack_file="$work_dir/stack.json"
outputs_file="$work_dir/outputs.json"
key_file="$work_dir/key.json"
rotation_file="$work_dir/rotation.json"
alias_key_file="$work_dir/alias-key.json"
key_policy_file="$work_dir/key-policy.json"
log_key_file="$work_dir/log-key.json"
log_rotation_file="$work_dir/log-rotation.json"
log_alias_key_file="$work_dir/log-alias-key.json"
log_key_policy_file="$work_dir/log-key-policy.json"
artifact_encryption_file="$work_dir/artifact-encryption.json"
artifact_policy_file="$work_dir/artifact-policy.json"
cloudfront_encryption_file="$work_dir/cloudfront-encryption.json"
cloudfront_policy_file="$work_dir/cloudfront-policy.json"
cloudfront_ownership_file="$work_dir/cloudfront-ownership.json"
cloudfront_public_access_file="$work_dir/cloudfront-public-access.json"
cloudfront_versioning_file="$work_dir/cloudfront-versioning.json"
cloudfront_logging_file="$work_dir/cloudfront-logging.json"
staging_secret_file="$work_dir/staging-secret.json"
production_secret_file="$work_dir/production-secret.json"
edge_role_file="$work_dir/edge-control-role.json"
finops_control_role_file="$work_dir/finops-control-role.json"
finops_control_policy_file="$work_dir/finops-control-policy.json"
finops_execution_role_file="$work_dir/finops-execution-role.json"
finops_execution_policy_file="$work_dir/finops-execution-policy.json"
alarm_control_role_file="$work_dir/alarm-control-role.json"
alarm_control_policy_file="$work_dir/alarm-control-policy.json"
alarm_execution_role_file="$work_dir/alarm-execution-role.json"
alarm_execution_policy_file="$work_dir/alarm-execution-policy.json"

aws cloudformation describe-stacks \
  --stack-name "$stack_name" \
  --region "$AWS_REGION" \
  --output json >"$stack_file"

jq -e \
  --arg stack "$stack_name" \
  '
    (.Stacks | length) == 1
    and .Stacks[0].StackName == $stack
    and (
      .Stacks[0].StackStatus == "UPDATE_COMPLETE"
      or .Stacks[0].StackStatus == "UPDATE_ROLLBACK_COMPLETE"
    )
  ' "$stack_file" >/dev/null
stack_status="$(jq -er '.Stacks[0].StackStatus' "$stack_file")"
alarm_routing_active="$(
  jq -r '
    [
      .Stacks[0].Parameters[]
      | select(.ParameterKey == "AlarmRoutingEnabled")
      | .ParameterValue
    ] == ["true"]
  ' "$stack_file"
)"

jq -e '
  .Stacks[0].Outputs
  | map({key:.OutputKey, value:.OutputValue})
  | from_entries
' "$stack_file" >"$outputs_file"

storage_key_arn="$(
  jq -er '.ApplicationStorageKeyArn | strings' "$outputs_file"
)"
storage_alias_arn="$(
  jq -er '.ApplicationStorageKeyAliasArn | strings' "$outputs_file"
)"
log_key_arn="$(
  jq -er '.CloudFrontAccessLogKeyArn | strings' "$outputs_file"
)"
log_alias_arn="$(
  jq -er '.CloudFrontAccessLogKeyAliasArn | strings' "$outputs_file"
)"
staging_secret_arn="$(
  jq -er '.StagingOriginVerifySecretArn | strings' "$outputs_file"
)"
production_secret_arn="$(
  jq -er '.ProductionOriginVerifySecretArn | strings' "$outputs_file"
)"
edge_role_arn="$(
  jq -er '.EdgeControlRoleArn | strings' "$outputs_file"
)"
finops_control_role_arn="$(
  jq -er '.FinOpsControlRoleArn | strings' "$outputs_file"
)"
finops_execution_role_arn="$(
  jq -er '.FinOpsCloudFormationExecutionRoleArn | strings' "$outputs_file"
)"
alarm_control_role_arn="$(
  jq -er '.AlarmRoutingControlRoleArn | strings' "$outputs_file"
)"
alarm_execution_role_arn="$(
  jq -er '.AlarmRoutingCloudFormationExecutionRoleArn | strings' \
    "$outputs_file"
)"

jq -e \
  --arg executionRole "$alarm_execution_role_arn" \
  '
    [
      .Stacks[0].Parameters[]
      | select(.ParameterKey == "AlarmRoutingEnabled")
      | .ParameterValue
    ] as $switch
    | ($switch == ["false"] or $switch == ["true"])
    and (
      if $switch == ["true"]
      then .Stacks[0].RoleARN == $executionRole
      else (
        ((.Stacks[0].RoleARN // null) == null)
        or .Stacks[0].RoleARN == $executionRole
      )
      end
    )
  ' "$stack_file" >/dev/null

jq -e \
  --arg account "$AWS_ACCOUNT_ID" \
  --arg region "$AWS_REGION" \
  --arg app "$APP_NAME" \
  --arg artifact "$artifact_bucket" \
  --arg cloudfrontLogs "$cloudfront_log_bucket" \
  '
    .ArtifactBucketName == $artifact
    and .CloudFrontAccessLogBucketName == $cloudfrontLogs
    and .EdgeControlRoleArn
      == (
        "arn:aws:iam::" + $account
        + ":role/" + $app + "-github-edge-controls"
      )
    and .FinOpsControlRoleArn
      == (
        "arn:aws:iam::" + $account
        + ":role/" + $app + "-github-finops-controls"
      )
    and .FinOpsCloudFormationExecutionRoleArn
      == (
        "arn:aws:iam::" + $account
        + ":role/" + $app + "-finops-cloudformation-execution"
      )
    and .AlarmRoutingControlRoleArn
      == (
        "arn:aws:iam::" + $account
        + ":role/" + $app + "-github-alarm-routing-controls"
      )
    and .AlarmRoutingCloudFormationExecutionRoleArn
      == (
        "arn:aws:iam::" + $account
        + ":role/" + $app
        + "-alarm-routing-cloudformation-execution"
      )
    and (
      .ApplicationStorageKeyArn
      | test(
          "^arn:aws:kms:" + $region + ":" + $account
          + ":key/[0-9a-f-]+$"
        )
    )
    and .ApplicationStorageKeyAliasArn
      == (
        "arn:aws:kms:" + $region + ":" + $account
        + ":alias/" + $app + "-storage"
      )
    and (
      .CloudFrontAccessLogKeyArn
      | test(
          "^arn:aws:kms:" + $region + ":" + $account
          + ":key/[0-9a-f-]+$"
        )
    )
    and .CloudFrontAccessLogKeyAliasArn
      == (
        "arn:aws:kms:" + $region + ":" + $account
        + ":alias/" + $app + "-cloudfront-logs"
      )
    and (
      .StagingOriginVerifySecretArn
      | test(
          "^arn:aws:secretsmanager:" + $region + ":" + $account
          + ":secret:" + $app
          + "/staging/origin-verification-[A-Za-z0-9]+$"
        )
    )
    and (
      .ProductionOriginVerifySecretArn
      | test(
          "^arn:aws:secretsmanager:" + $region + ":" + $account
          + ":secret:" + $app
          + "/production/origin-verification-[A-Za-z0-9]+$"
        )
    )
  ' "$outputs_file" >/dev/null

test "$storage_alias_arn" = \
  "arn:aws:kms:${AWS_REGION}:${AWS_ACCOUNT_ID}:alias/${APP_NAME}-storage"
test "$log_alias_arn" = \
  "arn:aws:kms:${AWS_REGION}:${AWS_ACCOUNT_ID}:alias/${APP_NAME}-cloudfront-logs"

aws kms describe-key \
  --key-id "$storage_key_arn" \
  --region "$AWS_REGION" \
  --output json >"$key_file"
aws kms describe-key \
  --key-id "alias/${APP_NAME}-storage" \
  --region "$AWS_REGION" \
  --output json >"$alias_key_file"
aws kms get-key-rotation-status \
  --key-id "$storage_key_arn" \
  --region "$AWS_REGION" \
  --output json >"$rotation_file"
aws kms get-key-policy \
  --key-id "$storage_key_arn" \
  --policy-name default \
  --region "$AWS_REGION" \
  --output json >"$key_policy_file"
aws kms describe-key \
  --key-id "$log_key_arn" \
  --region "$AWS_REGION" \
  --output json >"$log_key_file"
aws kms describe-key \
  --key-id "alias/${APP_NAME}-cloudfront-logs" \
  --region "$AWS_REGION" \
  --output json >"$log_alias_key_file"
aws kms get-key-rotation-status \
  --key-id "$log_key_arn" \
  --region "$AWS_REGION" \
  --output json >"$log_rotation_file"
aws kms get-key-policy \
  --key-id "$log_key_arn" \
  --policy-name default \
  --region "$AWS_REGION" \
  --output json >"$log_key_policy_file"

jq -e \
  --arg arn "$storage_key_arn" \
  '
    .KeyMetadata.Arn == $arn
    and .KeyMetadata.AWSAccountId == ($arn | split(":")[4])
    and .KeyMetadata.Enabled == true
    and .KeyMetadata.KeyManager == "CUSTOMER"
    and .KeyMetadata.KeySpec == "SYMMETRIC_DEFAULT"
    and .KeyMetadata.KeyUsage == "ENCRYPT_DECRYPT"
    and .KeyMetadata.MultiRegion == false
    and .KeyMetadata.Origin == "AWS_KMS"
  ' "$key_file" >/dev/null
jq -e \
  --arg arn "$storage_key_arn" \
  '.KeyMetadata.Arn == $arn' "$alias_key_file" >/dev/null
jq -e '.KeyRotationEnabled == true' "$rotation_file" >/dev/null
jq -e \
  --arg account "$AWS_ACCOUNT_ID" \
  --arg region "$AWS_REGION" \
  --arg stagingBucket \
    "arn:aws:s3:::${APP_NAME}-staging-web-${AWS_ACCOUNT_ID}-${AWS_REGION}" \
  --arg productionBucket \
    "arn:aws:s3:::${APP_NAME}-production-web-${AWS_ACCOUNT_ID}-${AWS_REGION}" \
  '
    (.Policy | fromjson).Statement as $statements
    | any(
        $statements[];
        .Sid == "AllowCloudFrontPrivateOriginRead"
        and .Effect == "Allow"
        and .Principal.Service == "cloudfront.amazonaws.com"
        and .Action == "kms:Decrypt"
        and .Condition.StringEquals["AWS:SourceAccount"] == $account
        and .Condition.StringEquals["kms:ViaService"]
          == ("s3." + $region + ".amazonaws.com")
        and .Condition.ArnLike["AWS:SourceArn"]
          == ("arn:aws:cloudfront::" + $account + ":distribution/*")
        and (
          .Condition.StringLike[
            "kms:EncryptionContext:aws:s3:arn"
          ] | sort
        ) == ([$stagingBucket, $productionBucket] | sort)
      )
    and all(
      $statements[];
      (.Principal.Service // "") != "delivery.logs.amazonaws.com"
    )
  ' "$key_policy_file" >/dev/null

jq -e \
  --arg arn "$log_key_arn" \
  '
    .KeyMetadata.Arn == $arn
    and .KeyMetadata.AWSAccountId == ($arn | split(":")[4])
    and .KeyMetadata.Enabled == true
    and .KeyMetadata.KeyManager == "CUSTOMER"
    and .KeyMetadata.KeySpec == "SYMMETRIC_DEFAULT"
    and .KeyMetadata.KeyUsage == "ENCRYPT_DECRYPT"
    and .KeyMetadata.MultiRegion == false
    and .KeyMetadata.Origin == "AWS_KMS"
  ' "$log_key_file" >/dev/null
jq -e \
  --arg arn "$log_key_arn" \
  '.KeyMetadata.Arn == $arn' "$log_alias_key_file" >/dev/null
jq -e '.KeyRotationEnabled == true' "$log_rotation_file" >/dev/null
jq -e '
  (.Policy | fromjson).Statement as $statements
  | any(
      $statements[];
      .Sid == "AllowCloudFrontAccessLogEncryption"
      and .Effect == "Allow"
      and .Principal.Service == "delivery.logs.amazonaws.com"
      and (.Action | sort)
        == (["kms:Decrypt", "kms:GenerateDataKey*"] | sort)
      and .Resource == "*"
      and ((.Condition // {}) | length) == 0
    )
  and all(
    $statements[];
    (.Principal.Service // "") != "cloudfront.amazonaws.com"
  )
' "$log_key_policy_file" >/dev/null

prove_secret_metadata() {
  local environment secret_arn output_file
  environment="$1"
  secret_arn="$2"
  output_file="$3"
  aws secretsmanager describe-secret \
    --secret-id "$secret_arn" \
    --region "$AWS_REGION" \
    --output json >"$output_file"
  jq -e \
    --arg arn "$secret_arn" \
    --arg name "${APP_NAME}/${environment}/origin-verification" \
    --arg key "$storage_key_arn" \
    '
      .ARN == $arn
      and .Name == $name
      and .KmsKeyId == $key
      and .DeletedDate == null
    ' "$output_file" >/dev/null
}

prove_secret_metadata \
  staging "$staging_secret_arn" "$staging_secret_file"
prove_secret_metadata \
  production "$production_secret_arn" "$production_secret_file"

aws iam get-role \
  --role-name "${APP_NAME}-github-edge-controls" \
  --output json >"$edge_role_file"
jq -e \
  --arg arn "$edge_role_arn" \
  --arg account "$AWS_ACCOUNT_ID" \
  --arg repository "$GITHUB_REPOSITORY" \
  --arg repositoryId "$GITHUB_REPOSITORY_ID" \
  --arg ownerId "$GITHUB_REPOSITORY_OWNER_ID" \
  '
    .Role.Arn == $arn
    and .Role.MaxSessionDuration == 3600
    and (.Role.AssumeRolePolicyDocument.Statement | length) == 1
    and (
      .Role.AssumeRolePolicyDocument.Statement[0]
      | .Effect == "Allow"
      and .Action == "sts:AssumeRoleWithWebIdentity"
      and .Principal.Federated
        == (
          "arn:aws:iam::" + $account
          + ":oidc-provider/token.actions.githubusercontent.com"
        )
      and .Condition.StringEquals[
        "token.actions.githubusercontent.com:aud"
      ] == "sts.amazonaws.com"
      and .Condition.StringEquals[
        "token.actions.githubusercontent.com:sub"
      ] == ("repo:" + $repository + ":environment:edge-controls")
      and .Condition.StringEquals[
        "token.actions.githubusercontent.com:repository"
      ] == $repository
      and .Condition.StringEquals[
        "token.actions.githubusercontent.com:repository_id"
      ] == $repositoryId
      and .Condition.StringEquals[
        "token.actions.githubusercontent.com:repository_owner_id"
      ] == $ownerId
      and .Condition.StringEquals[
        "token.actions.githubusercontent.com:ref"
      ] == "refs/heads/main"
      and .Condition.StringEquals[
        "token.actions.githubusercontent.com:environment"
      ] == "edge-controls"
      and .Condition.StringEquals[
        "token.actions.githubusercontent.com:workflow"
      ] == "Manage AWS Edge Controls"
    )
  ' "$edge_role_file" >/dev/null

aws iam get-role \
  --role-name "${APP_NAME}-github-finops-controls" \
  --output json >"$finops_control_role_file"
aws iam get-role-policy \
  --role-name "${APP_NAME}-github-finops-controls" \
  --policy-name manage-exact-finops-control-plane \
  --output json >"$finops_control_policy_file"
aws iam get-role \
  --role-name "${APP_NAME}-finops-cloudformation-execution" \
  --output json >"$finops_execution_role_file"
aws iam get-role-policy \
  --role-name "${APP_NAME}-finops-cloudformation-execution" \
  --policy-name finops-cloudformation-execution \
  --output json >"$finops_execution_policy_file"

jq -e \
  --arg arn "$finops_control_role_arn" \
  --arg account "$AWS_ACCOUNT_ID" \
  --arg repository "$GITHUB_REPOSITORY" \
  --arg repositoryId "$GITHUB_REPOSITORY_ID" \
  --arg ownerId "$GITHUB_REPOSITORY_OWNER_ID" \
  '
    .Role.Arn == $arn
    and .Role.MaxSessionDuration == 3600
    and (.Role.AssumeRolePolicyDocument.Statement | length) == 1
    and (
      .Role.AssumeRolePolicyDocument.Statement[0]
      | .Effect == "Allow"
      and .Action == "sts:AssumeRoleWithWebIdentity"
      and .Principal.Federated
        == (
          "arn:aws:iam::" + $account
          + ":oidc-provider/token.actions.githubusercontent.com"
        )
      and .Condition.StringEquals[
        "token.actions.githubusercontent.com:aud"
      ] == "sts.amazonaws.com"
      and .Condition.StringEquals[
        "token.actions.githubusercontent.com:sub"
      ] == ("repo:" + $repository + ":environment:finops-controls")
      and .Condition.StringEquals[
        "token.actions.githubusercontent.com:repository"
      ] == $repository
      and .Condition.StringEquals[
        "token.actions.githubusercontent.com:repository_id"
      ] == $repositoryId
      and .Condition.StringEquals[
        "token.actions.githubusercontent.com:repository_owner_id"
      ] == $ownerId
      and .Condition.StringEquals[
        "token.actions.githubusercontent.com:ref"
      ] == "refs/heads/main"
      and .Condition.StringEquals[
        "token.actions.githubusercontent.com:environment"
      ] == "finops-controls"
      and .Condition.StringEquals[
        "token.actions.githubusercontent.com:workflow"
      ] == "Manage AWS FinOps Controls"
    )
  ' "$finops_control_role_file" >/dev/null

jq -e \
  --arg account "$AWS_ACCOUNT_ID" \
  --arg app "$APP_NAME" \
  --arg executionRole "$finops_execution_role_arn" \
  '
    .RoleName == ($app + "-github-finops-controls")
    and .PolicyName == "manage-exact-finops-control-plane"
    and (.PolicyDocument.Statement | length) == 10
    and (.PolicyDocument.Statement | map(.Sid) | unique | length) == 10
    and (
      .PolicyDocument.Statement
      | map(
          select(.Sid == "ProveActiveApplicationCostAllocationTag")
        )
      | .[0]
      | .Action == "ce:ListCostAllocationTags"
      and .Resource == "*"
    )
    and (
      .PolicyDocument.Statement
      | map(select(.Sid == "CreateExactFinOpsChangeSets"))
      | .[0]
      | .Action == "cloudformation:CreateChangeSet"
      and (.Resource | sort) == ([
        (
          "arn:aws:cloudformation:us-east-1:" + $account
          + ":stack/" + $app + "-finops/*"
        ),
        (
          "arn:aws:cloudformation:us-east-1:" + $account
          + ":changeSet/finops-*/*"
        )
      ] | sort)
      and .Condition.StringEquals["cloudformation:RoleArn"]
        == $executionRole
    )
    and (
      .PolicyDocument.Statement
      | map(select(.Sid == "PlanAndApplyExactFinOpsStacks"))
      | .[0]
      | (.Resource | sort) == ([
          (
            "arn:aws:cloudformation:us-east-1:" + $account
            + ":stack/" + $app + "-finops/*"
          ),
          (
            "arn:aws:cloudformation:us-east-1:" + $account
            + ":changeSet/finops-*/*"
          )
        ] | sort)
    )
    and (
      .PolicyDocument.Statement
      | map(
          select(
            .Sid == "PassOnlyFinOpsCloudFormationExecutionRole"
          )
        )
      | .[0]
      | .Action == "iam:PassRole"
      and .Resource == $executionRole
      and .Condition.StringEquals["iam:PassedToService"]
        == "cloudformation.amazonaws.com"
    )
    and (
      .PolicyDocument.Statement
      | map(
          select(
            .Sid == "InspectAndTestAccountBoundNotificationRoutes"
          )
        )
      | .[0]
      | (.Action | sort)
        == (["sns:GetTopicAttributes", "sns:Publish"] | sort)
      and .Resource == (
        "arn:aws:sns:us-east-1:" + $account + ":*"
      )
    )
    and (
      .PolicyDocument.Statement
      | map(
          select(
            .Sid == "PublishOnlyThroughAccountBoundEncryptedSns"
          )
        )
      | .[0]
      | (.Action | sort)
        == (["kms:Decrypt", "kms:GenerateDataKey*"] | sort)
      and .Resource == (
        "arn:aws:kms:us-east-1:" + $account + ":key/*"
      )
      and .Condition.StringEquals["kms:ViaService"]
        == "sns.us-east-1.amazonaws.com"
      and .Condition.StringLike[
        "kms:EncryptionContext:aws:sns:topicArn"
      ] == ("arn:aws:sns:us-east-1:" + $account + ":*")
    )
  ' "$finops_control_policy_file" >/dev/null

jq -e \
  --arg arn "$finops_execution_role_arn" \
  '
    .Role.Arn == $arn
    and .Role.MaxSessionDuration == 3600
    and .Role.AssumeRolePolicyDocument
      == {
        Version: "2012-10-17",
        Statement: [{
          Effect: "Allow",
          Principal: {Service:"cloudformation.amazonaws.com"},
          Action: "sts:AssumeRole"
        }]
      }
  ' "$finops_execution_role_file" >/dev/null

jq -e \
  --arg account "$AWS_ACCOUNT_ID" \
  --arg app "$APP_NAME" \
  '
    .RoleName == ($app + "-finops-cloudformation-execution")
    and .PolicyName == "finops-cloudformation-execution"
    and (.PolicyDocument.Statement | length) == 6
    and (.PolicyDocument.Statement | map(.Sid) | unique | length) == 6
    and (
      .PolicyDocument.Statement
      | map(select(.Sid == "ManageOnlyNamedWorkloadBudgets"))
      | .[0]
      | .Resource == (
          "arn:aws:budgets::" + $account + ":budget/"
            + $app + "-workload-monthly-total"
        )
    )
    and (
      .PolicyDocument.Statement
      | map(select(.Sid == "CreateOnlyTaggedCostAnomalyControls"))
      | .[0]
      | .Resource == "*"
      and .Condition.StringEquals["aws:RequestTag/Application"]
        == $app
      and .Condition.StringEquals[
        "aws:RequestTag/ApprovalBoundary"
      ] == "explicit-live-activation-required"
      and .Condition.StringEquals["aws:RequestTag/FinOpsScope"]
        == "workload"
    )
    and (
      .PolicyDocument.Statement
      | map(
          select(
            .Sid == "CreateOnlyBudgetsServiceLinkedRole"
          )
        )
      | .[0]
      | .Action == "iam:CreateServiceLinkedRole"
      and .Resource == (
        "arn:aws:iam::" + $account
        + ":role/aws-service-role/budgets.amazonaws.com/*"
      )
      and .Condition.StringEquals["iam:AWSServiceName"]
        == "budgets.amazonaws.com"
    )
  ' "$finops_execution_policy_file" >/dev/null

aws iam get-role \
  --role-name "${APP_NAME}-github-alarm-routing-controls" \
  --output json >"$alarm_control_role_file"
aws iam get-role-policy \
  --role-name "${APP_NAME}-github-alarm-routing-controls" \
  --policy-name manage-exact-alarm-routing-control-plane \
  --output json >"$alarm_control_policy_file"
aws iam get-role \
  --role-name "${APP_NAME}-alarm-routing-cloudformation-execution" \
  --output json >"$alarm_execution_role_file"
aws iam get-role-policy \
  --role-name "${APP_NAME}-alarm-routing-cloudformation-execution" \
  --policy-name activate-exact-alarm-routing-resources \
  --output json >"$alarm_execution_policy_file"

jq -e \
  --arg arn "$alarm_control_role_arn" \
  --arg account "$AWS_ACCOUNT_ID" \
  --arg repository "$GITHUB_REPOSITORY" \
  --arg repositoryId "$GITHUB_REPOSITORY_ID" \
  --arg ownerId "$GITHUB_REPOSITORY_OWNER_ID" \
  '
    .Role.Arn == $arn
    and .Role.MaxSessionDuration == 3600
    and (.Role.AssumeRolePolicyDocument.Statement | length) == 1
    and (
      .Role.AssumeRolePolicyDocument.Statement[0]
      | .Effect == "Allow"
      and .Action == "sts:AssumeRoleWithWebIdentity"
      and .Principal.Federated == (
        "arn:aws:iam::" + $account
        + ":oidc-provider/token.actions.githubusercontent.com"
      )
      and .Condition.StringEquals[
        "token.actions.githubusercontent.com:aud"
      ] == "sts.amazonaws.com"
      and .Condition.StringEquals[
        "token.actions.githubusercontent.com:sub"
      ] == (
        "repo:" + $repository
        + ":environment:alarm-routing-controls"
      )
      and .Condition.StringEquals[
        "token.actions.githubusercontent.com:repository"
      ] == $repository
      and .Condition.StringEquals[
        "token.actions.githubusercontent.com:repository_id"
      ] == $repositoryId
      and .Condition.StringEquals[
        "token.actions.githubusercontent.com:repository_owner_id"
      ] == $ownerId
      and .Condition.StringEquals[
        "token.actions.githubusercontent.com:ref"
      ] == "refs/heads/main"
      and .Condition.StringEquals[
        "token.actions.githubusercontent.com:environment"
      ] == "alarm-routing-controls"
      and .Condition.StringEquals[
        "token.actions.githubusercontent.com:workflow"
      ] == "Manage AWS Alarm Routing"
    )
  ' "$alarm_control_role_file" >/dev/null

jq -e \
  --arg account "$AWS_ACCOUNT_ID" \
  --arg app "$APP_NAME" \
  --arg executionRole "$alarm_execution_role_arn" \
  '
    .RoleName == ($app + "-github-alarm-routing-controls")
    and .PolicyName == "manage-exact-alarm-routing-control-plane"
    and (.PolicyDocument.Statement | length) == 13
    and (.PolicyDocument.Statement | map(.Sid) | unique | length) == 13
    and (
      .PolicyDocument.Statement
      | map(select(.Sid == "CreatePinnedAlarmRoutingChangeSet"))
      | .[0]
      | .Action == "cloudformation:CreateChangeSet"
      and .Condition.StringEquals["cloudformation:RoleArn"]
        == $executionRole
      and .Condition.StringLike["cloudformation:TemplateUrl"]
        == (
          "https://" + $app + "-artifacts-" + $account
          + ".s3.eu-west-1.amazonaws.com/foundation/alarm-routing/*"
        )
    )
    and (
      .PolicyDocument.Statement
      | map(select(
          .Sid == "PassOnlyAlarmRoutingCloudFormationExecutionRole"
        ))
      | .[0]
      | .Action == "iam:PassRole"
      and .Resource == $executionRole
      and .Condition.StringEquals["iam:PassedToService"]
        == "cloudformation.amazonaws.com"
    )
    and (
      .PolicyDocument.Statement
      | map(select(.Sid == "RunOnlyBoundedStagingAlarmDeliveryDrill"))
      | .[0]
      | .Action == "cloudwatch:SetAlarmState"
      and .Resource == (
        "arn:aws:cloudwatch:eu-west-1:" + $account
        + ":alarm:" + $app + "-staging-routing-drill"
      )
    )
    and (
      .PolicyDocument.Statement
      | map(select(.Sid == "InspectExactAlarmSubscriptions"))
      | .[0]
      | .Action == "sns:GetSubscriptionAttributes"
      and (.Resource | sort) == ([
          (
            "arn:aws:sns:eu-west-1:" + $account + ":" + $app
            + "-staging-alarms:*"
          ),
          (
            "arn:aws:sns:eu-west-1:" + $account + ":" + $app
            + "-production-alarms:*"
          )
        ] | sort)
    )
    and (
      .PolicyDocument.Statement
      | map(select(.Sid == "InspectExactAlarmArchives"))
      | .[0]
      | (.Resource | sort) == ([
          (
            "arn:aws:sqs:eu-west-1:" + $account
            + ":" + $app + "-staging-alarm-archive"
          ),
          (
            "arn:aws:sqs:eu-west-1:" + $account
            + ":" + $app + "-staging-alarm-routing-drill"
          ),
          (
            "arn:aws:sqs:eu-west-1:" + $account
            + ":" + $app + "-production-alarm-archive"
          )
        ] | sort)
    )
    and (
      .PolicyDocument.Statement
      | map(select(.Sid == "ReadOnlyStagingAlarmDrillDelivery"))
      | .[0]
      | .Action == "sqs:ReceiveMessage"
      and .Resource == (
        "arn:aws:sqs:eu-west-1:" + $account
        + ":" + $app + "-staging-alarm-routing-drill"
      )
    )
    and all(
      .PolicyDocument.Statement[];
      ((.Action | if type == "array" then . else [.] end)
       | index("sqs:DeleteMessage")) == null
    )
  ' "$alarm_control_policy_file" >/dev/null

jq -e \
  --arg arn "$alarm_execution_role_arn" \
  '
    .Role.Arn == $arn
    and .Role.MaxSessionDuration == 3600
    and .Role.AssumeRolePolicyDocument == {
      Version: "2012-10-17",
      Statement: [{
        Effect: "Allow",
        Principal: {Service:"cloudformation.amazonaws.com"},
        Action: "sts:AssumeRole"
      }]
    }
  ' "$alarm_execution_role_file" >/dev/null

jq -e \
  --arg account "$AWS_ACCOUNT_ID" \
  --arg app "$APP_NAME" \
  '
    .RoleName == ($app + "-alarm-routing-cloudformation-execution")
    and .PolicyName == "activate-exact-alarm-routing-resources"
    and (.PolicyDocument.Statement | length) == 11
    and (.PolicyDocument.Statement | map(.Sid) | unique | length) == 11
    and (
      .PolicyDocument.Statement
      | map(select(.Sid == "CreateOnlyTaggedAlarmNotificationKey"))
      | .[0]
      | .Action == "kms:CreateKey"
      and .Resource == "*"
      and .Condition.StringEquals["aws:RequestTag/Application"] == $app
      and .Condition.StringEquals[
        "aws:RequestTag/DataClassification"
      ] == "alarm-notifications"
      and .Condition.Bool["kms:MultiRegion"] == "false"
    )
    and (
      .PolicyDocument.Statement
      | map(select(.Sid == "ManageExactAlarmSubscriptions"))
      | .[0]
      | (.Action | sort) == ([
          "sns:GetSubscriptionAttributes",
          "sns:SetSubscriptionAttributes",
          "sns:Unsubscribe"
        ] | sort)
      and (.Resource | sort) == ([
          (
            "arn:aws:sns:eu-west-1:" + $account + ":" + $app
            + "-staging-alarms:*"
          ),
          (
            "arn:aws:sns:eu-west-1:" + $account + ":" + $app
            + "-production-alarms:*"
          )
        ] | sort)
    )
    and (
      .PolicyDocument.Statement
      | map(select(.Sid == "ManageExactAlarmArchiveQueues"))
      | .[0]
      | (.Resource | sort) == ([
          (
            "arn:aws:sqs:eu-west-1:" + $account
            + ":" + $app + "-staging-alarm-archive"
          ),
          (
            "arn:aws:sqs:eu-west-1:" + $account
            + ":" + $app + "-staging-alarm-routing-drill"
          ),
          (
            "arn:aws:sqs:eu-west-1:" + $account
            + ":" + $app + "-production-alarm-archive"
          )
        ] | sort)
    )
    and (
      .PolicyDocument.Statement
      | map(select(.Sid == "AttachOnlyAlarmInspectionPolicies"))
      | .[0]
      | (.Resource | sort) == ([
          (
            "arn:aws:iam::" + $account
            + ":role/" + $app + "-github-staging-deploy"
          ),
          (
            "arn:aws:iam::" + $account
            + ":role/" + $app + "-github-production-deploy"
          )
        ] | sort)
    )
    and (
      .PolicyDocument.Statement
      | map(select(.Sid == "ManageOnlyStagingRoutingDrillAlarm"))
      | .[0]
      | .Resource == (
        "arn:aws:cloudwatch:eu-west-1:" + $account
        + ":alarm:" + $app + "-staging-routing-drill"
      )
    )
  ' "$alarm_execution_policy_file" >/dev/null

migration_authority_retired=false
if [ "$authority_state" = "retired" ]; then
  authority_stack_error="$work_dir/authority-stack.err"
  if aws cloudformation describe-stacks \
      --stack-name "${APP_NAME}-foundation-migration-authority" \
      --region "$AWS_REGION" \
      --output json >/dev/null 2>"$authority_stack_error"; then
    echo "The one-time migration authority stack still exists." >&2
    exit 1
  fi
  grep -Fq "ValidationError" "$authority_stack_error"
  grep -Fq "does not exist" "$authority_stack_error"
  authority_role_error="$work_dir/authority-role.err"
  if aws iam get-role \
      --role-name "${APP_NAME}-github-foundation-migration" \
      --output json >/dev/null 2>"$authority_role_error"; then
    echo "The one-time migration authority role still exists." >&2
    exit 1
  fi
  grep -Fq "NoSuchEntity" "$authority_role_error"
  migration_authority_retired=true
fi

aws s3api get-bucket-encryption \
  --bucket "$artifact_bucket" \
  --expected-bucket-owner "$AWS_ACCOUNT_ID" \
  --region "$AWS_REGION" \
  --output json >"$artifact_encryption_file"
aws s3api get-bucket-encryption \
  --bucket "$cloudfront_log_bucket" \
  --expected-bucket-owner "$AWS_ACCOUNT_ID" \
  --region "$AWS_REGION" \
  --output json >"$cloudfront_encryption_file"
aws s3api get-bucket-policy \
  --bucket "$artifact_bucket" \
  --expected-bucket-owner "$AWS_ACCOUNT_ID" \
  --region "$AWS_REGION" \
  --output json >"$artifact_policy_file"
aws s3api get-bucket-policy \
  --bucket "$cloudfront_log_bucket" \
  --expected-bucket-owner "$AWS_ACCOUNT_ID" \
  --region "$AWS_REGION" \
  --output json >"$cloudfront_policy_file"

jq -e \
  --arg key "$storage_key_arn" \
  '
    .ServerSideEncryptionConfiguration.Rules as $rules
    | ($rules | length) == 1
      and $rules[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm
        == "aws:kms"
      and $rules[0].ApplyServerSideEncryptionByDefault.KMSMasterKeyID
        == $key
      and $rules[0].BucketKeyEnabled == true
  ' "$artifact_encryption_file" >/dev/null
jq -e \
  --arg key "$log_key_arn" \
  '
    .ServerSideEncryptionConfiguration.Rules as $rules
    | ($rules | length) == 1
      and $rules[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm
        == "aws:kms"
      and $rules[0].ApplyServerSideEncryptionByDefault.KMSMasterKeyID
        == $key
      and $rules[0].BucketKeyEnabled == true
  ' "$cloudfront_encryption_file" >/dev/null

jq -e \
  --arg bucketArn "arn:aws:s3:::${artifact_bucket}" \
  --arg aliasArn \
    "arn:aws:kms:${AWS_REGION}:${AWS_ACCOUNT_ID}:alias/${APP_NAME}-storage" \
  '
    (.Policy | fromjson).Statement as $statements
    | ($statements | length) == 3
      and any(
        $statements[];
        .Sid == "DenyInsecureTransport"
        and .Effect == "Deny"
        and .Principal == "*"
        and .Action == "s3:*"
        and (.Resource | sort)
          == ([$bucketArn, ($bucketArn + "/*")] | sort)
        and .Condition == {Bool:{"aws:SecureTransport":"false"}}
      )
      and any(
        $statements[];
        .Sid == "DenyArtifactWritesWithoutKms"
        and .Effect == "Deny"
        and .Principal == "*"
        and .Action == "s3:PutObject"
        and .Resource == ($bucketArn + "/*")
        and .Condition
          == {
            StringNotEquals: {
              "s3:x-amz-server-side-encryption": "aws:kms"
            }
          }
      )
      and any(
        $statements[];
        .Sid == "DenyArtifactWritesWithUnexpectedKmsKey"
        and .Effect == "Deny"
        and .Principal == "*"
        and .Action == "s3:PutObject"
        and .Resource == ($bucketArn + "/*")
        and .Condition
          == {
            StringNotEquals: {
              "s3:x-amz-server-side-encryption-aws-kms-key-id":
                $aliasArn
            }
          }
      )
  ' "$artifact_policy_file" >/dev/null
jq -e \
  --arg bucketArn "arn:aws:s3:::${cloudfront_log_bucket}" \
  '
    (.Policy | fromjson).Statement
    == [{
      Sid: "DenyInsecureTransport",
      Effect: "Deny",
      Principal: "*",
      Action: "s3:*",
      Resource: [$bucketArn, ($bucketArn + "/*")],
      Condition: {Bool:{"aws:SecureTransport":"false"}}
    }]
  ' "$cloudfront_policy_file" >/dev/null

aws s3api get-bucket-ownership-controls \
  --bucket "$cloudfront_log_bucket" \
  --expected-bucket-owner "$AWS_ACCOUNT_ID" \
  --region "$AWS_REGION" \
  --output json >"$cloudfront_ownership_file"
aws s3api get-public-access-block \
  --bucket "$cloudfront_log_bucket" \
  --expected-bucket-owner "$AWS_ACCOUNT_ID" \
  --region "$AWS_REGION" \
  --output json >"$cloudfront_public_access_file"
aws s3api get-bucket-versioning \
  --bucket "$cloudfront_log_bucket" \
  --expected-bucket-owner "$AWS_ACCOUNT_ID" \
  --region "$AWS_REGION" \
  --output json >"$cloudfront_versioning_file"
aws s3api get-bucket-logging \
  --bucket "$cloudfront_log_bucket" \
  --expected-bucket-owner "$AWS_ACCOUNT_ID" \
  --region "$AWS_REGION" \
  --output json >"$cloudfront_logging_file"

jq -e \
  '.OwnershipControls.Rules == [{"ObjectOwnership":"BucketOwnerPreferred"}]' \
  "$cloudfront_ownership_file" >/dev/null
jq -e '
  .PublicAccessBlockConfiguration == {
    BlockPublicAcls: true,
    BlockPublicPolicy: true,
    IgnorePublicAcls: true,
    RestrictPublicBuckets: true
  }
' "$cloudfront_public_access_file" >/dev/null
jq -e '.Status == "Enabled"' "$cloudfront_versioning_file" >/dev/null
jq -e \
  --arg archive "$archive_bucket" \
  '
    .LoggingEnabled.TargetBucket == $archive
    and .LoggingEnabled.TargetPrefix == "cloudfront-log-bucket/"
    and .LoggingEnabled.TargetObjectKeyFormat
      == {PartitionedPrefix:{PartitionDateSource:"EventTime"}}
  ' "$cloudfront_logging_file" >/dev/null

jq -n \
  --arg stack "$stack_name" \
  --arg stackStatus "$stack_status" \
  --arg keyArnSha256 "$(
    printf '%s' "$storage_key_arn" | sha256sum | awk '{print $1}'
  )" \
  --arg keyAliasArnSha256 "$(
    printf '%s' "$storage_alias_arn" | sha256sum | awk '{print $1}'
  )" \
  --arg logKeyArnSha256 "$(
    printf '%s' "$log_key_arn" | sha256sum | awk '{print $1}'
  )" \
  --arg logKeyAliasArnSha256 "$(
    printf '%s' "$log_alias_arn" | sha256sum | awk '{print $1}'
  )" \
  --arg artifactBucketSha256 "$(
    printf '%s' "$artifact_bucket" | sha256sum | awk '{print $1}'
  )" \
  --arg archiveBucketSha256 "$(
    printf '%s' "$archive_bucket" | sha256sum | awk '{print $1}'
  )" \
  --arg cloudFrontLogBucketSha256 "$(
    printf '%s' "$cloudfront_log_bucket" | sha256sum | awk '{print $1}'
  )" \
  --arg stagingSecretArnSha256 "$(
    printf '%s' "$staging_secret_arn" | sha256sum | awk '{print $1}'
  )" \
  --arg productionSecretArnSha256 "$(
    printf '%s' "$production_secret_arn" | sha256sum | awk '{print $1}'
  )" \
  --arg edgeControlRoleArnSha256 "$(
    printf '%s' "$edge_role_arn" | sha256sum | awk '{print $1}'
  )" \
  --arg finOpsControlRoleArnSha256 "$(
    printf '%s' "$finops_control_role_arn" |
      sha256sum |
      awk '{print $1}'
  )" \
  --arg finOpsExecutionRoleArnSha256 "$(
    printf '%s' "$finops_execution_role_arn" |
      sha256sum |
      awk '{print $1}'
  )" \
  --arg alarmControlRoleArnSha256 "$(
    printf '%s' "$alarm_control_role_arn" |
      sha256sum |
      awk '{print $1}'
  )" \
  --arg alarmExecutionRoleArnSha256 "$(
    printf '%s' "$alarm_execution_role_arn" |
      sha256sum |
      awk '{print $1}'
  )" \
  --argjson alarmRoutingActive "$alarm_routing_active" \
  --argjson migrationAuthorityRetired \
    "$migration_authority_retired" \
  '{
    schema: "archon.aws.foundation-storage-controls",
    schemaVersion: 1,
    ok: true,
    stack: {
      name: $stack,
      status: $stackStatus
    },
    storageKey: {
      arnSha256: $keyArnSha256,
      aliasArnSha256: $keyAliasArnSha256,
      customerManaged: true,
      rotationEnabled: true,
      bucketKeysEnabled: true,
      explicitWritePolicy: true
    },
    cloudFrontAccessLogKey: {
      arnSha256: $logKeyArnSha256,
      aliasArnSha256: $logKeyAliasArnSha256,
      customerManaged: true,
      rotationEnabled: true,
      dataScope: "cloudfront-access-logs-only",
      servicePrincipalIsolated: true,
      bucketKeysEnabled: true
    },
    buckets: {
      artifactSha256: $artifactBucketSha256,
      serverAccessArchiveSha256: $archiveBucketSha256,
      cloudFrontAccessLogsSha256: $cloudFrontLogBucketSha256,
      cloudFrontAccessLogOwnership: "BucketOwnerPreferred",
      explicitTlsPolicy: true,
      publicAccessBlocked: true,
      versioningEnabled: true
    },
    originVerificationSecrets: {
      stagingArnSha256: $stagingSecretArnSha256,
      productionArnSha256: $productionSecretArnSha256,
      valuesRead: false,
      kmsKeyArnSha256: $keyArnSha256
    },
    edgeControls: {
      roleArnSha256: $edgeControlRoleArnSha256,
      workflow: "Manage AWS Edge Controls",
      controlPlaneRegion: "us-east-1",
      liveActivationPerformed: false
    },
    finOpsControls: {
      controllerRoleArnSha256: $finOpsControlRoleArnSha256,
      executionRoleArnSha256: $finOpsExecutionRoleArnSha256,
      workflow: "Manage AWS FinOps Controls",
      controlPlaneRegion: "us-east-1",
      roleSeparation: true,
      liveActivationPerformed: false
    },
    alarmRoutingControls: {
      controllerRoleArnSha256: $alarmControlRoleArnSha256,
      executionRoleArnSha256: $alarmExecutionRoleArnSha256,
      workflow: "Manage AWS Alarm Routing",
      applicationRegion: "eu-west-1",
      roleSeparation: true,
      liveActivationPerformed: $alarmRoutingActive,
      liveDeliveryDrillPerformed: false
    },
    migrationAuthority: {
      retirementRequired: true,
      retired: $migrationAuthorityRetired
    }
  }'
