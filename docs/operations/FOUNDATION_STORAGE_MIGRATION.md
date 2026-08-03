# Protected foundation storage migration

Status: no foundation change set has been applied. A legacy self-deleting abort
attempt removed the temporary IAM role but left its CloudFormation stack in
`DELETE_FAILED`. Do not rerun that path. The v2 non-self-deleting lifecycle is
repository-prepared, but recovery of the legacy orphaned stack remains pending
because that historical stack is not v2-eligible; the new source contract also
still requires exact-main CI validation. No foundation mutation or legacy
recovery is claimed complete by this document.

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
  separate FinOps CloudFormation execution role;
- a permanent `FoundationPromotionRole` controller and a dedicated
  `FoundationAuthorityRetirementExecutionRole` used by CloudFormation only to
  retire the temporary authority; and
- a target stack policy that prevents replacement or deletion of the new
  control-plane resources.

The application workload remains in `eu-west-1`. `us-east-1` is used only by
CloudFront WAF and AWS billing control planes. This procedure creates nothing
in `us-west-2`.

All AWS mutation jobs join the queued
`aws-shared-control-plane-mutation` job-level concurrency group. This serializes
bootstrap, foundation migration/abort/retirement, edge controls, application
deployment, and recovery without locking the read-only Deploy source gate.

The approved incremental fixed control-plane ceiling is `$26.00/month`. The
source cost contract is `$22.40/month` initially and at most `$24.40/month`
after the application key reaches its maximum billed rotated-key state. That
contract covers two WebACLs with five rules each, six standard-resolution
alarms, two Secrets Manager secrets, and the single application KMS key. WAF
requests, log ingestion/storage, S3, and EventBridge usage remain variable
and are not represented as fixed cost. Any source change that exceeds the
ceiling must fail CI and requires a new explicit approval before AWS planning.
IAM roles have no fixed monthly charge, so the dedicated retirement execution
role adds `$0` to this projection and the approved ceiling remains
`$26.00/month`.

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
anchor, read-only inspection of its own stack, and bounded cleanup of verified
unexecuted migration plans. It has no `cloudformation:DeleteStack`,
`iam:PassRole`, or direct permission to delete itself.

Authority retirement is deliberately split across two permanent roles in the
foundation stack. `FoundationPromotionRole` is the controller: it may call
`DeleteStack` only for the exact authority stack and may pass only
`FoundationAuthorityRetirementExecutionRole`, only to
`cloudformation.amazonaws.com`, enforced by the
`iam:PassedToService=cloudformation.amazonaws.com` condition. The workflow
supplies that exact execution role ARN through CloudFormation's `--role-arn`;
it never relies on a default or mutable role. The execution role trusts only
CloudFormation and can remove only the exact temporary migration role and its
inline policy. The controller, service role, stack policy, and workflow all
enforce this separation, so the temporary authority never deletes the
credentials executing its own retirement.

The terminal authority proof is schema v2 and records
`terminalLifecycleSafetyContractVersion=2`. Both permanent roles are bound by
stable IAM identity, policy, attachment inventory, and CloudFormation drift
evidence. The storage proof and every promotion/retirement gate require all
eight sanitized fields:

- `controllerRoleIdSha256`, `controllerPolicySha256`,
  `controllerInventorySha256`, and `controllerDriftSha256`; and
- `executionRoleIdSha256`, `executionPolicySha256`,
  `executionInventorySha256`, and `executionDriftSha256`.

An ARN hash alone is insufficient because an IAM role name and ARN can be
reused after deletion. The RoleId and inventory hashes bind the live principal
and its attachment state, while the drift hashes bind both roles to their exact
CloudFormation resources.

Historical authority source is untrusted input at the destructive boundary.
The v2 retirement path fetches the recorded ancestor file only as inert data,
proves its ancestry, hashes its bytes, and binds that hash and the recorded
template digest into the receipt. It never sources, invokes, or marks the
fetched file executable. This no-execution boundary is also required by abort
and the canonical v2 orphan-reconciliation path.

No mutable GitHub role-ARN variable is used. The workflow derives the exact ARN
from the validated AWS account and application name.

