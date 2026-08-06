# Judge evidence map

One row per claim. Every row names how the claim is satisfied and links to
something you can open: a file in this repository, or a completed GitHub Actions
run page.

Commit: `25c8f4434dc42771e1262aad30441f01c9868d77` (`main`).
Compiled: 2026-08-04.

## How to read this

**Every evidence link is a public run page or a repository file.** Artifact
deep-links of the form `/actions/runs/<id>/artifacts/<aid>` redirect to a
sign-in gate and return an error for anyone not logged into GitHub, so they are
not used here. Each run page linked below was checked with an unauthenticated
request on the compile date and returned HTTP 200.

**A run page is a fixed record.** It is bound to an exact commit and stays
viewable regardless of what any hosted service is doing today. Measurements
cited from a run describe what happened when that run executed.

**Read this before opening the demo URL.** The 2026-08-02 data-plane outage is
over. The verified cause was the CockroachDB Cloud trial/billing state, not the
Request Unit limit; billing was restored on 2026-08-05. The hosted baseline now
returns HTTP 200 from `/api/health`, `/api/proof`, `/api/audit` and
`POST /api/recall`. It is still the older deployed commit identified below, so
the source-only resolution loop and judge-sandbox routes must not be presented
as live. Full detail and the corrected incident analysis are in
[`docs/DEMO_URL.md`](./DEMO_URL.md) and
[`docs/WELL_ARCHITECTED_AGENTIC_REVIEW.md`](./WELL_ARCHITECTED_AGENTIC_REVIEW.md).

**Where `main` and the deployed build differ, the row says which one it means.**
The last successful deployment was
[run 30577752661](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30577752661)
at commit `0b25d5f1` on 2026-07-30. Commits merged since then are on `main` and
not yet deployed.

---

## 1. Agentic Memory Design

| Claim | How | Evidence |
|---|---|---|
| Memory is a first-class store, not a chat transcript | `agent_memory` holds a natural-language statement, a structured payload, a `VECTOR(1024)` embedding, the embedding model id, a lifecycle status and an idempotency key. Every durable fact an agent learns is written here. | [`src/db/schema.sql`](../src/db/schema.sql) lines 135-177 |
| Recall is semantic, over a native distributed vector index | Four CockroachDB C-SPANN vector indexes: one global, three prefix indexes keyed on exactly the columns production recall equality-constrains, so ANN work stays inside the permitted scope. The choice is justified from an `EXPLAIN` verification, recorded in the schema comment. | [`src/db/schema.sql`](../src/db/schema.sql) lines 1011-1051 |
| Memory writes are idempotent, so replay cannot duplicate a fact | Unique index on `(tenant_id, embed_model, idempotency_key)`, plus a content hash. Re-ingesting the same event is a no-op. | [`src/db/schema.sql`](../src/db/schema.sql) lines 1135-1136; [`src/memory/memory.ts`](../src/memory/memory.ts) |
| Memories from different embedding models are never compared | `embed_model` is part of the idempotency key and part of every recall prefix index, so vectors from two models cannot collide in one ANN search. | [`src/db/schema.sql`](../src/db/schema.sql) lines 1028-1051 |
| The agent audits its own memory for contradictions and absences | A deterministic consistency pass groups memories by subject key, applies a tolerance band so float noise is not a contradiction, skips un-auditable records rather than manufacturing subjects, and reports both contradictions and expected-but-missing facts. | [`src/memory/consistency.ts`](../src/memory/consistency.ts) |
| Forgetting is a database feature, not a cron job | CockroachDB row-level TTL expires the sandbox graph on `ttl_expiration_expression = 'expires_at'` with a four-hourly TTL job. Child evidence is retained until the parent expires, so an approval never destroys the competing source. | [`src/db/schema.sql`](../src/db/schema.sql) lines 189-222 |
| Conflicting memories are resolved by a human, with a receipt | Two observations, a proposal, a `financial-controller` decision, a SHA-256 receipt over a canonical form, and a versioned current/superseded consolidation. Enforced in the database by check constraints and by a `SECURITY DEFINER` function, not only in application code. | [`src/db/schema.sql`](../src/db/schema.sql) lines 271-379 and 789-955; [`docs/MEMORY_RESOLUTION_LOOP.md`](./MEMORY_RESOLUTION_LOOP.md) |
| The resolution loop cannot write to canonical memory | The runtime principal has `SELECT` only on `agent_memory` and the five-table fixed resolution graph; their mutation remains confined to two granted transition functions. Direct runtime DML exists separately and only on the two bounded TTL-backed judge-sandbox tables. | [`src/db/schema.sql`](../src/db/schema.sql); [`docs/MEMORY_RESOLUTION_LOOP.md`](./MEMORY_RESOLUTION_LOOP.md) |
| The memory architecture is evaluated, not just asserted | A memory-policy evaluator runs in CI on every push and scores the architecture against longitudinal cases. | [run 30927000583](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30927000583) at `25c8f443`; [`src/evaluation/memory-policy.ts`](../src/evaluation/memory-policy.ts); [`evals/longitudinal-cases.json`](../evals/longitudinal-cases.json) |
| Recall quality is measured, with a gate | Benchmark asserts recall@1 at least 0.99 and p95 recall latency under 1500 ms over the seeded corpus. | [run 30732311916](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30732311916) at `0b25d5f1`; [`docs/BENCHMARK.md`](./BENCHMARK.md) |

