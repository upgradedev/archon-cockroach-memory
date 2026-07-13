# Vector-memory benchmark — recall, latency, and distribution

This is the evidence behind the claim that CockroachDB's **native distributed vector
index** is a production-grade memory layer, not a demo. Everything here is
reproducible with `npm run benchmark` and `bash scripts/show-distribution.sh`; the
harness is `scripts/benchmark.ts`.

## What we measure and why it's valid

CockroachDB's vector index (**C-SPANN** — a hierarchical k-means partition tree
searched with a beam, replicated and distributed across the cluster) is an
**approximate** nearest-neighbour index, so the metric that matters is **recall@k**:
of the true top-k nearest memories, how many does the index actually return?

- **Ground truth** is computed in JS by brute-force cosine over the *same* vectors we
  generated (deterministic, seeded), so `recall@k = |ANN ∩ exact| / k` is exact.
- **Corpus** is dense unit vectors. The headline uses a **clustered** corpus (vectors
  drawn around random centroids + noise) because that mirrors the manifold structure
  of real sentence embeddings (Titan, OpenAI, etc.) — the same reason ANN-Benchmarks
  uses SIFT/GloVe/DEEP and never uniform noise. We also report a **uniform** corpus
  (points spread over the unit hypersphere) as a pathological worst case.
- Runs fully **offline** (no AWS) — the vectors carry no semantics; they exist to
  stress and measure the index. Titan supplies the real semantics in production.

> Latency figures below are from a **single local Docker node on a laptop**, not a
> tuned datacenter cluster — read them as *relative* (recall/latency tradeoff, effect
> of beam size), not as an absolute SLA. How environment-bound latency is: the CI
> recall-floor smoke (`ci.yml`, N=1500, clustered) on a clean GitHub Linux runner
> reports **p50 5.6 ms / p95 6.4 ms at 99.2% recall@10 and 860 rows/s writes** — ~10×
> the laptop's numbers at the same size. The load-bearing, environment-independent
> results are **recall@k** (index quality) and the **distribution** proof; treat the
> laptop latency as a conservative floor. Regenerate clean full-scale numbers with the
> `benchmark.yml` workflow (`workflow_dispatch`, available once merged to the default
> branch).

## Result 1 — recall@k across the data-hardness spectrum

Recall depends on how separable the true neighbours are, so we bracket the spectrum
rather than quote one number. CockroachDB v26.2.2 · dim 1024 · top-10.

| corpus | recall@10 | notes |
|---|---|---|
| **uniform** (no structure — worst case for any ANN) | **96.5%** at beam ≥100 | the structure-free floor |
| **clustered** (structured embeddings) | **~99%** | `N=10k`: 99.6%; robust across noise (below) |

At a representative *structured* distribution the index returns **~99% of the exact
top-10**; even on the pathological *structure-free* corpus it holds **96.5%**. Both are
index-accelerated (`EXPLAIN` → `vector search`, never a full scan).

**Honesty note on the clustered number.** The clustered corpus is generated as
`centroid + noise`, and queries share the same centroids, so a same-cluster signal is
present by construction — which is *why* recall stays high. We verified it is not a
single lucky setting by sweeping the noise level (`N=5000`, default beam):

| noise | 0.35 | 0.7 | 1.2 | 2.0 |
|---|---|---|---|---|
| recall@10 | 99.1% | 99.2% | 99.1% | 99.1% |

Recall is robust to noise *given cluster structure*. The number that isolates **index
quality** (independent of how easy the data is) is the **beam sweep** in Result 2 —
recall responding to the index's search effort — not the headline recall on any one
corpus. Treat **96.5%–99.6%** as the honest range and the beam curve + RF=3 as the
load-bearing evidence.

## Result 2 — the recall/latency knob (`vector_search_beam_size`)

Where the corpus is *hard* (uniform, no cluster structure — the worst case for any
ANN index), recall is tunable via `vector_search_beam_size` (how many partitions the
search visits). `BENCH_CORPUS=uniform BENCH_N=5000 BENCH_QUERIES=150 BENCH_K=10`:

