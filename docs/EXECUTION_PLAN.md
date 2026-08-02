# Exceptional-release execution plan

Status: implementation in progress; video and Devpost are deliberately last.

Target: a defensible score above 90/100 under the five equal CockroachDB AI
Hackathon judging criteria. This target is an internal planning threshold, not
an organizer score or a guarantee of placement.

## Non-negotiable release rules

- CockroachDB is the durable memory system, not a decorative datastore.
- The two eligible CockroachDB tools remain causally necessary:
  - native distributed vector indexing (C-SPANN) for runtime retrieval; and
  - Cockroach Cloud Managed MCP as a pre-promotion integrity gate.
- Application and recovery workloads remain in `eu-west-1`. No workload is
  created in `us-west-2`. CloudFront WAF and AWS billing controls may use their
  AWS-required `us-east-1` control planes only.
- Builds, tests, scanners, load tests, restore drills, receipts, and release
  verification run in CI/CD. Developer workstations do not retain generated
  build, media, coverage, scanner, or corpus artifacts.
- Security findings are fixed. The canonical waiver ledger remains empty.
- No live resource, billing control, paging destination, destructive drill,
  public upload, or submission is activated without explicit human approval.
- Synthetic, representative, human, customer, and production evidence are
  labelled as different evidence tiers. Missing evidence is never inferred.

## Gate 1 — feature and repository freeze

Exit criteria:

- [x] The Memory Resolution Loop is a real CockroachDB transaction:
  fixed synthetic conflict, opaque bearer capability, human approve/reject,
  idempotent replay, immutable decision/consolidation receipt, TTL lifecycle,
  and no canonical-memory or external financial mutation.
- [x] Runtime mutation is exposed only through two exact
  `SECURITY DEFINER` transition routines owned by a bounded non-login role.
  The runtime role has five exact sandbox `SELECT` grants, two exact routine
  `EXECUTE` grants, and zero direct table DML.
- [x] Every database credential is bound before mutation to the exact
  Cockroach Cloud API cluster UUID and its single primary `eu-west-1`
  `regions[].sql_dns` endpoint, port `26257`, and `sslmode=verify-full`.
- [x] Longitudinal and multi-session policy evaluation includes B0–B4,
  eight single-control ablations, action-safety metrics, and a generated
  100,000-event lifecycle rehearsal.
- [x] Real C-SPANN recall is compared with exact cosine ground truth under an
  identical corpus/query/top-k/seed budget. A broader vendor benchmark is not a
  release prerequisite because unlike-for-like data, hardware, model, warm-up,
  and cost controls are not currently available.
- [x] The protected foundation migration plus CloudFront WAF and AWS
  Budget/Cost Anomaly plan/apply/verify workflows are source-controlled,
  exact-SHA-bound, and separately approval-gated. No live execution or receipt
  is claimed.
- [x] The WA-03 account-security baseline has a manual protected read-only
  exact-green-main workflow, exact action-only reference policy, sanitized
  ten-control receipt, static contract test, and activation runbook. The role,
  account controls, and first live receipt remain approval-gated and unclaimed.
- [x] WA-02 has a manual protected exact-green-main alarm-routing
  `plan|apply|verify|drill` workflow, dedicated OIDC and CloudFormation roles,
  a zero-replacement/additive-only activation contract, a staging-only probe,
  encrypted SNS-to-SQS delivery evidence, and sanitized exact-SHA receipts.
  Live activation, the first drill receipt, and actual human paging/receipt
  evidence remain separately approval-gated and unclaimed.
- [x] WA-10 has a manual protected exact-green-main read-only intensity
  workflow, least-privilege reference policy, version-2 hosted-load window and
  successful-recall denominator, exact request-count isolation, equivalent
  baseline/after comparison, and sanitized non-emissions receipt contract.
  Owner assignment, role/environment activation, hosted cost, live baseline,
  target-meeting comparison, and human disposition remain approval-gated and
  unclaimed.
