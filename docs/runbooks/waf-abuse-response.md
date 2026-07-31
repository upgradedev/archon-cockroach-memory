# WAF and public-demo abuse response

Status: repository-prepared; live activation and drills require explicit
approval.

## Trigger

- CloudFront WAF blocked-request or rate-rule alarm;
- API Gateway throttling, Lambda throttling, or resolution-sandbox capacity
  alarm;
- unexpected cost or session-creation increase;
- evidence that the direct execute-api origin remains reachable after origin
  restriction was declared active.

## Triage

1. Acknowledge through the approved alarm destination and record the alert,
   exact deployed SHA, WebACL ARN digest, rule, timestamp, and responder.
2. Confirm the public application through CloudFront and inspect only
   sanitized aggregate metrics. Do not copy bearer tokens, database secrets,
   request bodies, or sampled sensitive headers into the incident record.
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
