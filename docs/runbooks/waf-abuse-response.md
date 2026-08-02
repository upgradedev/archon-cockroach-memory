# WAF and public-demo abuse response

Status: repository-prepared; live activation, delivery drills, and human paging
require explicit approval and hosted evidence.

## Prepared control contract

The protected edge stack defines three CloudWatch alarms in `us-east-1`: total
WebACL blocks, aggregate API rate-rule blocks, and resolution-create rate-rule
blocks. `ALARM` and `OK` transitions route to a customer-managed-KMS encrypted
SNS topic and then to a customer-managed-KMS encrypted SQS archive with 14-day
retention. The queue is durable machine evidence, not a human paging channel.

AWS WAF request sampling is disabled because WAF logging redaction does not
apply to sampled requests. The only request-level evidence route is a 30-day,
customer-managed-KMS encrypted CloudWatch Logs group. Its logging filter drops
everything except `BLOCK` records and redacts query strings plus
`authorization`, `cookie`, `referer`, `x-api-key`, and
`x-archon-origin-verify` headers. Never copy raw WAF log records into a GitHub
artifact or incident document.

CloudFront WAF metrics intentionally omit the `Region` dimension, as required
by the AWS WAF metrics contract for CloudFront distributions. The implementation
follows the current AWS primary documentation for
[WAF metrics and dimensions](https://docs.aws.amazon.com/waf/latest/developerguide/waf-metrics.html),
[CloudWatch Logs WAF delivery](https://docs.aws.amazon.com/waf/latest/developerguide/logging-cw-logs.html),
[WAF logging filters and redaction](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-wafv2-loggingconfiguration.html),
[encrypted SNS event sources](https://docs.aws.amazon.com/sns/latest/dg/sns-key-management.html),
and
[encrypted SNS-to-SQS delivery](https://docs.aws.amazon.com/sns/latest/dg/sns-enable-encryption-for-topic-sqs-queue-subscriptions.html).

## Trigger

- a verified CloudFront WAF blocked-request or rate-rule alarm transition;
- an archived edge-alarm notification in the encrypted SQS evidence route;
- API Gateway throttling, Lambda throttling, or resolution-sandbox capacity
  alarm;
- unexpected cost or session-creation increase;
- evidence that the direct execute-api origin remains reachable after origin
  restriction was declared active.

## Triage

1. If a separately approved human paging destination exists, acknowledge there.
   Otherwise record that paging and acknowledgement are `not configured`; an
   SQS archive message must never be represented as human acknowledgement.
   Record the alert, exact deployed SHA, WebACL ARN digest, rule, timestamp, and
   responder through the approved incident process.
2. Confirm the public application through CloudFront and inspect sanitized
   aggregate metrics first. Raw BLOCK logs require separately approved incident
   access. Do not copy bearer tokens, database secrets, request bodies, client
   identifiers, or sensitive headers into the incident record.
3. Check whether the event is a managed-rule match, aggregate API rate,
   resolution-create rate, API Gateway throttle, or bounded session-capacity
   response.
4. Verify the canonical memory remains read-only and that action writes remain
   fixed-scope, synthetic, session-token-bound, and TTL-expiring.
5. Treat missing metrics, inaccessible logs, or an unverified WebACL
   association as `unknown`, never `contained`.

## Approved mitigations

Every mutation below requires the protected environment and recorded human
approval:

- lower or raise a rate threshold within the reviewed bounds;
- change a managed rule from block to count while diagnosing a false positive;
- rotate the origin capability and redeploy both CloudFront and Lambda;
- reduce API or Lambda concurrency;
- temporarily disable only the isolated resolution-session creation path.

Do not disable canonical read isolation, RLS, request bounds, the session cap,
TTL, or idempotency to restore availability.

## Origin verification

When active, acceptance is exact:

```text
CloudFront GET /api/health       -> 200
direct execute-api GET /health  -> 403
wrong or absent origin header   -> 403
```

The capability must be generated outside the repository, stored only in the
protected deployment environment/CloudFormation NoEcho parameter path, never
printed, and rotated after suspected disclosure. An empty parameter means the
control is dormant and must not be reported as active.

## Drill evidence

`Manage AWS Edge Controls` has `plan|apply|verify` operations. `apply` and
`verify` prove the live resource configuration and emit only identifier hashes;
they do not generate traffic, read the archive queue, page a human, or prove
delivery. Its receipt therefore fixes `alarmDeliveryDrill` to `not-run`,
`humanPagingDestination` to `not-configured-by-this-stack`, and
`humanAcknowledgement` to `not-claimed`.

A separate explicitly approved hosted drill is required before any alarm
delivery or response claim. It must use a dedicated, short-lived reader role
that can read only the exact environment archive queue and decrypt only through
SQS; the edge deployment role deliberately has no `ReceiveMessage` or
`DeleteMessage` permission.

The pipeline receipt must bind:

- exact commit SHA and protected workflow run;
- WebACL ARN digest, not the account ID or raw ARN;
- exact managed-rule group names and configured thresholds;
- same-origin success and direct-origin rejection;
- one safe synthetic managed-rule probe and one bounded rate-rule probe;
- alarm delivery timestamp, acknowledgement timestamp, and responder role;
- rollback result and post-rollback health;
- cost impact and any false positives.

Repository validation, a CloudFormation change set, or a `COUNT`-mode rule is
not live blocking evidence.