| beam_size | recall@10 | p50 (ms) | p95 (ms) | p99 (ms) |
|---:|---:|---:|---:|---:|
| 10  | 29.2% | 67 | 162 | 297 |
| 50  | 86.1% | 72 | 144 | 250 |
| 100 (default) | 96.5% | 71 | 118 | 298 |
| 300 | 96.5% | 70 | 107 | 133 |
| 600 | 96.5% | 67 | 107 | 183 |

Even on the pathological uniform corpus the index reaches **96.5% recall@10**, and the
beam knob buys accuracy monotonically. In production you tune beam per workload; the
memory layer exposes it per query/session.

## Result 3 — distribution + survivability (what single-node pgvector can't do)

`bash scripts/show-distribution.sh` on the 3-node cluster (`docker-compose.cluster.yml`),
6,000 memories, CockroachDB v26.2.2:

```
agent_memory ranges — every range replicated across all 3 nodes (RF=3):
  range_id | lease_holder | replicas
  ---------+--------------+-----------
       106 |            2 | {1,2,3}
       107 |            3 | {1,2,3}     ← the vector index range
       108 |            1 | {1,2,3}
       ...        (11 ranges total)
  total_ranges = 11 · distinct_leaseholder_nodes = 3

EXPLAIN SELECT id FROM agent_memory ORDER BY embedding <=> $q LIMIT 10:
  • top-k
    └── • lookup join
          └── • vector search          ← distributed ANN index, on the cluster
```

- **Every** range of the memory (including the vector-index range) is **replicated
  RF=3 across all three nodes** — kill any one node and recall keeps serving with zero
  data loss. A single-node pgvector has one copy on one machine.
- **Leaseholders are spread across all 3 nodes** — read/write load distributes across
  the cluster instead of hitting one box.
- As the data grows, CockroachDB **auto-splits and rebalances those ranges across the cluster**,
  each still replicated RF=3 — the same mechanism at scale, exactly what runs on the managed
  multi-node Cloud cluster. Result 3b below demonstrates one recall query fanning out across a
  multi-range memory.

## Result 3b — multi-range ANN fan-out (demonstrated, not asserted)

