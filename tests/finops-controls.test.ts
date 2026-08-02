import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string): string =>
  readFileSync(join(root, path), "utf8");

const workflow = read(".github/workflows/finops-controls.yml");
const template = read("aws/finops.yaml");
const costModel = read("docs/finops/COST_MODEL.md");
const runbook = read("docs/runbooks/cost-anomaly.md");

function dispatchInput(name: string): string {
  const match = workflow.match(
    new RegExp(
      `^      ${name}:\\r?\\n([\\s\\S]*?)(?=^      [a-z_]+:|^\\s*$)`,
      "mu"
    )
  );
  assert.ok(match, `missing workflow_dispatch input ${name}`);
  return match[0];
}

function templateParameter(name: string): string {
  const match = template.match(
    new RegExp(
      `^  ${name}:\\r?\\n([\\s\\S]*?)(?=^  [A-Za-z][A-Za-z0-9]+:|^\\s*$)`,
      "mu"
    )
  );
  assert.ok(match, `missing CloudFormation parameter ${name}`);
  return match[0];
}

test("FinOps template has explicit financial inputs and three bounded controls", () => {
  assert.match(
    templateParameter("AppName"),
    /MinLength:\s*3[\s\S]*?MaxLength:\s*17[\s\S]*?AllowedPattern:\s*"\^\[a-z\]\[a-z0-9-\]\{2,16\}\$"/u
  );
  for (const parameter of [
    "MonthlyBudgetUsd",
    "AnomalyImpactUsd",
    "AnomalyImpactPercentage",
    "FinOpsNotificationTopicArn",
    "FinOpsOwnerReference",
    "ActivationApprovalReference",
  ]) {
    assert.doesNotMatch(templateParameter(parameter), /^\s+Default:/mu);
  }

  assert.match(
    template,
    /BillingControlPlaneRegion:[\s\S]*?Assert:\s*!Equals\s*\[!Ref "AWS::Region", us-east-1\]/u
  );
  assert.equal(
    (
      template.match(
        /^\s+Type:\s+AWS::(?:Budgets::Budget|CE::AnomalyMonitor|CE::AnomalySubscription)$/gmu
      ) ?? []
    ).length,
    3
  );
  assert.match(template, /Threshold:\s*50/u);
  assert.match(template, /Threshold:\s*80/u);
  assert.equal((template.match(/Threshold:\s*100/gu) ?? []).length, 2);
  assert.match(template, /Frequency:\s*IMMEDIATE/u);
  assert.doesNotMatch(template, /^  Environment:/mu);
  assert.match(
    template,
    /BudgetName:\s*!Sub "\$\{AppName\}-workload-monthly-total"[\s\S]*?FilterExpression:[\s\S]*?Key:\s*Application[\s\S]*?MatchOptions:[\s\S]*?- EQUALS/u
  );
  assert.match(
    template,
    /WorkloadCostAnomalyMonitor:[\s\S]*?MonitorType:\s*CUSTOM[\s\S]*?MonitorSpecification:[\s\S]*?"Key": "Application"/u
  );
  assert.doesNotMatch(template, /MonitorType:\s*DIMENSIONAL/u);
  assert.match(
    template,
    /ANOMALY_TOTAL_IMPACT_ABSOLUTE[\s\S]*?ANOMALY_TOTAL_IMPACT_PERCENTAGE/u
  );
  assert.doesNotMatch(template, /us-west-2/iu);
  assert.equal(
    (workflow.match(/\^\[a-z\]\[a-z0-9-\]\{2,16\}\$/gu) ?? []).length,
    2
  );
});

test("workflow is manual-only with required default-free human inputs", () => {
  const trigger = workflow.slice(
    workflow.indexOf("on:"),
    workflow.indexOf("concurrency:")
  );
  assert.match(trigger, /^\s+workflow_dispatch:/mu);
  assert.doesNotMatch(
    trigger,
    /^\s+(?:push|pull_request|schedule|workflow_call):/mu
  );

  for (const input of [
    "target_sha",
    "monthly_budget_usd",
    "anomaly_impact_usd",
    "anomaly_impact_percentage",
    "notification_topic_arn",
    "finops_owner_reference",
    "activation_approval_reference",
  ]) {
    const block = dispatchInput(input);
    assert.match(block, /^\s+required:\s+true$/mu);
    assert.doesNotMatch(block, /^\s+default:/mu);
  }

  assert.match(
    dispatchInput("operation"),
    /-\s+plan[\s\S]*?-\s+apply[\s\S]*?-\s+verify/u
  );
  assert.match(
    workflow,
    /APPLY-WORKLOAD-FINOPS-CONTROLS-AND-ROUTING-TEST/u
  );
  assert.doesNotMatch(workflow, /^      environment:/mu);
  assert.doesNotMatch(workflow, /^\s+queue:\s+max$/mu);
});

