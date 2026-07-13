// Readiness-gate test — offline, DB-free, AWS-free.
//
// The readiness evaluator reads repo files + parses ci.yml wiring; it touches no DB and
// no network, so this test simply imports evaluate() and asserts the gate holds. It is
// the e2e for the gate itself: if a future change breaks the CockroachDB-depth evidence,
// the AWS evidence, the CI wiring, or the docs consistency, automatable completeness drops
// below the floor and this test fails — the same signal the CI `readiness` job enforces.

import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, AUTOMATABLE_FLOOR } from "../scripts/readiness.js";

test("readiness: automatable completeness meets the >=95% CI floor", () => {
  const r = evaluate();
  assert.ok(
    r.automatable.pct >= AUTOMATABLE_FLOOR,
    `automatable completeness ${r.automatable.pct}% < floor ${AUTOMATABLE_FLOOR}% — failing checks: ` +
      r.checks
        .filter((c) => c.kind === "automatable" && c.status !== "pass")
        .map((c) => `${c.id} (${c.detail})`)
        .join("; ")
  );
  assert.equal(r.gate.pass, true, "readiness gate should PASS");
});

test("readiness: every CockroachDB-depth automatable check passes (load-bearing axis)", () => {
  const r = evaluate();
  const depth = r.checks.filter((c) => c.criterion === "CockroachDB-depth" && c.kind === "automatable");
  const failing = depth.filter((c) => c.status !== "pass");
  assert.equal(failing.length, 0, `CockroachDB-depth automatable checks must all pass; failing: ${failing.map((c) => c.id).join(", ")}`);
  // The load-bearing axis carries real weight, not a single token check.
  assert.ok(depth.reduce((s, c) => s + c.weight, 0) >= 10, "CockroachDB-depth should carry substantial weight");
});

test("readiness: the report has the expected shape (checks, criteria, gate, user-gated list)", () => {
  const r = evaluate();
  assert.ok(Array.isArray(r.checks) && r.checks.length > 0);
  assert.ok(r.criteria["CockroachDB-depth"], "CockroachDB-depth criterion present");
  assert.ok(r.criteria["AWS integration"], "AWS integration criterion present");
  assert.ok(r.criteria["Submission completeness"], "Submission completeness criterion present");
  assert.equal(typeof r.gate.pass, "boolean");
  assert.equal(r.gate.threshold, AUTOMATABLE_FLOOR);
  // Each check declares a valid kind + status.
  for (const c of r.checks) {
    assert.ok(["automatable", "user-gated"].includes(c.kind), `bad kind on ${c.id}`);
    assert.ok(["pass", "fail", "user-gated"].includes(c.status), `bad status on ${c.id}`);
  }
});

test("readiness: honesty guards — no Cloud-Managed-MCP overclaim, user-gated items surfaced", () => {
  const r = evaluate();
  // The self-hosted MCP surface must NOT be counted as the hosted "Cloud Managed MCP Server"
  // required feature: the honesty check must pass (README stays '2 of 4', no '3 of 4').
  const mcp = r.checks.find((c) => c.id === "crdb.mcp-agentic-surface");
  assert.equal(mcp?.status, "pass", "MCP agentic-surface honesty check must pass");
  // The known creds/deploy/hosted items are surfaced as user-gated, not silently passed.
  const gatedIds = r.userGated.map((u) => u.id);
  for (const id of ["aws.demo-url", "crdb.explain-live-probe", "submission.demo-url-and-form"]) {
    assert.ok(gatedIds.includes(id), `${id} should be user-gated`);
  }
});
