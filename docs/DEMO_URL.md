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

The URL is a private-S3 React + Tailwind application behind CloudFront, with
same-origin API Gateway and Lambda services in `eu-west-1`. It requires no
credentials. Submission eligibility accepts this exact HTTPS CloudFront root
only; paths, query strings, fragments, credentials, and substitute hosts fail
closed.

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
