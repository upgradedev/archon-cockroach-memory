# Cost model and FinOps evidence

Status: repository model, approval-gated template, and source-only control
workflow are defined. No hosted workflow receipt proves that a FinOps owner,
notification route, budget, or anomaly control is activated.

This model avoids a false precision claim. No total application monthly amount,
budget, forecast, or unit cost is committed until a billing-authorized
read-only pipeline collects the corresponding AWS and CockroachDB evidence.
The separately approved foundation-and-edge fixed control-plane envelope below
is a source estimate, not a measured bill or a total application forecast.

## Approved foundation and edge fixed envelope

The approved scope is exactly **incremental foundation + two edge stacks; not
total application cost**. Its fixed-cost ceiling is `$26.00/month`. Pricing was
checked on **2026-08-03**; the canonical machine-readable contract is
[`aws/foundation-storage-migration-policy.json`](../../aws/foundation-storage-migration-policy.json).

| Fixed control | Physical quantity | Unit monthly USD | Initial | After first billed KMS rotation | After second billed KMS rotation |
|---|---:|---:|---:|---:|---:|
| CloudFront WebACLs | 2 | `$5.00` | `$10.00` | `$10.00` | `$10.00` |
| WebACL rule associations | 10 (5 per WebACL) | `$1.00` | `$10.00` | `$10.00` | `$10.00` |
| Standard-resolution CloudWatch alarm metrics | 6 | `$0.10` | `$0.60` | `$0.60` | `$0.60` |
| Source-owned Secrets Manager secrets | 2 | `$0.40` | `$0.80` | `$0.80` | `$0.80` |
| Application customer-managed KMS key | 1 key; billed key-material units 1 / 2 / 3 | `$1.00` | `$1.00` | `$2.00` | `$3.00` |
| **Recomputed fixed total** | | | **`$22.40`** | **`$23.40`** | **`$24.40`** |
| **Headroom to `$26.00` ceiling** | | | **`$3.60`** | **`$2.60`** | **`$1.60`** |

AWS KMS charges the current key material and up to the first two retained
rotations; later rotations do not increase this storage line beyond the second
billed rotation. The lifecycle maximum is therefore `$24.40`, which must be
**strictly less than** `$26.00`, leaving `$1.60` fixed-cost headroom.