The current authority contract requires the source commit and canonical
authority-template digest as both exact stack parameters and the only two stack
tags. Future creation and strict verification hash exactly one recursively
key-sorted compact UTF-8 JSON object with no BOM and no trailing byte
(`jq -Scj`), making the binding independent of the operator platform. An
authority stack created from
an older, pre-binding contract cannot be adopted or upgraded by this workflow:
an administrator must delete it and recreate it from Phase 0 below. Repository
source and CI never create this authority; Phase 0 is a separately approved
external bootstrap action.

`verify-intrinsic` has one retirement-only compatibility boundary for an
already-bound authority created by the previous digest implementation: the
recorded digest may match the same canonical object followed by exactly LF or
CRLF. It does not normalize other whitespace, accept a BOM, change the live
template, or authorize planning/apply. The proof records the canonical digest,
the recorded digest, and `none|lf|crlf` independently. Normal `verify` accepts
only the no-terminator contract. The proof also hashes the exact UTF-8 stack ID
text with no trailing byte, matching the final pre-deletion binding.

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
  printf '%s' "$authority_template" |
    jq -Scj -s '
      if length != 1 then
        error("expected exactly one JSON document")
      elif (.[0] | type) != "object" then
        error("expected one JSON object")
      else
        .[0]
      end
    ' |
    sha256sum |
    awk '{print $1}'
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
3. If the migration must stop before `apply`, dispatch `abort` from the current
   green `main` SHA with
   `ABORT-FOUNDATION-MIGRATION-CLEAN-PLANS`. This operation only removes
   authorized, unexecuted migration plans; it is neither a foundation rollback
   nor authority retirement. It does not require the post-migration permanent
   role. The job must intrinsically prove the historical authority creation
   binding, trust, policy, template, and single resource. Historical source is
   fetched only as data from the recorded, verified ancestor, byte-hashed, and
   never executed or sourced. The recorded template binding must equal the
   canonical live template byte sequence with exactly `none`, LF, or CRLF
   termination; legacy termination is accepted only by this intrinsic stop
   path. The workflow source now enforces that no-execution boundary; until
   exact-main CI proves it, do not dispatch `abort`. Once proved, the job
   proves the target foundation is stable; and snapshots its stack, template,
   policy, and resource inventory. If `abort` succeeds, stop this sequence and
   arrange explicit administrator retirement of the preserved authority.
   Any digest, representation, historical-source, or body mismatch produces a
   sanitized failure phase and stops before change-set deletion.
   Failure receipts also state whether a destructive call was attempted and
   preserve only already-proved, sanitized deleted-plan records.
