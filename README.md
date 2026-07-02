# Archon Memory — CockroachDB × AWS

**Entry for the CockroachDB × AWS AI Hackathon** ([cockroachdb-ai.devpost.com](https://cockroachdb-ai.devpost.com))

An agentic financial-intelligence application that uses **CockroachDB as the agents' persistent memory layer**, running on **AWS Bedrock**.

Archon is a **unified financial-intelligence platform**: it ingests *all* of a small business's financial documents and data — sales and purchase invoices, orders, receipts, payments, bank transfers and statements, payroll, expenses — into one environment and produces a consolidated, period-over-period picture: P&L, EBITDA, cash, workforce cost, and the metrics behind them. Crucially, it also **cross-checks the whole picture for missing or inconsistent information** — for example, a vendor payment on the bank statement with no matching invoice (did the vendor never send it? did the accountant never register it? is the payment wrong?), or the fact that a bank salary transfer understates the *true* cost of employing a team by ~28% because it never shows employer social-security contributions. This entry gives Archon's agents a **memory**: every extracted document, fused financial event, validation finding, and narrated insight is embedded and stored in CockroachDB, then **recalled by meaning** on later runs — so the agents reason with continuity instead of starting cold on every upload.

## Why CockroachDB as the memory layer

- **Postgres-wire compatible** — Archon's existing PostgreSQL schema ports in nearly unchanged (the `documents` / `employees` / `payroll_events` / `validation_results` tables here are a 1:1 port from the production Archon schema).
- **Native distributed vector indexing** (v25.2+) — semantic recall (`CREATE VECTOR INDEX ... vector_cosine_ops`) runs *inside* the database, distributed across the cluster, with no separate vector store to operate.
- **Survivable, scalable memory** — agent memory is durable, multi-region-capable, and consistent by default; a memory the agents can trust.

## CockroachDB features used (2 of 4 required)

| Feature | How it's used | Status |
|---|---|---|
| **Distributed Vector Indexing** | `agent_memory.embedding VECTOR(1024)` + a native cosine `CREATE VECTOR INDEX` (CockroachDB C-SPANN, **not** pgvector). Semantic recall plans a `vector search` node (EXPLAIN-verified on v26.2.2, the 3-node cluster, and live Cloud v25.4.10). **Benchmarked: 99.6% recall@10 @ 10k memories; replicated RF=3 + leaseholders spread across 3 nodes.** | ✅ built + **benchmarked** + distribution-proven |
| **ccloud CLI (Agent-Ready)** | Provisions/manages the CockroachDB Cloud Serverless cluster the deployed app uses (`scripts/provision-cluster.sh`); live cluster in AWS eu-west-1. | ✅ scripted + live cluster reachable |
| Cloud Managed MCP Server | (stretch) expose memory recall as an MCP tool | ◻ roadmap |
| Agent Skills Repo | (stretch) | ◻ roadmap |

## AWS services used (1+ required)

| Service | How it's used |
|---|---|
| **Amazon Bedrock — Titan Text Embeddings V2** | Embeds every memory (`content` → 1024-dim vector) for storage + recall. |
| **Amazon Bedrock — Claude Sonnet (Converse)** | The RAG **narrator** (`src/agents/narrator.ts`): writes a CFO-level answer grounded in and citing the memories recalled from the CockroachDB vector index. Also does multimodal document extraction (reused from the Archon AWS build). Offline `FakeNarrator` fallback keeps CI AWS-free. |
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
An agent states a fact in natural language (`"Hidden payroll cost at Acme for 2026-03: the bank transfer of €41,000 understates true employer cost by €22,800 (28.8%)…"`) → Bedrock Titan embeds it → the text, structured metadata, and the vector are stored in `agent_memory`.

### Read path (`recall` → `narrate`)
A question is embedded and run as an approximate-nearest-neighbor search over the distributed vector index (`ORDER BY embedding <=> $query`). Unscoped semantic recall is index-accelerated (EXPLAIN plans a `vector search` node); a scoped recall additionally constrains `kind` / `company` via their btree indexes. The top-k memories are then handed to the **narrator** (`MemoryAgent.recallAnswer`), which calls **Claude Sonnet on Bedrock** to write a grounded, CFO-level answer that cites the exact memories it used — RAG over the agent's own memory. Without AWS creds a deterministic `FakeNarrator` composes the same cited answer, so the full recall→narrate loop runs offline in CI.

## Benchmark & distribution — why this is a real memory layer, not a demo

Full methodology + numbers: **[docs/BENCHMARK.md](./docs/BENCHMARK.md)**. Reproduce with
`npm run benchmark` and `bash scripts/show-distribution.sh` (harness: `scripts/benchmark.ts`).

The vector index is **approximate** (C-SPANN), so the metric that matters is **recall@k**:
of the true top-k nearest memories, how many does the index return? Ground truth is the
exact top-k computed by brute force in JS over the same seeded vectors, so recall is exact.

| | result |
|---|---|
| **recall@10** across the data-hardness spectrum | **96.5%** (uniform, worst case) → **~99%** (structured) |
| **index quality — recall vs `vector_search_beam_size`** (uniform) | **29% → 96.5%** as the search visits more partitions |
| **distribution** (3-node cluster) | 11 ranges, **RF=3 on all nodes**, leaseholders across all 3 |
| **live Cloud** (v25.4.10, eu-west-1) | recall + `vector search` EXPLAIN verified |

Recall depends on data separability, so we report the range, not a single lucky number;
the evidence that isolates **index quality** is the beam curve (recall responds to search
effort). The differentiator is **architectural** and demonstrated: a tuned single-node
pgvector may be faster on one box, but it has **one copy on one machine** — no replication,
no node-loss survival, no scale-out. CockroachDB gives the agent a memory that is durable,
distributed, and survivable, with the vector index **native in the same database** as the
relational data. (At this corpus size the vector index is a single RF=3 range; multi-range
ANN fan-out is CockroachDB's documented auto-split behaviour at scale, asserted not
demonstrated here — the demonstrated differentiator is RF=3 survivability + leaseholder spread.)

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
│   │   └── memory.ts            # remember() / recall() — the memory layer
│   ├── agents/
│   │   ├── memory-agent.ts      # agentic read/write-memory loop (ingestEvent → recallAnswer)
│   │   └── narrator.ts          # Bedrock Claude RAG narrator (+ offline FakeNarrator)
│   └── extraction/
│       ├── bedrock.ts           # AWS Bedrock Converse wrapper (reused from Archon AWS build)
│       └── types.ts             # domain types (reused from Archon AWS build)
├── docker-compose.cluster.yml  # local 3-node cluster (distribution demo)
├── scripts/
│   ├── apply-schema.ts          # apply schema.sql to DATABASE_URL
│   ├── demo-memory.ts           # end-to-end ingest → recall → narrate round trip
│   ├── benchmark.ts             # recall@k + latency + vector_search_beam_size sweep
│   ├── load-corpus.ts           # load clustered vectors (feeds the distribution demo)
│   ├── show-distribution.sh     # per-node range distribution + survivability proof
│   └── provision-cluster.sh     # ccloud CLI — provision the Cloud Serverless cluster
├── docs/
│   ├── BENCHMARK.md             # recall/latency/distribution results + methodology
│   ├── TOOLS.md                 # tool-identification doc (CockroachDB features + AWS)
│   └── BUILD_PLAN.md
└── tests/
    ├── memory.test.ts           # no-infra unit tests (embedder + vector literal)
    ├── narrator.test.ts         # no-infra narrator tests (FakeNarrator + BedrockNarrator w/ canned client)
    └── pipeline.test.ts         # recall→narrate integration (live CockroachDB, DATABASE_URL-gated, offline fakes)
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
ccloud cluster create serverless archon-memory --cloud aws --region us-east-1
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
- [x] Verify the live CockroachDB Cloud recall path (v25.4.10, eu-west-1) — `vector search` EXPLAIN confirmed.
- [ ] Deploy the agent API on AWS Lambda/ECS + a public demo URL.
- [ ] `provision-cluster.sh` (ccloud) + CockroachDB Cloud MCP Server as memory-recall tool.
- [ ] Sub-3-minute demo video.

## License

MIT — see [LICENSE](./LICENSE).
