# Well-Architected review: Agentic AI Lens

Reviewed commit: `25c8f4434dc42771e1262aad30441f01c9868d77` (`main`).
Review date: 2026-08-04.
Lens: [AWS Well-Architected Agentic AI Lens](https://docs.aws.amazon.com/wellarchitected/latest/agentic-ai-lens/agentic-ai-lens.html),
published 2026-06-10.
Reviewer role: architecture review, not an audit gate. Nothing here blocks a
merge and nothing here was fixed while writing it.

## What this document is, and what it is not

This is a first-party Well-Architected review of a running system against a
published AWS lens. It names what is wrong, how bad it is, what the evidence
is, and what fixing it would cost.

It is deliberately not the same thing as
[`well-architected-audit.yml`](../.github/workflows/well-architected-audit.yml)
and [`well-architected-contract.json`](./operations/well-architected-contract.json).
Those check that the repository agrees with itself. That is a useful property
and the repository has it. But a self-consistency check stays green while the
service is down, because "documented as not live" is a state it accepts. It did
stay green through the outage described below. This review looks at the running
system instead, and most of its findings come from read-only AWS API calls and
unauthenticated HTTP requests made on the review date.

Every control ID cited here was resolved against the live lens documentation
before it was written down. IDs that did not resolve are not used. The lens has
seven questions under Operational Excellence, nine under Security, seven under
Reliability, seven under Performance Efficiency, seven under Cost Optimization,
and three under Sustainability.

## The workload

A single-tenant public demo of persistent agent memory.

```
CloudFront (OAC, security headers, SPA rewrite)
  ├── private S3 bucket, KMS-encrypted, versioned, access-logged
  └── /api/*  →  API Gateway HTTP API (named stage "live")
                   → Lambda (Node 22, 512 MB, reserved concurrency 5)
                       ├── Amazon Bedrock — Titan Embed v2 (1024-dim), Claude Sonnet narration
                       └── CockroachDB Cloud Basic (eu-west-1)
                             VECTOR(1024) C-SPANN indexes
                             row-level security, forced
                             row-level TTL on the sandbox tables
```

The agent does four things: it embeds a question, recalls prior financial
memories by cosine similarity over a distributed vector index, narrates a cited
answer, and audits its own memory for contradictions and absences. A separate
sandbox demonstrates a human-gated memory correction loop that never writes to
canonical memory.

The lens calls out "agents remember" as one of the five dimensions that make
agentic systems architecturally different. That dimension is what this workload
is. So the two questions that matter most here are
[AGENTSEC01 Secure agent memory and state](https://docs.aws.amazon.com/wellarchitected/latest/agentic-ai-lens/agentsec01.html)
and
[AGENTREL03 Agent memory and state management](https://docs.aws.amazon.com/wellarchitected/latest/agentic-ai-lens/agentrel03.html).
The system scores well on the first and badly on the second, and that split is
the honest summary of the whole review.

## How severity and size are used

**HIGH** — the service is losing availability, memory integrity, or money right
now, or a single actor can make it do so. Fix before judging.

**MEDIUM** — a real gap that does not by itself take the system down, but
removes a layer of defence or leaves an objective unmeasurable.

**LOW** — acceptable at demo scale, would matter at production scale.

**S** — under an hour, usually one file. **M** — half a day, several files and
a deploy. **L** — multi-day, needs a design decision or a spend approval.

## Findings by pillar

| Pillar | HIGH | MEDIUM | LOW | Total |
|---|---:|---:|---:|---:|
| Reliability | 2 | 2 | 1 | 5 |
| Operational excellence | 3 | 2 | 1 | 6 |
| Security | 1 | 3 | 2 | 6 |
| Performance efficiency | 0 | 2 | 1 | 3 |
| Cost optimization | 1 | 1 | 1 | 3 |
| Sustainability | 0 | 1 | 1 | 2 |
| **Total** | **7** | **11** | **7** | **25** |

---

# Reliability

Lens questions: AGENTREL01 to AGENTREL07. The one that governs this workload is
[AGENTREL03](https://docs.aws.amazon.com/wellarchitected/latest/agentic-ai-lens/agentrel03.html),
"How do you support agent memory and state remaining reliably accessible
throughout the agent lifecycle?"

## REL-1 — HIGH — The memory store has been unavailable since 2026-08-02 and the system did not notice

**Lens:** [AGENTREL03-BP02](https://docs.aws.amazon.com/wellarchitected/latest/agentic-ai-lens/agentrel03-bp02.html)
architect fault-tolerant memory stores;
[AGENTREL03-BP04](https://docs.aws.amazon.com/wellarchitected/latest/agentic-ai-lens/agentrel03-bp04.html)
graceful degradation;
[AGENTOPS07](https://docs.aws.amazon.com/wellarchitected/latest/agentic-ai-lens/agentops07.html)
operational recovery and consumption monitoring.

This is the worked example the rest of the review hangs off, so it gets the full
treatment.

**What happened.** The CockroachDB Cloud Basic cluster consumed its 400M Request
Unit allowance and was disabled by the provider. The runtime login is now
refused with `the maximum number of allowed connections is 0`. Every route that
touches the database has returned HTTP 500 since 2026-08-02 11:20 UTC. The last
successful data-plane response was 2026-07-31 01:22 UTC. That is a continuing
outage of more than two days at the time of writing.

**Verified on the review date.** Unauthenticated requests to the public demo
origin:

```
GET https://d2s5v0o0eg2aaw.cloudfront.net/          → 200
GET https://d2s5v0o0eg2aaw.cloudfront.net/api/health → 200
GET https://d2s5v0o0eg2aaw.cloudfront.net/api/proof  → 500
GET https://d2s5v0o0eg2aaw.cloudfront.net/api/audit  → 500
```

The health response body at the time of the review:

```json
{"ok":true,"status":"reachable","service":"archon-cockroach-memory",
 "access":"public-read-only","dependencies":"unchecked", ...}
```

**Why nothing caught it.** The deployed build's health endpoint is a
reachability stub. It reports `dependencies:"unchecked"` and `ok:true` without
touching anything. The Control Room masthead reads that field, so the UI showed
a healthy API while every route that does real work returned 500. A liveness
check that cannot fail is not a health check. This is the classic version of the
failure the lens describes under AGENTREL03: the agent's memory was gone and the
agent's own reporting said it was fine.

**Root cause, not just proximate cause.** The RU allowance was drained because
the request budget is shared rather than per-caller. See REL-2. The exhaustion
is a symptom of the throttling design, and it will happen again after any
restore unless that design changes.

**Remediation already merged, not yet deployed.** `main` replaces the stub with
a real bounded probe. [`src/http/handler.ts:295-330`](../src/http/handler.ts)
races a `SELECT 1` through the live pool against an explicit timer, cleans up
the timer on both paths, and swallows the driver error so hostnames and secret
ids never reach a public endpoint.
[`src/http/handler.ts:332-371`](../src/http/handler.ts) caches the outcome for a
few seconds and collapses concurrent polls into one round trip, so a burst of
masthead requests costs one query. `ok` now follows the probe, and the frontend
already renders `ok:false` as degraded.
[`.github/workflows/live-availability.yml`](../.github/workflows/live-availability.yml)
adds an external canary on `cron: "9,39 * * * *"` that probes `/api/health`,
`/api/proof` and `/api/audit` with no credentials, exactly as a judge would, and
treats `/api/proof` as the hard gate.

Neither is live, because the release pipeline is red. See OPS-3.

**The canary already earned its place.** Its first scheduled execution,
[run 30928730030](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30928730030)
at 16:21 UTC on the review date, failed at the step "Probe live health and proof
endpoints". That is the correct result and the only detection in the whole
system that worked. It is worth being precise about why it worked when the
CloudWatch alarms did not: the canary runs from `main` on GitHub's schedule, so
it does not depend on the broken deployment path, and it asserts on the
response body rather than on reachability.

**Remediation still outstanding.**

1. Restore the cluster, or move to a plan whose limit is not a hard stop. (L,
   needs a spend decision.)
2. Ship the merged health probe and canary by unblocking the release pipeline.
   (M, see OPS-3.)
3. Give the data plane a degraded mode. See REL-3. (M.)

**Residual risk accepted.** Until step 1 completes, the demo has no data plane.
The repository states this plainly in [`docs/DEMO_URL.md`](./DEMO_URL.md) rather
than hiding it, which is the right call, and every measurement cited elsewhere
in the docs is pinned to a completed workflow run that remains viewable
regardless of cluster state.

## REL-2 — HIGH — The request budget is shared, so one caller can drain it for everyone

**Lens:** [AGENTREL02-BP02](https://docs.aws.amazon.com/wellarchitected/latest/agentic-ai-lens/agentrel02-bp02.html)
limit agent permissions to minimum required access;
[AGENTCOST01](https://docs.aws.amazon.com/wellarchitected/latest/agentic-ai-lens/agentcost01.html)
reasoning and execution cost optimization.

Three limits bound the workload, and all three are global:

- [`aws/template.yaml:112-121`](../aws/template.yaml) — `ApiThrottleRate` 5 rps,
  `ApiThrottleBurst` 10, applied at `DefaultRouteSettings`
  ([`:327-330`](../aws/template.yaml)), which is a per-stage budget.
- [`aws/template.yaml:103-111`](../aws/template.yaml) —
  `ReservedConcurrentExecutions` 5, a per-function budget.

None of them is per-caller. There is no API key, no usage plan, no per-IP rate
limit, and (see SEC-1) no WAF rate-based rule. A single client that stays under
5 rps consumes the entire allowance indefinitely, and every request behind it
spends CockroachDB Request Units and, on `/api/recall`, Bedrock tokens.

This is the mechanism behind REL-1. The throttle protected the Lambda from
overload and protected nothing else. The lens frames this under bounded
autonomy: the constraint has to bind the thing you actually cannot afford to
lose, which here is the memory store's consumption allowance, not the
function's concurrency.

**Remediation.** A rate-based WAF rule keyed on client IP in front of
CloudFront, sized well below the RU budget, plus a per-caller token bucket for
`/api/recall` specifically since it is the only route that bills inference. (M.
The WAF template already exists at [`aws/edge-waf.yaml`](../aws/edge-waf.yaml);
it has never been deployed.)

**Residual risk if not fixed.** The demo is publicly reachable with no
authentication by design, because judges must be able to use it. That design
choice is defensible. Pairing it with a shared budget and no per-caller limit is
not.

## REL-3 — MEDIUM — There is no degraded mode when memory is unavailable

**Lens:** [AGENTREL03-BP04](https://docs.aws.amazon.com/wellarchitected/latest/agentic-ai-lens/agentrel03-bp04.html)
implement graceful degradation for memory and state operations.

When the memory store is unreachable, `/api/proof` and `/api/audit` return a
bare 500. The lens asks for partial functionality under adverse conditions. A
memory-backed agent that cannot reach its memory can still return a structured,
cached, or explicitly empty answer that tells the caller the memory is
unavailable, rather than a server error that a CDN and a browser both treat as
a fault.

The narrator layer already demonstrates the right instinct in a different
context: when recall returns nothing,
[`src/agents/narrator.ts:120-130`](../src/agents/narrator.ts) returns a
no-evidence grounding trace instead of inventing an answer. The database layer
has no equivalent.

**Remediation.** Map a connection failure to a 503 with a typed body carrying
the same `dependencies`/`checks` shape the health endpoint now produces, so the
Control Room can render a real degraded state and a monitor can distinguish
"memory is down" from "the service is broken". (M.)

## REL-4 — MEDIUM — RPO is capped at 24 hours by choice, and no restore has ever been proven

**Lens:** [AGENTREL03-BP03](https://docs.aws.amazon.com/wellarchitected/latest/agentic-ai-lens/agentrel03-bp03.html)
comprehensive state management and checkpoint-based recovery.

CockroachDB Cloud Basic takes managed backups every 24 hours with 30-day
retention. The cadence is not configurable and restore is cluster-level only.
So the managed path cannot beat a 24-hour RPO.

That is where most reviews would stop and call it a platform limit. It is not
one. CockroachDB Cloud Basic
[supports self-managed backups to your own bucket](https://www.cockroachlabs.com/docs/cockroachcloud/managed-backups-basic).
The 24-hour ceiling is therefore an accepted choice, not a constraint, and it
should be recorded as a choice.

Separately, no restore has ever completed successfully.
[`cockroach-restore-drill.yml`](../.github/workflows/cockroach-restore-drill.yml)
has two runs in its history, both on 2026-07-31, both failed. There is no
successful run. An untested restore is a hypothesis.

**Remediation.** Either add scheduled self-managed backups to S3 and state the
resulting RPO, or record 24 hours as an approved objective in
[`docs/operations/SLO_AND_OWNERSHIP.md`](./operations/SLO_AND_OWNERSHIP.md)
with the reason. Then make the drill pass once, against a scratch cluster, and
link the run. (M for the drill, L if self-managed backups are adopted.)

**Residual risk accepted.** For a demo whose entire corpus is nine synthetic
memories that a seed script can rebuild, a 24-hour RPO is genuinely fine. The
problem is that this reasoning is nowhere written down, so a judge cannot tell
the difference between a considered choice and an oversight.

## REL-5 — LOW — Single region, no memory-store failover

**Lens:** [AGENTREL03-BP02](https://docs.aws.amazon.com/wellarchitected/latest/agentic-ai-lens/agentrel03-bp02.html).

Everything regional lives in `eu-west-1` and
[`docs/operations/SLO_AND_OWNERSHIP.md:15-23`](./operations/SLO_AND_OWNERSHIP.md)
fixes that deliberately, forbidding `us-west-2` outright and requiring a
separate architecture decision plus cost approval for any additional region.
The boundary is explicit and enforced, which is more than most entries manage.

At demo scale this is correct and cheap. It is recorded here so the accepted
risk is visible: a regional CockroachDB Cloud failure takes the memory with it,
and there is no failover.

**Remediation.** None recommended. Keep the boundary. (S, documentation only.)

---

# Operational excellence

Lens questions AGENTOPS01 to AGENTOPS07.

## OPS-1 — HIGH — The alarm notification control plane cannot be deployed

**Lens:** [AGENTOPS05](https://docs.aws.amazon.com/wellarchitected/latest/agentic-ai-lens/agentops05.html)
observability and monitoring;
[AGENTOPS07-BP01](https://docs.aws.amazon.com/wellarchitected/latest/agentic-ai-lens/agentops07-bp01.html)
automated response and recovery mechanisms.

Four production CloudWatch alarms exist and every one of them notifies nobody.

```
$ aws cloudwatch describe-alarms --region eu-west-1 --alarm-name-prefix archon-memory
archon-memory-production-api-5xx                    ActionsEnabled: true  AlarmActions: []
archon-memory-production-lambda-canary-errors-v23   ActionsEnabled: true  AlarmActions: []
archon-memory-production-lambda-errors              ActionsEnabled: true  AlarmActions: []
archon-memory-production-lambda-throttles           ActionsEnabled: true  AlarmActions: []
```

`aws sns list-topics --region eu-west-1` returns 103 topics. None of them
belongs to this application. The template is honest about the mechanism:
[`aws/template.yaml:122-125`](../aws/template.yaml) declares `AlarmTopicArn`
with an empty default and
[`aws/template.yaml:615-618`](../aws/template.yaml) makes every `AlarmActions`
block conditional on it, so an empty parameter produces an alarm with no
action.

The interesting part is why the topic is missing, and this is where a review of
the running system finds something a source audit cannot. The control plane was
attempted twice on the review date and rolled back both times.

```
$ aws cloudformation describe-stack-events --region eu-west-1 \
    --stack-name archon-memory-delivery-bootstrap

2026-08-04T12:22:08Z  CREATE_FAILED  ProductionAlarmTopicPolicy
  "Invalid parameter: Policy statement action out of service scope!
   (Service: Sns, Status Code: 400)"
2026-08-04T12:22:08Z  CREATE_FAILED  StagingAlarmTopicPolicy      (same error)
2026-08-04T12:22:09Z  UPDATE_ROLLBACK_IN_PROGRESS
  failed to create: [ProductionAlarmTopicPolicy, AlarmNotificationsKeyAlias,
   StagingAlarmRoutingDrillAlarm, StagingAlarmTopicPolicy,
   StagingAlarmArchiveQueue, StagingAlarmRoutingDrillQueue,
   ProductionAlarmArchiveQueue]
2026-08-04T12:23:17Z  UPDATE_ROLLBACK_COMPLETE
```

An earlier attempt at 11:07 UTC failed the same way. The rollback deleted
`ProductionAlarmTopic`, `StagingAlarmTopic`, `AlarmNotificationsKey` and both
archive queues, so the stack is now in `UPDATE_ROLLBACK_COMPLETE` and the
account has no alarm topic at all.

The two most recent infrastructure commits on `main` are attempts at exactly
this fix: `38f129e` "give each alarm topic its own SNS policy" and `93dfa73`
"enumerate the SNS actions each alarm topic policy denies". Both are merged.
Both are CI-green. Neither works against the real SNS API. SNS rejects at least
one action in the enumerated deny list as out of scope for a topic policy, and
CloudFormation surfaces that only at create time.

That gap between a green repository and a service that will not come up is the
single clearest argument for doing this kind of review at all.

**Remediation.** Narrow each topic policy's `Action` list to actions SNS accepts
in a topic resource policy, then re-run the bootstrap update and confirm the
topics exist before wiring `AlarmTopicArn`. Note that the failing statements are
deny statements, so the safe fix is to shrink the enumerated action set, not to
broaden it. (S to fix, M including redeploy and verification.)

**Not implemented here.** This review touches `docs/**` only.

## OPS-2 — HIGH — The alarms cannot express a sustained outage

**Lens:** [AGENTOPS05-BP02](https://docs.aws.amazon.com/wellarchitected/latest/agentic-ai-lens/agentops05-bp02.html)
monitor agent behavior patterns and detect anomalies.

Every archon alarm is configured the same way
([`aws/template.yaml:598-714`](../aws/template.yaml)):

```yaml
Period: 60
EvaluationPeriods: 1
DatapointsToAlarm: 1
Threshold: 1
TreatMissingData: notBreaching
```

On a public demo with almost no organic traffic, that combination produces a
sawtooth rather than an outage signal. One error in one minute trips the alarm.
One minute with no traffic clears it, because missing data is treated as not
breaching. A two-day hard outage therefore never rendered as a sustained ALARM.

Alarm history from the review date, `archon-memory-production-api-5xx`:

```
2026-08-04T13:15:46Z  OK    → ALARM
2026-08-04T13:27:46Z  ALARM → OK
2026-08-04T13:28:46Z  OK    → ALARM
2026-08-04T13:36:46Z  ALARM → OK
2026-08-04T13:37:46Z  OK    → ALARM
2026-08-04T13:43:46Z  ALARM → OK
2026-08-04T16:22:46Z  OK    → ALARM
2026-08-04T16:29:46Z  ALARM → OK
```

Ten transitions in one day on a service that has been continuously broken for
two. `archon-memory-production-lambda-errors` and
`...-lambda-canary-errors-v23` show the same pattern within seconds.

The 16:22 transition is worth reading closely. The canary
([run 30928730030](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30928730030))
started at 16:21:29 and failed at 16:22:29. The alarms tripped at 16:22:46,
16:23:06 and 16:23:29, then cleared at 16:29:06 to 16:29:46. The canary's own
probe traffic is what generated the 500s that moved the alarms, and once it
stopped, the missing-data rule reset them. The only traffic the system gets is
its own monitoring, and the alarm design converts that into noise.

So even after OPS-1 is fixed and a topic exists, this configuration would page
on single errors and go quiet during an outage.

**Remediation.** Split the intent. Keep a fast error alarm but require several
datapoints, and add a separate availability alarm that treats missing data as
breaching so silence is itself a signal. The lens's own framing helps here:
behavioural monitoring for a stochastic system should alarm on a pattern over a
window, not on a single sample. (S for the template change, M with deploy and a
verified transition.)

## OPS-3 — HIGH — The release pipeline is red, so remediated code cannot reach production

**Lens:** [AGENTOPS03](https://docs.aws.amazon.com/wellarchitected/latest/agentic-ai-lens/agentops03.html)
agent lifecycle and deployment processes.

Every push to `main` on the review date failed to deploy.

| Run | Commit | Result |
|---|---|---|
| [30927005947](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30927005947) | `25c8f443` | failure |
| [30924341652](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30924341652) | `3fbba06c` | failure |
| [30922902170](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30922902170) | `33978fd5` | failure |
| [30911932156](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30911932156) | `93dfa73d` | failure |
| [30908418294](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30908418294) | `e371acc7` | failure |
| [30905193588](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30905193588) | `38f129e0` | failure |

All six fail in the first job, "Validate Deploy AWS source CI", at the step
"Require successful exact-SHA Supply Chain evidence". Every later job is
skipped, including staging deploy and production promotion. The upstream cause
is [supply-chain run 30927000378](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30927000378),
which fails at "Create fail-closed exact-SHA release receipt" inside the job
"Bind exact-SHA supply-chain release evidence". The four gates before it
(infrastructure policy, shell and workflow policy, ZIP-content and SBOM,
trusted SARIF) all pass.

The last successful deploy is
[run 30577752661](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30577752661)
at `0b25d5f1` on 2026-07-30. That commit is what serves the judge URL today.

This is why REL-1's remediation is merged but not live. The fail-closed
behaviour itself is correct and worth keeping; a release gate that refuses to
promote without exact-SHA supply-chain evidence is a good gate. The problem is
that it has been failing for a full day of commits and nothing surfaces that as
an operational condition rather than a per-run red check.

**Remediation.** Fix the receipt step, then confirm a deploy reaches production
and the health probe answers `dependencies:"ready"` or `"degraded"` rather than
`"unchecked"`. (M.)

**Second blocking gate to expect.** Even with supply chain fixed, the deploy
will stop again at the WAF gate. See SEC-1.

## OPS-4 — MEDIUM — The deployed build and `main` have drifted, and nothing detects it

**Lens:** [AGENTOPS02](https://docs.aws.amazon.com/wellarchitected/latest/agentic-ai-lens/agentops02.html)
prompt and configuration lifecycle management.

The live health response reports `"access":"public-read-only"`. `main` reports
`"access":"canonical-read-only+isolated-synthetic-resolution-write"`
([`src/http/handler.ts:394`](../src/http/handler.ts)). The deployed baseline
predates the human-gated resolution loop entirely. The live body also has no
`checks` object and no `resolutionSandbox` object, both of which `main`
produces.

So one of the entry's headline capabilities, the memory resolution loop, exists
in source, is tested, is documented, and is not running at the URL a judge will
open. Nothing in the system reports that divergence. There is a deployment
receipt mechanism ([`aws/create-deployment-receipt.mjs`](../aws/create-deployment-receipt.mjs))
and the Lambda carries `RELEASE_COMMIT_SHA`
([`aws/template.yaml:372`](../aws/template.yaml)), so the raw material for a
drift check is present. It is simply not compared against `main`.

**Remediation.** Have the availability canary read `release.commitSha` from
`/api/proof` and warn when it is not an ancestor of `main`. (S, since the canary
already exists and already parses the proof body.)

## OPS-5 — MEDIUM — No owner and no objective is assigned

**Lens:** [AGENTOPS01](https://docs.aws.amazon.com/wellarchitected/latest/agentic-ai-lens/agentops01.html)
operational practices, roles and success criteria.

[`docs/operations/SLO_AND_OWNERSHIP.md:25-47`](./operations/SLO_AND_OWNERSHIP.md)
lists five responsibilities (workload, operations, security, FinOps,
sustainability) all "Unassigned", and five objectives (availability, p95
latency, error rate, RTO, RPO) all "Pending".

The document is careful to call these deliberate placeholders rather than
missing documentation, and it is right that inventing an owner would be worse.
But the consequence is concrete rather than clerical: with no availability
objective there is no error budget, so nothing defines how long the current
outage is allowed to last, and with no named responder there is nobody for the
alarm topic to notify even once OPS-1 is fixed.

**Remediation.** Assign at least the workload and operations owner, and adopt
one availability objective, even a modest one. The CI thresholds in
[`docs/BENCHMARK.md`](./BENCHMARK.md) (p95 under 1500 ms, recall@1 at least
0.99, error rate under 1%) are a reasonable starting point and are already
measured. (S, but it is a human decision, not an edit.)

## OPS-6 — LOW — The one working detector has no notification route

**Lens:** [AGENTOPS05](https://docs.aws.amazon.com/wellarchitected/latest/agentic-ai-lens/agentops05.html).

The availability canary is the only thing that correctly identified the outage.
Its failure notifies whoever GitHub notifies for a failed scheduled workflow in
that repository, which is a default, not a designed escalation path. There is no
on-call route, no severity, and no acknowledgement.

**Remediation.** Once an alarm topic exists (OPS-1) and an operations owner is
named (OPS-5), route the canary failure to the same destination as the
CloudWatch alarms so there is one place to look. (S.)

---

# Security

Lens questions AGENTSEC01 to AGENTSEC09. This pillar is the strongest part of
the workload and the review says so, with two named residual risks.

## SEC-1 — HIGH — No WAF exists in any region, and the deploy gate that requires one has never been satisfied

**Lens:** [AGENTSEC08](https://docs.aws.amazon.com/wellarchitected/latest/agentic-ai-lens/agentsec08.html)
secure agent inputs and outputs; [AGENTSEC03](https://docs.aws.amazon.com/wellarchitected/latest/agentic-ai-lens/agentsec03.html)
identity and permission management.

```
$ aws wafv2 list-web-acls --scope CLOUDFRONT --region us-east-1   → (empty)
$ aws wafv2 list-web-acls --scope REGIONAL   --region eu-west-1   → (empty)
```

No WebACL exists. [`aws/edge-waf.yaml`](../aws/edge-waf.yaml) defines one, and
[`.github/workflows/edge-controls.yml`](../.github/workflows/edge-controls.yml)
would deploy it, but that workflow has ten runs in its history, five cancelled
and five failed, and none successful. The most recent failure
[run 30903520076](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30903520076)
passed its authorization gate and then failed inside "Apply edge controls" at
"Load exact existing edge plan", so the blocker is the apply path itself rather
than the approval in front of it.

The deployment contract does genuinely require the ARN.
[`.github/workflows/deploy-aws.yml:2557-2601`](../.github/workflows/deploy-aws.yml)
reads `WebAclArn` from the edge stack outputs and asserts it matches
`^arn:aws:wafv2:us-east-1:<account>:global/webacl/...`, and the deploy fails if
it does not. So the gate is real, not aspirational. It has simply never passed,
and because the supply-chain gate fails first (OPS-3), it has not even been
reached recently.

Meanwhile [`aws/template.yaml:126-136`](../aws/template.yaml) accepts an empty
`CloudFrontWebAclArn` and attaches no WebACL in that case. The comment explains
the reasoning honestly: it lets the application stack exist before the edge
control plane does. The result today is a public, unauthenticated,
model-invoking API with no WAF and, per REL-2, no per-caller limit.

**Remediation.** Get [`edge-controls.yml`](../.github/workflows/edge-controls.yml)
to complete once, then let the deploy gate bind the ARN. Add a rate-based rule
sized below the CockroachDB RU budget while you are there, which also closes
REL-2. (M.)

## SEC-2 — MEDIUM — The RLS escape hatch that makes vector search plannable

**Lens:** [AGENTSEC01-BP01](https://docs.aws.amazon.com/wellarchitected/latest/agentic-ai-lens/agentsec01-bp01.html)
implement memory isolation and integrity controls.

This one is a deliberate trade-off and it deserves to be named rather than
buried.

CockroachDB v26.2 treats row-level security as an optimizer barrier. A forced
vector index below that barrier cannot be rewritten into a `VectorSearch`
operator, so RLS and index-accelerated ANN recall are mutually exclusive on the
base table. The schema resolves this with two dematerialized serving views
([`src/db/schema.sql:1061-1119`](../src/db/schema.sql)) declared
`WITH (security_invoker = false)` and owned by `archon_public_memory_view_owner`,
a `NOLOGIN BYPASSRLS` role.

The containment around it is careful. The owner role has no members and no login.
The runtime principals stay `NOBYPASSRLS`
([`src/db/schema.sql:400-405`](../src/db/schema.sql)). The views hard-code the
fixed scope (`tenant_id = 'public-demo' AND company = 'Helios SA' AND status =
'active'`), so the bypass is bounded by the view definition rather than by the
caller. `CREATE` on the public schema is granted for the ownership transfer and
revoked immediately afterwards ([`:1114-1119`](../src/db/schema.sql)).

But the residual is real: a change to those view definitions moves data across a
tenant boundary without tripping any RLS policy, because the policies are not in
the path. The security of the recall path rests on the view text, and the view
text is not covered by the same restrictive-policy machinery as everything else.

**Remediation.** Add a proof query that asserts the exact view definitions and
the owner's role options, in the same style as the existing index-definition
fingerprint in [`src/db/proof.ts`](../src/db/proof.ts), so a drift in the view
text fails a check instead of silently widening scope. (S to M.)

**Residual risk accepted.** The trade-off itself is correct. Losing
index-accelerated recall would gut the entry's core capability, and the
alternative (RLS on the base table, sequential scan) does not scale. Keep the
hatch, watch the door.

## SEC-3 — MEDIUM — The human gate is a role assertion, not an authentication

**Lens:** [AGENTSEC03-BP01](https://docs.aws.amazon.com/wellarchitected/latest/agentic-ai-lens/agentsec03-bp01.html)
strong authentication for agent identities;
[AGENTREL02-BP05](https://docs.aws.amazon.com/wellarchitected/latest/agentic-ai-lens/agentrel02-bp05.html)
tiered human oversight and approval workflows.

The memory resolution loop requires a `financial-controller` decision before a
corrected memory supersedes a prior one, enforced in the database by a check
constraint ([`src/db/schema.sql:335-342`](../src/db/schema.sql)) and by the
`SECURITY DEFINER` transition function
([`src/db/schema.sql:789-955`](../src/db/schema.sql)). Nobody can approve
without producing a SHA-256 receipt, the decision is idempotent on a unique
key, and the loop never touches canonical memory.

The system reports the limitation itself:
[`src/http/handler.ts:561`](../src/http/handler.ts) sets
`identityAssurance: "fixed-demo-role-assertion-not-authenticated"`. So the
human in "human-in-the-loop" is any anonymous caller holding a session bearer
token. For a public demo with a synthetic sandbox and no external side effects
that is a defensible choice, and declaring it in the API response is exactly
right.

It is recorded as MEDIUM rather than LOW because the same code path is the
template for the real product, where an unauthenticated approval would be a
serious control failure.

**Remediation.** None for the demo. For any non-synthetic use, bind the decision
to an authenticated identity and record that identity in the receipt canonical
form. (L, and out of scope for the hackathon.)

## SEC-4 — MEDIUM — Grounding is enforced but ungrounded output is not measured

**Lens:** [AGENTSEC01-BP03](https://docs.aws.amazon.com/wellarchitected/latest/agentic-ai-lens/agentsec01-bp03.html)
monitor for hallucination propagation.

The narrator does the hard part properly. When recall returns nothing it emits a
no-evidence trace rather than an answer
([`src/agents/narrator.ts:120-130`](../src/agents/narrator.ts)). When a draft
fails a deterministic grounding check it rewrites from scratch with a repair
prompt ([`:101-103`, `:166-186`](../src/agents/narrator.ts)), and if that still
fails it falls back to a canonical extractive answer and then to a
deterministic grounded answer ([`:186-200`](../src/agents/narrator.ts)). Numeric
lexemes from the cited memories bound what the answer may assert. This is a
real guard against a hallucinated number entering a financial narrative, and it
is better than most entries will have.

What is missing is the monitoring half of the best practice. Nothing counts how
often the repair path fires, how often the extractive fallback is used, or what
the ungrounded rate looks like in production. Those are the leading indicators
that the model or the corpus has drifted.

**Remediation.** Emit the grounding outcome as a structured log field and a
CloudWatch metric, then add it to the dashboard
([`aws/template.yaml:716-778`](../aws/template.yaml)). (S.)

## SEC-5 — LOW — Memory isolation and integrity are genuinely well built

**Lens:** [AGENTSEC01-BP01](https://docs.aws.amazon.com/wellarchitected/latest/agentic-ai-lens/agentsec01-bp01.html).

Recorded as a finding so the review is not only a list of gaps, and because the
lens question this satisfies is the one the workload is about.

- RLS is enabled and forced on every memory table, including canonical
  `agent_memory` ([`src/db/schema.sql:1003-1004`](../src/db/schema.sql)) and all
  five sandbox tables.
- Policies come in permissive and restrictive pairs, so a permissive policy
  alone cannot widen access
  ([`src/db/schema.sql:981-1001`](../src/db/schema.sql)).
- The runtime principal receives no direct `INSERT`, `UPDATE` or `DELETE` on any
  relation. Mutation is only reachable through two `SECURITY DEFINER` functions
  with a fixed `pg_catalog` search path and schema-qualified bodies
  ([`src/db/schema.sql:687-968`](../src/db/schema.sql)).
- `REVOKE CREATE ON SCHEMA public FROM PUBLIC`
  ([`src/db/schema.sql:398`](../src/db/schema.sql)) removes the ambient
  object-creation path that would otherwise let a caller shadow a qualified name.
- Writes are idempotent on `(tenant_id, embed_model, idempotency_key)`
  ([`src/db/schema.sql:1135-1136`](../src/db/schema.sql)), so a replay cannot
  duplicate a memory.
- Embedding-model isolation is part of the key, so vectors from different
  models can never be compared.

**Remediation.** None. Do not regress this.

## SEC-6 — LOW — Input validation is bounded and fails closed

**Lens:** [AGENTSEC08](https://docs.aws.amazon.com/wellarchitected/latest/agentic-ai-lens/agentsec08.html).

[`src/http/handler.ts:53-71`](../src/http/handler.ts) bounds question length,
result limit and minimum score, and an invalid deployment configuration throws
at cold start rather than silently disabling a guard. `company` is not
caller-selectable ([`:133-145`](../src/http/handler.ts)), `kind` is checked
against an allowlist, and malformed input returns 400 rather than throwing. The
CloudFront response headers policy
([`aws/template.yaml:219-266`](../aws/template.yaml)) sets a restrictive CSP
with `default-src 'self'`, `object-src 'none'` and `frame-ancestors 'none'`,
plus HSTS with preload and the three cross-origin isolation headers.

The gap is narrow: there is no explicit prompt-injection filter on the question
before it reaches the narrator. In practice the grounding guard (SEC-4) limits
the blast radius, because an injected instruction cannot make the model assert a
number that is not in the cited memories. Worth noting rather than fixing.

**Remediation.** Optional. Consider Bedrock Guardrails on the narration call if
the scope ever widens beyond a fixed synthetic corpus. (M.)

---

# Performance efficiency

Lens questions AGENTPERF01 to AGENTPERF07.

## PERF-1 — MEDIUM — No production latency objective exists

**Lens:** [AGENTPERF01](https://docs.aws.amazon.com/wellarchitected/latest/agentic-ai-lens/agentperf01.html)
strategic performance planning and measurement.

CI measures recall latency and gates on p95 under 1500 ms
([`docs/BENCHMARK.md`](./BENCHMARK.md), most recent successful run
[30732311916](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30732311916)).
That is a bounded CI workload, and the repository is explicit that it is not a
production SLO. The production objective remains "Pending".

The hosted measurement path exists
([`hosted-load-evidence.yml`](../.github/workflows/hosted-load-evidence.yml))
and has never run. So there is no measured hosted p95 at all, and this review
declines to invent one.

**Remediation.** Run the hosted load evidence workflow once against a restored
cluster and adopt the observed p95 as the objective. (M, blocked on REL-1.)

## PERF-2 — MEDIUM — Throughput is capped low and no capacity forecast exists

**Lens:** [AGENTPERF07](https://docs.aws.amazon.com/wellarchitected/latest/agentic-ai-lens/agentperf07.html)
multi-tenancy and resource optimization;
[AGENTREL06](https://docs.aws.amazon.com/wellarchitected/latest/agentic-ai-lens/agentrel06.html).

Reserved concurrency is 5 ([`aws/template.yaml:103-111`](../aws/template.yaml)),
memory is 512 MB ([`:98-102`](../aws/template.yaml)), and the connection pool
holds a single connection with a 300-second lifetime
([`aws/template.yaml:374-376`](../aws/template.yaml)). The comment at
[`:104-108`](../aws/template.yaml) reasons the number out from the Control Room's
concurrent loads, which is more thought than most defaults get.

The consequence is that the ceiling is about five in-flight requests, a sixth
caller is throttled, and there is no forecast connecting that number to expected
judge traffic. A demo linked from a public submission page can plausibly see
more than five concurrent visitors.

**Remediation.** Model expected concurrency for the judging window and either
raise reserved concurrency or accept the throttle explicitly. Note that raising
it without fixing REL-2 raises the RU burn rate too, so the two changes belong
together. (S to change, M to reason about properly.)

## PERF-3 — LOW — Memory retrieval is designed the way the lens describes

**Lens:** [AGENTPERF03](https://docs.aws.amazon.com/wellarchitected/latest/agentic-ai-lens/agentperf03.html)
memory, context, and RAG optimization.

Recorded as a strength. Four C-SPANN vector indexes exist
([`src/db/schema.sql:1021-1051`](../src/db/schema.sql)): one global, and three
prefix indexes keyed on exactly the columns production recall
equality-constrains (`tenant_id`, `embed_model`, `status`, then `company`, then
`kind`). So ANN work stays inside the security and model space the query is
allowed to see, rather than filtering after the fact. The reasoning for
indexing globally as well is written down in the schema comment
([`:1011-1020`](../src/db/schema.sql)) and rests on an `EXPLAIN` verification,
not on assumption.

`VECTOR(1024)` matches Titan Embed v2's output dimensionality and the two are
kept in lockstep by `EMBED_DIM`
([`src/memory/embeddings.ts:17-19`](../src/memory/embeddings.ts)).

**Remediation.** None.

---

# Cost optimization

Lens questions AGENTCOST01 to AGENTCOST07. See also the
[Generative AI Lens](https://docs.aws.amazon.com/wellarchitected/latest/generative-ai-lens/generative-ai-lens.html)
(2025-11-19) for token-level cost guidance, which is separate from this lens and
still applies to the Bedrock spend.

## COST-1 — HIGH — The budgets that actually bind have no alarm

**Lens:** [AGENTCOST05](https://docs.aws.amazon.com/wellarchitected/latest/agentic-ai-lens/agentcost05.html)
cost visibility and attribution;
[AGENTOPS07](https://docs.aws.amazon.com/wellarchitected/latest/agentic-ai-lens/agentops07.html)
consumption monitoring.

Measured AWS spend for this project is roughly $3 a month. AWS is not the
binding constraint. The two constraints that are binding are CockroachDB Cloud
Request Units and Bedrock tokens, and neither has a spend alarm, a consumption
metric, or a threshold.

The only budgets in the account are:

```
$ aws budgets describe-budgets --account-id "$AWS_ACCOUNT_ID"
High Monthly Cost Budget Alert!!!   3000.0  MONTHLY
Monthly Cost Budget Alert           2000.0  MONTHLY
```

Both are account-wide and shared with unrelated workloads in the same account
(the `fbx-*` and `any-config-*` stacks). Neither is scoped to this project, and
neither would move if this workload's RU consumption doubled.

This is not a theoretical finding. Unmonitored RU consumption is what took the
service down on 2026-08-02. The lens puts consumption monitoring in
AGENTOPS07 alongside operational recovery precisely because for agentic
workloads, running out of budget is an availability event, not just a finance
event. That is exactly what happened here.

[`docs/finops/COST_MODEL.md`](./finops/COST_MODEL.md) is careful and refuses to
publish a total until billing-authorized evidence exists, which is the right
discipline. But it explicitly excludes CockroachDB Cloud and inference from its
$26.00 fixed envelope, so the one number that is committed is the one that could
not have prevented the outage.
[`finops-controls.yml`](../.github/workflows/finops-controls.yml) has never run.

**Remediation.** Add a CockroachDB Cloud RU consumption check to the availability
canary, alarming well before the hard limit, and a cost-scoped AWS budget with a
tag filter on `Application=archon-memory` covering Bedrock. Emit token counts
per request so Bedrock spend is attributable. (M.)

## COST-2 — MEDIUM — Inference cost is not attributed per request

**Lens:** [AGENTCOST02](https://docs.aws.amazon.com/wellarchitected/latest/agentic-ai-lens/agentcost02.html)
model invocation and token cost optimization;
[AGENTCOST05-BP01](https://docs.aws.amazon.com/wellarchitected/latest/agentic-ai-lens/agentcost05-bp01.html)
agent-level reasoning cost tracking and attribution.

Each `/api/recall` triggers one Titan embedding and at least one Claude
completion, and up to three completions when the grounding repair path fires
(SEC-4). Nothing records input or output token counts, so the cost of a recall
varies by a factor of roughly three with no visibility into which path was
taken.

[`docs/finops/COST_MODEL.md`](./finops/COST_MODEL.md) defines the right unit
already, "one successful recall", and lists the allocation inputs. The
measurement is what is missing.

Two design choices already limit the damage and deserve credit. The health
endpoint reports inference configuration state only and never calls the model
([`src/http/handler.ts:410-419`](../src/http/handler.ts)), so a public health
check is not a free way to bill someone. The availability canary deliberately
omits `POST /api/recall` for the same reason, and says so in a comment.

**Remediation.** Record Bedrock token usage from the SDK response into the
structured log, then aggregate into a metric. (S.)

## COST-3 — LOW — Canonical memory has no retention policy

**Lens:** [AGENTCOST03-BP03](https://docs.aws.amazon.com/wellarchitected/latest/agentic-ai-lens/agentcost03-bp03.html)
cost-optimized state persistence and lifecycle management.

Row-level TTL is applied to the sandbox session tables
([`src/db/schema.sql:219-222`](../src/db/schema.sql), `ttl_job_cron = '0 */4 * *
*'`), which is a genuinely nice use of a CockroachDB feature for agent
forgetting. Canonical `agent_memory` has no TTL and no archival tier. It carries
a `status` lifecycle (`active` / `superseded` / `retracted`) but superseded rows
are never moved or expired.

At nine memories this costs nothing. The finding is about the pattern, not the
current bill: a memory store that only grows has an unbounded cost curve, and
the lens asks for tiering.

**Remediation.** Define a retention rule for `superseded` and `retracted`
memories before the corpus is real. (S to decide, M to implement.)

---

# Sustainability

Lens questions AGENTSUS01 to AGENTSUS03. This is the thinnest pillar in the
review and the review is not going to pretend otherwise.

## SUS-1 — MEDIUM — Sustainability is scaffolded but not measured

**Lens:** [AGENTSUS02](https://docs.aws.amazon.com/wellarchitected/latest/agentic-ai-lens/agentsus02.html)
resource right-sizing.

[`docs/sustainability/BASELINE_AND_TARGETS.md`](./sustainability/BASELINE_AND_TARGETS.md),
[`aws/measure-sustainability-intensity.sh`](../aws/measure-sustainability-intensity.sh)
and
[`sustainability-intensity-evidence.yml`](../.github/workflows/sustainability-intensity-evidence.yml)
all exist. The workflow has one run in its history and it failed. There is no
baseline, no measured intensity, and no assigned sustainability owner (OPS-5).

The design is right, in that it refuses to publish a number it has not measured
and it reuses the hosted-load receipt as its functional-unit denominator rather
than inventing a denominator. The execution has not happened.

**Remediation.** Blocked behind REL-1 and PERF-1, since the intensity metric
needs a successful hosted-load receipt as its denominator. Leave it. (M, but
sequenced last.)

## SUS-2 — LOW — Reuse is real

**Lens:** [AGENTSUS01](https://docs.aws.amazon.com/wellarchitected/latest/agentic-ai-lens/agentsus01.html)
resource reusability.

One recall core serves both the Lambda adapter and the plain node HTTP server
used as the load-test target ([`src/http/handler.ts:1-13`](../src/http/handler.ts)),
so the demo URL, the benchmark and the offline tests all exercise the same code
path with the same env-selected embedder and narrator. Offline runs swap in
deterministic fakes rather than a parallel implementation. That is the reuse
AGENTSUS01 asks for, and it also means CI results describe the deployed path
rather than a lookalike.

**Remediation.** None.

---

# Residual risks the team is accepting

Stated plainly so a reader does not have to infer them.

| Risk | Why it is accepted | Would change if |
|---|---|---|
| 24-hour RPO on the memory store | The corpus is nine synthetic memories rebuilt by a seed script | Any real customer data lands in `agent_memory` |
| Single region, no memory failover | Cost, and an explicit region boundary the team enforces | An availability objective above roughly 99% is adopted |
| `BYPASSRLS` view owner in the recall path | RLS and index-accelerated ANN are mutually exclusive on this engine version; losing ANN would gut the product | The engine gains RLS-transparent vector planning |
| Unauthenticated human approval in the resolution sandbox | Synthetic scope, TTL-expiring, no external side effects, no canonical write | The loop is pointed at real memory |
| No prompt-injection filter | The deterministic grounding guard bounds what an injected instruction can make the model assert | The corpus stops being fixed and synthetic |
| Reserved concurrency of 5 | Deliberate money-safety bound on a public demo | Judge traffic exceeds it, or REL-2 is fixed first |

# What to fix first

The dependencies matter more than the severities here, because several fixes are
blocked behind others.

1. **OPS-3**, the supply-chain receipt step. Nothing else can ship until deploys
   work. Everything merged since 2026-07-30 is stranded behind it.
2. **REL-1**, restore the cluster. The demo has no data plane until this
   happens, and PERF-1 and SUS-1 are both blocked on it.
3. **OPS-1**, the SNS topic policy. One action list, and alarms start notifying.
4. **OPS-2**, alarm evaluation periods. Without this, step 3 produces noise
   instead of signal.
5. **SEC-1 and REL-2 together**, the WAF and a per-caller rate limit. This is
   what stops the outage recurring, and the WAF is also a blocking deploy gate.

Items 1 to 4 are hours of work each. Item 5 is the one that needs a deployment
that has never succeeded.

# What this review could not verify

- **The CockroachDB RU exhaustion itself.** The 500s, the driver message, and
  the timeline are all consistent with it, and the repository records it in
  [`docs/DEMO_URL.md`](./DEMO_URL.md), but no CockroachDB Cloud API read was
  performed for this review. The cluster-side cause is a source claim here, not
  a first-party observation.
- **Whether the SNS policy fix is one action or several.** The CloudFormation
  error names no specific action, so the exact offending statement was not
  isolated.
- **Live latency.** No hosted load evidence run exists, and no synthetic
  measurement was performed against a broken data plane.
