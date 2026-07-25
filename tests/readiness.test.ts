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

test("readiness: only the verified canonical CloudFront root is an eligible demo", () => {
  const previous = process.env.SUBMISSION_DEMO_URL;
  try {
    process.env.SUBMISSION_DEMO_URL =
      "https://d2s5v0o0eg2aaw.cloudfront.net";
    assert.equal(
      evaluate().eligibility.requirements.find(
        (requirement) => requirement.id === "unrestricted-functional-demo"
      )?.status,
      "complete"
    );

    for (const invalid of [
      "http://d2s5v0o0eg2aaw.cloudfront.net",
      "https://example.com",
      "https://d0000000000000.cloudfront.net",
      "https://demo@d2s5v0o0eg2aaw.cloudfront.net",
      "https://d2s5v0o0eg2aaw.cloudfront.net/api/proof",
      "https://d2s5v0o0eg2aaw.cloudfront.net?claim=verified",
      "https://d2s5v0o0eg2aaw.cloudfront.net#proof",
      "https://d2s5v0o0eg2aaw.cloudfront.net?",
      "https://d2s5v0o0eg2aaw.cloudfront.net#",
    ]) {
      process.env.SUBMISSION_DEMO_URL = invalid;
      assert.equal(
        evaluate().eligibility.requirements.find(
          (requirement) => requirement.id === "unrestricted-functional-demo"
        )?.status,
        "pending",
        invalid
      );
    }
  } finally {
    if (previous === undefined) {
      delete process.env.SUBMISSION_DEMO_URL;
    } else {
      process.env.SUBMISSION_DEMO_URL = previous;
    }
  }
});

test("readiness: aggregate CI gate fails closed over every prerequisite", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/ci.yml", import.meta.url),
    "utf8"
  );
  const readinessJob = workflow.match(
    /(?:^|\r?\n)  readiness:\r?\n[\s\S]*?(?=\r?\n  [A-Za-z0-9_-]+:\r?\n|$)/u
  )?.[0];
  assert.ok(readinessJob);
  assert.match(
    readinessJob,
    /needs:\s*\[secret-scan,\s*dep-audit,\s*build-test,\s*cluster-survival,\s*pen-test,\s*load,\s*frontend-iac\]/u
  );
  assert.match(
    readinessJob,
    /^    if:\s*\$\{\{\s*always\(\)\s*\}\}\s*$/mu
  );
  assert.match(
    readinessJob,
    /^    steps:\r?\n      - name: Require every prerequisite CI job to pass\s*$/mu
  );
  assert.match(
    readinessJob,
    /jq -e 'length == 7 and all\(\.\[\]; \.result == "success"\)'/u
  );
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
  assert.equal(
    report.checks.find(
      (check) => check.id === "memory.legacy-reconciliation"
    )?.status,
    "pass"
  );
  assert.equal(
    report.checks.find(
      (check) => check.id === "memory.fixed-scope-cspann-owner"
    )?.status,
    "pass"
  );
  assert.equal(
    report.checks.find(
      (check) => check.id === "tech.runtime-cspann-release-gate"
    )?.status,
    "pass"
  );
});

test("readiness: protected legacy reconciliation requires preserved production history", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/database-release.yml", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(workflow, /\.mode == "clean"/u);
  assert.match(
    workflow,
    /\.mode == "migrated" and\s*\.activeBefore == 6 and\s*\.alreadySuperseded == 0 and\s*\.supersededThisRun == 6 and\s*\.linkedAfter == 6/u
  );
  assert.match(
    workflow,
    /\.mode == "already-reconciled" and\s*\.activeBefore == 0 and\s*\.alreadySuperseded == 6 and\s*\.supersededThisRun == 0 and\s*\.linkedAfter == 6/u
  );
  assert.match(
    workflow,
    /\.targetRowSetSha256 !=\s*"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"/u
  );

  const rehearsal = readFileSync(
    new URL("../scripts/reconcile-demo-memory-rehearsal.ts", import.meta.url),
    "utf8"
  );
  assert.match(rehearsal, /alteredCandidateRejected:\s*true/u);
  assert.match(rehearsal, /transactionRollbackAfterMutation:\s*true/u);
  assert.match(rehearsal, /intentional post-mutation reconciliation rollback sentinel/u);
});

