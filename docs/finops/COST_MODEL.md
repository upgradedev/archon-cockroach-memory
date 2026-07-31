# Cost model and FinOps evidence

Status: repository model and approval-gated control plane defined; billing
controls and a FinOps owner are not activated.

This model avoids a false precision claim. No monthly amount, budget, forecast,
or unit cost is committed until a billing-authorized read-only pipeline
collects the corresponding AWS and CockroachDB evidence.

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
- KMS, SNS, and SQS if alarm routing is later activated;
- WAF if later activated;
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
| Candidate/recovery/log storage age | Application account | Read-only inventory not yet activated |

The repository-only Well-Architected audit never requests billing credentials.

## Repository-prepared budget and anomaly controls

[`aws/finops.yaml`](../../aws/finops.yaml) defines, but cannot deploy:

- a human-selected monthly AWS cost budget;
- actual-spend notifications at 50%, 80%, and 100%;
- a forecast notification at 100%;
- a service-dimensional Cost Anomaly Detection monitor;
- an immediate SNS subscription whose alert condition combines human-selected
  absolute and percentage impact thresholds.

It has no deployment workflow, provides no defaults for amounts, owner,
recipient, or approval reference, and is hard-bound to the `us-east-1` AWS
billing control plane. That control-plane placement is not an application
workload and does not change the `eu-west-1` workload-region policy. The SNS
topic must already exist, be encrypted, and route to an approved human. Static
pipeline validation is not evidence that any budget, monitor, subscription, or
notification is live.

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

Activation requires the FinOps owner, threshold values, confirmed SNS
recipient, IAM/billing scope, estimated control cost, rollback, and a protected
workflow. The activation pipeline must validate the exact template SHA, obtain
protected-environment approval, deploy without widening application regions,
publish a harmless test notification to the same route, and record a sanitized
receipt. This repository batch activates none of them.

## Storage lifecycle decision

Current and noncurrent S3 objects must not be assigned an arbitrary expiry.
Before a lifecycle change, the workload and FinOps owners must approve:

- minimum rollback window;
- minimum immutable receipt/audit-retention window;
- treatment of current and last-known-good candidates;
- transition class and retrieval requirement;
- deletion boundary for superseded candidates and raw access logs;
- recovery test proving lifecycle does not remove required state.

The acceptance evidence is a pipeline receipt plus S3 Inventory after the
configured lifecycle interval. Merely checking a CloudFormation property is not
proof that accumulated current objects were reclaimed.

## Review

The monthly record must include exact source window, SHA/workload tags,
successful recall count, category costs, credits, unit cost, forecast,
budget/anomaly state, unexplained variance, reviewer, and decision. `Unknown`
and `not authorized` remain explicit outcomes.

See the AWS
[Cost Optimization pillar](https://docs.aws.amazon.com/wellarchitected/latest/cost-optimization-pillar/welcome.html)
and
[serverless expenditure awareness](https://docs.aws.amazon.com/wellarchitected/latest/serverless-applications-lens/expenditure-and-usage-awareness.html).
