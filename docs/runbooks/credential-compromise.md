# Credential compromise

Current capability: runtime database credentials are stored through AWS Secrets
Manager and are not committed to the repository.

The runtime now checks the `AWSCURRENT` Secrets Manager version every 30 seconds.
A changed version is authenticated with a bounded SQL probe before an atomic
pool swap. After a successful swap, the former pool accepts no new work and
drains checked-out clients.
If Secrets Manager or the candidate probe fails transiently, the process keeps
only its last proven pool, retries after 15 seconds, and never promotes the
unproven candidate.
This is the application-side prerequisite for two-principal rotation. A live
rotation has not yet been exercised and must not be claimed until the protected
rotation workflow produces an all-pass exact-SHA receipt.

## Protected two-principal workflow

`.github/workflows/database-credential-rotation.yml` is the only supported
rotation path. It is manual, shares the database-release concurrency boundary,
requires the `production-db` approval gate, assumes the short-lived database
operator role, and accepts only an exact current `main` SHA with successful CI,
CodeQL, supply-chain, and deployment runs. The selected CloudFront target must
prove that same release before retirement is allowed.
The OIDC trust is repository-ID, owner-ID, `main`, protected-environment, and
workflow-name bound. The rotation job further reduces the role with an inline
session policy: it can read only the exact admin secret and can describe, read,
list versions, write a version, or move a version label only on the selected
environment's runtime secret. Both ARNs are suffix-bounded to Secrets Manager's
six-character generated ARN suffix (`-??????`), not an open-ended name prefix.
Bedrock, secret creation/tagging/deletion, and unrelated secret access are
outside that session.

The pipeline creates an exact replacement principal, attaches only the public
reader and isolated resolution-writer roles, stores it as `AWSPENDING`, proves
the pending SQL credential, moves `AWSCURRENT`, and waits for all bounded hosted
proof requests to report the new database principal. Only then does it set the
old principal `NOLOGIN`, drain or cancel every session authenticated as that
exact old principal, prove that the old credential is rejected, revoke its
grants, and drop it. The
new version loses `AWSPENDING`; the old, unusable material remains labelled
`AWSPREVIOUS` only as audit evidence. Receipts contain hashes of identities and
version IDs, never the values themselves.

Before retirement begins, an inconclusive cutover moves `AWSCURRENT` back to
the proven old version and waits for hosted convergence before cleaning up the
prepared principal. Ambiguous provider state fails for operator review instead
of guessing. Once the old principal is disabled, the workflow completes
forward; it never presents a dead previous credential as a working rollback.
Lost `PutSecretValue` responses are reconciled by replaying the exact
idempotency token and payload. Candidate staging labels must be proven absent
from the paginated version inventory before the prepared principal can be
dropped.

Every script failure writes a sanitized, exact-release receipt with the last
completed phase, whether cutover was attempted/acknowledged/proved, whether
retirement started, and stable rollback/cleanup/operator-review outcomes. An
earlier workflow preflight failure is separately labelled and never claims that
the script mutated provider state. Success and failure receipts are both
attested and retained by the protected pipeline; raw provider errors, principal
names, version IDs, URLs, and secret material are excluded.

## Trigger

- credential appears in a log, artifact, screenshot, issue, or external report;
- unexpected authentication or database activity;
- Secret Manager or CockroachDB audit evidence indicates unauthorized access;
- routine rotation is later approved and scheduled.

## Response

1. Do not print, compare, paste, or download the suspected secret.
2. Record the secret identifier only in a redacted form, plus environment, UTC
   time, evidence source, and exact release.
3. Escalate to the assigned security and operations owners. They are currently
   unassigned.
4. Bound affected AWS role/session, database user, environment, and time window.
5. Dispatch the protected rotation workflow only after explicit approval; do
   not run the operator script from a workstation.
6. Use a documented overlap/blue-green strategy so new credentials are proved
   before old credentials are revoked.
7. Verify application health, old-credential rejection, audit events, and
   absence of secret values in every uploaded receipt.
8. Review historical access and record remaining unknowns.

Any emergency manual action must be recorded as an exception with actor,
approval, exact mutation, and follow-up pipeline reconciliation. This
repository-only batch neither rotates nor revokes credentials.
