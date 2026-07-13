# Archon Memory — Build Plan (CockroachDB × AWS AI Hackathon)

**Deadline:** 2026-08-18 17:00 EDT · **Prize:** $8,750 ($5k / $2.5k / $1.25k) · **Devpost:** cockroachdb-ai.devpost.com

## Thesis / fit
Archon is already an agentic multi-agent financial-intelligence app. CockroachDB is Postgres-wire compatible, so Archon's Postgres schema ports in nearly drop-in; we already run Archon on AWS with Bedrock (the H0 build). The differentiator we build here: **CockroachDB as the agents' persistent memory** — every financial event/document/extracted-fact stored + **vector-indexed** for RAG-style semantic recall, on AWS Bedrock.

## Required-tech lock
- **CockroachDB (≥2 of 4):** ✅ **Distributed Vector Indexing** (the star — it *is* the memory story) + ✅ **ccloud CLI** (cheap, provisions the Cloud cluster). Stretch: Cloud Managed MCP Server (expose recall as an MCP tool).
- **AWS (≥1):** ✅ **Amazon Bedrock** (Titan V2 embeddings + Claude Sonnet extraction/narration). Roadmap: Lambda/ECS to host the agent API.

## Submission deliverables (from the rules)
1. Public repo, MIT/Apache-2.0, README + setup/run instructions — **this repo (MIT).**
2. Functional demo app URL — *roadmap (deploy on AWS + public URL).*
3. Public video < 3 min demonstrating the CockroachDB memory layer — *roadmap.*
4. Tool-identification doc (which CockroachDB tools + AWS services, implementation detail) — README "features used" tables + `docs/TOOLS.md` (done).
5. Optional: architecture diagram (✅ in README) + feedback on CockroachDB AI tools.

## Judging criteria → where we score
| Criterion | Our play |
|---|---|
| Agentic Memory Design | Production-grade: durable, distributed VECTOR index, prefix-partitioned recall, metadata-rich memories. |
| Technical Implementation | Injectable embedder, pg-wire reuse of a real schema, typed, tested. |
| Real-World Impact | Consolidated P&L/EBITDA/cash for SMBs, plus completeness checks that catch missing or inconsistent records (e.g. a bank payment with no matching invoice) — and, as one worked example, the ~72% understatement of true workforce cost (of which the employer social-security wedge alone is ~35%). Genuine problems. |
| Production Readiness | CockroachDB survivability/consistency; TLS Cloud path; observability probes (memoryCount). |
| Creativity & Originality | "Financial-close agent with long-term semantic memory of every fused event." |

> **Reconciling the workforce-cost percentages** (they use different denominators, so they are not contradictory): the two platform-measured, ground-truth figures are **~72% = full off-bank gap ÷ bank net** (the bank transfer understates true employer cost by ~72%) and **~35% = employer social-security wedge ÷ bank net** (the wedge is ~half of that full gap). The **~36%** in [`docs/BEDROCK_SMOKE.md`](./BEDROCK_SMOKE.md) is a *different ratio on a different, synthetic toy example* — Claude's own answer expressing the off-bank gap as a share of **true cost** (€22,800 ÷ €63,800), not of bank net — and it is a frozen verbatim capture, so it is left as the model produced it. The synthetic demo event (`scripts/demo-memory.ts`) likewise carries its own internally-consistent ratios (its `cost_gap_pct` is the wedge ÷ bank net for *those* toy magnitudes), separate from the measured platform figures above.

## Architecture (memory layer)
`Agent → MemoryAgent.remember(fact)` → Bedrock Titan embeds → `agent_memory(content, metadata, embedding VECTOR(1024))` in CockroachDB.
`Agent → MemoryAgent.recallAnswer(question)` → embed question → `ORDER BY embedding <=> $q` over the distributed vector index (pre-filtered by kind/company prefix cols) → top-k grounds the answer.

## Reuse map
- `src/db/schema.sql` ← ported from `repos/nebius/backend/db/schema.sql` (documents/employees/payroll_events/validation_results 1:1) + new `agent_memory`.
- `src/extraction/bedrock.ts`, `src/extraction/types.ts` ← from `tmp/h0-archon/lib` (Bedrock Converse wrapper + domain types).
- New: `src/memory/*`, `src/agents/memory-agent.ts`.

## Indexing notes (verified on v26.2.2)
CockroachDB vector indexes accelerate a query only when it matches the index shape. EXPLAIN findings:
- A **global** `CREATE VECTOR INDEX (embedding vector_cosine_ops)` → an unscoped `ORDER BY embedding <=> $q LIMIT k` plans a **`vector search`** node (accelerated).
- A **prefix** index `(kind, company, embedding)` only accelerates when BOTH `kind` and `company` are equality-constrained; a company-only or unfiltered query falls back to FULL SCAN — and it forbids the cross-company semantic recall the memory layer needs.
- **Decision:** ship the **global** index (flagship semantic recall is accelerated), keep btree indexes on `kind`/`company`/`period` for scoped pre-filtering. Per-tenant prefix vector indexes are a scale-time optimization (session 4).

## Status (session 1 — DONE)
- ✅ Repo scaffolded (README, MIT, .gitignore, .env.example, package.json, tsconfig, docker-compose).
- ✅ Schema ported + `agent_memory` VECTOR(1024) + `CREATE VECTOR INDEX` — **verified running on CockroachDB v26.2.2** (local Docker single node).
- ✅ Memory layer: `remember()` / `recall()` (cosine ANN) + injectable Titan/Fake embedder.
- ✅ `MemoryAgent` write (ingestEvent) + read (recallAnswer) path.
- ✅ `npm run db:schema` + `npm run memory:demo` run end-to-end against live CockroachDB; recall ranks correctly.
- ✅ `npm test` green (5 tests, no infra); typecheck clean.

