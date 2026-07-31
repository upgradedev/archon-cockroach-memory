# Credential compromise

Current capability: runtime database credentials are stored through AWS Secrets
Manager and are not committed to the repository.

Current limitation: automatic or exercised CockroachDB credential rotation is
not implemented and must not be claimed.

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
5. Rotation/revocation requires explicit approval and a protected workflow with
   CockroachDB administrative authority.
6. Use a documented overlap/blue-green strategy so new credentials are proved
   before old credentials are revoked.
7. Verify application health, old-credential rejection, audit events, and
   absence of secret values in every uploaded receipt.
8. Review historical access and record remaining unknowns.

Any emergency manual action must be recorded as an exception with actor,
approval, exact mutation, and follow-up pipeline reconciliation. This
repository-only batch neither rotates nor revokes credentials.
