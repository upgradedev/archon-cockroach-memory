import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

const workflow = read(
  ".github/workflows/sustainability-intensity-evidence.yml"
);
const script = read("aws/measure-sustainability-intensity.sh");
const hostedWorkflow = read(".github/workflows/hosted-load-evidence.yml");
const hostedLoad = read("load/hosted-recall.js");
const hostedContract = read("load/hosted-recall-contract.js");
const baselineGuide = read("docs/sustainability/BASELINE_AND_TARGETS.md");
const runbook = read("docs/runbooks/sustainability-intensity.md");
const evidence = read("docs/operations/WELL_ARCHITECTED_EVIDENCE.md");
const contract = JSON.parse(
  read("docs/operations/well-architected-contract.json")
) as {
  controls: Array<Record<string, unknown>>;
  approvalGates: Array<Record<string, unknown>>;
  requiredDocuments: string[];
};
const policy = JSON.parse(
  read("aws/sustainability-intensity-audit-policy.json")
) as {
  Version: string;
  Statement: Array<{
    Sid: string;
    Effect: string;
    Action: string | string[];
    Resource: string | string[];
    Condition?: Record<string, Record<string, string>>;
  }>;
};

test("sustainability workflow is manual, protected, read-only, and exact-green-main", () => {
  const trigger = workflow.slice(
    workflow.indexOf("on:"),
    workflow.indexOf("concurrency:")
  );
  assert.match(trigger, /^\s{2}workflow_dispatch:/mu);
  assert.doesNotMatch(
    trigger,
    /^\s{2}(?:pull_request|push|schedule|workflow_call):/mu
  );
  assert.match(workflow, /environment:\s+sustainability-audit/u);
  assert.match(workflow, /id-token:\s+write/u);
  assert.match(workflow, /actions:\s+read/u);
  assert.match(workflow, /contents:\s+read/u);
  assert.match(
    workflow,
    /AWS_SUSTAINABILITY_AUDIT_ROLE_ARN:\s*\$\{\{ vars\.AWS_SUSTAINABILITY_AUDIT_ROLE_ARN \}\}/u
  );
  assert.match(workflow, /AWS_REGION:\s+eu-west-1/u);
  assert.equal(
    (workflow.match(/test "\$GITHUB_SHA" = "\$TARGET_SHA"/gu) ?? [])
      .length,
    2
  );
  assert.equal(
    (
      workflow.match(
        /sustainability-intensity-evidence\.yml@refs\/heads\/main/gu
      ) ?? []
    ).length,
    2
  );
  assert.equal(
    (
      workflow.match(
        /test "\$\(git rev-parse origin\/main\)" = "\$TARGET_SHA"/gu
      ) ?? []
    ).length,
    2
  );
  assert.match(workflow, /prove_workflow ci\.yml CI/u);
  assert.match(workflow, /prove_workflow codeql\.yml CodeQL/u);
  assert.match(
    workflow,
    /supply-chain\.yml "Supply Chain \(enforced\)"/u
  );
  assert.match(workflow, /deploy-aws\.yml "Deploy AWS"/u);
  assert.match(
    workflow,
    /\.owners\.sustainability[\s\S]*?\.status == "assigned"/u
  );
  assert.match(workflow, /role-duration-seconds:\s+900/u);
  assert.match(workflow, /mask-aws-account-id:\s+true/u);
  assert.match(
    workflow,
    /allowed-account-ids:\s*\$\{\{ env\.AWS_ACCOUNT_ID \}\}/u
  );
  assert.doesNotMatch(
    workflow,
    /secrets\.(?:AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY)|aws-access-key-id:|aws-secret-access-key:/u
  );
});

