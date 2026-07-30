# Judge application and legacy cutover

## Canonical judge URL

The unrestricted production application is:

**https://d2s5v0o0eg2aaw.cloudfront.net**

## Pinned exact feature-release baseline — 2026-07-30

The latest fully evidenced feature-bearing release baseline recorded before
this documentation-only update is commit
[`f3fafdac8d93a266eda9831edd0d66132940ec7b`](https://github.com/upgradedev/archon-cockroach-memory/commit/f3fafdac8d93a266eda9831edd0d66132940ec7b).
Every item below is hosted evidence for that exact SHA:

| Gate | Exact hosted evidence |
|---|---|
| Main CI | [Run 30533157603](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30533157603), all nine jobs successful |
| Code scanning | [CodeQL run 30533157215](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30533157215), successful with the prior receipt-flow alert fixed by analysis rather than dismissed |
| AWS + CockroachDB release | [Deploy AWS run 30533467206](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30533467206), attempt 1, six successful jobs covering every required deployment operation |
| Exact-release active + passive DAST | [Hosted DAST run 30535119259](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30535119259), source-bound to Deploy run `30533467206/1` |
| Independent CockroachDB proof | [Managed MCP run 30535180779](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30535180779), protected read-only production audit |
| Independent AWS protection/drift proof | [Recover AWS run 30535183552](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30535183552), manual `operation=audit`, both staging and production jobs successful |

Hosted measurements from the exact main CI run:

- backend unit/integration suite: 360 tests, 357 passed, 3 intentionally
  skipped, 0 failed; 94.70% lines, 82.99% branches, 94.06% functions;
- frontend: 42/42 unit tests and 4/4 desktop/mobile Playwright journeys;
  90.66% statements, 86.60% branches, 97.50% functions, 93.72% lines;
- k6: 554/554 checks, 0.00% request failures, 100.00% recall correctness,
  and 773.67 ms p95 at 20 concurrent virtual users;
- C-SPANN smoke: 98.6% mean recall@10 and 5.01 ms p95 over 1,500 vectors;
- exact-release active DAST: 16/16 checks; and
- exact-release ZAP: 13 URLs, 63 PASS, 0 FAIL, 0 WARN, with CSP alert
  `10055` and site-isolation alert `90004` both passing.

Key immutable evidence artifacts are unexpired and digest-bound by GitHub:

- [production deployment receipt 8756292172](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30533467206/artifacts/8756292172):
  `sha256:bab56a7f036ab5ad45fad91a22ebfe538621e76233a4a7bc73cecd35c442a2c8`;
- [exact-release DAST receipt 8756315429](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30535119259/artifacts/8756315429):
  `sha256:af6d93f95fd15301db2dfc013f9bbd4a3aec3e7d212ae9e9ddbacedfb3466b57`;
- [exact-release ZAP report 8756374638](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30535119259/artifacts/8756374638):
  `sha256:0ebbd7f9d43e07d3dd3716afa17f5c548c25c65b61c0e0c387c80bef3ccd6173`;
- [standalone Managed MCP receipt 8756341014](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30535180779/artifacts/8756341014):
  `sha256:49c73cbc84c6efd9949639ca92a216cd83aa06f1674c8b37521f87385db898a4`;
- [staging protection/drift audit 8756347685](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30535183552/artifacts/8756347685):
  `sha256:a0420d78238c58dcd20ee987fd9241c4c33d6e11938f93cde6069143122dd342`;
  and
- [production protection/drift audit 8756366419](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30535183552/artifacts/8756366419):
  `sha256:fa3462af7ec8770273f41a09cba19f81735570eb7b3c525af4967fae03eb1c44`.

These links are evidence references, not repository artifacts. No generated
receipt, coverage output, ZAP report, build tree, or video file is stored in the
workspace. This immutable baseline remains valid when a later documentation-only
commit advances `main`; that later commit must pass the live pipeline gates on
its own.

## Historical exact-release milestones

The first fully verified exact-SHA cutover baseline is:

- commit
  [`2202d758b390efbd23ecd4532196f879f227f282`](https://github.com/upgradedev/archon-cockroach-memory/commit/2202d758b390efbd23ecd4532196f879f227f282);
- [Deploy AWS run 30142557871](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30142557871);
- source CI and exact-SHA CodeQL;
- protected database schema/seed/RLS plus both runtime-principal C-SPANN paths;
- staging canary, full API smoke, and hosted Chromium journey;
- identical-candidate production promotion, full smoke, and hosted Chromium journey;
- final production CockroachDB Cloud Managed MCP read-only audit.

The reconciliation feature-bearing baseline is commit
[`25ca1c84f9df7721b8415b9bd55cc5849bf96ca4`](https://github.com/upgradedev/archon-cockroach-memory/commit/25ca1c84f9df7721b8415b9bd55cc5849bf96ca4)
in [Deploy AWS run 30144685107](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30144685107).
Its protected schema-v5 receipt proves that the six exact 2026-07-13 legacy
duplicates remain as linked `superseded` history while the public runtime sees
exactly nine active canonical memories, nine unique idempotency keys, and nine
payload-bound SHA-256 digests. Staging and production then passed the exact
9/9/9 API contract, real recall, hosted Chromium, and the final Managed MCP
audit. A separate read-only request after deployment observed the same 9/9/9
Store proof and complete 9/9 audit coverage.

A historical hardened exact-SHA milestone is commit
[`a2b69e3fad31010d14d0c3bca261421e635ca885`](https://github.com/upgradedev/archon-cockroach-memory/commit/a2b69e3fad31010d14d0c3bca261421e635ca885)
in [Deploy AWS run 30204081177](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30204081177).
That protected run passed build-once promotion, database release, staging,
production, hosted Chromium, and the hardened exact-scope Managed MCP v2
`9 / 9 / 9` receipt, with sanitized artifacts uploaded.

A later historical protected release milestone is commit
[`8c09b7ee07f1a3a0cd8ea19bf1db900c992e3edf`](https://github.com/upgradedev/archon-cockroach-memory/commit/8c09b7ee07f1a3a0cd8ea19bf1db900c992e3edf)
in [Deploy AWS run 30331875727, attempt 2](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30331875727/attempts/2).
That protected run passed build-once promotion, database release, staging,
production, hosted Chromium, fresh protection/drift gates, durable intent
commit, and the exact-scope Managed MCP v2 `9 / 9 / 9` receipt.

The URL is a private-S3 React + Tailwind application behind CloudFront, with
same-origin API Gateway and Lambda services in `eu-west-1`. It requires no
credentials. Submission eligibility accepts this exact HTTPS CloudFront root
only; paths, query strings, fragments, credentials, and substitute hosts fail
closed.

## Durable delivery recovery evidence

That historical protected release proved the activated cross-run control plane:
both environments created immutable recovery archives, armed their CAS-ledger
intents, passed terminal controls, and committed the exact receipt-bound
release. Automatic
[Recover AWS run 30333619982](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30333619982)
then assumed both recovery roles, classified the exact committed source run,
and exited successfully without a lease or restoration mutation:

- a data-only prior-release archive is created in CI and stored in the private,
  encrypted, versioned artifact bucket under
  `candidates/recovery/<environment>/`;
- an S3 ledger object is created with `If-None-Match: *` and advanced with
  `If-Match` against its current ETag, forming a compare-and-swap chain that
  implements `ARMED → COMMITTED` or
  `ARMED → RECOVERING → RECOVERED`;
- the independent `Recover AWS` workflow is defined for the exact completed
  `Deploy AWS` run, manual dispatch, and a 15-minute watchdog schedule. Its
  two-hour lease is bound to the exact watchdog run, attempt, and environment;
  an active owner blocks a competitor, while expiry or an exactly proved dead
  owner permits a CAS reclaim;
- recovery emits a strict schema-v2
  `archon.durable-recovery.receipt` bound to the immutable archive, manifest,
  exact `RECOVERING` ledger revision, executor, and sanitized restoration
  proofs; and
- the idempotent finalizer conditionally creates checksum-addressed receipt and
  post-recovery CloudFormation-control objects, reads back and verifies both
  exact S3 versions, then CAS-advances the same lease to `RECOVERED` with both
  object identities bound into the ledger. A process exit or supplemental
  GitHub artifact is not terminal proof.

Existing-stack preflight, terminal, recovery, and audit gates bind the exact
StackId/name/account/region, execution role, revision, and canonical tag
digest. They enforce termination protection and run fresh bounded
CloudFormation drift detection. Greenfield recovery instead proves exact
absence, and its cleanup can disable protection only after re-proving the exact
run-owned stack. The checked-in audit does not mutate protection and is
scheduled daily at `04:17 UTC`, when the classifier finds no pending recovery.
The identical audit is also explicitly replayable from the current trusted
`main` SHA through `workflow_dispatch` with `operation=audit`; reruns of stale
workflow SHAs remain rejected.

The selected prefix remains within each environment-scoped role and requires no
new database authority. The recovery IAM revision was promoted through a
separately authorized change set containing only three in-place managed-policy
document updates; it completed successfully and foundation drift is `IN_SYNC`.
The protected release exercised the required live APIs, and the automatic
watchdog proved both recovery-role assumptions and the committed/no-op path.
This does not claim an intentionally failed deployment, a live
`RECOVERING → RECOVERED` finalizer receipt, or a scheduled `04:17 UTC` audit
receipt. Source presence or a local script run remains insufficient evidence.

The recovery bucket, ledger, credentials, and any watchdog compute are fixed to
AWS `eu-west-1`. CloudFront remains global edge infrastructure. This design
does not recreate an application or recovery workload in `us-west-2`.

## Retired legacy `us-west-2` workload

The historical IAM-authenticated Function URL was never the public judge demo.
After the `eu-west-1` production and Managed MCP gates passed, the dedicated
legacy resources were retired on 2026-07-25:

- Function URL deleted;
- Lambda `archon-cockroach-memory` deleted;
- log group `/aws/lambda/archon-cockroach-memory` deleted (2,082 bytes);
- inline `bedrock-invoke` policy and dedicated
  `archon-cockroach-memory-role` deleted;
- shared AWS-managed `AWSLambdaBasicExecutionRole` policy only detached.

Final direct inventory:

```text
ArchonLambdaFunctionsInUsWest2: []
ArchonLambdaLogGroupsInUsWest2: []
LegacyDedicatedIamRoles: []
SharedCockroachOperatorCredentialTouched: false
```

The deleted AWS resources are not directly recoverable; their source remains in
Git. The SQL credential found in the old Lambda was intentionally not revoked:
it is the same operator credential still used by the protected database-release
pipeline. Its migration requires a separate two-principal
pending→prove→activate→observe→retire workflow. It is no longer attached to a
`us-west-2` compute workload.

`aws/deploy-lambda.sh` remains break-glass only. It requires both
`ALLOW_LEGACY_DEPLOY=1` and an explicit region, uses a temporary package
directory, and cannot silently recreate a default `us-west-2` workload.
