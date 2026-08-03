# WAF and public-demo abuse response

Status: repository-prepared; live activation, delivery drills, and human paging
require explicit approval and hosted evidence.

## Prepared control contract

The protected edge stack defines three CloudWatch alarms in `us-east-1`: total
WebACL blocks, aggregate API rate-rule blocks, and resolution-create rate-rule
blocks. The alarms have no notification actions. One exact EventBridge rule
accepts only those alarms' `ALARM` and `OK` state-change events and writes them
to a dedicated CloudWatch Logs archive with 14-day retention. An exact
resource policy allows only EventBridge delivery from that rule. The archive
is durable machine evidence, not a human paging channel.

AWS WAF request sampling is disabled because WAF logging redaction does not
apply to sampled requests. The only request-level evidence route is a 30-day,
CloudWatch-encrypted Logs group using the service's AWS-owned default AES-GCM
encryption. Its logging filter drops everything except `BLOCK` records and
redacts query strings plus
`authorization`, `cookie`, `referer`, `x-api-key`, and
`x-archon-origin-verify` headers. Never copy raw WAF log records into a GitHub
artifact or incident document.

CloudFront WAF metrics intentionally omit the `Region` dimension, as required
by the AWS WAF metrics contract for CloudFront distributions. The implementation
follows the current AWS primary documentation for
[WAF metrics and dimensions](https://docs.aws.amazon.com/waf/latest/developerguide/waf-metrics.html),
[CloudWatch Logs WAF delivery](https://docs.aws.amazon.com/waf/latest/developerguide/logging-cw-logs.html),
[WAF logging filters and redaction](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-wafv2-loggingconfiguration.html),
[CloudWatch alarm state changes in EventBridge](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/cloudwatch-and-eventbridge.html),
[CloudWatch Logs encryption](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/encrypt-log-data-kms.html),
and [EventBridge resource-based target policies](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-use-resource-based.html).

## Trigger

- a verified CloudFront WAF blocked-request or rate-rule alarm transition;
- an archived edge-alarm transition in the default-encrypted CloudWatch Logs
  evidence route;
- API Gateway throttling, Lambda throttling, or resolution-sandbox capacity
  alarm;
- unexpected cost or session-creation increase;
- evidence that the direct execute-api origin remains reachable after origin
  restriction was declared active.

## Triage

1. If a separately approved human paging destination exists, acknowledge there.
   Otherwise record that paging and acknowledgement are `not configured`; a
   CloudWatch Logs archive event must never be represented as human
   acknowledgement.
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

`Manage AWS Edge Controls` has exact
`plan|apply|verify|cleanup|finalize` operations for `staging` and `production`.
Every dispatch is authorized from the exact current green `main` SHA. `plan`,
`apply`, `verify`, and `finalize` use the protected `edge-controls` environment;
destructive shell cleanup uses the separately protected `edge-cleanup`
environment and a distinct role that cannot create or execute change sets or
change lifecycle protections. Conversely, the ordinary edge-control role
cannot list change sets or delete a stack. `apply`, `cleanup`, and `finalize`
require, respectively,
`APPLY-{ENV}-EDGE-CONTROLS`, `CLEANUP-{ENV}-EDGE-CONTROLS`, or
`FINALIZE-{ENV}-EDGE-CONTROLS`, where `{ENV}` is `STAGING` or `PRODUCTION`.
`plan` and `verify` reject a non-empty confirmation.

The lifecycle boundaries are deliberately narrow:

- `plan` creates or reuses only the source-bound non-replacement change set. A
  greenfield CREATE plan can leave a CloudFormation shell in
  `REVIEW_IN_PROGRESS`; it has no deployed stack resources.
- `apply` re-proves and executes the exact available plan. If the exact current
  template is already deployed but stack policy or termination-protection setup
  was interrupted, a later `apply` switches to the same proof-and-finalize path
  instead of creating or executing another change set.
- `verify` is read-only and requires the exact template, parameters, nine
  resources, stack policy, termination protection, WebACL, logging routes,
  EventBridge archive route, and three action-free alarms to match.
- `cleanup` accepts only an unprotected `REVIEW_IN_PROGRESS` shell with zero
  resources or an unprotected `ROLLBACK_COMPLETE` stack whose every listed
  resource is `DELETE_COMPLETE`. It intrinsically recovers the originating
  commit and template digest from the single CREATE change set, fetches that
  historical repository commit, and compares both the source and CloudFormation
  template. Immediately before deletion it refreshes current `main`, then
  repeats the complete AWS stack, resource, change-set, template, and source
  binding checks; `DeleteStack` is the next external action. Success requires a
  subsequent name lookup to return CloudFormation `NotFound`. The receipt
  hashes the stack ID and deletion token. It may retain deterministic,
  account-neutral stack and change-set names plus source bindings, but never an
  account ID or ARN.
- `finalize` creates no change set. Normally it proves that the stable stack
  uses the exact current template, parameters, and nine-resource inventory,
  repairs the exact stack policy and termination protection, and then repeats
  the full live proof. For an interrupted deployment of an older revision,
  optional `deployed_sha` must be a green ancestor of current `main` with exact
  successful CI, CodeQL, and Supply Chain push runs. The workflow then loads
  that revision's template and stack policy, repairs only its lifecycle
  protections, and emits a source-bound protection-only receipt. If its
  semantics differ from current `main`, it explicitly does not claim current
  live controls and requires a new current plan/apply. These are the restart
  paths after deployment succeeded but lifecycle protection setup did not
  finish.

`apply` and `verify`, plus a current-semantics `finalize`, emit a sanitized
live-configuration receipt. A historical-semantics `finalize` emits only
lifecycle-protection evidence, while `cleanup` emits only deletion and
source-binding evidence; neither claims a current deployed control. None of the
five operations generates probe traffic, queries the alarm archive, pages a
human, or proves alarm delivery. Their receipts keep
`alarmDeliveryDrill` as `not-run`, `humanPagingDestination` as
`not-configured-by-this-stack`, and `humanAcknowledgement` as `not-claimed`.

A separate explicitly approved hosted drill is required before any alarm
delivery or response claim. It must use a dedicated, short-lived reader role
that can query only the exact environment alarm-archive log group; the edge
deployment role deliberately has no `FilterLogEvents`, `GetLogEvents`, or
`StartQuery` permission.

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
