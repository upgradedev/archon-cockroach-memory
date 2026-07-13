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
  (recall@k + latency + `vector_search_beam_size` sweep), `scripts/fanout-demo.ts` +
  `tests/fanout.test.ts` (multi-range fan-out), `docs/BENCHMARK.md` (measured results),
  `scripts/show-distribution.sh` (per-node range distribution).
- **Proof it is used, not just present:** `EXPLAIN` plans a **`vector search`** node
  (index-accelerated ANN, not a full scan) — verified on the local single node
  (v26.2.2) **and on the live CockroachDB Cloud cluster** (v25.4.10, eu-west-1).
  See `docs/BENCHMARK.md` for the plan and the recall/latency numbers.
- **Distributed, not just present:** one unscoped ANN recall genuinely **fans out across
  multiple KV ranges** of the memory and stays correct. Demonstrated deterministically (CI
  v26.2.3): enforced `SPLIT AT` puts the table in 14 ranges, and one recall's top-k neighbours
  come from **4 distinct ranges** at **99.5% recall@10** with a `vector search` plan. Run
  `npm run fanout:demo`; gated by `tests/fanout.test.ts`; see `docs/BENCHMARK.md` Result 3b. At
  scale the vector index itself auto-splits into RF=3 ranges too (Result 3, 3-node cluster).

### 2. ccloud CLI (Agent-Ready)
- **What:** provisions / reuses the CockroachDB Cloud Serverless cluster the deployed
  app connects to.
- **Where:** `scripts/provision-cluster.sh` (`ccloud cluster create serverless … `,
  `ccloud cluster sql …` → `DATABASE_URL`).
- **Status:** the live cluster `archon-cockroachdb-cluster-27534` (AWS eu-west-1) is
  provisioned and reachable; the schema + vector index are applied and the ANN recall
  path is verified against it.

### 3. Agentic MCP surface (self-hosted) + Cloud connection
- **Self-hosted MCP server (built):** the CockroachDB-backed memory is exposed as an
  MCP server (`src/mcp/server.ts`, stdio entrypoint `scripts/mcp-server.ts`) with three
  tools — `recall_memory` (ANN recall over the vector index, read-only), `audit_memory`
  (self-audit for contradictions/absences, read-only), `remember_memory` (write). A real
  MCP `Client` drives a full `remember → recall → audit` round trip in CI
  (`tests/mcp.test.ts`, offline). Any MCP-speaking agent (Claude Code, Cursor, VS Code)
  can connect to it.
- **Honest scope:** this is a *self-hosted* MCP surface we run over our own store. It is
  **not** the hosted CockroachDB Cloud **Managed MCP Server** required-feature box (that
  product needs console-generated Cloud creds and cannot be self-hosted or exercised
  reproducibly in CI). Wiring the hosted variant is the remaining stretch item (README
  roadmap). We therefore still count **2 of the 4** required CockroachDB features.
- The Cloud cluster itself is operated through the CockroachDB Cloud console + connection
  string (`scripts/provision-cluster.sh`).

## AWS services

### Amazon Bedrock — Titan Text Embeddings V2
- **What:** turns each memory's natural-language `content` into a 1024-dim vector for
  storage and recall. `dimensions: 1024, normalize: true` matches `VECTOR(1024)` and
  cosine distance.
- **Where:** `src/memory/embeddings.ts` (`BedrockEmbedder`). Offline `FakeEmbedder` /
  `RandomEmbedder` implement the same `Embedder` interface so dev, CI, and the
  benchmark run with no AWS credentials.
- **Proof it runs against real AWS:** a verbatim real-run capture (real 1024-dim
  unit-length Titan vector) is in [`docs/BEDROCK_SMOKE.md`](./BEDROCK_SMOKE.md);
  re-runnable via the gated `tests/bedrock.integration.test.ts` (`RUN_BEDROCK_IT=1`).

### Amazon Bedrock — Claude Sonnet (Converse)
- **What:** the RAG **narrator** — writes a CFO-level answer grounded in and citing
  the memories recalled from the vector index. The Converse wrapper also supports
  multimodal document extraction (reused from the Archon AWS build).
- **Where:** `src/agents/narrator.ts` (`BedrockNarrator`) over `src/extraction/bedrock.ts`
  (`converse()`). Offline `FakeNarrator` keeps the full recall→narrate loop testable
  without AWS.
- **Proof it runs against real AWS:** a verbatim real Claude Sonnet Converse answer —
  grounded and citing `[1]`/`[2]` — is captured in
  [`docs/BEDROCK_SMOKE.md`](./BEDROCK_SMOKE.md) (same gated integration test).

### AWS deploy target (roadmap)
- The agent API is deployment-agnostic (pg-wire + Bedrock SDK); the planned host is
  AWS Lambda/ECS for a public demo URL.

## How the two sides meet
`agent states a fact` → **Bedrock Titan** embeds it → stored in **CockroachDB**
`agent_memory(embedding VECTOR(1024))` → later a question is embedded, run as ANN over
the **distributed vector index**, and the top-k memories are narrated by **Bedrock
Claude** into a grounded, cited answer. CockroachDB is the durable, distributed,
survivable memory; Bedrock supplies the semantics at both ends.
