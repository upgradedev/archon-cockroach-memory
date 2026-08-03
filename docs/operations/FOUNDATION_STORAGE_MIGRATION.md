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
- an ACL-compatible CloudFront standard-access-log bucket with explicit
  S3-managed `AES256` encryption and no dedicated billable KMS key;
- generated staging and production origin-verification secrets whose values
  are never read by the workflow;
- deterministic, repository-bound edge and FinOps control roles, including a
  separate FinOps CloudFormation execution role; and
- a target stack policy that prevents replacement or deletion of the new
  control-plane resources.

The application workload remains in `eu-west-1`. `us-east-1` is used only by
CloudFront WAF and AWS billing control planes. This procedure creates nothing
in `us-west-2`.

The approved incremental fixed control-plane ceiling is `$26.00/month`. The
source cost contract is `$22.40/month` initially and at most `$24.40/month`
after the application key reaches its maximum billed rotated-key state. That
contract covers two WebACLs with five rules each, six standard-resolution
alarms, two Secrets Manager secrets, and the single application KMS key. WAF
requests, log ingestion/storage, S3, and EventBridge usage remain variable
and are not represented as fixed cost. Any source change that exceeds the
ceiling must fail CI and requires a new explicit approval before AWS planning.

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

The current authority contract requires the source commit and canonical
authority-template digest as both exact stack parameters and the only two stack
tags. An authority stack created from an older, pre-binding contract cannot be
adopted or upgraded by this workflow: an administrator must delete it and
recreate it from Phase 0 below. No authority stack has been created as part of
this repository work.

## Phase 0: create the one-time authority

Prerequisites:

- explicit approval for the temporary IAM authority;
- administrator credentials in an approved ephemeral operator environment;
- exact `AWS_ACCOUNT_ID`, `APP_NAME`, repository ID, owner ID, and existing
  GitHub OIDC provider ARN; and
- the protected `bootstrap` GitHub environment already configured with a
  required reviewer.

From the exact approved main commit, export the inputs required by
`aws/foundation-migration-authority.sh`. The worktree must contain only that
committed source. Bind `HEAD` and the canonical rendered-template digest,
render the template only in memory, and submit it directly to CloudFormation;
do not save a rendered copy:

```bash
test -z "$(git status --porcelain=v1)"
git fetch --no-tags --depth=1 origin main
SOURCE_COMMIT=$(git rev-parse HEAD)
test "$(git rev-parse origin/main)" = "$SOURCE_COMMIT"
AUTHORITY_TEMPLATE_SHA256=$(
  bash aws/foundation-migration-authority.sh render-template-sha256
)
authority_template=$(
  bash aws/foundation-migration-authority.sh render-template
)
test "$(
  printf '%s' "$authority_template" | jq -Sc . | sha256sum | awk '{print $1}'
)" = "$AUTHORITY_TEMPLATE_SHA256"
aws cloudformation create-stack \
  --stack-name "${APP_NAME}-foundation-migration-authority" \
  --template-body "$authority_template" \
  --parameters \
    "ParameterKey=SourceCommit,ParameterValue=${SOURCE_COMMIT}" \
    "ParameterKey=AuthorityTemplateSha256,ParameterValue=${AUTHORITY_TEMPLATE_SHA256}" \
  --tags \
    "Key=SourceCommit,Value=${SOURCE_COMMIT}" \
    "Key=AuthorityTemplateSha256,Value=${AUTHORITY_TEMPLATE_SHA256}" \
  --capabilities CAPABILITY_NAMED_IAM \
  --on-failure ROLLBACK \
  --no-enable-termination-protection \
  --region eu-west-1
unset authority_template
```

The create request intentionally omits `--role-arn`; it also supplies no extra
stack tag, notification ARN, or resource. Wait for `CREATE_COMPLETE`. The live
stack must have termination protection disabled, no CloudFormation `RoleARN`,
exactly the two matching stack tags and parameters above, and exactly one
resource: `FoundationMigrationRole`. The role inherits the two creation tags in
addition to its four canonical role tags. Do not attach policies, change the
trust, enable termination protection, or create the role outside this generated
CloudFormation contract. The workflow independently proves the committed source
binding, original template, trust, inline policy, stack, and one-resource
inventory before it can plan, apply, abort, or retire.

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
3. If the one-time authority must be retired without continuing the normal
   plan/apply/retire sequence, dispatch `abort` from the current green `main`
   SHA with
   `ABORT-FOUNDATION-MIGRATION-AND-RETIRE-AUTHORITY`. This is a terminal
   authority-cleanup path, not a foundation rollback. It does not require the
   permanent foundation role. The job intrinsically proves the historical
   authority creation binding, trust, policy, template, and single resource.
   It fetches the generator from the recorded, verified ancestor commit, runs
   only its `render-template` mode in a credential-free environment, and
   requires that canonical digest to equal both the recorded and live template;
   proves the target foundation is stable; and snapshots its stack, template,
   policy, and resource inventory. If `abort` succeeds, stop this sequence.
