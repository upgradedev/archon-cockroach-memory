# Regional outage

Current architecture: regional AWS application resources and CockroachDB are
anchored in `eu-west-1`; CloudFront is global. There is no approved secondary
regional application stack or completed regional restore drill.

## Trigger

- AWS reports a material `eu-west-1` service disruption;
- multiple independent regional dependencies fail;
- the workload cannot meet its approved RTO/RPO in place.

## Response before DR activation

1. Confirm the signal from multiple sources and record affected dependencies.
2. Preserve exact release, data watermark, recovery ledger, and last-known-good
   evidence.
3. Notify the assigned workload and operations owners. They are currently
   unassigned, so live DR activation must fail closed.
4. Do not create resources in another region from an ad hoc console, local
   shell, or unreviewed workflow.
5. Do not use `us-west-2`.
6. Record service state as unavailable/degraded/unknown until health is
   restored and data consistency is verified.

## Approval required for a DR strategy

Before any second-region implementation:

- approve business RTO and RPO;
- choose backup-and-restore or pilot-light;
- choose an EU region other than `us-west-2`;
- approve AWS and CockroachDB cost;
- define data, secret, artifact, DNS/front-door, and audit-evidence handling;
- implement source-controlled IaC and least-privilege roles;
- run the complete restore through a protected pipeline;
- measure recovery time and restored data watermark;
- tear down temporary resources if that is the approved strategy.

Until that drill succeeds, regional disaster recovery is `not tested`, not
`ready`.

See AWS guidance on
[RTO/RPO](https://docs.aws.amazon.com/wellarchitected/latest/framework/rel_planning_for_recovery_objective_defined_recovery.html)
and
[disaster-recovery strategies](https://docs.aws.amazon.com/wellarchitected/latest/framework/rel_planning_for_recovery_disaster_recovery.html).
