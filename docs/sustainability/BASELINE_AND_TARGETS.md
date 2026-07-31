# Sustainability baseline and targets

Status: measurement contract defined; owner, baseline, and target are pending
human decisions.

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
| Lambda GB-seconds | CloudWatch/Lambda | Pending |
| Lambda invocation and retry count | CloudWatch/Lambda | Pending |
| Bedrock model calls and input/output usage | Bedrock telemetry or billing dimensions | Pending |
| S3 GB-days and request count | S3/CloudWatch/Inventory | Pending |
| CloudFront/API transfer bytes | CloudFront/API telemetry | Pending |
| Retained log and recovery-evidence GB-days | S3/CloudWatch Logs | Pending |
| CockroachDB provisioned/consumed capacity | Provider evidence | Pending |

These are engineering intensity proxies. They must not be described as
measured emissions without the corresponding AWS sustainability data and
methodology.

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
build, or tuning artifact is acceptable evidence.

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
4. at least one statistically meaningful intensity reduction;
5. absence or explicit acceptance of regressions;
6. owner review and next measurement date.

Use the current [AWS Sustainability service](https://docs.aws.amazon.com/sustainability/)
and the
[Sustainability pillar](https://docs.aws.amazon.com/wellarchitected/latest/sustainability-pillar/sustainability-pillar.html).
The Customer Carbon Footprint Tool was
[retired on 30 June 2026](https://docs.aws.amazon.com/ccft/latest/releasenotes/what-is-ccftrn.html)
and must not be introduced as the new evidence source.
