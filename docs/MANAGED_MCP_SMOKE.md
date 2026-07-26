# CockroachDB Cloud Managed MCP — receipt schema v2

Archon Memory uses CockroachDB Cloud's hosted **Managed MCP Server** as an
independent production-readiness control plane. This is distinct from the
application-owned memory MCP server.

The protected audit is read-only and calls exactly four advertised tools, once
each and in this order:

1. `get_cluster`;
2. `list_tables`;
3. `get_table_schema`; and
4. `select_query`.

No create, insert, update, or administrative Managed MCP tool is called.

## Exact bounded Store proof

`select_query` receives SQL fixed in
[`scripts/cloud-mcp-audit.ts`](../scripts/cloud-mcp-audit.ts). It cannot be
changed with environment variables or workflow input. The query:

- equality-constrains tenant `public-demo`;
- equality-constrains company `Helios SA`;
- equality-constrains lifecycle status `active`;
- equality-constrains embedding model
  `amazon.titan-embed-text-v2:0`;
- forces `idx_agent_memory_active_scope`;
- selects only `idempotency_key` and `content_hash` inside an ordered
  `LIMIT 10` sentinel;
- aggregates that bounded result; and
- applies an outer `LIMIT 1`.

The tenth inner row is a fail-closed overflow sentinel: the canonical public
fixture has nine rows, so a tenth row produces `persisted = 10` and fails. The
single returned aggregate must contain exactly these keys and numeric values:

| Key | Required value |
|---|---:|
| `persisted` | 9 |
| `idempotency_keys` | 9 |
| `content_digests` | 9 |

`idempotency_keys` counts only non-empty bounded keys.
`content_digests` counts only distinct lowercase 64-character SHA-256 values.
The Managed MCP response must be either `structuredContent` containing
`{"rows":[one]}` or one MCP text block containing that exact JSON shape.
Additional/missing keys, additional/missing rows, numeric strings, negative or
fractional counts, unsafe integers, invalid JSON, ambiguous structured/text
payloads, and any value other than `9 / 9 / 9` fail closed.

## Sanitized v2 receipt contract

The receipt contains only:

- `schemaVersion: 2`, `ok`, and a UTC `checkedAt`;
- the public Managed MCP endpoint and a validated database identifier;
- `mode: "read-only"`;
- the exact `scope`, `bound`, and `aggregate` above;
- the exact four-entry `calledTools` list;
- a safe integer count of advertised tools;
- exactly four named boolean proofs with fixed, source-owned descriptions; and
- a fixed list of redaction categories.

It contains no API-key value, cluster identifier, SQL credential or connection
URL, memory content, embedding, or raw Managed MCP response. Both protected
workflows capture stdout without streaming the unvalidated file, check for the
actual API-key and cluster-ID values, enforce the complete top-level JSON key
set, every fixed nested value, and the four exact proof objects, and only then
upload a receipt.

## Historical live evidence — pre-hardening

The exact commit
[`25ca1c84f9df7721b8415b9bd55cc5849bf96ca4`](https://github.com/upgradedev/archon-cockroach-memory/commit/25ca1c84f9df7721b8415b9bd55cc5849bf96ca4)
passed the post-production Managed MCP job in
[Deploy AWS run 30144685107](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30144685107).
At **2026-07-23 06:23:43 UTC**, that run connected to the live AWS
`eu-west-1` CockroachDB Cloud Basic cluster, observed CockroachDB v26.2.1 and 12
advertised tools, and passed the four read-only tool checks.

That run is historical **pre-hardening** evidence. It predates receipt schema v2:
its aggregate was not pinned to the exact four-axis scope, did not force
`idx_agent_memory_active_scope`, did not use the ten-row/one-row bounds, and was
not parsed or workflow-gated as exact typed `9 / 9 / 9`. It therefore proves live
Managed MCP connectivity and tool availability only. It must not be cited as a
successful v2 receipt.

At the time this source contract was added, a new protected v2 run had not yet
been recorded. The v2 proof becomes live evidence only when either
[the dedicated Managed MCP workflow](../.github/workflows/managed-mcp-audit.yml)
or the post-production job in
[`deploy-aws.yml`](../.github/workflows/deploy-aws.yml) passes against the live
cluster and publishes its sanitized artifact.

## Protected re-run

The recommended path is GitHub Actions:

1. configure `CCLOUD_API_KEY` as a protected `production-audit` secret;
2. configure `COCKROACH_CLUSTER_ID` and `COCKROACH_DATABASE` as protected
   variables;
3. dispatch **Cockroach Cloud Managed MCP Audit**; and
4. retain the resulting sanitized receipt artifact as the live evidence.

For an authorized operator reproducing the client outside CI:

```bash
export CCLOUD_API_KEY='<redacted>'
export COCKROACH_CLUSTER_ID='<cluster-uuid>'
export COCKROACH_DATABASE='archon'
npm run mcp:cloud:audit
```

Do not copy the emitted receipt into the repository. Generated Managed MCP
receipts are ignored and readiness-gated as local artifacts.
