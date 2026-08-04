---
status: submission-copy-complete
project: Archon Memory
tagline: Financial agent memory that disagrees out loud before a CFO acts.
repository: https://github.com/upgradedev/archon-cockroach-memory
demo: https://d2s5v0o0eg2aaw.cloudfront.net
thumbnail: demo/assets/devpost-thumbnail.png
video_delivery: supplied through the final hosted submission gate after public upload
---

# Archon Memory

## Demo status, read this first — 2026-08-04

The hosted demo's data plane is down. The page loads and `/api/health` answers
200, but that endpoint is a reachability stub reporting
`"dependencies":"unchecked"`. `/api/proof`, `/api/audit`, and `POST /api/recall`
have returned HTTP 500 since 2026-08-02 11:20 UTC; the last successful
data-plane response was 2026-07-31 01:22 UTC. The CockroachDB Cloud Basic
cluster reached its Request Unit allowance and is disabled, so the runtime
principal is refused with `the maximum number of allowed connections is 0`.

This is a cluster budget state, not a code or deployment regression. The judge
journey below describes the application as it behaves with a live cluster; with
the cluster disabled, steps 2 through 5 will show errors instead of data. The
hosted CI evidence is unaffected — every run link in this repository is a
completed GitHub Actions run bound to an exact commit and remains viewable.

**Latest hosted evidence for the deployed commit:** [CI run
30577405580](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30577405580)
at `0b25d5f1`, all ten jobs successful — 388 backend tests (385 passed, 3
skipped, 0 failed) and 42/42 frontend unit tests with 4/4 Playwright journeys.
The full ledger is [docs/DEMO_URL.md](./DEMO_URL.md).

## Inspiration

Financial agents can retrieve a plausible fact and still be dangerously wrong:
the durable memory may contain an older value, a conflicting revision, or a
reference to evidence that was never stored. Conventional RAG demos optimize
for finding a nearby chunk. A CFO needs a stronger question answered first:
**does the memory agree with itself, and can every claim be traced to evidence?**

Archon Memory is a Financial Memory Control Room that makes persistent agent
memory inspectable before a human acts on it.

## What it does

The public demo uses a fixed, synthetic company called Helios SA. Canonical
memory is read-only; a separate disposable sandbox permits only one fixed,
human-gated resolution action.
A judge can:

1. Ask a financial question in the Control Room.
2. Retrieve durable facts through CockroachDB's native distributed vector
   index.
3. Inspect the exact cited memories behind the grounded answer.
4. Run a complete-scope audit that surfaces one deliberate invoice
   contradiction and one missing payment counterpart.
5. Inspect a live proof ledger for database identity, runtime principal,
   fixed scope, models, vector index, and the exact `9 / 9 / 9` Store
   integrity contract.
6. Open a longitudinal resolution session, compare an older payroll memory
   with newer signed evidence, explicitly approve or reject the proposal, and
   inspect the consolidated state plus SHA-256 decision receipt.

The system never hides weak grounding. It abstains when evidence is irrelevant,
checks citations, numbers, and claims, and can replace unsafe model wording with
an exact deterministic rendering of the cited evidence.

The lifecycle is explicit **Store → Retrieve → Act**. `MemoryAgent.ingestEvent`
and `remember` idempotently store embedded facts with provenance, content
digests, and lifecycle state. C-SPANN retrieves only the fixed active scope.
The agent then acts by returning a cited grounded answer, abstaining, falling
back to deterministic evidence wording, or proposing a correction. The agent
cannot finalize that proposal. A judge may explicitly act as the fixed
synthetic controller role; CockroachDB then commits an idempotent serializable
decision, consolidation record, and immutable receipt. This is not
authenticated enterprise RBAC and has no external financial side effect.

The nine-row live story is deliberately small enough to inspect end to end.
Reproducible hosted evaluations separately exercise 5,000–10,000-vector
corpora, a deterministic 100,000-event lifecycle rehearsal, B0–B4 longitudinal
baselines, eight policy ablations, beam/recall behavior, multi-range fan-out,
RF=3 placement, and recall after single-node loss. These are explicitly
synthetic/representative evaluations, not customer production data or human
outcome evidence.

## Why it matters

Month-end close, payroll review, and audit preparation depend on facts written
across different sessions and source documents. Archon Memory targets the
failure modes that ordinary semantic search can hide: a stale amount outranking
the confirmed one, an untraceable answer, a referenced payment that was never
stored, or a fluent model response that changes the numbers. It gives finance
operators inspectable evidence before they approve or escalate an action; it
does not claim fabricated savings or autonomous financial authority.

## How we used CockroachDB

### Distributed Vector Indexing

This is the load-bearing runtime retrieval path, not a decorative benchmark.
Each durable memory stores provenance, lifecycle state, idempotency key,
content digest, embedding model, and a `VECTOR(1024)` embedding. Production
recall uses a CockroachDB-native C-SPANN vector index with exact equality
prefixes for tenant, model, active status, and company.