---

## 2. Technical Implementation

| Claim | How | Evidence |
|---|---|---|
| One recall core serves the deployed API, the load target and the tests | `src/http/handler.ts` is called by the Lambda adapter and by the plain node server used as the k6 target, with the embedder and narrator selected by environment. So CI exercises the deployed code path, not a lookalike. | [`src/http/handler.ts`](../src/http/handler.ts) lines 1-13; [`src/lambda.ts`](../src/lambda.ts); [`src/http/server.ts`](../src/http/server.ts) |
| Infrastructure is one reviewable SAM template | CloudFront with origin access control over a private KMS-encrypted S3 bucket, a named HTTP API stage with throttling and access logs, Lambda with a canary deployment preference, four alarms and an operations dashboard. | [`aws/template.yaml`](../aws/template.yaml) |
| The SPA origin is private and reachable only through CloudFront | Bucket blocks all public access, enforces bucket-owner ownership, denies non-TLS and non-KMS writes, and allows `s3:GetObject` only to the CloudFront service principal for the exact distribution ARN. | [`aws/template.yaml`](../aws/template.yaml) lines 164-207 and 551-594 |
| The database connection string never appears in source, parameters or environment | Lambda receives a Secrets Manager secret id and resolves the value at runtime with a bounded refresh. The origin verification token uses a versionless dynamic reference so it stays out of stack parameters and rollback snapshots. | [`aws/template.yaml`](../aws/template.yaml) lines 40-47 and 381-386; [`src/db/secret.ts`](../src/db/secret.ts) |
| Tests cover the runtime, not only the happy path | 44 `*.test.ts` files under `tests/` in the current source, including health-probe timeout, rejection and never-settling cases, alarm routing, API stage proof, row-level-security behaviour and the isolated judge sandbox. The linked historical CI run proves its exact older commit, not these uncommitted additions. | [run 30927004090](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30927004090) at `25c8f443`; [`tests/`](../tests) |
| Static analysis runs on every push | CodeQL. | [run 30926999958](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30926999958) at `25c8f443` |
| Supply chain is gated, not assumed | Infrastructure policy gate, shell and workflow policy gate, canonical ZIP-content and dependency SBOM gate, and trusted SARIF publication. | [run 30922901035](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30922901035) at `33978fd5`; [`docs/SUPPLY_CHAIN_SECURITY.md`](./SUPPLY_CHAIN_SECURITY.md) |
| Infrastructure has policy-as-code rules | CloudFormation Guard rules with their own test fixtures. | [`aws/guard/archon.guard`](../aws/guard/archon.guard); [`aws/guard/tests/archon_tests.yaml`](../aws/guard/tests/archon_tests.yaml) |
| The hosted application is scanned dynamically, against the exact release | ZAP runs against the deployed production release rather than a local build. | [run 30579578909](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30579578909) at `0b25d5f1` |
| The memory layer is reachable over MCP | An MCP server exposes the memory tools, and a separate audit proves the CockroachDB Cloud managed MCP path. | [`src/mcp/server.ts`](../src/mcp/server.ts); [run 30579694425](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30579694425) at `0b25d5f1`; [`docs/MANAGED_MCP_SMOKE.md`](./MANAGED_MCP_SMOKE.md) |
| Deployment is a canary with automatic rollback | `Canary10Percent5Minutes` behind a `live` alias, gated on an alarm scoped to the candidate version only, so a bad candidate rolls back without a broken stable version blocking its own recovery. | [`aws/template.yaml`](../aws/template.yaml) lines 353-359 and 627-658 |
| The last full deployment succeeded end to end | Validate, build once, reconcile memory release, prove through managed MCP, deploy and smoke staging, promote the identical candidate, then DAST the exact production release. | [run 30577752661](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30577752661) at `0b25d5f1` |