test("readiness: database release requires both C-SPANN paths from both runtime principals", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/database-release.yml", import.meta.url),
    "utf8"
  );
  assert.match(workflow, /\.schemaVersion == 5/u);
  assert.match(workflow, /\.proofs\.durableStoreIntegrity == true/u);
  assert.match(workflow, /\.proofs\.canonicalActiveMemories == 9/u);
  assert.match(workflow, /\.proofs\.distinctIdempotencyKeys == 9/u);
  assert.match(workflow, /\.proofs\.distinctContentDigests == 9/u);
  assert.match(
    workflow,
    /\.proofs\.runtimePrincipalCspannPlanAndExecute == true/u
  );
  assert.match(workflow, /all\(\.runtimes\[\];/u);
  assert.match(workflow, /public-no-kind-cspann/u);
  assert.match(workflow, /public-kind-cspann/u);
  assert.match(
    workflow,
    /\.cspannRecall\.noKind\.scopedServingQueryVerified == true/u
  );
  assert.match(
    workflow,
    /\.cspannRecall\.kind\.scopedServingQueryVerified == true/u
  );
  assert.match(
    workflow,
    /\.cspannRecall\.noKind\.isolationCanariesRejected == 3/u
  );
  assert.match(
    workflow,
    /\.cspannRecall\.kind\.isolationCanariesRejected == 3/u
  );
  assert.match(workflow, /\.proofs\.isolationCanaryCount == 3/u);
  assert.match(
    workflow,
    /\.proofs\.scopedServingQueriesRejectCanaries == true/u
  );
  assert.match(
    workflow,
    /servingViewOwnerPrivilegeBoundary ==\s*\n?\s*"direct non-inheritable BYPASSRLS role option; SELECT agent_memory only; no system privileges"/u
  );
  assert.match(
    workflow,
    /idx_agent_memory_company_kind_scope_embedding/u
  );
  const verifier = readFileSync(
    new URL("../scripts/verify-database-release.ts", import.meta.url),
    "utf8"
  );
  assert.match(verifier, /schemaVersion: 5/u);
  assert.match(verifier, /scopedServingQueriesRejectCanaries: true/u);
  const scopedVerifier = verifier.match(
    /async function verifyScopedServingQueryCanaries[\s\S]*?(?=\r?\nasync function verifyRuntimeCspannPath)/u
  )?.[0];
  assert.ok(scopedVerifier);
  assert.match(verifier, /EXPLAIN \$\{statement\.text\}/u);
  assert.match(
    verifier,
    /safeRuntimeQuery<RecallQueryRow>\(\s*client,\s*statement\.text,\s*statement\.params/u
  );
  assert.match(scopedVerifier, /for \(const canary of canaryVectors\)/u);
  assert.match(scopedVerifier, /buildRecallQuery\(embedding, expectedModel/u);
  assert.match(scopedVerifier, /company: "Helios SA"/u);
  assert.match(scopedVerifier, /kind: input\.kind/u);
  assert.match(scopedVerifier, /limit: 50/u);
  assert.match(scopedVerifier, /!query\.fixedPublicScope/u);
  assert.match(
    scopedVerifier,
    /query\.relation !== input\.expectedView/u
  );
  assert.match(
    scopedVerifier,
    /query\.expectedIndexName !== input\.expectedIndex/u
  );
  assert.match(
    scopedVerifier,
    /idempotency_key === canary\.idempotencyKey/u
  );
  assert.match(scopedVerifier, /\/idempotency_key\\s\*=\//u);
  assert.match(scopedVerifier, /publicControlMissing/u);
  assert.match(scopedVerifier, /scopedRows\.rows\.length < 1/u);
  assert.match(scopedVerifier, /scopedRows\.rows\.length > 50/u);
  assert.match(scopedVerifier, /SET vector_search_beam_size = 600/u);
  assert.match(verifier, /class ReleaseGateError extends Error/u);
  assert.match(verifier, /error instanceof ReleaseGateError/u);
});

test("readiness: both AWS release gates accept only fully grounded safe-answer states", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/deploy-aws.yml", import.meta.url),
    "utf8"
  );
  const smokeBlocks = [
    workflow.match(
      /- name: Smoke the same-origin application and real recall path[\s\S]*?(?=\r?\n      - name: Hosted Chromium judge journey on staging)/u
    )?.[0],
    workflow.match(
      /- name: Smoke production through CloudFront[\s\S]*?(?=\r?\n      - name: Hosted Chromium judge journey on production)/u
    )?.[0],
  ];
  const safeStatusGate =
    '(.grounding.status == "verified" or .grounding.status == "extractive")';

  for (const [index, block] of smokeBlocks.entries()) {
    assert.ok(block, `AWS smoke block ${index + 1} must exist`);
    assert.match(block, /-X POST "\$APPLICATION_URL\/api\/recall"/u);
    assert.ok(block.includes(safeStatusGate));
    for (const contract of [
      ".database.activeMemories == .memory.persisted",
      ".memory.persisted == 9",
      ".memory.idempotencyKeys == .memory.persisted",
      ".memory.contentDigests == .memory.persisted",
      ".memory.storeVerified == true",
      '.memory.evidence == "live bounded fixed-scope payload-digest verification"',
      ".recalled > 0",
      "(.citations | length) > 0",
      '(.answer | type == "string" and length > 0)',
      ".modelId == $narrator",
    ]) {
      assert.ok(
        block.includes(contract),
        `AWS smoke block ${index + 1} must require ${contract}`
      );
    }
    for (const check of ["citations", "numerics", "claims"]) {
      assert.ok(
        block.includes(`.grounding.checks.${check} == true`),
        `AWS smoke block ${index + 1} must require grounding.checks.${check}`
      );
    }
    for (const amount of ["€15,375", "€6,775"]) {
      assert.ok(
        block.includes(`contains("${amount}")`),
        `AWS smoke block ${index + 1} must verify ${amount} evidence`
      );
    }
  }
});