- [x] A manual, protected, fail-closed Cockroach Cloud managed-backup restore
  drill is repository-prepared. It must restore an exact backup into a
  separately approved empty Basic cluster in the same organization, prove the
  schema/data/role/vector contracts, measure observed RTO/RPO, and perform no
  cutover or deletion.
- [x] ShellCheck, actionlint, zizmor, cfn-lint, SAM validation/build,
  CloudFormation Guard, Trivy IaC, dependency review, three-scope SBOM,
  vulnerability/license policy, and CodeQL are blocking and exact-SHA bound.
- [x] Repository Well-Architected, operations, incident, FinOps,
  sustainability, and abuse-response contracts are machine-audited.

Gate owner: implementation team. Evidence source: pull-request pipelines.

## Gate 2 — draft PR and hosted verification

Push the feature branch and open a draft pull request only after Gate 1 is
statically consistent. Do not claim the release is ready until every required
check for the exact head SHA is green.

Required hosted evidence:

- canonical backend and frontend builds and type checks;
- backend unit/integration/security tests on real ephemeral CockroachDB;
- frontend unit and browser functional tests;
- backend and frontend line/branch/function coverage receipts;
- three-node cluster survival and multi-range fan-out;
- k6 correctness, error-rate, concurrency, and p95 thresholds;
- hosted active checks plus passive/AJAX-spider ZAP DAST;
- blocking CodeQL and blocking zero-waiver supply-chain results;
- CloudFormation/SAM/WAF/FinOps policy validation;
- longitudinal, scale, baseline, ablation, and C-SPANN evaluation receipts;
- database schema/rehearsal, privilege, RLS, function-body, receipt-integrity,
  endpoint-binding, idempotency, and canonical-memory invariance checks; and
- submission/readiness contract checks, excluding final video/upload inputs.

Failure policy:

1. inspect the hosted log/artifact;
2. reproduce the failure only by changing source or the pipeline;
3. push a focused fix;
4. rerun the exact failed and dependent gates;
5. add no waiver and lower no quality threshold merely to obtain green.

Gate owner: implementation team. Evidence source: GitHub Actions exact-PR SHA.

## Gate 3 — exact-main release chain

After review and all required PR checks:

1. merge the reviewed exact SHA;
2. require a successful exact-main CodeQL gate and the exact-main
   supply-chain release receipt;
3. run the database release and endpoint-bound schema verification;
4. run the Managed MCP causal integrity audit;
5. build one immutable AWS candidate;
6. promote the same candidate through protected staging and production;
7. run hosted health, proof, recall, resolution approve/replay, and DAST gates;
8. retain only sanitized, SHA-bound receipts and attestations.

The production page must visibly prove both eligible CockroachDB tools and the
human-gated resolution loop. A green historical SHA is not evidence for a new
release.

Gate owner: release owner. Evidence source: exact-main release workflows.

## Gate 4 — approval-gated live Well-Architected evidence

Repository templates alone cannot make every Well-Architected pillar an 8/10.
The following requires explicit approval and accountable human decisions:

1. assign workload, operations, security, FinOps, and sustainability owners;
2. approve availability, API p95, error-rate, RTO, and RPO objectives;
3. provision the separate least-privilege `security-audit` OIDC role and
   protected environment through an approved infrastructure change, then run
   the exact-green-main read-only WA-03 workflow and retain its sanitized
   all-pass `10/10` account-baseline receipt;
4. run and retire the one-time protected foundation migration, verify it with
   permanent authority, activate both CloudFront WAF stacks and the
   secret-backed origin capability, then prove:
   CloudFront health succeeds, direct execute-api access fails, managed/rate
   rules block the intended abuse cases, alarms fire, and rollback succeeds;
5. run alarm-routing `plan`, inspect its exact 15 additions, separately approve
   `apply`, run the staging-only encrypted archive drill, then connect a
   production paging destination and execute a distinct human
   delivery/acknowledgement/escalation drill;
