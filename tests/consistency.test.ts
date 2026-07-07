// Unit tests for the self-auditing memory-consistency engine — no DB, no AWS key.
// These pin the two guarantees the "agentic memory that audits itself" claim
// rests on: every injected cross-session contradiction / dangling reference is
// flagged (DETECTION), and NOTHING in the consistent control set is flagged
// (PRECISION — 0 false positives). Plus the recommender picks the labelled winner
// for each conflict (RESOLUTION). Domain-neutral fixtures (invoices, orders,
// customers) — the capability is universal, not tied to any document type.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  auditConsistency,
  resolveContradiction,
  subjectKey,
  type AuditMemory,
} from "../src/memory/consistency.js";

const S_A = "2026-05-01T09:00:00.000Z";
const S_B = "2026-05-08T14:30:00.000Z";
const S_C = "2026-05-25T10:15:00.000Z";

function mem(
  id: string,
  record: string | null,
  createdAt: string,
  metadata: Record<string, unknown> | null,
  sourceRef: string | null = record,
  kind = "document"
): AuditMemory {
  return {
    id,
    kind,
    company: "Northwind Traders",
    period: "2026-05",
    sourceRef,
    content: `mem ${id}`,
    metadata: metadata ? { ...(record ? { record } : {}), ...metadata } : null,
    createdAt,
  };
}

// ── Labelled DETECTION dataset (inlined; mirrors the Qwen bench) ────────────────
// Several business records; for each, two "sessions" (write events) stored a
// memory. Some agree (control), some disagree (injected contradiction), plus a
// dangling reference and unrelated records that merely SHARE an attribute name.
const CONSISTENCY_CASE: {
  memories: AuditMemory[];
  expectContradictions: Array<{ subject: string; attribute: string }>;
  expectAbsences: string[];
} = {
  memories: [
    // Injected CONTRADICTIONS (session B disagrees with session A).
    mem("c1a", "INV-2043", S_A, { total: 18400 }),
    mem("c1b", "INV-2043", S_B, { total: 18900 }),
    mem("c2a", "CUST-77", S_A, { credit_limit: 5000 }),
    mem("c2b", "CUST-77", S_B, { credit_limit: 8000 }),
    mem("c3a", "PO-5590", S_A, { quantity: 12, unit_price: 1075 }),
    mem("c3b", "PO-5590", S_B, { quantity: 15, unit_price: 1075 }), // unit_price AGREES
    mem("c4a", "VENDOR-BoxLine", S_A, { status: "active" }),
    mem("c4b", "VENDOR-BoxLine", S_B, { status: "suspended" }),
    // Consistent CONTROL (must NEVER be flagged).
    mem("k1a", "INV-2051", S_A, { total: 9250 }),
    mem("k1b", "INV-2051", S_B, { total: 9250 }),
    mem("k1c", "INV-2051", S_B, { total: 9250.3 }), // within float tolerance
    mem("k2a", "CUST-91", S_A, { credit_limit: 12000 }),
    mem("k2b", "CUST-91", S_B, { credit_limit: 12000, region: "north" }),
    mem("k3", "PINV-802", S_A, { total: 12900 }), // shares `total` — different subject
    mem("k4", "SO-330", S_A, { total: 9250 }),
    mem("k5", "INV-2099", S_A, { total: 4100 }), // single write, nothing to compare
    // Injected ABSENCE (dangling reference to a never-stored PAY-118).
    mem("a1", "RECON-5590", S_B, { refs: ["PO-5590", "PINV-802", "PAY-118"] }),
  ],
  expectContradictions: [
    { subject: "CUST-77", attribute: "credit_limit" },
    { subject: "INV-2043", attribute: "total" },
    { subject: "PO-5590", attribute: "quantity" },
    { subject: "VENDOR-BoxLine", attribute: "status" },
  ],
  expectAbsences: ["PAY-118"],
};

