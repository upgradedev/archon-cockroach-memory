#!/usr/bin/env bash
set -euo pipefail

mode="${1:-verify}"
case "$mode" in
  render-trust|render-policy|render-template|verify) ;;
  *)
    echo "Usage: $0 [render-trust|render-policy|render-template|verify]" >&2
    exit 1
    ;;
esac

for name in \
  APP_NAME \
  AWS_ACCOUNT_ID \
  AWS_REGION \
  GITHUB_ORGANIZATION \
  GITHUB_REPOSITORY_ID \
  GITHUB_REPOSITORY_NAME \
  GITHUB_REPOSITORY_OWNER_ID \
  GITHUB_OIDC_PROVIDER_ARN; do
  if [ -z "${!name:-}" ]; then
    echo "$name is required." >&2
    exit 1
  fi
done

test "$AWS_REGION" = "eu-west-1"
test "$GITHUB_ORGANIZATION" = "upgradedev"
test "$GITHUB_REPOSITORY_NAME" = "archon-cockroach-memory"
[[ "$AWS_ACCOUNT_ID" =~ ^[0-9]{12}$ ]]
[[ "$GITHUB_REPOSITORY_ID" =~ ^[1-9][0-9]*$ ]]
[[ "$GITHUB_REPOSITORY_OWNER_ID" =~ ^[1-9][0-9]*$ ]]
test "$GITHUB_OIDC_PROVIDER_ARN" = \
  "arn:aws:iam::${AWS_ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com"

role_name="${APP_NAME}-github-foundation-migration"
policy_name="protected-foundation-storage-migration"
repository="${GITHUB_ORGANIZATION}/${GITHUB_REPOSITORY_NAME}"
foundation_stack_arn="arn:aws:cloudformation:${AWS_REGION}:${AWS_ACCOUNT_ID}:stack/${APP_NAME}-delivery-bootstrap/*"
authority_stack_arn="arn:aws:cloudformation:${AWS_REGION}:${AWS_ACCOUNT_ID}:stack/${APP_NAME}-foundation-migration-authority/*"
change_set_arn="arn:aws:cloudformation:${AWS_REGION}:${AWS_ACCOUNT_ID}:changeSet/foundation-storage-*/*"
artifact_bucket_arn="arn:aws:s3:::${APP_NAME}-artifacts-${AWS_ACCOUNT_ID}-${AWS_REGION}"
archive_bucket_arn="arn:aws:s3:::${APP_NAME}-s3-access-logs-${AWS_ACCOUNT_ID}-${AWS_REGION}"
cloudfront_log_bucket_arn="arn:aws:s3:::${APP_NAME}-cloudfront-access-logs-${AWS_ACCOUNT_ID}-${AWS_REGION}"
migration_role_arn="arn:aws:iam::${AWS_ACCOUNT_ID}:role/${role_name}"

render_trust() {
  jq -n \
    --arg provider "$GITHUB_OIDC_PROVIDER_ARN" \
    --arg repository "$repository" \
    --arg repositoryId "$GITHUB_REPOSITORY_ID" \
    --arg ownerId "$GITHUB_REPOSITORY_OWNER_ID" \
    '{
      Version: "2012-10-17",
      Statement: [{
        Effect: "Allow",
        Principal: {Federated:$provider},
        Action: "sts:AssumeRoleWithWebIdentity",
        Condition: {
          StringEquals: {
            "token.actions.githubusercontent.com:aud":
              "sts.amazonaws.com",
            "token.actions.githubusercontent.com:sub":
              ("repo:" + $repository + ":environment:bootstrap"),
            "token.actions.githubusercontent.com:repository":
              $repository,
            "token.actions.githubusercontent.com:repository_id":
              $repositoryId,
            "token.actions.githubusercontent.com:repository_owner_id":
              $ownerId,
            "token.actions.githubusercontent.com:ref":
              "refs/heads/main",
            "token.actions.githubusercontent.com:environment":
              "bootstrap",
            "token.actions.githubusercontent.com:workflow":
              "Foundation Storage Migration"
          }
        }
      }]
    }'
}

