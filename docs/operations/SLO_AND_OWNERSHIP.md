# Service objectives and ownership

Status: repository contract ready; live activation is not approved.

This document separates the load-test thresholds that already exist in CI from
production service-level objectives that a responsible human has approved.
No person, team, availability promise, recovery promise, or paging destination
is inferred from repository history.

The machine-readable source of truth is
[`well-architected-contract.json`](./well-architected-contract.json). A
repository-only audit accepts explicit pending values. A requested live audit
fails closed until every required owner and objective is assigned or approved.

## Fixed deployment boundary

- Regional application workloads are permitted only in `eu-west-1`.
- `us-west-2` is explicitly forbidden for application and recovery workloads.
- CloudFront is the global front door; being global does not create a regional
  application workload.
- Any additional region requires a separate architecture decision, cost
  approval, approved RTO/RPO, and a pipeline-only disaster-recovery drill. It
  must not be `us-west-2`.

## Owners

| Responsibility | Current value | Proposed / Assigned Target | Activation requirement |
|---|---|---|---|
| Workload owner | Unassigned | Archon Core Team `<engineering@archon-memory.internal>` | Named accountable human or team |
| Operations owner | Unassigned | Archon Reliability Operations `<ops@archon-memory.internal>` | Named responder and escalation path |
| Security owner | Unassigned | Archon Security Office `<security@archon-memory.internal>` | Named incident/security decision owner |
| FinOps owner | Unassigned | Archon Cloud Financial Operations `<finops@archon-memory.internal>` | Named budget and anomaly reviewer |
| Sustainability owner | Unassigned | Archon Green Computing Lead `<sustainability@archon-memory.internal>` | Named intensity-metric reviewer |

These are deliberate placeholders in the repository contract to prevent unverified live activation. Assignment is a human decision at workflow dispatch time.

## Objectives requiring approval

| Objective | Current value | Proposed Target | Proposed measurement source |
|---|---|---|---|
| Availability | Pending | 99.9% | Successful requests divided by eligible requests |
| API p95 latency | Pending | 1,500 ms | Hosted CloudFront-to-database request telemetry |
| Request error rate | Pending | 1.0% | Hosted API 5xx/timeout/error telemetry |
| Recovery time objective (RTO) | Pending | 60 minutes | Timestamped recovery or DR drill |
| Recovery point objective (RPO) | Pending | 1,440 minutes (24 h) | CockroachDB Basic managed backups boundary |

The existing CI reference thresholds in
[`docs/BENCHMARK.md`](../BENCHMARK.md) remain test gates:

- recall latency p95 below 1,500 ms;
- recall@1 at least 0.99;
- request error rate below 1%.

They exercise a bounded CI workload and are not represented as production SLOs.
A human may adopt or change them only after hosted-path evidence and a cost
review.

The manual **Hosted Load Evidence** workflow closes the measurement gap without
inventing a production claim. It requires an exact current `main` SHA whose CI,
CodeQL, supply-chain, and deployment runs succeeded; a protected environment;
an explicit confirmation; an owned CloudFront target that proves the same
release; and operator-supplied p95/error objectives. It sends only 20–200
read-only recall requests with 2–10 virtual users against the synthetic public
demo corpus. The pipeline records observed latency, errors, grounded citation
completeness, tenant/status isolation, source deployment, and raw-summary
digest. Every measured recall must pass the contract, grounding, and isolation
validators; one semantic failure fails the run. Main CI also parses the shipped
k6 module with bounded dummy configuration without executing its networked
functions, while behavioral fixtures execute the same runtime-neutral validator
that k6 imports. It does not silently convert the results into a business SLA or
claim production-scale traffic.

The manual **Sustainability Intensity Evidence** workflow reuses the exact
successful version-2 hosted-load receipt as its functional-unit denominator.
It requires an assigned sustainability owner, a protected approval, an exact
green deployed release, an existing read-only audit role, a human-selected
primary proxy, and an approved reduction target. A baseline run records no
improvement; an equivalent after run must satisfy the same hosted correctness
and service objectives and meet the target before the receipt passes. These
measurements do not create an SLO, emissions claim, or production-scale claim.

## Live-activation gate

A `live-read-only` Well-Architected audit may proceed only when:

1. all five owners are assigned in the contract;
2. all five objectives contain approved numeric values;
3. the dispatch explicitly attests approval;
4. the protected `production-audit` environment approves the job;
5. the source is the exact `main` commit;
6. an existing least-privilege read-only role is configured;
7. the region remains `eu-west-1`.

The audit workflow never provisions, updates, deletes, enables, rotates, or
publishes an AWS resource.

## Review cadence

- Release: repository contract and exact-SHA evidence receipt.
- Monthly: repository audit; live read-only inventory only after activation.
- After an incident or objective breach: human-reviewed post-incident record
  and an explicit decision whether the objective or implementation changes.

No review is considered complete without a workflow run URL, exact commit SHA,
receipt digest, reviewer, and recorded disposition for every unknown.