The protected database release executes and explains the real application
queries as the real staging and production principals. It also proves row-level
security, fixed-scope serving views, catalog ownership, grants, isolation
canaries, and native index use before application promotion.

### CockroachDB Cloud Managed MCP

The Financial Memory Agent uses Distributed Vector Indexing for its runtime
memory data plane. A separate deterministic Memory Integrity Agent uses
CockroachDB Cloud Managed MCP as its independent read-only control plane. This
is a causal integration: after the protected database release, the Managed MCP
agent must verify the same exact release before either staging or production can
be promoted.

The agent always makes four bounded hosted calls:

- cluster identity;
- table listing;
- schema inspection;
- one fixed-scope aggregate query.

If and only if the hosted MCP server advertises `explain_query`, the agent also
uses it to require a native `vector search` plan on
`idx_agent_memory_company_scope_embedding`. If the advertised call cannot prove
that exact C-SPANN path, the release fails closed. If the capability is absent,
the receipt records `not-advertised` and links to the exact-SHA
database-release C-SPANN receipt instead; the submission never claims a tool
call that did not happen.

The query is pinned to the synthetic public scope, forces the fixed-scope B-tree
`idx_agent_memory_active_scope` (not the C-SPANN retrieval index), reads through
a ten-row sentinel, returns at most one aggregate row, and accepts only
`9 persisted / 9 unique idempotency keys / 9 payload-bound digests`.
The resulting receipt schema v3 binds the 40-character release SHA, exact
database C-SPANN receipt SHA-256, actual called-tool sequence, Store aggregate,
and optional plan fingerprint. Credentials, connection material, memory text,
embeddings, and raw query plans are never emitted.

## How we used AWS

The application follows the AWS serverless web reference pattern:

- Amazon CloudFront provides the public same-origin edge.
- A private, encrypted, versioned Amazon S3 origin serves React and Tailwind.
- Amazon API Gateway exposes bounded canonical-read routes and one fixed
  synthetic, TTL-scoped action surface.
- AWS Lambda runs the Node.js 22 API with five bounded in-flight slots—three
  initial Control Room reads, one recall, and one spare—while API request rate
  and burst limits are enforced independently.
- AWS Secrets Manager supplies the least-privilege CockroachDB connection at
  runtime; it is never stored in source or a Lambda environment variable.
- Amazon Bedrock Titan Text Embeddings V2 creates normalized 1024-dimensional
  vectors.
- Amazon Bedrock Claude Sonnet 4.6 narrates only from retrieved evidence.
- AWS CodeDeploy canaries, CloudWatch metrics/logs/alarms, X-Ray, IAM, OIDC,
  CloudFormation, and private S3 receipts protect and explain promotion.

Regional AWS application resources and API entry points, plus the CockroachDB
cluster, are anchored in `eu-west-1`. CloudFront is global. Claude uses an EU
cross-region inference profile. A scoped inventory found no application
resources in `us-west-2`.

Alarm-routing infrastructure is source-controlled but deliberately dormant:
the live alarms have no actions and no SNS/SQS/KMS routing resources are claimed
as active. This keeps the submission accurate while preserving a separately
authorized activation path.

## Architecture

```text
Judge browser
  -> CloudFront
       -> private S3 (React + Tailwind)
       -> API Gateway /live
            -> Lambda
                 -> Bedrock Titan embeddings
                 -> CockroachDB Cloud SQL + RLS + C-SPANN
                 -> Bedrock Claude grounded narration

CockroachDB Cloud Managed MCP
  -> deterministic, bounded, read-only release proof
```

## Judge journey

1. Open the public demo and confirm the fixed synthetic, read-only scope.
2. Ask: “What was the true employer cost and the off-bank wedge?”
3. Inspect the answer, exact citations, C-SPANN trace, model identity, and
   citation/numeric/claim grounding state.
4. Open the audit ledger and inspect:
   - the `INV-2043` contradiction (`€18,400` versus `€18,900`), with the
     deterministic importance-based recommendation;
   - the missing `PAY-118` counterpart referenced by `RECON-2043`.
5. Open the proof ledger and confirm CockroachDB, native C-SPANN, `eu-west-1`,
   and exact `9 / 9 / 9` Store integrity.
6. Inspect the owned, sanitized exact-SHA evidence card for the separate
   Managed MCP release audit.

### Not in the deployed baseline: the Memory Resolution Loop

The Memory Resolution Loop — start the loop, approve the higher-authority signed
correction, inspect Session C and the immutable receipt — is implemented and
CI-covered on `main` (`src/memory/resolution.ts`, `src/http/resolution-handler.ts`,
`web/src/components/MemoryResolutionLoop.tsx`, and
[MEMORY_RESOLUTION_LOOP.md](./MEMORY_RESOLUTION_LOOP.md)).

