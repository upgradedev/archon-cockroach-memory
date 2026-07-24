# Judge State — 2026-07-13

> **SUPERSEDED HISTORICAL SNAPSHOT.** This file records the repository on
> 2026-07-13 and must not be used as current readiness evidence. The canonical
> current state is [README.md](../README.md), [TOOLS.md](./TOOLS.md), and CI
> deployment receipts. Video, public demo, and Managed MCP claims below describe
> what was true on that date; video/post/submission are currently deferred to the
> final phase.

> **Purpose.** A durable snapshot of where this entry stands against the judging bar after
> the 2026-07-12/13 judgment review and the merged fixes (PRs #7–#11). It records the current
> per-criterion self-assessment, the discrepancies those PRs closed, and the ranked path to
> push the score *above* the target bar. At that date, video and blog/post were
> incorrectly treated as ready-to-submit; the current documentation supersedes
> that assumption.

## 1. Challenge + target

| | |
|---|---|
| **Challenge** | CockroachDB × AWS AI Hackathon ([cockroachdb-ai.devpost.com](https://cockroachdb-ai.devpost.com)) |
| **Deadline** | 2026-08-18 |
| **Rubric axes** | **CockroachDB-depth** (load-bearing for a DB-sponsor hackathon) · AWS integration · technical · reproducibility · submission-completeness |
| **Target bar to exceed** | **> 9.5 / 10** |
| **Current judged score (build)** | **~8.8** — lifted from the earlier build baseline by merged PRs #7–#11 |

## 2. Current judge score — per criterion

| Criterion | Score | Basis (verified in repo) |
|---|---|---|
| **CockroachDB-depth** | **9.5** | Real native distributed vector index — **C-SPANN, not pgvector** (`CREATE VECTOR INDEX … vector_cosine_ops` in `src/db/schema.sql`). `EXPLAIN` plans a `vector search` node on local v26.2.2, the 3-node cluster, and live Cloud v25.4.10 (`docs/CLOUD_SMOKE.md`). Recall@10 benchmarked 96.5%→99.6% (`docs/BENCHMARK.md`). RF=3 on every range + leaseholders across 3 nodes. Multi-range ANN fan-out demonstrated (`docs/BENCHMARK.md` Result 3b). Not vanilla Postgres. |
| **AWS integration** | **~8.5** | Historical `us-west-2` Bedrock verification (account identifier redacted); see the dated capture in `docs/BEDROCK_SMOKE.md`. At that date there was no AWS-hosted demo URL. |
| **Technical** | **9** | Layered memory/agents/extraction, injectable offline fakes, full test pyramid (unit + live-CRDB integration + e2e), CI green (gitleaks + CodeQL + CockroachDB smoke). |
| **Reproducibility** | **9** | README quickstart, `npm run` harnesses (`db:schema`, `memory:demo`, `benchmark`, `fanout:demo`), `show-distribution.sh`, `provision-cluster.sh`; offline path runs with no AWS creds; both smoke docs give exact reproduce steps. |
| **Submission-completeness** | **gap** | Still the weakest axis — no public demo URL and the Devpost submission form is not yet filed. |

## 3. Discrepancies fixed this session (merged PRs)

All confirmed merged to `main` (`gh pr list --state merged`) and present in history:

| PR | What it fixed | Verified |
|---|---|---|
| **[#7](https://github.com/upgradedev/archon-cockroach-memory/pull/7)** — judge-credibility polish | Wording (`pgvector`→CockroachDB C-SPANN vector rows), figures (old ~28% → **~72% full / ~35% employer wedge**), feature count, test wiring. Also carried the real prod-bug fix (below). | ✅ `500c498` |
| **[#8](https://github.com/upgradedev/archon-cockroach-memory/pull/8)** — README depth-foregrounding | README now leads with CockroachDB-depth evidence + the "self-auditing tests caught a real prod bug" story. | ✅ `abe6f99` |
| **[#9](https://github.com/upgradedev/archon-cockroach-memory/pull/9)** — Bedrock runs for real | Proves the AWS Bedrock integration executes against real AWS (Titan V2 1024-dim + Claude Sonnet 4.6, us-west-2); evidence in `docs/BEDROCK_SMOKE.md` + gated integration test. | ✅ `b57f3a1` |
| **[#10](https://github.com/upgradedev/archon-cockroach-memory/pull/10)** — multi-range ANN fan-out | Deterministic demonstration via enforced `ALTER TABLE … SPLIT AT`: one unscoped recall fans out across ≥2 KV ranges, correct top-k, `vector search` plan. `scripts/fanout-demo.ts` + `tests/fanout.test.ts` (CI-gated). | ✅ `8c184e4` |
| **[#11](https://github.com/upgradedev/archon-cockroach-memory/pull/11)** — judgment-review harmony | Reconciled remaining judgment-review findings + demo video. | ✅ `da4c042` |

**Real production bug caught by committing the tests** (confirmed in history — `e82a617`, rolled into PR #7): `recall()` passed the raw `created_at` column straight through, while `listForAudit()` normalized it. The `pg` driver returns a `TIMESTAMP` as a JS `Date`, so on the **real CockroachDB** path a recalled memory carried a `Date`; when a no-importance contradiction reached the recalled top-k, the consistency resolver's recency branch called `createdAt.slice(0,10)` and threw `slice is not a function` — invisible against the string-returning offline mock. Root-fixed by normalizing in `recall()`, and the mock (`tests/db_mock.ts`) was made faithful (returns a `Date`) so the class of bug is now caught offline.

## 4. Path to exceed the target (> 9.5) — ranked (excludes video + blog/post)

1. **[USER-only creds/deploy] Stand up an AWS-hosted demo URL** (Lambda or ECS recall API). *Highest leverage* — lifts the two weakest axes at once (AWS integration + submission-completeness). Note: no handler exists in `src/` yet — the AWS deploy is a roadmap item (unchecked in the README roadmap), so this is a build-then-deploy, not just a deploy.
2. **[USER-only creds/deploy] Run the node-kill survivability demo once on the 3-node cluster.** `scripts/show-distribution.sh` (over `docker-compose.cluster.yml`) contains a live `docker stop roach3` → re-run-recall → restart sequence, but it has **never been RUN/captured** — `docs/BENCHMARK.md` Result 3 only shows the `SHOW RANGES` RF=3 table, not the node-kill serving output. Running it + capturing the "STILL served N memories after roach3 stopped" output turns the RF=3 survivability claim from **asserted → demonstrated** (CockroachDB-depth).
3. **[CODE/buildable] Wire the real CockroachDB Cloud Managed MCP Server** as a 3rd CockroachDB feature. Currently the feature table reads **"2 of 4"**; landing this moves it to **"3 of 4"** and pushes CockroachDB-depth toward 10. Roadmap item in README + TOOLS.md ("stretch/partial").
4. **[CODE/buildable] Optionally capture a Titan/Claude cost + latency table** into `docs/BEDROCK_SMOKE.md` from a slightly larger real run — marginal, strengthens AWS integration evidence.

## 5. Verified-harmonized (no action needed)

- **Figures consistent** — `~72%` full payroll-cost understatement / `~35%` employer social-security wedge across README, write path, and narrator grounding (old inconsistent `~28%` scrubbed). The BEDROCK_SMOKE real answer's "roughly 36%" is the model narrating one specific fixture (22,800 / 63,800), consistent with the ~35% wedge.
- **C-SPANN, not pgvector** — wording is truthful and consistent in README, TOOLS.md, and BENCHMARK.md; the index is CockroachDB's own native distributed vector index, EXPLAIN-verified.
- **Feature count consistent** — "**2 of 4** required CockroachDB features" stated identically in README and `docs/TOOLS.md`.
- **Bedrock real-run linked** — `docs/BEDROCK_SMOKE.md` is referenced from README + TOOLS.md; the live Cloud capture (`docs/CLOUD_SMOKE.md`) is referenced from the depth section.
- **Multi-range fan-out** — demonstrated (`docs/BENCHMARK.md` Result 3b, `scripts/fanout-demo.ts`, CI-gated `tests/fanout.test.ts`), no longer merely asserted.
- **Self-auditing memory** — read-only guarantee proven end-to-end against a live cluster (`tests/consistency.e2e.test.ts`), detection + resolution measured offline with zero false positives (`tests/consistency.test.ts`).
