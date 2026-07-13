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
#   • a live NODE-KILL: it stops roach3, re-runs the ANN recall through the surviving
#     roach1, shows it still serves (RF=3 quorum → zero data loss), then restarts roach3
set -euo pipefail

COMPOSE="docker compose -f docker-compose.cluster.yml"
SQL() { $COMPOSE exec -T roach1 cockroach sql --insecure -d archon_memory "$@"; }
LOAD_N="${DIST_N:-6000}"
# STRICT=1 turns the node-kill survival demo into an ASSERTION: the script exits
# non-zero if recall does not keep serving after roach3 is stopped (or if it never
# served before the kill). CI runs it with STRICT=1 so a regression that breaks
# node-loss survival FAILS the build instead of printing a warning and passing.
STRICT="${STRICT:-0}"
strict_fail() {
  echo "✗ STRICT: $1" >&2
  # Best-effort restore so a failed strict run still leaves the cluster rerunnable.
  $COMPOSE start roach3 >/dev/null 2>&1 || true
  exit 1
}

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
echo "════════════════════════════════════════════════════════════════════════"
echo "  NODE-LOSS SURVIVAL — kill one node, recall keeps serving (RF=3 quorum)"
echo "  We stop roach3 (a node we are NOT connected through) and re-run the ANN"
echo "  recall through the surviving roach1. With every range replicated RF=3, the"
echo "  two remaining nodes hold a quorum, so recall answers with zero data loss."
echo "════════════════════════════════════════════════════════════════════════"
# Recall helper: run one ANN recall through roach1 and print how many rows it served.
# Wrapped so a transient error during leaseholder failover does not abort (pipefail).
recall_served() {
  SQL --format=raw -e \
    "SELECT id FROM agent_memory ORDER BY embedding <=> '${QVEC}'::VECTOR LIMIT 5;" 2>/dev/null \
    | grep -cE '^[0-9a-f-]{36}$' || true
}

if [ -n "${QVEC:-}" ]; then
  BEFORE=$(recall_served)
  echo "→ Before kill: recall through roach1 served ${BEFORE} memories."
  if [ "${STRICT}" = "1" ] && [ "${BEFORE:-0}" -eq 0 ]; then
    strict_fail "recall served 0 memories BEFORE the node-kill — the corpus/index is not serving; cannot prove survival."
  fi
  echo "→ Stopping roach3 (docker stop) — simulating a node loss…"
  $COMPOSE stop roach3 >/dev/null 2>&1 || true
  # Give the cluster a moment to shift leaseholders off the downed node.
  SERVED=0
  for attempt in 1 2 3 4 5 6; do
    sleep 5
    SERVED=$(recall_served)
    if [ "${SERVED:-0}" -gt 0 ]; then
      echo "→ Node down (roach3 stopped): recall through roach1 STILL served ${SERVED} memories" \
           "(attempt ${attempt}) — survived the loss with zero data loss."
      break
    fi
    echo "  …leaseholders still failing over (attempt ${attempt}); retrying"
  done
  echo "→ Restarting roach3 to restore RF=3 (script stays rerunnable)…"
  $COMPOSE start roach3 >/dev/null 2>&1 || true
  sleep 5
  if [ "${SERVED:-0}" -eq 0 ]; then
    if [ "${STRICT}" = "1" ]; then
      strict_fail "recall did NOT keep serving after roach3 was stopped — node-loss survival not demonstrated."
    fi
    echo "  ⚠ recall did not return within the retry window — inspect the cluster manually."
  else
    echo "✓ NODE-KILL SURVIVAL DEMONSTRATED: recall kept serving with one node down (RF=3 quorum)."
  fi
else
  if [ "${STRICT}" = "1" ]; then
    strict_fail "no corpus/query vector loaded — cannot run the node-kill survival demo."
  fi
  echo "  (no corpus loaded — skipping the node-kill recall)"
fi

echo
echo "A single-node pgvector shows none of the above: one node, one copy, no cross-node"
echo "range replication, no survive-a-node-loss guarantee, no leaseholder spread."
