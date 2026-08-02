# AWS Well-Architected evidence contract

Status: repository evidence implemented, including the protected WA-03 audit
source; account-wide controls are not activated and no live WA-03 receipt is
claimed by this batch.

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

## Protected edge-control delivery

[`aws/edge-waf.yaml`](../../aws/edge-waf.yaml) now defines an approval-gated
CloudFront WebACL with AWS managed common-threat, known-bad-input, and IP
reputation groups plus separate aggregate API and resolution-session
rate-based rules. It is hard-bound to the AWS CloudFront WAF control plane in
`us-east-1`; this is not an application workload region.

The same edge stack defines three exact CloudWatch `BlockedRequests` alarms
(all WebACL blocks and both rate rules). CloudFront alarms omit the WAF
`Region` dimension in accordance with the AWS metric contract. Both `ALARM`
and `OK` transitions route through a customer-managed-KMS encrypted SNS topic
to a customer-managed-KMS encrypted SQS archive with 14-day retention. This is
durable machine evidence, not human paging.

Request sampling is disabled because AWS states that WAF logging redaction does
not apply to sampled requests. The only request-level route is a 30-day,
customer-managed-KMS encrypted CloudWatch Logs group whose WAF filter keeps
only `BLOCK` records. Query strings and the declared credential/session headers
are redacted. Raw logs and AWS responses stay outside GitHub artifacts; the
edge receipt contains only resource-identifier hashes and stable booleans.

`.github/workflows/edge-controls.yml` provides manual, protected
plan/apply/verify operations using a repository-bound OIDC role. It accepts
only the two deterministic edge stacks, the exact 13-resource non-replacement
change set, the source template digest, the protective stack policy, and
termination protection. `apply` executes the independently created, still
available change set whose name, description, parameters, original-template
digest, resource changes, and replacement semantics are re-proved. For a
greenfield CREATE, the apply run accepts CloudFormation's intermediate
`REVIEW_IN_PROGRESS` shell stack only when that stack and the pending change
set are mutually identity-bound and the exact source SHA, description,
parameters, and original-template digest all match before CREATE is selected.
`verify` then reads the live WebACL, logging filter, KMS key/rotation/policy,
log group,
SNS policy/subscription, SQS policy/retention, and all three alarm definitions.
Its receipt stores only identifier digests rather than raw AWS identifiers.

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

Neither edge `apply` nor `verify` generates a probe, reads an archive message,
or contacts a human. Every receipt therefore records alarm delivery as
`not-run`, human paging as `not-configured-by-this-stack`, and acknowledgement
as `not-claimed`. No live edge activation, delivery drill, or response evidence
is claimed by repository source.

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
