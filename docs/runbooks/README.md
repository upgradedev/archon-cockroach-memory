# Runbooks

Status: decision paths documented; no live responder, paging destination,
second region, billing control, or completed credential rotation is claimed.

Runbooks are executed through protected CI/CD workflows. They are not
instructions to build, test, recover, or mutate production from a developer
laptop.

| Condition | Runbook | Live capability |
|---|---|---|
| AWS account security baseline gap | [Account security baseline audit](./aws-account-security-baseline.md) | Protected read-only audit prepared; role, controls, and live receipt require approval |
| Alarm or SLO symptom | [Alarm response](./alarm-response.md) | Protected activation/dedicated filtered-queue drill path prepared; live route and human paging remain unclaimed |
| Failed deployment or unresolved recovery intent | [Rollback and recovery](./rollback-recovery.md) | Existing deployment/watchdog workflows; no fault-injected recovery receipt |
| Regional outage | [Regional outage](./regional-outage.md) | `eu-west-1` only; no approved second-region DR |
| Suspected credential compromise | [Credential compromise](./credential-compromise.md) | Protected two-principal rotation prepared; no live receipt |
| Database loss/corruption | [Database restore](./database-restore.md) | Approval-gated managed-backup drill prepared; no live receipt or PITR |
| Spend or usage anomaly | [Cost anomaly](./cost-anomaly.md) | No live Budget/anomaly monitor |
| Sustainability intensity baseline or comparison | [Sustainability intensity](./sustainability-intensity.md) | Protected read-only source prepared; no live baseline or improvement receipt |
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
