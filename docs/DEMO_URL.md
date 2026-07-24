# Judge application and legacy cutover

## Current judge URL

The unrestricted CloudFront production URL is not recorded until the exact
main-branch candidate passes:

1. source CI;
2. staging deployment and real health/recall/audit/proof smoke;
3. hosted staging Playwright;
4. identical-candidate production promotion;
5. production smoke and hosted Playwright.

After those receipts exist, this file will contain the production URL and commit
SHA. Until then, repository readiness must report the demo deliverable as pending.

## Legacy `us-west-2` workload

The old IAM-authenticated Lambda Function URL is a private historical smoke
surface, not a public judge demo. It remains temporarily available only to avoid
an unverified cutover.

Known legacy resources:

- Lambda `archon-cockroach-memory`
- its IAM-authenticated Function URL
- log group `/aws/lambda/archon-cockroach-memory`
- role `archon-cockroach-memory-role` and its policies
- a legacy Lambda environment containing `DATABASE_URL`

Retirement occurs only after the new `eu-west-1` public production receipts and
Managed MCP audit pass. The retirement order is:

1. delete the legacy Function URL;
2. delete the Lambda;
3. remove the dedicated log group after the retention decision;
4. detach/delete the dedicated role policies and role;
5. revoke the CockroachDB login embedded in the legacy Lambda configuration;
6. run a scoped final `us-west-2` inventory and record a sanitized receipt here.

`aws/deploy-lambda.sh` is break-glass only. It requires both
`ALLOW_LEGACY_DEPLOY=1` and an explicit region, uses a temporary package
directory, and cannot silently recreate a default `us-west-2` workload.