test("readiness: AWS canary isolates and exercises the exact candidate version", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/deploy-aws.yml", import.meta.url),
    "utf8"
  );
  const template = readFileSync(
    new URL("../aws/template.yaml", import.meta.url),
    "utf8"
  );
  const deploymentPreference = template.match(
    /AutoPublishAlias:\s*live[\s\S]*?DeploymentPreference:[\s\S]*?(?=\r?\n      Environment:)/u
  )?.[0];
  const candidateAlarm = template.match(
    /  LambdaCanaryErrorAlarm:[\s\S]*?(?=\r?\n  LambdaThrottleAlarm:)/u
  )?.[0];
  const operationalAlarm = template.match(
    /  LambdaErrorAlarm:[\s\S]*?(?=\r?\n  LambdaCanaryErrorAlarm:)/u
  )?.[0];
  const canaryBlocks = [
    workflow.match(
      /- name: Deploy staging with recovery-safe SAM canary[\s\S]*?(?=\r?\n      - name: Resolve public, non-secret stack outputs)/u
    )?.[0],
    workflow.match(
      /- name: Deploy production with recovery-safe SAM canary[\s\S]*?(?=\r?\n      - name: Resolve public, non-secret stack outputs)/u
    )?.[0],
  ];

  for (const [index, block] of canaryBlocks.entries()) {
    assert.ok(block, `AWS canary block ${index + 1} must exist`);
    assert.match(block, /trap stop_canary_probe EXIT/u);
    assert.match(block, /while true; do/u);
    assert.match(block, /\$CANARY_URL\/api\/proof/u);
    assert.match(block, /\$CANARY_URL\/api\/recall/u);
    assert.match(
      block,
      /sam deploy[\s\S]*?--no-progressbar\s+stop_canary_probe\s+trap - EXIT/u
    );
  }
  assert.ok(deploymentPreference);
  assert.match(
    deploymentPreference,
    /Type:\s*Canary10Percent5Minutes[\s\S]*?Alarms:\s*- !Ref LambdaCanaryErrorAlarm/u
  );
  assert.doesNotMatch(deploymentPreference, /!Ref LambdaErrorAlarm/u);
  assert.ok(candidateAlarm);
  assert.match(
    candidateAlarm,
    /AlarmName:\s*!Sub\s+- "\$\{AppName\}-\$\{Environment\}-lambda-canary-errors-v\$\{CandidateVersion\}"\s+- CandidateVersion: !GetAtt ArchonFunction\.Version\.Version/u
  );
  assert.match(
    candidateAlarm,
    /Dimensions:\s*- Name: FunctionName\s+Value: !Ref ArchonFunction\s+- Name: Resource\s+Value: !Sub "\$\{ArchonFunction\}:live"\s+- Name: ExecutedVersion\s+Value: !GetAtt ArchonFunction\.Version\.Version/u
  );
  assert.ok(operationalAlarm);
  assert.match(
    operationalAlarm,
    /Dimensions:\s*- Name: FunctionName\s+Value: !Ref ArchonFunction/u
  );
  assert.doesNotMatch(
    operationalAlarm,
    /Name:\s*(?:Resource|ExecutedVersion)/u
  );
  assert.equal(
    (
      workflow.match(
        /canaryTrafficProbe:\s*"weighted-alias-proof-and-recall"/gu
      ) ?? []
    ).length,
    2
  );
  assert.equal(
    (
      workflow.match(
        /recallGate:\s*"post-promotion-with-explicit-restore"/gu
      ) ?? []
    ).length,
    2
  );
  assert.equal(
    (
      workflow.match(
        /name: Restore the previous (?:staging|production) release on verification failure/gu
      ) ?? []
    ).length,
    2
  );
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

