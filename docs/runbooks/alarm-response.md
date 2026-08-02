# Alarm routing activation, drill, and response

Current limitation: `AlarmRoutingEnabled=false` is the safe foundation default.
The repository contains a protected activation and encrypted archive-delivery
drill, but no live activation, drill, responder paging, or human receipt is
claimed until the corresponding hosted exact-SHA receipts exist.

## Authority and boundaries

Only `.github/workflows/alarm-routing-controls.yml` may operate this control.
It is manual, accepts only the current `main` SHA with successful CI, CodeQL,
and Supply Chain runs, and crosses the protected `alarm-routing-controls`
environment. Inputs are non-secret record references; names, email addresses,
phone numbers, and other contact details are prohibited.

The repository-bound OIDC role can pass only
`<app>-alarm-routing-cloudformation-execution`. Activation is one-way and is
accepted only when:

- the live original foundation template digest equals the authorized source;
- the stack policy equals `aws/bootstrap-stack-policy.json`;
- the eight-parameter contract is exact and only `AlarmRoutingEnabled` changes
  from `false` to `true`;
- the change set adds exactly the 15 conditional KMS, SNS, SQS, IAM, and
  staging-probe resources;
- replacement, deletion, and modification of existing resources are all zero;
- the protected operator enters `ACTIVATE-ENCRYPTED-ALARM-ROUTING`.

The workflow intentionally has no disable operation. The alarm resources use
retention policies and the foundation stack becomes bound to the dedicated
CloudFormation execution role when an activation plan is executed, including
after a failed update that CloudFormation rolls back. A retried plan accepts
only that exact role and still requires `AlarmRoutingEnabled=false`. Finish
every other foundation migration before activation. A later foundation-template change requires a newly reviewed
execution-role contract and pipeline change; do not attempt an ad-hoc update.

## Plan, apply, and verify

1. Run `plan` against the exact green `main` SHA with the approved change-record
   reference. It uploads the exact template to the private versioned artifact
   bucket using the application KMS key and creates an inert deterministic
   change set.
2. Review the sanitized receipt and the protected job. It must report 15 adds,
   zero existing-resource mutations, and zero replacements.
3. Run `apply` with the same SHA and approval reference plus the exact
   confirmation. Apply re-derives and re-inspects the existing plan; it never
   creates a replacement plan implicitly.
4. The workflow waits for `UPDATE_COMPLETE`, then proves both environment
   topics, both encrypted 14-day operational archive queues, the dedicated
   encrypted five-minute staging drill queue, its exact `AlarmName` body
   filter, KMS rotation and policies, subscriptions, tags, queue producer
   denies, and the exact alarm actions.
5. `verify` repeats those checks without mutation.

Plan is source readiness, not live activation. Apply or verify is live evidence
only when its uploaded receipt has `ok=true`, the target commit is the exact
deployed SHA, and the protected GitHub run remains available.

## Bounded staging delivery drill

Use `drill` only after activation. Supply a non-secret operation approval
reference, a non-secret human acknowledgement-record reference, and
`DRILL-STAGING-ALARM-DELIVERY`. The workflow refuses the drill until at least
15 minutes after the foundation's last update, covering SNS filter-policy
propagation before the drill role reads the dedicated queue.

The drill can call `SetAlarmState` only on
`<app>-staging-routing-drill`. That probe is owned by the foundation and is not
attached to CodeDeploy. The workflow verifies its only action is the staging
topic, forces `ALARM`, observes the uniquely reason-bound SNS envelope in a
customer-key-encrypted, short-retention queue whose subscription accepts only
the probe's exact `AlarmName`, and restores `OK` even on failure. The drill role
cannot read the 14-day operational archive. It receives with zero visibility
timeout and does not delete the message. Its IAM policy has no production
`SetAlarmState` resource. The observer tolerates SNS/SQS at-least-once duplicate
delivery while still requiring the exact unique drill reason and recording the
number of matching envelopes.

The receipt stores hashes of the approval/acknowledgement references, message
id, body, timestamp, role, stack, repository, and workflow identity. It stores
no raw AWS identifiers, raw human references, contact details, message body, or
secret values.

This drill proves CloudWatch -> encrypted SNS -> encrypted filtered SQS probe
delivery without reading the operational archive.
The acknowledgement reference is a dispatch attestation bound to the receipt;
it does not prove that a human pager, email, SMS, or incident-management system
received the alarm. That separate production paging test remains required.

## Operational response

1. Record environment, UTC time, exact release SHA, deployment run, alarm name,
   state, and reason without copying account identifiers or ARNs.
2. Determine whether the signal is candidate-specific, API-wide, Lambda,
   throttle, Bedrock, CockroachDB, or evidence-delivery related.
3. If CodeDeploy already rolled back, verify the alias/candidate and functional
   health through the existing protected pipeline.
4. If the archive contains the event but no responder received it, record
   `archive route healthy; human delivery not proved`. Never reinterpret SQS
   evidence as paging evidence.
5. Escalate to the assigned operations owner. Until an owner and destination
   exist, the human incident-loop gate remains incomplete.
6. Subscription, threshold, suppression, production alarm state, or
   notification-service changes require their own explicit approval and
   mutating pipeline. Do not use the staging drill authority.

See AWS guidance for
[alarm notifications](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Notify_Users_Alarm_Changes.html)
and [alarm testing](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Alarms.html).
