# Sustainability intensity evidence

Status: repository-prepared; no live baseline or improvement receipt is
claimed.

This runbook governs the protected, read-only
`Sustainability Intensity Evidence` workflow. It measures engineering resource
intensity for one successful recall. It does not calculate carbon or emissions,
does not activate AWS services, and does not change the deployed application.
CCFT is retired and is not an evidence source.

## Approval boundary

Before dispatch, an accountable sustainability owner must be assigned in
`docs/operations/well-architected-contract.json`. The `sustainability-audit`
GitHub environment must have a required reviewer, and the existing role named
by `AWS_SUSTAINABILITY_AUDIT_ROLE_ARN` must use no broader permissions than
`aws/sustainability-intensity-audit-policy.json`. The workflow does not create
that role or environment.

The dispatcher supplies:

- the exact current green `main` SHA and environment;
- the run id, attempt, and receipt digest of a successful version-2 `Hosted
  Load Evidence` run;
- one primary proxy and a 1–9,000 basis-point reduction target approved by the
  owner;
- a non-secret approval reference, retained only as a SHA-256 digest;
- either the all-zero baseline sentinel values or an exact prior baseline run,
  commit, attempt, and receipt digest;
- the confirmation string bound to environment, mode, and target SHA.

The hosted load and telemetry query can incur bounded service and telemetry
cost. Cost and execution approval happen outside the repository before the
protected environment reviewer releases the job.

## Evidence sequence

1. Run `Hosted Load Evidence` for the exact deployed release. Preserve its
   successful artifact and independently calculate the version-2 receipt
   SHA-256.
2. Dispatch this workflow in `baseline` mode. The pipeline proves current
   green `main`, deployment, hosted run identity, assigned owner, role/account
   binding, and the exact live stack release.
3. Make an optimization only through the normal reviewed CI/CD and deployment
   path. This evidence workflow never performs the optimization.
4. Run `Hosted Load Evidence` again with the same environment, synthetic
   corpus, iterations, concurrency, exact hosted-contract source digest,
   correctness gates, and objectives.
5. Dispatch this workflow in `compare` mode with the exact baseline receipt.
   It fails unless the equivalence digest, owner digest, primary proxy, and
   approved target match and the after value meets the reduction target.
6. Record the workflow URL, artifact digest, reviewer disposition, limitations,
   and next review date. A baseline receipt alone is not an improvement claim.

## Measured proxies

The pipeline reads one-minute CloudWatch bins enclosing only the hosted-load
workload window. It records Lambda invocations, errors and Duration; derives
configured-memory GB-seconds; records API Gateway requests, errors and
`DataProcessed`; and records CloudFront requests, bytes uploaded and bytes
downloaded. Each primary value is divided by the exact successful-recall
counter emitted by the hosted load. The receipt also binds a canonical
path-and-SHA-256 manifest for `load/hosted-recall.js` and its imported
`load/hosted-recall-contract.js` validator; a changed question, request, or
deterministic correctness contract therefore cannot be compared to the earlier
baseline.

Hosted load waits for a fresh CloudWatch minute before recording its workload
window. The audit requires Lambda, API Gateway, and CloudFront request totals to
equal the exact hosted request count. Any detected concurrent request in those
bins fails closed instead of being attributed to the test.

Lambda configured-memory GB-seconds are an engineering proxy, not
billed-duration GB-seconds. CloudFront metrics are read from the service's
`us-east-1` global telemetry/control plane; this creates no regional workload
there. The application and database workload remain in `eu-west-1`.

The receipt also includes point-in-time Lambda/API log `storedBytes` and
retention context. The audit never reads log events, Lambda environment
variables, database records, embeddings, or application objects.

## Failure and evidence handling

Missing access, stale or mismatched artifacts, a workload older than 14 days,
incomplete metrics, release drift, an unassigned owner, nonequivalent
workloads, or a missed reduction target fail closed. Retry only after resolving
the stated condition; do not widen the role or edit a receipt.

Raw STS, CloudFormation, CloudWatch, and log-group metadata responses stay
under the hosted runner's `RUNNER_TEMP`, are hashed for provenance, and are
deleted on exit. Only the sanitized receipt is uploaded. It contains no AWS
account id, ARN, role/session name, resource identifier, host name, secret,
human name, log content, or database content.

The receipt explicitly states that concurrent request traffic fails the exact
count gate, log storage is point-in-time context, the corpus is synthetic, and
neither emissions nor production scale were measured.
