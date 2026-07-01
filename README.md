# Archon Memory — CockroachDB × AWS

**Entry for the CockroachDB × AWS AI Hackathon** ([cockroachdb-ai.devpost.com](https://cockroachdb-ai.devpost.com))

An agentic financial-intelligence application that uses **CockroachDB as the agents' persistent memory layer**, running on **AWS Bedrock**.

Archon reads a small business's raw financial documents — bank confirmations, payroll registers, payslips, invoices — and fuses them into an accurate, auditable monthly close. The headline insight it surfaces: *the bank salary transfer understates the true employer payroll cost by ~28%*, because it never sees employer social-security (IKA) contributions. This entry gives Archon's agents a **memory**: every extracted document, fused financial event, validation finding, and narrated insight is embedded and stored in CockroachDB, then **recalled by meaning** on later runs — so the agents reason with continuity instead of starting cold on every upload.

## Why CockroachDB as the memory layer

- **Postgres-wire compatible** — Archon's existing PostgreSQL schema ports in nearly unchanged (the `documents` / `employees` / `payroll_events` / `validation_results` tables here are a 1:1 port from the production Archon schema).
- **Native distributed vector indexing** (v25.2+) — semantic recall (`CREATE VECTOR INDEX ... vector_cosine_ops`) runs *inside* the database, distributed across the cluster, with no separate vector store to operate.
- **Survivable, scalable memory** — agent memory is durable, multi-region-capable, and consistent by default; a memory the agents can trust.

## CockroachDB features used (2 of 4 required)

| Feature | How it's used | Status |
|---|---|---|
| **Distributed Vector Indexing** | `agent_memory.embedding VECTOR(1024)` + a global cosine `CREATE VECTOR INDEX`. Unscoped semantic recall plans a `vector search` node (EXPLAIN-verified on v26.2.2); scoped recall pre-filters via btree indexes. | ✅ built + verified on v26.2.2 |
| **ccloud CLI (Agent-Ready)** | Provisions/manages the CockroachDB Cloud Serverless cluster the deployed app uses (`scripts/provision-cluster.sh`). | ◻ scripted, runs at deploy time |
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
├── scripts/
│   ├── apply-schema.ts          # apply schema.sql to DATABASE_URL
│   └── demo-memory.ts           # end-to-end ingest → recall → narrate round trip
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
- [ ] Deploy the agent API on AWS Lambda/ECS + a public demo URL.
- [ ] `provision-cluster.sh` (ccloud) + CockroachDB Cloud MCP Server as memory-recall tool.
- [ ] Sub-3-minute demo video.

## License

MIT — see [LICENSE](./LICENSE).
