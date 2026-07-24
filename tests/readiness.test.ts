import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  evaluate,
  OFFICIAL_CRITERIA,
  SOURCE_FLOOR,
} from "../scripts/readiness.js";

test("readiness: every repository-verifiable source gate passes", () => {
  const report = evaluate();
  const failing = report.checks.filter((check) => check.status === "fail");
  assert.equal(
    failing.length,
    0,
    failing.map((check) => `${check.id}: ${check.detail}`).join("; ")
  );
  assert.ok(report.sourceGate.pct >= SOURCE_FLOOR);
  assert.equal(report.sourceGate.pass, true);
});

test("readiness: judging mirrors the five equally presented official criteria", () => {
  const report = evaluate();
  assert.deepEqual(Object.keys(report.judging), [...OFFICIAL_CRITERIA]);
  for (const criterion of OFFICIAL_CRITERIA) {
    const score = report.judging[criterion];
    assert.ok(score.total > 0, `${criterion} must contain source checks`);
    assert.equal(score.pct, 100, `${criterion} should be source-ready`);
  }
});

test("readiness: source readiness cannot masquerade as submission eligibility", () => {
  const report = evaluate();
  assert.equal(report.sourceGate.pass, true);
  assert.equal(
    report.submissionEligible,
    report.eligibility.requirements.every(
      (requirement) => requirement.status === "complete"
    )
  );
  for (const id of [
    "unrestricted-functional-demo",
    "public-under-three-minute-video",
    "devpost-submitted",
  ]) {
    assert.ok(
      report.eligibility.requirements.some((requirement) => requirement.id === id),
      `${id} must be represented as a hard eligibility requirement`
    );
  }
});

test("readiness: required tool story is Vector + live Managed MCP", () => {
  const report = evaluate();
  assert.equal(
    report.checks.find((check) => check.id === "memory.native-vector-lifecycle")
      ?.status,
    "pass"
  );
  assert.equal(
    report.checks.find((check) => check.id === "memory.managed-mcp")?.status,
    "pass"
  );
});

test("readiness: both AWS release gates accept only fully grounded safe-answer states", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/deploy-aws.yml", import.meta.url),
    "utf8"
  );
  const safeStatusGate =
    '(.grounding.status == "verified" or .grounding.status == "extractive")';

  assert.equal(workflow.split(safeStatusGate).length - 1, 2);
  for (const check of ["citations", "numerics", "claims"]) {
    assert.equal(
      workflow.split(`.grounding.checks.${check} == true`).length - 1,
      2,
      `both AWS release gates must require grounding.checks.${check}`
    );
  }
});

test("readiness: AWS promotion is gated by exact-SHA CodeQL and a fresh main-head proof", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/deploy-aws.yml", import.meta.url),
    "utf8"
  );

  assert.match(
    workflow,
    /name: Prove CodeQL succeeded for the exact release SHA/u
  );
  assert.match(
    workflow,
    /actions\/workflows\/codeql\.yml\/runs\?branch=main&event=push/u
  );
  assert.match(
    workflow,
    /name: Prove the candidate is still the main branch head/u
  );
});
