#!/usr/bin/env bash
# Prove the vector index is DISTRIBUTED + SURVIVABLE across a multi-node CockroachDB
# cluster — the thing a single-node pgvector fundamentally cannot do.
#
# Prereqs: the 3-node cluster from docker-compose.cluster.yml, initialized, with the
# schema applied:
#
#   docker compose -f docker-compose.cluster.yml up -d
#   sleep 12
#   docker compose -f docker-compose.cluster.yml exec -T roach1 cockroach init --insecure || true
#   docker compose -f docker-compose.cluster.yml exec -T roach1 cockroach sql --insecure -e "CREATE DATABASE IF NOT EXISTS archon_memory"
#   export DATABASE_URL="postgresql://root@localhost:26257/archon_memory?sslmode=disable"
#   npm run db:schema
#   bash scripts/show-distribution.sh
#
# It loads a clustered corpus, scatters the ranges, and prints:
#   • every agent_memory range replicated RF=3 across all three nodes (survives a loss)
#   • leaseholders spread across the cluster (load distribution)
#   • the vector-index range(s) replicated across the nodes
#   • the live EXPLAIN proving the ANN query plans a `vector search` node on the cluster
set -euo pipefail

COMPOSE="docker compose -f docker-compose.cluster.yml"
SQL() { $COMPOSE exec -T roach1 cockroach sql --insecure -d archon_memory "$@"; }
LOAD_N="${DIST_N:-6000}"

echo "→ Loading ${LOAD_N} clustered memories into the distributed vector index"
LOAD_N="$LOAD_N" npm run load:corpus

echo "→ Scattering ranges to spread leaseholders across the cluster"
SQL -e "ALTER TABLE agent_memory SCATTER;" >/dev/null 2>&1 || true
sleep 8

echo
echo "════════════════════════════════════════════════════════════════════════"
echo "  agent_memory ranges — every range REPLICATED across all 3 nodes (RF=3),"
echo "  leaseholders spread over the cluster. Kill any one node: memory survives."
echo "════════════════════════════════════════════════════════════════════════"
SQL --format=table -e "SELECT range_id, lease_holder, replicas
        FROM [SHOW RANGES FROM TABLE agent_memory WITH DETAILS]
        ORDER BY range_id;"

echo
echo "→ Distribution summary:"
SQL --format=table -e "SELECT count(*) AS total_ranges,
               count(DISTINCT lease_holder) AS distinct_leaseholder_nodes
        FROM [SHOW RANGES FROM TABLE agent_memory WITH DETAILS];"

echo
echo "════════════════════════════════════════════════════════════════════════"
echo "  VECTOR INDEX ranges (agent_memory@idx_agent_memory_embedding)"
echo "  Compact (quantized) → one range at this size, replicated across the nodes."
echo "  Past the ~64 MiB range threshold CockroachDB auto-splits + rebalances the"
echo "  index across the cluster — the same mechanism, at scale (as on Cloud)."
echo "════════════════════════════════════════════════════════════════════════"
SQL --format=table -e "SELECT range_id, lease_holder, replicas
        FROM [SHOW RANGES FROM INDEX agent_memory@idx_agent_memory_embedding WITH DETAILS]
        ORDER BY range_id;"

echo
echo "════════════════════════════════════════════════════════════════════════"
echo "  EXPLAIN — the ANN recall query plans a 'vector search' node on the cluster"
echo "════════════════════════════════════════════════════════════════════════"
QVEC=$(SQL --format=raw -e "SELECT embedding::string FROM agent_memory WHERE company='_dist' LIMIT 1;" 2>/dev/null | grep -E '^\[' | head -1)
if [ -n "${QVEC:-}" ]; then
  SQL -e "EXPLAIN SELECT id FROM agent_memory ORDER BY embedding <=> '${QVEC}'::VECTOR LIMIT 10;"
fi

echo
echo "A single-node pgvector shows none of the above: one node, one copy, no cross-node"
echo "range replication, no survive-a-node-loss guarantee, no leaseholder spread."
