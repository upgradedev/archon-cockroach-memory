# Judge application and legacy cutover

## Canonical judge URL

The unrestricted production application is:

**https://d2s5v0o0eg2aaw.cloudfront.net**

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

The current hardened exact-SHA evidence is commit
[`a2b69e3fad31010d14d0c3bca261421e635ca885`](https://github.com/upgradedev/archon-cockroach-memory/commit/a2b69e3fad31010d14d0c3bca261421e635ca885)
in [Deploy AWS run 30204081177](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30204081177).
That protected run passed build-once promotion, database release, staging,
production, hosted Chromium, and the hardened exact-scope Managed MCP v2
`9 / 9 / 9` receipt, with sanitized artifacts uploaded.

The URL is a private-S3 React + Tailwind application behind CloudFront, with
same-origin API Gateway and Lambda services in `eu-west-1`. It requires no
credentials. Submission eligibility accepts this exact HTTPS CloudFront root
only; paths, query strings, fragments, credentials, and substitute hosts fail
closed.

## Durable delivery recovery status

The live URL and the verified runs above use the deployed same-run canary and
rollback controls. They do not prove the current AWS-native cross-run recovery,
finalizer, or CloudFormation-control revision. That revision is checked in, but
is **not claimed as deployed or hosted-CI evidence**:

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

The selected prefix is already inside the permissions of each live
environment-scoped delivery role, so the ledger itself needs no new database
authority. An unselected DynamoDB alternative would additionally require table
provisioning. The bootstrap template models the required `Recover AWS` OIDC
trust and narrow recovery, finalization, cleanup, termination-protection, and
drift actions, but this is source state only. The currently authorized
`Bootstrap AWS Foundation` workflow accepts only the exact artifact-bucket
logging change and cannot promote IAM. Before this revision becomes live
evidence, it needs a separately authorized, narrowly reviewed foundation IAM
promotion, post-promotion assume-role and allowed/denied API proof, hosted CI,
and protected staging/production recovery, finalizer, and audit receipts.
Source presence or a local script run is insufficient.

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