render_policy() {
  jq -n \
    --arg account "$AWS_ACCOUNT_ID" \
    --arg region "$AWS_REGION" \
    --arg app "$APP_NAME" \
    --arg foundationStack "$foundation_stack_arn" \
    --arg authorityStack "$authority_stack_arn" \
    --arg changeSet "$change_set_arn" \
    --arg artifactBucket "$artifact_bucket_arn" \
    --arg archiveBucket "$archive_bucket_arn" \
    --arg cloudFrontLogBucket "$cloudfront_log_bucket_arn" \
    --arg migrationRole "$migration_role_arn" \
    '{
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "ManageExactFoundationStack",
          Effect: "Allow",
          Action: [
            "cloudformation:CreateChangeSet",
            "cloudformation:DeleteChangeSet",
            "cloudformation:DescribeChangeSet",
            "cloudformation:DescribeStackEvents",
            "cloudformation:DescribeStacks",
            "cloudformation:ExecuteChangeSet",
            "cloudformation:GetStackPolicy",
            "cloudformation:GetTemplate",
            "cloudformation:ListStackResources",
            "cloudformation:SetStackPolicy"
          ],
          Resource: [$foundationStack, $changeSet],
          Condition: {
            StringLikeIfExists: {
              "cloudformation:ChangeSetName": [
                "foundation-storage-*",
                $changeSet
              ]
            }
          }
        },
        {
          Sid: "PublishImmutableMigrationObjects",
          Effect: "Allow",
          Action: [
            "s3:GetObject",
            "s3:GetObjectVersion",
            "s3:PutObject"
          ],
          Resource:
            ($artifactBucket + "/foundation/storage-migrations/*")
        },
        {
          Sid: "InspectExactFoundationBuckets",
          Effect: "Allow",
          Action: [
            "s3:GetBucketAcl",
            "s3:GetLifecycleConfiguration",
            "s3:GetBucketLocation",
            "s3:GetBucketLogging",
            "s3:GetBucketOwnershipControls",
            "s3:GetBucketPolicy",
            "s3:GetBucketPublicAccessBlock",
            "s3:GetBucketTagging",
            "s3:GetBucketVersioning",
            "s3:GetEncryptionConfiguration"
          ],
          Resource: [
            $artifactBucket,
            $archiveBucket,
            $cloudFrontLogBucket
          ]
        },
        {
          Sid: "UseExistingApplicationStorageKey",
          Effect: "Allow",
          Action: [
            "kms:Decrypt",
            "kms:DescribeKey",
            "kms:Encrypt",
            "kms:GenerateDataKey",
            "kms:ReEncryptFrom",
            "kms:ReEncryptTo"
          ],
          Resource:
            ("arn:aws:kms:" + $region + ":" + $account + ":key/*"),
          Condition: {
            "ForAnyValue:StringEquals": {
              "kms:ResourceAliases":
                ("alias/" + $app + "-storage")
            }
          }
        },
        {
          Sid: "CreateTaggedFoundationKeysViaCloudFormation",
          Effect: "Allow",
          Action: "kms:CreateKey",
          Resource: "*",
          Condition: {
            "ForAnyValue:StringEquals": {
              "aws:CalledVia": "cloudformation.amazonaws.com"
            },
            StringEquals: {
              "aws:RequestTag/Application": $app,
              "aws:RequestTag/ManagedBy": "CloudFormation"
            }
          }
        },
        {
          Sid: "ManageTaggedFoundationKeysViaCloudFormation",
          Effect: "Allow",
          Action: [
            "kms:CancelKeyDeletion",
            "kms:DescribeKey",
            "kms:EnableKeyRotation",
            "kms:GetKeyPolicy",
            "kms:GetKeyRotationStatus",
            "kms:ListResourceTags",
            "kms:PutKeyPolicy",
            "kms:ScheduleKeyDeletion",
            "kms:TagResource",
            "kms:UntagResource"
          ],
          Resource:
            ("arn:aws:kms:" + $region + ":" + $account + ":key/*"),
          Condition: {
            "ForAnyValue:StringEquals": {
              "aws:CalledVia": "cloudformation.amazonaws.com"
            },
            StringEquals: {
              "aws:ResourceTag/Application": $app
            }
          }
        },
        {
          Sid: "ManageExactFoundationAliasesViaCloudFormation",
          Effect: "Allow",
          Action: [
            "kms:CreateAlias",
            "kms:DeleteAlias",
            "kms:UpdateAlias"
          ],
          Resource: [
            (
              "arn:aws:kms:" + $region + ":" + $account
              + ":alias/" + $app + "-storage"
            ),
            (
              "arn:aws:kms:" + $region + ":" + $account
              + ":alias/" + $app + "-cloudfront-logs"
            ),
            ("arn:aws:kms:" + $region + ":" + $account + ":key/*")
          ],
          Condition: {
            "ForAnyValue:StringEquals": {
              "aws:CalledVia": "cloudformation.amazonaws.com"
            }
          }
        },
        {
          Sid: "ManageExactOriginSecretsViaCloudFormation",
          Effect: "Allow",
          Action: [
            "secretsmanager:CreateSecret",
            "secretsmanager:DeleteSecret",
            "secretsmanager:DescribeSecret",
            "secretsmanager:TagResource",
            "secretsmanager:UntagResource",
            "secretsmanager:UpdateSecret"
          ],
          Resource: [
            (
              "arn:aws:secretsmanager:" + $region + ":" + $account
              + ":secret:" + $app
              + "/staging/origin-verification-*"
            ),
            (
              "arn:aws:secretsmanager:" + $region + ":" + $account
              + ":secret:" + $app
              + "/production/origin-verification-*"
            )
          ],
          Condition: {
            "ForAnyValue:StringEquals": {
              "aws:CalledVia": "cloudformation.amazonaws.com"
            }
          }
        },
        {
          Sid: "ManageExactFoundationBucketsViaCloudFormation",
          Effect: "Allow",
          Action: [
            "s3:CreateBucket",
            "s3:DeleteBucket",
            "s3:DeleteBucketPolicy",
            "s3:PutBucketAcl",
            "s3:PutEncryptionConfiguration",
            "s3:PutLifecycleConfiguration",
            "s3:PutBucketLogging",
            "s3:PutBucketOwnershipControls",
            "s3:PutBucketPolicy",
            "s3:PutBucketPublicAccessBlock",
            "s3:PutBucketTagging",
            "s3:PutBucketVersioning"
          ],
          Resource: [
            $artifactBucket,
            $archiveBucket,
            $cloudFrontLogBucket
          ],
          Condition: {
            "ForAnyValue:StringEquals": {
              "aws:CalledVia": "cloudformation.amazonaws.com"
            }
          }
        },
        {
          Sid: "ManageExactFoundationRolesViaCloudFormation",
          Effect: "Allow",
          Action: [
            "iam:CreateRole",
            "iam:DeleteRole",
            "iam:DeleteRolePolicy",
            "iam:GetRole",
            "iam:GetRolePolicy",
            "iam:ListRolePolicies",
            "iam:PutRolePolicy",
            "iam:TagRole",
            "iam:UntagRole",
            "iam:UpdateAssumeRolePolicy"
          ],
          Resource: [
            (
              "arn:aws:iam::" + $account
              + ":role/" + $app + "-github-edge-controls"
            ),
            (
              "arn:aws:iam::" + $account
              + ":role/" + $app
              + "-alarm-routing-cloudformation-execution"
            ),
            (
              "arn:aws:iam::" + $account
              + ":role/" + $app + "-github-alarm-routing-controls"
            ),
            (
              "arn:aws:iam::" + $account
              + ":role/" + $app + "-github-database-operator"
            ),
            (
              "arn:aws:iam::" + $account
              + ":role/" + $app + "-github-foundation-promotion"
            ),
            (
              "arn:aws:iam::" + $account
              + ":role/" + $app + "-github-finops-controls"
            ),
            (
              "arn:aws:iam::" + $account
              + ":role/" + $app + "-finops-cloudformation-execution"
            ),
            (
              "arn:aws:iam::" + $account
              + ":role/" + $app + "-github-staging-deploy"
            ),
            (
              "arn:aws:iam::" + $account
              + ":role/" + $app + "-github-production-deploy"
            ),
            $migrationRole
          ],
          Condition: {
            "ForAnyValue:StringEquals": {
              "aws:CalledVia": "cloudformation.amazonaws.com"
            }
          }
        },
        {
          Sid: "ManageExactCloudFormationPoliciesViaCloudFormation",
          Effect: "Allow",
          Action: [
            "iam:CreatePolicyVersion",
            "iam:DeletePolicyVersion",
            "iam:GetPolicy",
            "iam:GetPolicyVersion",
            "iam:ListPolicyVersions",
            "iam:SetDefaultPolicyVersion"
          ],
          Resource: [
            (
              "arn:aws:iam::" + $account + ":policy/"
              + $app + "-staging-cloudformation-resources"
            ),
            (
              "arn:aws:iam::" + $account + ":policy/"
              + $app + "-production-cloudformation-resources"
            )
          ],
          Condition: {
            "ForAnyValue:StringEquals": {
              "aws:CalledVia": "cloudformation.amazonaws.com"
            }
          }
        },
        {
          Sid: "InspectPermanentControlRoleMetadata",
          Effect: "Allow",
          Action: "iam:GetRole",
          Resource: [
            (
              "arn:aws:iam::" + $account
              + ":role/" + $app + "-github-edge-controls"
            ),
            (
              "arn:aws:iam::" + $account
              + ":role/" + $app + "-github-finops-controls"
            ),
            (
              "arn:aws:iam::" + $account
              + ":role/" + $app + "-finops-cloudformation-execution"
            ),
            (
              "arn:aws:iam::" + $account
              + ":role/" + $app
              + "-alarm-routing-cloudformation-execution"
            ),
            (
              "arn:aws:iam::" + $account
              + ":role/" + $app + "-github-alarm-routing-controls"
            )
          ]
        },
        {
          Sid: "InspectPermanentControlRolePolicies",
          Effect: "Allow",
          Action: "iam:GetRolePolicy",
          Resource: [
            (
              "arn:aws:iam::" + $account
              + ":role/" + $app + "-github-finops-controls"
            ),
            (
              "arn:aws:iam::" + $account
              + ":role/" + $app + "-finops-cloudformation-execution"
            ),
            (
              "arn:aws:iam::" + $account
              + ":role/" + $app
              + "-alarm-routing-cloudformation-execution"
            ),
            (
              "arn:aws:iam::" + $account
              + ":role/" + $app + "-github-alarm-routing-controls"
            )
          ]
        },
        {
          Sid: "InspectOwnAuthorityContract",
          Effect: "Allow",
          Action: [
            "iam:GetRole",
            "iam:GetRolePolicy"
          ],
          Resource: $migrationRole
        },
        {
          Sid: "RetireAuthorityStack",
          Effect: "Allow",
          Action: [
            "cloudformation:DeleteStack",
            "cloudformation:DescribeStackEvents",
            "cloudformation:DescribeStacks",
            "cloudformation:GetTemplate"
          ],
          Resource: $authorityStack
        }
      ]
    }'
}

