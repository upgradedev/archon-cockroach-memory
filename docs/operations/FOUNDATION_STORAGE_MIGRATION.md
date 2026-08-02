# Protected foundation storage migration

Status: source-complete; no live migration has been run. Creating the one-time
authority, applying the foundation change set, and retiring that authority are
external AWS mutations and require explicit human approval.

## Purpose

This runbook moves the existing `eu-west-1` foundation stack from legacy
SSE-S3 artifact storage to the protected storage/control contract required by
the application:

- one rotating customer-managed KMS key for immutable deployment, recovery,
  private SPA, and origin-verification data;
- a separate rotating KMS key and ACL-compatible bucket used only for
  CloudFront standard access logs;
- generated staging and production origin-verification secrets whose values
  are never read by the workflow;
- deterministic, repository-bound edge and FinOps control roles, including a
  separate FinOps CloudFormation execution role; and
- a target stack policy that prevents replacement or deletion of the new
  control-plane resources.

The application workload remains in `eu-west-1`. `us-east-1` is used only by
CloudFront WAF and AWS billing control planes. This procedure creates nothing
in `us-west-2`.

## Authority model

The current foundation role intentionally cannot grant itself the permissions
needed for this migration. An AWS administrator must therefore create one
temporary CloudFormation stack named
`<app>-foundation-migration-authority`. That stack contains exactly one OIDC
role:

`arn:aws:iam::<account>:role/<app>-github-foundation-migration`

Its trust is bound to the exact GitHub repository and numeric repository/owner
IDs, `refs/heads/main`, the protected `bootstrap` environment, and the
`Foundation Storage Migration` workflow. Its inline policy is generated from
[`aws/foundation-migration-authority.sh`](../../aws/foundation-migration-authority.sh)
and permits only the enumerated additive migration, its encrypted recovery
anchor, and its own retirement.

No mutable GitHub role-ARN variable is used. The workflow derives the exact ARN
from the validated AWS account and application name.

## Phase 0: create the one-time authority

Prerequisites:

- explicit approval for the temporary IAM authority;
- administrator credentials in an approved ephemeral operator environment;
- exact `AWS_ACCOUNT_ID`, `APP_NAME`, repository ID, owner ID, and existing
  GitHub OIDC provider ARN; and
- the protected `bootstrap` GitHub environment already configured with a
  required reviewer.

From the exact approved main commit, export the inputs required by
`aws/foundation-migration-authority.sh`. Render the template in memory and
submit it directly to CloudFormation with
`CAPABILITY_NAMED_IAM`; do not save a rendered copy:

```bash
authority_template="$(bash aws/foundation-migration-authority.sh render-template)"
aws cloudformation create-stack \
  --stack-name "${APP_NAME}-foundation-migration-authority" \
  --template-body "$authority_template" \
  --capabilities CAPABILITY_NAMED_IAM \
  --region eu-west-1
unset authority_template
```

Wait for `CREATE_COMPLETE`. Do not attach policies, change the trust, enable
termination protection, or create the role outside this generated
CloudFormation contract. The workflow independently compares the live trust,
inline policy, stack, and original template with the source-generated
contract before it can plan or apply.

## Pipeline sequence

Use `.github/workflows/foundation-migration.yml` against one exact, current,
green main SHA:

1. Dispatch `plan` with an empty confirmation.
2. Review the sanitized plan receipt and the CloudFormation change set. It
   must contain every `requiredNewResources` entry and only the modifications
   listed in
   [`aws/foundation-storage-migration-policy.json`](../../aws/foundation-storage-migration-policy.json).
   Any remove, import, replacement, unexpected parameter, tag, role ARN,
   notification ARN, rollback trigger, or resource fails closed.
3. Dispatch `apply` for the same SHA with
   `APPLY-PROTECTED-FOUNDATION-STORAGE-MIGRATION`.
4. Review the live storage, secret-metadata, role, bucket-policy,
   server-access-logging, deployed-template, and target-stack-policy proofs.
5. Dispatch `retire` for the same SHA with
   `RETIRE-FOUNDATION-MIGRATION-AUTHORITY`. The permanent foundation role must
   first prove the migrated controls. The temporary stack then deletes itself
   and the workflow proves both stack and role are absent.
6. Dispatch `verify` for the same SHA with an empty confirmation. This uses
   only the permanent foundation role and produces the exact receipt consumed
   by the application deployment source gate.

Do not start an application deployment until the final `verify` receipt and
the staging/production edge-control receipts exist for that same SHA.

## Recovery boundary

Before planning or applying, the workflow stores a deterministic archive of
the current template, stack policy, canonical parameters, and manifest in the
versioned foundation artifact namespace. The receipt binds its object version,
checksum, encryption mode, and manifest digest.

That archive is evidence and a recovery input; it is not an automatic rollback
promise. The stack policy is restored automatically if execution has not
started or CloudFormation rolls the update back. A post-success reversion is a
separate destructive change, requires a new approved recovery procedure, and
must account for retained KMS keys, aliases, secrets, buckets, and IAM roles.
Never improvise deletion or replacement of retained resources.

## Expected evidence

All uploaded evidence is SHA-bound and sanitized:

- one-time authority trust/policy/role digests;
- candidate template, parameter, stack-policy, change-set, and recovery-anchor
  digests;
- explicit additive/non-replacement change classification;
- live KMS rotation, alias, encryption-context, bucket-key, bucket-policy,
  lifecycle, logging, secret-metadata, and OIDC trust proofs;
- edge and FinOps controller/execution role ARN digests, never raw ARNs; and
- proof that the temporary authority was retired.

Secret values, raw AWS resource identifiers, credentials, and rendered
temporary templates must not be placed in repository files, logs, or uploaded
receipts.