test("readiness: both CloudFormation roles have scoped SAM transform and HTTP API tag permissions", () => {
  const bootstrap = readFileSync(
    new URL("../aws/bootstrap-oidc.yaml", import.meta.url),
    "utf8"
  );
  const commonPolicy = bootstrap.match(
    /  CloudFormationCommonExecutionPolicy:[\s\S]*?\n  CloudFormationApiGatewayStageTagPolicy:/u
  )?.[0];
  const stageTagPolicy = bootstrap.match(
    /  CloudFormationApiGatewayStageTagPolicy:[\s\S]*?\n  StagingExecutionRole:/u
  )?.[0];
  const stagingRole = bootstrap.match(
    /  StagingExecutionRole:[\s\S]*?\n  ProductionExecutionRole:/u
  )?.[0];
  const productionRole = bootstrap.match(
    /  ProductionExecutionRole:[\s\S]*?\n  StagingDeployRole:/u
  )?.[0];

  assert.ok(commonPolicy);
  assert.match(
    commonPolicy,
    /- Sid: ExpandAwsSamTransform\s+Effect: Allow\s+Action:\s+- cloudformation:CreateChangeSet\s+Resource: !Sub "arn:\$\{AWS::Partition\}:cloudformation:\$\{AWS::Region\}:aws:transform\/Serverless-2016-10-31"/u
  );
  assert.match(
    commonPolicy,
    /- Sid: ApiGatewayV2ApiTags\s+Effect: Allow\s+Action:\s+- apigateway:DELETE\s+- apigateway:GET\s+- apigateway:POST\s+Resource: !Sub "arn:\$\{AWS::Partition\}:apigateway:\$\{AWS::Region\}::\/tags\/\*"/u
  );
  assert.ok(stageTagPolicy);
  assert.match(
    stageTagPolicy,
    /Metadata:\s+cfn-lint:\s+config:\s+# The live AWS::ApiGatewayV2::Stage provider requires these native\s+# actions, but cfn-lint 1\.53\.1 has not added them to rule W3037 yet\.\s+ignore_checks:\s+- W3037/u
  );
  assert.match(
    stageTagPolicy,
    /- Sid: ApiGatewayV2StageTags\s+Effect: Allow\s+Action:\s+- apigateway:TagResource\s+- apigateway:UntagResource\s+Resource:\s+- !Sub "arn:\$\{AWS::Partition\}:apigateway:\$\{AWS::Region\}::\/apis\/\*\/stages"\s+- !Sub "arn:\$\{AWS::Partition\}:apigateway:\$\{AWS::Region\}::\/apis\/\*\/stages\/\*"/u
  );
  assert.ok(stagingRole);
  assert.match(stagingRole, /- !Ref CloudFormationCommonExecutionPolicy/u);
  assert.match(
    stagingRole,
    /- !Ref CloudFormationApiGatewayStageTagPolicy/u
  );
  assert.ok(productionRole);
  assert.match(productionRole, /- !Ref CloudFormationCommonExecutionPolicy/u);
  assert.match(
    productionRole,
    /- !Ref CloudFormationApiGatewayStageTagPolicy/u
  );
});