render_template() {
  local policy trust
  trust="$(render_trust)"
  policy="$(render_policy)"
  jq -n \
    --arg app "$APP_NAME" \
    --arg role "$role_name" \
    --arg policyName "$policy_name" \
    --argjson trust "$trust" \
    --argjson policy "$policy" \
    '{
      AWSTemplateFormatVersion: "2010-09-09",
      Description:
        "One-time, approval-gated authority for the protected Archon foundation storage migration. Delete this stack after a successful migration and permanent-role verification.",
      Resources: {
        FoundationMigrationRole: {
          Type: "AWS::IAM::Role",
          Properties: {
            RoleName: $role,
            MaxSessionDuration: 3600,
            AssumeRolePolicyDocument: $trust,
            Policies: [{
              PolicyName: $policyName,
              PolicyDocument: $policy
            }],
            Tags: [
              {Key:"Application", Value:$app},
              {Key:"Environment", Value:"bootstrap"},
              {Key:"Lifecycle", Value:"one-time-migration-authority"},
              {Key:"ManagedBy", Value:"CloudFormation"}
            ]
          }
        }
      },
      Outputs: {
        FoundationMigrationRoleArn: {
          Value: {"Fn::GetAtt":["FoundationMigrationRole","Arn"]}
        }
      }
    }'
}

