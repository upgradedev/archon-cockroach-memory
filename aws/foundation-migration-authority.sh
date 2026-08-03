#!/usr/bin/env bash
set -euo pipefail

mode="${1:-verify}"
case "$mode" in
  render-trust|render-policy|render-template|render-template-sha256|verify|verify-intrinsic|verify-retirement-retry|verify-retirement-orphaned) ;;
  *)
    echo "Usage: $0 [render-trust|render-policy|render-template|render-template-sha256|verify|verify-intrinsic|verify-retirement-retry|verify-retirement-orphaned]" >&2
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
[[ "$APP_NAME" =~ ^[a-z][a-z0-9-]{2,16}$ ]]
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
            "cloudformation:DetectStackResourceDrift",
            "cloudformation:DescribeChangeSet",
            "cloudformation:DescribeStackEvents",
            "cloudformation:DescribeStacks",
            "cloudformation:ExecuteChangeSet",
            "cloudformation:GetStackPolicy",
            "cloudformation:GetTemplate",
            "cloudformation:ListChangeSets",
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
          Sid: "ManageExactNewFoundationRolesViaCloudFormation",
          Effect: "Allow",
          Action: [
            "iam:CreateRole",
            "iam:DeleteRole",
            "iam:DeleteRolePolicy",
            "iam:GetRole",
            "iam:GetRolePolicy",
            "iam:ListAttachedRolePolicies",
            "iam:ListInstanceProfilesForRole",
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
              + ":role/" + $app + "-github-edge-cleanup"
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
              + ":role/" + $app
              + "-foundation-authority-retirement-execution"
            ),
            (
              "arn:aws:iam::" + $account
              + ":role/" + $app + "-github-finops-controls"
            ),
            (
              "arn:aws:iam::" + $account
              + ":role/" + $app + "-finops-cloudformation-execution"
            )
          ],
          Condition: {
            "ForAnyValue:StringEquals": {
              "aws:CalledVia": "cloudformation.amazonaws.com"
            }
          }
        },
        {
          Sid: "ModifyExactExistingFoundationRolesViaCloudFormation",
          Effect: "Allow",
          Action: [
            "iam:DeleteRolePolicy",
            "iam:GetRole",
            "iam:GetRolePolicy",
            "iam:ListAttachedRolePolicies",
            "iam:ListInstanceProfilesForRole",
            "iam:ListRolePolicies",
            "iam:PutRolePolicy",
            "iam:TagRole",
            "iam:UntagRole",
            "iam:UpdateAssumeRolePolicy"
          ],
          Resource: [
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
              + ":role/" + $app + "-github-staging-deploy"
            ),
            (
              "arn:aws:iam::" + $account
              + ":role/" + $app + "-github-production-deploy"
            )
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
              + ":role/" + $app + "-github-edge-cleanup"
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
              + ":role/" + $app + "-github-foundation-promotion"
            ),
            (
              "arn:aws:iam::" + $account
              + ":role/" + $app + "-github-edge-controls"
            ),
            (
              "arn:aws:iam::" + $account
              + ":role/" + $app + "-github-edge-cleanup"
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
          Sid: "InspectFoundationRetirementRoleMetadata",
          Effect: "Allow",
          Action: [
            "iam:GetRole",
            "iam:ListAttachedRolePolicies",
            "iam:ListInstanceProfilesForRole",
            "iam:ListRolePolicies"
          ],
          Resource: [
            (
              "arn:aws:iam::" + $account
              + ":role/" + $app + "-github-foundation-promotion"
            ),
            (
              "arn:aws:iam::" + $account
              + ":role/" + $app
              + "-foundation-authority-retirement-execution"
            )
          ]
        },
        {
          Sid: "InspectFoundationRetirementRolePolicies",
          Effect: "Allow",
          Action: "iam:GetRolePolicy",
          Resource: [
            (
              "arn:aws:iam::" + $account
              + ":role/" + $app
              + "-foundation-authority-retirement-execution"
            )
          ]
        },
        {
          Sid: "InspectOwnAuthorityContract",
          Effect: "Allow",
          Action: [
            "iam:GetRole",
            "iam:GetRolePolicy",
            "iam:ListAttachedRolePolicies",
            "iam:ListInstanceProfilesForRole",
            "iam:ListRolePolicies"
          ],
          Resource: $migrationRole
        },
        {
          Sid: "InspectAuthorityStack",
          Effect: "Allow",
          Action: [
            "cloudformation:DescribeStackEvents",
            "cloudformation:DescribeStacks",
            "cloudformation:GetTemplate",
            "cloudformation:ListStackResources"
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
        "One-time, approval-gated authority for the protected Archon foundation storage migration. The original source commit and canonical template digest are bound through exact stack parameters and stack tags. A separate permanent controller retires this stack after migration; abort preserves it for explicit administrator retirement.",
      Metadata: {
        AuthorityCreationContract: {
          SourceCommitParameter: "SourceCommit",
          TemplateSha256Parameter: "AuthorityTemplateSha256",
          RequiredStackTagKeys: [
            "SourceCommit",
            "AuthorityTemplateSha256"
          ]
        },
        TerminalLifecycleSafetyContract: {
          Version: 2,
          SelfDeletionAllowed: false,
          PermanentControllerRequired: true
        }
      },
      Parameters: {
        SourceCommit: {
          Type: "String",
          AllowedPattern: "^[0-9a-f]{40}$"
        },
        AuthorityTemplateSha256: {
          Type: "String",
          AllowedPattern: "^[0-9a-f]{64}$"
        }
      },
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
        },
        FoundationMigrationRoleId: {
          Value: {"Fn::GetAtt":["FoundationMigrationRole","RoleId"]}
        }
      }
    }'
}

