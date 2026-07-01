#!/usr/bin/env bash
# Provision (or reuse) a CockroachDB Cloud Serverless cluster with the ccloud CLI
# — this satisfies the hackathon's "ccloud CLI (Agent-Ready)" required feature.
#
# Prereqs: `ccloud` installed + authenticated (`ccloud auth login`), or set
# CCLOUD_API_KEY. Reads COCKROACH_CLUSTER_NAME from the environment (.env).
#
#   bash scripts/provision-cluster.sh
#
# On success it prints the SQL connection string to paste into DATABASE_URL,
# then apply the schema with `npm run db:schema`.
set -euo pipefail

CLUSTER="${COCKROACH_CLUSTER_NAME:-archon-memory}"
CLOUD="${CCLOUD_CLOUD:-aws}"
REGION="${CCLOUD_REGION:-us-east-1}"

if ! command -v ccloud >/dev/null 2>&1; then
  echo "ccloud CLI not found. Install: https://www.cockroachlabs.com/docs/cockroachcloud/ccloud-get-started" >&2
  exit 1
fi

echo "→ Ensuring CockroachDB Cloud Serverless cluster '${CLUSTER}' (${CLOUD}/${REGION})"
if ccloud cluster list 2>/dev/null | grep -q "\b${CLUSTER}\b"; then
  echo "  cluster already exists — reusing"
else
  ccloud cluster create serverless "${CLUSTER}" --cloud "${CLOUD}" --region "${REGION}"
fi

echo "→ Connection string (paste into DATABASE_URL, add /archon_memory as the db):"
ccloud cluster sql "${CLUSTER}" --connection-string
