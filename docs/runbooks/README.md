# Runbooks

Status: decision paths documented; no live responder, paging destination,
second region, billing control, or credential-rotation mechanism is claimed.

Runbooks are executed through protected CI/CD workflows. They are not
instructions to build, test, recover, or mutate production from a developer
laptop.

| Condition | Runbook | Live capability |
|---|---|---|
| Alarm or SLO symptom | [Alarm response](./alarm-response.md) | CloudWatch rollback alarms exist; human paging is dormant |
| Failed deployment or unresolved recovery intent | [Rollback and recovery](./rollback-recovery.md) | Existing deployment/watchdog workflows; no fault-injected recovery receipt |
| Regional outage | [Regional outage](./regional-outage.md) | `eu-west-1` only; no approved second-region DR |
| Suspected credential compromise | [Credential compromise](./credential-compromise.md) | Secret storage exists; rotation is not implemented |
| Database loss/corruption | [Database restore](./database-restore.md) | Approval-gated managed-backup drill prepared; no live receipt or PITR |
| Spend or usage anomaly | [Cost anomaly](./cost-anomaly.md) | No live Budget/anomaly monitor |
| WAF block, public-demo abuse, or direct-origin bypass | [WAF and abuse response](./waf-abuse-response.md) | IaC prepared; live WebACL, origin token, routing, and drill require approval |

For every runbook:

- preserve observed fact, unknown, inference, and human decision separately;
- record exact SHA, environment, timestamps, workflow URL, and receipt;
- never expose secrets, AWS account IDs, ARNs, database content, or embeddings;
- require the owner and approval named by the Well-Architected contract;
- use `eu-west-1`; never create recovery workloads in `us-west-2`;
- do not claim success until the acceptance checks complete.

The overarching severity, closure, and post-incident requirements are in
[`docs/operations/INCIDENT_PROCESS.md`](../operations/INCIDENT_PROCESS.md).
