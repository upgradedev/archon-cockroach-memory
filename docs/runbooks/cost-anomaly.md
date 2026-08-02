# Cost or usage anomaly

Current limitation: [`aws/finops.yaml`](../../aws/finops.yaml) and the manual
[`finops-controls.yml`](../../.github/workflows/finops-controls.yml) workflow
prepare a monthly Budget and Cost Anomaly Detection monitor/subscription. No
hosted receipt currently proves that a human billing recipient, live control,
or unit-cost baseline is activated.

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

## Activation and verification

Do not borrow a deployment role or long-lived AWS credentials. Before the first
dispatch, prove that the protected `finops-controls` environment and the
deterministic controller and CloudFormation execution roles from the
[cost-model activation contract](../finops/COST_MODEL.md#activation-contract)
exist. The approved SNS topic must be same-account, `us-east-1`,
customer-managed-KMS encrypted, human-routed, and contain the exact
Budgets/Cost Anomaly topic and key policy grants checked by the workflow.

1. Record the non-secret FinOps owner, approval reference, monthly budget,
   absolute anomaly threshold, percentage threshold, and notification topic.
   Do not upload account identifiers, endpoint addresses, or raw invoices.
   Confirm that the user-defined `Application` cost-allocation tag is active;
   the workflow verifies this read-only and otherwise fails before planning.
2. Dispatch `plan` for the exact current `main` SHA and enter every value
   explicitly. Wait for the protected-environment reviewer.
3. Review the sanitized receipt and the CloudFormation change set in AWS.
   Confirm its SHA/template/parameter/execution-role binding, three-resource
   allowlist, no replacement, and expected monthly control cost.
4. Dispatch `apply` with the identical SHA and values, enter
   `APPLY-WORKLOAD-FINOPS-CONTROLS-AND-ROUTING-TEST`, and obtain a new
   protected approval. The workflow refuses to create a plan during `apply`.
5. Confirm the harmless SNS routing message reached the accountable human.
   The artifact proves only that SNS accepted the publish; record human
   acknowledgment outside the digest-only artifact.
6. Dispatch read-only `verify` with the same approved values and exact current
   `main` SHA. Preserve its receipt with the approval and routing
   acknowledgment.

CloudFormation performs bounded rollback for a failed create or update. Do not
delete the stack, disable termination protection, change thresholds, or remove
the notification route as an automatic incident reaction. Reversal requires a
new inspected plan, protected approval, and explicit FinOps-owner decision.
Until successful hosted `apply` and `verify` receipts plus human routing
acknowledgment exist, report the controls as **prepared, not live**. Static
template or source-test success is not a delivery drill.
