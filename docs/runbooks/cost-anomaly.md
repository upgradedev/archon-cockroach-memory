# Cost or usage anomaly

Current limitation: [`aws/finops.yaml`](../../aws/finops.yaml) prepares a
monthly Budget and Cost Anomaly Detection monitor/subscription, but no human
billing recipient, control, or unit-cost baseline is activated by this
repository batch.

## Trigger

- AWS Budget or anomaly notification after future activation;
- unexpected Bedrock, Marketplace, Lambda, API, transfer, logging, S3, WAF, or
  CockroachDB usage;
- unit cost exceeds an approved threshold;
- resource inventory identifies unexpected persistence.

## Response

1. Record billing window, service/category, workload tag coverage, magnitude,
   and evidence source. Do not upload account identifiers or raw invoices.
2. Confirm whether credits, delayed Marketplace charges, retries, load tests,
   logging growth, or retained candidate/recovery objects explain the change.
3. Escalate to the assigned FinOps and workload owners. They are currently
   unassigned.
4. Do not disable production, delete evidence, change retention, or reduce
   safety controls without explicit approval.
5. Prefer reversible containment: pause an approved test schedule, reduce an
   approved nonproduction limit, or stop future optional work through a
   protected workflow.
6. Recalculate cost per successful recall for the same window and record
   unallocated costs.
7. Close only after the owner accepts the explanation or a corrective control
   has an owner and due date.

Budget and anomaly activation requires a dedicated billing-authorized workflow,
confirmed recipient, FinOps owner, explicit thresholds and approval reference,
estimated control cost, rollback, and a harmless test of the same SNS
notification destination. Static template validation is not a delivery drill.
