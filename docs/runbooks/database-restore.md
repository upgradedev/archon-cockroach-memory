# CockroachDB managed-backup restore

Status: repository-prepared, manual, approval-gated workflow. No live restore
has been run and no RTO has been measured.

The workflow
[`cockroach-restore-drill.yml`](../../.github/workflows/cockroach-restore-drill.yml)
restores one exact CockroachDB Cloud managed backup into a separate, existing,
empty CockroachDB Basic cluster. It is a managed-backup restore, not PITR. It
does not provision a cluster, change application traffic, cut over, delete, or
clean up anything.

## Recovery capability and current limit

CockroachDB Basic takes a managed backup every 24 hours and retains managed
backups for 30 days. Without a failed or delayed backup, the default worst-case
RPO is therefore up to 24 hours. That schedule is not point-in-time recovery.
RTO remains unknown until a protected live drill completes.

The isolated destination must:

- already exist in the same CockroachDB Cloud organization;
- be a different cluster from the source;
- use the Basic plan on AWS in `eu-west-1`;
- contain only the default empty-cluster databases and no user database,
  schema, table, view, sequence, or other relation;
- have no previous restore history;
- remain disconnected from production traffic.

`us-west-2` is forbidden. Creating the destination cluster, accepting its cost,
and deleting it later are separate, explicit approval boundaries.

## Protected configuration

The `production-db` GitHub Environment must require an accountable reviewer.
It provides the existing source configuration plus:

- `CCLOUD_API_KEY`: an organization-visible CockroachDB Cloud service account
  authorized to read the organization and administer both source and
  destination for restore;
- `COCKROACH_CLUSTER_ID`: the source Cloud API cluster UUID;
- `COCKROACH_RESTORE_EMPTY_SECRET_ID`: AWS Secrets Manager secret containing a
  TLS-verified SQL URL for the empty destination's `defaultdb` or `postgres`;
- `COCKROACH_RESTORE_VALIDATION_SECRET_ID`: AWS Secrets Manager secret
  containing a TLS-verified SQL URL for the restored `archon` database;
- `COCKROACH_ADMIN_SECRET_ID`: source administrator URL, or the existing
  documented default;
- `AWS_ACCOUNT_ID`, `AWS_DATABASE_OPERATOR_ROLE_ARN`, and `AWS_REGION`.

Every SQL URL must contain a password, use port `26257`, and have exactly one
query parameter: `sslmode=verify-full`. The workflow rejects
connection-string host, port, database, service, `hostaddr`, `options`, or any
other query override. It normalizes case and one trailing DNS dot, then
compares the URL hostname with `sql_dns` from the exact, single, primary
`eu-west-1` region in the Cloud API cluster response. It also proves that
source and destination have different SQL cluster IDs and that the destination
SQL cluster ID is unchanged after restore. SQL cluster IDs are continuity
evidence only; they are never treated as Cloud API cluster IDs.

## Manual dispatch contract

The reviewer supplies:

- the exact current `main` SHA;
- the existing destination cluster UUID;
- the exact backup ID returned by
  `GET /v1/clusters/{source_cluster_id}/backups`;
- `RESTORE <destination UUID> FROM <backup UUID>` as the destructive
  confirmation;
- an approved change/drill reference;
- approved RTO and RPO objectives;
- a bounded 30, 60, or 90 minute API poll window.

For this Basic managed-backup drill, the approved RPO objective cannot be less
than 1,440 minutes. A lower objective requires a different backup
architecture or plan, not optimistic labeling.

## Fail-closed sequence

1. Check out the exact protected `main` SHA without persisted credentials and
   prove it is still the remote `main` head.
2. Enter the reviewer-protected `production-db` environment and assume the
   existing short-lived AWS database-operator role.
3. Read source, destination, and caller-organization metadata with the pinned
   `Cc-Version: 2024-09-16` API contract.
