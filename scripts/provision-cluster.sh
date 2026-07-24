#!/usr/bin/env bash
# Provision (or reuse) a CockroachDB Cloud Basic cluster with the current ccloud CLI.
#
# Prereqs: `ccloud` installed and interactively authenticated (`ccloud auth login`).
# ccloud does not use CCLOUD_API_KEY as a drop-in CLI login; that service-account key
# is reserved for the Cloud API / Managed MCP audit.
#
#   bash scripts/provision-cluster.sh
#
# On success it prints the SQL connection URL to paste into DATABASE_URL, then apply
# the schema with `npm run db:schema`.
set -euo pipefail

CLUSTER="${COCKROACH_CLUSTER_NAME:-archon-cockroachdb-cluster}"
CLOUD="${CCLOUD_CLOUD:-AWS}"
REGION="${CCLOUD_REGION:-eu-west-1}"  # matches the live cluster (archon-cockroachdb-cluster-27534, AWS eu-west-1)

if ! command -v ccloud >/dev/null 2>&1; then
  echo "ccloud CLI not found. Install: https://www.cockroachlabs.com/docs/cockroachcloud/ccloud-get-started" >&2
  exit 1
fi

echo "→ Ensuring CockroachDB Cloud Basic cluster '${CLUSTER}' (${CLOUD}/${REGION})"
if ccloud cluster list -o json 2>/dev/null | grep -q "\"name\"[[:space:]]*:[[:space:]]*\"${CLUSTER}\""; then
  echo "  cluster already exists — reusing"
else
  ccloud cluster create basic "${CLUSTER}" "${REGION}" --cloud "${CLOUD}" --spend-limit 0
fi

echo "→ Connection URL (paste into DATABASE_URL and select the application database):"
ccloud cluster sql --connection-url "${CLUSTER}"