---

## 3. Real-World Impact

| Claim | How | Evidence |
|---|---|---|
| The problem is a real one with a measured size | Three documents describe one payroll event and disagree. The bank transfer is only net wages; adding withheld taxes and the employer's own contributions reconciles to the true employer cost, which is materially higher. Recalling the wrong one understates cost. | [`docs/PRODUCT_STRATEGY.md`](./PRODUCT_STRATEGY.md); [`docs/BUILD_PLAN.md`](./BUILD_PLAN.md) |
| The agent finds contradictions a human would miss | The seeded corpus contains a genuine contradiction (`INV-2043` recorded as both 18400 and 18900) and a genuine absence (`PAY-118` expected and missing). `/api/audit` surfaces both. | [`src/memory/consistency.ts`](../src/memory/consistency.ts); assertion in [`.github/workflows/live-availability.yml`](../.github/workflows/live-availability.yml) |
| The benefit is evaluated against a protocol, not asserted | A human-impact evaluation runs in CI against a written protocol and a synthetic pilot, and reports the outcome. | [run 30926999904](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30926999904) at `25c8f443`; [`evals/human-evaluation-protocol.json`](../evals/human-evaluation-protocol.json); [`docs/HUMAN_IMPACT_EVIDENCE.md`](./HUMAN_IMPACT_EVIDENCE.md) |
| Answers are grounded in cited memories, with deterministic guards | Instruction-shaped recalled text is removed before model context is built. The narrator cites every sentence, bounds assertable numbers to lexemes present in cited memories, rewrites once when a deterministic grounding check fails, and falls back to exact evidence rather than preserving rejected model text. With no safe evidence it returns a no-evidence trace and records when recalled evidence was withheld. | [`src/agents/narrator.ts`](../src/agents/narrator.ts) |
| Every answer carries its own audit trail | The recall response returns the cited memories with content, similarity score, source reference and period, plus a retrieval and narration trace naming the index, metric and models used. | [`src/http/handler.ts`](../src/http/handler.ts) lines 199-239 |
| The evaluation method is documented so a reader can disagree with it | Scope, corpus, metrics and limitations are written down rather than summarised into a score. | [`docs/EVALUATION.md`](./EVALUATION.md) |

---

## 4. Production Readiness

This is the criterion the entry scores lowest on, and the honest position is
that some controls are proven, some are source-only, and some historical or
unassigned controls remain bounded limitations. The distinction is drawn in
every row.

