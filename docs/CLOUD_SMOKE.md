# CockroachDB Cloud — live-cluster smoke evidence

Judge-facing proof that the vector-memory path runs against the **live, managed
CockroachDB Cloud Serverless cluster**, not only a local Docker node — the distributed
vector index is *used* (EXPLAIN plans a `vector search` node), the ANN recall returns
correctly-ranked memories, and every range is replicated **RF=3** across the cluster.

Everything below is a **verbatim capture** taken over the TLS (`sslmode=verify-full`)
connection string in `.env` (`DATABASE_URL`), read-only against whatever the cluster
currently holds — no data was loaded or deleted for this capture.

## Run metadata

| Field | Value |
|---|---|
| Cluster | `archon-cockroachdb-cluster-27534` |
| Host | `archon-cockroachdb-cluster-27534.j77.aws-eu-west-1.cockroachlabs.cloud:26257` |
| Cloud / region | **AWS eu-west-1** |
| Version | `CockroachDB CCL v25.4.10 (x86_64-pc-linux-gnu, built 2026/04/29)` |
| Database | `archon` |
| TLS | `sslmode=verify-full` (public CA) |
| Rows in `agent_memory` | 3 (the current self-audit fixture — see below) |

The three memories currently in the cluster are a self-audit fixture (two write events
that stored **different totals** for the same invoice — a cross-session contradiction —
plus a reconciliation memory referencing a separate payment):

```
[document]   Northwind Traders/2026-05: Invoice INV-2043 for Northwind Traders totalled €18,400 (confirmed).
[document]   Northwind Traders/2026-05: Invoice INV-2043 for Northwind Traders totalled €18,900 (later note).
[validation] Northwind Traders/2026-05: Reconciliation for INV-2043 references payment PAY-118.
```

## 1. The distributed vector index is USED (EXPLAIN → `vector search`)

`EXPLAIN SELECT id FROM agent_memory ORDER BY embedding <=> $q::VECTOR LIMIT 5`
(the exact unscoped ANN recall shape `src/memory/memory.ts::recall()` runs), verbatim:

```
distribution: local
vectorized: true

• top-k
│ estimated row count: 3
│ order: +column15
│ k: 5
│
└── • render
    │
    └── • lookup join
        │ table: agent_memory@agent_memory_pkey
        │ equality: (id) = (id)
        │ equality cols are key
        │
        └── • vector search
              table: agent_memory@idx_agent_memory_embedding
              target count: 5
```

The plan bottoms out in a **`vector search`** node against
`agent_memory@idx_agent_memory_embedding` (the native C-SPANN index), feeding a
`lookup join` back to the primary key — index-accelerated ANN, **not** a full table
scan. This is the same plan shape verified on the local single node (v26.2.2) and the
3-node cluster; here it is confirmed on the managed Cloud cluster.

## 2. The ANN recall returns correctly-ranked memories

One real recall (query vector = the first stored memory's embedding), top-3 by cosine
distance, verbatim:

```
distance  kind         content
--------  -----------  ----------------------------------------------------------
0.0000    [document]   Invoice INV-2043 for Northwind Traders totalled €18,400 (confirmed).
0.2372    [document]   Invoice INV-2043 for Northwind Traders totalled €18,900 (later note).
0.6646    [validation] Reconciliation for INV-2043 references payment PAY-118.
```

Ranking is correct and monotonic: the identical memory returns at cosine distance
`0.0000`, the near-duplicate contradicting total (`€18,900`) next at `0.2372`, and the
semantically-related-but-different reconciliation memory furthest at `0.6646`.

## 3. Every range is replicated RF=3 across the cluster

`SHOW RANGES FROM TABLE agent_memory WITH DETAILS` and
`SHOW RANGES FROM INDEX agent_memory@idx_agent_memory_embedding WITH DETAILS`, verbatim:

```
TABLE agent_memory:
  range_id  | lease_holder | replicas
  ----------+--------------+------------------
   9869658  |      45      | ["43","45","85"]

INDEX agent_memory@idx_agent_memory_embedding:
  range_id  | lease_holder | replicas
  ----------+--------------+------------------
   9869658  |      45      | ["43","45","85"]
```

At this small scale the table + vector index share one range — and that range is
**replicated across three distinct nodes (`43`, `45`, `85`), RF=3**, leaseholder on
`45`. Lose any one of the three and a quorum survives, so recall keeps serving with
zero data loss. As the corpus grows past the range threshold CockroachDB auto-splits
and rebalances these ranges across the cluster, each still RF=3 (the multi-range
mechanism is demonstrated deterministically in `docs/BENCHMARK.md` Result 3 / 3b).

## Reproduce

Point `DATABASE_URL` at the Cloud cluster (the connection string is in `.env`) and run
the same read-only queries:

```bash
# EXPLAIN the ANN recall plans a `vector search` node (any stored embedding as $q):
cockroach sql --url "$DATABASE_URL" -e \
  "EXPLAIN SELECT id FROM agent_memory ORDER BY embedding <=> (SELECT embedding FROM agent_memory LIMIT 1) LIMIT 5;"

# Ranges + replication factor:
cockroach sql --url "$DATABASE_URL" -e \
  "SELECT range_id, lease_holder, replicas FROM [SHOW RANGES FROM TABLE agent_memory WITH DETAILS];"
```

Or run the full local + cluster distribution proof (3-node docker, includes a live
node-kill): `bash scripts/show-distribution.sh` (see `docker-compose.cluster.yml`).
