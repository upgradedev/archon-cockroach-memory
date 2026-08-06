# AWS Well-Architected evidence contract

Status: repository evidence is prepared for the declared controls, including
the protected WA-03 audit source. This document does not infer current AWS
state from source or from an earlier review. Foundation, edge/WAF, recovery,
and WA-03 controls count as live only when an exact-release hosted receipt is
cited; absent or stale receipts remain `unknown` or `not activated`.

This package turns the Well-Architected review into reproducible evidence
without treating documentation as proof of live AWS state. It follows the six
pillars of the
[AWS Well-Architected Framework](https://docs.aws.amazon.com/wellarchitected/latest/userguide/waf.html).
AWS Well-Architected Tool findings and milestones are authoritative if a
separately approved review is created; internal 0–10 scores are only a planning
heuristic.

## Evidence levels

| Level | What it proves | What it does not prove |
|---|---|---|
| Repository | Contract shape, region policy, approval gates, and required runbooks exist at an exact SHA | Live AWS configuration |
| Pipeline | A hosted workflow executed the declared check and emitted a sanitized receipt | Human response or controls outside the queried scope |
| Live read-only | An approved audit role observed bounded AWS state without mutation | Account-wide completeness beyond its declared API queries |
| Human-attested | An accountable reviewer accepted a result or exercised a response path | An AWS state transition unless separately evidenced |
| Live mutating drill | A separately approved workflow changed controlled staging state and verified recovery | Production readiness unless the production boundary was explicitly approved |

Unknown, inaccessible, not activated, and not tested are distinct states. None
may be converted to `pass`.

## Default repository audit

`.github/workflows/well-architected-audit.yml` runs for relevant pull requests,
`main` pushes, a monthly schedule, and manual dispatch. Its default job:

1. checks out the exact workflow SHA without persisted credentials;
2. validates the machine contract using only the pinned runner's Node.js
   runtime and standard library;
3. verifies `eu-west-1` is the only deployment-region value and that deployment
   workflows contain no `us-west-2`;
4. accepts honest pending owners and objectives;
5. emits a sanitized receipt under `RUNNER_TEMP`;
6. uploads only that receipt as a GitHub Actions artifact.

It performs no package installation, AWS login, network inventory, build, or
resource mutation.

## Optional live read-only audit

The manual `live-read-only` mode is dormant until all of these exist:

- assigned owners and approved SLO/RTO/RPO values;
- `live_activation_approved=true` at dispatch;
- required-reviewer protection on the `production-audit` environment;
- `AWS_ACCOUNT_ID` and an existing `AWS_WAF_AUDIT_ROLE_ARN`;
- a role limited to identity and Resource Groups Tagging API reads.

When activated, it proves the account binding, counts application-tagged
resources in `eu-west-1`, and fails if the same application tag is found in
`us-west-2`. The receipt includes counts, not account identifiers or ARNs.
This is a scoped tag inventory, not a claim that every possible account
resource is discoverable through that API.

## Protected WA-03 account security audit

`.github/workflows/aws-security-baseline.yml` is a separate manual,
exact-green-main, read-only account audit. It requires approval through the
`security-audit` environment and assumes only the pre-existing role named by
`AWS_SECURITY_AUDIT_ROLE_ARN`. The workflow first proves successful `CI`,
`CodeQL`, and `Supply Chain (enforced)` push runs for the exact current `main`
SHA, then rebinds that SHA after protected approval.

The least-privilege reference policy and dependency-free audit script inspect
account S3 Block Public Access, root MFA/access-key posture, the IAM password
policy, an actively delivering and log-validating multi-region CloudTrail,
GuardDuty, ready Security Hub foundational and CIS standards, AWS Config
recorder/channel health, IAM Access Analyzer, and `eu-west-1` default EBS
encryption. Missing access or state fails closed. Raw service responses remain
only in the hosted runner's temporary directory; the uploaded receipt contains
only booleans/counts, limitations, and its exact source SHA—never account IDs,
ARNs, access keys, or resource names.

This is source readiness, not live proof. The role and protected environment
must be created separately, services may require security/cost approval before
activation, and an all-pass `10/10` exact-SHA receipt must still be run and
reviewed. The audit has no write IAM actions and cannot remediate a failure.
AWS Inspector and organization delegated-administrator posture remain outside
the WA-03 receipt. See
[`aws-account-security-baseline.md`](../runbooks/aws-account-security-baseline.md).

## Protected foundation lifecycle

The one-time foundation migration authority is a source-bound CloudFormation
creation contract, not a manually assembled IAM role. Phase 0 requires a clean
current `main` worktree, sets `SOURCE_COMMIT=$(git rev-parse HEAD)`, computes
`AUTHORITY_TEMPLATE_SHA256` with
`foundation-migration-authority.sh render-template-sha256`, renders the
canonical template only in memory, and creates the authority stack with no
CloudFormation `RoleARN` and termination protection disabled. The exact source
commit and template digest are both stack parameters and the only two stack
tags. The template contains one resource, `FoundationMigrationRole`; its trust,
inline policy, original template, parameters, tags, and inventory are all
proved before use. A pre-contract authority cannot be adopted: it requires
administrator deletion and Phase 0 recreation. A historical
`DELETE_FAILED` authority shell whose physical role was already absent is
recorded in the operational handover; this evidence contract does not infer
that shell's current existence or treat external cleanup as a source-final
retirement receipt.

`.github/workflows/foundation-migration.yml` exposes exact-current-green-main
`plan|apply|verify|abort|retire` operations. Apply, abort, and retirement require
their exact confirmation phrases; abort uses
`ABORT-FOUNDATION-MIGRATION-CLEAN-PLANS`. The one-time policy includes the bounded
`ListChangeSets` and `ListStackResources` reads required to prove complete plan
and resource inventories; those reads do not authorize broader mutation. The
temporary role has no `DeleteStack`, `PassRole`, or direct self-delete
permission.

The plan/apply job has a same-run `always()` cleanup when an exact change-set
ID was captured but plan creation, loading, or exact inspection failed. It
re-proves that single AVAILABLE, non-importing UPDATE plan, its source template,
parameters, tags, target identity, and no-role/no-notification boundary before
deletion, then proves both plan absence and an unchanged target-stack
projection. The receipt hashes the plan ARN, name, and description. It never
executes an unverified plan. A final adjacent re-description must still show
the exact ID in `CREATE_COMPLETE`/`AVAILABLE`, UPDATE, non-importing state.

`abort` is a separate stop operation that cleans only authorized, unexecuted
migration plans and does not require the post-migration permanent foundation
role. It first intrinsically proves the
historical authority source binding, digest-bound original template, exact
repository trust, bounded/subset-safe inline policy, and single live resource.
The required v2 boundary treats fetched historical source as inert data: the
recorded commit must be a verified ancestor, its bytes are hashed and bound,
and the file is never sourced or executed. Repository source now enforces that
no-execution boundary; `abort` remains operationally pending until exact-main
CI proves the source contract and a separately approved dispatch is authorized.
It then proves the target foundation stable and snapshots digests for its full
stack projection, original template, stack policy, and resource inventory.
Before its deletion loop, the complete change-set inventory must contain only
`foundation-storage-*` entries in `CREATE_COMPLETE` and
`AVAILABLE|OBSOLETE`, with imports disabled. An unrelated, pending, failed, or
executing plan rejects the whole abort. Every eligible plan is independently
bound to its historical committed source/template and exact UPDATE contract,
deleted, and proved absent. The target foundation digests must remain identical
after cleanup. A second complete all-change-set inventory must be empty; any
concurrent unrelated or executing plan fails closed. Abort never calls
`DeleteStack` and preserves the authority stack and role for explicit
administrator retirement. The sanitized receipt contains hashes and committed
source/template digests, not account IDs or account-bearing ARNs, and records
`authorityRetired=false` and `unchangedDuringAbort=true`. It does not invent an
administrator or controller capability before one is proved:
`externalAdministratorRetirementRequired` and
`nonSelfDeletingExecutorAvailableBeforeApply` are `null`, while their
corresponding known/availability booleans are `false`.
`preMigrationStateVerified` reflects only evidence actually established by the
run. A failure receipt records the last completed phase, whether any destructive
call started, and only the sanitized plan records already proved; it cannot
claim authority retirement.

The normal `retire` path uses the permanent `FoundationPromotionRole` as its
controller after a completed migration. The foundation also contains a
dedicated `FoundationAuthorityRetirementExecutionRole` that trusts only
CloudFormation and may remove only the exact temporary role and its inline
policy. The controller may delete only the exact authority stack and may pass
only that execution role, conditioned on
`iam:PassedToService=cloudformation.amazonaws.com`; the workflow binds the same
role explicitly with CloudFormation's `--role-arn`. Before deletion it proves
the migrated live controls, matches the fresh digest to the preceding proof,
compares the exact deployed template and stack policy, and requires both
permanent roles' source-bound trust/policy, attachment inventory, stable IAM
RoleId, and CloudFormation resource drift to be exact and `IN_SYNC`. The eight
required hashes are the controller and execution variants of
`RoleIdSha256|PolicySha256|InventorySha256|DriftSha256`. It proves the full
change-set inventory empty and binds a fresh composite proof digest into the
receipt. The v2 proof records
`terminalLifecycleSafetyContractVersion=2`. For a normal `CREATE_COMPLETE`
authority it uses `verify-intrinsic`; a v2, role-present `DELETE_FAILED` retry
uses `verify-retirement-retry` and standard deletion only. A canonical v2,
role-absent `DELETE_FAILED` shell uses `verify-retirement-orphaned`, two exact
`NoSuchEntity` checks, and targeted `STANDARD --retain-resources
FoundationMigrationRole` reconciliation; its receipt explicitly states that
the role was already absent and was not deleted by the run. Historical
authority source is fetched from the recorded ancestor as inert data,
ancestry-checked, byte-hashed, and never executed. The receipt records the identity and control
hashes, exact service-role binding, `selfDeletion=false`, and temporary
stack/role absence without exposing raw account-bearing ARNs. It is initialized
before AWS access; its failure form records the last completed phase and
whether deletion began, retains only facts already proved, and never represents
an unknown deletion outcome as success.

That historical legacy `DELETE_FAILED` shell was ineligible for the finalized
v2 orphan workflow: its temporary role was absent but its historical template
lacked the mandatory v2 terminal-safety contract. This package claims no
source-final receipt for the external reconciliation and no current AWS state.
See
[`FOUNDATION_STORAGE_MIGRATION.md`](./FOUNDATION_STORAGE_MIGRATION.md).

Immediately before `ExecuteChangeSet`, the workflow installs and re-reads the
legacy rollback-safe policy so newly added resources can still be removed by a
legitimate rollback. After observed success it installs and re-reads the final
policy. An `always()` reconciler waits for a terminal stack state, hashes the
live original template, keeps the rollback-safe policy when the candidate is
absent, and selects the final policy only when the candidate digest is live.
It re-reads the selected policy and permits apply success only for the exact
candidate. A rerun can finish reconciliation without replaying the migration.
Neither `abort` nor same-run plan cleanup rolls back or otherwise mutates the
foundation stack. See
[`FOUNDATION_STORAGE_MIGRATION.md`](./FOUNDATION_STORAGE_MIGRATION.md).

## Protected edge-control delivery

[`aws/edge-waf.yaml`](../../aws/edge-waf.yaml) now defines an approval-gated
CloudFront WebACL with AWS managed common-threat, known-bad-input, and IP
reputation groups plus separate aggregate API and resolution-session
rate-based rules. It is hard-bound to the AWS CloudFront WAF control plane in
`us-east-1`; this is not an application workload region.

The same edge stack defines three exact CloudWatch `BlockedRequests` alarms
(all WebACL blocks and both rate rules). CloudFront alarms omit the WAF
`Region` dimension in accordance with the AWS metric contract. The alarms have
no notification actions. One account- and ARN-bound EventBridge rule captures
only their `ALARM` and `OK` state changes and sends them to a dedicated 14-day
CloudWatch Logs archive. An exact resource policy permits only EventBridge log
delivery for that rule. This is durable machine evidence, not human paging.

Request sampling is disabled because AWS states that WAF logging redaction does
not apply to sampled requests. The only request-level route is a 30-day,
CloudWatch-encrypted Logs group whose WAF filter keeps only `BLOCK` records.
Both edge log groups use CloudWatch Logs' AWS-owned default encryption; the
stack does not create a billable KMS key. Query strings and the declared
credential/session headers are redacted. Raw logs and AWS responses stay
outside GitHub artifacts. Edge receipts hash account-bearing identifiers and
retain only deterministic account-neutral source/stack metadata, stable
booleans, counts, and explicit limitations.

`.github/workflows/edge-controls.yml` provides manual, protected
`plan|apply|verify|cleanup|finalize` operations. Every dispatch requires the
exact current green `main` SHA. Non-destructive planning, deployment,
verification, and lifecycle protection use the repository-bound
`EdgeControlRole` through `edge-controls`; destructive recoverable-shell
cleanup uses the separately protected `edge-cleanup` environment and
`EdgeCleanupRole`. The ordinary role cannot list change sets or delete stacks;
the cleanup role cannot create/execute/delete change sets, change stack policy
or termination protection, pass roles, or assume roles. The three explicitly
confirmed operations require exact environment-specific values:
`APPLY-{ENV}-EDGE-CONTROLS`, `CLEANUP-{ENV}-EDGE-CONTROLS`, and
`FINALIZE-{ENV}-EDGE-CONTROLS`; `plan` and `verify` require an empty
confirmation.

The plan/apply path accepts only the two deterministic edge stacks, the source
template digest, the protective stack policy, termination protection, and one
of three exact non-replacement change-set shapes: a greenfield CREATE with nine
Add actions; the legacy bootstrap UPDATE with eight Add actions plus one WebACL
Modify; or a steady-state UPDATE containing a non-empty Modify-only subset of
the exact nine resources, with `Replacement=False`, non-empty property details,
and `RequiresRecreation=Never`. `apply` executes the independently created,
still-available change set whose name, description, parameters,
original-template digest, resource changes, and replacement semantics are
re-proved. For a greenfield CREATE, the apply run accepts CloudFormation's
intermediate `REVIEW_IN_PROGRESS` shell stack only when that stack and the
pending change set are mutually identity-bound and the exact source SHA,
description, parameters, and original-template digest all match before CREATE
is selected. Although `plan` has no typed confirmation, it still runs behind
the protected environment and may materialize only that empty CloudFormation
shell; it cannot deploy a stack resource.

Edge apply is also cancellation-safe at the lifecycle boundary. An `always()`
reconciliation step waits boundedly for an interrupted create/update/rollback
to reach a supported terminal state, then proves the exact stack ID, source
template digest, parameters, no service role/tags/notifications/capabilities,
and the exact nine-resource inventory before it can mutate lifecycle controls.
It installs and re-reads the source-bound stack policy and termination
protection, then requires the complete live WAF proof before success. The final
`always()` receipt step cannot turn interruption into success: it records
`apply-failed-candidate-lifecycle-protected` with known protected state only
after that reconciliation proof, otherwise
`apply-failed-state-unknown` with `destructiveStateKnown=false`.

Bootstrap, Foundation Migration, Edge Controls, staging/production Deploy, and
Recover AWS mutation jobs share the queued
`aws-shared-control-plane-mutation` mutex. Source-gate and read-only audit jobs
do not hold it, avoiding a receipt-wait deadlock while closing cross-workflow
control-plane TOCTOU races.

Recovery from partial lifecycle progress is bounded rather than manual. The
`cleanup` operation accepts only an unprotected `REVIEW_IN_PROGRESS` shell with
zero resources or an unprotected `ROLLBACK_COMPLETE` stack for which every
listed resource is `DELETE_COMPLETE`. It derives the originating commit and
template digest from the single CREATE change set, fetches that historical
commit even when current `main` has advanced, matches the repository and
CloudFormation templates to that digest, refreshes current `main`, and then
repeats the complete AWS/source checks so `DeleteStack` is the next external
action. It deletes the exact stack ID and requires the stack-name lookup to
return `NotFound`. Its receipt retains the
source SHA, template digest, and deterministic account-neutral
stack/change-set names but hashes the stack ID and deletion token; no account
ID or ARN is emitted.

The `finalize` operation creates no change set. Normally it proves the exact
current template, parameters, and nine-resource live inventory before repairing
the stack policy and termination protection, then repeats the full live proof.
`apply` automatically selects that same finalize path when the exact current
template is already live, making a run restart-safe if deployment completed
before lifecycle protection setup. For an interrupted older deployment, the
optional `deployed_sha` must be a green ancestor of current `main` with exact
successful CI, CodeQL, and Supply Chain push runs. The workflow loads that
revision's template and stack policy and repairs only its lifecycle protections.
If its semantics differ from current `main`, the resulting source-bound receipt
explicitly does not claim current live controls and requires a new current
plan/apply. `verify`, post-apply proof, and current-semantics finalize proof read
the live WebACL, logging filter, default-encrypted log groups, exact EventBridge
event pattern and log target, archive resource policy/retention, all three
action-free alarm definitions, stack policy, and termination protection. Live
receipts hash account-bearing identifiers while retaining only deterministic
account-neutral source/stack metadata and proof facts.

The regional application template has no optional, unprotected mode. Its
mandatory WebACL ARN is resolved directly from the protected edge stack rather
than a mutable GitHub variable. Its origin capability is generated by the
foundation stack in Secrets Manager and is resolved by CloudFormation into
both CloudFront and Lambda without entering source, stack parameters, or
receipts. Deploy AWS fails before mutation unless the same SHA has:

- a post-migration permanent-authority foundation verification receipt;
- staging and production live edge-control receipts; and
- direct edge-stack output validation for account, name, environment, region,
  rate limits, status, stack-role absence, and termination protection.

Each staging and production mutation job holds the shared
`aws-shared-control-plane-mutation` mutex. Immediately before any new release
mutation, it paginates all eligible foundation and environment-specific edge
runs, uses one shared edge snapshot, selects the global latest run before
comparing SHA, and requires the exact source-gate run IDs/attempts, successful
foundation `verify`, successful
edge `apply|verify`, and the same current `main` head. The canonical fence proof
binds its checked time, deployment environment/job/run/attempt, mutex group,
source SHA, and exact operations. The terminal deployment receipt embeds that
exact proof plus its SHA-256; extracting the object, deleting only `sha256`, and
serializing with `jq -cS` reproduces the digest.

The only mutation allowed before this new-release fence is fail-safe
reconciliation of an interrupted same-run greenfield stack. It requires exact
cryptographic ownership and recovery evidence and may only restore/delete that
orphaned candidate; it cannot deploy a candidate or alter foundation/edge
controls. This recovery exception prevents a stale failed run from blocking
safe cleanup while preserving the fence for every new release transition.

No edge lifecycle operation generates a probe, queries the alarm archive, or
contacts a human. In particular, `cleanup` proves only the eligible shell's
source-bound deletion, while `finalize` proves configuration and lifecycle
protection—not alarm delivery. Every receipt therefore records alarm delivery
as `not-run`, human paging as `not-configured-by-this-stack`, and
acknowledgement as `not-claimed`. No live edge activation, delivery drill, or
response evidence is claimed by repository source.

Regional application alarm routing has a separate manual,
protected, exact-green-main `plan|apply|verify|drill` workflow. Its activation
accepts only the inspected false-to-true foundation switch and 15 resource
additions with zero replacements or existing-resource mutations. Its bounded
drill can mutate only the isolated staging probe, proves the encrypted
SNS-to-SQS envelope through a short-retention exact-`AlarmName` filtered queue
without reading the operational archive, restores `OK`, and stores only hashed human
approval/acknowledgement references. That is not evidence that a human paging
destination received or acknowledged an alert. The one-time foundation
migration, both edge stacks, application deployment, direct-origin rejection,
managed/rate-rule drills, alarm activation, archive drill, edge-alarm delivery
drill, and human paging still require explicit approval and hosted evidence. See
[`FOUNDATION_STORAGE_MIGRATION.md`](./FOUNDATION_STORAGE_MIGRATION.md) and
[`waf-abuse-response.md`](../runbooks/waf-abuse-response.md).

## Protected WA-06 fault-injected recovery

`Deploy AWS` has one manual operation: an explicitly confirmed, protected
staging recovery drill. Before it arms the durable S3 ledger, the job requires
an existing same-SHA staging stack with the normal runtime secret, a disabled
drill token, and an exact non-expired staging receipt from a successful push
deployment of the current green `main` SHA. Greenfield, stale, ambiguous, or
unreceipted state fails before mutation. A top-level CloudFormation Rule also
rejects every non-disabled drill token outside `Environment=staging`, so the
staging boundary does not depend only on workflow behavior.

For the manual event, the job graph requires the mutating `database-release`
reconciliation and the production Managed MCP audit to be skipped. The prior
successful push proves those release gates, while the drill reuses the exact
authenticated `CockroachSqlDns` captured in the previous staging stack. Thus
the fault exercise has no shared production database or production MCP action.

The candidate receives a unique behavior-neutral version token and a
deterministic staging-only database-secret name that its runtime role cannot
read. Continuous data-backed probes exercise the weighted alias. Independent
control-plane observation must capture the new candidate at 10%, its exact
ExecutedVersion alarm in `ALARM`, and the deployment group's alarm rollback
configuration. The failed SAM step is accepted only when CodeDeploy exposes
exactly one source deployment as `Stopped/ALARM_ACTIVE`, the deployment's
external ID matches the exact existing stack, its creation time is inside the
captured drill window, and the retrieved AppSpec content matches its CodeDeploy
SHA-256 plus the exact function, `live` alias, previous version, and observed
candidate version. Exactly one related rollback deployment must be
`Succeeded`, must not predate the stopped source deployment, and the runner's
start/observation/end timestamps must be monotonic. The SHA-only
`GetApplicationRevision` request is behaviorally tested, and its IAM authority
is scoped to staging application/deployment-group ARN families. Unknown GitHub
run statuses or incomplete `total_count`-bound run, job, or artifact
inventories fail closed. Trusted historical `workflow_run` source/lease-owner
records remain recoverable, while manual dispatch metadata cannot create a
production recovery candidate.

Before the ordinary recovery handler runs, the job proves CloudFormation
`UPDATE_ROLLBACK_COMPLETE`, the previous template/parameters/tags/outputs, the
old alias with no additional weights, and live health/data proof. The standard
inline restore must then succeed idempotently while leaving the ledger `ARMED`.
The attested sanitized handoff stores only digests for AWS identifiers and
explicitly records that terminal recovery is still pending.

The scheduled `Recover AWS` workflow must later produce the immutable recovery
receipt, atomically mark the ledger `RECOVERED`, and allow a subsequent run to
classify the exact successful recovery receipt as a credential-free no-op.
Manual dispatch cannot enter the production promotion job, and production
fault injection is outside the workflow's authority. These are repository
contracts; no live fault, `RECOVERED`, idempotent no-op, RTO, or RPO evidence is
claimed until the protected hosted sequence succeeds. See
[`rollback-recovery.md`](../runbooks/rollback-recovery.md).

## Repository-prepared FinOps controls

[`aws/finops.yaml`](../../aws/finops.yaml) defines one Application-tag-filtered
monthly AWS Budget, one customer-managed Application-tag Cost Anomaly Detection
monitor, and immediate SNS anomaly routing. The protected workflow proves the
cost-allocation tag is active before it can plan or activate the controls.
The threshold amounts, percentage, owner, SNS topic, and approval reference
have no defaults. The only deployment path is the protected, manual,
exact-green-main `plan|apply|verify` workflow. The template is hard-bound to
the `us-east-1` billing control plane; it creates no application workload
outside `eu-west-1`.

The permanent `FoundationAuthorityRetirementExecutionRole` adds
`$0.00/month` in fixed IAM charges. Its inclusion leaves the approved
incremental fixed control-plane ceiling unchanged at `$26.00/month`; request,
logging, storage, and other usage-based charges remain variable and separately
evidenced.

Live evidence requires a separately approved billing-authorized pipeline,
validated SNS delivery to an accountable human, observed budget/monitor state,
and a sanitized exact-SHA receipt. Repository and pipeline scans prove only
that the dormant control definition is valid.

## Repository-prepared managed-backup restore drill

`.github/workflows/cockroach-restore-drill.yml` defines a manual, dual-reviewer
CockroachDB Cloud Basic restore drill. A credential-free `operations-drill`
job first binds protected approval to the exact inputs and exposes only their
run-bound SHA-256 digest; the separate `production-db` boundary then gates all
credentials and the mutation. It accepts only an exact current `main` SHA, an
existing separate empty AWS Basic destination in `eu-west-1`, an exact
managed-backup ID, a confirmation bound to both IDs, and approved RTO/RPO
objectives. It fails closed on provider, plan, region, organization boundary,
SQL endpoint identity, prior restore history, or non-empty target state.

The single permitted mutation is the exact Cloud API `CLUSTER` restore. The
pipeline then measures recovery time and backup age and compares the restored
schema, grants, roles, RLS, vector indexes, and canonical checksum with the
source. A successful run produces a sanitized exact-SHA artifact and GitHub
provenance attestation. Repository preparation does not prove a restore has
occurred. This is managed-backup recovery, not PITR; Basic's default schedule
has a worst-case RPO of up to 24 hours, and RTO remains unknown until the live
drill is separately approved and run. See
[`database-restore.md`](../runbooks/database-restore.md).

## Protected WA-10 sustainability intensity evidence

`.github/workflows/sustainability-intensity-evidence.yml` is a manual,
protected, read-only measurement gate for an exact current green `main`
release. It consumes a successful version-2 Hosted Load Evidence receipt rather
than generating traffic itself, verifies the exact deployed stack, and reads
only CloudFormation, CloudWatch, and log-group metadata through the existing
role named by `AWS_SUSTAINABILITY_AUDIT_ROLE_ARN`.

The sanitized receipt records the bounded workload and minute-aligned telemetry
windows, source deployment and raw-response digests, exact successful-recall
denominator, Lambda configured-memory GB-seconds/invocations/errors/Duration,
API request/error/processed-byte totals, CloudFront request/transfer totals,
and point-in-time Lambda/API log storage context. Resource identifiers, account
identity, human owner, raw AWS responses, logs, secrets, and database content
are never uploaded.

Baseline and after receipts must have the same synthetic corpus, concurrency,
correctness gates, objectives, owner digest, primary proxy, and approved
reduction target. Baseline mode makes no improvement claim; comparison mode
fails if the target is missed. These are engineering intensity proxies, not
carbon, emissions, billed-duration, production-scale, or business-impact
evidence. CloudFront metrics are read from its `us-east-1` global telemetry
control plane; application workloads remain only in `eu-west-1`.

Repository preparation does not prove a baseline or improvement was measured.
The owner assignment, protected environment, external least-privilege role,
hosted runs, cost approval, live receipts, and human disposition remain
separately approval-gated. See
[`sustainability-intensity.md`](../runbooks/sustainability-intensity.md).

## Controls intentionally not activated

The repository records, but does not enable:

- human alarm destinations and delivery drills;
- live activation or remediation of CloudTrail, GuardDuty, Security Hub, AWS
  Config, Access Analyzer, account S3 public access, root/password posture, EBS
  encryption, and Inspector; the named non-Inspector controls now have
  repository-prepared read-only WA-03 checks, while Inspector remains outside
  that receipt;
- the repository-prepared WAF, CloudFront access logging, origin restriction,
  and their live alarm drill;
- a source-final foundation migration and v2 authority-retirement receipt;
  historical external-administrator reconciliation is not promoted into live
  evidence by this repository document;
- a completed protected two-principal database credential rotation; the runtime
  refresh and pipeline are repository-prepared, but no live receipt is claimed;
- the repository-prepared staging fault-injected recovery sequence, including
  its live `ALARM_ACTIVE`, automatic rollback, `RECOVERED`, and subsequent
  no-op receipts;
- a completed CockroachDB managed-backup restore drill and measured RTO/RPO;
- a successful protected **Hosted Load Evidence** run for the exact deployed
  release, followed by human approval of the measured service objectives;
- second-region disaster recovery;
- quota increases or hosted load;
- the repository-prepared Budget and Cost Anomaly Detection controls, billing
  exports, and their human delivery drill;
- a successful protected WA-10 baseline and equivalent after measurement, an
  approved target-meeting improvement, or any optimization change; the
  read-only source, policy, receipt contract, and runbook are repository-ready.

Each requires its own explicit approval, cost statement, rollback, protected
workflow, and acceptance receipt. The repository audit cannot activate them.

## Receipt requirements

Every receipt must contain:

- schema and version;
- generation timestamp;
- repository and exact commit SHA;
- mode and pass/fail;
- fixed region-policy result;
- individual checks with stable identifiers;
- limitations and any pending activation prerequisites.

Receipts must exclude secrets, AWS account identifiers, resource ARNs, database
content, embeddings, and human contact details. Raw AWS responses remain only
under the ephemeral hosted runner's `RUNNER_TEMP` and are never uploaded.

## Review sources

- [Operational Excellence](https://docs.aws.amazon.com/wellarchitected/latest/operational-excellence-pillar/welcome.html)
- [Security](https://docs.aws.amazon.com/wellarchitected/latest/security-pillar/welcome.html)
- [Reliability](https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/welcome.html)
- [Performance Efficiency](https://docs.aws.amazon.com/wellarchitected/latest/performance-efficiency-pillar/welcome.html)
- [Cost Optimization](https://docs.aws.amazon.com/wellarchitected/latest/cost-optimization-pillar/welcome.html)
- [Sustainability](https://docs.aws.amazon.com/wellarchitected/latest/sustainability-pillar/sustainability-pillar.html)
