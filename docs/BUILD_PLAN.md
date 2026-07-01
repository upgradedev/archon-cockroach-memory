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
4. Tool-identification doc (which CockroachDB tools + AWS services, implementation detail) — README "features used" tables + `docs/TOOLS.md` (roadmap).
5. Optional: architecture diagram (✅ in README) + feedback on CockroachDB AI tools.

## Judging criteria → where we score
| Criterion | Our play |
|---|---|
| Agentic Memory Design | Production-grade: durable, distributed VECTOR index, prefix-partitioned recall, metadata-rich memories. |
| Technical Implementation | Injectable embedder, pg-wire reuse of a real schema, typed, tested. |
| Real-World Impact | Consolidated P&L/EBITDA/cash for SMBs, plus completeness checks that catch missing or inconsistent records (e.g. a bank payment with no matching invoice) — and, as one worked example, the ~28% understatement of true workforce cost. Genuine problems. |
| Production Readiness | CockroachDB survivability/consistency; TLS Cloud path; observability probes (memoryCount). |
| Creativity & Originality | "Financial-close agent with long-term semantic memory of every fused event." |

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
- ⏳ Real Titan + real Claude Sonnet smoke test still needs AWS creds (Bedrock account 308857099262; confirm Titan-embed-v2 + Sonnet enabled in `BEDROCK_REGION`).

## Timeline to Aug 18
- **Session 3:** Deploy agent API on AWS (Lambda or ECS) + CockroachDB Cloud Serverless (ccloud) → public demo URL. `provision-cluster.sh` live run. Real-Bedrock smoke test.
- **Session 4:** Cloud MCP Server as a memory-recall tool (stretch 3rd feature). Observability/security hardening (connection TLS verify-full, secrets).
- **Session 5:** Record < 3-min video, tool-identification doc, Devpost submission form.

## User inputs required (blockers for later sessions)
- CockroachDB Cloud account + Serverless cluster connection string (or `CCLOUD_API_KEY` for `provision-cluster.sh`).
- AWS creds with Bedrock access (we have the H0 account: 308857099262) + confirm Titan V2 + Claude Sonnet enabled in `BEDROCK_REGION` (us-west-2 verified for Claude; confirm Titan-embed-v2).
- Hosting choice for the demo URL (AWS Lambda vs ECS; or reuse Vercel front from H0 calling an AWS-hosted agent API).