test("readiness: named HTTP API stage controls are proved from transform to live access log", () => {
  const template = readFileSync(
    new URL("../aws/template.yaml", import.meta.url),
    "utf8"
  );
  const workflow = readFileSync(
    new URL("../.github/workflows/deploy-aws.yml", import.meta.url),
    "utf8"
  );
  const bootstrap = readFileSync(
    new URL("../aws/bootstrap-oidc.yaml", import.meta.url),
    "utf8"
  );
  const proof = readFileSync(
    new URL("../aws/prove-api-stage-controls.sh", import.meta.url),
    "utf8"
  );
  const restore = readFileSync(
    new URL("../aws/restore-cloudformation-stack.sh", import.meta.url),
    "utf8"
  );
  const cleanup = readFileSync(
    new URL("../aws/delete-greenfield-stack.sh", import.meta.url),
    "utf8"
  );

  assert.match(template, /StageName:\s+live/u);
  assert.match(
    template,
    /OriginPath:\s*!Join\s*\["",\s*\["\/",\s*!Ref ServerlessHttpApi\.Stage\]\]/u
  );
  assert.match(
    template,
    /DefaultRouteSettings:\s+DetailedMetricsEnabled:\s+true\s+ThrottlingBurstLimit:\s+!Ref ApiThrottleBurst\s+ThrottlingRateLimit:\s+!Ref ApiThrottleRate/u
  );
  assert.match(
    template,
    /AccessLogSettings:\s+DestinationArn:\s+!GetAtt ApiVendedAccessLogGroup\.Arn/u
  );
  assert.match(
    template,
    /LogGroupName:\s+!Sub "\/aws\/vendedlogs\/apigateway\/\$\{AppName\}-\$\{Environment\}"/u
  );
  assert.equal(
    (template.match(/DeletionPolicy:\s+RetainExceptOnCreate/gu) ?? [])
      .length,
    3
  );
  assert.doesNotMatch(template, /StageName:\s+["']?\$default/u);
  assert.equal(
    (
      workflow.match(
        /name: Prove transformed and live API stage controls/gu
      ) ?? []
    ).length,
    2
  );
  assert.match(proof, /--template-stage Processed/u);
  assert.match(proof, /aws apigatewayv2 get-stage/u);
  assert.match(proof, /\.DetailedMetricsEnabled == true/u);
  assert.match(proof, /\.ThrottlingRateLimit == 5/u);
  assert.match(proof, /\.ThrottlingBurstLimit == 10/u);
  assert.match(proof, /aws logs describe-log-streams/u);
  assert.match(proof, /aws logs filter-log-events/u);
  assert.equal((proof.match(/--no-paginate/gu) ?? []).length, 2);
  assert.match(proof, /\.stage == "live"/u);
  assert.match(proof, /--stage-name '\$default'/u);
  assert.match(proof, /legacyDefaultStageAbsent: true/u);
  assert.match(proof, /\.routeKey == "GET \/api\/health"/u);
  for (const output of [
    "ApiId",
    "ApiStageName",
    "ApiAccessLogGroupName",
  ]) {
    assert.match(template, new RegExp(`^  ${output}:$`, "mu"));
  }
  assert.equal(
    (
      workflow.match(
        /name: Preflight API stage-proof permissions before stack mutation/gu
      ) ?? []
    ).length,
    2
  );
  assert.equal(
    (workflow.match(/API_ID="\$\(jq -er/gu) ?? []).length,
    2
  );
  assert.equal(
    (workflow.match(/--slurpfile apiStage api-stage-proof\.json/gu) ?? [])
      .length,
    2
  );
  assert.equal(
    (workflow.match(/else error\("invalid API stage proof"\)/gu) ?? [])
      .length,
    2
  );
  assert.equal(
    (workflow.match(/apiStage: \$apiStage\[0\]/gu) ?? []).length,
    2
  );
  assert.equal(
    (workflow.match(/--template-stage Original/gu) ?? []).length,
    2
  );
  assert.equal(
    (workflow.match(/bash aws\/restore-cloudformation-stack\.sh/gu) ?? [])
      .length,
    2
  );
  assert.equal(
    (workflow.match(/bash aws\/delete-greenfield-stack\.sh/gu) ?? [])
      .length,
    2
  );
  assert.equal(
    (workflow.match(/"\$PREVIOUS_APPLICATION_URL\/api\/health"/gu) ?? [])
      .length,
    2
  );
  assert.equal(
    (workflow.match(/"\$PREVIOUS_APPLICATION_URL\/api\/proof"/gu) ?? [])
      .length,
    2
  );
  assert.equal(
    (workflow.match(/EXPECTED_STACK_STATE:/gu) ?? []).length,
    2
  );
  assert.equal(
    (workflow.match(/Stack state changed after the greenfield preflight/gu) ?? [])
      .length,
    2
  );
  assert.equal(
    (
      workflow.match(
        /name: Refresh short-lived AWS credentials for (?:staging|production) recovery/gu
      ) ?? []
    ).length,
    2
  );
  assert.equal(
    (workflow.match(/timeout-minutes:\s+90/gu) ?? []).length,
    2
  );
  assert.equal(
    (workflow.match(/test "\$RECOVERY_FAILED" -eq 0/gu) ?? []).length,
    4
  );
  assert.ok(
    (workflow.match(/aws cloudfront wait invalidation-completed/gu) ?? [])
      .length >= 4
  );
  assert.equal(
    (bootstrap.match(/- cloudformation:GetTemplate$/gmu) ?? []).length,
    2
  );
  for (const action of [
    "logs:CreateLogDelivery",
    "logs:PutResourcePolicy",
    "logs:UpdateLogDelivery",
    "logs:DeleteLogDelivery",
    "logs:DescribeLogStreams",
    "logs:DescribeResourcePolicies",
    "logs:FilterLogEvents",
    "logs:GetLogEvents",
    "logs:GetLogDelivery",
    "logs:ListLogDeliveries",
  ]) {
    const expectedCount =
      action === "logs:DescribeLogStreams" ||
      action === "logs:FilterLogEvents"
        ? 3
        : 1;
    assert.equal(
      (bootstrap.match(new RegExp(`- ${action}$`, "gmu")) ?? []).length,
      expectedCount
    );
  }
  assert.equal(
    (
      bootstrap.match(
        /log-group:\/aws\/vendedlogs\/apigateway\/\$\{AppName\}-(?:staging|production)"/gu
      ) ?? []
    ).length,
    2
  );
  assert.match(restore, /--parameters "file:\/\/\$\{parameters_file\}"/u);
  assert.match(restore, /cloudformation create-change-set/u);
  assert.match(restore, /cloudformation execute-change-set/u);
  assert.match(restore, /cloudformation wait stack-update-complete/u);
  assert.match(cleanup, /cloudformation delete-stack/u);
  assert.match(cleanup, /s3api list-object-versions/u);
  assert.match(cleanup, /s3api delete-bucket/u);
  assert.equal(
    (
      bootstrap.match(
        /Resource: !Sub "arn:\$\{AWS::Partition\}:apigateway:\$\{AWS::Region\}::\/apis\/\*\/stages\/\*"/gu
      ) ?? []
    ).length,
    2
  );
});

test("readiness: CloudFront pins valid AWS managed policies for the SPA and uncached API", () => {
  const template = readFileSync(
    new URL("../aws/template.yaml", import.meta.url),
    "utf8"
  );
  const cachePolicyIds = [
    ...template.matchAll(/^\s+CachePolicyId:\s+([0-9a-f-]+)\s*$/gmu),
  ].map((match) => match[1]);

  assert.deepEqual(cachePolicyIds, [
    "658327ea-f89d-4fab-a63d-7e88639e58f6",
    "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
  ]);
  assert.match(
    template,
    /PathPattern: \/api\/\*[\s\S]*?CachePolicyId: 4135ea2d-6df8-44a3-9df3-4b5a84be39ad[\s\S]*?OriginRequestPolicyId: b689b0a8-53d0-40ab-baf2-68738e2966ac/u
  );
});