The CloudFront log bucket uses S3-managed `AES256`; both the WAF log group and
the alarm-state archive use CloudWatch Logs' AWS-owned default encryption.
They therefore add no customer-managed-key fixed charge. Official pricing
sources are [AWS WAF](https://aws.amazon.com/waf/pricing/),
[Amazon CloudWatch](https://aws.amazon.com/cloudwatch/pricing/),
[AWS Secrets Manager](https://aws.amazon.com/secrets-manager/pricing/), and
[AWS KMS](https://aws.amazon.com/kms/pricing/).

Variable usage charges excluded from this fixed envelope are WAF requests,
CloudWatch Logs ingestion and storage, S3 storage and requests, EventBridge
events, and data transfer. External or otherwise out-of-scope charges are
taxes; application compute, API, and network services; CockroachDB Cloud;
model and inference services; the conditional regional alarm-routing control;
the optional FinOps human notification route; and GitHub Actions.

CI does not trust a stored `within ceiling` flag. Readiness and the independent
Well-Architected audit calculate every line in integer cents, reconcile all
three declared scenario totals, derive the maximum, and then compare that
maximum strictly with the ceiling. These are source assertions, not a measured
AWS bill; variable charges still require billing-authorized evidence.

## Unit of value

The primary unit is one **successful recall**: an eligible request that returns
the required grounded answer/proof response without timeout or server error.

For an evidence window:

```text
unit cost per successful recall =
  allocated workload cost / successful recall count
```

Allocated workload cost must state whether it includes:

- Lambda compute and requests;
- API Gateway requests;
- CloudFront requests and transfer;
- S3 storage, requests, logs, and recovery evidence;
- Bedrock embedding and narration inference;
- CloudWatch logs, metrics, dashboards, and alarms;
- KMS, SNS, and SQS for the separately gated regional alarm-routing control;
- WAF, EventBridge, and log usage for the approved edge controls;
- CockroachDB Cloud;
- GitHub-hosted CI/CD consumption where separately measurable.

An omitted category must be explicit. Credits and promotional discounts are
reported separately so they do not make the underlying run rate appear zero.

## Required evidence

| Evidence | Scope | Current state |
|---|---|---|
| Successful recall count | Hosted application telemetry | Not yet bound to a production SLO window |
| AWS cost by workload tag/service | Billing account | Approval and billing read role required |
| Bedrock/Marketplace spend | Billing account | Approval required |
| CockroachDB cost | External provider | Approval and invoice/plan evidence required |
| Budget threshold and recipient | Billing account + human | Pending human decision |
| Cost anomaly monitor | Billing account | Not activated |
| Candidate/recovery/log storage age | Application account | Candidate and recovery current objects expire at the seven-year evidence horizon; noncurrent ledger versions expire after 30 days while preserving five recent versions |

The repository-only Well-Architected audit never requests billing credentials.

## Repository-prepared budget and anomaly controls

[`aws/finops.yaml`](../../aws/finops.yaml) defines:

- one human-selected monthly AWS workload cost budget filtered by the active
  `Application` cost-allocation tag;
- actual-spend notifications at 50%, 80%, and 100%;
- a forecast notification at 100%;
- one customer-managed Cost Anomaly Detection monitor scoped to the same
  `Application` tag, avoiding AWS's one-managed-service-monitor-per-account
  quota and duplicate staging/production alerts;
- an immediate SNS subscription whose alert condition combines human-selected
  absolute and percentage impact thresholds.

No default exists for an amount, recipient, owner, or approval reference.
[`finops-controls.yml`](../../.github/workflows/finops-controls.yml) is a manual,
fail-closed `plan|apply|verify` workflow. It is hard-bound to the `us-east-1`
AWS billing control plane. That placement is not an application workload and
does not change the `eu-west-1` workload-region policy. Static pipeline
validation is not evidence that any budget, monitor, subscription, or
notification is live.

## Activation contract

Every operation requires an exact current `main` SHA with successful `CI`,
`CodeQL`, and `Supply Chain (enforced)` push runs. The job crosses the protected
`finops-controls` environment and accepts explicit human-supplied budget,
absolute-anomaly, percentage-anomaly, SNS topic, owner, and approval values.
Every operation also fails closed unless the user-defined `Application` cost
allocation tag is active. The `apply` operation additionally requires the exact
workload-scoped confirmation phrase that includes the routing test.

The workflow derives, rather than accepts, two deterministic authorities from
the validated `AWS_ACCOUNT_ID` and `AWS_APP_NAME` repository variables:

- `arn:aws:iam::<account>:role/<app>-github-finops-controls`;
- `arn:aws:iam::<account>:role/<app>-finops-cloudformation-execution`.

Both roles must already exist. The controller trust must be limited to this
repository, `main`, the workflow, and the `finops-controls` environment. Its
permissions must be limited to the single workload stack/change-set boundary,
read-only live proof, the active cost-allocation-tag check, the approved notification route, and
`iam:PassRole` only for the deterministic CloudFormation execution role. The
execution role must be limited to the three resources in `aws/finops.yaml`.
There is no broad-credential or role-ARN-variable fallback.

The human-supplied SNS topic must be in the same account in `us-east-1`, use an
enabled customer-managed symmetric KMS key, and have exact publish-policy
statements for AWS Budgets and Cost Anomaly Detection. Their KMS key-policy
statements must grant only `kms:Decrypt` and `kms:GenerateDataKey*`, bounded by
the account and respective budget/anomaly source ARN patterns. A missing exact
grant or mismatched key fails before a change set is created.

`plan` creates or reuses one inert, deterministic CloudFormation change set
whose identity binds the current SHA, template digest, normalized parameter
digest, and execution-role digest. It rejects unexpected resources, actions,
capabilities, service roles, notification ARNs, rollback hooks, or replacement.
`apply` can execute only that available inspected change set, uses a bounded
poll, enables termination protection, proves the exact live stack and AWS
Budget/Cost Explorer/SNS state, and publishes one harmless routing message.
`verify` is read-only and performs the same live-state proof without publishing.

Only sanitized receipts under the runner temporary directory are uploaded.
Thresholds, owner/approval values, topic/key ARNs, stack/change-set IDs, and
other raw AWS identifiers are never copied into the artifact; their SHA-256
digests and boolean proof results are retained. A routing-test publish receipt
proves SNS accepted the message, not that a human read it.

CloudFormation automatically rolls back a failed create/update according to
the inspected change-set contract. Deactivation, deletion, or threshold
reversal is intentionally not automatic: it requires a new exact-SHA plan,
protected approval, and documented human decision.

The minimum live control set is:

1. a total workload/monthly AWS Budget with confirmed human notification;
2. a separate model/Marketplace budget or filter if the billing dimensions
   support it;
3. Cost Anomaly Detection as a complementary signal;
4. cost-allocation tags and an explicit unallocated-cost bucket;
5. monthly unit-cost evidence and reviewer disposition.

AWS documents
[Budgets](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html)
and
[Cost Anomaly Detection](https://docs.aws.amazon.com/cost-management/latest/userguide/manage-ad.html)
as separate controls. Because Marketplace and third-party model billing
coverage can differ from native-service anomaly coverage, Budgets must remain
the primary bounded-spend control rather than assuming every model charge will
produce an anomaly.

Activation still requires a human-confirmed recipient and acknowledged routing
test, FinOps owner, threshold values, approved IAM/billing scope, estimated
control cost, and rollback decision. The source workflow prepares those gates;
this repository state contains no hosted activation receipt.

## Storage lifecycle decision

The source template proposes a conservative seven-year (2,555-day) upper bound
for current candidate and recovery evidence, while noncurrent versions retire
after 30 days with five recent versions preserved. This is a prepared control,
not evidence that the live bucket has changed. Before activation, the workload
and FinOps owners must approve:

- the seven-year rollback and immutable receipt/audit-retention horizon;
- treatment of current and last-known-good candidates;
- transition class and retrieval requirement;
- deletion boundary for superseded candidates and raw access logs;
- recovery test proving lifecycle does not remove required state.

The runbook requires at least annual recovery-point renewal so an active
environment never approaches the current-object horizon. Acceptance evidence
is a protected pipeline receipt plus S3 Inventory after the configured
lifecycle interval. Merely checking a CloudFormation property is not proof
that accumulated current objects were reclaimed.

## Review

The monthly record must include exact source window, SHA/workload tags,
successful recall count, category costs, credits, unit cost, forecast,
budget/anomaly state, unexplained variance, reviewer, and decision. `Unknown`
and `not authorized` remain explicit outcomes.

See the AWS
[Cost Optimization pillar](https://docs.aws.amazon.com/wellarchitected/latest/cost-optimization-pillar/welcome.html)
and
[serverless expenditure awareness](https://docs.aws.amazon.com/wellarchitected/latest/serverless-applications-lens/expenditure-and-usage-awareness.html).