// ── Labelled RESOLUTION dataset (inlined) ──────────────────────────────────────
// For each contradiction: which memory SHOULD win and which rule decides it.
const RESOLUTION_CASE: {
  memories: AuditMemory[];
  expect: Array<{
    subject: string;
    attribute: string;
    winnerMemoryId: string;
    rule: "recency" | "importance" | "source-authority";
  }>;
} = {
  memories: [
    // RECENCY (default): nothing distinguishes the writes but time.
    mem("r1a", "INV-3001", S_A, { total: 100 }),
    mem("r1b", "INV-3001", S_B, { total: 120 }),
    mem("r2a", "CUST-88", S_A, { credit_limit: 5000 }),
    mem("r2b", "CUST-88", S_C, { credit_limit: 8000 }),
    // IMPORTANCE: an explicitly flagged OLDER memory beats a later casual write.
    mem("i1a", "POLICY-1", S_A, { limit: 1000, importance: 0.9 }),
    mem("i1b", "POLICY-1", S_B, { limit: 1500 }),
    // SOURCE-AUTHORITY: a structured record outranks a later derived insight.
    mem("s1a", "ACCT-7", S_A, { balance: 5000 }, "ACCT-7", "document"),
    mem("s1b", "ACCT-7", S_B, { balance: 5200 }, "ACCT-7", "insight"),
  ],
  expect: [
    { subject: "ACCT-7", attribute: "balance", winnerMemoryId: "s1a", rule: "source-authority" },
    { subject: "CUST-88", attribute: "credit_limit", winnerMemoryId: "r2b", rule: "recency" },
    { subject: "INV-3001", attribute: "total", winnerMemoryId: "r1b", rule: "recency" },
    { subject: "POLICY-1", attribute: "limit", winnerMemoryId: "i1a", rule: "importance" },
  ],
};

// ── subject identity ───────────────────────────────────────────────────────────

test("subjectKey prefers metadata.record, then sourceRef, else null", () => {
  assert.equal(subjectKey(mem("1", "R1", S_A, {})), "R1");
  assert.equal(
    subjectKey({ ...mem("2", null, S_A, {}), sourceRef: "evt-1:E-03", metadata: {} }),
    "evt-1:E-03"
  );
  assert.equal(subjectKey({ ...mem("3", null, S_A, null), sourceRef: null }), null);
});

// ── detection + precision ───────────────────────────────────────────────────────

test("flags a cross-session contradiction on the same record + attribute", () => {
  const report = auditConsistency([
    mem("a", "INV-1", S_A, { total: 100 }),
    mem("b", "INV-1", S_B, { total: 200 }),
  ]);
  assert.equal(report.contradictions.length, 1);
  const c = report.contradictions[0]!;
  assert.equal(c.subject, "INV-1");
  assert.equal(c.attribute, "total");
  assert.deepEqual(c.values.map((v) => v.value).sort(), [100, 200]);
  assert.equal(c.values[0]!.createdAt, S_A); // earliest write listed first
  assert.equal(report.ok, false);
});

test("agreeing re-ingests are NOT a contradiction (idempotent memory)", () => {
  const report = auditConsistency([
    mem("a", "INV-1", S_A, { total: 100 }),
    mem("b", "INV-1", S_B, { total: 100 }),
  ]);
  assert.equal(report.contradictions.length, 0);
  assert.equal(report.ok, true);
});

test("numbers within tolerance are treated as equal (float noise)", () => {
  const report = auditConsistency([
    mem("a", "INV-1", S_A, { total: 9250 }),
    mem("b", "INV-1", S_B, { total: 9250.3 }),
  ]);
  assert.equal(report.contradictions.length, 0);
});

test("distinct records sharing an attribute name do NOT collapse (no false positive)", () => {
  const report = auditConsistency([
    mem("a", "INV-1", S_A, { total: 100 }),
    mem("b", "PO-9", S_A, { total: 200 }),
  ]);
  assert.equal(report.contradictions.length, 0, "different subjects must never contradict");
});

test("per-record sourceRef keeps two employees in one event distinct", () => {
  const report = auditConsistency([
    { ...mem("e1", null, S_A, { net: 1000 }), sourceRef: "evt-1:E-01", metadata: { net: 1000 } },
    { ...mem("e2", null, S_A, { net: 2000 }), sourceRef: "evt-1:E-02", metadata: { net: 2000 } },
  ]);
  assert.equal(report.contradictions.length, 0);
});

test("only shared attributes are compared; a new attribute is not a conflict", () => {
  const report = auditConsistency([
    mem("a", "CUST-1", S_A, { credit_limit: 5000 }),
    mem("b", "CUST-1", S_B, { credit_limit: 5000, region: "north" }),
  ]);
  assert.equal(report.contradictions.length, 0);
});

test("flags a dangling reference (absence) and not present references", () => {
  const report = auditConsistency([
    mem("a", "RECON-1", S_A, { refs: ["INV-1", "MISSING-9"] }),
    mem("b", "INV-1", S_A, { total: 100 }),
  ]);
  assert.equal(report.absences.length, 1);
  assert.equal(report.absences[0]!.subject, "MISSING-9");
  assert.equal(report.absences[0]!.referencedBy[0]!.memoryId, "a");
});

test("memories with no record key are counted but never flagged", () => {
  const report = auditConsistency([
    { ...mem("x", null, S_A, { total: 1 }), sourceRef: null, metadata: { total: 1 } },
    { ...mem("y", null, S_B, { total: 2 }), sourceRef: null, metadata: { total: 2 } },
  ]);
  assert.equal(report.audited, 2);
  assert.equal(report.contradictions.length, 0);
});

