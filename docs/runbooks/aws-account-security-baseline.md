# AWS account security baseline audit

Status: repository-prepared; the read-only role, protected environment, account
controls, and live exact-SHA receipt are not claimed as active or verified.

This runbook closes the source-evidence gap for Well-Architected control WA-03.
It does not enable or remediate an AWS service. The only authorized execution
path is the manual
[`AWS Account Security Baseline Audit`](../../.github/workflows/aws-security-baseline.yml)
workflow on GitHub-hosted runners.

## Scope and authority boundary

The workflow reads one approved AWS account and `eu-west-1` at one exact current
`main` SHA. It checks:

| Control | Exact all-pass requirement |
|---|---|
| Audit identity | OIDC session belongs to `AWS_ACCOUNT_ID` and the configured read-only role |
| S3 account public access | All four account-level Block Public Access settings are true |
| Root credentials | Root MFA is enabled and no root access key exists |
| IAM password policy | Length at least 14, all four complexity classes, user change, 90-day maximum age, 24-password reuse prevention, and no hard expiry |
| CloudTrail | At least one multi-region trail includes global events, validates log files, is logging, and has successful log and digest delivery in its home region |
| GuardDuty | The regional detector exists and is enabled |
| Security Hub | The hub is readable and ready subscriptions include AWS Foundational Security Best Practices and a CIS AWS Foundations Benchmark |
| AWS Config | At least one continuously recording all-supported/global recorder and one successfully delivering history channel |
| IAM Access Analyzer | At least one active account- or organization-scope analyzer |
| EBS encryption | Encryption by default is enabled in `eu-west-1` |

Missing permissions, absent services, partial state, stale delivery, unexpected
identity, or unavailable APIs are failures. An unknown is never converted to a
pass. AWS Inspector and organization delegated-administrator coverage are
explicitly outside this receipt.

## One-time activation prerequisites

These are account mutations and require separate security-owner, cost, and
change approval. Do not perform them from a workstation or from this audit:

1. Assign the security owner in
   [`well-architected-contract.json`](../operations/well-architected-contract.json).
2. Create the GitHub `security-audit` environment with required reviewers,
   deployment branch restricted to `main`, and self-review prevention where
   the plan supports it.
3. Create a dedicated IAM role through an approved infrastructure pipeline.
   Its GitHub OIDC trust must require audience `sts.amazonaws.com` and subject
   `repo:upgradedev/archon-cockroach-memory:environment:security-audit`.
4. Attach only
   [`account-security-baseline-audit-policy.json`](../../aws/account-security-baseline-audit-policy.json)
   (plus no unrelated managed policy) and cap the session at 15 minutes.
   Its CloudTrail reads are intentionally region-unconditioned because
   `GetTrailStatus` must target a qualifying multi-region trail's home region;
   all regional service reads remain conditioned to `eu-west-1`.
5. Store the role ARN as environment variable `AWS_SECURITY_AUDIT_ROLE_ARN` in
   `security-audit`. Keep the already established 12-digit `AWS_ACCOUNT_ID`
   repository variable. Neither value belongs in source, logs, or receipts.
6. Separately decide whether to enable or remediate CloudTrail, GuardDuty,
   Security Hub standards, AWS Config, Access Analyzer, password policy, S3
   account public access, or EBS encryption. Some services incur charges;
   activation is outside the read-only workflow and reference policy.

The role is intentionally not added to `aws/bootstrap-oidc.yaml`: an audit must
not silently expand the authority of an application-delivery bootstrap. Until
the pre-existing role and protected environment are configured, WA-03 remains
`repository-prepared-live-audit-required`.

## Execute the exact-SHA audit

1. Choose the current `main` SHA only after its push runs for `CI`, `CodeQL`,
   and `Supply Chain (enforced)` are successful.
2. In GitHub Actions, open `AWS Account Security Baseline Audit`, select
   `main`, choose **Run workflow**, and enter the full lowercase 40-character
   SHA as `target_sha`.
3. The security reviewer compares the requested SHA and account/change ticket,
   then approves the `security-audit` environment. Approval authorizes a
   read-only observation, not remediation.
4. Require the audit job to pass. Download only the
   `aws-account-security-baseline-<sha>-<run>-<attempt>` artifact from the
   protected run.
5. Verify that the JSON receipt binds the repository and exact SHA, reports
   `10/10`, contains the ten expected control IDs, and contains no account ID,
   ARN, access key, detector/trail/analyzer name, or other raw identifier.
6. Record the workflow URL, artifact ID/digest, reviewer role, and decision in
   the release evidence ledger. Do not commit the receipt.

The workflow rechecks current `main` after environment approval, obtains a
15-minute OIDC session, keeps raw AWS responses only in `${RUNNER_TEMP}`, and
uploads only the sanitized receipt even on failure. A fail-closed receipt is
failure evidence, not a passing baseline.

## Failure and remediation path

1. Use the sanitized `controls[].observed` booleans/counts to identify the
   failed control. Do not publish or copy raw AWS responses.
2. Open a separate change with security owner, cost impact, rollback, and the
   minimum mutating IAM authority. This audit role must never receive write
   permissions.
3. Apply remediation only through a dedicated protected infrastructure
   pipeline.
4. Rerun this audit against a new exact green current-main SHA and retain both
   receipts. Never alter the earlier result.

## Revoke or retire

Remove `AWS_SECURITY_AUDIT_ROLE_ARN` from the protected environment first, then
retire the role through its owning infrastructure pipeline. Preserve receipt
metadata and the audit log according to the evidence-retention policy. Role
removal does not prove the account controls were disabled or changed.

## AWS references

- [Amazon S3 account-level Block Public Access](https://docs.aws.amazon.com/AmazonS3/latest/userguide/configuring-block-public-access-account.html)
- [IAM credential report and account summary](https://docs.aws.amazon.com/IAM/latest/UserGuide/credential-reports.html)
- [IAM password policy](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_passwords_account-policy.html)
- [CloudTrail log file integrity validation](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-log-file-validation-intro.html)
- [GuardDuty detector status](https://docs.aws.amazon.com/guardduty/latest/ug/guardduty_settingup.html)
- [Security Hub standards](https://docs.aws.amazon.com/securityhub/latest/userguide/standards-enable-disable.html)
- [AWS Config recorder concepts](https://docs.aws.amazon.com/config/latest/developerguide/stop-start-recorder.html)
- [IAM Access Analyzer concepts](https://docs.aws.amazon.com/IAM/latest/UserGuide/what-is-access-analyzer.html)
- [EBS encryption by default](https://docs.aws.amazon.com/ebs/latest/userguide/encryption-by-default.html)
