# Tool inventory and proof

Archon Memory meaningfully integrates **two CockroachDB tools**:

1. Distributed Vector Indexing
2. CockroachDB Cloud Managed MCP

Together they form one causal tool chain: the Financial Memory Agent uses
Distributed Vector Indexing as its memory data plane, and the Memory Integrity
Agent uses Cloud Managed MCP as an independent control plane that must pass
before staging or production promotion. ccloud automation and the self-hosted
application MCP server are useful additional surfaces, but are not counted.

## 1. Distributed Vector Indexing

Implementation:

- `src/db/schema.sql`
  - `agent_memory.embedding VECTOR(1024)`
  - native `CREATE VECTOR INDEX ... vector_cosine_ops`
  - global index for benchmark/fan-out evidence
  - `idx_agent_memory_company_scope_embedding` with
    `tenant_id + embed_model + status + company` equality prefixes
  - `idx_agent_memory_company_kind_scope_embedding` with
    `tenant_id + embed_model + status + company + kind` equality prefixes
  - fixed-predicate `archon_public_memory_recall` and
    `archon_public_memory_kind_recall` serving views, owned by the isolated
    non-login view owner while the runtime principals remain RLS-bound
- `src/memory/memory.ts`
  - cosine `ORDER BY embedding <=> $1::VECTOR`
  - exact filters for tenant, model space, active status, kind/company
  - one shared query builder that routes the no-kind and kind public paths
    through their exact serving view and C-SPANN index
  - no pgvector extension
- `scripts/verify-database-release.ts` and
  `.github/workflows/database-release.yml`
  - as each real staging and production runtime principal, `EXPLAIN` the exact
    shared application query and require its exact C-SPANN index
  - execute both query paths and verify bounded results, fixed scope, finite
    distances, and the expected self-probe
  - query both serving views with the three wrong-company, wrong-tenant, and
    retracted-status canary vectors; reassert every C-SPANN equality prefix
    required by CockroachDB, use a high-recall gate beam, require exactly three
    rejected canaries per path, and reject any visible canary. Exact catalog,
    owner, grant, and view-definition checks independently prove that the
    serving-view boundary itself has not drifted.
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
- The protected database release goes further: using each real staging and
  production credential, it runs the exact shared application query, requires
  a `vector search` plan on both the company and company+kind C-SPANN indexes,
  executes both recalls, verifies the returned fixed scope and probe row, and
  behaviorally rejects all three isolation canaries through both views.