| Claim | How | Evidence |
|---|---|---|
| The system has a full Well-Architected review against the current AWS Agentic AI Lens, including its own outage | 25 findings across six pillars, each with severity, evidence, remediation and size, written against the lens published 2026-06-10. The live outage is written up as a worked Reliability finding with root cause and detection failure. | [`docs/WELL_ARCHITECTED_AGENTIC_REVIEW.md`](./WELL_ARCHITECTED_AGENTIC_REVIEW.md) |
| A repository self-consistency audit runs in CI | A contract-driven audit checks that the repository's claims agree with each other. It is a source audit, and the review above states plainly what that does and does not prove. | [run 30924341525](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30924341525) at `3fbba06c`; [`docs/operations/well-architected-contract.json`](./operations/well-architected-contract.json) |
| An external availability canary probes the hosted demo on a schedule, with no credentials | Every 30 minutes it makes the same unauthenticated requests a judge makes, treats `/api/proof` as the hard gate, and asserts the audit contract rather than mere reachability. It deliberately skips `POST /api/recall` so a canary never bills a model completion. | [`.github/workflows/live-availability.yml`](../.github/workflows/live-availability.yml) |
| The canary works: its first scheduled run correctly caught the live outage | The run fails at "Probe live health and proof endpoints". This is the only detector in the system that identified the outage, and the link is to a failing run on purpose. | [run 30928730030](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30928730030) at `25c8f443` |
| The health endpoint on `main` performs a real bounded dependency probe | Races a `SELECT 1` through the live pool against an explicit timer, caches the result for a few seconds, collapses concurrent polls into one round trip, and reports `ready` / `degraded` / `unchecked`. Driver errors are swallowed so a public endpoint never leaks a hostname or a secret id. **On `main`, not yet deployed.** | [`src/http/handler.ts`](../src/http/handler.ts) lines 242-424 |
| A recovery watchdog has a recorded successful run | The linked fixed run detected and repaired drift in the AWS foundation at its recorded commit. This row does not claim current external state. | [run 30926605419](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30926605419) at `3fbba06c` |
| Operational runbooks exist for the failures that can actually happen | Alarm response, cost anomaly, credential compromise, database restore, regional outage, rollback recovery, WAF abuse response, account security baseline. | [`docs/runbooks/`](../docs/runbooks); [`docs/operations/INCIDENT_PROCESS.md`](./operations/INCIDENT_PROCESS.md) |
| Ownership and objectives are marked unassigned rather than invented | Five owners and five objectives are explicit placeholders, with a documented live-activation gate that fails closed until a human assigns them. | [`docs/operations/SLO_AND_OWNERSHIP.md`](./operations/SLO_AND_OWNERSHIP.md) lines 25-47 |
| Cost is modelled without a false precision claim | A fixed control-plane envelope with a `$26.00` ceiling recomputed in integer cents by CI, and an explicit refusal to publish a total until billing-authorized evidence exists. | [`docs/finops/COST_MODEL.md`](./finops/COST_MODEL.md) |
| Secrets are scanned and dependency changes are gated | Supply-chain workflow gates, plus a written dependency release policy and a reviewed waiver file. | [run 30922901035](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30922901035) at `33978fd5`; [`docs/DEPENDENCY_RELEASE_POLICY.md`](./DEPENDENCY_RELEASE_POLICY.md); [`security/waivers.yml`](../security/waivers.yml) |

**Known-failing controls at this map's 2026-08-04 snapshot, stated rather than
omitted.** Alarm notification
topics do not exist because the bootstrap stack update rolled back twice on
2026-08-04 with an SNS topic-policy error. Deployment has failed on every push
since `38f129e` at the exact-SHA supply-chain receipt step. No WAF WebACL exists
in any region. The restore drill has two runs and no success. Each is a
numbered finding with evidence and a remediation size in
[`docs/WELL_ARCHITECTED_AGENTIC_REVIEW.md`](./WELL_ARCHITECTED_AGENTIC_REVIEW.md)
(OPS-1, OPS-3, SEC-1, REL-4).

---

## 5. Creativity and Originality