6. activate AWS Budget and Cost Anomaly Detection with approved thresholds,
   an accountable recipient, a delivery drill, and a unit-cost receipt;
7. run the protected Cockroach managed-backup restore drill, calculate observed
   restore time and backup-watermark loss, and compare them with the approved
   RTO/RPO;
8. run a fault-injected staging rollback/recovery drill; and
9. consider a second EU recovery region only under a separate architecture,
   cost, data-residency, RTO/RPO, and teardown approval. It must not be
   `us-west-2`.

Managed Basic backups are snapshots, not PITR. Do not claim PITR unless a
separate self-managed revision-history design is implemented and actually
drilled.

Gate owner: accountable workload/cloud owners. Evidence source: protected
approval-gated workflows plus human acknowledgement.

## Gate 5 — external quality and impact evidence

These results cannot be manufactured by code or synthetic fixtures:

- at least three qualified finance reviewers complete the blinded B2-versus-B4
  human-evaluation protocol;
- CI calculates paired outcomes, bootstrap confidence intervals, inter-rater
  agreement, exclusions, and action-safety results from pseudonymous ratings;
- a consenting user trial compares the baseline workflow with Archon on time to
  current fact, contradiction miss rate, reviewer effort, accepted/rejected
  proposals, and unauthorized-action attempts;
- any real corpus has documented permission, provenance, privacy review,
  retention, schema mapping, and an exact-SHA reproducibility receipt; and
- quantified business claims report distributions and confidence intervals,
  not a selected best run.

Until this gate runs, wording is limited to “protocol prepared,” “synthetic
evaluation,” and “representative generated scale.” No customer ROI,
production-scale-corpus, or human-evaluated claim is permitted.

Gate owner: study owner and consenting reviewers. Evidence source: blinded
study and CI analysis receipt.

## Gate 6 — strict judge audit and release freeze

Act as a hostile but fair judge and score the exact released SHA under the five
official equal criteria:

| Criterion | Required evidence before a 90+ submission |
|---|---|
| Agentic Memory Design | longitudinal behavior, conflicts, evidence lineage, abstention, learning/consolidation/forgetting, human authority, and exact-once action |
| Technological Implementation | two causal Cockroach tools, real C-SPANN, Managed MCP release gate, AWS production path, tests/scans/load/DAST, and SHA-bound release |
| Real-World Impact | credible finance workflow, real reviewer evidence, and measured task/business outcomes without extrapolation |
| Product Readiness | live app, reproducible public repository, license, CI/CD, observability, rollback, WAF, alarm, restore/RTO–RPO, FinOps, runbooks, and honest limitations |
| Creativity / Originality | temporal evidence-ledger memory plus human-gated resolution and verifiable action receipts, not generic RAG/chat |

The audit must publish:

- exact coverage numbers from the release artifacts;
- pass/fail counts for functional, integration, browser, load, security, DAST,
  CodeQL, supply-chain, database-release, MCP, deploy, and recovery gates;
- internal Well-Architected pillar scores with evidence/unknowns;
- remaining risks and approvals;
- criterion-by-criterion score with deductions and confidence; and
- an explicit “exceptional SOTA” verdict or a refusal to make that claim.

## Gate 7 — video and Devpost, last

Only after Gates 1–6 and feature freeze:

1. generate narration and capture the exact released live application through
   the protected CI video workflow;
2. assemble a sub-three-minute review package;
3. verify duration, audio/video streams, source SHA, receipt hashes, visible
   eligible-tool evidence, and claim wording;
4. obtain human approval for public upload;
5. bind the public video URL to the exact CI artifact digest;
6. finalize Devpost text, public repository/license, live demo URL, screenshots,
   and required fields; and
7. obtain explicit human approval before submission.

No further feature work is allowed after the video source gate without
invalidating and regenerating the video and submission receipts.
