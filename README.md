# Archon Memory — CockroachDB × AWS

**Entry for the CockroachDB × AWS AI Hackathon** ([cockroachdb-ai.devpost.com](https://cockroachdb-ai.devpost.com))

An agentic financial-intelligence application that uses **CockroachDB as the agents' persistent memory layer**, running on **AWS Bedrock**.

Archon is a **unified financial-intelligence platform**: it ingests *all* of a small business's financial documents and data — sales and purchase invoices, orders, receipts, payments, bank transfers and statements, payroll, expenses — into one environment and produces a consolidated, period-over-period picture: P&L, EBITDA, cash, workforce cost, and the metrics behind them. Crucially, it also **cross-checks the whole picture for missing or inconsistent information** — for example, a vendor payment on the bank statement with no matching invoice (did the vendor never send it? did the accountant never register it? is the payment wrong?), or the fact that a bank salary transfer understates the *true* cost of employing a team by ~72% (measured) — the employer social-security contributions it never shows are alone ~35% of that true cost. This entry gives Archon's agents a **memory**: every extracted document, fused financial event, validation finding, and narrated insight is embedded and stored in CockroachDB, then **recalled by meaning** on later runs — so the agents reason with continuity instead of starting cold on every upload. And because that memory accumulates across many independent sessions, the agent also **audits its own memory**: it scans everything it has stored for cross-session *contradictions* (two sessions that remembered one record differently) and *dangling references* (a memory pointing at a record it never stored), and **recommends which value to trust** — read-only, at distributed-vector scale.

## Why this is real CockroachDB depth, not vanilla Postgres

The load-bearing question for this entry is whether it exercises the features that make
CockroachDB *distinct* — not just Postgres-over-the-wire. Every claim below is **demonstrated**
in the repo, not asserted:

| CockroachDB-distinguishing capability | Where it's demonstrated |
|---|---|
| **Native distributed vector index — C-SPANN, not pgvector.** Semantic recall runs *inside* the database engine; no separate vector store, no `pgvector` extension. | `CREATE VECTOR INDEX … (embedding vector_cosine_ops)` in [`src/db/schema.sql`](./src/db/schema.sql) (C-SPANN k-means partition tree — [docs/BENCHMARK.md](./docs/BENCHMARK.md)). |
| **The index is actually used — `EXPLAIN` plans a `vector search` node**, not a table scan, so recall is ANN (not brute force). | Verified on v26.2.2, the 3-node cluster, and live Cloud v25.4.10 — [docs/BENCHMARK.md](./docs/BENCHMARK.md) Results 3–4. |
| **Recall@k measured against brute-force ground truth: 96.5% (uniform, worst case) → 99.6% (structured, 10k memories).** Ground truth = exact top-k by brute-force cosine over the same seeded vectors, so recall is exact. | `npm run benchmark` ([`scripts/benchmark.ts`](./scripts/benchmark.ts)); numbers + methodology in [docs/BENCHMARK.md](./docs/BENCHMARK.md) Results 1–2. |
| **Survivability a single box can't give: RF=3 on every range + leaseholders spread across all 3 nodes.** Kill any one node and recall keeps serving with zero data loss — **demonstrated in CI** (the `cluster-survival` job stops `roach3` and asserts recall still serves, in `STRICT` mode). | `bash scripts/show-distribution.sh` on `docker-compose.cluster.yml` (CI runs it `STRICT=1`); per-node range proof in [docs/BENCHMARK.md](./docs/BENCHMARK.md) Result 3. |

A tuned single-node pgvector may be faster on one box, but it has one copy on one machine — no
replication, no node-loss survival, no scale-out. The differentiator here is **architectural
and demonstrated**, with the vector index native in the *same* database as the relational data.

## Why CockroachDB as the memory layer

- **Postgres-wire compatible** — Archon's existing PostgreSQL schema ports in nearly unchanged (the `documents` / `employees` / `payroll_events` / `validation_results` tables here are a 1:1 port from the production Archon schema).
- **Native distributed vector indexing** (v25.2+) — semantic recall (`CREATE VECTOR INDEX ... vector_cosine_ops`) runs *inside* the database, distributed across the cluster, with no separate vector store to operate.
- **Survivable, scalable memory** — agent memory is durable, multi-region-capable, and consistent by default; a memory the agents can trust.
- **A memory that audits itself** — because every write is a distinct, timestamped event in one consistent store, the agent can scan *all* of its stored memory for cross-session contradictions and dangling references and recommend a resolution — turning "vector recall on CockroachDB" into an agentic memory that keeps itself honest (see [Self-auditing memory](#self-auditing-memory-the-agentic-differentiator)).

## CockroachDB features used (2 of 4 required)

| Feature | How it's used | Status |
|---|---|---|
| **Distributed Vector Indexing** | `agent_memory.embedding VECTOR(1024)` + a native cosine `CREATE VECTOR INDEX` (CockroachDB C-SPANN, **not** pgvector). Semantic recall plans a `vector search` node (EXPLAIN-verified on v26.2.2, the 3-node cluster, and live Cloud v25.4.10). **Benchmarked: 99.6% recall@10 @ 10k memories; replicated RF=3 + leaseholders spread across 3 nodes.** | ✅ built + **benchmarked** + distribution-proven |
| **ccloud CLI (Agent-Ready)** | Provisions/manages the CockroachDB Cloud Serverless cluster the deployed app uses (`scripts/provision-cluster.sh`); live cluster in AWS eu-west-1. | ✅ scripted + live cluster reachable |
| Cloud Managed MCP Server | The **hosted** CockroachDB Cloud Managed MCP Server (console-generated creds, not self-hostable/CI-reproducible) is a roadmap item. We instead built a **self-hosted** MCP surface over this same store — see [Agentic MCP surface](#agentic-mcp-surface). | ◻ hosted variant roadmap · self-hosted surface ✅ built |
| Agent Skills Repo | (stretch) | ◻ roadmap |

> **Honest count:** we use **2 of the 4** required CockroachDB features (Distributed Vector
> Indexing + ccloud CLI). The self-hosted MCP surface below is a genuine agentic tool surface
> over the CockroachDB memory, but it is **not** the hosted *Cloud Managed MCP Server* product,
> so we do not claim that required-feature box (the rules require ≥2; we meet that).

## AWS services used (1+ required)

| Service | How it's used |
|---|---|
| **Amazon Bedrock — Titan Text Embeddings V2** | Embeds every memory (`content` → 1024-dim vector) for storage + recall. |
| **Amazon Bedrock — Claude Sonnet (Converse)** | The RAG **narrator** (`src/agents/narrator.ts`): writes a CFO-level answer grounded in and citing the memories recalled from the CockroachDB vector index. The Converse wrapper also supports multimodal document extraction (reused from the Archon AWS build). Offline `FakeNarrator` fallback keeps CI AWS-free. Real-run capture: [docs/BEDROCK_SMOKE.md](./docs/BEDROCK_SMOKE.md). |
| **AWS Lambda / ECS** | (roadmap) hosts the agent API; the memory layer is deployment-agnostic. |

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  Archon agentic pipeline                                              │
│                                                                        │
│  Extractor ─▶ EventLinker ─▶ Validator ─▶ Narrator                    │
│     │             │             │            │                         │
│     │  each agent WRITES facts it learns, and READS relevant prior    │
│     │  facts by meaning, through the MemoryAgent                       │
│     ▼             ▼             ▼            ▼                         │
│                MemoryAgent  (src/agents/memory-agent.ts)              │
│         ingestEvent() → remember()  ·  recallAnswer() → recall()      │
│                     → Narrator (Claude Sonnet, cites memories)        │
└───────────────┬────────────────────────────────┬─────────────────────┘
                │ embed(content)                  │ SQL (pg-wire)
                ▼                                  ▼
   ┌────────────────────────────┐   ┌───────────────────────────────────┐
   │  AWS Bedrock                │   │  CockroachDB  (the memory layer)  │
   │  Titan Embeddings V2        │   │  ───────────────────────────────  │
   │  → 1024-dim vector          │   │  agent_memory(embedding VECTOR)   │
   │  Claude Sonnet (extract +   │   │  + CREATE VECTOR INDEX (cosine)   │
   │  narrate)                   │   │  documents · employees ·          │
   └────────────────────────────┘   │  payroll_events · validation      │
                                     │  recall = ORDER BY embedding <=> q │
                                     └───────────────────────────────────┘
```

### Write path (`remember`)
An agent states a fact in natural language (`"Off-bank employment cost at Acme for 2026-03: the bank transfer of €41,000 understates true employer cost by €22,800 — the employer social-security wedge alone, ~35% of the €63,800 true cost…"`) → Bedrock Titan embeds it → the text, structured metadata, and the vector are stored in `agent_memory`.

### Read path (`recall` → `narrate`)
A question is embedded and run as an approximate-nearest-neighbor search over the distributed vector index (`ORDER BY embedding <=> $query`). Unscoped semantic recall is index-accelerated (EXPLAIN plans a `vector search` node); a scoped recall additionally constrains `kind` / `company` via their btree indexes. The top-k memories are then handed to the **narrator** (`MemoryAgent.recallAnswer`), which calls **Claude Sonnet on Bedrock** to write a grounded, CFO-level answer that cites the exact memories it used — RAG over the agent's own memory. Without AWS creds a deterministic `FakeNarrator` composes the same cited answer, so the full recall→narrate loop runs offline in CI.

## Self-auditing memory (the agentic differentiator)

Semantic recall answers *"what do I know about X?"*. A memory that accumulates across
many independent sessions faces a second, agent-native problem: **nothing stops two of
those writes from disagreeing.** Session A stores *"invoice INV-2043 total €18,400"*; a
later session B stores *"€18,900"* for the same invoice. Plain recall hands back whichever
ranks higher and stays silent about the conflict.

`MemoryAgent.audit()` (`src/memory/consistency.ts`) is the agent inspecting its **own**
memory. It reads every stored memory in scope (`listForAudit` — a plain `SELECT`, never a
top-k slice, so it sees *both* sides of a conflict) and flags two memory-native problems:

- **Contradiction** — two write events assign *different* values to the *same* attribute of
  the *same* record (e.g. two stored totals for one invoice).
- **Absence** — a memory explicitly references another record (`metadata.refs`) that **no**
  memory in the store actually holds — a dangling reference.

For every contradiction it also returns a **resolution recommendation** over a fixed,
domain-neutral priority ladder — **importance → source-authority → recency** — picking which
stored value to trust and explaining why (e.g. an explicitly-important insight outranks a
later casual write; a structured `document` record outranks a derived `insight`; otherwise the
later write wins). It is a **recommender, not ground truth**, and — the load-bearing property —
it is strictly **read-only**: the audit never mutates, supersedes, or deletes a memory. The
`recallAnswer` hot path also runs a best-effort audit over the memories it just recalled, so a
conflict surfaces inline; the exhaustive guarantee is `audit()`.

Measured offline (`tests/consistency.test.ts`, no DB / no AWS): on a labelled fixture it
detects **every** injected contradiction and dangling reference with **zero false positives**,
and recommends the labelled winner + rule on **every** resolution case. The read-only guarantee
is proven end-to-end against a live CockroachDB in `tests/consistency.e2e.test.ts` (memory count
identical before/after the audit). Run the live self-audit in the demo: `npm run memory:demo`.

## Agentic MCP surface

The memory is exposed as a **self-hosted [MCP](https://modelcontextprotocol.io) server**
([`src/mcp/server.ts`](./src/mcp/server.ts)), so any MCP-speaking agent (Claude Code, Cursor,
VS Code, a custom orchestrator) can call the CockroachDB-backed memory as tools:

| MCP tool | What it does | Mode |
|---|---|---|
| `recall_memory` | ANN recall over the distributed vector index (top-k by meaning, scoped by company/kind) | read-only |
| `audit_memory` | self-audit for cross-session contradictions + dangling references, with a resolution recommendation | read-only |
| `remember_memory` | embed and store a new fact | write |

Run it over stdio with `npm run mcp:server` (offline `FakeEmbedder` without AWS creds; real
Bedrock Titan with them — same tools, same store). A full **round-trip is tested in CI**
([`tests/mcp.test.ts`](./tests/mcp.test.ts)): a real MCP `Client` connects over an in-process
transport, lists the tools, and drives `remember → recall → audit` against the CockroachDB
memory layer — offline, no DB or AWS required.

This is an **honest** agentic surface we run ourselves; it is **not** the hosted CockroachDB
*Cloud Managed MCP Server* product (which needs console-generated Cloud creds and cannot be
self-hosted or exercised reproducibly in CI). That hosted variant remains a roadmap item — we
do not claim its required-feature box.

## Benchmark & distribution — why this is a real memory layer, not a demo

Full methodology + numbers: **[docs/BENCHMARK.md](./docs/BENCHMARK.md)**. Reproduce with
`npm run benchmark`, `npm run fanout:demo`, and `bash scripts/show-distribution.sh`
(harnesses: `scripts/benchmark.ts`, `scripts/fanout-demo.ts`).

The vector index is **approximate** (C-SPANN), so the metric that matters is **recall@k**:
of the true top-k nearest memories, how many does the index return? Ground truth is the
exact top-k computed by brute force in JS over the same seeded vectors, so recall is exact.

| | result |
|---|---|
| **recall@10** across the data-hardness spectrum | **96.5%** (uniform, worst case) → **~99%** (structured) |
| **index quality — recall vs `vector_search_beam_size`** (uniform) | **29% → 96.5%** as the search visits more partitions |
| **multi-range fan-out** (`npm run fanout:demo`, single node) | memory forced into **≥2 KV ranges** (enforced `SPLIT AT`); one unscoped ANN recall **fans out across them** — top-k drawn from ≥2 ranges — and stays correct (recall@10 ~99%) with a `vector search` plan |
| **distribution** (3-node cluster) | 11 ranges, **RF=3 on all nodes**, leaseholders across all 3 |
| **live Cloud** (v25.4.10, eu-west-1) | recall + `vector search` EXPLAIN + RF=3 ranges — verbatim capture in [docs/CLOUD_SMOKE.md](./docs/CLOUD_SMOKE.md) |

Recall depends on data separability, so we report the range, not a single lucky number;
the evidence that isolates **index quality** is the beam curve (recall responds to search
effort). The differentiator is **architectural** and demonstrated: a tuned single-node
pgvector may be faster on one box, but it has **one copy on one machine** — no replication,
no node-loss survival, no scale-out. CockroachDB gives the agent a memory that is durable,
distributed, and survivable, with the vector index **native in the same database** as the
relational data.

**Multi-range ANN fan-out — now demonstrated, not just asserted.** A single ANN recall query
has to fan out across every KV range the memory spans and merge the results correctly.
`npm run fanout:demo` ([`scripts/fanout-demo.ts`](./scripts/fanout-demo.ts)) proves it
deterministically on a tiny dataset: it forces the `agent_memory` table into multiple KV ranges
with **enforced primary-key `SPLIT AT`** (CockroachDB splits a table into N ranges regardless of
size), then runs one **unscoped** ANN recall — served by the global vector index (`EXPLAIN` →
`vector search → lookup join`). It shows the query **fans out**: the returned top-k neighbours come
from **≥2 distinct ranges**, recall@k stays at the brute-force ground-truth floor (~99%), and the
plan is a `vector search` node (not a scan). Gated in CI by [`tests/fanout.test.ts`](./tests/fanout.test.ts).
(At production scale the vector index *itself* also auto-splits into ranges — the 3-node proof in
Result 3, [docs/BENCHMARK.md](./docs/BENCHMARK.md), shows those ranges replicated **RF=3 across
nodes**; we don't gate CI on loading enough data to force that natural split.)

## Quality & testing — the tests are held to the same self-auditing bar

The memory layer's philosophy is to keep itself honest; we hold its *tests* to the same bar,
and committing the integration suite paid off by surfacing a genuine production bug the earlier
unit tests had masked. `recall()` ([`src/memory/memory.ts`](./src/memory/memory.ts)) passed the
raw `created_at` column straight through, while `listForAudit()` normalized it — but the `pg`
driver returns a `TIMESTAMP` as a JS `Date`, not an ISO string, so on the **real CockroachDB**
path a recalled memory carried a `Date`; when a no-importance contradiction landed in the
recalled top-k, the consistency resolver's recency branch called `createdAt.slice(0,10)` and
threw `slice is not a function` (the offline mock returned strings, so it was invisible until
the suite ran against a live cluster). It was root-fixed — normalize in `recall()`, mirroring
`listForAudit()` — **and** the mock ([`tests/db_mock.ts`](./tests/db_mock.ts)) was made faithful,
now returning a `Date` like the real driver, so this class of bug is caught offline (reverting
the fix fails an integration test with the exact CI error).

## Readiness gate

The entry ships a **machine-checkable readiness gate** — the same self-auditing philosophy
applied to the *submission* itself. [`scripts/readiness.ts`](./scripts/readiness.ts) encodes the
judging bar as concrete, evidence-backed checks (run `npm run readiness`; it writes
`readiness.json` and, in CI, **fails the build if automatable completeness drops below 95%**).

Each check is one of:

- **automatable** — verifiable from the repo alone, and the gate verifies **CI wiring, not just
  file existence**: e.g. `node-kill CI-proven` is only counted when `show-distribution.sh` kills a
  node under a `STRICT` assertion **and** ci.yml runs it with `STRICT=1`; `offline suite green`
  because the `readiness` job `needs:` the green `build-test` + `cluster-survival` jobs. This is
  what makes the gate reflect **truth** rather than a checklist of touched files.
- **user-gated** — needs a live cluster / live AWS creds / a hosted URL / a filed form that only
  the operator can provide (live-cluster `EXPLAIN`, a real Bedrock invocation, the AWS-hosted demo
  URL, the Devpost form). Reported and listed, never blocking the automatable gate.

The report groups checks by judging criterion (CockroachDB-depth is weighted highest, as the
load-bearing axis), prints a per-criterion + overall completeness %, and enumerates the
outstanding user-gated items so the remaining human actions are unambiguous. It is exercised in CI
two ways: the `readiness` job runs the CLI, and [`tests/readiness.test.ts`](./tests/readiness.test.ts)
asserts the ≥95% floor offline.

## Repository layout

```
repos/cockroachdb/
├── README.md
├── docker-compose.yml          # local CockroachDB single node (v25.2+)
├── .env.example
├── src/
│   ├── db/
│   │   ├── schema.sql          # ported Archon schema + agent_memory VECTOR table + vector index
│   │   └── client.ts           # pg pool over CockroachDB (pg-wire) + vector literal helper
│   ├── memory/
│   │   ├── embeddings.ts        # Bedrock Titan V2 embedder (+ injectable offline FakeEmbedder)
│   │   ├── memory.ts            # remember() / recall() / listForAudit() — the memory layer
│   │   └── consistency.ts       # self-auditing memory — pure contradiction/absence audit + resolver
│   ├── agents/
│   │   ├── memory-agent.ts      # agentic read/write-memory loop (ingestEvent → recallAnswer)
│   │   └── narrator.ts          # Bedrock Claude RAG narrator (+ offline FakeNarrator)
│   ├── mcp/
│   │   └── server.ts           # self-hosted MCP server exposing memory as recall/audit/remember tools
│   └── extraction/
│       ├── bedrock.ts           # AWS Bedrock Converse wrapper (reused from Archon AWS build)
│       └── types.ts             # domain types (reused from Archon AWS build)
├── docker-compose.cluster.yml  # local 3-node cluster (distribution demo)
├── scripts/
│   ├── apply-schema.ts          # apply schema.sql to DATABASE_URL
│   ├── demo-memory.ts           # end-to-end ingest → recall → narrate round trip
│   ├── benchmark.ts             # recall@k + latency + vector_search_beam_size sweep
│   ├── fanout-demo.ts           # multi-range ANN fan-out demo (SPLIT AT → recall fans out across ranges)
│   ├── load-corpus.ts           # load clustered vectors (feeds the distribution demo)
│   ├── show-distribution.sh     # per-node range distribution + STRICT node-kill survivability proof (CI-run)
│   ├── mcp-server.ts            # stdio entrypoint for the self-hosted memory MCP server
│   ├── readiness.ts            # readiness gate — weighted, evidence-backed judge-readiness report
│   └── provision-cluster.sh     # ccloud CLI — provision the Cloud Serverless cluster
├── docs/
│   ├── BENCHMARK.md             # recall/latency/distribution results + methodology
│   ├── TOOLS.md                 # tool-identification doc (CockroachDB features + AWS)
│   ├── BEDROCK_SMOKE.md         # verbatim real-AWS-Bedrock run (Titan embed + Claude Converse)
│   ├── CLOUD_SMOKE.md           # verbatim live CockroachDB Cloud capture (EXPLAIN + RF=3 ranges)
│   └── BUILD_PLAN.md
└── tests/
    ├── memory.test.ts           # no-infra unit tests (embedder + vector literal)
    ├── narrator.test.ts         # no-infra narrator tests (FakeNarrator + BedrockNarrator w/ canned client)
    ├── consistency.test.ts      # no-infra self-audit tests (detection + precision + resolution, labelled)
    ├── pipeline.test.ts         # recall→narrate integration (live CockroachDB, DATABASE_URL-gated, offline fakes)
    ├── consistency.e2e.test.ts  # self-audit over live CockroachDB — flags + recommends, read-only (DATABASE_URL-gated)
    ├── integration.test.ts      # DB-client ↔ memory ↔ consistency integration (mock offline / live CRDB)
    ├── load.test.ts             # concurrent pool + remember/recall load exercise (mock offline / live CRDB)
    ├── fanout.test.ts           # multi-range ANN fan-out — recall correctness (both) + >=2-range gate (live CRDB)
    ├── mcp.test.ts              # MCP round-trip — a real MCP Client drives remember/recall/audit (offline)
    ├── readiness.test.ts        # readiness gate e2e — automatable completeness >=95% (offline, DB-free)
    └── db_mock.ts               # in-memory pg mock (vector cosine + Date semantics) for the offline path
```

## Quickstart

Requires Node ≥ 20 and Docker (for local CockroachDB).

```bash
cd repos/cockroachdb
cp .env.example .env            # fill AWS creds for real embeddings (optional for the demo)
npm install

# 1. Start a local CockroachDB single node (v25.2+ required for vector indexing)
docker compose up -d

# 2. Create the database, then apply the schema (tables + vector index)
docker exec -it $(docker compose ps -q cockroach) \
  cockroach sql --insecure -e "CREATE DATABASE IF NOT EXISTS archon_memory"
export DATABASE_URL="postgresql://root@localhost:26257/archon_memory?sslmode=disable"
npm run db:schema

# 3. Run the end-to-end agent-memory demo (write fused events, recall by meaning)
npm run memory:demo

# Tests (no DB / AWS needed)
npm test
```

Without AWS credentials the demo runs with a deterministic offline `FakeEmbedder` so the full CockroachDB write + vector-recall path still executes. Set `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (and `BEDROCK_REGION`) to switch to real Titan embeddings — same interface, same 1024 dimensions.

### CockroachDB Cloud (production)

Provision a free Serverless cluster with the ccloud CLI, then point `DATABASE_URL` at it:

```bash
ccloud auth login
ccloud cluster create serverless archon-memory --cloud aws --region eu-west-1
ccloud cluster sql archon-memory   # copy the connection string → DATABASE_URL
npm run db:schema
```

## Provenance / reuse

Archon is our own product; this entry reuses the public Archon challenge build freely:
- `src/db/schema.sql` — ported from the Archon Nebius Managed PostgreSQL schema.
- `src/extraction/bedrock.ts`, `src/extraction/types.ts` — from the Archon AWS (Vercel + Bedrock) build.
- The `memory/` layer, `agent_memory` vector table, and `MemoryAgent` are new for this hackathon.

## Roadmap (multi-session)

- [x] Bedrock Claude narrator over recalled memories (RAG answer that cites the memories, not just lists them) — `src/agents/narrator.ts`, offline `FakeNarrator` fallback.
- [x] Wire `MemoryAgent` end-to-end: `ingestEvent` (embed + remember fused events) → `recallAnswer` (vector recall → narrator). Demo + tests cover the offline path; real Bedrock is a creds swap.
- [x] Benchmark the vector index (recall@k, latency, `vector_search_beam_size` sweep) — `scripts/benchmark.ts`, results in `docs/BENCHMARK.md`; recall floor smoke gates CI.
- [x] Prove distribution + survivability on a multi-node cluster — `docker-compose.cluster.yml` + `scripts/show-distribution.sh`.
- [x] **Node-loss survival demonstrated in CI** — the `cluster-survival` CI job stands up the 3-node cluster and runs `show-distribution.sh` in `STRICT=1` mode: it stops `roach3` and asserts recall keeps serving (fails the build otherwise). The "kill any one node → recall keeps serving" claim is CI-proven, not just asserted.
- [x] Demonstrate multi-range ANN fan-out (memory forced into ≥2 KV ranges via `SPLIT AT`; one unscoped recall fans out — top-k from ≥2 ranges — with correct top-k) — `scripts/fanout-demo.ts` + `tests/fanout.test.ts`, CI-gated.
- [x] Verify the live CockroachDB Cloud recall path (v25.4.10, eu-west-1) — `vector search` EXPLAIN confirmed.
- [x] Expose the CockroachDB memory as a **self-hosted MCP server** (`recall`/`audit`/`remember` tools) with a CI round-trip test — `src/mcp/server.ts`, `tests/mcp.test.ts` ([Agentic MCP surface](#agentic-mcp-surface)).
- [x] **Readiness gate** — a machine-checkable, weighted judge-readiness report (`scripts/readiness.ts`, CI `readiness` job) that fails the build if automatable completeness drops below 95% and lists the user-gated items ([Readiness gate](#readiness-gate)).
- [ ] Deploy the agent API on AWS Lambda/ECS + a public demo URL.
- [ ] Wire the hosted CockroachDB *Cloud Managed MCP Server* (console-generated creds) — the hosted counterpart to our self-hosted surface.
- [ ] Sub-3-minute demo video.

## License

MIT — see [LICENSE](./LICENSE).