It is **not** deployed. The commit serving the demo, `0b25d5f1`, contains none of
those files, and the deployed API answers `/api/resolution/session` with 404. A
judge cannot walk this step at the demo URL; it is listed here as implemented
work, separately from the journey above, and reaches the application only when a
release chain deploys a commit that carries it.

## Security, resilience, and production readiness

- The demo has one server-configured synthetic scope and no canonical-memory
  mutation route, tenant selector, model selector, or database selector.
- The only public write capability is an opaque-token, fixed-fixture,
  rate/cap-bounded sandbox with same-session foreign keys, RLS, idempotency,
  immutable decisions, logical expiry checks, and CockroachDB row-level TTL.
- CockroachDB row-level security is role-bound; Lambda principals cannot bypass
  it.
- Memory text is untrusted evidence, never instructions.
- Questions are accepted only in JSON request bodies and never placed in URLs
  or access logs.
- Input bytes, question length, top-k, audit size, API rate, concurrency,
  database connections, and model calls are bounded.
- Database and AWS errors are redacted from public responses while native
  operational signals remain observable.
- CI is secret-first and includes deterministic unit/integration tests,
  adversarial security tests, real multi-node CockroachDB survival, vector
  quality gates, frontend browser tests, IaC validation, CodeQL, staging,
  production, hosted E2E, Managed MCP proof, drift checks, and receipts.
- Deployments build once, promote the same candidate, use canaries, preserve
  prior versioned frontend and Lambda state, and maintain a durable private-S3
  recovery ledger that a trusted watchdog can reconcile after runner loss.
- Routine dependency upgrades are frozen for judging; security updates remain
  enabled and must pass the full hosted gates.

## Challenges

The hardest work was proving the difference between “vector search exists” and
“the production principal executed the intended native index path.” CockroachDB
RLS is correctly an optimizer barrier, so we designed fixed-predicate serving
views, exact role and catalog checks, and real-principal execution evidence.

The second challenge was uncertainty preservation. A fluent answer is not enough
when durable memories conflict. We separated semantic recall from exhaustive
consistency auditing and made unsafe narration fall back to exact cited text.

The third challenge was delivery evidence. A successful command is weaker than
a reproducible release. The pipeline binds source, build hashes, stack state,
aliases, versioned S3 objects, drift, live checks, and independent Managed MCP
proof into verifiable receipts.

## Accomplishments

- Native C-SPANN is used by the real fixed-scope recall path.
- Every visible answer is citation-bound and numerically checked.
- Contradictions and missing counterparts are explicit first-class results.
- The public Store proves persistence, idempotency, and content integrity
  independently as `9 / 9 / 9`.
- The app is a public AWS serverless deployment with protected build-once
  promotion, rollback, durable recovery ledgers, and a verified no-op watchdog
  classification. No fault-injected live `RECOVERED` drill is claimed.
- Managed MCP independently and causally gates the same exact release without
  exposing sensitive data; an optional advertised `explain_query` also links
  the control plane directly to the native C-SPANN serving path.

## What we learned

Agent memory quality is not only a retrieval metric. It is a contract across
durability, identity, lifecycle, scope, provenance, contradiction handling,
grounding, human visibility, and release evidence. Distributed SQL is valuable
here because the relational truth, audit state, and vector memory share one
serializable system instead of being reconciled across separate stores.

## Prior-work disclosure

Development of this challenge entry began on 1 July 2026. The pre-existing work
was the broader Archon financial domain, the synthetic Helios scenario,
document-extraction/reconciliation concepts, relational table shapes, and
selected schema/extraction code adapted from the earlier Archon/Nebius work.

The challenge-period implementation is the CockroachDB `agent_memory` layer,
native vector and prefix indexes, fixed-scope C-SPANN serving views, lifecycle
and idempotency model, role-bound RLS, recall/audit/proof APIs, grounding guards,
Managed MCP release proof, React Control Room, AWS serverless deployment, and
the complete verification and recovery pipeline. Related project patterns
informed the design, but this entry's shipped code and evidence are contained in
this public repository.

The complete source is public and [MIT licensed](https://github.com/upgradedev/archon-cockroach-memory/blob/main/LICENSE).

## What's next

After judging, the next product work is an authenticated multi-tenant identity
boundary, a two-principal secret-rotation workflow, a separately approved live
alarm consumer, and consenting human/production outcome studies. None of those
are represented as shipped in this submission.

## Built with

CockroachDB Cloud, Distributed Vector Indexing, C-SPANN, CockroachDB Cloud
Managed MCP, SQL, row-level security, TypeScript, Node.js 22, React, Tailwind
CSS, Amazon Bedrock, Titan Text Embeddings V2, Claude Sonnet 4.6, AWS Lambda,
Amazon API Gateway, Amazon CloudFront, Amazon S3, AWS Secrets Manager, AWS
CodeDeploy, AWS CloudFormation, Amazon CloudWatch, AWS X-Ray, GitHub Actions,
OpenID Connect, CodeQL, Playwright, and Docker.
