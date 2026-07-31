# Incident process

Status: process defined; responders and live paging are not assigned.

The application may detect, record, recommend, roll back through an already
authorized delivery mechanism, and produce evidence. It does not infer a human
responder, contact a person, enable a service, rotate a credential, incur new
cost, or provision disaster-recovery infrastructure without approval.

## Severity guide

| Severity | Example | Initial disposition |
|---|---|---|
| SEV-1 | Confirmed public data exposure, compromised credential, or complete production outage | Escalate to the assigned security and operations owners |
| SEV-2 | Sustained SLO breach, failed rollback, unavailable database or Bedrock dependency | Escalate to the operations and workload owners |
| SEV-3 | Degraded noncritical function, rising error/cost trend, or recoverable drift | Record, bound impact, and schedule correction |
| Evidence gap | Alarm, owner, or telemetry unavailable | Preserve `unknown`; do not classify as healthy |

Severity assignment remains a human decision.

## Response sequence

1. **Identify:** record UTC time, exact release SHA, environment, symptom, and
   evidence source. Do not copy secrets or customer/database content.
2. **Bound:** determine whether staging, production, CockroachDB, Bedrock,
   CloudFront, or the delivery pipeline is affected.
3. **Authorize:** identify the required owner and approval before any external
   or mutating response.
4. **Contain:** prefer an existing reversible mechanism. Production rollback,
   credential rotation, traffic blocking, or new infrastructure requires its
   corresponding approval boundary.
5. **Recover:** use only protected CI/CD workflows and immutable receipts. Do
   not execute an untracked local recovery.
6. **Verify:** exercise functional health, data consistency, authorization,
   alarm state, and idempotency.
7. **Close:** record owner, decision, evidence URLs, remaining unknowns, and
   follow-up due date.

## Post-incident record

The record must include:

- incident identifier and severity;
- detection and acknowledgement timestamps;
- exact affected SHA/environment;
- observed facts separated from hypotheses;
- approvals and actors;
- actions and immutable workflow receipts;
- measured recovery duration and data watermark;
- SLO/RTO/RPO result when applicable;
- root/contributing causes;
- corrective control, owner, and due date;
- explicitly accepted residual risks.

The
[AWS incident-response guidance](https://docs.aws.amazon.com/wellarchitected/latest/framework/sec-10.html)
recommends prepared plans and recurring practice. A written runbook alone is
not evidence that the response path or human delivery has been exercised.