Result 3 proves ranges replicate across nodes; this proves that ONE ANN recall query genuinely
**fans out across multiple KV ranges** of the memory and still returns the correct top-k — the
thing previously asserted but not shown. Rather than load tens of GB to hit a natural split, we
demonstrate it **deterministically on a small dataset**: `npm run fanout:demo`
([`scripts/fanout-demo.ts`](../scripts/fanout-demo.ts)) forces the `agent_memory` table into
several KV ranges with **enforced primary-key `SPLIT AT`** (CockroachDB splits a table into N
ranges regardless of size; the split is enforced so it won't merge back), then runs one
**unscoped** ANN recall — served by the global vector index. CI, single node, v26.2.3, N=3000:

```
Memory table spans 14 KV range(s) (vector index: 1 range(s) at this scale):
  range_id | lease_holder | replicas
  ---------+--------------+----------
   … 14 ranges (4 primary + secondary/vector index spans) …

recall@10: mean 99.5% · min 90% · top-k neighbours drawn from 4 distinct primary range(s)

EXPLAIN … ORDER BY embedding <=> q LIMIT 10:
  • top-k └── • render └── • lookup join └── • vector search
→ plan uses a 'vector search' node: true
```

- The memory table is split across **14 KV ranges** (the 3 enforced `SPLIT AT` points give 4
  primary ranges; the rest are the secondary + vector-index spans). The rows' random-UUID PKs
  scatter across the four primary ranges.
- The **unscoped** recall (`ORDER BY embedding <=> q LIMIT k`, no company filter) is served by
  the **global vector index** — `EXPLAIN` plans `vector search → lookup join`. The lookup
  **fans out** across the primary ranges: the returned top-k semantic neighbours came from **4
  distinct ranges**, so the query genuinely spans the cluster's ranges, not one.
- It stays **correct** under that distributed execution: **recall@10 = 99.5%** against
  brute-force ground truth (min 90%), and the plan is a `vector search` node (ANN, not a scan).
- Gated in CI by [`tests/fanout.test.ts`](../tests/fanout.test.ts) (hard asserts: ≥2 table
  ranges, top-k drawn from ≥2 ranges, recall ≥90%, `vector search` — against the real
  CockroachDB CI stands up); offline, the same file runs the recall-correctness half under the
  mock and skips the range assertions.
- **At production scale the vector index itself also auto-splits** into KV ranges (CockroachDB's
  minimum `range_max_bytes` is 64 MiB, so this needs a large corpus, not zone tuning) and each
  range is replicated RF=3 (Result 3). We report the index's range count above transparently
  (1 at this small scale) rather than gate CI on loading enough data to force that split.

## Result 4 — verified on the live CockroachDB Cloud cluster

The same recall path runs against the managed Serverless cluster
(`archon-cockroachdb-cluster-27534`, **CockroachDB v25.4.10, AWS eu-west-1**):
semantic recall returns correctly-ranked memories and `EXPLAIN` plans a **`vector
search`** node — the distributed index is used (ANN), not a scan. TLS is
`sslmode=verify-full` against the public CA.

**Verbatim live-Cloud capture — [docs/CLOUD_SMOKE.md](./CLOUD_SMOKE.md):** the actual
`EXPLAIN` plan (`vector search → lookup join → top-k`), a real top-k recall with cosine
distances, and `SHOW RANGES` proving the range is replicated **RF=3** (`["43","45","85"]`)
across the Cloud cluster.

## Result 5 — concurrent recall under load (k6 SLO)

A [k6](https://k6.io) load test (`load/recall.js`) drives the **recall / vector-search
path** — the same `MemoryAgent.recallAnswer` the demo Function URL uses — through the
HTTP server (`src/http/server.ts`) against a real CockroachDB, at **20 concurrent virtual
users for 20 s** over a **2,000-memory** corpus. Each request poses the *exact text* of a
seeded memory, so recall is deterministic and correctness is measurable under concurrency.

**Reference SLO (enforced as k6 thresholds — the `load` CI job fails on a breach):**

| Metric | SLO threshold |
|---|---|
| Recall latency **p95** | **< 1500 ms** |
| **recall@1** correctness under concurrency | **≥ 0.99** |
| Request error rate | **< 1%** |

The thresholds live in `load/recall.js`; the CI `load` job installs k6, seeds the corpus
(`npm run load:seed`), starts the server, and runs `k6 run load/recall.js`. A regression
that breaches the p95 SLO or drops recall@1 fails the build.

```bash
# concurrent recall load test (needs a running DB + server)
npm run db:schema && LOAD_N=2000 npm run load:seed
PORT=8787 npm run serve &                       # start the recall server
k6 run -e BASE_URL=http://localhost:8787 -e LOAD_N=2000 load/recall.js
```

## Honest comparison to single-node pgvector

We do **not** claim lower latency or higher recall than pgvector — on one node a tuned
pgvector HNSW is often faster. The claim is **architectural**, and it is real:

| | single-node pgvector | CockroachDB distributed vector index |
|---|---|---|
| Vector index | extension (HNSW/IVF) | **native**, in the DB engine |
| Replication / HA | none (single copy) | **RF=3, survives node loss** |
| Scale-out | vertical only | **horizontal — ranges split + rebalance across nodes** |
| Multi-region | no | yes (regional-by-row capable) |
| Operate a separate vector store | often | **no — memory + relations + vectors in one DB** |

For an agent's *long-term* memory — durable, always-on, growing without bound — those
architectural properties are the point.

## Reproduce

```bash
# recall@k + latency (representative)
docker compose up -d && npm run db:schema
BENCH_N=10000 BENCH_QUERIES=200 BENCH_BEAMS=100,200 npm run benchmark

# the beam knob on the worst case
BENCH_CORPUS=uniform BENCH_N=5000 BENCH_BEAMS=10,50,100,300 npm run benchmark

# multi-range ANN fan-out (SPLIT AT forces >=2 ranges; one unscoped recall fans out across them)
npm run fanout:demo

# distribution + survivability (3 nodes)
docker compose -f docker-compose.cluster.yml up -d && sleep 12
docker compose -f docker-compose.cluster.yml exec -T roach1 cockroach init --insecure || true
docker compose -f docker-compose.cluster.yml exec -T roach1 cockroach sql --insecure -e "CREATE DATABASE IF NOT EXISTS archon_memory"
export DATABASE_URL="postgresql://root@localhost:26257/archon_memory?sslmode=disable"
npm run db:schema && bash scripts/show-distribution.sh
```
