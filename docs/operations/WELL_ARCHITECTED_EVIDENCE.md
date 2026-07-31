# AWS Well-Architected evidence contract

Status: repository evidence implemented; account-wide controls are not
activated by this batch.

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

## Repository-prepared edge controls

[`aws/edge-waf.yaml`](../../aws/edge-waf.yaml) now defines an approval-gated
CloudFront WebACL with AWS managed common-threat, known-bad-input, and IP
reputation groups plus separate aggregate API and resolution-session
rate-based rules. It is hard-bound to the AWS CloudFront WAF control plane in
`us-east-1`; this is not an application workload region. The regional
application template accepts an optional WebACL ARN and an optional
CloudFront-to-origin capability. Both default to empty, so no billable WAF
resource or origin restriction is activated by repository code alone.

Activation must deploy the edge stack through a protected pipeline, pass the
WebACL ARN and a newly generated secret capability to the regional stack,
change direct execute-api health from `200` to `403`, preserve same-origin
CloudFront health at `200`, exercise managed and rate rules, route alarms to an
approved human destination, and produce an exact-SHA receipt. See
[`waf-abuse-response.md`](../runbooks/waf-abuse-response.md).

## Repository-prepared FinOps controls

[`aws/finops.yaml`](../../aws/finops.yaml) defines a monthly AWS Budget,
service-dimensional Cost Anomaly Detection, and immediate SNS anomaly routing.
The threshold amounts, percentage, owner, SNS topic, and approval reference
have no defaults, and no workflow can deploy the stack. The template is
hard-bound to the `us-east-1` billing control plane; it creates no application
workload outside `eu-west-1`.

Live evidence requires a separately approved billing-authorized pipeline,
validated SNS delivery to an accountable human, observed budget/monitor state,
and a sanitized exact-SHA receipt. Repository and pipeline scans prove only
that the dormant control definition is valid.

## Repository-prepared managed-backup restore drill

`.github/workflows/cockroach-restore-drill.yml` defines a manual,
reviewer-protected CockroachDB Cloud Basic restore drill. It accepts only an
exact current `main` SHA, an existing separate empty AWS Basic destination in
`eu-west-1`, an exact managed-backup ID, a confirmation bound to both IDs, and
approved RTO/RPO objectives. It fails closed on provider, plan, region,
organization boundary, SQL endpoint identity, prior restore history, or
non-empty target state.

The single permitted mutation is the exact Cloud API `CLUSTER` restore. The
pipeline then measures recovery time and backup age and compares the restored
schema, grants, roles, RLS, vector indexes, and canonical checksum with the
source. A successful run produces a sanitized exact-SHA artifact and GitHub
provenance attestation. Repository preparation does not prove a restore has
occurred. This is managed-backup recovery, not PITR; Basic's default schedule
has a worst-case RPO of up to 24 hours, and RTO remains unknown until the live
drill is separately approved and run. See
[`database-restore.md`](../runbooks/database-restore.md).

## Controls intentionally not activated

The repository records, but does not enable:

- human alarm destinations and delivery drills;
- CloudTrail/GuardDuty/Security Hub/Config/Inspector account baselines;
- the repository-prepared WAF, CloudFront access logging, origin restriction,
  and their live alarm drill;
- database credential rotation;
- fault-injected recovery;
- a completed CockroachDB managed-backup restore drill and measured RTO/RPO;
- second-region disaster recovery;
- quota increases or hosted load;
- the repository-prepared Budget and Cost Anomaly Detection controls, billing
  exports, and their human delivery drill;
- any billable sustainability telemetry or optimization change.

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
