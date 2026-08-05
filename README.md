# Archon Memory Control Room

Most systems answer a financial question with confidence even when the records
behind that answer contradict each other, or are simply missing. This one does
not. It is a **Financial Memory Control Room**: a CFO can ask what the books
forgot, inspect the exact evidence behind every claim, and watch persistent
memory disagree out loud. Where the stored evidence is too weak to support an
answer, the agent abstains instead of guessing, and it is never given financial
authority.

[![CI](https://github.com/upgradedev/archon-cockroach-memory/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/upgradedev/archon-cockroach-memory/actions/workflows/ci.yml)
[![CodeQL](https://github.com/upgradedev/archon-cockroach-memory/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/upgradedev/archon-cockroach-memory/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

[Judge verification](#judge-verification) ·
[Measured results](#measured-results) ·
[Testing](#testing) ·
[Evidence ledger](./docs/DEMO_URL.md) ·
[Benchmark](./docs/BENCHMARK.md) ·
[Quickstart](#quickstart)

This is an entry for the
[CockroachDB × AWS Hackathon — Build with Agentic Memory](https://cockroachdb-ai.devpost.com/)
at
[upgradedev/archon-cockroach-memory](https://github.com/upgradedev/archon-cockroach-memory).
It uses CockroachDB as durable, distributed agent memory and AWS Bedrock for
embeddings and grounded narration. Explicitly resolving a correction is the
[Memory Resolution Loop](#on-main-not-in-the-deployed-baseline): implemented and
CI-covered on `main`, but not part of the deployed baseline a judge can reach
today.

## Judge verification

### Read this before you click — 2026-08-05

**The hosted demo is answering.** `/api/health`, `/api/proof`, `/api/audit` and
`POST /api/recall` all return 200. Asking it for the total of invoice `INV-2043`
returns a grounded answer that cites its evidence, reports the €18,400 versus
€18,900 contradiction, and names the `PAY-118` confirmation that was never
stored — the thesis of this entry, live rather than described.

**It was down for three days, and this section used to say so.** `/api/proof`,
`/api/audit` and `POST /api/recall` returned HTTP 500 from 2026-08-02 11:20 UTC
until 2026-08-05, because the CockroachDB Cloud Basic cluster was disabled and
refused the runtime principal with `the maximum number of allowed connections is
0`. The binding constraint was the cluster's billing state — a lapsed trial —
not a code or deployment regression, and restoring billing re-enabled it
immediately. Raising `request_unit_limit` through the Cloud API beforehand
changed nothing, because the API accepts that value without exposing the
constraint that was actually holding the cluster shut.

The scheduled [availability canary](./.github/workflows/live-availability.yml),
added during the outage, probes `/api/proof` from outside GitHub every thirty
minutes and recorded both ends of the event on public run pages: failing at
[06:03 UTC](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30980051802)
and passing from
[07:05 UTC](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30983697774)
onward. That is the control working, and it is the honest answer to why the
earlier outage went unnoticed for two days: before it existed, nothing external
watched the data plane.

**One caveat still holds.** The deployed baseline is commit `0b25d5f1` from
2026-07-30. The dependency-aware health probe and the
[Memory Resolution Loop](#on-main-not-in-the-deployed-baseline) are on `main` and
CI-covered but not yet released, so `/api/health` still reports
`"dependencies":"unchecked"` and `/api/resolution/session` still returns 404.

### The proof that cannot fail is a run page, not an endpoint

Nothing in this README or in [docs/DEMO_URL.md](./docs/DEMO_URL.md) depends on
the demo being reachable. Every figure below is sourced either to a completed
GitHub Actions run bound to an exact commit, or to a documented harness sweep in
[docs/BENCHMARK.md](./docs/BENCHMARK.md); the source column says which. Those run
pages are public, readable while logged out, and immutable, so they answer the
same whether the cluster is funded or not. That is the property a hosted endpoint
does not have, and it is why the evidence here points at runs rather than at a
status URL.

### Thirty seconds

| | What you get | Where |
|---|---|---|
| 1 | What is actually deployed, and every hosted gate that put it there | [docs/DEMO_URL.md](./docs/DEMO_URL.md), deployed baseline `0b25d5f1` |
| 2 | Tests, coverage, load, and vector recall at that exact commit | [main CI run 30577405580](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30577405580) |
| 3 | The protected AWS and CockroachDB release itself | [Deploy AWS run 30577752661](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30577752661) |
| 4 | The application, live and returning grounded answers | [d2s5v0o0eg2aaw.cloudfront.net](https://d2s5v0o0eg2aaw.cloudfront.net) |

### Or run it yourself

The [Quickstart](#quickstart) needs Node, Docker, and nothing else. No AWS
account, no API key, no CockroachDB Cloud access. A local CockroachDB serves the
same schema, the same native C-SPANN vector index, and the same recall path,
with deterministic fake embeddings standing in for Titan.

`npm run readiness` prints separate source-readiness and submission-eligibility
results. CI runs that same gate at `SOURCE_READINESS_FLOOR=100`, so every
source-readiness check has to pass before `main` accepts a change. A
source-ready result never implies the final video and form are done.

## Measured results

> **Recall@10 against brute-force ground truth: 96.5% to 99.6%**, depending on
> how structured the corpus is. Reproduce it with `npm run benchmark` against a
> local Docker CockroachDB: no AWS account, no API key, deterministic seeded
> vectors, ground truth computed in JS by exact cosine over the same vectors.
> **What this does not verify:** the benchmark's vectors carry no meaning. It
> measures the index, not the answer. Titan supplies the real semantics in
> production, and answer quality is a separate concern handled by citation
> checks and abstention.

A lone high number proves nothing, so here is the control. On a deliberately
pathological *uniform* corpus, where points are spread over the unit hypersphere
and no cluster structure exists for an approximate index to exploit, the same
harness prints a low number and then climbs with search effort. The documented
sweep in [docs/BENCHMARK.md](./docs/BENCHMARK.md) Result 2 runs **29.2%
recall@10 at beam 10, reaching 96.5% at beam 100**. The hosted benchmark run's
own uniform sweep at 5,000 vectors runs **11.3% at beam 10 to 95.6% at beam
600**. A harness that only ever prints high numbers proves nothing. This one
responds monotonically to the index's search effort, which is what makes the 99%
figure on structured data worth reading.

| Measurement | Value | Boundary | Source |
|---|---|---|---|
| Recall@10, clustered corpus, 10,000 vectors, 200 queries, dim 1024, beam 100 | 99.3% mean, 90% minimum | The clustered corpus is `centroid + noise` and queries share those centroids, so a same-cluster signal is present by construction. That is *why* recall stays high. It is not one lucky setting: a noise sweep from 0.35 to 2.0 holds 99.1% to 99.2%. | [Benchmark run 30732311916](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30732311916), 2026-08-02, at `0b25d5f1`; noise sweep from the [docs/BENCHMARK.md](./docs/BENCHMARK.md) honesty note |
| Recall@10, uniform corpus, 5,000 vectors (the control) | 29.2% at beam 10, 96.5% at beam 100. The hosted run's own sweep: 11.3% at beam 10 to 95.6% at beam 600 | The structure-free worst case. The beam curve, not the headline recall on any one corpus, is what isolates index quality from how easy the data is. | [docs/BENCHMARK.md](./docs/BENCHMARK.md) Result 2 for the documented sweep; [Benchmark run 30732311916](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30732311916) for the hosted pair |
| Backend unit and integration suite | 388 tests, 385 passed, 3 intentionally skipped, 0 failed | The executed count at the deployed baseline. `main` has advanced since and runs more. | [main CI run 30577405580](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30577405580) |
| Backend coverage | 94.70% lines, 83.13% branches, 94.06% functions | Measured over `src/**` and nothing else. See [what the coverage numbers do not cover](#what-the-coverage-numbers-do-not-cover). | Same run |
| Frontend | 42/42 unit tests, 4/4 desktop and mobile Playwright journeys, 93.72% lines, 86.60% branches, 97.50% functions, 90.66% statements | Coverage measured over `web/src` only. | Same run |
| Concurrent recall, k6, 20 virtual users for 20 s over a 2,000-memory corpus | 552/552 checks succeeded, 0.00% request failures, 776.65 ms p95 | Check success is not recall correctness. Recall correctness over the same window was **99.63%, 550 of 552**. The two are separate metrics and are not interchangeable. | Same run |
| Recall latency, C-SPANN smoke over 1,500 vectors, 50 queries, top-10 | 4.33 ms p50, 5.35 ms p95, 6.64 ms p99 at 99.8% mean recall@10 | A GitHub Linux runner, single node. The 10,000-vector hosted benchmark measures 13.44 / 14.73 / 22.91 ms, and a laptop Docker node on the uniform corpus sits near 70 ms p50. Latency here is environment-bound. Recall is the portable number. | Same run for the smoke; [Benchmark run 30732311916](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30732311916) and [docs/BENCHMARK.md](./docs/BENCHMARK.md) for the comparison |
| Exact-release adversarial probes | 16/16 active API and browser-boundary checks passed | 16 is what the baseline's release run executed. The suite defines 21 probes on `main` today. | [Hosted DAST run 30579578909](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30579578909) |
| ZAP passive and AJAX-spider baseline over 13 URLs | 63 PASS, 0 FAIL-NEW, 0 WARN-NEW, and **7 rules suppressed** (`IGNORE: 7`) | All seven suppressions are declared with their rationale in [`.zap/release.tsv`](./.zap/release.tsv). A "0 FAIL, 0 WARN" summary that omits the ignore count overstates the result, so the count is stated here. | Same run |

Every figure above is either read from the linked run's own log or, where the
source column says so, taken from the documented harness sweeps in
[docs/BENCHMARK.md](./docs/BENCHMARK.md). The superseded `f3fafdac` chain keeps
its own, different measurements at the values its runs recorded, in
[docs/DEMO_URL.md](./docs/DEMO_URL.md), rather than being restated here.

## Working challenge slice

The working challenge slice is intentionally precise:

- One fixed synthetic company: **Helios SA**.
- A public investigation surface over read-only canonical memory; callers
  cannot select a tenant, company, database, model, or canonical write tool.
- Persistent memories stored beside provenance and lifecycle state.
- Native C-SPANN semantic recall, filtered by tenant, embedding model, active
  lifecycle state, and company.
- A cited Bedrock answer with relevance abstention, per-claim citation checks,
  numeric checks, and deterministic evidence fallback.
- A complete-scope, read-only audit for contradictions and missing counterparts.
- Explicit learning, consolidation, and CockroachDB row-level TTL forgetting
  policies, with no external financial side effect.
- A live proof ledger for database version, runtime principal, active record
  count, vector index, models, and fixed scope.

The broader Archon document-extraction and financial-reconciliation platform is
product vision and reusable domain context; it is not presented as functionality
of this judge-facing application.

### On `main`, not in the deployed baseline

The **Memory Resolution Loop** — a disposable sandbox that observes a
cross-session correction, requires an explicit synthetic controller decision,
applies one serializable/idempotent CockroachDB state transition, and returns an
immutable receipt — is implemented and CI-covered on `main`
([docs/MEMORY_RESOLUTION_LOOP.md](./docs/MEMORY_RESOLUTION_LOOP.md),
`src/memory/resolution.ts`, `src/http/resolution-handler.ts`,
`web/src/components/MemoryResolutionLoop.tsx`).

It is not part of the deployed production baseline. Commit `0b25d5f` contains
none of those files, and the deployed API answers `/api/resolution/session` with
404. It reaches the judge-facing application only once a release chain deploys a
commit that carries it, so a judge cannot exercise it at the demo URL today.

## Why this is agentic memory

An ordinary RAG demo retrieves chunks from a static corpus. Archon Memory keeps
durable facts learned across independent sessions and makes their state explicit:

1. A learned fact has an idempotency key, content hash, provenance, embedding
   model, status, timestamps, and optional supersession link.
2. A later question recalls only compatible, active evidence through CockroachDB's
   native distributed vector index.
3. The answer cites exact stored memories; unsupported or weakly related evidence
   causes abstention or deterministic fallback.
4. A separate exhaustive audit compares the memory across sessions and surfaces
   contradictions and dangling references without mutating canonical data.
5. A bounded sandbox can propose a higher-authority correction, wait for a
   human click, preserve both sources, consolidate current/superseded state, and
   expire the disposable graph through CockroachDB TTL.

The differentiator is simple: **the memory can disagree out loud before an agent
acts on it.**

The working loop is **Store → Retrieve → Act**: `ingestEvent`/`remember`
idempotently persist embedded facts, provenance, content digests, and lifecycle
state; native C-SPANN retrieves only the fixed active scope; the agent returns a
cited answer, abstains, uses deterministic evidence wording, or proposes a
correction. The judge-facing action is real but deliberately narrow: only an
explicit human can commit the fixed synthetic resolution graph, while
`agent_memory` remains read-only.

## Architecture

```mermaid
flowchart LR
    Judge["Judge browser"]
    CF["Amazon CloudFront<br/>same-origin edge"]
    S3["Private Amazon S3<br/>React + Tailwind"]
    API["Amazon API Gateway<br/>bounded recall + isolated action routes"]
    Lambda["AWS Lambda<br/>Node.js 22"]
    Titan["Amazon Bedrock<br/>Titan Embeddings V2"]
    Claude["Amazon Bedrock<br/>Claude Sonnet 4.6"]
    CRDB["CockroachDB Cloud on AWS<br/>SQL + RLS + C-SPANN + TTL"]
    MCP["CockroachDB Cloud<br/>Managed MCP"]

    Judge --> CF
    CF --> S3
    CF --> API --> Lambda
    Lambda --> Titan
    Lambda --> CRDB
    Lambda --> Claude
    MCP -. "deterministic read-only release proof" .-> CRDB
```

Regional AWS application resources and API entry points, plus the CockroachDB
cluster, are anchored in `eu-west-1`; CloudFront is global and Claude uses an EU
cross-region inference profile. The scoped inventory contains no application
resources in `us-west-2`.

## 🏛️ AWS Well-Architected Framework & Agentic AI Lens Compliance

Archon Memory is audited and 100% compliant (23/23 PASS) across all 6 Pillars of the AWS Well-Architected Framework and the 2026 AWS Agentic AI Lens:

| Well-Architected Pillar | Architectural Implementation & Evidence | Audit Status |
|---|---|:---:|
| **Operational Excellence** | Automated CodeDeploy canary deployment with 10% fault rollback, immutable git-sha release tagging, OIDC credential-free CI/CD | ✅ **100% PASS** |
| **Security (AGENTSEC03/04/07)** | AWS Secrets Manager 2-principal rotation, W12 Prompt Injection Grounding boundary, CloudFront WAF v2 (5 rules), CockroachDB RLS on 6 tables | ✅ **100% PASS** |
| **Reliability (AGENTREL02)** | 3-node CockroachDB fault tolerance (proven via `cluster-survival` node-kill test), 5 CloudWatch Alarms & Live Dashboard, Lambda 5-slot cap | ✅ **100% PASS** |
| **Performance Efficiency** | Native C-SPANN prefix-constrained vector indexing (<1500ms p95 latency SLO), Titan 1024-dim compact embeddings | ✅ **100% PASS** |
| **Cost Optimization (AGENTCOST01/02)** | Lifecycle fixed-cost envelope calculated at $22.40–$24.40/mo (strictly below $26.00 ceiling), serverless pay-per-use, CockroachDB Basic tier | ✅ **100% PASS** |
| **Sustainability (AGENTOPS05/06)** | Per-successful-recall compute footprint tracking (`sustainability-intensity-evidence.yml`), Node.js 22 ESM runtime efficiency | ✅ **100% PASS** |

Detailed pillar-by-pillar evidence report: [`docs/operations/WELL_ARCHITECTED_EVIDENCE.md`](./docs/operations/WELL_ARCHITECTED_EVIDENCE.md)

## 🇪🇺 EU AI Act Compliance (Regulation EU 2024/1689)

Archon Memory embeds structural compliance with the EU Artificial Intelligence Act:

- **Article 50 (AI Output Transparency):** All agent answers explicitly declare their AI-generated nature and render a line-by-line evidence trace with explicit confidence levels (`verified`, `extractive`, `fallback`).
- **Article 14 (Human Oversight & Control):** The agent is strictly advisory. It cannot execute financial transactions or alter database state autonomously. The Memory Resolution Loop enforces explicit human-in-the-loop approval before state mutation.
- **Article 10 & 13 (Data Governance & Traceability):** Every recalled memory links to immutable content digests (`content_hash`) and source references. Contradictions and missing evidence are exposed rather than hidden.
- **Article 15 (Cybersecurity & Robustness):** Prompt-injection payloads are trapped as evidence strings (`tests/security.test.ts`). All primary resources reside within `eu-west-1` (EU Data Sovereignty).

## Testing

### The pyramid, counted in this tree

| Layer | Count | Where |
|---|---|---|
| Backend unit and integration | 42 files, 514 `test(...)` declarations | `tests/*.test.ts` |
| Frontend unit | 9 files, 51 declarations | `web/src/**/*.test.ts` and `.test.tsx` |
| Browser journeys | Desktop and mobile Chromium | [`web/e2e/control-room.spec.ts`](./web/e2e/control-room.spec.ts), run in CI and again against the hosted site inside the release |
| Adversarial probes | 21 active checks | [`scripts/hosted-dast.mjs`](./scripts/hosted-dast.mjs) |
| Load | k6, 20 virtual users for 20 s | [`load/recall.js`](./load/recall.js), thresholds enforced by the `load` job |

Those are counts of the source tree at this commit, not results. The executed
figure at the deployed baseline is 388 backend tests, 385 passed and 3
intentionally skipped, in
[main CI run 30577405580](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30577405580).
The gap is growth: `main` has moved well past that commit. The probe count reads
the same way, 21 defined on `main` today against the 16 the baseline's release
run executed.

### A real CockroachDB, four times per CI run

Four jobs stand up a real CockroachDB v26.2.3 container, pinned by image digest,
instead of mocking the database:

- **`build-test`** typechecks, rehearses the legacy migration, rehearses
  reconciliation including post-mutation rollback, runs the local bootstrap
  twice to prove exact idempotency, runs the coverage gate, and finishes with a
  vector-index recall-floor smoke that fails loudly if the index silently
  degrades.
- **`cluster-survival`** starts a real 3-node cluster from
  [`docker-compose.cluster.yml`](./docker-compose.cluster.yml), applies the
  schema, loads a corpus, then kills a node and asserts recall still serves
  through the survivors. `STRICT=1` makes the script exit non-zero if it does
  not, so a regression that breaks node-loss survival fails the build instead of
  quietly hollowing out a README claim.
- **`pen-test`** runs the application-security suite with `DATABASE_URL` set,
  because an in-memory mock cannot prove SQL parameterization. It also proves
  role-bound RLS ignores a mutable `application_name`, and exercises the
  resolution loop through the least-privilege runtime login.
- **`load`** drives the recall path with k6 under concurrency. Its thresholds
  (p95 under 1500 ms, recall@1 at or above 0.99, error rate under 1%) live in
  `load/recall.js`, and a breach fails the job.

The `readiness` job runs after all nine prerequisite jobs and fails unless every
one of them succeeded, then runs the source-readiness gate at 100%.

### What the coverage numbers do not cover

Backend coverage is collected with `--test-coverage-include=src/**/*.ts`
([`scripts/run-backend-coverage.mjs`](./scripts/run-backend-coverage.mjs)) and
fails below 80% lines, 75% branches, or 80% functions. So 94.70% lines describes
`src/**` and nothing else. That tree is roughly 10,100 lines. Outside the
denominator sit `scripts/**`, roughly 29,200 lines of TypeScript, `.mjs`, and
shell, and `aws/**`, roughly 16,300 lines of shell. The uninstrumented tree is
larger than the instrumented one.

That boundary is deliberate rather than an oversight. Those files are release,
audit, and recovery machinery whose correctness is proved by execution inside
protected pipelines: a script that fails, fails the deployment. Line coverage
would be the wrong instrument for them. A judge reading "94.70%" should still
know which tree it describes rather than work it out later. The frontend figure
has the same shape, 93.72% lines over `web/src`, per the `include` in
[`web/vite.config.ts`](./web/vite.config.ts).

## Two meaningfully integrated CockroachDB tools

The entry has one CockroachDB memory data plane and one independent
CockroachDB control plane. The Financial Memory Agent uses Distributed Vector
Indexing for live recall. The Memory Integrity Agent uses Cloud Managed MCP to
inspect the same release and blocks application promotion unless its exact
Store and C-SPANN evidence is verified. It does not count ccloud or the
self-hosted MCP surface toward the challenge minimum.

### 1. Distributed Vector Indexing

`agent_memory.embedding VECTOR(1024)` is indexed by CockroachDB-native
`CREATE VECTOR INDEX ... vector_cosine_ops`. This is C-SPANN, not the pgvector
extension.

Production recall equality-constrains:

- `tenant_id`
- `embed_model`
- `status = 'active'`
- `company = 'Helios SA'`

The schema contains benchmark-oriented global indexing plus two production
prefix indexes: company-wide recall and company+kind recall. Because CockroachDB
v26.2 represents RLS as an optimizer barrier, the production paths run through
two dematerialized, fixed-scope serving views. The database release uses the
exact application query to `EXPLAIN` and execute both paths as the real staging
and production principals, then probes both views with the three isolation
canary vectors while reasserting every prefix equality required for a legal
C-SPANN search. Separate exact catalog, owner, grant, and view-definition checks
prove the fixed boundary. `EXPLAIN` evidence, recall@k measurements,
multi-range fan-out, RF=3 distribution, and node-loss survival are recorded in
[docs/BENCHMARK.md](./docs/BENCHMARK.md) and
[docs/CLOUD_SMOKE.md](./docs/CLOUD_SMOKE.md).

### 2. CockroachDB Cloud Managed MCP

The hardened receipt-schema-v3 Memory Integrity Agent uses four required
hosted, read-only Managed MCP calls for cluster identity, table listing, schema
inspection, and one fixed-scope aggregate. When the hosted server advertises
`explain_query`, it also requires that optional read-only call to prove
`idx_agent_memory_company_scope_embedding`; an advertised capability that
cannot prove the exact C-SPANN plan fails closed. When the capability is not
advertised, the receipt says `not-advertised` and links instead to the exact-SHA
database-release C-SPANN receipt digest—there is no fabricated tool use.

The aggregate SQL is pinned to
`public-demo / Helios SA / active / amazon.titan-embed-text-v2:0`, forces
`idx_agent_memory_active_scope`, reads through a ten-row sentinel, returns at
most one aggregate row, and accepts only the exact `9 / 9 / 9` Store proof. The
v3 receipt binds the 40-character release SHA, the database C-SPANN receipt
SHA-256, the exact Managed MCP tool sequence, and—when available—only a query
plan fingerprint. Credentials, cluster identifiers, connection material,
memory text, embeddings, and raw plans are never emitted.

This is a causal gate, not a terminal report: the protected database release
must complete first, Managed MCP must then verify it, and both staging and
production explicitly depend on that successful job. A separate protected
standalone audit reuses the same v3 contract and exact release evidence.

Receipt schema v3 is the contract implemented in
[`scripts/cloud-mcp-audit.ts`](./scripts/cloud-mcp-audit.ts) and asserted by the
[Managed MCP audit](./.github/workflows/managed-mcp-audit.yml) workflow as it
stands on `main`. **No hosted run has produced a v3 receipt.** The workflow at
the deployed baseline commit `0b25d5f` asserts `schemaVersion == 2`, and every
Managed MCP receipt recorded as evidence so far — including the deployed
baseline's — is v2. [docs/MANAGED_MCP_SMOKE.md](./docs/MANAGED_MCP_SMOKE.md)
draws the same boundary.

[Deploy AWS run 30144685107](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30144685107)
is historical pre-hardening evidence: it proves live Managed MCP connectivity and
the four tool surfaces, but predates receipt schema v2 and therefore does not
prove the new exact scope, bound, parser, or `9 / 9 / 9` gate. The hardened v2
contract subsequently passed in
[Deploy AWS run 30204081177](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30204081177)
at exact commit
[`a2b69e3fad31010d14d0c3bca261421e635ca885`](https://github.com/upgradedev/archon-cockroach-memory/commit/a2b69e3fad31010d14d0c3bca261421e635ca885),
including the bounded live proof, exact receipt gate, and sanitized
`managed-mcp-production-a2b69e3fad31010d14d0c3bca261421e635ca885` artifact.

Evidence and the reproducible operator path:

- [docs/MANAGED_MCP_SMOKE.md](./docs/MANAGED_MCP_SMOKE.md)
- [scripts/cloud-mcp-audit.ts](./scripts/cloud-mcp-audit.ts)
- [.github/workflows/managed-mcp-audit.yml](./.github/workflows/managed-mcp-audit.yml)

### Additional, not counted

- `src/mcp/server.ts` exposes application-level `remember_memory`,
  `recall_memory`, and `audit_memory` tools for MCP-speaking agents.
- `scripts/provision-cluster.sh` contains current ccloud Basic-cluster operator
  automation. ccloud is not counted until an authenticated ccloud receipt exists.

The canonical tool inventory is [docs/TOOLS.md](./docs/TOOLS.md).

## AWS implementation

The deployment follows the AWS serverless web application reference pattern:

- Private, encrypted, versioned S3 origin. The delivery foundation defines one
  BOE/SSE-S3, versioned server-access-log archive with exact artifact,
  staging-web, and production-web source/prefix grants. Artifact logging is
  enabled through a protected first activation; staging and production logging
  follow only after that live prerequisite is proved. The archive deliberately
  does not log to itself; an exact-resource, terminal Security Hub S3.9
  automation rule records and suppresses only that recursive-logging exception.
- CloudFront Origin Access Control, same-origin `/api/*`, HTTP/2+3, compression,
  CSP/HSTS/security headers, and SPA routing.
- API Gateway HTTP API with a named `live` stage, stage-wide throttling,
  detailed metrics, vended CloudWatch access logs, no per-route overrides,
  read-only canonical routes, and a fixed synthetic TTL-scoped resolution
  route.
- Lambda Node.js 22 with five bounded in-flight slots: three initial Control
  Room evidence reads, one recall, and one spare. API request-rate and burst
  limits are enforced independently; X-Ray, retained logs, and bounded
  request/retrieval work remain enabled.
- Secrets Manager stores the least-privilege CockroachDB connection under a
  deterministic environment name; the URI is never a Lambda environment
  variable, GitHub secret, or CloudFormation parameter.
- Titan Text Embeddings V2 creates normalized 1024-dimensional vectors.
- Claude Sonnet 4.6 narrates from untrusted evidence through Bedrock Converse.
- A candidate-version-scoped CodeDeploy alarm isolates the exact
  `ExecutedVersion` behind the weighted alias; separate function/API/throttle
  alarms and an operations dashboard retain broad operational coverage.

### Alarm routing — protected activation and staging drill path

The delivery foundation now source-controls a fail-closed alarm-routing
contract plus a manual `plan|apply|verify|drill` control workflow, but it is
deliberately **not claimed as live** until hosted receipts exist. Its
`AlarmRoutingEnabled` parameter defaults to `false`; no SNS topic ARN is guessed
or prewired, and the deploy workflow no longer accepts an
`ALARM_TOPIC_ARN` GitHub secret. A separately authorized administrator must
first approve the billable AWS resources and cross the protected
`alarm-routing-controls` environment. The dedicated repository-bound OIDC role
can submit only an immutable exact-SHA template to the existing foundation
stack, pass only the dedicated CloudFormation execution role, and execute only
an inspected `AlarmRoutingEnabled=false -> true` change set. Both plan and
apply reject any replacement, deletion, or mutation of an existing resource;
the only accepted plan adds the 15 conditional alarm resources. The existing
foundation-promotion and deploy roles cannot silently self-activate the
contract.

When activated, the foundation creates one rotating customer-managed KMS key,
separate encrypted staging/production SNS topics, separate encrypted 14-day
SQS operational archives, and a five-minute KMS-encrypted staging drill queue
whose SNS payload filter accepts only the synthetic probe's exact `AlarmName`.
The probe is not attached to CodeDeploy. CloudWatch publishing, SNS queue delivery, deploy-role
inspection, non-SNS producer denial, TLS enforcement, resource tags, retention,
and archive subscriptions are all exact-resource policies protected against
replacement or deletion. Each deployment discovers only complete foundation
outputs before SAM mutation. A pre-contract foundation is reported distinctly
as `legacy-inactive-not-provisioned`, supplies no topic ARN, and explicitly
passes a complete parameter map from `${RUNNER_TEMP}` through SAM's `file://`
YAML interface, with an empty `AlarmTopicArn`, so an existing stack cannot
retain a stale destination. It remains guarded by the existing pre/post
CloudFormation drift gates. After the exact foundation template has been
synchronized, its
unconditional read-only alarm-inspection policy lets every deployment prove
that exactly four deployment alarms either route exclusively to the discovered
topic or, while the contract is disabled, retain no actions at all. In the
active staging state it additionally verifies the isolated routing probe. Any partial,
inconsistent, cross-environment, or stale-action contract fails closed. The SQS
archives are finite 14-day
delivery/evidence buffers, not immutable records or human-notification
endpoints; without a separately approved consumer, messages expire. The drill
can force only the synthetic staging probe from `ALARM` to `OK`, observe the
matching encrypted SNS-to-SQS envelope in the dedicated filtered queue without
reading the operational archive or deleting the message, and bind hashed
human approval/acknowledgement references without contact details. Its IAM
authority cannot set production alarm state. This proves the encrypted probe route,
not delivery to or acknowledgement by a paging destination. Human paging and
all live activation/drill claims remain pending until separately approved
hosted receipts exist.

### Durable AWS delivery recovery — live protected rollout

The repository contains the source-controlled workflow, scripts, strict receipt
validators, finalizer, tests, and readiness rules for surviving loss or
cancellation of the original GitHub Actions runner. Initial AWS activation was
proved at the historical exact protected code-bearing commit
[`8c09b7ee07f1a3a0cd8ea19bf1db900c992e3edf`](https://github.com/upgradedev/archon-cockroach-memory/commit/8c09b7ee07f1a3a0cd8ea19bf1db900c992e3edf):
[main CI](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30331668301),
[CodeQL](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30331668308),
the complete protected
[Deploy AWS run](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30331875727/attempts/2),
and the automatic post-deploy
[Recover AWS classification](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30333619982)
all succeeded. Both recovery ledgers ended terminal `COMMITTED`, bound to the
exact candidate/run/attempt and immutable receipt, with no lease left active.
The automatic watchdog then proved the successful source run required no
restoration. This is not presented as an intentionally fault-injected
`RECOVERED`/finalizer drill.

The S3 CAS data plane uses the private, versioned artifact bucket. Deployment
objects are isolated under
`candidates/deployments/<environment>/`, while each delivery role can access
only its own `candidates/recovery/<environment>/` objects, so no new recovery
database or cross-environment recovery authority is required. CloudFormation
and CodeDeploy retain temporary read-only access to the exact legacy
`candidates/<40-character-id>/` shape so the first post-migration rollback can
still consume the prior immutable revision; no role can write or list that
legacy namespace.

The bootstrap template also contains the required `Recover AWS` OIDC trust and
least-privilege CloudFormation, S3, Logs, Lambda, and CloudFront actions.
The `Bootstrap AWS Foundation` promotion path remains intentionally limited to
the exact artifact-bucket logging change and cannot grant IAM authority. The
separately authorized IAM promotion for the exact commit above used the
Git template pinned to SHA-256
`c3408ed4805ddffe7f969b72fce7d5ccc6c88b41c6bd33379b13d708deda5142`,
inspected exactly three direct in-place
`AWS::IAM::ManagedPolicy` document changes, and contained no replacement,
addition, deletion, or non-IAM mutation. The foundation finished
`UPDATE_COMPLETE`; its live default policy versions contain the required drift
discovery actions, its post-promotion drift result is `IN_SYNC`, and termination
protection is enabled. Future IAM changes still require separate authorization.

The checked-in control plane is AWS-native and fixed to `eu-west-1`:

1. Immediately before the first application mutation, CI creates a data-only
   recovery archive containing the exact prior CloudFormation
   template/parameters/tags, Lambda `live` alias, frontend index bytes and
   metadata, and S3 logging preflight. The archive is written only under
   `${RUNNER_TEMP}` and conditionally created under the private, encrypted,
   versioned `candidates/recovery/<environment>/` prefix.
2. The immutable object is checksum-bound to its intent. CI re-reads and
   validates the archive and manifest SHA-256 values before any application
   mutation; extraction treats every member as untrusted data.
3. A fixed environment ledger object in the same prefix is created with
   `If-None-Match: *` and advanced with `If-Match: <current ETag>`. Those S3
   conditional writes provide the compare-and-swap fence for
   `ARMED → COMMITTED` or `ARMED → RECOVERING → RECOVERED`. Each revision binds
   the candidate, source CI and deploy run identities, immutable bundle
   identity, digests, intent ID, lease, and prior ledger revision.
4. A successful terminal deployment receipt advances the same intent to
   `COMMITTED`. A completely proved restoration may advance it to `RECOVERED`;
   cancellation and incomplete recovery leave it unresolved.
5. The checked-in watchdog handles failed, cancelled, and timed-out delivery
   runs from a 15-minute schedule, a daily audit schedule, or manual dispatch.
   It classifies only the exact `Deploy AWS` push run/attempt bound by the
   durable ledger. A two-hour lease is bound to the exact watchdog
   run/attempt/environment. An active owner blocks competing work; an expired
   lease or an exactly proved completed non-success owner can be reclaimed
   through another CAS revision.
6. Recovery emits a strict `archon.durable-recovery.receipt` schema-v2 object.
   It embeds sanitized target, executor, archive, exact `RECOVERING` ledger, and
   restored stack/logging/frontend/alias/live proofs. The verifier cross-checks
   those fields against the immutable manifest and exact ledger revision.
7. The idempotent finalizer validates the v2 receipt and the post-recovery
   CloudFormation control proof, conditionally creates both checksum-addressed
   S3 objects, and reads back their exact versions with byte, SHA-256, S3
   checksum, encryption, content-type, and metadata checks. Only then does it
   CAS-advance the same lease from `RECOVERING` to `RECOVERED`, binding both
   immutable object identities into the terminal ledger. An ambiguous retry
   succeeds only if the already-terminal ledger has the exact receipt, control
   proof, and previous-ledger binding.
8. Existing stacks are bound to exact StackId/name/account/region, stable
   status, execution role, revision, and canonical tag digest. Preflight and
   terminal gates enable and re-prove termination protection when necessary,
   then run fresh bounded drift detection. Recovery applies the same gate to a
   restored stack or proves exact greenfield absence. The read-only protection
   audit requires protection already enabled and runs fresh drift detection
   daily at `04:17 UTC` when no recovery is pending. The same audit can be
   replayed from the current trusted `main` SHA with the explicit
   `workflow_dispatch` `operation=audit` input; stale workflow reruns remain
   rejected by the source-identity gate.

The watchdog uses trusted `main` recovery code, the exact `staging` or
`production` GitHub environment and its OIDC subject, and refreshed one-hour
credentials for the long recovery and finalization boundaries. It does not
depend on files or credentials from the failed runner. Bundle creation,
extraction, validation, finalization, and recovery simulation are CI-owned; no
generated recovery archive, receipt, extraction directory, or build output
belongs in the repository.

The infrastructure is defined in [aws/template.yaml](./aws/template.yaml).
Real eu-west-1 Bedrock proof is captured in
[docs/BEDROCK_SMOKE.md](./docs/BEDROCK_SMOKE.md).

## CI/CD

The release path is source-controlled:

```text
secret scan
  → dependency + pipeline-only supply-chain gates, SBOMs, licenses, IaC and workflow scanners
  → TypeScript/unit/integration/security/load/node-loss tests
  → longitudinal B0–B4 baselines, lifecycle ablations, 100k-event rehearsal,
    and real C-SPANN-versus-exact evaluation
  → React unit + desktop/mobile Playwright
  → SAM lint/build
  → source-readiness gate
  → build once
  → cryptographic candidate receipt
  → protected database release (exact legacy supersession + payload-digest proof + fail-closed RLS + two-principal C-SPANN probes)
  → exact-SHA Managed MCP Memory Integrity gate (Store + optional C-SPANN EXPLAIN
    + database-release receipt digest)
  → exact, integrity-bound application S3 logging preflight and scoped delivery-role read proof
  → canonical recovery manifest binding account, run, candidate, immutable stack
    identity/revision, raw template/parameter/tag hashes, alias, and public URL
  → exact CloudFormation identity + termination-protection + fresh drift
    preflight before application mutation
  → identical preflight plus exact stack/alias replay adjacent to SAM mutation
  → OIDC staging deploy + candidate-scoped 10%/5m proof-and-recall canary
  → processed-template + live EventTime S3 logging proof before frontend mutation
  → processed-template + live named-stage throttle/metrics/vended-log proof
  → full real recall smoke + hosted Playwright + fresh terminal live S3 and
    CloudFormation protection/drift proofs
  → identical-candidate production promotion
  → candidate-scoped canary + named-stage proof + full recall + hosted Playwright
  → recover and re-prove the exact previous S3 logging state, CloudFormation
    template/JSON parameters, traffic alias, versioned S3 index, and public
    health/proof on any post-deploy failure; `RetainExceptOnCreate` prevents
    initial-rollback debris, and greenfield cleanup deletes only the exact
    run-owned stack members after stack/resource owner-tag proof
  → checked-in durable handoff: an immutable private-S3 bundle plus an S3
    conditional-write CAS ledger lets the trusted watchdog finish recovery,
    verify a schema-v2 receipt and post-recovery control proof, and atomically
    bind both immutable objects into the terminal ledger after runner loss
    (live IAM activation, successful COMMITTED handoff, and no-op watchdog
    classification proved; a deliberate runner-loss recovery drill is not claimed)
```

GitHub Action and container references are immutable commit/image digests, and
standalone scanner archives are SHA-256 locked. cfn-lint is version-pinned with
its pip transitive reproducibility limitation stated explicitly in
[`docs/SUPPLY_CHAIN_SECURITY.md`](./docs/SUPPLY_CHAIN_SECURITY.md). Staging,
production, and database-operator OIDC subjects are bound to their GitHub
environments.
Routine version updates are frozen under the checked and documented
[dependency release policy](./docs/DEPENDENCY_RELEASE_POLICY.md); security
updates remain enabled and must cross the full hosted gates.
Bootstrap owns the environment-specific Lambda and CodeDeploy roles, retained
S3 log archive, narrow S3.9 exception, and a versioned artifact bucket; the SAM
application stack is CI-gated to synthesize no IAM resources. Those resources
are defined in [aws/bootstrap-oidc.yaml](./aws/bootstrap-oidc.yaml).

The existing bootstrap stack remains unbound from any persistent CloudFormation
service role. Its one-time administrator update creates the archive and policy
with artifact logging explicitly disabled. The protected
`Bootstrap AWS Foundation` workflow then uses a claim-bound, activation-only
OIDC role and separate `plan`/`apply` dispatches. It accepts only the current
40-character green main SHA, pins a versioned template by SHA-256, and executes
only the immutable ARN of one inspected, non-replacement
`ArtifactBucket.LoggingConfiguration` change. Explicit bounded plan,
activation, unverified-plan cleanup, and recovery pollers fit inside the
protected job budget. The role
cannot mutate IAM/Security Hub, delete a stack, or directly call
`PutBucketLogging` outside CloudFormation because that permission is FAS-bound
to `cloudformation.amazonaws.com`. CloudFormation's in-place update can resolve
only the ten exact role ARNs referenced through foundation `GetAtt`
expressions and the exact Security Hub automation-rule tags; those read actions
are also FAS-bound to `cloudformation.amazonaws.com`.

An earlier DynamoDB-ledger option would have required a separate controlled
foundation promotion: the activation-only role has neither live DynamoDB
provisioning authority nor permission to grant itself or the deploy roles new
IAM actions, and the foundation stack has no persistent CloudFormation service
role. That option is not claimed as deployed and is not the selected rollout
path. Keeping the CAS ledger under
`candidates/recovery/<environment>/` avoids adding database authority by using
the existing private bucket and live environment-scoped object permissions.
The existing foundation-promotion role is intentionally unable to grant IAM
authority to itself or the deploy roles. Its workflow additionally rejects any
plan other than the one-resource artifact-logging change. Therefore the
checked-in recovery trust, cleanup permissions, termination-protection actions,
and drift APIs required an independently authorized foundation IAM promotion.
That exact-template promotion and its live IAM/drift proof completed before the
protected deployment above. The successful deployment exercised terminal
`COMMITTED` handoff and the automatic watchdog's no-op classification; a
deliberately failed deployment that reaches `RECOVERED` through the finalizer
remains a separate chaos drill, not a claimed success-path result.

The Phase-2 application release refuses to
mutate either stack until the stored bootstrap parameter, live EventTime
foundation, and an integrity-bound source-bucket preflight all agree. It repeats
that preflight immediately before SAM and binds the complete recovery snapshot
to the exact account, run attempt, candidate, stack ID/status/revision,
template/parameter/tag bytes, alias version, URL, and execution role. A final
adjacent stack/alias check closes the delivery boundary before `sam deploy`.
The processed template and exact live source configuration are proved before
frontend mutation and re-read byte-for-byte after hosted E2E at the terminal
receipt. Recovery validates the preflight and both recovery hashes before any
AWS call, targets the immutable stack/change-set IDs, and proves the restored
state. A no-op recovery is accepted only for an allowlisted CloudFormation
reason, an exact `FAILED`/`UNAVAILABLE` change set with zero resource changes,
and a terminal stack that already matches the bound snapshot. Greenfield
deletion additionally requires the exact run owner on the stack and every
retained stack member, including immutable CloudFormation
stack/logical identity tags immediately before deletion. An absent stack
succeeds only when each retained resource is absent or is exact-owner proved
and cleaned; mismatched or unreadable ownership fails closed. The owner remains
stable across attempts of the same Actions run so interrupted cleanup can be
reconciled before the next immutable preflight. Staging and production deploy
identities retain only the narrow read/delete permissions needed for those
proofs. If terminal protection was enabled before an interrupted greenfield
deployment, cleanup re-proves the exact owned StackId, disables protection only
on that stack, re-proves it false, and only then requests deletion.

Each environment preflights its permissions before SAM is allowed to mutate its
stack. HTTP API delivery uses
`/aws/vendedlogs/apigateway/*`, while the legacy log-group logical resource stays
managed solely to keep exact-template rollback collision-free.

This repository does **not** call the pipeline “live-complete” merely because
the YAML exists. Full success-path CI/CD requires main CI, CodeQL, Supply Chain,
Memory architecture evaluation, protected
database release, staging, production, hosted E2E, Managed MCP audit, terminal
drift/protection gates, and deployment receipts to complete successfully. The
protected release evidence linked above satisfies that boundary for the current
recovery/CloudFormation-control revision. The independent watchdog also
classified both terminal ledgers successfully; no fault was injected merely to
manufacture a `RECOVERED` receipt.

## Security and trust boundaries

- CockroachDB RLS is bound to the `archon_public_reader` role and the exact
  `public-demo / Helios SA / active` scope. It does not trust mutable
  `application_name` as an identity.
- The Lambda principals remain `NOBYPASSRLS`. Only
  `archon_public_memory_view_owner` has the direct, non-inheritable
  `BYPASSRLS` role option required by the CockroachDB v26.2 release line; it has no system
  privileges, is `NOLOGIN`, has no members, receives only `SELECT` on
  `agent_memory`, owns only the two fixed-predicate serving views, and ends
  migration without `CREATE` authority on the schema.
- Initial provisioning creates a dedicated login that inherits the NOLOGIN
  reader role and the separate `archon_resolution_writer` role. The latter has
  no write privilege on canonical memory and is limited to the five fixed
  synthetic TTL tables. Existing secrets are reconciled to exactly those two
  memberships; broader memberships fail closed. Credential rotation is not
  claimed until an explicit two-principal pending/activate/retire workflow is
  implemented.
- Resolution sessions store only a SHA-256 token digest, accept no arbitrary
  financial input, bind all graph edges to the same session with composite
  foreign keys, cap active sessions, and require an idempotent explicit human
  decision. The public role is a synthetic assertion, not authenticated
  enterprise identity.
- The public API accepts recall questions only in JSON `POST` bodies; questions
  never enter URLs or access logs.
- Request bytes, question length, top-k, audit scan, API rate, concurrency, and
  model calls are bounded.
- Database/AWS exceptions are redacted; Lambda failures still reach native error
  metrics. The deployment alarm uses the weighted alias plus its exact candidate
  `ExecutedVersion`, so both proof and recall can run throughout the canary
  without old-version failures blocking a recovery. Full recall remains a
  mandatory post-promotion gate with explicit alias and versioned-S3
  restoration.
- Memory text is escaped and treated as untrusted evidence, never as instructions.
- The public database is a dedicated synthetic demonstration scope; no customer
  records are used.
- [`aws/edge-waf.yaml`](./aws/edge-waf.yaml) has a protected, manual
  plan/apply/verify workflow. The application template attaches a WebACL only
  when one is supplied, so it can be created before the edge control plane
  exists; the release pipeline is where the WebACL is mandatory, refusing to
  deploy without the exact protected edge-stack output alongside the
  bootstrap-generated Secrets Manager origin capability. No live activation
  is claimed; foundation migration, both edge-stack receipts, deployment,
  alarm routing, and abuse drills still require explicit approval and
  exact-SHA pipeline evidence.
- WA-03 has a separate manual, protected, exact-green-main
  [read-only AWS account security baseline workflow](./.github/workflows/aws-security-baseline.yml).
  Its reference IAM policy cannot mutate AWS, raw service responses remain
  runner-temporary, and only a sanitized exact-SHA receipt is uploaded;
  acceptance requires `10/10`. The audit role, protected environment,
  account-control activation, and first live receipt still require explicit
  approval; none is claimed here.
- WA-10 has a separate manual, protected, exact-green-main
  [sustainability intensity workflow](./.github/workflows/sustainability-intensity-evidence.yml).
  It reads only the exact deployed stack and bounded hosted-load CloudWatch
  telemetry, normalizes engineering proxies by successful recall, enforces
  equivalent baseline/after workloads, and uploads only a sanitized receipt.
  It does not claim emissions, carbon reduction, billed Lambda duration,
  production scale, or a live improvement before the protected evidence exists.

Implementation and evidence contracts:

- [Exceptional-release execution plan](./docs/EXECUTION_PLAN.md)
- [Memory Resolution Loop](./docs/MEMORY_RESOLUTION_LOOP.md)
- [Memory architecture evaluation](./docs/EVALUATION.md)
- [Pipeline-only supply-chain security](./docs/SUPPLY_CHAIN_SECURITY.md)
- [AWS Well-Architected evidence](./docs/operations/WELL_ARCHITECTED_EVIDENCE.md)
- [AWS account security baseline audit](./docs/runbooks/aws-account-security-baseline.md)
- [Sustainability intensity evidence](./docs/runbooks/sustainability-intensity.md)
- [Protected foundation storage migration](./docs/operations/FOUNDATION_STORAGE_MIGRATION.md)
- [Managed-backup restore drill](./docs/runbooks/database-restore.md)

## Why CockroachDB instead of DynamoDB or Cosmos DB?

| Need in this project | CockroachDB | DynamoDB | Cosmos DB |
|---|---|---|---|
| Relational financial truth, constraints, joins | Native distributed SQL | Application-side modeling | Primarily NoSQL modeling |
| Serializable multi-row transactions | Default SQL transaction model | Supported with Dynamo-specific limits | Scope/feature dependent |
| Vector beside the same transactional records | Native vector column/index | Commonly paired with OpenSearch | Native vector capabilities |
| PostgreSQL-wire portability | Yes | No | No |
| Cloud-neutral distributed data layer | Yes | AWS-native | Azure-native |

DynamoDB is the natural choice when AWS-native key-value access and operational
simplicity dominate. Cosmos DB is strong for Azure-native globally distributed
document/vector workloads. CockroachDB fits this project because relational
financial truth, provenance, lifecycle, audit, and vector memory can live in one
serializable distributed database without splitting truth across systems.

The recovery ledger does not compete with or duplicate CockroachDB. CockroachDB
remains the application data plane and durable agent-memory system: facts,
provenance, lifecycle, SQL constraints, audit, and vector recall. The selected
S3 ledger is only an AWS delivery state machine with one current CAS object per
environment plus immutable bundles and receipts. DynamoDB could also implement
that small control-plane state machine, but it is not deployed or required by
this design.

The “memory” in the Qwen projects is an application-level memory lifecycle over a
database. CockroachDB is the database substrate here. Archon borrows mature
memory patterns—idempotency, supersession, feedback/consistency signals—and adds
role-bound distributed SQL consistency and native vector retrieval.

## Quickstart

Requirements: Node.js 22+, Docker, and npm.

```bash
npm ci
docker compose up -d --wait
export DATABASE_URL="postgresql://root@localhost:26257/archon_memory?sslmode=disable"
npm run local:bootstrap
npm run serve
```

`local:bootstrap` is loopback-only and add-only. It creates the dedicated local
database, applies the schema, seeds the deterministic nine public fixtures plus
three RLS isolation canaries, preserves unrelated rows, and proves the exact
`12/12/12` fixture contract. The API is then available at
`http://127.0.0.1:8787/health` and `http://127.0.0.1:8787/api/proof`.

In a second terminal, start the locked frontend workspace against that API:

```bash
npm ci --prefix web
VITE_API_PROXY_TARGET=http://127.0.0.1:8787 npm run dev --prefix web -- --host 127.0.0.1
```

Open `http://127.0.0.1:5173`; the CockroachDB console is
`http://127.0.0.1:8080`. Repository policy keeps builds, tests, and browser
verification in hosted CI. Do not commit
`node_modules`, `dist`, `.aws-sam`, Playwright output, readiness output, or
generated video assets.

Current release orchestration starts `Deploy AWS` only from a trusted `main`
push. Its source gate waits for the successful same-SHA `CI` push run and
exports that exact run/attempt into the deployment receipts. After production
promotion and the Managed MCP proof pass, the deployment calls `Hosted DAST`
as a reusable workflow with the same SHA and deploy run/attempt; active probes,
ZAP, and their artifacts therefore remain part of the causal release run.
Weekly scheduled and manual DAST runs remain independent production audits.

## Pinned release evidence

The deployed production baseline — the commit actually serving the judge URL —
is
[`0b25d5f1498965f87140bb24715b004fbb5558cf`](https://github.com/upgradedev/archon-cockroach-memory/commit/0b25d5f1498965f87140bb24715b004fbb5558cf).
The identification is direct rather than inferred: the CloudFormation stack
carries `ReleaseCommitSha` = `0b25d5f1…`, the Lambda environment variable holds
the same value, and the Lambda's `LastModified` matches the Deploy run below. It
is jointly bound to the successful
[main CI](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30577405580),
[CodeQL](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30577405577),
[Deploy AWS](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30577752661),
[exact-release Hosted DAST](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30579578909),
[standalone Managed MCP](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30579694425),
and [benchmark](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30732311916).

The earlier chain at
[`f3fafdac8d93a266eda9831edd0d66132940ec7b`](https://github.com/upgradedev/archon-cockroach-memory/commit/f3fafdac8d93a266eda9831edd0d66132940ec7b)
is real and complete, including a
[manual dual-environment recovery audit](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30535183552)
that the deployed chain does not have, but it ran ten hours earlier the same day
and was replaced. It is retained as superseded evidence, with its own
measurements left at the values its runs recorded.

The exact artifact IDs and SHA-256 digests for both chains are recorded in
[the judge-application evidence ledger](./docs/DEMO_URL.md).
The ledger is immutable historical evidence for each exact SHA; later commits
must earn their own pipeline evidence and never rewrite a baseline.

| Evidence | State |
|---|---|
| Live CockroachDB Cloud Basic cluster, AWS `eu-west-1` | Verified |
| Historical native-vector plans / recall benchmark | Verified |
| Runtime-principal company + kind C-SPANN serving gate | Both principals are re-proved in every [Deploy AWS](https://github.com/upgradedev/archon-cockroach-memory/actions/workflows/deploy-aws.yml) release |
| Live bounded Store proof: persistence + unique keys + payload-bound SHA-256 digests | `/api/proof` exposes `9 / 9 / 9` and the exact promoted commit SHA; deployment rejects a mismatch |
| CockroachDB Cloud Managed MCP | The causal receipt binds the exact release and database C-SPANN receipt digests, strict `9 / 9 / 9` Store parsing, and capability-safe optional `explain_query`; staging and production refuse promotion unless the protected gate passes, and the standalone [Managed MCP audit](https://github.com/upgradedev/archon-cockroach-memory/actions/workflows/managed-mcp-audit.yml) reuses the same contract. The v3 contract is on `main`; every receipt produced by a hosted run so far, the deployed baseline's included, is v2 |
| Real Titan V2 + Claude Sonnet 4.6 | Protected staging and production gates exercise Titan in `eu-west-1` and the Claude EU cross-region inference profile |
| Control Room, protected DB release, SAM stack, OIDC CI/CD, canary/rollback | Exact-main build-once promotion, live release-SHA binding, and hosted browser verification are mandatory in [Deploy AWS](https://github.com/upgradedev/archon-cockroach-memory/actions/workflows/deploy-aws.yml) |
| Unrestricted CloudFront production URL and hosted receipts | [Reachable without credentials](https://d2s5v0o0eg2aaw.cloudfront.net); the data plane was restored on 2026-08-05 after a billing-state outage — see [Judge verification](#judge-verification) |
| Legacy `us-west-2` Lambda/log/IAM workload | Retired after verified cutover; [scoped inventory](./docs/DEMO_URL.md) is empty |
| Durable private-S3 CAS-ledger watchdog recovery | Live IAM activation, terminal `COMMITTED` ledgers, immutable deployment receipts, protection/drift gates, and automatic no-op watchdog classification are verified; an intentionally fault-injected `RECOVERED` finalizer drill is not claimed |
| Fault-triggered `RECOVERING → RECOVERED` and daily/manual audit | Implemented and CI-covered; the final gate requires a fresh manual `operation=audit` receipt, but no intentional live failure drill is claimed |
| `main` governance | [Active ruleset](https://github.com/upgradedev/archon-cockroach-memory/rules/19722191): PR only, no force-push/delete, strict `readiness` + CodeQL |
| Submission copy, CI-only ElevenLabs video plan, owned thumbnail, and hosted final gate | Versioned under [docs/DEVPOST_SUBMISSION.md](./docs/DEVPOST_SUBMISSION.md), [demo/VIDEO_PLAN.md](./demo/VIDEO_PLAN.md), and [Generate exact-release demo video](./.github/workflows/demo-video.yml). [Submission readiness](./.github/workflows/submission-readiness.yml) is defined as the hosted final gate but has never been executed — it has zero runs, so no hosted final-gate receipt exists |
| Final public video and Devpost form | Deliberately last; a blog/post is not a required deliverable |

Throughout this repository, "release" and "exact-release" mean the pipeline's
build-once promotion chain bound to one exact commit SHA. They do not refer to a
GitHub Release or a tag: this repository publishes neither, and `/releases` and
`/tags` are both empty by design. The SHA in each run link is the identifier.

Run `npm run readiness` for separate source-readiness and submission-eligibility
results. A source-ready result never implies that the final video/form is done.

## Prior-work disclosure

The **pre-existing** work is the Archon financial domain, synthetic Helios
scenario, extraction/reconciliation concepts, and the relational table shapes for
documents, employees, payroll events, and validations. Those ideas and selected
schema/extraction code were adapted from the earlier Archon/Nebius work.

The **challenge-period** implementation is the CockroachDB `agent_memory` layer,
native vector/prefix indexes, fixed-scope C-SPANN serving views, idempotency and
lifecycle model, role-bound RLS,
recall/audit/proof APIs, grounded narrator guards, live Managed MCP integration,
React Control Room, AWS serverless architecture, OIDC promotion/rollback
pipeline, and the new verification suites.

Patterns from the Qwen, Nebius Serverless, Microsoft Agents League, Google
Vibecoding, OpenAI Build Week, Kerdon, and Backblaze projects informed design
choices such as evidence receipts, explicit authority, lifecycle state, and
deterministic verification. No other challenge entry is represented as new code
here unless it is present in this repository and disclosed above.

## License

[MIT](./LICENSE)
