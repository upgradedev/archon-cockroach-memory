# CockroachDB Cloud Managed MCP — live read-only proof

Archon Memory uses CockroachDB Cloud's **hosted Managed MCP Server** as a
production-readiness control plane. This is distinct from the application's own
self-hosted memory MCP tools.

The managed connection is intentionally read-only in this workflow. An MCP client
asks CockroachDB Cloud to:

1. identify the live cluster;
2. list the application database tables;
3. inspect the `agent_memory` schema and native vector index; and
4. execute one bounded aggregate query.

It never prints the Cloud API key, SQL credentials, memory text, or embeddings.

## Verified live run

Run at **2026-07-23 06:23:43 UTC** against the live AWS `eu-west-1` CockroachDB
Cloud Basic cluster (CockroachDB **v26.2.1** at verification time).

```text
endpoint: https://cockroachlabs.cloud/mcp
transport: Streamable HTTP
tools advertised: 12

PASS get_cluster       — live cluster metadata returned
PASS list_tables       — agent_memory present in database archon
PASS get_table_schema  — VECTOR(1024) and native vector index present
PASS select_query      — bounded memory/company aggregate succeeded
```

The client received the following managed tools:

```text
create_database  create_table  explain_query  get_cluster
get_table_schema insert_rows   list_clusters  list_databases
list_tables      select_query  show_running_queries  show_statement
```

The application audit calls only the four read-only tools shown in the PASS list.

## Re-run

Create a scoped CockroachDB Cloud service-account API key and keep it outside the
repository:

```bash
export CCLOUD_API_KEY='<redacted>'
export COCKROACH_CLUSTER_ID='<cluster-uuid>'
export COCKROACH_DATABASE='archon'
npm run mcp:cloud:audit
```

The command emits a sanitized, machine-readable receipt and exits non-zero if the
table, vector type, vector index, or aggregate proof is missing.

Implementation: [`scripts/cloud-mcp-audit.ts`](../scripts/cloud-mcp-audit.ts).

## Why this is agentic

The control-plane agent is not a decorative connectivity test. It discovers the
live schema through MCP tool metadata and verifies that the deployed memory
substrate still matches the application's required invariants. This gives the
release pipeline an independent, SQL-credential-free check of the CockroachDB
deployment before or after an AWS application release.

