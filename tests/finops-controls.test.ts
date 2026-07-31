import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string): string =>
  readFileSync(join(root, path), "utf8");

test("FinOps IaC is explicit, bounded, and billing-control-plane only", () => {
  const template = read("aws/finops.yaml");
  assert.match(
    template,
    /BillingControlPlaneRegion:[\s\S]*?Assert:\s*!Equals\s*\[!Ref "AWS::Region", us-east-1\]/u,
  );
  assert.match(template, /Type:\s*AWS::Budgets::Budget/u);
  assert.match(template, /BudgetType:\s*COST/u);
  assert.match(template, /TimeUnit:\s*MONTHLY/u);
  for (const threshold of [50, 80, 100]) {
    assert.match(
      template,
      new RegExp(`Threshold:\\s*${threshold}`, "u"),
    );
  }
  assert.match(template, /NotificationType:\s*FORECASTED/u);
  assert.match(template, /Type:\s*AWS::CE::AnomalyMonitor/u);
  assert.match(template, /MonitorType:\s*DIMENSIONAL/u);
  assert.match(template, /MonitorDimension:\s*SERVICE/u);
  assert.match(template, /Type:\s*AWS::CE::AnomalySubscription/u);
  assert.match(template, /Frequency:\s*IMMEDIATE/u);
  assert.match(
    template,
    /ANOMALY_TOTAL_IMPACT_ABSOLUTE[\s\S]*?GREATER_THAN_OR_EQUAL[\s\S]*?AnomalyImpactUsd/u,
  );
  assert.match(
    template,
    /ANOMALY_TOTAL_IMPACT_PERCENTAGE[\s\S]*?GREATER_THAN_OR_EQUAL[\s\S]*?AnomalyImpactPercentage/u,
  );
  assert.doesNotMatch(template, /^\s*Threshold:\s*!Ref AnomalyImpactUsd/mu);
  assert.doesNotMatch(template, /us-west-2/iu);
});

test("FinOps activation cannot inherit guessed thresholds, recipients, or owners", () => {
  const template = read("aws/finops.yaml");
  for (const parameter of [
    "MonthlyBudgetUsd",
    "AnomalyImpactUsd",
    "AnomalyImpactPercentage",
    "FinOpsNotificationTopicArn",
    "FinOpsOwnerReference",
    "ActivationApprovalReference",
  ]) {
    const block = template.match(
      new RegExp(
        `^  ${parameter}:\\r?\\n([\\s\\S]*?)(?=^  [A-Za-z][A-Za-z0-9]+:|^Rules:)`,
        "mu",
      ),
    )?.[1];
    assert.ok(block, `missing ${parameter} parameter`);
    assert.doesNotMatch(block, /^\s+Default:/mu);
  }
  assert.match(
    template,
    /FinOpsNotificationTopicArn:[\s\S]*?AllowedPattern:\s*"\^arn:aws:sns:us-east-1/u,
  );
  assert.match(
    template,
    /ApprovalBoundary[\s\S]*?explicit-live-activation-required/u,
  );
});

test("no existing workflow can activate the dormant FinOps stack", () => {
  const workflows = [
    ".github/workflows/bootstrap-aws.yml",
    ".github/workflows/database-release.yml",
    ".github/workflows/deploy-aws.yml",
    ".github/workflows/recover-aws.yml",
  ]
    .map(read)
    .join("\n");
  assert.doesNotMatch(workflows, /finops\.yaml/u);
  assert.doesNotMatch(workflows, /AWS::Budgets::Budget/u);
  assert.doesNotMatch(workflows, /AWS::CE::AnomalySubscription/u);
});