test("workflow binds exact hosted and baseline receipts and uploads no raw AWS response", () => {
  const measureJobStart = workflow.indexOf("  measure:");
  const measureStepsStart = workflow.indexOf("    steps:", measureJobStart);
  assert.ok(measureJobStart >= 0);
  assert.ok(measureStepsStart > measureJobStart);
  assert.doesNotMatch(
    workflow.slice(measureJobStart, measureStepsStart),
    /\$\{\{\s*runner\./u
  );
  assert.match(workflow, /Hosted Load Evidence/u);
  assert.match(workflow, /\.github\/workflows\/hosted-load-evidence\.yml/u);
  assert.match(workflow, /hosted-load-\$\{\{ inputs\.environment \}\}/u);
  assert.match(workflow, /hosted_load_receipt_sha256/u);
  assert.match(workflow, /comparison_mode == 'compare'/u);
  assert.match(workflow, /baseline_receipt_sha256/u);
  assert.match(workflow, /BASELINE_RECEIPT_PATH:\s*\$\{\{ runner\.temp \}\}/u);
  assert.match(workflow, /RECEIPT_PATH:\s*\$\{\{ runner\.temp \}\}\/sustainability-intensity-receipt\.json/u);
  assert.match(
    workflow,
    /name:\s+Upload only the sanitized receipt[\s\S]*?path:\s*\$\{\{ runner\.temp \}\}\/sustainability-intensity-receipt\.json[\s\S]*?retention-days:\s+90/u
  );
  assert.doesNotMatch(
    workflow,
    /path:\s*\$\{\{ runner\.temp \}\}\/(?:sustainability-intensity\.|regional-metrics|cloudfront-metrics|stack\.json)/u
  );
  assert.match(workflow, /rawResponsesUploaded == false/u);
  assert.match(workflow, /emissionsMeasured:\s+false/u);
  assert.match(workflow, /carbonReductionClaimed:\s+false/u);
  assert.match(workflow, /productionScaleClaimed:\s+false/u);
  assert.match(workflow, /ccftUsed:\s+false/u);

  const uses = [...workflow.matchAll(/^\s+uses:\s+([^\s#]+)/gmu)].map(
    (match) => match[1]
  );
  assert.equal(uses.length, 6);
  for (const action of uses) {
    assert.match(action, /^[^@]+@[a-f0-9]{40}$/u);
  }
  assert.equal(
    (workflow.match(/persist-credentials:\s+false/gu) ?? []).length,
    2
  );
});

test("hosted load version 2 provides recall-only numerator boundaries and an exact denominator", () => {
  assert.match(hostedLoad, /new Trend\("hosted_recall_duration_ms", true\)/u);
  assert.match(hostedLoad, /new Rate\("hosted_recall_http_failure"\)/u);
  assert.match(hostedLoad, /new Counter\("hosted_successful_recalls"\)/u);
  assert.match(
    hostedLoad,
    /hosted_recall_duration_ms:\s*\[`p\(95\)<\$\{P95_LATENCY_MS\}`\]/u
  );
  assert.match(
    hostedLoad,
    /hosted_recall_http_failure:\s*\[`rate<=\$\{MAX_ERROR_RATE\}`\]/u
  );
  assert.match(hostedLoad, /hosted_scope_isolation:\s*\["rate>=1"\]/u);
  assert.match(hostedLoad, /hosted_recall_contract:\s*\["rate>=1"\]/u);
  assert.match(hostedWorkflow, /--new-machine-readable-summary/u);
  assert.match(
    hostedLoad,
    /hosted_grounded_citations:\s*\["rate>=1"\]/u
  );
  assert.match(
    hostedLoad,
    /hosted_successful_recalls:\s*\[`count>=\$\{TOTAL_ITERATIONS\}`\]/u
  );
  assert.doesNotMatch(
    hostedLoad,
    /http_req_duration:\s*\[|http_req_failed:\s*\[/u
  );
  assert.match(hostedLoad, /successfulRecalls\.add\(1\)/u);
  assert.match(hostedContract, /grounding\.status === "verified"/u);
  assert.match(hostedContract, /grounding\.status === "extractive"/u);
  assert.match(hostedContract, /groundingChecks\.citations === true/u);
  assert.match(hostedContract, /groundingChecks\.numerics === true/u);
  assert.match(hostedContract, /groundingChecks\.claims === true/u);
  assert.match(hostedContract, /answer\.includes\("€15,375"\)/u);
  assert.match(hostedContract, /answer\.includes\("€6,775"\)/u);
  assert.match(hostedContract, /EXACT_UUID\.test\(citation\.memoryId\)/u);
  assert.match(hostedContract, /exactPublicScope/u);
  assert.match(hostedWorkflow, /version:\s+2/u);
  assert.match(hostedWorkflow, /measurementWindow:/u);
  assert.match(
    hostedWorkflow,
    /contractSource:\s+"load\/hosted-recall\.js"/u
  );
  assert.match(
    hostedWorkflow,
    /contractSourceSha256:\s+\$workloadContractSha256/u
  );
  assert.match(
    hostedWorkflow,
    /contractDigestAlgorithm:\s*\n\s+"sha256\(canonical-sha256sum-manifest\)"/u
  );
  assert.match(hostedWorkflow, /hosted-load-contract\.sha256/u);
  assert.match(hostedWorkflow, /sha256sum --check --strict/u);
  assert.match(hostedWorkflow, /measurement_started_at/u);
  assert.match(hostedWorkflow, /measurement_completed_at/u);
  assert.match(hostedWorkflow, /alignment_wait="\$\(\(62 - current_second\)\)"/u);
  assert.match(hostedWorkflow, /sleep "\$alignment_wait"/u);
  assert.match(hostedWorkflow, /hosted_recall_duration_ms/u);
  assert.match(hostedWorkflow, /hosted_recall_http_failure/u);
  assert.match(hostedWorkflow, /hosted_successful_recalls/u);
  assert.match(hostedWorkflow, /\$document\.version == "1\.0\.0"/u);
  assert.match(hostedWorkflow, /\$document\.results\.metrics/u);
  assert.match(
    hostedWorkflow,
    /\$metrics\.http_reqs\.values\.count[\s\S]*?== \(\$iterations \+ 1\)/u
  );
  assert.match(
    hostedWorkflow,
    /\$metrics\.hosted_successful_recalls\.values\.count\s*== \$iterations/u
  );
  assert.match(script, /\.version == "1\.0\.0"/u);
  assert.match(script, /\.results\.metrics \| map\(\{key: \.name, value: \.\}\)/u);
  assert.match(
    script,
    /the raw k6 summary does not match the successful hosted-load receipt/u
  );
});

test("measurement script uses bounded read APIs and conservative per-successful-recall proxies", () => {
  const operations = [
    ...new Set(
      [...script.matchAll(/\b(sts|cloudformation|cloudwatch|logs)\s+([a-z][a-z0-9-]+)\b/gu)].map(
        (match) => `${match[1]} ${match[2]}`
      )
    ),
  ].sort();
  assert.deepEqual(operations, [
    "cloudformation describe-stacks",
    "cloudwatch get-metric-data",
    "logs describe-log-groups",
    "sts get-caller-identity",
  ]);
  assert.match(script, /\[ "\$AWS_REGION" = "eu-west-1" \]/u);
  assert.match(script, /--region us-east-1/u);
  assert.doesNotMatch(script, /--region us-west-2/u);
  assert.match(
    script,
    /"\$window_end_epoch" -ge \$\(\(now_epoch - 1209600\)\)/u
  );
  assert.match(script, /telemetry_duration" -le 780/u);
  assert.equal(
    (script.match(/-eq "\$expected_http_requests" \]/gu) ?? []).length,
    3
  );
  assert.match(script, /Period:60/u);
  assert.match(script, /MetricName:"Invocations"/u);
  assert.match(script, /MetricName:"Errors"/u);
  assert.match(script, /MetricName:"Duration"/u);
  assert.match(script, /MetricName:"DataProcessed"/u);
  assert.match(script, /MetricName:"BytesDownloaded"/u);
  assert.match(script, /MetricName:"BytesUploaded"/u);
  assert.match(script, /configuredMemoryGbSecondsPerSuccessfulRecall/u);
  assert.match(script, /dataProcessedBytesPerSuccessfulRecall/u);
  assert.match(script, /transferBytesPerSuccessfulRecall/u);
  assert.match(script, /storedBytes/u);
  assert.match(script, /corpus: "synthetic-public-demo"/u);
  assert.match(
    script,
    /\.workload\.contractSource == "load\/hosted-recall\.js"/u
  );
  assert.match(script, /load\/hosted-recall-contract\.js/u);
  assert.match(script, /sha256\(canonical-sha256sum-manifest\)/u);
  assert.match(
    workflow,
    /HOSTED_LOAD_CONTRACT_MANIFEST_PATH:\s+\$\{\{ runner\.temp \}\}\/hosted-load-artifact\/hosted-load-contract\.sha256/u
  );
  assert.match(
    workflow,
    /HOSTED_LOAD_SUMMARY_PATH:\s+\$\{\{ runner\.temp \}\}\/hosted-load-artifact\/hosted-k6-summary\.json/u
  );
  assert.match(script, /sha256sum --check --strict/u);
  assert.match(
    script,
    /\.workload\.contractSourceSha256 == \$contractDigest/u
  );
  assert.match(script, /\.rawSummary\.sha256 == \$summaryDigest/u);
  assert.match(
    script,
    /\.results\.metrics \| map\(\{key: \.name, value: \.\}\) \| from_entries/u
  );
  assert.match(
    script,
    /\.observed\.successfulRecalls == \.workload\.iterations/u
  );
  assert.match(script, /equivalence_digest/u);
  assert.match(script, /oneMinuteRequestCountsExact: true/u);
  assert.match(script, /approved-reduction-target-met/u);
  assert.match(script, /rawResponsesUploaded: false/u);
  assert.match(script, /rm -f -- "\$raw_dir"\/\*/u);
  assert.match(script, /mv -f -- "\$final_receipt" "\$RECEIPT_PATH"/u);
  assert.doesNotMatch(
    script,
    /\b(?:create|put|update|delete|enable|disable|start|stop|invoke)-[a-z0-9-]+\b/u
  );
});

test("reference IAM policy grants only exact read surfaces in approved control planes", () => {
  const actions = policy.Statement.flatMap((statement) =>
    Array.isArray(statement.Action) ? statement.Action : [statement.Action]
  ).sort();
  assert.equal(policy.Version, "2012-10-17");
  assert.equal(policy.Statement.length, 5);
  assert.deepEqual(actions, [
    "cloudformation:DescribeStacks",
    "cloudwatch:GetMetricData",
    "cloudwatch:GetMetricData",
    "logs:DescribeLogGroups",
    "sts:GetCallerIdentity",
  ]);
  assert.ok(policy.Statement.every((statement) => statement.Effect === "Allow"));
  const stacks = policy.Statement.find(
    (statement) => statement.Sid === "ReadExactApplicationStacks"
  );
  assert.deepEqual(stacks?.Resource, [
    "arn:aws:cloudformation:eu-west-1:*:stack/archon-memory-staging/*",
    "arn:aws:cloudformation:eu-west-1:*:stack/archon-memory-production/*",
  ]);
  assert.deepEqual(stacks?.Condition, {
    StringEquals: { "aws:RequestedRegion": "eu-west-1" },
  });
  assert.deepEqual(
    policy.Statement.find(
      (statement) => statement.Sid === "ReadGlobalCloudFrontMetrics"
    )?.Condition,
    { StringEquals: { "aws:RequestedRegion": "us-east-1" } }
  );
  assert.ok(
    actions.every((action) => /:(?:Describe|Get)[A-Z]/u.test(action))
  );
  assert.ok(
    policy.Statement.every(
      (statement) => JSON.stringify(statement).includes("us-west-2") === false
    )
  );
});

test("WA-10 source contract and docs preserve approval and claim boundaries", () => {
  assert.deepEqual(
    contract.controls.find((control) => control.id === "WA-10"),
    {
      id: "WA-10",
      name: "Measured sustainability improvement",
      scope: "repository-and-account-telemetry",
      state: "repository-prepared-live-measurement-required",
      requiresExternalApproval: true,
      activatedByThisContract: false,
      evidenceWorkflow:
        ".github/workflows/sustainability-intensity-evidence.yml",
      auditScript: "aws/measure-sustainability-intensity.sh",
      referencePolicy: "aws/sustainability-intensity-audit-policy.json",
      runbook: "docs/runbooks/sustainability-intensity.md",
      protectedEnvironment: "sustainability-audit",
      roleVariable: "AWS_SUSTAINABILITY_AUDIT_ROLE_ARN",
      mutationPermitted: false,
      emissionsClaimPermitted: false,
    }
  );
  assert.deepEqual(
    contract.approvalGates.find(
      (gate) => gate.id === "sustainability-intensity-measurement"
    ),
    {
      id: "sustainability-intensity-measurement",
      required: true,
      mutationAllowed: false,
      conditions: [
        "exact current green main SHA and exact successful hosted-load receipt",
        "assigned sustainability owner and protected sustainability-audit approval",
        "existing least-privilege AWS_SUSTAINABILITY_AUDIT_ROLE_ARN",
        "human-approved primary proxy and reduction target",
        "equivalent synthetic corpus concurrency correctness and objectives",
        "sanitized receipt with no emissions or production-scale claim",
      ],
    }
  );
  assert.ok(
    contract.requiredDocuments.includes(
      "docs/runbooks/sustainability-intensity.md"
    )
  );
  assert.match(baselineGuide, /Status: repository-prepared/u);
  assert.match(baselineGuide, /version-2 Hosted Load Evidence/u);
  assert.match(baselineGuide, /successful recall/u);
  assert.match(baselineGuide, /not billed-duration/u);
  assert.match(runbook, /no live baseline or improvement receipt is[\s\S]*?claimed/iu);
  assert.match(runbook, /AWS_SUSTAINABILITY_AUDIT_ROLE_ARN/u);
  assert.match(runbook, /sustainability-audit/u);
  assert.match(runbook, /CCFT is retired/u);
  assert.match(evidence, /Protected WA-10 sustainability intensity evidence/u);
});