4. Before deleting anything, `abort` enumerates every target-stack change set.
   The complete inventory must contain only `foundation-storage-*` plans in
   `CREATE_COMPLETE` with `AVAILABLE|OBSOLETE` execution state and no import.
   Any unrelated, failed, pending, executing, or otherwise unexpected plan
   rejects the entire abort. Each eligible plan is then independently bound to
   its description, historical repository commit, source-template digest,
   parameters, tags, target stack, and non-importing UPDATE contract. It then
   re-describes the exact ID and safe state immediately before every deletion.
   A second complete inventory must be empty immediately before authority
   deletion, so a concurrent unrelated, pending, or executing plan fails closed.
   The target foundation projection, original
   template, stack policy, and resource inventory must remain byte-digest
   identical before and after cleanup. Finally the exact authority stack is
   deleted and both its stack and role are proved absent; only sanitized hashes
   and source digests enter the receipt.
5. Otherwise dispatch `apply` for the same SHA with
   `APPLY-PROTECTED-FOUNDATION-STORAGE-MIGRATION`.
6. Review the live storage, secret-metadata, role, bucket-policy,
   server-access-logging, deployed-template, and target-stack-policy proofs.
7. Dispatch `retire` for the same SHA with
   `RETIRE-FOUNDATION-MIGRATION-AUTHORITY`. The permanent foundation role must
   first prove the migrated controls. Immediately before deletion, the
   destructive job repeats the live-controls proof, exact deployed-template and
   stack-policy comparisons, permanent-role trust/policy and CloudFormation
   `IN_SYNC` drift proof, and the empty all-change-set inventory. It requires
   the fresh controls digest to match the preceding permanent-role proof and
   binds a fresh composite digest into the receipt. The temporary stack then
   deletes itself and the workflow proves both stack and role are absent.
8. Dispatch `verify` for the same SHA with an empty confirmation. This uses
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
promise. The stack policy is restored automatically only before execution is
dispatched, or after the workflow observes the exact terminal
`UPDATE_ROLLBACK_COMPLETE` state. After dispatch, ambiguous CLI, network, or
polling failures retain the target policy and fail closed; the error trap never
restores the old policy. A post-success reversion is a
separate destructive change, requires a new approved recovery procedure, and
must account for the retained application KMS key and alias, secrets, buckets,
and IAM roles.
Never improvise deletion or replacement of retained resources.

The `plan`/`apply` job also has same-run `always()` cleanup for a plan that was
created or loaded but failed creation, loading, or exact inspection. Cleanup
runs only when the exact change-set ID was captured. It re-proves the current
green SHA, candidate template digest, exact target stack and AVAILABLE UPDATE
metadata, parameters, tags, role/notification/import boundaries, deletes that
one unexecuted plan, proves it absent, and proves the target stack projection
unchanged. Immediately before deletion it re-describes the exact ID and again
requires `CREATE_COMPLETE`/`AVAILABLE`, UPDATE, and non-importing state. It does
not execute or repair a plan and emits only hashes for the
change-set ARN/name/description. A failure before an ID is safely bound leaves
no cleanup authority assumption; use the separately approved `abort` path only
after its full inventory gate passes.

## Expected evidence

All uploaded evidence is SHA-bound and sanitized:

- one-time authority trust/policy/role digests;
- candidate template, parameter, stack-policy, change-set, and recovery-anchor
  digests;
- explicit additive/non-replacement change classification;
- live application-KMS rotation, alias, encryption-context and bucket-key
  proofs, plus S3-managed `AES256` CloudFront-log encryption, bucket-policy,
  lifecycle, logging, secret-metadata, and OIDC trust proofs;
- edge and FinOps controller/execution role ARN digests, never raw ARNs; and
- proof that the temporary authority was retired, either after the migrated
  permanent authority was proved or through the bounded no-foundation-mutation
  `abort` path.

Secret values, account IDs, account-bearing ARNs, credentials, and rendered
temporary templates must not be placed in repository files, logs, or uploaded
receipts. The only intentionally retained raw AWS locator in the protected
90-day receipt is the deterministic, account-neutral pre-state S3 object key;
the candidate and pre-state version IDs, object content, and surrounding AWS
resources are digest-bound. An approved recovery resolves the exact version
under separately authorized S3 access and verifies its recorded checksum before
use.