The recorded Cloud SQL capture remains historical supporting evidence. One
historical live serving-path milestone is the protected database release,
production deployment, and Managed MCP receipt from
[Deploy AWS run 30331875727, attempt 2](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30331875727/attempts/2)
at exact commit `8c09b7ee07f1a3a0cd8ea19bf1db900c992e3edf`.
The latest pinned feature-bearing release baseline is
[`f3fafdac8d93a266eda9831edd0d66132940ec7b`](https://github.com/upgradedev/archon-cockroach-memory/commit/f3fafdac8d93a266eda9831edd0d66132940ec7b)
in [Deploy AWS run 30533467206](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30533467206);
that run re-proved both runtime-principal C-SPANN paths before staging and
production promotion.

## 2. CockroachDB Cloud Managed MCP

Implementation:

- `scripts/cloud-mcp-audit.ts` connects to CockroachDB Cloud's hosted Managed MCP
  endpoint with a service-account API key.
- It always calls exactly `get_cluster`, `list_tables`, `get_table_schema`, and
  `select_query`, in that order.
- If and only if the hosted server advertises `explain_query`, the agent inserts
  that read-only call immediately before `select_query` and requires a
  `vector search` plan on
  `idx_agent_memory_company_scope_embedding`. An advertised but incompatible or
  incorrect capability fails closed. If it is not advertised, the receipt says
  `not-advertised`; it never claims the call occurred.
- Its fixed SQL equality-constrains
  `public-demo / Helios SA / active / amazon.titan-embed-text-v2:0`, forces
  `idx_agent_memory_active_scope`, applies an inner `LIMIT 10` sentinel, and
  applies an outer `LIMIT 1`.
- It parses only `{ "rows": [one exact aggregate row] }` from either MCP text or
  `structuredContent`, requires safe integer types, and fails unless persisted
  rows, distinct idempotency keys, and valid distinct content digests are exactly
  `9 / 9 / 9`.
- It verifies cluster identity, table discovery, `agent_memory` schema, and a
  fixed-scope select.
- Receipt schema v3 binds the exact 40-character release SHA and SHA-256 of the
  exact database-release C-SPANN receipt. It prints the exact scope, bounds,
  aggregate, called-tool list, optional EXPLAIN status/plan fingerprint, and
  fixed proof descriptions, with no API key, cluster identifier, host, user,
  password, connection string, memory content, embedding, or raw query plan.
- `.github/workflows/deploy-aws.yml` downloads and validates the exact
  database-release receipt before invoking Managed MCP. Both staging and
  production explicitly depend on this job, so the second CockroachDB tool is a
  causal promotion gate rather than a post-deployment report.
- `.github/workflows/managed-mcp-audit.yml` runs only in the protected
  `production-audit` environment, resolves the successful exact-SHA deployment,
  downloads its database C-SPANN receipt, exact-gates every v3 field, checks
  that secret values are absent, records the receipt digest, and uploads only
  the sanitized receipt.

Evidence status:

- The pinned feature-release contract passed in
  [Deploy AWS run 30533467206](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30533467206)
  and was independently re-proved after deployment in
  [Managed MCP run 30535180779](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30535180779).
  The standalone receipt is
  [artifact 8756341014](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30535180779/artifacts/8756341014),
  digest
  `sha256:49c73cbc84c6efd9949639ca92a216cd83aa06f1674c8b37521f87385db898a4`.
- [MANAGED_MCP_SMOKE.md](./MANAGED_MCP_SMOKE.md) separates the successful
  historical live read-only proof from the hardened v2 contract. That historical
  contract
  passed at exact commit `a2b69e3fad31010d14d0c3bca261421e635ca885`
  in [Deploy AWS run 30204081177](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30204081177);
  its fixed scope, bounds, strict parser, `9 / 9 / 9` aggregate, and sanitized
  artifact were all protected-workflow verified. The same contract passed for
  later historical protected release commit `8c09b7ee07f1a3a0cd8ea19bf1db900c992e3edf`
  in [Deploy AWS run 30331875727, attempt 2](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30331875727/attempts/2).

These are immutable historical v2 receipts. Receipt v3 is deliberately not
claimed as live until a protected exact-SHA CI, deploy, and standalone audit
have all passed after this source change.

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
- Amazon API Gateway HTTP API: fixed canonical-read routes, isolated synthetic
  resolution routes, and throttling.
- AWS Lambda Node.js 22: bounded recall/audit/proof adapter plus the
  human-gated, idempotent resolution controller.
- AWS Secrets Manager: least-privilege CockroachDB URL.
- AWS X-Ray and CloudWatch: traces, logs, alarms, dashboard.
- AWS CodeDeploy via SAM: 10%/5-minute canary continuously exercises live proof
  and recall while a fresh alarm isolates the candidate `ExecutedVersion`
  behind the weighted alias. Mandatory full-recall and hosted-browser gates
  follow, with explicit prior-release restoration.
- Amazon SNS, Amazon SQS, and AWS KMS: a source-controlled but currently
  dormant alarm-routing contract. Explicit foundation activation creates
  environment-isolated encrypted topics and 14-day audit queues; deploy
  auto-discovery and terminal proof refuse partial outputs or cross-environment
  alarm actions, and inactive proof rejects stale actions. The queues deny
  non-topic producers and are finite delivery/evidence buffers, not immutable
  records or human-notification endpoints. Activation first requires an
  authorized administrator to apply the exact stack policy and foundation
  template. Until that synchronization, discovery emits the distinct
  `legacy-inactive-not-provisioned` state, sends the complete SAM parameter map
  through a temporary runner-local `file://` YAML document, explicitly clears
  `AlarmTopicArn`, and relies on the existing CloudFormation drift gates;
  afterward an unconditional read-only alarm policy enables direct
  four-alarm verification even while routing is disabled. No live activation,
  queue consumer, or human paging endpoint is claimed.
- GitHub Actions OIDC to AWS STS: short-lived staging/production delivery
  credentials.

### Durable delivery recovery control plane — live protected activation

This control plane's initial activation was hosted-proven at historical exact protected release commit
`8c09b7ee07f1a3a0cd8ea19bf1db900c992e3edf`.
[Main CI](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30331668301),
[CodeQL](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30331668308),
the full protected
[Deploy AWS run](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30331875727/attempts/2),
and automatic
[Recover AWS classification](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30333619982)
all succeeded. Both ledgers are terminal `COMMITTED` with no active lease. This
proves live IAM/OIDC activation and the committed/no-pending-recovery watchdog
path, not an intentionally fault-injected `RECOVERED` restoration.

The design uses the private, versioned artifact bucket with
environment-isolated deployment objects under
`candidates/deployments/<environment>/` and recovery objects under
`candidates/recovery/<environment>/`, so it does not require a new recovery
database or cross-environment recovery authority. A temporary, read-only,
exact-length `candidates/<40-character-id>/` compatibility path remains only
for CloudFormation and CodeDeploy rollback of the immediately preceding
pre-migration revision; it grants neither write nor list access. The bootstrap
template defines the required `Recover AWS` OIDC trust and least-privilege
recovery actions. A separately authorized exact-template promotion applied
only three in-place managed-policy document updates; the live default policies
and foundation `IN_SYNC` drift state were verified.

- Private, encrypted, versioned Amazon S3 stores data-only, intent-bound
  archives and checksum-addressed receipts under
  `candidates/recovery/<environment>/`. Conditional creation prevents an
  existing immutable object from being replaced.
- One fixed ledger object per `staging` or `production` environment is created
  with `If-None-Match: *` and advanced only with
  `If-Match: <current ETag>`. This implements the
  `ARMED → COMMITTED` or `ARMED → RECOVERING → RECOVERED`
  compare-and-swap state machine, lease, and prior-revision chain.
- Each ledger revision binds the candidate, source CI and deploy identities,
  immutable bundle identity, archive/manifest digests, lease owner and expiry,
  and—only for `RECOVERED`—the immutable receipt and post-recovery
  CloudFormation-control object identities and digests.
- The checked-in watchdog classifies the exact source run and terminal
  environment job after `Deploy AWS` completion, every 15 minutes, or on
  manual dispatch. It claims a two-hour lease bound to its exact run, attempt,
  and environment. An active owner blocks competing work; an expired lease or
  an exactly proved completed non-success owner can be reclaimed through CAS.
- Recovery emits a strict schema-v2
  `archon.durable-recovery.receipt`. Its validator cross-checks the sanitized
  target, executor, archive, exact `RECOVERING` ledger identity, and restoration
  proofs against the immutable manifest and ledger revision.
- The idempotent finalizer conditionally creates checksum-addressed receipt and
  post-recovery CloudFormation-control objects, reads back both exact S3
  versions, verifies bytes, SHA-256, S3 checksum, encryption, content type, and
  metadata, and only then CAS-advances the same lease to `RECOVERED`, binding
  both objects. An ambiguous retry passes only when the existing terminal
  ledger has the exact receipt, control proof, and prior-ledger binding.
- CloudFormation preflight and terminal gates bind exact stack identity,
  revision, execution role, and canonical tags, enforce and re-prove
  termination protection, and require fresh bounded drift detection. Recovery
  proves the restored stack through the same controls or proves exact
  greenfield absence. An audit that does not mutate protection is defined daily
  at `04:17 UTC` when no recovery is pending. Operators can replay that exact
  audit from the current trusted `main` SHA by dispatching `Recover AWS` with
  `operation=audit`; the workflow still refuses stale default-branch code.
- The watchdog uses trusted `main` code and fresh environment-bound OIDC
  credentials for long recovery and finalization boundaries. It does not
  depend on GitHub artifact retention, the failed runner's workspace, or
  application availability.
- All recovery workloads and state are restricted to `eu-west-1`. CloudFront
  remains a global edge service; no recovery compute or data workload is
  introduced in `us-west-2`.

CockroachDB and the S3 ledger serve different roles. CockroachDB is the
application data plane and agent memory: relational facts, provenance,
lifecycle, audit, and vector retrieval. S3 is only the independent AWS delivery
control plane for two environments. DynamoDB could also implement that small
conditional state machine, but no DynamoDB recovery ledger is claimed as
deployed or required.

The unselected DynamoDB option would require a controlled foundation promotion:
the activation-only role cannot create the table or grant itself and the deploy
roles new IAM actions, and the foundation stack has no persistent
CloudFormation service role. The selected S3 CAS design avoids new database
authority. Its recovery, finalization, cleanup, termination-protection, and
drift permissions were promoted through the separately authorized
exact-template foundation change set. The live policies, protected
staging/production release, and automatic recovery classifier passed. The
logging-only foundation workflow remains unable to mutate IAM; future IAM
changes still require separate authorization. An actual
`RECOVERING → RECOVERED` restoration/finalizer and daily audit receipt are not
claimed by these successful no-failure runs.

The source components are:

- `aws/classify-durable-recovery-source.sh`
- `aws/create-durable-recovery-bundle.sh`
- `aws/delete-greenfield-stack.sh`
- `aws/download-durable-recovery-bundle.sh`
- `aws/enforce-cloudformation-controls.sh`
- `aws/extract-durable-recovery-bundle.sh`
- `aws/finalize-durable-recovery-receipt.sh`
- `aws/put-durable-recovery-object.sh`
- `aws/recover-durable-environment.sh`
- `aws/verify-durable-recovery-bundle.sh`
- `aws/verify-durable-recovery-receipt.sh`
- `aws/recovery-intent-ledger.sh`
- `.github/workflows/deploy-aws.yml`
- `.github/workflows/recover-aws.yml`

Bundle creation, immutable-object download, extraction, verification,
finalization, watchdog simulation, and receipt checks remain CI-only. Deploy
AWS run 30331875727 generated and validated the staging and production recovery
objects under `${RUNNER_TEMP}`, committed both intents, and removed temporary
runner material. Recover AWS run 30333619982 proved the trusted-source,
environment-OIDC classifier and cleanup path. Because both intents were already
`COMMITTED`, no restoration receipt or post-recovery control object was created.

For the pinned exact feature release, [Deploy AWS run 30533467206](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30533467206)
again committed both receipt-bound environment intents and removed runner
material. The independent manual
[Recover AWS audit 30535183552](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30535183552)
then passed fresh staging and production termination-protection and drift
checks, uploading only sanitized audit receipts with GitHub-bound digests.

Infrastructure and delivery proof live in:

- `aws/template.yaml`
- `aws/bootstrap-oidc.yaml`
- `.github/workflows/ci.yml`
- `.github/workflows/deploy-aws.yml`
- `aws/create-deployment-receipt.mjs`
