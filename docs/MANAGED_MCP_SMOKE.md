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

The hardened v2 proof is now live evidence. Exact commit
[`a2b69e3fad31010d14d0c3bca261421e635ca885`](https://github.com/upgradedev/archon-cockroach-memory/commit/a2b69e3fad31010d14d0c3bca261421e635ca885)
passed the post-production Managed MCP job in
[Deploy AWS run 30204081177](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30204081177).
The run passed the bounded live proof and exact v2 receipt gate, then uploaded
the sanitized
`managed-mcp-production-a2b69e3fad31010d14d0c3bca261421e635ca885`
artifact.

The same hardened proof passed again for the exact protected release commit
[`8c09b7ee07f1a3a0cd8ea19bf1db900c992e3edf`](https://github.com/upgradedev/archon-cockroach-memory/commit/8c09b7ee07f1a3a0cd8ea19bf1db900c992e3edf)
in [Deploy AWS run 30331875727, attempt 2](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30331875727/attempts/2).

## Separation from AWS delivery recovery

Managed MCP and CockroachDB prove the application memory data plane. They do
not act as the deployment rollback ledger and are not a hidden dependency of
AWS recovery.

The durable recovery revision was initially activated and hosted-proven at the
historical exact protected release commit above. Deploy AWS run 30331875727 committed both environment
intents after the full protected release; automatic
[Recover AWS run 30333619982](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30333619982)
proved trusted-source checkout, both recovery-role assumptions, exact
classification, cleanup, and the safe no-op path. Conditional writes in the
private, versioned S3 `candidates/recovery/<environment>/` prefix serialize
`ARMED → COMMITTED` or `ARMED → RECOVERING → RECOVERED`.

The checked-in watchdog classifies the exact source run after its completion
event, every 15 minutes, or on manual dispatch. A two-hour lease is bound to the
exact watchdog run, attempt, and environment; only expiry or proof that the
exact owner completed unsuccessfully permits early reclaim. Recovery emits a
strict schema-v2 `archon.durable-recovery.receipt`, distinct from the Managed
MCP schema-v2 receipt described above. Its finalizer verifies the immutable
manifest, exact `RECOVERING` ledger revision, and post-recovery
CloudFormation-control proof. It conditionally stores and round-trips both
checksum-addressed objects at exact S3 versions, then CAS-advances the same
lease to `RECOVERED` with both identities bound into the ledger.

CloudFormation preflight, terminal, recovery, and daily `04:17 UTC` audit gates
bind exact stack identity and revision, enforce termination protection, and run
fresh bounded drift detection. The watchdog uses trusted `main` code and fresh
environment-bound AWS OIDC credentials, so it can operate when the original
runner or application stack is unavailable. All application and recovery state
is restricted to AWS `eu-west-1`; CloudFront is global edge infrastructure, not
a `us-west-2` recovery workload.

DynamoDB would be a valid AWS-native implementation of this small control-plane
state machine, but no DynamoDB recovery ledger is deployed or required here.
CockroachDB remains the system for durable agent facts, provenance, lifecycle,
SQL audit, and vector recall; S3 recovery state contains no application memory
or Managed MCP response.

The required recovery trust and permissions are live. A separately authorized,
exact-template foundation change set modified only three managed-policy
documents in place, completed `UPDATE_COMPLETE`, and left foundation drift
`IN_SYNC`. The standard logging-only promotion workflow remains unable to
change IAM. The successful release and automatic watchdog do not constitute an
intentional `RECOVERING → RECOVERED` restoration, finalizer receipt, or daily
audit receipt; those remain unexercised live drills.

Recovery bundles, extracted files, and receipts are generated and validated in
protected CI under `${RUNNER_TEMP}` and removed from the runner after use. A
supplemental sanitized GitHub receipt may aid review, but the terminal recovery
proof is the immutable S3 receipt plus control proof bound into the ledger.
None of these files should be copied into the repository or treated as Managed
MCP evidence.

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
