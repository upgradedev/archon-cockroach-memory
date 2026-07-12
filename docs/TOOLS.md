# Tool identification — CockroachDB features + AWS services used

Required by the hackathon rules: which CockroachDB tools and which AWS services this
entry uses, and exactly how. Archon Memory uses **2 of the 4** CockroachDB required
features fully (2 are required; a third is partial/stretch) and **Amazon Bedrock** on
the AWS side.

## CockroachDB features

### 1. Distributed Vector Indexing — the core of the entry
- **What:** `agent_memory.embedding VECTOR(1024)` with a native
  `CREATE VECTOR INDEX ... (embedding vector_cosine_ops)` (CockroachDB v25.2+).
  This is CockroachDB's **own** distributed vector index (C-SPANN — a hierarchical
  k-means partition tree distributed and replicated across the cluster), **not**
  the `pgvector` extension.
- **Where:** `src/db/schema.sql` (the index), `src/memory/memory.ts`
  (`recall()` = `ORDER BY embedding <=> $q LIMIT k`), `scripts/benchmark.ts`
  (recall@k + latency + `vector_search_beam_size` sweep), `docs/BENCHMARK.md`
  (measured results), `scripts/show-distribution.sh` (per-node range distribution).
- **Proof it is used, not just present:** `EXPLAIN` plans a **`vector search`** node
  (index-accelerated ANN, not a full scan) — verified on the local single node
  (v26.2.2) **and on the live CockroachDB Cloud cluster** (v25.4.10, eu-west-1).
  See `docs/BENCHMARK.md` for the plan and the recall/latency numbers.

### 2. ccloud CLI (Agent-Ready)
- **What:** provisions / reuses the CockroachDB Cloud Serverless cluster the deployed
  app connects to.
- **Where:** `scripts/provision-cluster.sh` (`ccloud cluster create serverless … `,
  `ccloud cluster sql …` → `DATABASE_URL`).
- **Status:** the live cluster `archon-cockroachdb-cluster-27534` (AWS eu-west-1) is
  provisioned and reachable; the schema + vector index are applied and the ANN recall
  path is verified against it.

### 3. Cloud connection / operational surface (stretch, partial)
- The Cloud cluster is operated through the CockroachDB Cloud console + connection
  string; exposing recall as a Cloud **Managed MCP Server** tool is the remaining
  stretch item (roadmap in the README).

## AWS services

### Amazon Bedrock — Titan Text Embeddings V2
- **What:** turns each memory's natural-language `content` into a 1024-dim vector for
  storage and recall. `dimensions: 1024, normalize: true` matches `VECTOR(1024)` and
  cosine distance.
- **Where:** `src/memory/embeddings.ts` (`BedrockEmbedder`). Offline `FakeEmbedder` /
  `RandomEmbedder` implement the same `Embedder` interface so dev, CI, and the
  benchmark run with no AWS credentials.

### Amazon Bedrock — Claude Sonnet (Converse)
- **What:** the RAG **narrator** — writes a CFO-level answer grounded in and citing
  the memories recalled from the vector index. Also multimodal document extraction
  (reused from the Archon AWS build).
- **Where:** `src/agents/narrator.ts` (`BedrockNarrator`) over `src/extraction/bedrock.ts`
  (`converse()`). Offline `FakeNarrator` keeps the full recall→narrate loop testable
  without AWS.

### AWS deploy target (roadmap)
- The agent API is deployment-agnostic (pg-wire + Bedrock SDK); the planned host is
  AWS Lambda/ECS for a public demo URL.

## How the two sides meet
`agent states a fact` → **Bedrock Titan** embeds it → stored in **CockroachDB**
`agent_memory(embedding VECTOR(1024))` → later a question is embedded, run as ANN over
the **distributed vector index**, and the top-k memories are narrated by **Bedrock
Claude** into a grounded, cited answer. CockroachDB is the durable, distributed,
survivable memory; Bedrock supplies the semantics at both ends.
