# Sustainability baseline and targets

Status: repository-prepared; owner assignment, protected execution, live
baseline, and improvement evidence remain pending human decisions.

The project does not convert cost, architecture choice, or a short CI benchmark
into a carbon claim. It first measures workload intensity for an equivalent
functional result, then records an approved improvement and verifies that
reliability and performance did not regress.

## Functional unit

The functional unit is one **successful recall** as defined in
[`docs/finops/COST_MODEL.md`](../finops/COST_MODEL.md). A comparison is valid
only when the request corpus, correctness requirement, concurrency profile, and
service objective are equivalent.

## Proxy metrics

| Metric per successful recall | Evidence source | Current baseline |
|---|---|---|
| Lambda configured-memory GB-seconds | CloudWatch/Lambda Duration × configured memory | Pending |
| Lambda invocation and retry count | CloudWatch/Lambda | Pending |
| Bedrock model calls and input/output usage | Bedrock telemetry or billing dimensions | Pending |
| API Gateway processed bytes and request/error count | CloudWatch/API Gateway | Pending |
| CloudFront uploaded/downloaded bytes and requests | CloudWatch/CloudFront | Pending |
| Retained Lambda/API log bytes and retention | CloudWatch Logs metadata | Pending |
| CockroachDB provisioned/consumed capacity | Provider evidence | Pending |

These are engineering intensity proxies. Configured-memory GB-seconds use
Lambda `Duration`, not billed-duration rounding or extension duration. None may
be described as measured emissions without an applicable AWS sustainability
methodology and evidence source.

## Pipeline-owned measurement

The protected `Sustainability Intensity Evidence` workflow consumes an exact
successful version-2 Hosted Load Evidence receipt. That receipt provides the
bounded workload timestamps, synthetic-corpus contract, concurrency and
objectives, exact source deployment, the hosted workload contract-bundle digest
(covering `load/hosted-recall.js` and its imported runtime-neutral validator),
and a custom successful-recall counter that must equal the requested iterations.
Recall p95 and error rate are custom recall-only k6 metrics; the setup proof
request remains in the total request-integrity count but cannot distort the
recall p95/error objectives.

The read-only audit then queries the one-minute CloudWatch bins enclosing that
window. It records Lambda invocation/error/Duration values, API Gateway
`DataProcessed` and request/error values, CloudFront request/transfer values,
and point-in-time Lambda/API log storage metadata. All numerators and the exact
successful-recall denominator are retained in the sanitized receipt. Hosted
load begins in a fresh CloudWatch minute, and Lambda, API, and CloudFront
request counts must each equal the exact workload request count; detected
concurrent traffic fails the evidence run.

AWS application telemetry and the live stack are fixed to `eu-west-1`.
CloudFront metrics are read from its `us-east-1` global telemetry/control plane;
that read does not create an application workload there. The workflow creates,
updates, invokes, or deletes no AWS resource.

See [`sustainability-intensity.md`](../runbooks/sustainability-intensity.md) for
the approval, baseline, comparison, and raw-evidence handling procedure.
Metric definitions follow the official AWS documentation for
[Lambda metrics](https://docs.aws.amazon.com/lambda/latest/dg/monitoring-metrics-types.html),
[HTTP API metrics](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-metrics.html),
and [CloudFront metrics](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/programming-cloudwatch-metrics.html).

## Candidate improvements

None is selected until pipeline evidence exists:

- Lambda memory tuning for the lowest resource intensity that still satisfies
  latency and error objectives;
- `arm64` only after compatibility, latency, and cost evidence;
- bounded inference calls and output sizes;
- CloudFront compression and cache effectiveness review;
- lifecycle/retention reduction that preserves rollback and audit evidence;
- removal of unused metrics, logs, objects, and test environments;
- database/index configuration changes only if recall correctness and
  resilience remain intact.

The representative hosted comparison must run through CI/CD. No local load,
build, telemetry query, or tuning artifact is acceptable evidence.

## Human decisions required

The following remain null in the machine contract until approved:

- sustainability owner;
- baseline window;
- percentage intensity-reduction target;
- review period;
- acceptable latency/error/correctness bounds;
- retention changes;
- any paid AWS or CockroachDB measurement/control.

A live audit must fail rather than invent these decisions.

## Acceptance record

For the same functional unit and workload profile, the record must show:

1. exact before/after release SHAs and workflow runs;
2. correctness and SLO results;
3. every proxy numerator and successful-recall denominator;
4. the human-selected primary proxy and approved reduction target;
5. a target-meeting before/after reduction for that proxy;
6. absence or explicit acceptance of regressions;
7. owner review and next measurement date.

The repository has the measurement source only. Until both protected live
runs exist and the comparison succeeds, baseline values remain pending and no
improvement, carbon, emissions, production-scale, or business-impact claim is
permitted.

Use the current [AWS Sustainability service](https://docs.aws.amazon.com/sustainability/)
and the
[Sustainability pillar](https://docs.aws.amazon.com/wellarchitected/latest/sustainability-pillar/sustainability-pillar.html).
The Customer Carbon Footprint Tool was
[retired on 30 June 2026](https://docs.aws.amazon.com/ccft/latest/releasenotes/what-is-ccftrn.html)
and must not be introduced as the new evidence source.