case "$mode" in
  render-trust)
    render_trust
    ;;
  render-policy)
    render_policy
    ;;
  render-template)
    render_template
    ;;
  verify)
    : "${AWS_FOUNDATION_MIGRATION_ROLE_ARN:?}"
    test "$AWS_FOUNDATION_MIGRATION_ROLE_ARN" = "$migration_role_arn"
    work_dir="$(mktemp -d)"
    cleanup() {
      rm -rf -- "$work_dir"
    }
    trap cleanup EXIT
    expected_trust="$work_dir/expected-trust.json"
    expected_policy="$work_dir/expected-policy.json"
    live_role="$work_dir/live-role.json"
    live_policy="$work_dir/live-policy.json"
    live_stack="$work_dir/live-stack.json"
    live_template="$work_dir/live-template.json"
    expected_template="$work_dir/expected-template.json"
    render_trust >"$expected_trust"
    render_policy >"$expected_policy"
    render_template >"$expected_template"
    aws iam get-role \
      --role-name "$role_name" \
      --output json >"$live_role"
    aws iam get-role-policy \
      --role-name "$role_name" \
      --policy-name "$policy_name" \
      --output json >"$live_policy"
    aws cloudformation describe-stacks \
      --stack-name "${APP_NAME}-foundation-migration-authority" \
      --region "$AWS_REGION" \
      --output json >"$live_stack"
    aws cloudformation get-template \
      --stack-name "${APP_NAME}-foundation-migration-authority" \
      --template-stage Original \
      --region "$AWS_REGION" \
      --output json >"$live_template"
    jq -e \
      --arg arn "$migration_role_arn" \
      --slurpfile trust "$expected_trust" \
      '
        .Role.Arn == $arn
        and .Role.MaxSessionDuration == 3600
        and .Role.AssumeRolePolicyDocument == $trust[0]
      ' "$live_role" >/dev/null
    jq -e \
      --arg role "$role_name" \
      --arg policy "$policy_name" \
      --slurpfile expected "$expected_policy" \
      '
        .RoleName == $role
        and .PolicyName == $policy
        and .PolicyDocument == $expected[0]
      ' "$live_policy" >/dev/null
    jq -e \
      --arg stack "${APP_NAME}-foundation-migration-authority" \
      --arg roleArn "$migration_role_arn" \
      '
        (.Stacks | length) == 1
        and .Stacks[0].StackName == $stack
        and (
          .Stacks[0].StackStatus == "CREATE_COMPLETE"
          or .Stacks[0].StackStatus == "UPDATE_COMPLETE"
        )
        and .Stacks[0].EnableTerminationProtection == false
        and ((.Stacks[0].RoleARN // null) == null)
        and (
          [
            .Stacks[0].Outputs[]
            | select(
                .OutputKey == "FoundationMigrationRoleArn"
              )
            | .OutputValue
          ]
        ) == [$roleArn]
      ' "$live_stack" >/dev/null
    jq -e \
      --slurpfile expected "$expected_template" \
      '
        (
          .TemplateBody
          | if type == "string" then fromjson else . end
        ) == $expected[0]
      ' "$live_template" >/dev/null
    trust_digest="$(
      jq -Sc . "$expected_trust" | sha256sum | awk '{print $1}'
    )"
    policy_digest="$(
      jq -Sc . "$expected_policy" | sha256sum | awk '{print $1}'
    )"
    jq -n \
      --arg roleArnSha256 "$(
        printf '%s' "$migration_role_arn" |
          sha256sum |
          awk '{print $1}'
      )" \
      --arg trustSha256 "$trust_digest" \
      --arg policySha256 "$policy_digest" \
      '{
        schema: "archon.aws.foundation-migration-authority",
        schemaVersion: 1,
        ok: true,
        oneTime: true,
        roleArnSha256: $roleArnSha256,
        trustPolicySha256: $trustSha256,
        permissionsPolicySha256: $policySha256,
        liveContractExact: true,
        cloudFormationCreationContractExact: true,
        retirementRequired: true
      }'
    ;;
esac