# Hash exactly one compact, recursively key-sorted JSON object without a line
# terminator so the creation binding is identical on Linux and Windows.
canonical_json_bytes() {
  jq -Scj -s '
    if length != 1 then
      error("expected exactly one JSON document")
    elif (.[0] | type) != "object" then
      error("expected one JSON object")
    else
      .[0]
    end
  ' "$@"
}

canonical_template_body_bytes() {
  jq -Scj -s '
    if length != 1 then
      error("expected exactly one template response")
    else
      (
        .[0].TemplateBody
        | if type == "string" then fromjson else . end
      ) as $body
      | if ($body | type) != "object" then
          error("expected one template object")
        else
          $body
        end
    end
  ' "$@"
}

canonical_json_sha256() {
  canonical_json_bytes "$@" | sha256sum | awk '{print $1}'
}

canonical_template_body_sha256() {
  canonical_template_body_bytes "$@" | sha256sum | awk '{print $1}'
}

legacy_lf_template_body_sha256() {
  canonical_template_body_bytes "$@" |
    { cat; printf '\n'; } |
    sha256sum |
    awk '{print $1}'
}

legacy_crlf_template_body_sha256() {
  canonical_template_body_bytes "$@" |
    { cat; printf '\r\n'; } |
    sha256sum |
    awk '{print $1}'
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
  render-template-sha256)
    render_template | canonical_json_sha256
    ;;
  verify|verify-intrinsic|verify-retirement-retry|verify-retirement-orphaned)
    : "${AWS_FOUNDATION_MIGRATION_ROLE_ARN:?}"
    test "$AWS_FOUNDATION_MIGRATION_ROLE_ARN" = "$migration_role_arn"
    if [ "$mode" = "verify" ]; then
      : "${TARGET_SHA:?}"
      [[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]]
    fi
    expected_stack_status=CREATE_COMPLETE
    orphaned_retirement=false
    if [ "$mode" = "verify-retirement-retry" ] ||
        [ "$mode" = "verify-retirement-orphaned" ]; then
      expected_stack_status=DELETE_FAILED
    fi
    if [ "$mode" = "verify-retirement-orphaned" ]; then
      orphaned_retirement=true
    fi
    work_dir="$(mktemp -d)"
    cleanup() {
      rm -rf -- "$work_dir"
    }
    trap cleanup EXIT
    expected_trust="$work_dir/expected-trust.json"
    expected_policy="$work_dir/expected-policy.json"
    live_role="$work_dir/live-role.json"
    live_policy="$work_dir/live-policy.json"
    live_inline_policies="$work_dir/live-inline-policies.json"
    live_attached_policies="$work_dir/live-attached-policies.json"
    live_instance_profiles="$work_dir/live-instance-profiles.json"
    live_role_inventory="$work_dir/live-role-inventory.json"
    role_absence_error="$work_dir/role-absence-error.txt"
    final_role_absence_error="$work_dir/final-role-absence-error.txt"
    policy_evidence="$work_dir/policy-evidence.json"
    live_stack="$work_dir/live-stack.json"
    live_template="$work_dir/live-template.json"
    expected_template="$work_dir/expected-template.json"
    render_trust >"$expected_trust"
    render_policy >"$expected_policy"
    render_template >"$expected_template"
    if [ "$orphaned_retirement" = "true" ]; then
      if aws iam get-role \
          --role-name "$role_name" \
          --output json >"$live_role" 2>"$role_absence_error"; then
        echo \
          "foundation authority verification failed: orphaned-role-present" \
          >&2
        exit 1
      fi
      if ! grep -Eq \
          "^An error occurred \\(NoSuchEntity\\) when calling the GetRole operation: .*${role_name}.*$" \
          "$role_absence_error"; then
        echo \
          "foundation authority verification failed: orphaned-role-absence-unproven" \
          >&2
        exit 1
      fi
    else
      aws iam get-role \
        --role-name "$role_name" \
        --output json >"$live_role"
      aws iam get-role-policy \
        --role-name "$role_name" \
        --policy-name "$policy_name" \
        --output json >"$live_policy"
      aws iam list-role-policies \
        --role-name "$role_name" \
        --no-paginate \
        --output json >"$live_inline_policies"
      aws iam list-attached-role-policies \
        --role-name "$role_name" \
        --no-paginate \
        --output json >"$live_attached_policies"
      aws iam list-instance-profiles-for-role \
        --role-name "$role_name" \
        --no-paginate \
        --output json >"$live_instance_profiles"
      jq -n \
        --slurpfile inline "$live_inline_policies" \
        --slurpfile attached "$live_attached_policies" \
        --slurpfile profiles "$live_instance_profiles" \
        '{
          inlinePolicyNames: $inline[0].PolicyNames,
          inlinePoliciesTruncated: ($inline[0].IsTruncated // false),
          attachedPolicies: $attached[0].AttachedPolicies,
          attachedPoliciesTruncated: ($attached[0].IsTruncated // false),
          instanceProfiles: $profiles[0].InstanceProfiles,
          instanceProfilesTruncated: ($profiles[0].IsTruncated // false)
        }' >"$live_role_inventory"
      jq -e \
        --arg policy "$policy_name" \
        '
          . == {
            inlinePolicyNames: [$policy],
            inlinePoliciesTruncated: false,
            attachedPolicies: [],
            attachedPoliciesTruncated: false,
            instanceProfiles: [],
            instanceProfilesTruncated: false
          }
        ' "$live_role_inventory" >/dev/null
      jq . "$live_policy" >"$policy_evidence"
    fi
    aws cloudformation describe-stacks \
      --stack-name "${APP_NAME}-foundation-migration-authority" \
      --region "$AWS_REGION" \
      --output json >"$live_stack"
    aws cloudformation get-template \
      --stack-name "${APP_NAME}-foundation-migration-authority" \
      --template-stage Original \
      --region "$AWS_REGION" \
      --output json >"$live_template"
    live_resources="$work_dir/live-resources.json"
    aws cloudformation list-stack-resources \
      --stack-name "${APP_NAME}-foundation-migration-authority" \
      --region "$AWS_REGION" \
      --output json >"$live_resources"

    expected_template_digest="$(
      canonical_json_sha256 "$expected_template"
    )"
    live_template_digest="$(
      canonical_template_body_sha256 "$live_template"
    )"
    proof_template_digest="$live_template_digest"
    recorded_template_terminator="none"
    template_canonicalization="jq-sort-compact-no-terminator-v1"
    legacy_template_digest_accepted=false

    if [ "$mode" = "verify" ]; then
      test "$live_template_digest" = "$expected_template_digest"
      jq -e \
        --arg arn "$migration_role_arn" \
        --arg sourceCommit "$TARGET_SHA" \
        --arg templateSha256 "$expected_template_digest" \
        --arg app "$APP_NAME" \
        --slurpfile trust "$expected_trust" \
        '
          def tag_map:
            map({key:.Key, value:.Value}) | from_entries;
          .Role.Arn == $arn
          and .Role.MaxSessionDuration == 3600
          and ((.Role.PermissionsBoundary // null) == null)
          and ((.Role.Description // null) == null)
          and .Role.AssumeRolePolicyDocument == $trust[0]
          and (
            [
              .Role.Tags[]
              | select(.Key | startswith("aws:cloudformation:") | not)
            ] | tag_map
          ) == {
            Application: $app,
            Environment: "bootstrap",
            Lifecycle: "one-time-migration-authority",
            ManagedBy: "CloudFormation",
            SourceCommit: $sourceCommit,
            AuthorityTemplateSha256: $templateSha256
          }
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
        --arg account "$AWS_ACCOUNT_ID" \
        --arg stack "${APP_NAME}-foundation-migration-authority" \
        --arg roleArn "$migration_role_arn" \
        --arg roleId "$(jq -er '.Role.RoleId' "$live_role")" \
        --arg sourceCommit "$TARGET_SHA" \
        --arg templateSha256 "$expected_template_digest" \
        --arg stackStatus "$expected_stack_status" \
        '
          def parameter_map:
            map({key:.ParameterKey, value:.ParameterValue}) | from_entries;
          def tag_map:
            map({key:.Key, value:.Value}) | from_entries;
          (.Stacks | length) == 1
          and .Stacks[0].StackName == $stack
          and .Stacks[0].StackId == (
            "arn:aws:cloudformation:eu-west-1:" + $account
            + ":stack/" + $stack + "/"
            + (.Stacks[0].StackId | split("/") | last)
          )
          and (.Stacks[0].StackId | split("/") | length) == 3
          and .Stacks[0].StackStatus == $stackStatus
          and .Stacks[0].EnableTerminationProtection == false
          and ((.Stacks[0].RoleARN // null) == null)
          and ((.Stacks[0].NotificationARNs // []) == [])
          and (.Stacks[0].Capabilities // []) == ["CAPABILITY_NAMED_IAM"]
          and (.Stacks[0].Parameters | length) == 2
          and (.Stacks[0].Parameters | parameter_map) == {
            SourceCommit: $sourceCommit,
            AuthorityTemplateSha256: $templateSha256
          }
          and ((.Stacks[0].Tags // []) | length) == 2
          and ((.Stacks[0].Tags // []) | tag_map) == {
            SourceCommit: $sourceCommit,
            AuthorityTemplateSha256: $templateSha256
          }
          and (
            [
              .Stacks[0].Outputs[]
              | select(.OutputKey == "FoundationMigrationRoleArn")
              | .OutputValue
            ]
          ) == [$roleArn]
          and (
            [
              .Stacks[0].Outputs[]
              | select(.OutputKey == "FoundationMigrationRoleId")
              | .OutputValue
            ]
          ) == [$roleId]
        ' "$live_stack" >/dev/null
      jq -e \
        --slurpfile expected "$expected_template" \
        '
          (
            .TemplateBody
            | if type == "string" then fromjson else . end
          ) == $expected[0]
        ' "$live_template" >/dev/null
    else
      source_commit="$(
        jq -er '
          def parameter_map:
            map({key:.ParameterKey, value:.ParameterValue}) | from_entries;
          .Stacks[0].Parameters | parameter_map | .SourceCommit
          | select(test("^[0-9a-f]{40}$"))
        ' "$live_stack"
      )"
      recorded_template_digest="$(
        jq -er '
          def parameter_map:
            map({key:.ParameterKey, value:.ParameterValue}) | from_entries;
          .Stacks[0].Parameters | parameter_map | .AuthorityTemplateSha256
          | select(test("^[0-9a-f]{64}$"))
        ' "$live_stack"
      )"
      # Terminal-lifecycle byte compatibility is limited to authorities that
      # still satisfy the current non-self-deleting safety contract. Unsafe
      # historical authorities remain external-administrator-only. The three
      # candidates below differ only by an exact trailing byte sequence.
      legacy_lf_template_digest="$(
        legacy_lf_template_body_sha256 "$live_template"
      )"
      legacy_crlf_template_digest="$(
        legacy_crlf_template_body_sha256 "$live_template"
      )"
      if [ "$orphaned_retirement" = "true" ] &&
          [ "$recorded_template_digest" != "$live_template_digest" ]; then
        echo \
          "foundation authority verification failed: orphaned-template-not-canonical" \
          >&2
        exit 1
      fi
      if [ "$recorded_template_digest" = "$live_template_digest" ]; then
        recorded_template_terminator="none"
      elif [ "$recorded_template_digest" = "$legacy_lf_template_digest" ]; then
        recorded_template_terminator="lf"
        legacy_template_digest_accepted=true
      elif [ "$recorded_template_digest" = "$legacy_crlf_template_digest" ]; then
        recorded_template_terminator="crlf"
        legacy_template_digest_accepted=true
      else
        echo \
          "foundation authority verification failed: template-digest-binding" \
          >&2
        exit 1
      fi
      proof_template_digest="$recorded_template_digest"
      if [ "$orphaned_retirement" = "true" ]; then
        role_id="$(
          jq -er '
            [
              .Stacks[0].Outputs[]
              | select(.OutputKey == "FoundationMigrationRoleId")
              | .OutputValue
            ]
            | select(length == 1)
            | .[0]
            | select(test("^AROA[A-Z0-9]{17}$"))
          ' "$live_stack"
        )"
      else
        role_id="$(jq -er '.Role.RoleId' "$live_role")"
      fi

      jq -e \
        --arg account "$AWS_ACCOUNT_ID" \
        --arg stack "${APP_NAME}-foundation-migration-authority" \
        --arg roleArn "$migration_role_arn" \
        --arg roleId "$role_id" \
        --arg retirementExecutionRoleArn \
          "arn:aws:iam::${AWS_ACCOUNT_ID}:role/${APP_NAME}-foundation-authority-retirement-execution" \
        --arg sourceCommit "$source_commit" \
        --arg templateSha256 "$recorded_template_digest" \
        --arg stackStatus "$expected_stack_status" \
        '
          def parameter_map:
            map({key:.ParameterKey, value:.ParameterValue}) | from_entries;
          def tag_map:
            map({key:.Key, value:.Value}) | from_entries;
          (.Stacks | length) == 1
          and .Stacks[0].StackName == $stack
          and .Stacks[0].StackId == (
            "arn:aws:cloudformation:eu-west-1:" + $account
            + ":stack/" + $stack + "/"
            + (.Stacks[0].StackId | split("/") | last)
          )
          and (.Stacks[0].StackId | split("/") | length) == 3
          and .Stacks[0].StackStatus == $stackStatus
          and .Stacks[0].EnableTerminationProtection == false
          and (
            if $stackStatus == "DELETE_FAILED" then
              .Stacks[0].RoleARN == $retirementExecutionRoleArn
            else
              ((.Stacks[0].RoleARN // null) == null)
            end
          )
          and ((.Stacks[0].NotificationARNs // []) == [])
          and (.Stacks[0].Capabilities // []) == ["CAPABILITY_NAMED_IAM"]
          and (.Stacks[0].Parameters | length) == 2
          and (.Stacks[0].Parameters | parameter_map) == {
            SourceCommit: $sourceCommit,
            AuthorityTemplateSha256: $templateSha256
          }
          and ((.Stacks[0].Tags // []) | length) == 2
          and ((.Stacks[0].Tags // []) | tag_map) == {
            SourceCommit: $sourceCommit,
            AuthorityTemplateSha256: $templateSha256
          }
          and ((.Stacks[0].Outputs // []) | length) == 2
          and (
            [.Stacks[0].Outputs[].OutputKey] | sort
          ) == ([
            "FoundationMigrationRoleArn",
            "FoundationMigrationRoleId"
          ] | sort)
          and (
            [
              .Stacks[0].Outputs[]
              | select(.OutputKey == "FoundationMigrationRoleArn")
              | .OutputValue
            ]
          ) == [$roleArn]
          and (
            [
              .Stacks[0].Outputs[]
              | select(.OutputKey == "FoundationMigrationRoleId")
              | .OutputValue
            ]
          ) == [$roleId]
        ' "$live_stack" >/dev/null
      if [ "$orphaned_retirement" = "true" ]; then
        jq '
          def body:
            .TemplateBody
            | if type == "string" then fromjson else . end;
          body.Resources.FoundationMigrationRole.Properties as $properties
          | {
              RoleName: $properties.RoleName,
              PolicyName: $properties.Policies[0].PolicyName,
              PolicyDocument: $properties.Policies[0].PolicyDocument
            }
        ' "$live_template" >"$policy_evidence"
        contract_trust="$(jq -c . "$expected_trust")"
      else
        jq -e \
          --arg arn "$migration_role_arn" \
          --arg sourceCommit "$source_commit" \
          --arg templateSha256 "$recorded_template_digest" \
          --arg app "$APP_NAME" \
          --slurpfile trust "$expected_trust" \
          '
            def tag_map:
              map({key:.Key, value:.Value}) | from_entries;
            .Role.Arn == $arn
            and .Role.MaxSessionDuration == 3600
            and ((.Role.PermissionsBoundary // null) == null)
            and ((.Role.Description // null) == null)
            and .Role.AssumeRolePolicyDocument == $trust[0]
            and (
              [
                .Role.Tags[]
                | select(.Key | startswith("aws:cloudformation:") | not)
              ] | tag_map
            ) == {
              Application: $app,
              Environment: "bootstrap",
              Lifecycle: "one-time-migration-authority",
              ManagedBy: "CloudFormation",
              SourceCommit: $sourceCommit,
              AuthorityTemplateSha256: $templateSha256
            }
          ' "$live_role" >/dev/null
        contract_trust="$(
          jq -c '.Role.AssumeRolePolicyDocument' "$live_role"
        )"
      fi
      jq -e \
        --arg role "$role_name" \
        --arg policy "$policy_name" \
        --arg arn "$migration_role_arn" \
        --arg executionArn "arn:aws:iam::${AWS_ACCOUNT_ID}:role/${APP_NAME}-foundation-authority-retirement-execution" \
        --arg promotionArn "arn:aws:iam::${AWS_ACCOUNT_ID}:role/${APP_NAME}-github-foundation-promotion" \
        --slurpfile allowed "$expected_policy" \
        '
          def list:
            if type == "array" then . else [.] end;
          def subset($actual; $expected):
            all($actual[]; . as $value | any($expected[]; . == $value));
          .RoleName == $role
          and .PolicyName == $policy
          and .PolicyDocument.Version == "2012-10-17"
          and (
            .PolicyDocument.Statement | map(.Sid) | unique | length
          ) == (.PolicyDocument.Statement | length)
          and all(
            .PolicyDocument.Statement[];
            ((.Action | list) | index("cloudformation:DeleteStack")) == null
            and ((.Action | list) | index("iam:PassRole")) == null
          )
          and all(
            .PolicyDocument.Statement[];
            . as $statement
            | [
                $allowed[0].Statement[]
                | select(.Sid == $statement.Sid)
              ] as $matches
            | ($matches | length) == 1
            and ($statement | keys | sort) == ($matches[0] | keys | sort)
            and $statement.Effect == "Allow"
            and subset(
              ($statement.Action | list);
              ($matches[0].Action | list)
            )
            and subset(
              ($statement.Resource | list);
              ($matches[0].Resource | list)
            )
            and (($statement.Condition // null) == ($matches[0].Condition // null))
          )
          and any(
            .PolicyDocument.Statement[];
            .Sid == "ManageExactFoundationStack"
            and ((.Action | list) | index("cloudformation:DeleteChangeSet")) != null
            and ((.Action | list) | index("cloudformation:DetectStackResourceDrift")) != null
            and ((.Action | list) | index("cloudformation:DescribeChangeSet")) != null
            and ((.Action | list) | index("cloudformation:DescribeStacks")) != null
            and ((.Action | list) | index("cloudformation:GetStackPolicy")) != null
            and ((.Action | list) | index("cloudformation:GetTemplate")) != null
            and ((.Action | list) | index("cloudformation:ListChangeSets")) != null
            and ((.Action | list) | index("cloudformation:ListStackResources")) != null
          )
          and any(
            .PolicyDocument.Statement[];
            .Sid == "ManageExactNewFoundationRolesViaCloudFormation"
            and ((.Resource | list) | index($arn)) == null
            and ((.Resource | list) | index($executionArn)) != null
            and ((.Action | list) | index("iam:CreateRole")) != null
            and ((.Action | list) | index("iam:DeleteRole")) != null
          )
          and any(
            .PolicyDocument.Statement[];
            .Sid == "ModifyExactExistingFoundationRolesViaCloudFormation"
            and ((.Resource | list) | index($arn)) == null
            and ((.Resource | list) | index($promotionArn)) != null
            and ((.Action | list) | index("iam:CreateRole")) == null
            and ((.Action | list) | index("iam:DeleteRole")) == null
          )
          and any(
            .PolicyDocument.Statement[];
            .Sid == "InspectOwnAuthorityContract"
            and ((.Action | list) | index("iam:GetRole")) != null
            and ((.Action | list) | index("iam:GetRolePolicy")) != null
            and ((.Action | list) | index("iam:ListAttachedRolePolicies")) != null
            and ((.Action | list) | index("iam:ListInstanceProfilesForRole")) != null
            and ((.Action | list) | index("iam:ListRolePolicies")) != null
          )
          and any(
            .PolicyDocument.Statement[];
            .Sid == "InspectAuthorityStack"
            and ((.Action | list) | index("cloudformation:DeleteStack")) == null
            and ((.Action | list) | index("cloudformation:DescribeStacks")) != null
            and ((.Action | list) | index("cloudformation:GetTemplate")) != null
            and ((.Action | list) | index("cloudformation:ListStackResources")) != null
          )
        ' "$policy_evidence" >/dev/null
      contract_permissions="$(jq -c '.PolicyDocument' "$policy_evidence")"
      jq -e \
        --arg app "$APP_NAME" \
        --arg role "$role_name" \
        --arg policy "$policy_name" \
        --argjson trust "$contract_trust" \
        --argjson permissions "$contract_permissions" \
        '
          def body:
            .TemplateBody
            | if type == "string" then fromjson else . end;
          body as $template
          | ($template | keys | sort) == ([
              "AWSTemplateFormatVersion",
              "Description",
              "Metadata",
              "Outputs",
              "Parameters",
              "Resources"
            ] | sort)
          and $template.AWSTemplateFormatVersion == "2010-09-09"
          and ($template.Description | type == "string" and length > 0)
          and $template.Metadata == {
            AuthorityCreationContract: {
              SourceCommitParameter: "SourceCommit",
              TemplateSha256Parameter: "AuthorityTemplateSha256",
              RequiredStackTagKeys: [
                "SourceCommit",
                "AuthorityTemplateSha256"
              ]
            },
            TerminalLifecycleSafetyContract: {
              Version: 2,
              SelfDeletionAllowed: false,
              PermanentControllerRequired: true
            }
          }
          and $template.Parameters == {
            SourceCommit: {
              Type: "String",
              AllowedPattern: "^[0-9a-f]{40}$"
            },
            AuthorityTemplateSha256: {
              Type: "String",
              AllowedPattern: "^[0-9a-f]{64}$"
            }
          }
          and ($template.Resources | keys) == ["FoundationMigrationRole"]
          and (
            $template.Resources.FoundationMigrationRole | keys | sort
          ) == (["Properties", "Type"] | sort)
          and $template.Resources.FoundationMigrationRole.Type == "AWS::IAM::Role"
          and (
            $template.Resources.FoundationMigrationRole.Properties | keys | sort
          ) == ([
            "AssumeRolePolicyDocument",
            "MaxSessionDuration",
            "Policies",
            "RoleName",
            "Tags"
          ] | sort)
          and $template.Resources.FoundationMigrationRole.Properties.RoleName == $role
          and $template.Resources.FoundationMigrationRole.Properties.MaxSessionDuration == 3600
          and $template.Resources.FoundationMigrationRole.Properties.AssumeRolePolicyDocument == $trust
          and $template.Resources.FoundationMigrationRole.Properties.Policies == [{
            PolicyName: $policy,
            PolicyDocument: $permissions
          }]
          and $template.Resources.FoundationMigrationRole.Properties.Tags == [
            {Key:"Application", Value:$app},
            {Key:"Environment", Value:"bootstrap"},
            {Key:"Lifecycle", Value:"one-time-migration-authority"},
            {Key:"ManagedBy", Value:"CloudFormation"}
          ]
          and $template.Outputs == {
            FoundationMigrationRoleArn: {
              Value: {"Fn::GetAtt":["FoundationMigrationRole","Arn"]}
            },
            FoundationMigrationRoleId: {
              Value: {"Fn::GetAtt":["FoundationMigrationRole","RoleId"]}
            }
          }
        ' "$live_template" >/dev/null
    fi

    jq -e \
      --arg role "$role_name" \
      --arg verificationMode "$mode" \
      '
      (.StackResourceSummaries | length) == 1
      and ((.NextToken // null) == null)
      and .StackResourceSummaries[0].LogicalResourceId
        == "FoundationMigrationRole"
      and .StackResourceSummaries[0].ResourceType == "AWS::IAM::Role"
      and (
        if ($verificationMode | IN(
          "verify-retirement-retry",
          "verify-retirement-orphaned"
        )) then
          .StackResourceSummaries[0].ResourceStatus
            | IN("CREATE_COMPLETE", "DELETE_FAILED")
        else
          .StackResourceSummaries[0].ResourceStatus == "CREATE_COMPLETE"
        end
      )
      and .StackResourceSummaries[0].PhysicalResourceId == $role
    ' "$live_resources" >/dev/null
    resource_status="$(
      jq -er '.StackResourceSummaries[0].ResourceStatus' "$live_resources"
    )"
    if [ "$orphaned_retirement" = "true" ]; then
      if aws iam get-role \
          --role-name "$role_name" \
          --output json >"$live_role" 2>"$final_role_absence_error"; then
        echo \
          "foundation authority verification failed: orphaned-role-reappeared" \
          >&2
        exit 1
      fi
      if ! grep -Eq \
          "^An error occurred \\(NoSuchEntity\\) when calling the GetRole operation: .*${role_name}.*$" \
          "$final_role_absence_error"; then
        echo \
          "foundation authority verification failed: final-orphaned-role-absence-unproven" \
          >&2
        exit 1
      fi
    fi
    if [ "$orphaned_retirement" = "true" ]; then
      trust_digest="$(
        jq -Sc '
          def body:
            .TemplateBody
            | if type == "string" then fromjson else . end;
          body.Resources.FoundationMigrationRole.Properties
            .AssumeRolePolicyDocument
        ' "$live_template" |
          sha256sum |
          awk '{print $1}'
      )"
      role_attachment_inventory_digest=""
      role_identity_evidence_source=cloudformation-output
      trust_policy_evidence_source=cloudformation-template
      permissions_policy_evidence_source=cloudformation-template
    else
      role_id="$(jq -er '.Role.RoleId' "$live_role")"
      trust_digest="$(
        jq -Sc '.Role.AssumeRolePolicyDocument' "$live_role" |
          sha256sum |
          awk '{print $1}'
      )"
      role_attachment_inventory_digest="$(
        jq -Sc . "$live_role_inventory" |
          sha256sum |
          awk '{print $1}'
      )"
      role_identity_evidence_source=iam-get-role
      trust_policy_evidence_source=iam-get-role
      permissions_policy_evidence_source=iam-get-role-policy
    fi
    policy_digest="$(
      jq -Sc '.PolicyDocument' "$policy_evidence" |
        sha256sum |
        awk '{print $1}'
    )"
    jq -n \
      --arg roleArnSha256 "$(
        printf '%s' "$migration_role_arn" |
          sha256sum |
          awk '{print $1}'
      )" \
      --arg roleIdSha256 "$(
        printf '%s' "$role_id" |
          sha256sum |
          awk '{print $1}'
      )" \
      --arg trustSha256 "$trust_digest" \
      --arg policySha256 "$policy_digest" \
      --arg roleAttachmentInventorySha256 \
        "$role_attachment_inventory_digest" \
      --arg roleIdentityEvidenceSource "$role_identity_evidence_source" \
      --arg trustPolicyEvidenceSource "$trust_policy_evidence_source" \
      --arg permissionsPolicyEvidenceSource \
        "$permissions_policy_evidence_source" \
      --arg recordedTemplateSha256 "$proof_template_digest" \
      --arg canonicalTemplateSha256 "$live_template_digest" \
      --arg templateCanonicalization "$template_canonicalization" \
      --arg recordedTemplateTerminator "$recorded_template_terminator" \
      --argjson legacyTemplateDigestAccepted \
        "$legacy_template_digest_accepted" \
      --arg stackIdSha256 "$(
        jq -ejr '.Stacks[0].StackId' "$live_stack" |
          sha256sum |
          awk '{print $1}'
      )" \
      --arg sourceCommit "$(
        if [ "$mode" = "verify" ]; then
          printf '%s' "$TARGET_SHA"
        else
          printf '%s' "$source_commit"
        fi
      )" \
      --arg stackStatus "$(jq -er '.Stacks[0].StackStatus' "$live_stack")" \
      --arg resourceStatus "$resource_status" \
      --arg verificationMode "$mode" \
      --argjson orphanedRetirement "$orphaned_retirement" \
      --argjson exact "$(
        if [ "$mode" = "verify" ]; then
          printf 'true'
        else
          printf 'false'
        fi
      )" \
      --argjson retryExact "$(
        if [ "$mode" = "verify-retirement-retry" ]; then
          printf 'true'
        else
          printf 'false'
        fi
      )" \
      '{
        schema: "archon.aws.foundation-migration-authority",
        schemaVersion: 2,
        ok: true,
        oneTime: true,
        roleArnSha256: $roleArnSha256,
        roleIdSha256: $roleIdSha256,
        roleIdentityEvidenceSource: $roleIdentityEvidenceSource,
        roleIdLiveVerified: ($orphanedRetirement | not),
        authorityRolePresent: ($orphanedRetirement | not),
        roleAbsenceVerified: $orphanedRetirement,
        roleAbsenceChecks: (if $orphanedRetirement then 2 else 0 end),
        roleAbsenceFreshAtProofEmission: $orphanedRetirement,
        roleAbsenceErrorCode: (
          if $orphanedRetirement then "NoSuchEntity" else null end
        ),
        trustPolicySha256: $trustSha256,
        trustPolicyEvidenceSource: $trustPolicyEvidenceSource,
        permissionsPolicySha256: $policySha256,
        permissionsPolicyEvidenceSource: $permissionsPolicyEvidenceSource,
        roleAttachmentInventorySha256: (
          if $orphanedRetirement then
            null
          else
            $roleAttachmentInventorySha256
          end
        ),
        authorityTemplateSha256: $recordedTemplateSha256,
        recordedAuthorityTemplateSha256: $recordedTemplateSha256,
        canonicalAuthorityTemplateSha256: $canonicalTemplateSha256,
        templateCanonicalization: $templateCanonicalization,
        recordedTemplateTerminator: $recordedTemplateTerminator,
        legacyTemplateDigestAccepted: $legacyTemplateDigestAccepted,
        authorityStackIdSha256: $stackIdSha256,
        sourceCommit: $sourceCommit,
        stackStatus: $stackStatus,
        resourceStatus: $resourceStatus,
        verificationMode: $verificationMode,
        resourceCount: 1,
        liveContractExact: $exact,
        cloudFormationCreationContractExact: $exact,
        retirementRetryContractExact: $retryExact,
        standardDeleteRetryEligible: $retryExact,
        orphanedRetirementContractExact: $orphanedRetirement,
        targetedRetainReconciliationEligible: $orphanedRetirement,
        requiredRetainResources: (
          if $orphanedRetirement then
            ["FoundationMigrationRole"]
          else
            []
          end
        ),
        forceDeleteEligible: false,
        intrinsicSafetyContractVerified: true,
        terminalLifecycleSafetyContractVersion: 2,
        creationBindingVerified: true,
        trustRepositoryBound: true,
        roleRuntimeContractVerified: ($orphanedRetirement | not),
        roleAttachmentContractVerified: ($orphanedRetirement | not),
        selfDeletionAllowed: false,
        permanentRetirementControllerRequired: true,
        retirementRequired: true
      }'
    ;;
esac