4. Require source and destination to be distinct, `CREATED`, AWS Basic,
   single-region `eu-west-1` clusters under the same API organization
   boundary.
5. Select the exact requested backup ID from the source backup list and reject
   a missing, duplicate, future, or retention-expired recovery point.
6. Reject any destination restore history, bind both destination SQL secrets
   to the destination API DNS, and query SQL to prove the target is empty.
7. Snapshot only digests of the source schema, views, indexes, grants, roles,
   memberships, forced RLS policies, canonical memory rows, and both public
   C-SPANN index definitions.
8. Send exactly one mutating request:
   `POST /v1/clusters/{destination_cluster_id}/restores` with
   `source_cluster_id`, the exact `backup_id`, and `type: CLUSTER`.
   Because the API exposes no idempotency key, the POST is never retried after
   a transport or server error; an ambiguous outcome fails with
   `RESTORE_POST_OUTCOME_UNKNOWN`.
9. Poll
   `GET /v1/clusters/{destination_cluster_id}/restores/{restore_id}` until
   `SUCCESS`, `FAILED`, or the selected hard deadline. A pending timeout fails
   closed. The required response contract is limited to the documented
   `id`, `backup_id`, `status`, `created_at`, `type`, and
   `completion_percent`; optional backup time, cluster names, or completion
   time are validated only when returned.
10. Retry only read-only SQL availability for at most ten minutes, then prove
    the destination SQL identity, schema, grants, roles, RLS, C-SPANN indexes,
    canonical keys, row count, and canonical checksum match the source
    snapshot.
11. Measure RPO from backup `as_of_time` to restore request and RTO from
    restore request through completed SQL verification. Both must meet the
    approved objectives.
12. Attest and retain only a sanitized exact-SHA receipt. Raw Cloud API
    responses, SQL URLs, data, embeddings, account identifiers, and cluster
    identifiers are never uploaded.

The workflow emits a failure receipt when possible. A failed or timed-out
restore is not retried automatically; because the destination must have no
restore history, a second attempt requires a newly approved empty target.
There is no cutover in this workflow.

## Receipt interpretation

A passing receipt proves one exact managed backup was restored and verified at
one exact commit. It includes:

- SHA-256 identities for the organization, source, destination, backup,
  restore, SQL endpoints, and SQL clusters;
- recovery-point and bounded timing measurements;
- RTO/RPO objectives and dispositions;
- matching source/destination evidence digests;
- explicit `pointInTimeRestore: false`, `cutoverPerformed: false`,
  `deletionPerformed: false`, and `provisioningPerformed: false`.

Repository existence is not restore evidence. Until the workflow has a
successful, attested run, restore readiness remains `not tested`.

## Incident use

For real data loss or corruption:

1. stop only authorized write paths and preserve the incident record;
2. obtain workload, operations, database, cost, and change approval;
3. use an isolated empty destination and the exact known-good backup;
4. run the protected workflow and review the receipt;
5. treat any mismatch or unknown as a failed recovery;
6. perform any cutover through a separate approved workflow;
7. retain or delete the destination only through a separate approved action.

CockroachDB documents that a restore makes the destination unavailable,
replaces its data, and cannot be canceled, paused, or reversed. Isolation and
the no-cutover boundary are therefore the rollback strategy for this drill.

## Official API assumptions

The workflow is bound to the CockroachDB Cloud API version `2024-09-16` and
uses only fields and endpoints in the official contract:

- [Managed backups in CockroachDB Basic](https://www.cockroachlabs.com/docs/cockroachcloud/managed-backups-basic)
- [CockroachDB Cloud API usage and versioning](https://www.cockroachlabs.com/docs/cockroachcloud/cloud-api)
- [CockroachDB Cloud API reference](https://www.cockroachlabs.com/docs/api/cloud/v1)
- [Backup and restore overview](https://www.cockroachlabs.com/docs/cockroachcloud/backup-and-restore-overview)

If those response schemas or restore semantics change, the workflow fails
closed rather than guessing.
