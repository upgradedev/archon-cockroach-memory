# Security policy

## Supported version

Only the current protected `main` release is supported during the
CockroachDB × AWS judging period. Historical commits, the retired Function URL
deployment helper, and the retired container path are not supported releases.

## Reporting a vulnerability

Please use
[GitHub private vulnerability reporting](https://github.com/upgradedev/archon-cockroach-memory/security/advisories/new).
Do not open a public issue containing exploit details, credentials, tenant data,
or unredacted logs.

Include the affected commit, endpoint or file, reproduction prerequisites,
observed impact, and a minimal proof. Never test destructive payloads against
the public demo or attempt to access data outside the fixed synthetic tenant.

## Validation boundary

Security validation is executed by hosted CI/CD pipelines. CodeQL, secret
scanning, dependency review, ShellCheck, workflow analysis, CloudFormation
policy checks, SBOM generation, and vulnerability/license scanning are separate
controls with different coverage. A green workflow is evidence that those
specific controls ran; it is not a claim that the software has no
vulnerabilities or that an independent penetration test occurred.

The supply-chain workflow begins in documented audit mode. Findings must be
triaged and the gate explicitly promoted to enforcement before it can be cited
as a blocking release control. See
[`docs/SUPPLY_CHAIN_SECURITY.md`](docs/SUPPLY_CHAIN_SECURITY.md).