test("workflow binds exact current green main and protected OIDC authority", () => {
  assert.match(workflow, /environment:\s+finops-controls/u);
  assert.match(workflow, /id-token:\s+write/u);
  assert.match(workflow, /actions:\s+read/u);
  assert.match(workflow, /contents:\s+read/u);
  assert.match(
    workflow,
    /test "\$GITHUB_REF" = "refs\/heads\/main"/u
  );
  assert.match(workflow, /test "\$GITHUB_SHA" = "\$TARGET_SHA"/u);
  assert.match(
    workflow,
    /test "\$\(git rev-parse origin\/main\)" = "\$TARGET_SHA"/u
  );
  assert.match(
    workflow,
    /test "\$GITHUB_REPOSITORY" = \\\s*\n\s*"upgradedev\/archon-cockroach-memory"/u
  );
  assert.match(workflow, /prove_workflow ci\.yml CI/u);
  assert.match(workflow, /prove_workflow codeql\.yml CodeQL/u);
  assert.match(
    workflow,
    /prove_workflow \\\s*\n\s*supply-chain\.yml "Supply Chain \(enforced\)"/u
  );

  assert.match(
    workflow,
    /arn:aws:iam::\$\{\{ vars\.AWS_ACCOUNT_ID \}\}:role\/\$\{\{ vars\.AWS_APP_NAME \}\}-github-finops-controls/u
  );
  assert.match(
    workflow,
    /arn:aws:iam::\$\{\{ vars\.AWS_ACCOUNT_ID \}\}:role\/\$\{\{ vars\.AWS_APP_NAME \}\}-finops-cloudformation-execution/u
  );
  assert.doesNotMatch(
    workflow,
    /\$\{\{\s*vars\.AWS_FINOPS_(?:CONTROL|CLOUDFORMATION)/u
  );
  assert.match(workflow, /--role-arn "\$AWS_FINOPS_CLOUDFORMATION_EXECUTION_ROLE_ARN"/u);
  assert.match(workflow, /\.RoleARN == \$role/u);
  assert.doesNotMatch(
    workflow,
    /secrets\.(?:AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY)|aws-access-key-id:|aws-secret-access-key:/u
  );

  const bootstrap = read("aws/bootstrap-oidc.yaml");
  assert.equal(
    (
      bootstrap.match(
        /stack\/\$\{AppName\}-finops\/\*/gu
      ) ?? []
    ).length,
    2
  );
  assert.doesNotMatch(
    bootstrap,
    /\$\{AppName\}-(?:staging|production)-finops/u
  );
});

test("all third-party actions are immutable and checkout credentials are disabled", () => {
  const uses = [...workflow.matchAll(/^\s+uses:\s+([^\s#]+)/gmu)].map(
    (match) => match[1]
  );
  assert.equal(uses.length, 4);
  for (const action of uses) {
    assert.match(action, /^[^@]+@[a-f0-9]{40}$/u);
  }
  assert.equal(
    (workflow.match(/persist-credentials:\s+false/gu) ?? []).length,
    2
  );
  assert.match(
    workflow,
    /aws-actions\/configure-aws-credentials@[a-f0-9]{40}/u
  );
  assert.match(workflow, /mask-aws-account-id:\s+true/u);
});

test("plan and apply bind one immutable non-replacement change set", () => {
  assert.match(
    workflow,
    /change_set="finops-workload-\$\{TARGET_SHA:0:10\}-\$\{template_digest:0:10\}-\$\{parameter_digest:0:10\}-\$\{execution_role_digest:0:10\}"/u
  );
  assert.match(
    workflow,
    /description="operation=finops-controls[\s\S]*?template_sha256=\$\{template_digest\}[\s\S]*?parameters_sha256=\$\{parameter_digest\}[\s\S]*?execution_role_sha256=\$\{execution_role_digest\}"/u
  );
  assert.match(
    workflow,
    /if:\s+inputs\.operation == 'plan'[\s\S]*?aws cloudformation create-change-set/u
  );
  assert.match(
    workflow,
    /if:\s+inputs\.operation == 'apply'[\s\S]*?aws cloudformation describe-change-set/u
  );
  assert.match(workflow, /REVIEW_IN_PROGRESS/u);
  assert.match(
    workflow,
    /if \[ "\$CHANGE_SET_TYPE" = "CREATE" \]; then[\s\S]*?--on-stack-failure DELETE[\s\S]*?test "\$CHANGE_SET_TYPE" = "UPDATE"/u
  );
  assert.match(workflow, /--template-stage Original/u);
  assert.match(
    workflow,
    /test "\$\(sha256sum "\$template" \| awk '\{print \$1\}'\)" = \\\s*\n\s*"\$FINOPS_TEMPLATE_DIGEST"/u
  );
  assert.match(workflow, /\.Parameters \| parameter_map/u);
  assert.match(workflow, /\(\.Capabilities \/\/ \[\]\) == \[\]/u);
  assert.match(workflow, /\(\.NotificationARNs \/\/ \[\]\) == \[\]/u);
  assert.match(workflow, /\(\.Tags \/\/ \[\]\) == \[\]/u);
  assert.match(
    workflow,
    /\(\$change\.Replacement \/\/ "False"\) == "False"/u
  );
  assert.match(workflow, /\.Target\.RequiresRecreation == "Never"/u);
  for (const logicalId of [
    "MonthlyWorkloadBudget",
    "WorkloadCostAnomalyMonitor",
    "ImmediateCostAnomalySubscription",
  ]) {
    assert.ok(workflow.includes(logicalId), logicalId);
  }
});

test("mutation and polling are operation-gated and bounded", () => {
  assert.equal(
    (workflow.match(/aws cloudformation create-change-set/gu) ?? []).length,
    1
  );
  assert.equal(
    (workflow.match(/aws cloudformation execute-change-set/gu) ?? []).length,
    1
  );
  assert.match(
    workflow,
    /Execute the exact inspected FinOps plan[\s\S]*?if:\s+inputs\.operation == 'apply'/u
  );
  assert.match(workflow, /--client-request-token "\$client_token"/u);
  assert.match(workflow, /for attempt in \$\(seq 1 90\)/u);
  assert.match(workflow, /for attempt in \$\(seq 1 120\)/u);
  assert.match(workflow, /timeout-minutes:\s+45/u);
  assert.match(workflow, /--enable-termination-protection/u);
  assert.match(workflow, /\.EnableTerminationProtection == true/u);
  assert.doesNotMatch(
    workflow,
    /cloudformation (?:delete-stack|update-stack)|budgets delete-budget|ce delete-anomaly/u
  );
});

test("notification route proof requires exact SNS and customer-managed KMS policy grants", () => {
  assert.match(workflow, /aws sns get-topic-attributes/u);
  assert.match(workflow, /aws kms describe-key/u);
  assert.match(workflow, /aws kms get-key-policy/u);
  assert.match(workflow, /\.KeyMetadata\.KeyManager == "CUSTOMER"/u);
  assert.match(workflow, /\.KeyMetadata\.KeyState == "Enabled"/u);
  assert.match(workflow, /\.KeyMetadata\.KeySpec == "SYMMETRIC_DEFAULT"/u);
  assert.equal(
    (workflow.match(/"budgets\.amazonaws\.com"/gu) ?? []).length,
    2
  );
  assert.equal(
    (workflow.match(/"costalerts\.amazonaws\.com"/gu) ?? []).length,
    2
  );
  assert.match(workflow, /arn:aws:budgets::\$\{AWS_ACCOUNT_ID\}:\*/u);
  assert.match(
    workflow,
    /arn:aws:ce::\$\{AWS_ACCOUNT_ID\}:anomalysubscription\/\*/u
  );
  assert.match(
    workflow,
    /\["kms:decrypt", "kms:generatedatakey\*"\]/u
  );
  assert.match(workflow, /"sns:publish"/u);
  assert.match(
    workflow,
    /budgetsPublishPolicyProved:\s+true[\s\S]*?anomalyPublishPolicyProved:\s+true/u
  );
  assert.doesNotMatch(
    workflow,
    /aws sns set-topic-attributes|aws kms put-key-policy/u
  );
});

test("live proof covers exact Budget, anomaly, tags, and apply-only routing test", () => {
  for (const command of [
    "aws budgets describe-budget",
    "aws budgets list-tags-for-resource",
    "aws budgets describe-notifications-for-budget",
    "aws budgets describe-subscribers-for-notification",
    "aws ce get-anomaly-monitors",
    "aws ce get-anomaly-subscriptions",
    "aws ce list-tags-for-resource",
    "aws ce list-cost-allocation-tags",
  ]) {
    assert.ok(workflow.includes(command), command);
  }
  assert.match(workflow, /length == 4/u);
  assert.match(workflow, /actual-50-percent/u);
  assert.match(workflow, /actual-80-percent/u);
  assert.match(workflow, /actual-100-percent/u);
  assert.match(workflow, /forecasted-100-percent/u);
  assert.match(workflow, /Frequency == "IMMEDIATE"/u);
  assert.match(workflow, /MonitorType == "CUSTOM"/u);
  assert.match(
    workflow,
    /MonitorSpecification\.Tags == \{[\s\S]*?Key: "Application"[\s\S]*?MatchOptions: \["EQUALS"\]/u
  );
  assert.match(workflow, /--show-filter-expression/u);
  assert.match(workflow, /exact_tag\("FinOpsScope"; \$scope\)/u);
  assert.match(workflow, /exact_tag\("FinOpsOwner"; \$owner\)/u);
  assert.match(workflow, /exact_tag\("ActivationApproval"; \$approval\)/u);
  assert.match(
    workflow,
    /Publish one explicitly approved harmless routing test[\s\S]*?if:\s+inputs\.operation == 'apply'[\s\S]*?aws sns publish/u
  );
  assert.equal((workflow.match(/aws sns publish/gu) ?? []).length, 1);
  assert.match(
    workflow,
    /No incident or spend threshold was triggered\./u
  );
});

test("uploaded receipt is runner-temporary, digest-only, and fail-closed", () => {
  assert.match(
    workflow,
    /receipt="\$\{RUNNER_TEMP:\?\}\/finops-controls-receipt\.json"/u
  );
  assert.match(
    workflow,
    /path:\s+\$\{\{ runner\.temp \}\}\/finops-controls-receipt\.json/u
  );
  assert.match(workflow, /if-no-files-found:\s+error/u);
  assert.match(workflow, /retention-days:\s+90/u);
  assert.match(workflow, /rawHumanInputsStored:\s+false/u);
  assert.match(workflow, /rawAwsIdentifiersStored:\s+false/u);
  assert.match(workflow, /secretValuesRead:\s+false/u);
  assert.match(workflow, /parameterSetSha256/u);
  assert.match(workflow, /templateSha256/u);
  assert.match(workflow, /notificationTopicPolicySha256/u);
  assert.match(workflow, /notificationKeyPolicySha256/u);
  assert.match(workflow, /ROUTING_TEST_MESSAGE_ID_SHA256/u);
  assert.match(workflow, /COST_ALLOCATION_STATUS_SHA256/u);
  assert.match(workflow, /costAllocationTagStatusSha256/u);
  assert.match(
    workflow,
    /\.costAllocation\.statusSha256\s*\n\s*== \.proof\.costAllocationTagStatusSha256/u
  );
  assert.match(
    workflow,
    /\.costAllocation\.statusSha256[\s\S]*?test\("\^\[a-f0-9\]\{64\}\$"\)/u
  );
  assert.equal(
    (workflow.match(/^\s+path:/gmu) ?? []).length,
    1
  );
});

test("FinOps documentation distinguishes prepared controls from live evidence", () => {
  assert.match(costModel, /source-only control\s+workflow/iu);
  assert.match(costModel, /No hosted workflow receipt/iu);
  assert.match(costModel, /manual,\s+fail-closed `plan\|apply\|verify`/iu);
  assert.match(costModel, /not an application workload/iu);
  assert.match(costModel, /There is no broad-credential or role-ARN-variable fallback/iu);
  assert.match(costModel, /customer-managed symmetric KMS key/iu);
  assert.match(costModel, /proves SNS accepted the message, not that a human read it/iu);
  assert.match(runbook, /prepared, not live/iu);
  assert.match(runbook, /Do not borrow a deployment role/iu);
  assert.match(runbook, /The workflow refuses to create a plan during `apply`/iu);
  assert.match(runbook, /human\s+acknowledgment/iu);
  assert.doesNotMatch(`${costModel}\n${runbook}`, /us-west-2/iu);
});
