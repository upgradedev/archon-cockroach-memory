# Tool inventory and proof

Archon Memory uses **2 of the 4 required CockroachDB tools**:

1. Distributed Vector Indexing
2. CockroachDB Cloud Managed MCP

ccloud automation and the self-hosted application MCP server are useful
additional surfaces, but are not counted toward the required two.

## 1. Distributed Vector Indexing

Implementation:

- `src/db/schema.sql`
  - `agent_memory.embedding VECTOR(1024)`
  - native `CREATE VECTOR INDEX ... vector_cosine_ops`
  - global index for benchmark/fan-out evidence
  - prefix indexes on tenant, embedding model, lifecycle status, and company for
    the production query shape
- `src/memory/memory.ts`
  - cosine `ORDER BY embedding <=> $1::VECTOR`
  - exact filters for tenant, model space, active status, kind/company
  - no pgvector extension
- `scripts/benchmark.ts`, `scripts/fanout-demo.ts`,
  `scripts/show-distribution.sh`
  - recall@k, beam/latency, multi-range fan-out, RF=3 placement, and node-loss
    evidence

Proof:

- [BENCHMARK.md](./BENCHMARK.md)
- [CLOUD_SMOKE.md](./CLOUD_SMOKE.md)
- CI jobs `build-test` and `cluster-survival`
- The judge app `/api/proof` performs a live `pg_catalog.pg_indexes` check for
  `idx_agent_memory_company_scope_embedding`; it does not infer index health from
  a static feature label.

The currently recorded Cloud SQL capture is historical. The role-bound RLS and
prefix-index migration are counted as live only after the new production
deployment and Managed MCP audit receipts pass.

## 2. CockroachDB Cloud Managed MCP

Implementation:

- `scripts/cloud-mcp-audit.ts` connects to CockroachDB Cloud's hosted Managed MCP
  endpoint with a service-account API key.
- It permits only a bounded allowlist of read-only tools and fixed SQL.
- It verifies cluster identity, table discovery, `agent_memory` schema, and a
  fixed-scope select.
- It prints a sanitized JSON receipt with no API key, host, user, password, or
  connection string.
- `.github/workflows/managed-mcp-audit.yml` runs only in the protected
  `production-audit` environment and uploads the sanitized receipt.

Live proof:

- [MANAGED_MCP_SMOKE.md](./MANAGED_MCP_SMOKE.md) records the successful
  read-only proof against the live AWS `eu-west-1` cluster.

This is the hosted CockroachDB Cloud Managed MCP product. It is distinct from the
application MCP server below.

## Additional CockroachDB surfaces, not counted

### Application MCP server

`src/mcp/server.ts` exposes:

- `remember_memory` — write
- `recall_memory` — read-only native-vector recall
- `audit_memory` — read-only contradiction/absence audit

`tests/mcp.test.ts` drives a complete in-memory protocol round trip. This is an
application-owned MCP surface, not a substitute for Cloud Managed MCP.

### ccloud operator automation

`scripts/provision-cluster.sh` uses the current Basic-cluster command shape and
interactive `ccloud auth login`. It is not counted as a required tool until an
authenticated ccloud receipt is produced.

## AWS services

### Amazon Bedrock

- Titan Text Embeddings V2:
  `amazon.titan-embed-text-v2:0`, normalized 1024 dimensions.
- Claude Sonnet 4.6 cross-region inference profile:
  `eu.anthropic.claude-sonnet-4-6`.
- [BEDROCK_SMOKE.md](./BEDROCK_SMOKE.md) records a real `eu-west-1` execution.

### Judge application

- Amazon S3: encrypted, versioned private React/Tailwind origin.
- Amazon CloudFront: OAC, same-origin delivery, security headers, HTTP/2+3.
- Amazon API Gateway HTTP API: fixed read-only routes and throttling.
- AWS Lambda Node.js 22: bounded recall/audit/proof adapter.
- AWS Secrets Manager: least-privilege CockroachDB URL.
- AWS X-Ray and CloudWatch: traces, logs, alarms, dashboard.
- AWS CodeDeploy via SAM: production canary.
- GitHub Actions OIDC to AWS STS: short-lived staging/production delivery
  credentials.

Infrastructure and delivery proof live in:

- `aws/template.yaml`
- `aws/bootstrap-oidc.yaml`
- `.github/workflows/ci.yml`
- `.github/workflows/deploy-aws.yml`
- `aws/create-deployment-receipt.mjs`
