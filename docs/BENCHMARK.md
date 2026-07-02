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

## Result 1 — recall@k on a representative (clustered) corpus

`BENCH_N=10000 BENCH_QUERIES=200 BENCH_K=10` · CockroachDB v26.2.2 · dim 1024

| metric | value |
|---|---|
| corpus | 10,000 memories, `VECTOR(1024)`, clustered |
| **recall@10** | **99.6%** (min 80% over 200 queries) |
| latency p50 / p95 / p99 | 68 ms / 106 ms / 167 ms |
| write throughput | 117 rows/s (batched, **index-maintained** — every write updates the ANN tree) |

At a representative embedding distribution the distributed ANN index returns **99.6%
of the exact top-10** — effectively exact recall — while the query is index-accelerated
(`EXPLAIN` → `vector search`, never a full scan). Recall is already saturated at the
default beam because clustered neighbourhoods are well separated.

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
- The quantized vector index is compact, so it is a single range at this size; past the
  ~64 MiB range threshold CockroachDB **auto-splits the vector index into more ranges
  and rebalances them across nodes** — the same mechanism, at scale (this is what runs
  on the managed multi-node Cloud cluster).

## Result 4 — verified on the live CockroachDB Cloud cluster

The same recall path runs against the managed Serverless cluster
(`archon-cockroachdb-cluster-27534`, **CockroachDB v25.4.10, AWS eu-west-1**):
semantic recall returns correctly-ranked memories and `EXPLAIN` plans a **`vector
search`** node — the distributed index is used (ANN), not a scan. TLS is
`sslmode=verify-full` against the public CA.

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

# distribution + survivability (3 nodes)
docker compose -f docker-compose.cluster.yml up -d && sleep 12
docker compose -f docker-compose.cluster.yml exec -T roach1 cockroach init --insecure || true
docker compose -f docker-compose.cluster.yml exec -T roach1 cockroach sql --insecure -e "CREATE DATABASE IF NOT EXISTS archon_memory"
export DATABASE_URL="postgresql://root@localhost:26257/archon_memory?sslmode=disable"
npm run db:schema && bash scripts/show-distribution.sh
```