## Status (session 2 — DONE)
- ✅ **Bedrock Claude narrator** (`src/agents/narrator.ts`): `Narrator` interface + `BedrockNarrator` (real RAG via `converse()` → Claude Sonnet `us.anthropic.claude-sonnet-4-6`, grounds + cites recalled memories) + deterministic offline `FakeNarrator` (mirrors `FakeEmbedder`; auto-selected when no AWS creds). Short-circuits to a no-memory answer without a model call on empty recall.
- ✅ **Agentic path wired end-to-end:** `MemoryAgent(embedder, narrator)` — `ingestEvent` (embed + remember fused events) → `recallAnswer` (vector recall → narrate). `recallAnswer` now returns `{ answer, hits, citations, modelId }`.
- ✅ Demo (`npm run memory:demo`) ingests fused events + a completeness finding → asks e.g. *"What was our real cost of employing the team last month?"* and *"Are there any payments without a matching invoice?"* → grounded answers citing the stored events (the €22,800 workforce-cost wedge) and the flagged missing-invoice inconsistency. Works offline (FakeEmbedder+FakeNarrator) and with real Bedrock (creds swap).
- ✅ Tests: `tests/narrator.test.ts` (offline — FakeNarrator grounding/citations, BedrockNarrator w/ canned Converse client, empty-recall short-circuit, offline auto-select) + `tests/pipeline.test.ts` (DATABASE_URL-gated recall→narrate integration over the live vector index, offline fakes). `npm test` = 12 tests: 10 pass / 2 skip offline, **12/12 with a DB (as in CI)**; typecheck clean.
- ✅ **Real Titan + real Claude Sonnet smoke test — DONE** (Bedrock account 308857099262, `us-west-2`): a real 1024-dim unit-length Titan V2 embedding + a real Claude Sonnet Converse RAG answer (grounded, `[1]`/`[2]` citations) captured verbatim in [`docs/BEDROCK_SMOKE.md`](./BEDROCK_SMOKE.md); re-runnable via the gated `tests/bedrock.integration.test.ts` (`RUN_BEDROCK_IT=1`), which skips cleanly offline so CI stays creds-free.

## Status (session 3 — DONE)
- ✅ **Benchmark harness** (`scripts/benchmark.ts`): recall@k vs JS brute-force ground truth,
  write throughput, p50/p95/p99 latency, and a `vector_search_beam_size` sweep. Representative
  **clustered** corpus + **uniform** worst case; dense unit vectors via `RandomEmbedder`/
  `unitGaussianVector` (deterministic, offline). Destructive-guard refuses non-ephemeral DBs.
- ✅ **Numbers** (`docs/BENCHMARK.md`): recall@10 bracket **96.5% (uniform, worst case) → ~99%
  (structured)**; beam sweep 29%→96.5% is the index-quality evidence (recall vs search effort);
  clustered recall robust across a noise sweep (0.35–2.0). All EXPLAIN-verified `vector search`.
  Honest framing: report the range + beam curve, don't anchor on the single 99.6%.
- ✅ **Distribution + survivability** (`docker-compose.cluster.yml` + `scripts/show-distribution.sh`):
  3-node cluster, 11 ranges RF=3 across all nodes, 3 distinct leaseholders, vector index range
  replicated {1,2,3}, `vector search` plan on the cluster.
- ✅ **Live Cloud verified** — recall + `vector search` EXPLAIN on the Serverless cluster (v25.4.10,
  eu-west-1) via the console connection string.
- ✅ **CI**: benchmark recall-floor smoke added to `ci.yml`; full benchmark + 3-node distribution
  in `benchmark.yml` (workflow_dispatch, non-gating, artifacts). Unit tests 5→8; suite 12→15.
- ✅ **Tool-identification doc** (`docs/TOOLS.md`) — required submission deliverable.
- Honest framing: no latency/recall win claimed vs single-node pgvector; the claim is
  architectural (native distributed index + RF=3 survivability + scale-out).

## Timeline to Aug 18
Done through session 3 (schema+memory, narrator, benchmark+distribution+fan-out, live-Cloud
verify, tool-identification doc, real-Bedrock smoke). Remaining:
- **Deploy:** agent API on AWS (Lambda or ECS) → public demo URL. Cloud cluster already live
  (`archon-cockroachdb-cluster-27534`, AWS eu-west-1); `provision-cluster.sh` reuses it.
- **Video:** < 3-min demo of the CockroachDB memory layer (a reproducible terminal-cast build
  lives in `demo/`).
- **Built (self-hosted MCP surface):** the memory is exposed as a self-hosted MCP server
  (`src/mcp/server.ts`, `recall`/`audit`/`remember` tools, CI round-trip in `tests/mcp.test.ts`).
  This is an honest agentic surface, **not** the hosted *Cloud Managed MCP Server* required-feature
  box — so we still count 2 of the 4 required CockroachDB features.
- **Stretch:** wire the hosted CockroachDB Cloud Managed MCP Server (console-generated creds) as
  the hosted counterpart to the self-hosted surface.
- **Submit:** Devpost form + public repo + demo URL + video.

## User inputs required (blockers for later sessions)
- CockroachDB Cloud account + Serverless cluster connection string (or `CCLOUD_API_KEY` for `provision-cluster.sh`).
- AWS creds with Bedrock access (we have the H0 account: 308857099262). Titan V2 + Claude Sonnet both verified enabled + invoked in `BEDROCK_REGION=us-west-2` (see `docs/BEDROCK_SMOKE.md`).
- Hosting choice for the demo URL (AWS Lambda vs ECS; or reuse Vercel front from H0 calling an AWS-hosted agent API).