4. Before deleting anything, `abort` enumerates every target-stack change set.
   The complete inventory must contain only `foundation-storage-*` plans in
   `CREATE_COMPLETE` with `AVAILABLE|OBSOLETE` execution state and no import.
   Any unrelated, failed, pending, executing, or otherwise unexpected plan
   rejects the entire abort. Each eligible plan is then independently bound to
   its description, historical repository commit, source-template digest,
   parameters, tags, target stack, and non-importing UPDATE contract. It then
   re-describes the exact ID and safe state immediately before every deletion.
   A second complete inventory must be empty before completion, so a concurrent
   unrelated, pending, or executing plan fails closed. The target foundation
   projection, original
   template, stack policy, and resource inventory must remain byte-digest
   identical before and after cleanup. `abort` never calls `DeleteStack` and
   leaves both the authority stack and role unchanged. Its receipt explicitly
   records `authorityRetired=false` and `unchangedDuringAbort=true`. It does not
   infer who can retire the authority: before the post-migration controller is
   proved it records `externalAdministratorRetirementRequired=null`,
   `externalAdministratorRequirementKnown=false`,
   `nonSelfDeletingExecutorAvailableBeforeApply=null`, and
   `permanentRetirementControllerAvailabilityKnown=false`.
   `preMigrationStateVerified` records only what the run actually proved and is
   never inferred from an empty plan inventory. Only sanitized hashes and
   source digests enter the receipt.
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
   binds a fresh composite digest into the receipt. The workflow assumes
   `FoundationPromotionRole`, proves both permanent roles and their exact
   RoleIds, policies, attachment inventories, and `IN_SYNC` drift hashes, and
   calls `DeleteStack` for the exact authority stack with the
   exact `FoundationAuthorityRetirementExecutionRole` ARN. CloudFormation—not
   the temporary role—removes the temporary role and stack. The workflow then
   proves both are absent while the permanent controller and execution role
   remain exact and available. A sanitized retirement receipt is initialized
   before AWS access; on any failure it records the last completed phase,
   whether deletion started, and only controller/service-role digests and
   absence facts already proved. It never turns an ambiguous deletion outcome
   into a successful retirement claim.
   A `CREATE_COMPLETE` v2 authority is checked with `verify-intrinsic`. A v2
   `DELETE_FAILED` authority whose temporary role still exists may use the
   narrow `verify-retirement-retry` contract and only a standard delete retry.
   A canonical v2 `DELETE_FAILED` authority whose role is already absent uses
   `verify-retirement-orphaned`, two exact `GetRole -> NoSuchEntity` proofs,
   and `STANDARD --retain-resources FoundationMigrationRole`. The targeted
   retain protects against deleting a same-name role recreated during the
   proof-to-delete interval; the receipt states that no physical role was
   deleted or retained by that run.
   The recorded historical source is fetched and hashed as data; it is never
   executed. All three modes reject the known legacy orphan because its
   authority template does not contain the v2 terminal-safety contract.
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
promise. Immediately before `ExecuteChangeSet`, the workflow installs and
re-reads the exact legacy rollback-safe policy, even if a prior interrupted run
had already installed the final policy. That leaves candidate resources
removable by a legitimate CloudFormation rollback. After an observed
`UPDATE_COMPLETE`, the execution step immediately installs and re-reads the
final protective policy. A separate `always()` reconciliation step then waits
for a terminal `UPDATE_COMPLETE|UPDATE_ROLLBACK_COMPLETE`, hashes the live
original template, selects the final policy only when the candidate digest is
live and otherwise selects the rollback-safe policy, applies it, and re-reads
it. The apply run succeeds only when the candidate is present. Re-running
`apply` can finish protection reconciliation without replaying an already-live
migration. A post-success reversion is a separate destructive change, requires
a new approved recovery procedure, and must account for the retained
application KMS key and alias, secrets, buckets, and IAM roles.
Never improvise deletion or replacement of retained resources.

The repository now contains a pipeline-owned orphan reconciliation only for a
canonical v2 authority. The known legacy `DELETE_FAILED` authority remains an
unresolved incident because its physical role is absent and its historical
template predates the v2 terminal-safety marker; fail-closed verification
therefore rejects it before mutation. Do not issue a manual `DeleteStack`,
`--retain-resources`, or force-delete command from this runbook. Recovering that
legacy shell still requires a separately approved, source-bound external-admin
procedure with stop-on-diff evidence proving both stack-record and physical-role
absence.

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

- one-time authority trust/policy/role digests, plus separate
  `recordedAuthorityTemplateSha256`, `canonicalAuthorityTemplateSha256`,
  `templateCanonicalization`, and `recordedTemplateTerminator` proof fields;
- candidate template, parameter, stack-policy, change-set, and recovery-anchor
  digests;
- explicit additive/non-replacement change classification;
- live application-KMS rotation, alias, encryption-context and bucket-key
  proofs, plus S3-managed `AES256` CloudFront-log encryption, bucket-policy,
  lifecycle, logging, secret-metadata, and OIDC trust proofs;
- edge and FinOps controller/execution role ARN digests, never raw ARNs; and
- permanent controller and CloudFormation retirement-execution-role RoleId,
  policy, attachment-inventory, and drift digests; exact
  `PassRole`/service-role binding; `selfDeletion=false`; historical-source byte
  and ancestry binding without source execution; and proof that normal
  retirement removed the temporary stack and role; or, for `abort`, explicit
  `authorityRetired=false` plus truthful unknown administrator/controller
  availability fields.

Secret values, account IDs, account-bearing ARNs, credentials, and rendered
temporary templates must not be placed in repository files, logs, or uploaded
receipts. The only intentionally retained raw AWS locator in the protected
90-day receipt is the deterministic, account-neutral pre-state S3 object key;
the candidate and pre-state version IDs, object content, and surrounding AWS
resources are digest-bound. An approved recovery resolves the exact version
under separately authorized S3 access and verifies its recorded checksum before
use.
