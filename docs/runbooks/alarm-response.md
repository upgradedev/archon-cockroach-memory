# Alarm response

Current limitation: the alarm-routing foundation contract defaults to
`AlarmRoutingEnabled=false`. CodeDeploy can consume alarm state for rollback,
but there is no approved human paging destination or completed delivery drill.

## Trigger

- CloudWatch alarm changes state;
- hosted SLO evidence breaches an approved threshold;
- CodeDeploy rolls back because its candidate alarm fired;
- an expected alarm or receipt is absent.

## Response

1. Record environment, UTC time, exact release SHA, deployment run, alarm name,
   state, and reason without copying account identifiers or ARNs.
2. Determine whether the signal is candidate-specific, API-wide, Lambda,
   throttle, Bedrock, CockroachDB, or evidence-delivery related.
3. If CodeDeploy already rolled back, verify the alias/candidate and functional
   health through the existing protected pipeline.
4. If no responder received the event, record `human delivery not activated`;
   do not reinterpret archive availability as paging.
5. Escalate to the assigned operations owner. Until one exists, the live
   activation gate fails.
6. Any alarm routing enablement, subscription, threshold change, suppression,
   or new notification service requires explicit approval and a dedicated
   mutating workflow.

## Acceptance for a future delivery drill

- staging synthetic alarm only;
- explicit environment approval;
- transition to `ALARM` and back to `OK`;
- encrypted archive receipt;
- confirmed human receipt and acknowledgement;
- no production CodeDeploy alarm mutation;
- sanitized exact-SHA artifact.

See AWS guidance for
[alarm notifications](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Notify_Users_Alarm_Changes.html)
and [alarm testing](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Alarms.html).