| Claim | How | Evidence |
|---|---|---|
| Agent memory is stored in the operational database, not a bolt-on vector service | `VECTOR(1024)` columns and C-SPANN indexes live in the same CockroachDB cluster as the financial records, in the same serializable transaction domain. A memory and the fact it describes commit together. | [`src/db/schema.sql`](../src/db/schema.sql) lines 125-177 and 1011-1051 |
| Row-level security is used as an agent memory boundary | RLS is enabled and forced on canonical memory, the five-table resolution graph, and both judge-sandbox tables, with paired permissive and restrictive policies so a permissive policy alone cannot widen access, and `NOBYPASSRLS` runtime roles. | [`src/db/schema.sql`](../src/db/schema.sql) |
| Row-level TTL is used as agent forgetting | Expiry is a table property with a scheduled TTL job, so forgetting is enforced by the storage engine rather than by application code that might not run. | [`src/db/schema.sql`](../src/db/schema.sql) lines 219-222 |
| A public demo can prove real write loops without exposing canonical memory | The human-gated resolution sandbox remains function-only, serializable, idempotent, receipted and TTL-expiring. Direct runtime DML is separately confined to two capability-scoped judge-sandbox tables with row-level TTL; the runtime still has no DML on `agent_memory` or the fixed resolution graph. | [`src/db/schema.sql`](../src/db/schema.sql); [`docs/MEMORY_RESOLUTION_LOOP.md`](./MEMORY_RESOLUTION_LOOP.md) |
| The RLS-versus-vector-planning conflict is solved and the trade-off is declared | RLS acts as an optimizer barrier that prevents index-accelerated ANN. Fixed-scope dematerialized views owned by a memberless `NOLOGIN BYPASSRLS` role restore the vector search path. The residual risk is named in the review rather than hidden. | [`src/db/schema.sql`](../src/db/schema.sql) lines 1053-1126; [`docs/WELL_ARCHITECTED_AGENTIC_REVIEW.md`](./WELL_ARCHITECTED_AGENTIC_REVIEW.md) finding SEC-2 |
| The vector index definition is verified live, not assumed | `/api/proof` reads `pg_catalog.pg_indexes` and fingerprints the actual index definition, so the claim "native C-SPANN vector index" is checked against the running cluster on every call. | [`src/db/proof.ts`](../src/db/proof.ts); [`src/http/handler.ts`](../src/http/handler.ts) lines 454-547 |
| The entry reviews itself against a lens published two months ago | The AWS Well-Architected Agentic AI Lens was published 2026-06-10. This entry is reviewed against its actual control IDs, including the two questions the lens dedicates to agent memory, AGENTSEC01 and AGENTREL03. | [`docs/WELL_ARCHITECTED_AGENTIC_REVIEW.md`](./WELL_ARCHITECTED_AGENTIC_REVIEW.md) |
| The demo video is built and verified by pipeline, not hand-edited | Scene plan, narration generation, build, and a media gate that verifies the receipt. | [run 30579893915](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30579893915) at `0b25d5f1`; [`demo/VIDEO_PLAN.md`](../demo/VIDEO_PLAN.md) |

---

## Workflow run index

Every run page below was requested without authentication on 2026-08-04 and
returned HTTP 200. Each commit listed is reachable from `main`.

| Workflow | Run | Commit | Result |
|---|---|---|---|
| CI | [30927004090](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30927004090) | `25c8f443` | success |
| CodeQL | [30926999958](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30926999958) | `25c8f443` | success |
| Memory architecture evaluation | [30927000583](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30927000583) | `25c8f443` | success |
| Human evaluation and impact evidence | [30926999904](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30926999904) | `25c8f443` | success |
| Supply Chain (enforced) | [30922901035](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30922901035) | `33978fd5` | success |
| AWS Well-Architected Evidence Audit | [30924341525](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30924341525) | `3fbba06c` | success |
| Recover AWS | [30926605419](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30926605419) | `3fbba06c` | success |
| Deploy AWS | [30577752661](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30577752661) | `0b25d5f1` | success |
| Benchmark (full + distribution) | [30732311916](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30732311916) | `0b25d5f1` | success |
| Hosted DAST | [30579578909](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30579578909) | `0b25d5f1` | success |
| Cockroach Cloud Managed MCP Audit | [30579694425](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30579694425) | `0b25d5f1` | success |
| Demo video | [30579893915](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30579893915) | `0b25d5f1` | success |
| Live demo availability | [30928730030](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30928730030) | `25c8f443` | **failure, cited deliberately** |

## What this entry is not claiming

Listed because a claim you cannot check is worth less than an absence you can.

- **No production SLO.** Availability, latency, error rate, RTO and RPO are all
  marked Pending. The CI thresholds in [`docs/BENCHMARK.md`](./BENCHMARK.md) are
  test gates over a bounded workload, not a service promise.
- **No hosted load measurement.** The hosted load evidence workflow exists and
  has never run, so there is no measured production p95.
- **No proven restore.** The restore drill has two runs, both failed. Recovery
  from the managed backup is a hypothesis here, not a demonstrated capability.
- **No emissions claim.** The sustainability workflow has one run and it failed.
  There is no baseline and no measured intensity.
- **No authenticated human approval.** The resolution loop's human gate is a
  fixed role assertion, and the API says so in its own response
  (`identityAssurance: "fixed-demo-role-assertion-not-authenticated"`).
- **No multi-agent orchestration.** This is a single agent with a memory. The
  lens questions about inter-agent trust and coordination do not apply and are
  not answered.
- **No live alarm notification.** Alarms exist and fire; they route nowhere. See
  finding OPS-1.
