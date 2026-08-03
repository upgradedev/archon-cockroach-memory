# Rollback and delivery recovery

Status: repository-prepared. Protected staging/production deployment,
CodeDeploy canaries, candidate-version alarms, durable recovery intents, and
watchdog audit/recovery workflows exist in `eu-west-1`. The staging-only fault
injection path is source-complete, but a live fault-injected receipt and its
subsequent watchdog `RECOVERED`/no-op receipts are not claimed until those
protected pipelines run successfully.

RTO and RPO remain explicit human decisions in the Well-Architected contract.
A measured drill duration is evidence, not an approved objective by itself.

## Trigger

- deployment failure or cancellation;
- nonterminal durable-recovery intent;
- failed canary or post-deploy smoke;
- CloudFormation drift or protection audit failure.

## Response

1. Preserve the source deployment run ID, attempt, SHA, environment, candidate
   identity, and durable-intent identifier.
2. Allow `Recover AWS` to run its GitHub-only preflight from the exact trusted
   default-branch SHA. The preflight has `actions: read`/`contents: read` only:
   it has no environment, OIDC permission, AWS role, or AWS API access.
3. Treat active deploys, proved durable commits, and successful receipt-bound
   watchdog runs as `noop`. A routine `noop` exits before a protected
   environment or the shared `aws-shared-control-plane-mutation` serialization
   group.
   Only the documented GitHub active statuses are accepted; unknown statuses,
   incomplete job inventories, or more than one API page fail closed.
4. For a GitHub candidate, require the matching protected `staging` or
   `production` environment and existing least-privilege deploy role. Inside
   that protected job, re-read the private S3 ledger and require `recover` with
   the exact same source run ID, attempt, and candidate SHA before claiming a
   lease or performing any mutation.
5. The mutation job alone joins `aws-shared-control-plane-mutation`; the recovery
   watchdog has its own queue so it cannot deadlock normal delivery while
   performing read-only classification.
6. Verify application health, immutable receipt, lease release, idempotent
   reclassification, and no cross-environment mutation. Do not download and
   execute recovery code from an S3 bundle or a laptop.
7. Escalate any failed or ambiguous preflight, S3 reclassification, lease, or
   finalization. `Unknown` is not recovered.

The scheduled/manual protection-and-drift audit is a separate, explicitly
authorized read-only matrix job. It uses the existing protected environment
role, reclassifies the exact S3 ledger as `noop`, and never joins the delivery
mutation group. No unprotected AWS read role was introduced for preflight.

## Protected staging fault-injection drill

The drill reuses `Deploy AWS`; this preserves the exact production delivery and
recovery code path while hard-disabling production promotion for every manual
dispatch.

1. Start only from the current exact green `main` SHA after a successful push
   `Deploy AWS` run. The staging job requires the exact non-expired staging
   receipt artifact from that push. The manual graph skips both the mutating
   `database-release` reconciliation and the production Managed MCP audit; the
   successful source run already proved them.
2. Dispatch `Deploy AWS` with operation `staging-recovery-drill`, the exact
   current SHA, a non-secret approved change reference, and confirmation
   `FAULT-INJECT-STAGING-RECOVERY-AND-REQUIRE-WATCHDOG`. The protected `staging`
   environment supplies the human approval boundary.
3. Before the durable ledger is armed, the job rejects greenfield state and
   requires an existing same-SHA staging stack, the normal runtime database
   secret, its exact previously authenticated `CockroachSqlDns`, and
   `RecoveryDrillToken=disabled`. The DNS value is recovered from the prior
   stack parameters, not from a new shared database mutation. This prevents a
   drill from restoring an older release or touching the production database
   control plane. The SAM template independently enforces the same boundary
   with a CloudFormation Rule: a non-disabled token is invalid unless
   `Environment=staging`.
4. Persist the immutable recovery snapshot and move its ledger to `ARMED`.
5. Deploy one candidate version with a unique drill token and a deterministic
   staging-only database-secret name that the runtime role cannot access. No
   secret is created or read. The prior version remains healthy behind the live
   alias.
6. Continuously probe the data-backed proof endpoint and independently observe
   the exact candidate at 10% alias weight, its ExecutedVersion-scoped alarm in
   `ALARM`, and a deployment group configured for alarm rollback.
7. Accept the failed SAM step only when CodeDeploy reports exactly one original
   Lambda deployment as `Stopped` with `ALARM_ACTIVE`, its `externalId` is the
   exact existing CloudFormation stack, its creation time is inside the
   captured drill window, and the SHA-verified AppSpec names the exact function
   and `live` alias with the observed previous-to-candidate version transition.
   Runner timestamps must satisfy `started <= observed <= ended`; the bounded
   service-clock allowance applies only to AWS timestamps. Exactly one related
   automatic rollback deployment must be `Succeeded` and cannot predate its
   stopped source deployment. The staging role fetches the AppSpec through an
   exact SHA-only `GetApplicationRevision` request and can read only the
   staging CodeDeploy application/deployment-group ARN families.
   Then require CloudFormation
   `UPDATE_ROLLBACK_COMPLETE`, the exact prior template/parameters/tags/outputs,
   the old alias with no weights, and passing health/data proof.
8. Run the ordinary inline restore again. It must be idempotent and preserve the
   ledger as `ARMED`; the attested handoff receipt explicitly says terminal
   watchdog recovery is still pending.
9. Let the scheduled `Recover AWS` watchdog claim the exact intent, replay and
   prove the same prestate, persist its immutable receipt, and atomically mark
   the ledger `RECOVERED`. A subsequent watchdog run must classify the exact
   successful recovery receipt as GitHub-only `noop` before assuming AWS
   credentials.

Any missing or ambiguous observation fails closed and produces no successful
drill receipt. `Promote identical candidate to production` requires a successful
push event, so a manual recovery drill cannot enter the production job.
The credential-free watchdog also proves complete `total_count`-bound run,
job, and artifact inventories. It accepts trusted historical `workflow_run`
deployments and lease owners during migration, while never classifying a
manual dispatch as a production recovery candidate.

## New-release control-plane fence

Both deployment mutation jobs hold the shared
`aws-shared-control-plane-mutation` mutex. After any exact-owner reconciliation
of an interrupted same-run greenfield stack, but before stack-protection or any
new release mutation, the job revalidates the paginated global-latest
foundation and staging/production edge runs from one shared edge snapshot. It
fails closed unless their source SHA, run IDs/attempts, conclusions, and allowed
operations match the
source-gate receipts and the candidate is still the current `main` head.

That pre-fence same-run reconciliation is a deliberate recovery-only exception:
it may restore/delete only an orphaned candidate whose cryptographic owner and
recovery evidence match the current delivery run. It cannot deploy a candidate
or mutate foundation/edge controls. The canonical, timestamped fence proof is
bound to environment, job, deploy run/attempt, mutex group, main SHA, and exact
control operations; the final deployment receipt embeds it with a reproducible
SHA-256.

No recovery path may introduce an application or recovery workload in
`us-west-2`.
