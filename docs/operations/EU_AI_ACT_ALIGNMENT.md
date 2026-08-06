# EU AI Act technical alignment record

Status: **alignment review only — not legal advice, certification, an EU
declaration of conformity, or a determination of compliance**.

Regulation: Regulation (EU) 2024/1689. Review scope: the public Archon Memory
demo and its source controls. Review date: 2026-08-06.

## Applicability boundary

The public demo uses a fixed synthetic company and does not make or execute a
financial decision. That fact alone does not determine whether a future
deployment is a high-risk system, who is provider or deployer, or which
transparency duties apply. Classification depends on intended purpose, the
real decision process, affected persons, integrations, and material changes.

Before using real personal or financial data, an adopter must document the
classification and roles with qualified legal and DPO review, determine
whether a DPIA or fundamental-rights impact assessment is required, and map
the complete obligations. This record covers only Articles 10, 13, 14, 15,
and 50 requested for the submission review; it is not a complete Act audit.

## Article-by-article alignment

| Article | Technical evidence in this project | Residual gap / required production action |
|---|---|---|
| **10 — Data and data governance** | Synthetic canonical memories carry source references, content hashes, tenant/company scope, lifecycle state, contradiction reporting, and absence reporting. Judge-supplied records are capability-scoped, capped at 20, isolated from canonical memory, and subject to a maximum one-hour CockroachDB storage TTL. | The demo proves neither representativeness nor freedom from bias for a real population. Define lawful data sources, quality criteria, lineage owners, correction/deletion processes, bias testing, and retention before real data is accepted. |
| **13 — Transparency and information to deployers** | Answers expose citations, model identifiers, grounding status, recalled-record counts, contradictions, absences, and explicit demo boundaries. Source, deployed/live, regulatory, and submission readiness are reported separately. | Create deployment-specific instructions, intended-purpose and limitation statements, accuracy/robustness characteristics, foreseeable misuse guidance, monitoring instructions, and notices for affected persons. |
| **14 — Human oversight** | The Memory Resolution Loop requires an explicit approve/reject decision, records a tamper-evident receipt, preserves both sources, and has no financial-transfer side effect. Canonical memory cannot be changed by the public runtime. | The public `financial-controller` role is a fixed demo assertion, not authenticated authority. A production system needs IdP-backed roles, competent named reviewers, override/stop procedures, training, escalation, and protection against automation bias. Judge-sandbox ingestion is evidence entry, not approval of a business action. |
| **15 — Accuracy, robustness and cybersecurity** | Forced RLS, exact grants, serializable writes, capability hashing, capacity and TTL bounds, C-SPANN index proofs, grounding checks, dependency-aware health, external canaries, release gates, DAST, prompt-injection tests, and node-loss tests provide bounded technical evidence. | Source checks do not prove the currently deployed release. Establish target accuracy by use case, exact-release hosted receipts, continuous monitoring, incident response, adversarial evaluation, backup/restore objectives, and periodic revalidation. |
| **50 — Transparency for certain AI systems** | The interface identifies an agentic AI system and exposes model/evidence traces for generated answers rather than presenting them as human-authored financial facts. | Legal review must determine whether Article 50 applies to each deployed interaction and the required timing, wording, machine-readability, and accessibility of notices. The current demo wording is not asserted as a universal statutory notice. |

## Readiness interpretation

- `npm run readiness` evaluates repository source and static evidence.
- Deployed/live readiness requires current hosted probes and exact deployed-SHA
  receipts.
- This document records regulatory alignment only; it cannot turn either of
  those engineering results into a legal compliance decision.
- Submission readiness is a separate package and hosted-gate question.

## Primary implementation evidence

- [`src/db/schema.sql`](../../src/db/schema.sql) — RLS, grants, capability
  sandbox, TTL, constraints, and canonical-memory boundary.
- [`src/memory/sandbox-store.ts`](../../src/memory/sandbox-store.ts) — bounded,
  capability-scoped ingestion, recall, expiry, and contradiction audit.
- [`src/memory/resolution.ts`](../../src/memory/resolution.ts) and
  [`docs/MEMORY_RESOLUTION_LOOP.md`](../MEMORY_RESOLUTION_LOOP.md) — human
  decision and receipt contract.
- [`scripts/verify-database-release.ts`](../../scripts/verify-database-release.ts)
  — live database release proofs.
- [`scripts/hosted-dast.mjs`](../../scripts/hosted-dast.mjs) — hosted
  adversarial boundaries.
- [`docs/operations/WELL_ARCHITECTED_EVIDENCE.md`](./WELL_ARCHITECTED_EVIDENCE.md)
  — evidence-level discipline shared with the AWS review.