test("MEASURED: detects every injected contradiction/absence with 0 false positives", () => {
  const { memories, expectContradictions, expectAbsences } = CONSISTENCY_CASE;
  const report = auditConsistency(memories);

  const gotC = report.contradictions.map((c) => `${c.subject}::${c.attribute}`).sort();
  const goldC = expectContradictions.map((e) => `${e.subject}::${e.attribute}`).sort();
  assert.deepEqual(gotC, goldC, "contradictions must match the gold labels exactly");

  const gotA = report.absences.map((a) => a.subject).sort();
  const goldA = [...expectAbsences].sort();
  assert.deepEqual(gotA, goldA, "absences must match the gold labels exactly");

  // Exactly the injected problems, nothing from the control set.
  assert.equal(
    report.contradictions.length + report.absences.length,
    expectContradictions.length + expectAbsences.length
  );
});

// ── resolution (recommender) ─────────────────────────────────────────────────────

test("every contradiction carries a resolution recommending a real memory", () => {
  const report = auditConsistency([
    mem("a", "INV-1", S_A, { total: 100 }),
    mem("b", "INV-1", S_B, { total: 200 }),
  ]);
  const r = report.contradictions[0]!.resolution;
  assert.ok(r, "resolution must be present");
  assert.ok(["recency", "importance", "source-authority"].includes(r.rule));
  assert.ok(r.confidence >= 0 && r.confidence <= 1, "confidence in [0,1]");
  assert.ok(["a", "b"].includes(r.recommendedMemoryId), "must point at a real memory");
  assert.ok(r.rationale.length > 0);
});

test("recency (default): the later write wins", () => {
  const report = auditConsistency([
    mem("a", "INV-1", S_A, { total: 100 }),
    mem("b", "INV-1", S_B, { total: 200 }),
  ]);
  const r = report.contradictions[0]!.resolution;
  assert.equal(r.rule, "recency");
  assert.equal(r.recommendedMemoryId, "b");
  assert.equal(r.recommendedValue, 200);
});

test("importance overrides recency: a flagged older memory beats a later one", () => {
  const report = auditConsistency([
    { ...mem("a", "P-1", S_A, { limit: 1000 }), metadata: { record: "P-1", limit: 1000, importance: 0.9 } },
    mem("b", "P-1", S_B, { limit: 1500 }),
  ]);
  const r = report.contradictions[0]!.resolution;
  assert.equal(r.rule, "importance");
  assert.equal(r.recommendedMemoryId, "a");
  assert.equal(r.recommendedValue, 1000);
});

test("source-authority overrides recency: a structured record beats a derived insight", () => {
  const report = auditConsistency([
    { ...mem("a", "ACCT-1", S_A, { balance: 5000 }), kind: "document" },
    { ...mem("b", "ACCT-1", S_B, { balance: 5200 }), kind: "insight" },
  ]);
  const r = report.contradictions[0]!.resolution;
  assert.equal(r.rule, "source-authority");
  assert.equal(r.recommendedMemoryId, "a");
  assert.equal(r.recommendedValue, 5000);
});

test("resolveContradiction falls back to recency for equal kinds + no importance", () => {
  const r = resolveContradiction([
    { value: 1, memories: [mem("a", "X", S_A, { v: 1 })] },
    { value: 2, memories: [mem("b", "X", S_B, { v: 2 })] },
  ]);
  assert.equal(r.rule, "recency");
  assert.equal(r.recommendedMemoryId, "b");
});

test("a timestamp tie is resolved deterministically with low confidence", () => {
  const r = resolveContradiction([
    { value: 1, memories: [mem("z", "X", S_A, { v: 1 })] },
    { value: 2, memories: [mem("a", "X", S_A, { v: 2 })] },
  ]);
  assert.equal(r.rule, "recency");
  assert.ok(r.confidence <= 0.5, "tie confidence must be modest");
  assert.equal(r.recommendedMemoryId, "a"); // lexically smallest id among latest carriers
});

test("MEASURED: recommends the labelled winner + rule on every resolution case", () => {
  const { memories, expect } = RESOLUTION_CASE;
  const report = auditConsistency(memories);
  const byKey = new Map(report.contradictions.map((c) => [`${c.subject}::${c.attribute}`, c]));
  for (const e of expect) {
    const c = byKey.get(`${e.subject}::${e.attribute}`);
    assert.ok(c, `expected a contradiction for ${e.subject}.${e.attribute}`);
    assert.equal(c!.resolution.recommendedMemoryId, e.winnerMemoryId, `${e.subject} winner`);
    assert.equal(c!.resolution.rule, e.rule, `${e.subject} rule`);
  }
});
