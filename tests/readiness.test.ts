import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  allCockroachImagesPinned,
  allCheckoutStepsDisableCredentialPersistence,
  allComposeImagesPinned,
  allDockerfileBasesPinned,
  allSetupNodeStepsPinned,
  allWorkflowActionCommitsInventoryLocked,
  allWorkflowActionsPinned,
  evaluate,
  EXPECTED_COCKROACH_IMAGE_REFS,
  EXPECTED_COMPOSE_IMAGE_REFS,
  EXPECTED_DEPENDABOT_RELEASE_FREEZE,
  EXPECTED_DOCKERFILE_BASE_REFS,
  EXPECTED_SETUP_NODE_STEPS,
  EXPECTED_WORKFLOW_ACTION_REFS,
  DURABLE_RECOVERY_LOCAL_BASENAMES,
  DURABLE_RECOVERY_SCRIPT_PATHS,
  evaluateIncrementalFixedCostContract,
  generatedArtifactPaths,
  GENERATED_ARTIFACT_BASENAMES,
  hasExactAwsDeliveryConcurrency,
  hasExactAwsDeployTrigger,
  hasExactAwsRecoveryTrigger,
  hasExactBenchmarkTrigger,
  hasExactCiTrigger,
  hasExactCodeqlActionPins,
  hasExactDependabotReleaseFreeze,
  hasExactDemoVideoTrigger,
  hasExactHostedDastTrigger,
  hasExactHostedSmokeContracts,
  hasExactSubmissionReadinessTrigger,
  hasExactSubmissionWorkflowContract,
  hasExactZapIgnorePolicy,
  hasUniqueCiTriggerOwnership,
  inspectSubmissionThumbnail,
  isSubmissionEligible,
  MAX_SUBMISSION_THUMBNAIL_BYTES,
  OFFICIAL_CRITERIA,
  parseCanonicalSubmissionVideoUrl,
  PINNED_CODEQL_ACTION_SHA,
  PINNED_NODE_VERSION,
  repositoryDockerComposeSources,
  repositoryDockerfileSources,
  repositoryWorkflowSources,
  setupNodeVersions,
  SOURCE_FLOOR,
  SUBMISSION_THUMBNAIL_PATH,
  validDevpostSubmissionUrl,
  validatedSubmissionThumbnail,
  validSubmissionThumbnail,
  validSubmissionVideoDuration,
} from "../scripts/readiness.js";

function repositoryWorkflowTexts(): string[] {
  return repositoryWorkflowSources().map(({ source }) => source);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function extractNamedWorkflowStep(source: string, name: string): string {
  return (
    source.match(
      new RegExp(
        `(?:^|\\r?\\n)      - name: ${escapeRegExp(name)}\\r?\\n[\\s\\S]*?(?=\\r?\\n      - name: |$)`,
        "u"
      )
    )?.[0] ?? ""
  );
}

function extractNamedWorkflowJob(source: string, id: string): string {
  return (
    source.match(
      new RegExp(
        `(?:^|\\r?\\n)  ${escapeRegExp(id)}:\\r?\\n[\\s\\S]*?(?=\\r?\\n  [A-Za-z0-9_-]+:\\r?\\n|$)`,
        "u"
      )
    )?.[0] ?? ""
  );
}

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

test("readiness: lifecycle fixed-cost ceiling is itemized and independently recomputed", () => {
  const policySource = readFileSync(
    new URL(
      "../aws/foundation-storage-migration-policy.json",
      import.meta.url
    ),
    "utf8"
  );
  const evaluation = evaluateIncrementalFixedCostContract(
    JSON.parse(policySource) as unknown
  );
  assert.equal(evaluation.valid, true);
  assert.deepEqual(evaluation.scenarioMonthlyUsd, {
    initial: 22.4,
    afterFirstBilledKmsRotation: 23.4,
    afterSecondBilledKmsRotation: 24.4,
  });
  assert.equal(evaluation.maximumMonthlyUsd, 24.4);
  assert.equal(evaluation.approvedCeilingMonthlyUsd, 26);
  assert.equal(evaluation.headroomMonthlyUsd, 1.6);
  assert.doesNotMatch(policySource, /withinApprovedCeiling/u);

  const misstatedScenarioSource = policySource.replace(
    '"expectedMonthlyUsd": 23.40',
    '"expectedMonthlyUsd": 23.39'
  );
  assert.notEqual(misstatedScenarioSource, policySource);
  assert.equal(
    evaluateIncrementalFixedCostContract(
      JSON.parse(misstatedScenarioSource) as unknown
    ).valid,
    false
  );

  const unapprovedUnitPriceSource = policySource.replace(
    '"unitMonthlyUsd": 5.00',
    '"unitMonthlyUsd": 5.01'
  );
  assert.notEqual(unapprovedUnitPriceSource, policySource);
  assert.equal(
    evaluateIncrementalFixedCostContract(
      JSON.parse(unapprovedUnitPriceSource) as unknown
    ).valid,
    false
  );

  const check = evaluate().checks.find(
    (candidate) => candidate.id === "product.lifecycle-fixed-cost-ceiling"
  );
  assert.ok(check);
  assert.equal(check.criterion, "Production Readiness");
  assert.equal(check.status, "pass", check.detail);

  const audit = readFileSync(
    new URL(
      "../.github/scripts/well-architected-contract-audit.mjs",
      import.meta.url
    ),
    "utf8"
  );
  assert.match(audit, /evaluateIncrementalFixedCostContract/u);
  assert.match(audit, /incremental-fixed-cost-contract-arithmetic/u);
  assert.doesNotMatch(audit, /withinApprovedCeiling/u);
});

test("readiness: lifecycle workflow cost guards compile and evaluate", () => {
  const jqVersion = spawnSync("jq", ["--version"], { encoding: "utf8" });
  assert.equal(
    jqVersion.status,
    0,
    jqVersion.error?.message ?? jqVersion.stderr
  );

  const policyPath = fileURLToPath(
    new URL(
      "../aws/foundation-storage-migration-policy.json",
      import.meta.url
    )
  );
  const workflowPaths = [
    "../.github/workflows/foundation-migration.yml",
    "../.github/workflows/edge-controls.yml",
  ];
  const filters: string[] = [];
  for (const workflowPath of workflowPaths) {
    const workflow = readFileSync(
      new URL(workflowPath, import.meta.url),
      "utf8"
    );
    const step = extractNamedWorkflowStep(
      workflow,
      "Validate the approved incremental fixed-cost contract"
    );
    assert.ok(step.length > 0, workflowPath);
    const filter =
      step.match(
        /jq -e '([\s\S]*?)' aws\/foundation-storage-migration-policy\.json/u
      )?.[1] ?? "";
    assert.ok(filter.length > 0, workflowPath);
    assert.doesNotMatch(
      filter,
      /all\(\s*\$[A-Za-z_][A-Za-z0-9_.]*\[\] as \$[A-Za-z_][A-Za-z0-9_]*;/u
    );
    assert.equal(
      (filter.match(/\$cost\.lineItems\[\];\s*\. as \$item\s*\|/gu) ?? [])
        .length,
      1,
      workflowPath
    );
    assert.equal(
      (filter.match(/\$scenarioIds\[\];\s*\. as \$scenario\s*\|/gu) ?? [])
        .length,
      3,
      workflowPath
    );
    const evaluated = spawnSync("jq", ["-e", filter, policyPath], {
      encoding: "utf8",
    });
    assert.equal(
      evaluated.status,
      0,
      `${workflowPath}: ${evaluated.error?.message ?? evaluated.stderr}`
    );
    filters.push(filter);
  }
  assert.equal(filters.length, 2);
  assert.equal(filters[1], filters[0]);
});

test("readiness: edge cleanup and finalization have bounded restart-safe lifecycle contracts", () => {
  const check = evaluate().checks.find(
    (candidate) =>
      candidate.id === "product.protected-foundation-and-edge-delivery"
  );
  assert.ok(check);
  assert.equal(check.criterion, "Production Readiness");
  assert.equal(check.status, "pass", check.detail);

  const workflow = readFileSync(
    new URL("../.github/workflows/edge-controls.yml", import.meta.url),
    "utf8"
  );
  const audit = readFileSync(
    new URL(
      "../.github/scripts/well-architected-contract-audit.mjs",
      import.meta.url
    ),
    "utf8"
  );
  const contract = JSON.parse(
    readFileSync(
      new URL(
        "../docs/operations/well-architected-contract.json",
        import.meta.url
      ),
      "utf8"
    )
  ) as {
    controls: Array<{
      id: string;
      operations?: string;
      typedConfirmations?: Record<string, string>;
      cleanupEligibleStates?: string[];
      cleanupOldSourceValidation?: string;
      cleanupTerminalProof?: string;
      cleanupReceiptSanitized?: boolean;
      finalizeCreatesChangeSet?: boolean;
      finalizeExactLiveProof?: boolean;
      restartSafeProtectionRepair?: boolean;
      alarmDeliveryDrill?: string;
      humanPagingClaimed?: boolean;
    }>;
  };
  const inspectStep = extractNamedWorkflowStep(
    workflow,
    "Inspect current edge stack state"
  );
  const cleanupStep = extractNamedWorkflowStep(
    workflow,
    "Clean up exact recoverable edge shell"
  );
  const createPlanStep = extractNamedWorkflowStep(
    workflow,
    "Create or reuse exact edge plan"
  );
  const loadPlanStep = extractNamedWorkflowStep(
    workflow,
    "Load exact existing edge plan"
  );
  const requirePlanStep = extractNamedWorkflowStep(
    workflow,
    "Require exact non-replacement WAF evidence plan"
  );
  const executePlanStep = extractNamedWorkflowStep(
    workflow,
    "Execute exact inspected edge plan"
  );
  const preProtectionProofStep = extractNamedWorkflowStep(
    workflow,
    "Prove exact deployed stack before lifecycle protection"
  );
  const setProtectionStep = extractNamedWorkflowStep(
    workflow,
    "Set exact edge stack lifecycle protections"
  );
  const liveProofStep = extractNamedWorkflowStep(
    workflow,
    "Prove exact deployed WAF controls"
  );

  for (const step of [
    inspectStep,
    cleanupStep,
    createPlanStep,
    loadPlanStep,
    requirePlanStep,
    executePlanStep,
    preProtectionProofStep,
    setProtectionStep,
    liveProofStep,
  ]) {
    assert.ok(step.length > 0);
  }
  assert.match(
    workflow,
    /options:\r?\n\s+- plan\r?\n\s+- apply\r?\n\s+- verify\r?\n\s+- cleanup\r?\n\s+- finalize/u
  );
  for (const confirmation of [
    "APPLY-${environment_upper}-EDGE-CONTROLS",
    "CLEANUP-${environment_upper}-EDGE-CONTROLS",
    "FINALIZE-${environment_upper}-EDGE-CONTROLS",
  ]) {
    assert.ok(workflow.includes(`expected_confirmation="${confirmation}"`));
  }
  assert.match(
    workflow,
    /plan\|verify\)\r?\n\s+test -z "\$CONFIRMATION"/u
  );

  assert.match(inspectStep, /^[ \t]+REVIEW_IN_PROGRESS\)\r?$/mu);
  assert.match(inspectStep, /^[ \t]+apply\|cleanup\) ;;\r?$/mu);
  assert.match(inspectStep, /EDGE_CLEANUP_PRIOR_STATUS=REVIEW_IN_PROGRESS/u);
  assert.match(inspectStep, /^[ \t]+ROLLBACK_COMPLETE\)\r?$/mu);
  assert.match(inspectStep, /test "\$OPERATION" = "cleanup"/u);
  assert.match(inspectStep, /EDGE_CLEANUP_PRIOR_STATUS=ROLLBACK_COMPLETE/u);
  assert.match(
    cleanupStep,
    /if \$priorStatus == "REVIEW_IN_PROGRESS"\s+then \(\.StackResourceSummaries \| length\) == 0\s+else \$priorStatus == "ROLLBACK_COMPLETE"\s+and all\(\s+\.StackResourceSummaries\[\];\s+\.ResourceStatus == "DELETE_COMPLETE"/u
  );
  assert.match(
    cleanupStep,
    /git fetch --no-tags --depth=1 origin "\$cleanup_source_commit"/u
  );
  assert.match(
    cleanupStep,
    /"\$\{cleanup_source_commit\}:aws\/edge-waf\.yaml"/u
  );
  assert.match(cleanupStep, /sha256sum "\$cleanup_source_template"/u);
  assert.match(cleanupStep, /sha256sum "\$cleanup_template"/u);
  assert.match(
    cleanupStep,
    /aws cloudformation delete-stack \\\r?\n\s+--stack-name "\$stack_id"/u
  );
  assert.match(cleanupStep, /grep -Fq "does not exist" "\$cleanup_error"/u);
  const cleanupReceiptOffset = cleanupStep.indexOf(
    'receipt_next="${RUNNER_TEMP:?}/edge-cleanup-receipt.json"'
  );
  assert.ok(cleanupReceiptOffset >= 0);
  const cleanupReceipt = cleanupStep.slice(cleanupReceiptOffset);
  assert.match(cleanupReceipt, /stackIdSha256: \$stackIdSha256/u);
  assert.match(
    cleanupReceipt,
    /clientRequestTokenSha256: \$cleanupTokenSha256/u
  );
  assert.match(cleanupReceipt, /sourceRepositoryCommitBound: true/u);
  assert.match(cleanupReceipt, /stackDeletedAndNotFound: true/u);
  assert.doesNotMatch(
    cleanupReceipt,
    /--arg stackId "\$stack_id"|AWS_ACCOUNT_ID|arn:aws:/u
  );
  assert.doesNotMatch(
    cleanupStep,
    /filter-log-events|get-log-events|start-query|set-alarm-state/u
  );

  assert.match(inspectStep, /if \[ "\$OPERATION" = "finalize" \] \|\|/u);
  assert.match(inspectStep, /EDGE_APPLY_MODE=finalize/u);
  assert.match(createPlanStep, /if: inputs\.operation == 'plan'/u);
  assert.match(
    loadPlanStep,
    /if: inputs\.operation == 'apply' && env\.EDGE_APPLY_MODE == 'execute'/u
  );
  assert.match(
    requirePlanStep,
    /if: inputs\.operation == 'plan' \|\| \(inputs\.operation == 'apply' && env\.EDGE_APPLY_MODE == 'execute'\)/u
  );
  assert.match(
    executePlanStep,
    /if: inputs\.operation == 'apply' && env\.EDGE_APPLY_MODE == 'execute'/u
  );
  assert.match(
    preProtectionProofStep,
    /if: inputs\.operation == 'apply' \|\| inputs\.operation == 'finalize'/u
  );
  assert.match(
    preProtectionProofStep,
    /\(\.StackResourceSummaries \| length\) == 9/u
  );
  assert.match(
    setProtectionStep,
    /if: inputs\.operation == 'apply' \|\| inputs\.operation == 'finalize'/u
  );
  assert.match(setProtectionStep, /set-stack-policy/u);
  assert.match(setProtectionStep, /update-termination-protection/u);
  assert.match(
    liveProofStep,
    /if: inputs\.operation == 'apply' \|\| inputs\.operation == 'verify' \|\| \(inputs\.operation == 'finalize' && env\.EDGE_CURRENT_SEMANTICS_MATCH == 'true'\)/u
  );
  assert.match(liveProofStep, /stackPolicyProtected: true/u);
  assert.match(liveProofStep, /terminationProtection: true/u);
  for (const readCommand of [
    "aws wafv2 get-web-acl",
    "aws wafv2 get-logging-configuration",
    "aws logs describe-log-groups",
    "aws logs describe-resource-policies",
    "aws events describe-rule",
    "aws events list-targets-by-rule",
    "aws cloudwatch describe-alarms",
  ]) {
    assert.ok(liveProofStep.includes(readCommand), readCommand);
  }
  assert.match(liveProofStep, /alarmDeliveryDrill: "not-run"/u);
  assert.match(
    liveProofStep,
    /humanPagingDestination: "not-configured-by-this-stack"/u
  );
  assert.doesNotMatch(
    `${setProtectionStep}\n${liveProofStep}`,
    /filter-log-events|get-log-events|start-query|set-alarm-state/u
  );
  assert.doesNotMatch(
    `${preProtectionProofStep}\n${setProtectionStep}\n${liveProofStep}`,
    /cloudformation (?:create|describe|execute)-change-set/u
  );

  const wa04 = contract.controls.find((control) => control.id === "WA-04");
  assert.ok(wa04);
  assert.equal(wa04.operations, "plan|apply|verify|cleanup|finalize");
  assert.deepEqual(wa04.typedConfirmations, {
    apply: "APPLY-{ENV}-EDGE-CONTROLS",
    cleanup: "CLEANUP-{ENV}-EDGE-CONTROLS",
    finalize: "FINALIZE-{ENV}-EDGE-CONTROLS",
  });
  assert.deepEqual(wa04.cleanupEligibleStates, [
    "REVIEW_IN_PROGRESS with zero stack resources",
    "ROLLBACK_COMPLETE with every listed stack resource DELETE_COMPLETE",
  ]);
  assert.equal(
    wa04.cleanupOldSourceValidation,
    "change-set source commit and template digest independently re-proved"
  );
  assert.equal(
    wa04.cleanupTerminalProof,
    "delete exact stack ID and prove stack name NotFound"
  );
  assert.equal(wa04.cleanupReceiptSanitized, true);
  assert.equal(wa04.finalizeCreatesChangeSet, false);
  assert.equal(wa04.finalizeExactLiveProof, true);
  assert.equal(wa04.restartSafeProtectionRepair, true);
  assert.equal(wa04.alarmDeliveryDrill, "not-run");
  assert.equal(wa04.humanPagingClaimed, false);

  assert.match(audit, /extractNamedWorkflowStep/u);
  assert.match(audit, /edgeCleanupLifecycleValid/u);
  assert.match(audit, /edgeFinalizeLifecycleValid/u);
  assert.equal(
    audit.includes(
      '/REVIEW_IN_PROGRESS\\)[\\s\\S]*?test "\\$OPERATION" = "apply"'
    ),
    false
  );
});

test("readiness: foundation Phase 0, failed-plan cleanup, and abort are source-bound", () => {
  const check = evaluate().checks.find(
    (candidate) =>
      candidate.id === "product.protected-foundation-and-edge-delivery"
  );
  assert.ok(check);
  assert.equal(check.status, "pass", check.detail);

  const workflow = readFileSync(
    new URL("../.github/workflows/foundation-migration.yml", import.meta.url),
    "utf8"
  );
  const authority = readFileSync(
    new URL("../aws/foundation-migration-authority.sh", import.meta.url),
    "utf8"
  );
  const runbook = readFileSync(
    new URL(
      "../docs/operations/FOUNDATION_STORAGE_MIGRATION.md",
      import.meta.url
    ),
    "utf8"
  );
  const audit = readFileSync(
    new URL(
      "../.github/scripts/well-architected-contract-audit.mjs",
      import.meta.url
    ),
    "utf8"
  );
  const phaseZero =
    runbook.match(
      /## Phase 0: create the one-time authority[\s\S]*?```bash\r?\n([\s\S]*?)\r?\n```/u
    )?.[1] ?? "";
  const authorizeStep = extractNamedWorkflowStep(
    workflow,
    "Fail closed unless the dispatch targets current green main"
  );
  const failedPlanCleanupStep = extractNamedWorkflowStep(
    workflow,
    "Delete an unverified foundation migration plan"
  );
  const abortJob = extractNamedWorkflowJob(workflow, "abort-authority");
  const abortStep = extractNamedWorkflowStep(
    abortJob,
    "Prove stable foundation, clean safe plans, and delete authority"
  );
  for (const source of [
    phaseZero,
    authorizeStep,
    failedPlanCleanupStep,
    abortJob,
    abortStep,
  ]) {
    assert.ok(source.length > 0);
  }

  assert.match(phaseZero, /test -z "\$\(git status --porcelain=v1\)"/u);
  assert.match(phaseZero, /SOURCE_COMMIT=\$\(git rev-parse HEAD\)/u);
  assert.match(
    phaseZero,
    /AUTHORITY_TEMPLATE_SHA256=\$\(\s*bash aws\/foundation-migration-authority\.sh render-template-sha256\s*\)/u
  );
  assert.match(
    phaseZero,
    /authority_template=\$\(\s*bash aws\/foundation-migration-authority\.sh render-template\s*\)/u
  );
  assert.match(phaseZero, /jq -Scj/u);
  for (const binding of [
    "ParameterKey=SourceCommit,ParameterValue=${SOURCE_COMMIT}",
    "ParameterKey=AuthorityTemplateSha256,ParameterValue=${AUTHORITY_TEMPLATE_SHA256}",
    "Key=SourceCommit,Value=${SOURCE_COMMIT}",
    "Key=AuthorityTemplateSha256,Value=${AUTHORITY_TEMPLATE_SHA256}",
    "--no-enable-termination-protection",
  ]) {
    assert.ok(phaseZero.includes(binding), binding);
  }
  assert.doesNotMatch(phaseZero, /--role-arn/u);
  assert.match(
    authority,
    /\(\$template\.Resources \| keys\) == \["FoundationMigrationRole"\]/u
  );
  assert.match(authority, /\.Stacks\[0\]\.EnableTerminationProtection == false/u);
  assert.match(authority, /\(\(\.Stacks\[0\]\.RoleARN \/\/ null\) == null\)/u);
  assert.match(authority, /cloudformation:ListChangeSets/u);
  assert.match(authority, /cloudformation:ListStackResources/u);
  assert.match(
    authority,
    /canonical_json_bytes\(\)[\s\S]*?jq -Scj -s[\s\S]*?length != 1[\s\S]*?type\) != "object"/u
  );
  assert.match(
    authority,
    /render-template-sha256\)\s*render_template \| canonical_json_sha256/u
  );
  assert.match(
    authority,
    /live_template_digest="\$\(\s*canonical_template_body_sha256 "\$live_template"/u
  );
  assert.match(
    authority,
    /--arg stackIdSha256 "\$\(\s*jq -ejr '\.Stacks\[0\]\.StackId' "\$live_stack" \|\s*sha256sum/u
  );
  assert.equal(
    (authority.match(/legacy_lf_template_body_sha256/gu) ?? []).length,
    2
  );
  assert.equal(
    (authority.match(/legacy_crlf_template_body_sha256/gu) ?? []).length,
    2
  );
  for (const field of [
    "recordedAuthorityTemplateSha256",
    "canonicalAuthorityTemplateSha256",
    "templateCanonicalization",
    "recordedTemplateTerminator",
    "legacyTemplateDigestAccepted",
  ]) {
    assert.ok(authority.includes(field), field);
  }
  assert.match(authority, /template-digest-binding/u);
  assert.doesNotMatch(authority, /aws cloudformation delete-stack/u);
  assert.match(
    runbook,
    /pre-binding contract cannot be[\s\S]*?administrator must delete it and[\s\S]*?recreate it from Phase 0/u
  );
  assert.match(
    runbook,
    /Repository[\s\S]*?source and CI never create this authority/u
  );

  assert.match(failedPlanCleanupStep, /always\(\)/u);
  for (const failedStep of ["create_plan", "load_plan", "exact_plan"]) {
    assert.ok(
      failedPlanCleanupStep.includes(
        `steps.${failedStep}.outcome == 'failure'`
      ),
      failedStep
    );
  }
  assert.match(failedPlanCleanupStep, /\.ExecutionStatus == "AVAILABLE"/u);
  assert.match(failedPlanCleanupStep, /aws cloudformation delete-change-set/u);
  assert.match(failedPlanCleanupStep, /test "\$absent" = "true"/u);
  assert.match(
    failedPlanCleanupStep,
    /test "\$after_projection_sha256" = "\$before_projection_sha256"/u
  );
  assert.match(
    failedPlanCleanupStep,
    /changeSetArnSha256: \$arnSha256/u
  );
  assert.doesNotMatch(failedPlanCleanupStep, /execute-change-set/u);

  assert.match(
    workflow,
    /options:\r?\n\s+- plan\r?\n\s+- apply\r?\n\s+- verify\r?\n\s+- abort\r?\n\s+- retire/u
  );
  assert.match(
    authorizeStep,
    /ABORT-FOUNDATION-MIGRATION-AND-RETIRE-AUTHORITY/u
  );
  assert.match(authorizeStep, /test "\$GITHUB_SHA" = "\$TARGET_SHA"/u);
  assert.match(
    authorizeStep,
    /test "\$\(git rev-parse origin\/main\)" = "\$TARGET_SHA"/u
  );
  assert.match(abortJob, /needs: authorize/u);
  assert.match(abortJob, /Configure exact one-time migration authority/u);
  assert.doesNotMatch(abortJob, /Configure permanent narrow foundation authority/u);
  assert.match(
    abortStep,
    /foundation-migration-authority\.sh verify-intrinsic/u
  );
  assert.match(
    abortStep,
    /authority_stack_id="\$\(jq -er '\.Stacks\[0\]\.StackId' "\$authority_stack"\)"[\s\S]*?printf '%s' "\$authority_stack_id" \|\s*sha256sum/u
  );
  assert.match(abortStep, /\.creationBindingVerified == true/u);
  assert.match(abortStep, /\.resourceCount == 1/u);
  for (const field of [
    "recordedAuthorityTemplateSha256",
    "canonicalAuthorityTemplateSha256",
    "templateCanonicalization",
    "recordedTemplateTerminator",
  ]) {
    assert.ok(abortStep.includes(field), field);
  }
  assert.match(
    abortStep,
    /recordedTemplateTerminator \| IN\("none", "lf", "crlf"\)/u
  );
  assert.match(
    abortStep,
    /jq -Scj -s[\s\S]*?expected exactly one historical JSON document/u
  );
  assert.match(abortStep, /matchesCanonicalLiveTemplate: true/u);
  assert.match(abortStep, /recordedDigestCompatibilityVerified: true/u);
  assert.doesNotMatch(abortStep, /matchesRecordedAndLiveTemplate/u);
  assert.match(abortStep, /destructive_actions_started=false/u);
  assert.match(
    abortStep,
    /destructiveActionsStarted: \$destructiveActionsStarted/u
  );
  assert.match(abortStep, /partialChangeSetCleanup:/u);
  assert.match(abortStep, /deletedCount: \(\$plans\[0\] \| length\)/u);
  assert.match(
    abortStep,
    /all\(\s*\(\.Summaries \/\/ \[\]\)\[\];\s*\(\.ChangeSetName \| startswith\("foundation-storage-"\)\)\s*and \.Status == "CREATE_COMPLETE"\s*and \(\.ExecutionStatus \| IN\("AVAILABLE", "OBSOLETE"\)\)\s*and \(\(\.ImportExistingResources \/\/ false\) == false\)/u
  );
  assert.match(
    abortStep,
    /contents\/aws\/bootstrap-oidc\.yaml\?ref=\$\{plan_source\}/u
  );
  assert.match(abortStep, /aws cloudformation delete-change-set/u);
  for (const digest of [
    "target_projection_sha256",
    "target_policy_sha256",
    "target_resources_sha256",
  ]) {
    assert.ok(abortStep.includes(`)" = "$${digest}"`), digest);
  }
  assert.match(
    abortStep,
    /\)" = \\\r?\n\s+"\$target_template_sha256"/u
  );
  assert.match(
    abortStep,
    /aws cloudformation delete-stack \\\r?\n\s+--stack-name "\$authority_stack_id"/u
  );
  assert.equal(
    (abortStep.match(/aws cloudformation delete-stack/gu) ?? []).length,
    1
  );
  assert.match(abortStep, /grep -Fq "NoSuchEntity" "\$role_error"/u);
  assert.doesNotMatch(
    abortStep,
    /cloudformation (?:create|execute)-change-set|cloudformation set-stack-policy|cloudformation update-stack/u
  );
  const abortReceiptOffset = abortStep.lastIndexOf("          phase=receipt");
  assert.ok(abortReceiptOffset >= 0);
  const abortReceipt = abortStep.slice(abortReceiptOffset);
  assert.match(abortReceipt, /remainingCount: 0/u);
  assert.match(abortReceipt, /stackDeleted: true/u);
  assert.match(abortReceipt, /roleDeleted: true/u);
  assert.match(abortReceipt, /destructiveActionsStarted: true/u);
  assert.doesNotMatch(abortReceipt, /AWS_ACCOUNT_ID|arn:aws:/u);

  assert.match(audit, /foundation-migration-lifecycle-source/u);
  assert.match(audit, /foundationPhaseZeroContractValid/u);
  assert.match(audit, /foundationSameRunCleanupValid/u);
  assert.match(audit, /foundationAbortContractValid/u);
});

test("readiness: centralized S3 access logging is a first-class product gate", () => {
  const check = evaluate().checks.find(
    (candidate) =>
      candidate.id === "product.s3-access-logging-foundation"
  );
  assert.ok(check);
  assert.equal(check.criterion, "Production Readiness");
  assert.equal(check.status, "pass", check.detail);
});

test("readiness: protected encrypted alarm routing control loop is a first-class product gate", () => {
  const check = evaluate().checks.find(
    (candidate) =>
      candidate.id ===
      "product.protected-encrypted-alarm-routing-control-loop"
  );
  assert.ok(check);
  assert.equal(check.criterion, "Production Readiness");
  assert.equal(check.status, "pass", check.detail);
  const audit = readFileSync(
    new URL(
      "../.github/scripts/well-architected-contract-audit.mjs",
      import.meta.url
    ),
    "utf8"
  );
  assert.match(audit, /wa02-alarm-routing-control-loop-source/u);
});

test("readiness: judge-facing concurrency has bounded in-flight headroom", () => {
  const check = evaluate().checks.find(
    (candidate) =>
      candidate.id === "product.demo-concurrency-headroom"
  );
  assert.ok(check);
  assert.equal(check.criterion, "Production Readiness");
  assert.equal(check.status, "pass", check.detail);
});

test("readiness: candidate DAST blocks CI and live DAST is exact-release bound", () => {
  const check = evaluate().checks.find(
    (candidate) =>
      candidate.id === "product.hosted-dast-release-gate"
  );
  assert.ok(check);
  assert.equal(check.criterion, "Production Readiness");
  assert.equal(check.status, "pass", check.detail);

  const ci = readFileSync(
    new URL("../.github/workflows/ci.yml", import.meta.url),
    "utf8"
  );
  const hostedDast = readFileSync(
    new URL("../.github/workflows/security-dast.yml", import.meta.url),
    "utf8"
  );
  const deploy = readFileSync(
    new URL("../.github/workflows/deploy-aws.yml", import.meta.url),
    "utf8"
  );
  const packageSource = readFileSync(
    new URL("../package.json", import.meta.url),
    "utf8"
  );
  const predeployZapServer = readFileSync(
    new URL("../scripts/predeploy-zap-server.mjs", import.meta.url),
    "utf8"
  );
  const hostedDastScript = readFileSync(
    new URL("../scripts/hosted-dast.mjs", import.meta.url),
    "utf8"
  );
  assert.match(
    ci,
    /needs:\s*\[secret-scan,\s*dep-audit,\s*build-test,\s*cluster-survival,\s*pen-test,\s*load,\s*frontend-iac,\s*hosted-dast,\s*video-gate\]/u
  );
  assert.match(hostedDast, /workflow_call:/u);
  assert.doesNotMatch(hostedDast, /workflow_run:/u);
  assert.match(
    hostedDast,
    /DAST_EXPECTED_RELEASE_SHA:\s*\$\{\{\s*needs\.source-gate\.outputs\.expected_release_sha\s*\}\}/u
  );
  assert.match(
    hostedDast,
    /name:\s*Require successful operation-bound Deploy AWS source/u
  );
  assert.match(
    hostedDast,
    /\[\[ "\$REQUESTED_RUN_ID" =~ \^\[1-9\]\[0-9\]\*\$ \]\]/u
  );
  assert.match(
    hostedDast,
    /\[\[ "\$REQUESTED_RUN_ATTEMPT" =~ \^\[1-9\]\[0-9\]\*\$ \]\]/u
  );
  assert.match(
    hostedDast,
    /\[\[ "\$REQUESTED_SHA" =~ \^\[0-9a-f\]\{40\}\$ \]\]/u
  );
  assert.match(
    hostedDast,
    /actions\/runs\/\$\{REQUESTED_RUN_ID\}\/attempts\/\$\{REQUESTED_RUN_ATTEMPT\}\/jobs\?per_page=100/u
  );
  assert.match(
    hostedDast,
    /exact_job\("Promote identical candidate to production"\)/u
  );
  assert.match(
    hostedDast,
    /"Smoke production through CloudFront"/u
  );
  assert.match(hostedDast, /"Upload production receipt"/u);
  assert.match(
    deploy,
    /hosted-dast-production:[\s\S]*?needs:\s*\r?\n\s+- deploy-production\r?\n\s+- managed-mcp-production-audit[\s\S]*?uses:\s*\.\/\.github\/workflows\/security-dast\.yml[\s\S]*?exact_sha:\s*\$\{\{\s*github\.sha\s*\}\}[\s\S]*?deploy_run_id:\s*\$\{\{\s*fromJSON\(github\.run_id\)\s*\}\}[\s\S]*?deploy_run_attempt:\s*\$\{\{\s*fromJSON\(github\.run_attempt\)\s*\}\}/u
  );
  assert.match(
    hostedDastScript,
    /function allowlistedStatus\(actual, expectedStatuses, id\)/u
  );
  assert.match(
    hostedDastScript,
    /releaseSha:\s*expectedReleaseSha \|\| "unknown"/u
  );
  assert.match(
    readFileSync(
      new URL("../tests/hosted-dast.test.ts", import.meta.url),
      "utf8"
    ),
    /rejects base64url-encoded JSON secret fields/u
  );
  assert.equal(
    (hostedDast.match(/needs:\s*source-gate/gu) ?? []).length,
    2
  );
  assert.match(
    hostedDast,
    /name:\s*hosted-dast-\$\{\{\s*env\.DAST_CHECKOUT_SHA\s*\}\}-\$\{\{\s*needs\.source-gate\.outputs\.artifact_run_id\s*\}\}-\$\{\{\s*needs\.source-gate\.outputs\.artifact_run_attempt\s*\}\}/u
  );
  assert.match(ci, /rules_file_name:\s*\.zap\/predeploy\.tsv/u);
  assert.match(hostedDast, /rules_file_name:\s*\.zap\/release\.tsv/u);
  assert.match(
    ci,
    /name:\s*dast-contract-ci-\$\{\{\s*github\.sha\s*\}\}-\$\{\{\s*github\.run_attempt\s*\}\}/u
  );
  assert.match(ci, /DAST_CANDIDATE_URL:\s*http:\/\/127\.0\.0\.1:4173/u);
  assert.match(
    ci,
    /node --import tsx --test --test-concurrency=1[\s\S]*?tests\/hosted-dast\.test\.ts \| tee "\$DAST_CONTRACT_TAP"/u
  );
  assert.match(ci, /npm run build --prefix web/u);
  assert.match(ci, /node scripts\/predeploy-zap-server\.mjs/u);
  assert.match(predeployZapServer, /const LOOPBACK_HOST = "127\.0\.0\.1"/u);
  assert.match(predeployZapServer, /server\.listen\(port, LOOPBACK_HOST/u);
  assert.match(packageSource, /tests\/predeploy-zap-server\.test\.ts/u);
  assert.match(
    ci,
    /target:\s*\$\{\{\s*env\.DAST_CANDIDATE_URL\s*\}\}/u
  );
  assert.match(ci, /test "\$alive" = "true"/u);
  assert.match(ci, /test "\$healthy" = "true"/u);
  assert.match(ci, /test "\$candidate_identity" = "true"/u);
  assert.match(ci, /test "\$shutdown_clean" = "true"/u);
  assert.match(ci, /test "\$forced_cleanup" = "false"/u);
  assert.match(ci, /test "\$process_absent" = "true"/u);
  assert.match(ci, /trap cleanup_candidate_metadata EXIT/u);
  assert.match(
    ci,
    /forced_cmdline[\s\S]*?\/proc\/\$server_pid\/cmdline[\s\S]*?kill -KILL "\$server_pid"/u
  );
  assert.doesNotMatch(ci, /wait "\$server_pid"/u);
  assert.doesNotMatch(
    ci.match(/(?:^|\r?\n)  hosted-dast:\r?\n[\s\S]*?(?=\r?\n  video-gate:\r?\n|$)/u)?.[0] ?? "",
    /d2s5v0o0eg2aaw\.cloudfront\.net|DAST_EXPECTED_RELEASE_SHA/u
  );
  assert.match(
    ci,
    /artifact_name:\s*zap-baseline-ci-\$\{\{\s*github\.sha\s*\}\}-\$\{\{\s*github\.run_attempt\s*\}\}/u
  );
  assert.match(
    hostedDast,
    /artifact_name:\s*zap-baseline-\$\{\{\s*env\.DAST_CHECKOUT_SHA\s*\}\}-\$\{\{\s*needs\.source-gate\.outputs\.artifact_run_attempt\s*\}\}/u
  );
  assert.match(
    readFileSync(
      new URL("../aws/template.yaml", import.meta.url),
      "utf8"
    ),
    /ApiFallback:[\s\S]*?Path:\s*\/api\/\{proxy\+\}[\s\S]*?Method:\s*ANY/u
  );
  const predeployRules = readFileSync(
    new URL("../.zap/predeploy.tsv", import.meta.url),
    "utf8"
  );
  const releaseRules = readFileSync(
    new URL("../.zap/release.tsv", import.meta.url),
    "utf8"
  );
  assert.equal(
    hasExactZapIgnorePolicy(predeployRules, [
      "10015",
      "10036",
      "10049",
      "10050",
      "10094",
      "10109",
      "90005",
    ]),
    true
  );
  assert.equal(
    hasExactZapIgnorePolicy(releaseRules, [
      "10015",
      "10036",
      "10049",
      "10050",
      "10094",
      "10109",
      "90005",
    ]),
    true
  );
  for (const mutation of [
    releaseRules.replace("10015", "*"),
    releaseRules.replace("\tIGNORE\t", "\tWARN\t"),
    `${releaseRules}10055\tIGNORE\t(Release policy regression)\n`,
    releaseRules.replace("10036", "10015"),
    releaseRules.replace(/\t\([^)]+\)/u, "\t(short)"),
  ]) {
    assert.equal(
      hasExactZapIgnorePolicy(mutation, [
        "10015",
        "10036",
        "10049",
        "10050",
        "10094",
        "10109",
        "90005",
      ]),
      false
    );
  }
});

test("readiness: Deploy AWS cannot succeed as an all-skipped no-op", () => {
  const check = evaluate().checks.find(
    (candidate) =>
      candidate.id === "product.oidc-promotion-rollback"
  );
  assert.ok(check);
  assert.equal(check.criterion, "Production Readiness");
  assert.equal(check.status, "pass", check.detail);

  const deploy = readFileSync(
    new URL("../.github/workflows/deploy-aws.yml", import.meta.url),
    "utf8"
  );
  assert.match(deploy, /name:\s*Validate Deploy AWS source CI/u);
  assert.match(
    deploy,
    /name:\s*Require successful exact-main push CI source/u
  );
  assert.match(deploy, /case "\$GITHUB_EVENT_NAME" in/u);
  assert.match(
    deploy,
    /push\)[\s\S]*?test "\$DEPLOY_OPERATION" = "release"[\s\S]*?workflow_dispatch\)[\s\S]*?test "\$DEPLOY_OPERATION" = "staging-recovery-drill"/u
  );
  assert.match(deploy, /test "\$GITHUB_REF" = "refs\/heads\/main"/u);
  assert.match(
    deploy,
    /actions\/workflows\/ci\.yml\/runs\?branch=main&event=push/u
  );
  assert.match(
    deploy,
    /ci_run_id:\s*\$\{\{\s*steps\.source_ci\.outputs\.run_id\s*\}\}/u
  );
  assert.doesNotMatch(deploy, /github\.event\.workflow_run/u);
  assert.match(
    deploy,
    /build-once:\r?\n\s+name:\s*Verify CI SHA and build once\r?\n\s+needs:\r?\n\s+- source-gate/u
  );
  const buildOnce =
    deploy.match(
      /(?:^|\r?\n)  build-once:\r?\n[\s\S]*?(?=\r?\n  [A-Za-z0-9_-]+:\r?\n|$)/u
    )?.[0] ?? "";
  assert.doesNotMatch(buildOnce, /^    if:/mu);
});

test("readiness: coverage evidence is CI-only and thresholded", () => {
  const check = evaluate().checks.find(
    (candidate) =>
      candidate.id === "tech.pipeline-coverage-evidence"
  );
  assert.ok(check);
  assert.equal(check.criterion, "Technical Implementation");
  assert.equal(check.status, "pass", check.detail);

  const ci = readFileSync(
    new URL("../.github/workflows/ci.yml", import.meta.url),
    "utf8"
  );
  const runner = readFileSync(
    new URL("../scripts/run-backend-coverage.mjs", import.meta.url),
    "utf8"
  );
  const frontend = readFileSync(
    new URL("../web/vite.config.ts", import.meta.url),
    "utf8"
  );
  const packageSource = readFileSync(
    new URL("../package.json", import.meta.url),
    "utf8"
  );
  assert.match(runner, /if \(!runnerTemp\)/u);
  assert.match(
    runner,
    /const canonicalTestCommand = packageJson\?\.scripts\?\.test/u
  );
  assert.match(runner, /\.\.\.testFiles/u);
  for (const testPath of [
    "tests/durable-recovery.test.ts",
    "tests/staging-recovery-drill.test.ts",
    "tests/recovery-watchdog.test.ts",
    "tests/github-recovery-preflight.test.ts",
    "tests/cloudformation-controls.test.ts",
  ]) {
    assert.equal(packageSource.split(testPath).length - 1, 1, testPath);
  }
  assert.doesNotMatch(ci, /path:\s*(?:web\/)?coverage\//u);
  assert.match(
    ci,
    /\$\{\{\s*runner\.temp\s*\}\}\/archon-coverage\/backend\/lcov\.info/u
  );
  assert.match(frontend, /process\.env\.RUNNER_TEMP \?\? tmpdir\(\)/u);
});

test("readiness: durable S3 CAS recovery is armed before mutation and closed by receipts", () => {
  const reportCheck = evaluate().checks.find(
    (candidate) =>
      candidate.id === "product.durable-out-of-band-recovery"
  );
  assert.ok(reportCheck);
  assert.equal(reportCheck.criterion, "Production Readiness");
  assert.equal(reportCheck.status, "pass", reportCheck.detail);

  const deploy = readFileSync(
    new URL("../.github/workflows/deploy-aws.yml", import.meta.url),
    "utf8"
  );
  const recovery = readFileSync(
    new URL("../.github/workflows/recover-aws.yml", import.meta.url),
    "utf8"
  );
  const foundationWorkflow = readFileSync(
    new URL("../.github/workflows/bootstrap-aws.yml", import.meta.url),
    "utf8"
  );
  const ci = readFileSync(
    new URL("../.github/workflows/ci.yml", import.meta.url),
    "utf8"
  );
  const ledger = readFileSync(
    new URL("../aws/recovery-intent-ledger.sh", import.meta.url),
    "utf8"
  );
  const githubPreflight = readFileSync(
    new URL(
      "../aws/classify-github-recovery-preflight.sh",
      import.meta.url
    ),
    "utf8"
  );
  const classifier = readFileSync(
    new URL("../aws/classify-durable-recovery-source.sh", import.meta.url),
    "utf8"
  );
  const cloudFormationControls = readFileSync(
    new URL("../aws/enforce-cloudformation-controls.sh", import.meta.url),
    "utf8"
  );
  const cloudFormationControlsTests = readFileSync(
    new URL("../tests/cloudformation-controls.test.ts", import.meta.url),
    "utf8"
  );
  const bootstrap = readFileSync(
    new URL("../aws/bootstrap-oidc.yaml", import.meta.url),
    "utf8"
  );
  const template = readFileSync(
    new URL("../aws/template.yaml", import.meta.url),
    "utf8"
  );
  const scriptSources = DURABLE_RECOVERY_SCRIPT_PATHS.map((scriptPath) =>
    readFileSync(new URL(`../${scriptPath}`, import.meta.url), "utf8")
  );

  assert.equal(hasExactAwsRecoveryTrigger(recovery), true);
  assert.doesNotMatch(recovery, /workflow_run:/u);
  assert.match(
    classifier,
    /\.event == "push"[\s\S]*?\.event == "workflow_dispatch" and \$environment == "staging"/u
  );
  assert.equal(hasExactAwsDeliveryConcurrency(foundationWorkflow), true);
  assert.equal(hasExactAwsDeliveryConcurrency(deploy), true);
  assert.equal(hasExactAwsDeliveryConcurrency(recovery), false);
  assert.match(
    recovery,
    /(?:^|\r?\n)concurrency:\r?\n  group: aws-recovery-watchdog\r?\n  cancel-in-progress: false\r?\n  queue: max/u
  );
  assert.equal(
    (
      recovery.match(
        /^    concurrency:\r?\n      group: aws-production-delivery\r?\n      cancel-in-progress: false\r?\n      queue: max$/gmu
      ) ?? []
    ).length,
    2
  );
  const preflightJob =
    recovery.match(
      /(?:^|\r?\n)  classify-recovery:\r?\n[\s\S]*?(?=\r?\n  audit-environments:)/u
    )?.[0] ?? "";
  const auditJob =
    recovery.match(
      /(?:^|\r?\n)  audit-environments:\r?\n[\s\S]*?(?=\r?\n  recover-staging:)/u
    )?.[0] ?? "";
  assert.ok(preflightJob.length > 0);
  assert.match(
    preflightJob,
    /name: Classify recovery candidates without AWS access/u
  );
  assert.match(
    preflightJob,
    /bash aws\/classify-github-recovery-preflight\.sh/u
  );
  assert.match(
    preflightJob,
    /classificationSource == "github-actions-metadata-only"/u
  );
  assert.match(preflightJob, /awsCredentialsUsed == false/u);
  assert.doesNotMatch(preflightJob, /^    environment:/mu);
  assert.doesNotMatch(
    preflightJob,
    /configure-aws-credentials|id-token:\s*write/u
  );
  assert.doesNotMatch(
    githubPreflight,
    /\baws\s+(?:cloudformation|s3|s3api|sts)\b/u
  );
  assert.match(githubPreflight, /source-deploy-active/u);
  assert.match(githubPreflight, /terminal-commit-proved/u);
  assert.match(githubPreflight, /successful-recovery-receipt-proved/u);
  assert.match(githubPreflight, /die "Recovery artifact history exceeded/u);
  assert.ok(auditJob.length > 0);
  assert.equal(
    (
      auditJob.match(
        /bash aws\/enforce-cloudformation-controls\.sh audit/gu
      ) ?? []
    ).length,
    1
  );
  assert.match(
    auditJob,
    /strategy:\r?\n\s+fail-fast: false\r?\n\s+matrix:\r?\n\s+include:\r?\n\s+- environment: staging\r?\n\s+stack_name: archon-memory-staging\r?\n\s+terminal_job_name: Deploy and smoke staging\r?\n\s+- environment: production\r?\n\s+stack_name: archon-memory-production\r?\n\s+terminal_job_name: Promote identical candidate to production/u
  );
  assert.match(
    auditJob,
    /needs\.classify-recovery\.outputs\.staging_action == 'noop'/u
  );
  assert.match(
    auditJob,
    /needs\.classify-recovery\.outputs\.production_action == 'noop'/u
  );
  assert.doesNotMatch(auditJob, /aws-production-delivery/u);
  assert.match(deploy, /name: Deploy and smoke staging/u);
  assert.match(
    deploy,
    /name: Promote identical candidate to production/u
  );
  assert.match(
    recovery,
    /TERMINAL_JOB_NAME: Deploy and smoke staging/u
  );
  assert.match(
    recovery,
    /TERMINAL_JOB_NAME: Promote identical candidate to production/u
  );
  assert.equal(
    (recovery.match(/timeout-minutes:\s+65/gu) ?? []).length,
    2
  );
  assert.equal(
    (recovery.match(/role-duration-seconds:\s+3600/gu) ?? []).length,
    7
  );
  assert.match(ledger, /--argjson leaseUntil "\$\(\(now \+ 7200\)\)"/u);
  assert.equal(
    (
      recovery.match(
        /uses: actions\/checkout@[0-9a-f]{40}[^\r\n]*\r?\n        with:\r?\n          ref: \$\{\{ github\.sha \}\}\r?\n          fetch-depth: 0/gu
      ) ?? []
    ).length,
    4
  );
  assert.equal(
    (
      recovery.match(
        /github\.repository == 'upgradedev\/archon-cockroach-memory' &&\r?\n\s+github\.ref == 'refs\/heads\/main'/gu
      ) ?? []
    ).length,
    3
  );
  assert.equal(
    (
      recovery.match(
        /test "\$GITHUB_REF" = "refs\/heads\/main"/gu
      ) ?? []
    ).length,
    4
  );
  assert.equal(
    (
      recovery.match(
        /test "\$GITHUB_REF_TYPE" = "branch"/gu
      ) ?? []
    ).length,
    4
  );
  assert.equal(
    (
      recovery.match(
        /test "\$GITHUB_WORKFLOW_REF" = \\\r?\n\s+"upgradedev\/archon-cockroach-memory\/\.github\/workflows\/recover-aws\.yml@refs\/heads\/main"/gu
      ) ?? []
    ).length,
    4
  );
  assert.equal(
    (
      recovery.match(
        /test "\$\(git rev-parse HEAD\)" = "\$GITHUB_SHA"/gu
      ) ?? []
    ).length,
    4
  );
  assert.equal(
    (
      recovery.match(
        /git fetch --no-tags origin \\\r?\n\s+\+refs\/heads\/main:refs\/remotes\/origin\/main/gu
      ) ?? []
    ).length,
    4
  );
  assert.equal(
    (
      recovery.match(
        /test "\$\(git rev-parse origin\/main\)" = "\$GITHUB_SHA"/gu
      ) ?? []
    ).length,
    4
  );
  assert.match(
    recovery,
    /recover-staging:[\s\S]*?needs:\r?\n\s+- classify-recovery\r?\n\s+if: >-\r?\n\s+needs\.classify-recovery\.result == 'success' &&\r?\n\s+needs\.classify-recovery\.outputs\.staging_action == 'recover' &&\r?\n\s+github\.repository == 'upgradedev\/archon-cockroach-memory' &&\r?\n\s+github\.ref == 'refs\/heads\/main'\r?\n\s+runs-on:/u
  );
  assert.match(
    recovery,
    /recover-production:[\s\S]*?needs:\r?\n\s+- classify-recovery\r?\n\s+- recover-staging\r?\n\s+if: >-\r?\n\s+always\(\) &&\r?\n\s+needs\.classify-recovery\.result == 'success' &&\r?\n\s+needs\.classify-recovery\.outputs\.production_action == 'recover' &&\r?\n\s+github\.repository == 'upgradedev\/archon-cockroach-memory' &&\r?\n\s+github\.ref == 'refs\/heads\/main'\r?\n\s+runs-on:/u
  );
  assert.doesNotMatch(recovery, /needs\.recover-staging\.result/u);
  assert.doesNotMatch(recovery, /github\.event\.workflow_run\.head_sha/u);

  assert.match(
    bootstrap,
    /GitHubRepositoryId:\r?\n\s+Type: String\r?\n\s+Default: "1285750381"\r?\n\s+AllowedPattern: "\^\[0-9\]\{1,20\}\$"/u
  );
  assert.match(
    bootstrap,
    /GitHubRepositoryOwnerId:\r?\n\s+Type: String\r?\n\s+Default: "25751981"\r?\n\s+AllowedPattern: "\^\[0-9\]\{1,20\}\$"/u
  );
  const environmentTrustBlocks = [
    {
      environment: "staging",
      source:
        bootstrap.match(
          /(?:^|\r?\n)  StagingDeployRole:\r?\n[\s\S]*?\r?\n      Policies:/u
        )?.[0] ?? "",
    },
    {
      environment: "production",
      source:
        bootstrap.match(
          /(?:^|\r?\n)  ProductionDeployRole:\r?\n[\s\S]*?\r?\n      Policies:/u
        )?.[0] ?? "",
    },
  ];
  for (const { environment, source } of environmentTrustBlocks) {
    assert.ok(source.length > 0, environment);
    assert.equal(
      (source.match(/token\.actions\.githubusercontent\.com:/gu) ?? [])
        .length,
      8
    );
    assert.match(
      source,
      /token\.actions\.githubusercontent\.com:sub: !Sub >-/u
    );
    assert.ok(
      source.includes(
        `repo:\${GitHubOrganization}/\${GitHubRepository}:environment:${environment}`
      )
    );
    assert.match(
      source,
      /token\.actions\.githubusercontent\.com:repository: !Sub >-/u
    );
    assert.match(
      source,
      /token\.actions\.githubusercontent\.com:repository_id: !Ref GitHubRepositoryId/u
    );
    assert.match(
      source,
      /token\.actions\.githubusercontent\.com:repository_owner_id: !Ref GitHubRepositoryOwnerId/u
    );
    assert.match(
      source,
      /token\.actions\.githubusercontent\.com:ref: refs\/heads\/main/u
    );
    assert.ok(
      source.includes(
        `token.actions.githubusercontent.com:environment: ${environment}`
      )
    );
    assert.match(
      source,
      /token\.actions\.githubusercontent\.com:workflow:\r?\n\s+- Deploy AWS\r?\n\s+- Recover AWS\r?\n      Policies:$/u
    );
    assert.doesNotMatch(
      source,
      /token\.actions\.githubusercontent\.com:(?:workflow_ref|job_workflow_ref):/u
    );
  }

  const armPositions = [
    ...deploy.matchAll(
      /name: Persist and arm the immutable (?:staging|production) recovery intent/gu
    ),
  ].map((match) => match.index ?? -1);
  const samPositions = [
    ...deploy.matchAll(
      /name: Deploy (?:staging|production) with recovery-safe SAM canary/gu
    ),
  ].map((match) => match.index ?? -1);
  assert.equal(armPositions.length, 2);
  assert.equal(samPositions.length, 2);
  for (const [index, armPosition] of armPositions.entries()) {
    assert.ok(armPosition < samPositions[index]);
    assert.equal(
      (
        deploy
          .slice(armPosition, samPositions[index])
          .match(/\.state == "ARMED"/gu) ?? []
      ).length,
      1
    );
  }
  const samCredentialRefreshPositions = [
    ...deploy.matchAll(
      /name: Refresh short-lived AWS credentials for (?:staging|production) SAM deployment/gu
    ),
  ].map((match) => match.index ?? -1);
  const edgeStackHandoffPositions = [
    ...deploy.matchAll(
      /name: Resolve the exact (?:staging|production) edge-stack handoff/gu
    ),
  ].map((match) => match.index ?? -1);
  assert.equal(samCredentialRefreshPositions.length, 2);
  assert.equal(edgeStackHandoffPositions.length, 2);
  for (const [index, refreshPosition] of samCredentialRefreshPositions.entries()) {
    const handoffPosition = edgeStackHandoffPositions[index];
    assert.ok(refreshPosition < handoffPosition);
    assert.ok(handoffPosition < samPositions[index]);
    assert.equal(
      (
        deploy
          .slice(refreshPosition, handoffPosition)
          .match(/\r?\n      - name:/gu) ?? []
      ).length,
      0
    );
    assert.equal(
      (
        deploy
          .slice(handoffPosition, samPositions[index])
          .match(/\r?\n      - name:/gu) ?? []
      ).length,
      0
    );
  }
  const reconciliationPositions = [
    ...deploy.matchAll(
      /name: Reconcile an interrupted same-run (?:staging|production) greenfield recovery/gu
    ),
  ].map((match) => match.index ?? -1);
  const postReconciliationRefreshPositions = [
    ...deploy.matchAll(
      /name: Refresh short-lived AWS credentials after (?:staging|production) reconciliation/gu
    ),
  ].map((match) => match.index ?? -1);
  assert.equal(reconciliationPositions.length, 2);
  assert.equal(postReconciliationRefreshPositions.length, 2);
  for (const [
    index,
    refreshPosition,
  ] of postReconciliationRefreshPositions.entries()) {
    assert.ok(reconciliationPositions[index] < refreshPosition);
    assert.ok(refreshPosition < samPositions[index]);
  }
  assert.equal(
    (deploy.match(/role-duration-seconds:\s+3600/gu) ?? []).length,
    12
  );
  assert.equal(
    (deploy.match(/bash aws\/recovery-intent-ledger\.sh arm/gu) ?? [])
      .length,
    2
  );
  assert.equal(
    (
      deploy.match(
        /EXPECTED_HAD_PREVIOUS_INDEX: \$\{\{ steps\.durable_recovery\.outputs\.had_previous_index \}\}/gu
      ) ?? []
    ).length,
    2
  );
  assert.equal(
    (
      deploy.match(
        /Unable to re-prove the durable frontend baseline\./gu
      ) ?? []
    ).length,
    2
  );
  assert.equal(
    (deploy.match(/bash aws\/recovery-intent-ledger\.sh commit/gu) ?? [])
      .length,
    2
  );
  assert.equal(
    (deploy.match(/\.state == "COMMITTED"/gu) ?? []).length,
    4
  );
  assert.equal(
    (
      recovery.match(
        /bash aws\/finalize-durable-recovery-receipt\.sh/gu
      ) ?? []
    ).length,
    2
  );
  assert.equal(
    (
      recovery.match(
        /length == 1 and \(\.\[0\] \| type == "object"\)/gu
      ) ?? []
    ).length,
    17
  );
  assert.equal(
    (
      recovery.match(
        /bash aws\/classify-durable-recovery-source\.sh >"\$classification"\r?\n\s+jq -e -s/gu
      ) ?? []
    ).length,
    3
  );
  assert.equal(
    (
      recovery.match(
        /PREFLIGHT_CANDIDATE_SHA: \$\{\{ needs\.classify-recovery\.outputs\.(?:staging|production)_candidate_sha \}\}/gu
      ) ?? []
    ).length,
    2
  );
  assert.equal(
    (
      recovery.match(
        /and \.action == "recover"\r?\n\s+and \.candidateSha == \$candidate\r?\n\s+and \.sourceRunAttempt == \$sourceRunAttempt\r?\n\s+and \.sourceRunId == \$sourceRunId/gu
      ) ?? []
    ).length,
    2
  );
  assert.equal(
    (
      recovery.match(
        /bash aws\/recovery-intent-ledger\.sh claim \\\r?\n\s+>"\$\{RUNNER_TEMP:\?\}\/(?:staging|production)-recovery-claim\.json"\r?\n\s+jq -e -s/gu
      ) ?? []
    ).length,
    2
  );
  assert.equal(
    (
      recovery.match(
        /bash aws\/download-durable-recovery-bundle\.sh "\$bundle_dir" \\\r?\n\s+>"\$\{RUNNER_TEMP:\?\}\/(?:staging|production)-recovery-download\.json"\r?\n\s+jq -e -s/gu
      ) ?? []
    ).length,
    2
  );
  assert.equal(
    (
      recovery.match(
        /\$\{\{ runner\.temp \}\}\/(?:staging|production)-recovery-(?:execution|finalization)\.json/gu
      ) ?? []
    ).length,
    4
  );
  assert.equal(
    (
      recovery.match(
        /bash aws\/enforce-cloudformation-controls\.sh audit/gu
      ) ?? []
    ).length,
    1
  );
  assert.equal(
    (
      recovery.match(
        /name: Upload exact protection and drift audit/gu
      ) ?? []
    ).length,
    1
  );
  assert.equal(
    (
      recovery.match(
        /github\.event_name == 'schedule' &&\r?\n\s+github\.event\.schedule == '17 4 \* \* \*'/gu
      ) ?? []
    ).length,
    1
  );
  assert.equal(
    (
      recovery.match(
        /github\.event_name == 'workflow_dispatch' &&\r?\n\s+inputs\.operation == 'audit'/gu
      ) ?? []
    ).length,
    1
  );
  assert.equal(
    (
      recovery.match(
        /path: \$\{\{ runner\.temp \}\}\/\$\{\{ matrix\.environment \}\}-cloudformation-controls-audit\.json/gu
      ) ?? []
    ).length,
    1
  );
  assert.equal(
    (
      recovery.match(
        /bash aws\/enforce-cloudformation-controls\.sh recover/gu
      ) ?? []
    ).length,
    4
  );
  assert.equal(
    (recovery.match(/\.state == "RECOVERED"/gu) ?? []).length,
    2
  );
  assert.equal(
    (
      cloudFormationControls.match(/require_single_json_object/gu) ?? []
    ).length,
    6
  );
  assert.match(
    cloudFormationControls,
    /require_single_json_object\(\) \{[\s\S]*?jq -s -e \\\r?\n\s+'length == 1 and \(\.\[0\] \| type == "object"\)'/u
  );
  assert.match(
    cloudFormationControlsTests,
    /every live CloudFormation boundary rejects duplicate valid JSON documents/u
  );

  for (const environment of ["staging", "production"]) {
    const refreshPosition = recovery.indexOf(
      `name: Refresh credentials for the full ${environment} recovery cycle`
    );
    const executorPosition = recovery.indexOf(
      `name: Restore and prove the exact ${environment} prestate`
    );
    assert.ok(refreshPosition >= 0);
    assert.ok(refreshPosition < executorPosition);
    assert.equal(
      (
        recovery
          .slice(refreshPosition, executorPosition)
          .match(/\r?\n      - name:/gu) ?? []
      ).length,
      0
    );

    const terminalBlock =
      recovery.match(
        new RegExp(
          String.raw`- name: Restore and prove the exact ${environment} prestate[\s\S]*?(?=\r?\n      - name: Upload supplemental ${environment} recovery receipt)`,
          "u"
        )
      )?.[0] ?? "";
    const executionInputs = terminalBlock.indexOf(
      'for output in "$receipt" "$execution"; do'
    );
    const executionGate = terminalBlock.indexOf(
      "jq -e -s",
      executionInputs
    );
    const controlStep = terminalBlock.indexOf(
      `name: Enforce exact ${environment} post-recovery stack controls`
    );
    const controlGate = terminalBlock.indexOf("jq -e -s", controlStep);
    const finalizerStep = terminalBlock.indexOf(
      `name: Persist receipt and mark ${environment} recovered atomically`
    );
    const finalizerInputs = terminalBlock.indexOf(
      'for input in "$receipt" "$execution" "$controls"; do',
      finalizerStep
    );
    const finalizerInputGate = terminalBlock.indexOf(
      "jq -e -s",
      finalizerInputs
    );
    const finalizerCommand = terminalBlock.indexOf(
      "bash aws/finalize-durable-recovery-receipt.sh",
      finalizerInputGate
    );
    const finalizationGate = terminalBlock.indexOf(
      "jq -e -s",
      finalizerCommand
    );
    assert.equal(
      (
        terminalBlock.match(
          /length == 1 and \(\.\[0\] \| type == "object"\)/gu
        ) ?? []
      ).length,
      4,
      environment
    );
    assert.ok(executionInputs >= 0, environment);
    assert.ok(executionInputs < executionGate, environment);
    assert.ok(executionGate < controlStep, environment);
    assert.ok(controlStep < controlGate, environment);
    assert.ok(controlGate < finalizerStep, environment);
    assert.ok(finalizerStep < finalizerInputs, environment);
    assert.ok(finalizerInputs < finalizerInputGate, environment);
    assert.ok(finalizerInputGate < finalizerCommand, environment);
    assert.ok(finalizerCommand < finalizationGate, environment);
  }

  assert.match(
    ledger,
    /ledger_key="candidates\/recovery\/\$\{RECOVERY_ENVIRONMENT\}\/ledger\.json"/u
  );
  assert.match(ledger, /put_args\+=\(--if-match "\$prior_etag"\)/u);
  assert.match(ledger, /put_args\+=\(--if-none-match '\*'\)/u);
  assert.match(ledger, /--server-side-encryption aws:kms/u);
  assert.match(ledger, /--ssekms-key-id "\$storage_key_alias"/u);
  assert.match(
    ledger,
    /storage_key_alias="arn:aws:kms:\$\{AWS_REGION\}:\$\{AWS_ACCOUNT_ID\}:alias\/\$\{APP_NAME\}-storage"/u
  );
  assert.match(ledger, /--checksum-algorithm SHA256/u);
  assert.match(ledger, /\.schema == "archon\.recovery-intent\.ledger"/u);
  assert.match(ledger, /validate_previous_ledger_provenance\(\)/u);
  assert.match(ledger, /read\|first-create\|terminal-rearm/u);
  assert.match(
    ledger,
    /if \$armedMode == "first-create"[\s\S]*?then null_previous_ledger[\s\S]*?elif \$armedMode == "terminal-rearm"[\s\S]*?then complete_previous_ledger/u
  );
  assert.match(
    ledger,
    /armed_provenance_mode="terminal-rearm"[\s\S]*?armed_provenance_mode="first-create"/u
  );
  assert.match(
    ledger,
    /\.receiptVersionId[\s\S]*?type == "string" and length > 0/u
  );
  for (const [index, scriptPath] of DURABLE_RECOVERY_SCRIPT_PATHS.entries()) {
    assert.match(scriptSources[index], /^#!\/usr\/bin\/env bash\r?\n/u);
    assert.match(scriptSources[index], /^set -euo pipefail$/mu);
    assert.ok(ci.includes(`bash -n ${scriptPath}`), scriptPath);
  }
  assert.doesNotMatch(
    [bootstrap, template, deploy, recovery, ...scriptSources].join("\n"),
    /AWS::DynamoDB::Table|\bdynamodb:/iu
  );
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
  const deliverablesComplete = report.eligibility.requirements.every(
    (requirement) => requirement.status === "complete"
  );
  assert.equal(report.eligibility.pass, deliverablesComplete);
  assert.equal(
    report.submissionEligible,
    report.sourceGate.pass && deliverablesComplete
  );
  for (const id of [
    "unrestricted-functional-demo",
    "public-under-three-minute-video",
    "submission-thumbnail",
    "devpost-submitted",
  ]) {
    assert.ok(
      report.eligibility.requirements.some((requirement) => requirement.id === id),
      `${id} must be represented as a hard eligibility requirement`
    );
  }
});

test("readiness: submission eligibility is the full source/deliverables truth table", () => {
  for (const [
    sourceGatePass,
    eligibilityPass,
    expected,
  ] of [
    [false, false, false],
    [false, true, false],
    [true, false, false],
    [true, true, true],
  ] as const) {
    assert.equal(
      isSubmissionEligible(sourceGatePass, eligibilityPass),
      expected,
      `${sourceGatePass}/${eligibilityPass}`
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

test("readiness: final submission URLs, duration, and thumbnail fail closed", () => {
  const youtube = "https://www.youtube.com/watch?v=AbCdEfGhI_1";
  const youtubeShort = "https://youtu.be/AbCdEfGhI_1";
  const vimeo = "https://vimeo.com/123456789";
  assert.deepEqual(parseCanonicalSubmissionVideoUrl(youtube), {
    provider: "youtube",
    id: "AbCdEfGhI_1",
    canonicalUrl: youtube,
  });
  assert.deepEqual(parseCanonicalSubmissionVideoUrl(youtubeShort), {
    provider: "youtube",
    id: "AbCdEfGhI_1",
    canonicalUrl: youtubeShort,
  });
  assert.deepEqual(parseCanonicalSubmissionVideoUrl(vimeo), {
    provider: "vimeo",
    id: "123456789",
    canonicalUrl: vimeo,
  });
  for (const invalid of [
    "http://www.youtube.com/watch?v=AbCdEfGhI_1",
    "https://youtube.com/watch?v=AbCdEfGhI_1",
    "https://www.youtube.com.evil.test/watch?v=AbCdEfGhI_1",
    "https://user@www.youtube.com/watch?v=AbCdEfGhI_1",
    "https://www.youtube.com:444/watch?v=AbCdEfGhI_1",
    "https://www.youtube.com/watch?v=AbCdEfGhI_1&feature=share",
    "https://www.youtube.com/watch?v=AbCdEfGhI_1#",
    "https://www.youtube.com/shorts/AbCdEfGhI_1",
    "https://youtu.be/too-short",
    "https://vimeo.com/123456789/",
    "https://www.vimeo.com/123456789",
    " https://vimeo.com/123456789",
  ]) {
    assert.equal(
      parseCanonicalSubmissionVideoUrl(invalid),
      undefined,
      invalid
    );
  }

  for (const valid of ["1", "90", "179"]) {
    assert.equal(validSubmissionVideoDuration(valid), true, valid);
  }
  for (const invalid of [
    "0",
    "00",
    "01",
    "180",
    "179.5",
    " 170",
    "170 ",
    "NaN",
    "",
  ]) {
    assert.equal(validSubmissionVideoDuration(invalid), false, invalid);
  }

  const devpost = "https://devpost.com/software/archon-memory";
  assert.equal(validDevpostSubmissionUrl(devpost), true);
  for (const invalid of [
    "http://devpost.com/software/archon-memory",
    "https://www.devpost.com/software/archon-memory",
    "https://devpost.com.evil.test/software/archon-memory",
    "https://user@devpost.com/software/archon-memory",
    "https://devpost.com:444/software/archon-memory",
    "https://devpost.com/software/archon-memory/",
    "https://devpost.com/software/archon-memory?preview=1",
    "https://devpost.com/software/archon-memory#details",
    "https://devpost.com/hackathons/archon-memory",
    " https://devpost.com/software/archon-memory",
  ]) {
    assert.equal(validDevpostSubmissionUrl(invalid), false, invalid);
  }

  const thumbnail = readFileSync(
    new URL(`../${SUBMISSION_THUMBNAIL_PATH}`, import.meta.url)
  );
  assert.deepEqual(inspectSubmissionThumbnail(thumbnail), {
    width: 1536,
    height: 1024,
    bytes: thumbnail.length,
  });
  assert.deepEqual(validSubmissionThumbnail(), {
    width: 1536,
    height: 1024,
    bytes: thumbnail.length,
  });
  assert.deepEqual(validatedSubmissionThumbnail(), {
    width: 1536,
    height: 1024,
    bytes: thumbnail.length,
    sha256:
      "a5cea4336a66f72443611b01706c63a207ab717c8730b5b8d0f3ca7e599ca976",
  });
  const symlinkRoot = mkdtempSync(
    join(tmpdir(), "archon-thumbnail-symlink-")
  );
  try {
    const assets = join(symlinkRoot, "demo", "assets");
    mkdirSync(assets, { recursive: true });
    symlinkSync(
      fileURLToPath(
        new URL(`../${SUBMISSION_THUMBNAIL_PATH}`, import.meta.url)
      ),
      join(symlinkRoot, SUBMISSION_THUMBNAIL_PATH)
    );
    assert.equal(validSubmissionThumbnail(symlinkRoot), undefined);
  } finally {
    rmSync(symlinkRoot, { recursive: true, force: true });
  }
  const oversizedRoot = mkdtempSync(
    join(tmpdir(), "archon-thumbnail-oversized-")
  );
  try {
    const assets = join(oversizedRoot, "demo", "assets");
    mkdirSync(assets, { recursive: true });
    writeFileSync(
      join(oversizedRoot, SUBMISSION_THUMBNAIL_PATH),
      Buffer.alloc(MAX_SUBMISSION_THUMBNAIL_BYTES + 1)
    );
    assert.equal(
      validatedSubmissionThumbnail(oversizedRoot),
      undefined
    );
  } finally {
    rmSync(oversizedRoot, { recursive: true, force: true });
  }
  const badSignature = Buffer.from(thumbnail);
  badSignature[0] = 0;
  assert.equal(inspectSubmissionThumbnail(badSignature), undefined);
  const wrongRatio = Buffer.from(thumbnail);
  wrongRatio.writeUInt32BE(1000, 20);
  assert.equal(inspectSubmissionThumbnail(wrongRatio), undefined);
  assert.equal(inspectSubmissionThumbnail(thumbnail.subarray(0, 24)), undefined);
  const corruptChunkCrc = Buffer.from(thumbnail);
  corruptChunkCrc[29] = corruptChunkCrc[29]! ^ 0xff;
  assert.equal(inspectSubmissionThumbnail(corruptChunkCrc), undefined);
  const missingIend = thumbnail.subarray(0, thumbnail.length - 12);
  assert.equal(inspectSubmissionThumbnail(missingIend), undefined);
  const corruptCompressedData = Buffer.from(thumbnail);
  const firstIdat = corruptCompressedData.indexOf(Buffer.from("IDAT", "ascii"));
  assert.ok(firstIdat > 0);
  corruptCompressedData[firstIdat + 4] =
    corruptCompressedData[firstIdat + 4]! ^ 0xff;
  assert.equal(inspectSubmissionThumbnail(corruptCompressedData), undefined);
  assert.equal(
    inspectSubmissionThumbnail(
      Buffer.alloc(MAX_SUBMISSION_THUMBNAIL_BYTES + 1)
    ),
    undefined
  );
});

test("readiness: pre-submit and post-submit eligibility cannot be conflated", () => {
  const names = [
    "SUBMISSION_DEMO_URL",
    "SUBMISSION_PUBLIC_REPO_URL",
    "SUBMISSION_VIDEO_URL",
    "SUBMISSION_VIDEO_DURATION_SECONDS",
    "SUBMISSION_VIDEO_PUBLIC_EMBEDDABLE_ATTESTED",
    "SUBMISSION_VIDEO_CAPTIONS_ATTESTED",
    "DEVPOST_SUBMITTED",
    "DEVPOST_SUBMISSION_URL",
  ] as const;
  const previous = Object.fromEntries(
    names.map((name) => [name, process.env[name]])
  );
  try {
    process.env.SUBMISSION_DEMO_URL =
      "https://d2s5v0o0eg2aaw.cloudfront.net";
    process.env.SUBMISSION_PUBLIC_REPO_URL =
      "https://github.com/upgradedev/archon-cockroach-memory";
    process.env.SUBMISSION_VIDEO_URL =
      "https://www.youtube.com/watch?v=AbCdEfGhI_1";
    process.env.SUBMISSION_VIDEO_DURATION_SECONDS = "170";
    process.env.SUBMISSION_VIDEO_PUBLIC_EMBEDDABLE_ATTESTED = "true";
    process.env.SUBMISSION_VIDEO_CAPTIONS_ATTESTED = "true";
    delete process.env.DEVPOST_SUBMITTED;
    delete process.env.DEVPOST_SUBMISSION_URL;
    const preSubmit = evaluate();
    assert.equal(preSubmit.submissionEligible, false);
    assert.deepEqual(
      preSubmit.eligibility.requirements
        .filter((requirement) => requirement.status === "pending")
        .map((requirement) => requirement.id),
      ["devpost-submitted"]
    );

    process.env.DEVPOST_SUBMITTED = "1";
    process.env.DEVPOST_SUBMISSION_URL =
      "https://devpost.com/software/archon-memory";
    const postSubmit = evaluate();
    assert.equal(postSubmit.eligibility.pass, true);
    assert.equal(postSubmit.submissionEligible, true);
  } finally {
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
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
    /needs:\s*\[secret-scan,\s*dep-audit,\s*build-test,\s*cluster-survival,\s*pen-test,\s*load,\s*frontend-iac,\s*hosted-dast,\s*video-gate\]/u
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
    /jq -e 'length == 9 and all\(\.\[\]; \.result == "success"\)'/u
  );
});

test("readiness: gitleaks scans the exact tree and only protected-main HEAD ancestry", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/ci.yml", import.meta.url),
    "utf8"
  );
  const secretScanJob = workflow.match(
    /(?:^|\r?\n)  secret-scan:\r?\n[\s\S]*?(?=\r?\n  [A-Za-z0-9_-]+:\r?\n|$)/u
  )?.[0];
  assert.ok(secretScanJob);
  assert.match(secretScanJob, /"\$GITLEAKS_DIR\/gitleaks" dir \. \\/u);
  assert.match(
    secretScanJob,
    /"\$GITHUB_EVENT_NAME" = "push"[\s\S]*?"\$GITHUB_REF" = "refs\/heads\/main"/u
  );
  assert.ok(
    secretScanJob.includes(
      'HISTORY_HEAD="$(git rev-parse --verify "${GITHUB_SHA}^{commit}")"'
    )
  );
  assert.ok(
    secretScanJob.includes(
      'test "$HISTORY_HEAD" = "$(git rev-parse --verify HEAD)"'
    )
  );
  assert.match(
    secretScanJob,
    /"\$GITLEAKS_DIR\/gitleaks" git \. \\\r?\n\s+--log-opts="\$HISTORY_HEAD"/u
  );
  assert.doesNotMatch(secretScanJob, /--all/u);
});

test("readiness: every workflow action and Node runtime is pinned exhaustively", () => {
  const workflows = repositoryWorkflowTexts();
  const versions = workflows.flatMap(setupNodeVersions);
  assert.equal(EXPECTED_SETUP_NODE_STEPS, 31);
  assert.equal(versions.length, EXPECTED_SETUP_NODE_STEPS);
  assert.deepEqual(
    [...new Set(versions)],
    [PINNED_NODE_VERSION]
  );
  assert.equal(allSetupNodeStepsPinned(workflows), true);
  assert.equal(allWorkflowActionsPinned(workflows), true);
  const actionLock = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      ".github",
      "toolchain-lock.json"
    ),
    "utf8"
  );
  assert.equal(
    allWorkflowActionCommitsInventoryLocked(workflows, actionLock),
    true
  );
  assert.equal(
    allWorkflowActionCommitsInventoryLocked(
      workflows,
      actionLock.replace(
        "db07bd9765aac508ef18982e52ab937fe633a065",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      )
    ),
    false
  );
  assert.equal(
    allCheckoutStepsDisableCredentialPersistence(workflows),
    true
  );
  assert.equal(EXPECTED_WORKFLOW_ACTION_REFS, 216);

  const setupNodeSha =
    "48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e";
  const mixedNodeVersions = `
steps:
  - uses: actions/setup-node@${setupNodeSha}
    with:
      node-version: ${PINNED_NODE_VERSION}
  - name: Mutable runtime must fail the aggregate
    uses: actions/setup-node@${setupNodeSha}
    with:
      node-version: 22
`;
  assert.deepEqual(
    setupNodeVersions(mixedNodeVersions),
    [PINNED_NODE_VERSION, undefined]
  );
  assert.equal(
    allSetupNodeStepsPinned(
      [mixedNodeVersions],
      PINNED_NODE_VERSION,
      2
    ),
    false
  );
  assert.equal(
    allWorkflowActionsPinned([
      `steps:
  - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0
  - uses: actions/setup-node@main
`,
    ], 2),
    false
  );

  const exactSetupNode = `steps:
  - uses: actions/setup-node@${setupNodeSha}
    with:
      node-version: "${PINNED_NODE_VERSION}"
`;
  assert.equal(
    allSetupNodeStepsPinned(
      [exactSetupNode],
      PINNED_NODE_VERSION,
      1
    ),
    true
  );
  const flowSetupNode = `steps:
  - { uses: actions/setup-node@${setupNodeSha}, with: { node-version: "${PINNED_NODE_VERSION}" } }
`;
  assert.equal(
    allSetupNodeStepsPinned(
      [flowSetupNode],
      PINNED_NODE_VERSION,
      1
    ),
    true
  );
  assert.equal(
    allWorkflowActionsPinned([flowSetupNode], 1),
    true
  );
  assert.equal(
    allSetupNodeStepsPinned(
      [`${exactSetupNode}${flowSetupNode.replace("steps:\n", "")}`],
      PINNED_NODE_VERSION,
      2
    ),
    true
  );
  assert.equal(
    allSetupNodeStepsPinned(
      [
        `steps:
  - uses: Actions/Setup-Node@${setupNodeSha}
    with:
      node-version: ${PINNED_NODE_VERSION}
`,
      ],
      PINNED_NODE_VERSION,
      1
    ),
    true
  );
  for (const invalid of [
    `steps:
  - uses: actions/setup-node@${setupNodeSha}
    env:
      node-version: ${PINNED_NODE_VERSION}
`,
    `steps:
  - uses: actions/setup-node@${setupNodeSha}
`,
    `steps:
  - uses: Actions/Setup-Node@${setupNodeSha}
    env:
      node-version: ${PINNED_NODE_VERSION}
`,
  ]) {
    assert.equal(
      allSetupNodeStepsPinned(
        [invalid],
        PINNED_NODE_VERSION,
        1
      ),
      false,
      invalid
    );
  }
  const aliasedStep = `setup: &setup
  uses: actions/setup-node@${setupNodeSha}
  with:
    node-version: ${PINNED_NODE_VERSION}
steps:
  - *setup
`;
  assert.equal(
    allSetupNodeStepsPinned(
      [aliasedStep],
      PINNED_NODE_VERSION,
      1
    ),
    false
  );
  assert.equal(allWorkflowActionsPinned([aliasedStep], 1), false);

  for (const invalid of [
    "steps:\n  - { uses: actions/checkout@main }\n",
    "steps:\n  - uses : actions/checkout@release\n",
    'steps:\n  - "uses": actions/checkout@latest\n',
    'steps:\n  - "us\\u0065s": actions/checkout@main\n',
  ]) {
    assert.equal(
      allWorkflowActionsPinned([invalid], 1),
      false,
      invalid
    );
  }
  assert.equal(
    allWorkflowActionsPinned(
      [
        'steps:\n  - "us\\u0065s": actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0\n',
      ],
      1
    ),
    true
  );
  assert.equal(
    allWorkflowActionsPinned(
      ["steps:\n  - uses: ./.github/actions/unreviewed\n"],
      1
    ),
    false
  );
});

test("readiness: every CockroachDB and Docker base image is digest-pinned", () => {
  const workflows = repositoryWorkflowTexts();
  const compose = repositoryDockerComposeSources();
  const dockerfiles = repositoryDockerfileSources();
  assert.equal(compose.length, 2);
  assert.equal(dockerfiles.length, 0);
  assert.equal(EXPECTED_COCKROACH_IMAGE_REFS, 9);
  assert.equal(EXPECTED_COMPOSE_IMAGE_REFS, 4);
  assert.equal(EXPECTED_DOCKERFILE_BASE_REFS, 0);
  assert.equal(allComposeImagesPinned(compose), true);
  assert.equal(
    allCockroachImagesPinned({
      workflows,
      compose,
      dockerfiles,
    }),
    true
  );
  assert.equal(allDockerfileBasesPinned(dockerfiles), true);
  const digest = `sha256:${"a".repeat(64)}`;
  assert.equal(
    allCockroachImagesPinned(
      {
        workflows: [
          `steps:
  - run: |
      docker run cockroachdb/cockroach:v26.2.3@sha256:${"a".repeat(64)}
      docker run cockroachdb/cockroach:v26.2.3
`,
        ],
        compose: [],
        dockerfiles: [],
      },
      2
    ),
    false
  );
  assert.equal(
    allCockroachImagesPinned(
      {
        workflows: [
          `steps:
  - run: |
      docker run -d --name crdb -p 26257:26257 -e PROOF=cockroachdb/cockroach:v26.2.3@${digest} "$CRDB_IMAGE" start-single-node --insecure
`,
        ],
        compose: [],
        dockerfiles: [],
      },
      1
    ),
    false
  );
  assert.equal(
    allCockroachImagesPinned(
      {
        workflows: [
          `steps:
  - run: |
      docker run cockroachdb/cockroach:v26.2.3@${digest}
      docker run "$CRDB_IMAGE";# docker run cockroachdb/cockroach:v26.2.3@${digest}
`,
        ],
        compose: [],
        dockerfiles: [],
      },
      1
    ),
    false
  );

  assert.equal(
    allDockerfileBasesPinned(
      [
        `  FROM example/build@${digest} AS build
FROM example/runtime@${digest}
`,
        `FROM example/sidecar@${digest}
`,
      ],
      3
    ),
    true
  );
  assert.equal(
    allDockerfileBasesPinned(
      [`  FROM example/base@${digest}
FROM example/mutable:latest
`],
      2
    ),
    false
  );
  assert.equal(
    allComposeImagesPinned(
      [
        `services:
  roach:
    build: https://github.com/example/mutable.git#main
`,
      ],
      0
    ),
    false
  );
  assert.equal(
    allCockroachImagesPinned(
      {
        workflows: [
          `steps:
  - run: |
      docker run "$CRDB_IMAGE"
      # docker run cockroachdb/cockroach:v26.2.3@${digest}
`,
        ],
        compose: [],
        dockerfiles: [],
      },
      1
    ),
    false
  );
  assert.equal(
    allDockerfileBasesPinned(
      [`FROM example/base@${digest}\n`, "# no FROM\n"],
      1
    ),
    false
  );

  assert.equal(
    allComposeImagesPinned(
      [
        `services:
  roach:
    image: \${CRDB_IMAGE}
`,
      ],
      1
    ),
    false
  );

  const sandbox = mkdtempSync(
    join(tmpdir(), "archon-readiness-supply-chain-")
  );
  try {
    const nested = join(sandbox, "services", "memory");
    mkdirSync(nested, { recursive: true });
    writeFileSync(
      join(nested, "compose.yaml"),
      `services:
  roach:
    image: cockroachdb/cockroach:v26.2.3@${digest}
`,
      "utf8"
    );
    writeFileSync(
      join(nested, "Cockroach.Dockerfile"),
      `FROM cockroachdb/cockroach:v26.2.3@${digest}
`,
      "utf8"
    );
    const nestedCompose =
      repositoryDockerComposeSources(sandbox);
    const nestedDockerfiles =
      repositoryDockerfileSources(sandbox);
    assert.equal(nestedCompose.length, 1);
    assert.equal(nestedDockerfiles.length, 1);
    assert.equal(allComposeImagesPinned(nestedCompose, 1), true);
    assert.equal(
      allDockerfileBasesPinned(nestedDockerfiles, 1),
      true
    );
    assert.equal(
      allCockroachImagesPinned(
        {
          workflows: [],
          compose: nestedCompose,
          dockerfiles: nestedDockerfiles,
        },
        2
      ),
      true
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("readiness: dependency release freeze and CodeQL pins fail closed", () => {
  const codeql = readFileSync(
    new URL("../.github/workflows/codeql.yml", import.meta.url),
    "utf8"
  );
  const dependabot = readFileSync(
    new URL("../.github/dependabot.yml", import.meta.url),
    "utf8"
  );

  assert.equal(hasExactCodeqlActionPins(codeql), true);
  assert.match(codeql, /queries:\s*security-and-quality/u);
  assert.match(
    codeql,
    /output:\s*\$\{\{\s*env\.CODEQL_RAW_SARIF_DIR\s*\}\}/u
  );
  assert.match(
    codeql,
    /post-processed-sarif-path:\s*\$\{\{\s*env\.CODEQL_SARIF_DIR\s*\}\}/u
  );
  assert.match(codeql, /upload:\s*always/u);
  assert.match(
    codeql,
    /name: Enforce the CodeQL high-severity policy/u
  );
  assert.match(codeql, /properties\?\.\["security-severity"\]/u);
  assert.match(
    codeql,
    /securitySeverity >= 7 \|\| rawLevel === "error"/u
  );
  assert.match(codeql, /blockingFindings\.length > 0/u);
  assert.match(codeql, /policy: "codeql-high-critical-or-error"/u);
  assert.match(codeql, /acceptedWaivers: 0/u);
  assert.equal(
    (
      codeql.match(
        new RegExp(
          `github/codeql-action/(?:init|autobuild|analyze)@${PINNED_CODEQL_ACTION_SHA}`,
          "gu"
        )
      ) ?? []
    ).length,
    3
  );
  assert.equal(
    hasExactCodeqlActionPins(
      codeql.replaceAll(PINNED_CODEQL_ACTION_SHA, "v3.37.3")
    ),
    false
  );
  assert.equal(
    hasExactCodeqlActionPins(
      codeql.replace(
        `github/codeql-action/analyze@${PINNED_CODEQL_ACTION_SHA}`,
        `github/codeql-action/analyze@${"a".repeat(40)}`
      )
    ),
    false
  );
  assert.equal(
    hasExactCodeqlActionPins(
      codeql.replace(
        "github/codeql-action/autobuild",
        "github/codeql-action/init"
      )
    ),
    false
  );
  assert.equal(
    hasExactCodeqlActionPins(
      codeql.replace(
        "      - name: Perform CodeQL Analysis",
        `      - uses: github/codeql-action/upload-sarif@${PINNED_CODEQL_ACTION_SHA}

      - name: Perform CodeQL Analysis`
      )
    ),
    false
  );
  assert.equal(hasExactCodeqlActionPins("jobs: ["), false);

  assert.equal(hasExactDependabotReleaseFreeze(dependabot), true);
  assert.equal(
    EXPECTED_DEPENDABOT_RELEASE_FREEZE.length,
    4
  );
  assert.equal(
    hasExactDependabotReleaseFreeze(
      dependabot.replace("default-days: 7", "default-days: 0")
    ),
    false
  );
  assert.equal(
    hasExactDependabotReleaseFreeze(
      dependabot.replace(
        "open-pull-requests-limit: 0",
        "open-pull-requests-limit: 1"
      )
    ),
    false
  );
  assert.equal(
    hasExactDependabotReleaseFreeze(
      dependabot.replaceAll(
        "open-pull-requests-limit: 0",
        'open-pull-requests-limit: "0"'
      )
    ),
    false
  );
  assert.equal(
    hasExactDependabotReleaseFreeze(
      dependabot.replace(
        "package-ecosystem: docker-compose",
        "package-ecosystem: github-actions"
      )
    ),
    false
  );
  assert.equal(
    hasExactDependabotReleaseFreeze(
      dependabot.replace(
        "    open-pull-requests-limit: 0",
        `    open-pull-requests-limit: 0
    ignore:
      - dependency-name: "*"`
      )
    ),
    false
  );
  assert.equal(
    hasExactDependabotReleaseFreeze(
      dependabot.replace(
        "    open-pull-requests-limit: 0",
        `    open-pull-requests-limit: 0
    target-branch: release`
      )
    ),
    false
  );
  assert.equal(
    hasExactDependabotReleaseFreeze("version: 2\nupdates: ["),
    false
  );
});

test("readiness: CI covers main, every pull request, and exact manual evidence retries", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/ci.yml", import.meta.url),
    "utf8"
  );
  assert.equal(hasExactCiTrigger(workflow), true);
  assert.equal(
    hasExactCiTrigger(workflow.replace("  workflow_dispatch:\n", "")),
    false
  );
  assert.equal(
    hasExactCiTrigger(
      workflow.replace(
        "  workflow_dispatch:",
        "  workflow_dispatch:\n    inputs: {}"
      )
    ),
    false
  );
  const repositoryWorkflows = repositoryWorkflowSources();
  const recoveryWorkflow = repositoryWorkflows.find(
    (entry) => entry.name === "recover-aws.yml"
  );
  const deployWorkflow = repositoryWorkflows.find(
    (entry) => entry.name === "deploy-aws.yml"
  );
  const benchmarkWorkflow = repositoryWorkflows.find(
    (entry) => entry.name === "benchmark.yml"
  );
  const submissionWorkflow = repositoryWorkflows.find(
    (entry) => entry.name === "submission-readiness.yml"
  );
  const demoVideoWorkflow = repositoryWorkflows.find(
    (entry) => entry.name === "demo-video.yml"
  );
  const hostedDastWorkflow = repositoryWorkflows.find(
    (entry) => entry.name === "security-dast.yml"
  );
  assert.ok(recoveryWorkflow);
  assert.ok(deployWorkflow);
  assert.ok(benchmarkWorkflow);
  assert.ok(submissionWorkflow);
  assert.ok(demoVideoWorkflow);
  assert.ok(hostedDastWorkflow);
  assert.equal(hasExactAwsRecoveryTrigger(recoveryWorkflow.source), true);
  assert.equal(hasExactAwsDeployTrigger(deployWorkflow.source), true);
  assert.equal(hasExactBenchmarkTrigger(benchmarkWorkflow.source), true);
  assert.equal(hasExactHostedDastTrigger(hostedDastWorkflow.source), true);
  assert.equal(
    hasExactSubmissionReadinessTrigger(submissionWorkflow.source),
    true
  );
  assert.equal(
    hasExactSubmissionWorkflowContract(submissionWorkflow.source),
    true
  );
  assert.equal(hasExactDemoVideoTrigger(demoVideoWorkflow.source), true);
  for (const mutation of [
    deployWorkflow.source.replace(
      "    branches:\n      - main",
      "    branches:\n      - release"
    ),
    deployWorkflow.source.replace("  push:", "  workflow_dispatch:"),
    deployWorkflow.source.replace(
      "      - main",
      "      - main\n      - release"
    ),
    deployWorkflow.source.replace(
      "          - staging-recovery-drill",
      "          - production-recovery-drill"
    ),
    deployWorkflow.source.replace(
      "The only manual mode is the protected staging recovery drill.",
      "Any manual deployment mode."
    ),
    deployWorkflow.source.replace(
      "      confirmation:",
      "      bypass:\n        required: false\n        type: boolean\n      confirmation:"
    ),
  ]) {
    assert.equal(hasExactAwsDeployTrigger(mutation), false);
  }
  for (const mutation of [
    demoVideoWorkflow.source.replace(
      /(exact_sha:[\s\S]*?\n\s+required:) true/u,
      "$1 false"
    ),
    demoVideoWorkflow.source.replace(
      /(voice_rights_attested:[\s\S]*?\n\s+default:) false/u,
      "$1 true"
    ),
    demoVideoWorkflow.source.replace(
      "  workflow_dispatch:",
      "  push:"
    ),
    demoVideoWorkflow.source.replace(
      "    inputs:\n      exact_sha:",
      "    inputs:\n      bypass:\n        required: false\n        type: boolean\n      exact_sha:"
    ),
  ]) {
    assert.equal(hasExactDemoVideoTrigger(mutation), false);
  }
  assert.equal(
    hasExactAwsRecoveryTrigger(
      recoveryWorkflow.source.replace(
        "          - audit",
        "          - deploy"
      )
    ),
    false
  );
  for (const mutation of [
    hostedDastWorkflow.source.replace(
      "        description: Exact deployed main commit to scan",
      "        description: Arbitrary commit to scan"
    ),
    hostedDastWorkflow.source.replace(
      /(exact_sha:[\s\S]*?\n\s+required:) true/u,
      "$1 false"
    ),
    hostedDastWorkflow.source.replace(
      /(deploy_run_id:[\s\S]*?\n\s+type:) number/u,
      "$1 string"
    ),
    hostedDastWorkflow.source.replace(
      '    - cron: "43 4 * * 1"',
      '    - cron: "0 0 * * *"'
    ),
    hostedDastWorkflow.source.replace(
      "  workflow_dispatch:",
      "  workflow_dispatch:\n    inputs: {}"
    ),
  ]) {
    assert.equal(hasExactHostedDastTrigger(mutation), false);
  }
  for (const mutation of [
    benchmarkWorkflow.source.replace(
      '    - cron: "17 3 * * 0"',
      '    - cron: "0 0 * * *"'
    ),
    benchmarkWorkflow.source.replace(
      '        default: "10000"',
      '        default: "1000"'
    ),
    benchmarkWorkflow.source.replace(
      '        default: "200"',
      '        default: "20"'
    ),
    benchmarkWorkflow.source.replace(
      "  schedule:",
      "  push:\n  schedule:"
    ),
  ]) {
    assert.equal(hasExactBenchmarkTrigger(mutation), false);
  }
  assert.equal(
    hasExactAwsRecoveryTrigger(
      recoveryWorkflow.source.replace(
        "        default: recover",
        "        default: audit"
      )
    ),
    false
  );
  for (const mutation of [
    submissionWorkflow.source.replace(
      "          - post-submit",
      "          - draft"
    ),
    submissionWorkflow.source.replace(
      /(phase:[\s\S]*?\n\s+required:) true/u,
      "$1 false"
    ),
    submissionWorkflow.source.replace(
      /(video_url:[\s\S]*?\n\s+required:) true/u,
      "$1 false"
    ),
    submissionWorkflow.source.replace(
      /(video_duration_seconds:[\s\S]*?\n\s+type:) string/u,
      "$1 number"
    ),
    submissionWorkflow.source.replace(
      /(video_ci_run_id:[\s\S]*?\n\s+required:) true/u,
      "$1 false"
    ),
    submissionWorkflow.source.replace(
      /(video_ci_run_attempt:[\s\S]*?\n\s+type:) string/u,
      "$1 number"
    ),
    submissionWorkflow.source.replace(
      /(video_source_sha256:[\s\S]*?\n\s+required:) true/u,
      "$1 false"
    ),
    submissionWorkflow.source.replace(
      /(video_uploaded_from_ci_artifact_attested:[\s\S]*?\n\s+default:) false/u,
      "$1 true"
    ),
    submissionWorkflow.source.replace(
      /(video_public_embeddable_attested:[\s\S]*?\n\s+default:) false/u,
      "$1 true"
    ),
    submissionWorkflow.source.replace(
      /(video_english_captions_attested:[\s\S]*?\n\s+default:) false/u,
      "$1 true"
    ),
    submissionWorkflow.source.replace(
      /(devpost_url:[\s\S]*?\n\s+required:) false/u,
      "$1 true"
    ),
    submissionWorkflow.source.replace(
      /(devpost_submitted_attested:[\s\S]*?\n\s+required:) true/u,
      "$1 false"
    ),
    submissionWorkflow.source.replace(
      /(pre_submit_run_id:[\s\S]*?\n\s+default:) ""/u,
      '$1 "1"'
    ),
    submissionWorkflow.source.replace(
      "    inputs:\n      phase:",
      "    inputs:\n      bypass:\n        description: Unsafe bypass input.\n        required: false\n        type: boolean\n      phase:"
    ),
    submissionWorkflow.source.replace(
      "  workflow_dispatch:",
      "  push:"
    ),
    "on: [",
  ]) {
    assert.equal(
      hasExactSubmissionReadinessTrigger(mutation),
      false
    );
  }
  for (const mutation of [
    submissionWorkflow.source.replace("  contents: read", "  contents: write"),
    submissionWorkflow.source.replace(
      "      SUBMISSION_PHASE: ${{ inputs.phase }}",
      "      GITHUB_TOKEN: ${{ github.token }}\n      SUBMISSION_PHASE: ${{ inputs.phase }}"
    ),
    submissionWorkflow.source.replace(
      '"passed":false',
      '"passed":true'
    ),
    submissionWorkflow.source.replace(
      '"status":"fail"',
      '"status":"pass"'
    ),
    submissionWorkflow.source.replace(
      'readonly receipt_path="${SUBMISSION_RECEIPT_PATH:?}"',
      'readonly receipt_path="/tmp/untrusted-receipt.json"'
    ),
    submissionWorkflow.source.replace(
      "umask 077",
      "umask 022"
    ),
    submissionWorkflow.source.replace(
      '>"${receipt_path}"',
      '>>"${receipt_path}"'
    ),
    submissionWorkflow.source.replace(
      "    timeout-minutes: 25",
      "    timeout-minutes: 30"
    ),
    submissionWorkflow.source.replace(
      "      - name: Set up pinned Node.js",
      "      - name: Set up mutable Node.js"
    ),
    submissionWorkflow.source.replace(
      "          retention-days: 90",
      "          retention-days: 30"
    ),
    submissionWorkflow.source.replace(
      "      - name: Publish receipt artifact coordinates",
      "      - name: Extra bypass step\n        run: true\n\n      - name: Publish receipt artifact coordinates"
    ),
  ]) {
    assert.equal(hasExactSubmissionWorkflowContract(mutation), false);
  }
  assert.equal(repositoryWorkflows.length, 24);
  assert.equal(
    hasUniqueCiTriggerOwnership(repositoryWorkflows),
    true
  );
  assert.equal(
    hasUniqueCiTriggerOwnership([
      ...repositoryWorkflows,
      { name: "duplicate.yaml", source: workflow },
    ]),
    false
  );
  assert.equal(
    hasUniqueCiTriggerOwnership(
      repositoryWorkflows.map((entry) =>
        entry.name === "recover-aws.yml"
          ? {
              ...entry,
              source: entry.source.replace(
                '    - cron: "7,22,37,52 * * * *"',
                '    - cron: "0 * * * *"'
              ),
            }
          : entry
      )
    ),
    false
  );
  assert.equal(
    hasUniqueCiTriggerOwnership(
      repositoryWorkflows.map((entry) =>
        entry.name === "codeql.yml"
          ? {
              ...entry,
              source: entry.source.replace(
                "  pull_request:\n",
                ""
              ),
            }
          : entry
      )
    ),
    false
  );
  for (const invalid of [
    "on:\n  push:\n  pull_request:",
    "on:\n  push:\n    branches: [main]\n  pull_request:\n    branches: [main]",
    "on:\n  push:\n    branches: [main]\n  pull_request:\n  workflow_dispatch:\n  schedule:",
    "on:\n  push:\n    branches: [main]\n  pull_request:\nname: CI\non:\n  workflow_dispatch:",
    "on:\n  push:\n    branches: [main]\n  pull_request:\nname: CI\non :\n  workflow_dispatch:",
    "on:\n  push:\n    branches: [main]\n  pull_request:\nname: CI\n\"on\":\n  workflow_dispatch:",
    "on:\n  push:\n    branches: [main]\n  pull_request:\nname: CI\n\"o\\u006e\":\n  workflow_dispatch:",
  ]) {
    assert.equal(hasExactCiTrigger(invalid), false, invalid);
  }
});

test("readiness: generated receipts and nested build directories fail closed", () => {
  assert.ok(
    GENERATED_ARTIFACT_BASENAMES.includes("hosted-load-contract.sha256")
  );
  const sandbox = mkdtempSync(
    join(tmpdir(), "archon-readiness-artifacts-")
  );
  try {
    for (const basename of GENERATED_ARTIFACT_BASENAMES) {
      writeFileSync(join(sandbox, basename), "generated", "utf8");
    }
    for (const basename of DURABLE_RECOVERY_LOCAL_BASENAMES) {
      writeFileSync(join(sandbox, basename), "generated", "utf8");
    }
    for (const basename of [
      "staging-recovery-123-1.tar",
      "production-recovery-roundtrip-456-2.tar",
      "staging-recovery-download.json",
      "archon-recovery-archive.A1b2C3",
      "draft.mov",
      "screen.webm",
      "voice.wav",
      "narration.m4a",
      "mix.flac",
      "captions.srt",
    ]) {
      writeFileSync(join(sandbox, basename), "generated", "utf8");
    }
    mkdirSync(join(sandbox, "production-durable-recovery-bundle"), {
      recursive: true,
    });
    mkdirSync(join(sandbox, "archon-durable-recovery.X9y8Z7"), {
      recursive: true,
    });
    mkdirSync(join(sandbox, "packages", "api", "dist"), {
      recursive: true,
    });
    mkdirSync(join(sandbox, "packages", "web", "build"), {
      recursive: true,
    });
    mkdirSync(join(sandbox, "src"), { recursive: true });
    writeFileSync(
      join(sandbox, "src", "distribution.ts"),
      "export const source = true;\n",
      "utf8"
    );

    const found = generatedArtifactPaths(sandbox);
    for (const basename of GENERATED_ARTIFACT_BASENAMES) {
      assert.ok(found.includes(basename), basename);
    }
    for (const basename of DURABLE_RECOVERY_LOCAL_BASENAMES) {
      assert.ok(found.includes(basename), basename);
    }
    assert.ok(found.includes("staging-recovery-123-1.tar"));
    assert.ok(
      found.includes("production-recovery-roundtrip-456-2.tar")
    );
    assert.ok(found.includes("staging-recovery-download.json"));
    assert.ok(found.includes("archon-recovery-archive.A1b2C3"));
    for (const media of [
      "draft.mov",
      "screen.webm",
      "voice.wav",
      "narration.m4a",
      "mix.flac",
      "captions.srt",
    ]) {
      assert.ok(found.includes(media), media);
    }
    assert.ok(found.includes("production-durable-recovery-bundle"));
    assert.ok(found.includes("archon-durable-recovery.X9y8Z7"));
    assert.ok(found.includes("packages/api/dist"));
    assert.ok(found.includes("packages/web/build"));
    assert.ok(!found.includes("src/distribution.ts"));
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }

  const gitignore = readFileSync(
    new URL("../.gitignore", import.meta.url),
    "utf8"
  ).split(/\r?\n/u);
  for (const ignored of [
    ...GENERATED_ARTIFACT_BASENAMES,
    "frontend-prestate.json",
    "previous-index.html",
    "previous-live-alias.json",
    "recovery-intent.json",
    "recovery-intent.tar",
    "recovery-snapshot-proof.json",
    "staging-recovery-*.json",
    "production-recovery-*.json",
    "staging-durable-recovery-*.json",
    "production-durable-recovery-*.json",
    "staging-terminal-receipt-object.json",
    "production-terminal-receipt-object.json",
    "staging-cloudformation-controls-*.json",
    "production-cloudformation-controls-*.json",
    "dist/",
    "build/",
  ]) {
    assert.ok(gitignore.includes(ignored), ignored);
  }
  const ci = readFileSync(
    new URL("../.github/workflows/ci.yml", import.meta.url),
    "utf8"
  );
  for (const basename of DURABLE_RECOVERY_LOCAL_BASENAMES) {
    assert.ok(ci.includes(basename), basename);
  }
  const makefile = readFileSync(
    new URL("../Makefile", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(makefile, /scripts\/build_video\.py/u);
  assert.doesNotMatch(makefile, /^video(?:-frames)?:/mu);
});

test("readiness: required tool story is Vector + hardened Managed MCP", () => {
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
      (check) => check.id === "tech.managed-mcp-receipt-v3-gate"
    )?.status,
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

test("readiness: Managed MCP source and both protected workflows pin causal receipt v3 exactly", () => {
  const audit = readFileSync(
    new URL("../scripts/cloud-mcp-audit.ts", import.meta.url),
    "utf8"
  );
  for (const pattern of [
    /MANAGED_MCP_RECEIPT_SCHEMA_VERSION\s*=\s*3/u,
    /tenantId:\s*"public-demo"/u,
    /company:\s*"Helios SA"/u,
    /status:\s*"active"/u,
    /embedModel:\s*"amazon\.titan-embed-text-v2:0"/u,
    /FORCE_INDEX=idx_agent_memory_active_scope/u,
    /LIMIT 10[\s\S]*LIMIT 1/u,
    /parseManagedMcpAggregateResult/u,
    /parseManagedMcpCspannExplainResult/u,
    /runMemoryIntegrityAgent/u,
    /MANAGED_MCP_RELEASE_SHA/u,
    /MANAGED_MCP_CSPANN_RECEIPT_SHA256/u,
    /idx_agent_memory_company_scope_embedding/u,
    /assertExactKeys/u,
    /Number\.isSafeInteger/u,
    /invokedDirectly/u,
  ]) {
    assert.match(audit, pattern);
  }

  const standalone = readFileSync(
    new URL("../.github/workflows/managed-mcp-audit.yml", import.meta.url),
    "utf8"
  );
  const deploy = readFileSync(
    new URL("../.github/workflows/deploy-aws.yml", import.meta.url),
    "utf8"
  );
  const deployJob = deploy.match(
    /(?:^|\r?\n)  managed-mcp-production-audit:\r?\n[\s\S]*?(?=\r?\n  [A-Za-z0-9_-]+:\r?\n|$)/u
  )?.[0];
  assert.ok(deployJob);
  assert.match(
    standalone,
    /actions\/workflows\/deploy-aws\.yml\/runs\?branch=main&event=push&status=success/u
  );
  assert.doesNotMatch(standalone, /event=workflow_run/u);

  const exactGateFragments = [
    'keys == ["aggregate","bound","calledTools","checkedAt","cspannLinkage","database","endpoint","mode","ok","proofs","redactions","release","schemaVersion","scope","toolsAdvertised"]',
    ".schemaVersion == 3",
    '"tenantId":"public-demo"',
    '"company":"Helios SA"',
    '"status":"active"',
    '"embedModel":"amazon.titan-embed-text-v2:0"',
    '"index":"idx_agent_memory_active_scope"',
    '"innerLimit":10',
    '"outerLimit":1',
    '"persisted":9',
    '"idempotencyKeys":9',
    '"contentDigests":9',
    '"commitSha":$release',
    '"cspannReceiptSha256":$cspann',
    '"idx_agent_memory_company_scope_embedding"',
    '"status":"not-advertised"',
    '.cspannLinkage.explainQuery.status == "verified"',
    '["get_cluster","list_tables","get_table_schema","select_query"]',
    '["get_cluster","list_tables","get_table_schema","explain_query","select_query"]',
    '"Live cluster metadata returned through CockroachDB Cloud Managed MCP."',
    '"`agent_memory` is present in the configured application database."',
    '"Live schema exposes VECTOR(1024) and a native vector index."',
    '"Managed MCP EXPLAIN verified the exact fixed-scope C-SPANN serving index."',
    '"The fixed-scope, index-forced, ten-row-sentinel aggregate is exactly 9/9/9."',
    "map(.name) == $called",
    '.redactions == ["API key","cluster identifier","SQL credentials","memory content","embeddings","raw query plan"]',
    'grep -Fq -- "$CCLOUD_API_KEY"',
    'grep -Fq -- "$COCKROACH_CLUSTER_ID"',
    "sha256sum managed-mcp-",
  ];
  for (const workflow of [standalone, deployJob]) {
    for (const fragment of exactGateFragments) {
      assert.ok(workflow.includes(fragment), fragment);
    }
    const receipt = workflow.indexOf("npm run --silent mcp:cloud:audit");
    const apiKeyCheck = workflow.indexOf(
      'grep -Fq -- "$CCLOUD_API_KEY"'
    );
    const clusterIdCheck = workflow.indexOf(
      'grep -Fq -- "$COCKROACH_CLUSTER_ID"'
    );
    const exactJqGate = workflow.indexOf(
      '--arg database "$COCKROACH_DATABASE"'
    );
    assert.ok(receipt >= 0);
    assert.ok(receipt < apiKeyCheck);
    assert.ok(receipt < clusterIdCheck);
    assert.ok(apiKeyCheck < exactJqGate);
    assert.ok(clusterIdCheck < exactJqGate);
    const install = workflow.indexOf("npm ci --ignore-scripts");
    const secret = workflow.indexOf(
      "CCLOUD_API_KEY: ${{ secrets.CCLOUD_API_KEY }}"
    );
    assert.ok(install >= 0);
    assert.ok(secret > install);
    assert.ok(secret < receipt);
    assert.equal(
      (
        workflow.match(
          /CCLOUD_API_KEY: \$\{\{ secrets\.CCLOUD_API_KEY \}\}/gu
        ) ?? []
      ).length,
      1
    );
    assert.match(workflow, /persist-credentials: false/u);
    assert.match(
      workflow,
      /\.schemaVersion == 6[\s\S]*?\(\.runtimes \| length\) == 2[\s\S]*?\(\[\.runtimes\[\]\.environment\] \| sort\) ==[\s\S]*?\["production", "staging"\][\s\S]*?databaseMatrixSha256\] \|[\s\S]*?unique \| length\) == 2[\s\S]*?all\(\.runtimes\[\];[\s\S]*?archon_staging_[a-z0-9{}\[\],^-]+[\s\S]*?archon_production_[a-z0-9{}\[\],^-]+[\s\S]*?\.clusterGrantProof\.routineGrantCount == 2[\s\S]*?\.clusterGrantProof\.databaseGrantCount == 5[\s\S]*?\.clusterGrantProof\.databaseInventory ==[\s\S]*?\["archon", "defaultdb", "postgres", "system"\][\s\S]*?\.clusterGrantProof\.databaseGrantMatrix == \[[\s\S]*?"databaseName":"archon","grantee":\.principal,"privilegeType":"CONNECT","isGrantable":false[\s\S]*?"databaseName":"defaultdb","grantee":"public","privilegeType":"TEMPORARY","isGrantable":false[\s\S]*?"databaseName":"postgres","grantee":"public","privilegeType":"TEMPORARY","isGrantable":false[\s\S]*?\.clusterGrantProof\.databaseMatrixSha256/u
    );
    assert.match(
      workflow,
      /for runtime_environment in staging production; do[\s\S]*?expected_matrix_sha="\$\(jq -er[\s\S]*?\.clusterGrantProof\.databaseMatrixSha256[\s\S]*?matrix_json="\$\(jq -cer[\s\S]*?\.clusterGrantProof\.databaseGrantMatrix[\s\S]*?actual_matrix_sha="\$\(printf '%s' "\$matrix_json"[\s\S]*?sha256sum[\s\S]*?test "\$actual_matrix_sha" = "\$expected_matrix_sha"/u
    );
  }
  assert.match(
    standalone,
    /- name: Upload the sanitized proof receipt[\s\S]*?if: success\(\)[\s\S]*?if-no-files-found: error[\s\S]*?retention-days: 90/u
  );
  assert.match(
    deployJob,
    /needs:\s*\r?\n      - database-release/u
  );
  assert.match(
    deployJob,
    /database-release-\$\{\{\s*github\.sha\s*\}\}/u
  );
  assert.match(
    deployJob,
    /receipt_sha256:\s*\$\{\{\s*steps\.receipt\.outputs\.receipt_sha256\s*\}\}/u
  );
  const stagingJob = deploy.match(
    /(?:^|\r?\n)  deploy-staging:\r?\n[\s\S]*?(?=\r?\n  [A-Za-z0-9_-]+:\r?\n|$)/u
  )?.[0];
  const productionJob = deploy.match(
    /(?:^|\r?\n)  deploy-production:\r?\n[\s\S]*?(?=\r?\n  [A-Za-z0-9_-]+:\r?\n|$)/u
  )?.[0];
  assert.ok(stagingJob);
  assert.ok(productionJob);
  assert.match(stagingJob, /- managed-mcp-production-audit/u);
  assert.match(productionJob, /- managed-mcp-production-audit/u);
  for (const evidencePath of [
    "../README.md",
    "../docs/TOOLS.md",
    "../docs/MANAGED_MCP_SMOKE.md",
  ]) {
    const evidence = readFileSync(
      new URL(evidencePath, import.meta.url),
      "utf8"
    );
    assert.match(evidence, /actions\/runs\/30204081177/u);
    assert.match(
      evidence,
      /a2b69e3fad31010d14d0c3bca261421e635ca885/u
    );
    assert.doesNotMatch(
      evidence,
      /had not yet been recorded|becomes live evidence only|awaits a new protected|new protected pass is required/iu
    );
  }
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
  assert.match(workflow, /\.schemaVersion == 6/u);
  assert.match(workflow, /\.proofs\.durableStoreIntegrity == true/u);
  assert.match(workflow, /\.proofs\.canonicalActiveMemories == 9/u);
  assert.match(workflow, /\.proofs\.distinctIdempotencyKeys == 9/u);
  assert.match(workflow, /\.proofs\.distinctContentDigests == 9/u);
  assert.match(workflow, /COCKROACH_SQL_DNS/u);
  assert.match(workflow, /regions\[\]/u);
  assert.match(workflow, /sql_dns/u);
  assert.ok(
    workflow.indexOf("db:endpoint:verify") <
      workflow.indexOf("npm run db:schema"),
  );
  assert.match(
    workflow,
    /\.cockroachCloud\.sqlEndpointBinding\.boundUrlCount == 3/u,
  );
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
  assert.match(verifier, /schemaVersion: 6/u);
  assert.match(verifier, /assertCockroachEndpointBinding/u);
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
  assert.equal(
    evaluate().checks.find(
      (check) => check.id === "tech.runtime-resolution-release-gate"
    )?.status,
    "pass"
  );
  assert.match(workflow, /\.proofs\.memoryResolutionLoop == true/u);
  assert.match(
    workflow,
    /\.proofs\.runtimeResolutionEnvironmentCount == 2/u
  );
  assert.match(workflow, /\.proofs\.resolutionSandbox\.tables == 5/u);
  assert.match(workflow, /\.proofs\.resolutionSandbox\.rlsPolicies == 15/u);
  assert.match(
    workflow,
    /\.proofs\.resolutionSandbox\.ttlSchedule ==\s*\n?\s*"0 \*\/4 \* \* \*"/u
  );
  assert.match(
    workflow,
    /\.proofs\.resolutionSandbox\.ttlClusterEnabled == true/u
  );
  assert.match(
    workflow,
    /\.proofs\.resolutionSandbox\.ttlScheduleStatus == "ACTIVE"/u
  );
  assert.match(workflow, /\.proofs\.resolutionSandbox\.ttlPaused == false/u);
  assert.match(
    workflow,
    /\.proofs\.resolutionSandbox\.writerRelationGrantCount == 5/u
  );
  assert.match(
    workflow,
    /\.proofs\.resolutionSandbox\.transitionOwnerRelationGrantCount == 13/u
  );
  assert.match(
    workflow,
    /\.proofs\.resolutionSandbox\.transitionFunctionCount == 2/u
  );
  assert.match(
    workflow,
    /\.proofs\.resolutionSandbox\.writerFunctionExecuteCount == 2/u
  );
  assert.match(
    workflow,
    /\.proofs\.resolutionSandbox\.directRuntimeDml == "none"/u
  );
  for (const resolutionProof of [
    ".resolutionLoop.databaseEnforcedTransitions == true",
    ".resolutionLoop.exactTransitionFunctionExecute == true",
    ".resolutionLoop.directResolutionDmlDenied == true",
    ".resolutionLoop.approvePath == true",
    ".resolutionLoop.rejectPath == true",
    ".resolutionLoop.idempotentReplay == true",
    ".resolutionLoop.conflictingFinalDecisionRejected == true",
    ".resolutionLoop.receiptVerified == true",
    ".resolutionLoop.receiptDatabaseDerived == true",
    ".resolutionLoop.consolidationVerified == true",
    ".resolutionLoop.canonicalMemoryUnchanged == true",
    ".resolutionLoop.immutableDecisionTables == true",
    ".resolutionLoop.deletePrivilegeAbsent == true",
  ]) {
    assert.ok(workflow.includes(resolutionProof), resolutionProof);
  }
  assert.match(
    verifier,
    /SHOW SYSTEM GRANTS FOR archon_resolution_writer/u
  );
  assert.match(
    verifier,
    /verifyExactResolutionRelationGrants\(\s*client,\s*"archon_resolution_writer",\s*RESOLUTION_WRITER_GRANTS/u
  );
  assert.match(verifier, /SHOW GRANTS ON FUNCTION \$\{routine\.signature\}/u);
  const clusterGrantProof = readFileSync(
    new URL("../src/db/cluster-grant-proof.ts", import.meta.url),
    "utf8"
  );
  const systemGrantContract = readFileSync(
    new URL("../src/db/system-grants.ts", import.meta.url),
    "utf8"
  );
  const ci = readFileSync(
    new URL("../.github/workflows/ci.yml", import.meta.url),
    "utf8"
  );
  const applySchemaVerifier = readFileSync(
    new URL("../scripts/apply-schema.ts", import.meta.url),
    "utf8"
  );
  const migrationRehearsalVerifier = readFileSync(
    new URL("../scripts/schema-migration-rehearsal.ts", import.meta.url),
    "utf8"
  );
  const runtimeRotationVerifier = readFileSync(
    new URL("../scripts/rotate-runtime-secret.ts", import.meta.url),
    "utf8"
  );
  const runtimeProvisioningVerifier = readFileSync(
    new URL("../scripts/provision-runtime-secret.ts", import.meta.url),
    "utf8"
  );
  for (const [principalGrantVerifier, expectedProofCalls] of [
    [verifier, 2],
    [applySchemaVerifier, 1],
    [migrationRehearsalVerifier, 1],
    [runtimeRotationVerifier, 1],
    [runtimeProvisioningVerifier, 1],
  ] as const) {
    assert.equal(
      (
        principalGrantVerifier.match(
          /verifyClusterWideResolutionGrants\(\{/gu
        ) ?? []
      ).length,
      expectedProofCalls
    );
  }
  assert.match(clusterGrantProof, /const proofClient = new Client\(\{/u);
  assert.doesNotMatch(clusterGrantProof, /SET database = ''/u);
  assert.match(
    clusterGrantProof,
    /const databaseNames = await enumerateDatabases\(proofClient\)[\s\S]*?for \(const databaseName of databaseNames\)[\s\S]*?SET DATABASE = \$\{databaseSql\}/u
  );
  assert.match(clusterGrantProof, /SELECT current_database\(\) AS database_name/u);
  assert.match(
    clusterGrantProof,
    /selectedDatabase\.rows\[0\]\?\.database_name !== databaseName/u
  );
  assert.match(
    clusterGrantProof,
    /SHOW GRANTS FOR \$\{principalSql\}[\s\S]*?scopedGrants\.rows\.filter\([\s\S]*?grant\.object_type === "routine"[\s\S]*?routineGrants\.push/u
  );
  assert.match(
    clusterGrantProof,
    /archon_resolution_create_session\(text, uuid, uuid, uuid, uuid, timestamptz, int8\)/u
  );
  assert.match(
    clusterGrantProof,
    /archon_resolution_decide\(text, text, uuid, uuid, uuid, timestamptz\)/u
  );
  assert.match(
    clusterGrantProof,
    /routineRows\.length !== expectedRoutineKeys\.size/u
  );
  assert.match(
    clusterGrantProof,
    /COCKROACH_BUILTIN_PUBLIC_DATABASE_GRANTS[\s\S]*?databaseName: "defaultdb"[\s\S]*?privilegeType: "CONNECT"[\s\S]*?databaseName: "defaultdb"[\s\S]*?privilegeType: "TEMPORARY"[\s\S]*?databaseName: "postgres"[\s\S]*?privilegeType: "CONNECT"[\s\S]*?databaseName: "postgres"[\s\S]*?privilegeType: "TEMPORARY"/u
  );
  assert.match(
    clusterGrantProof,
    /\}>\("SHOW DATABASES"\)[\s\S]*?\.map\(\(row\) => row\.database_name\)[\s\S]*?\.sort\(\)/u
  );
  assert.doesNotMatch(clusterGrantProof, /FROM \[SHOW (?:GRANTS|DATABASES)/u);
  assert.match(
    clusterGrantProof,
    /SHOW GRANTS ON DATABASE \$\{databaseSql\} FOR \$\{principalSql\}/u
  );
  assert.match(
    clusterGrantProof,
    /JSON\.stringify\(finalDatabaseInventory\)[\s\S]*?JSON\.stringify\(databaseNames\)/u
  );
  assert.match(
    clusterGrantProof,
    /JSON\.stringify\(actualDatabaseInventory\)[\s\S]*?JSON\.stringify\(requiredDatabaseInventory\)/u
  );
  assert.match(clusterGrantProof, /databaseMatrixSha256: createHash\("sha256"\)/u);
  assert.match(
    clusterGrantProof,
    /Supplied runtime database privilege matrix is not canonical/u
  );
  assert.match(
    clusterGrantProof,
    /finally \{[\s\S]*?proofClient\.end\(\)\.catch/u
  );
  assert.match(
    ci,
    /CREATE DATABASE IF NOT EXISTS archon_migration[\s\S]*?db:migration:rehearsal[\s\S]*?DROP DATABASE archon_migration CASCADE[\s\S]*?DROP USER archon_migration_ci[\s\S]*?CREATE DATABASE archon_reconciliation[\s\S]*?db:memory:reconciliation:rehearsal[\s\S]*?DROP DATABASE archon_reconciliation CASCADE[\s\S]*?local:bootstrap/u
  );
  assert.equal(
    (ci.match(/CREATE DATABASE (?:IF NOT EXISTS )?archon_reconciliation/gu) ?? [])
      .length,
    1
  );
  assert.doesNotMatch(clusterGrantProof, /object_type = 'function'/u);
  assert.match(
    migrationRehearsalVerifier,
    /GRANT CONNECT ON DATABASE "\$\{databaseName\}" TO archon_migration_ci/u
  );
  assert.match(
    migrationRehearsalVerifier,
    /expectedDatabaseGrants: expectedRuntimeDatabaseGrants\(\s*databaseName,\s*"archon_migration_ci"\s*\)/u
  );
  assert.match(
    migrationRehearsalVerifier,
    /GRANT TEMPORARY ON DATABASE "\$\{databaseName\}" TO archon_migration_ci[\s\S]*?expectClusterGrantProofRejected[\s\S]*?REVOKE TEMPORARY ON DATABASE "\$\{databaseName\}" FROM archon_migration_ci/u
  );
  assert.match(
    migrationRehearsalVerifier,
    /GRANT CONNECT ON DATABASE "\$\{databaseName\}" TO archon_migration_ci WITH GRANT OPTION[\s\S]*?expectClusterGrantProofRejected[\s\S]*?REVOKE CONNECT ON DATABASE "\$\{databaseName\}" FROM archon_migration_ci[\s\S]*?GRANT CONNECT ON DATABASE "\$\{databaseName\}" TO archon_migration_ci/u
  );
  assert.match(
    migrationRehearsalVerifier,
    /CREATE DATABASE archon_unexpected_grants_ci[\s\S]*?REVOKE CONNECT, TEMPORARY ON DATABASE archon_unexpected_grants_ci FROM public[\s\S]*?expectClusterGrantProofRejected[\s\S]*?Cluster-wide grant proof could not bind the exact database inventory\.[\s\S]*?DROP DATABASE archon_unexpected_grants_ci CASCADE/u
  );
  assert.match(
    migrationRehearsalVerifier,
    /appTemporaryGrantDriftRejected:\s*true/u
  );
  assert.match(
    migrationRehearsalVerifier,
    /databaseGrantOptionDriftRejected:\s*true/u
  );
  assert.match(
    migrationRehearsalVerifier,
    /extraDatabaseGrantDriftRejected:\s*true/u
  );
  for (const runtimeVerifier of [
    verifier,
    runtimeRotationVerifier,
    runtimeProvisioningVerifier,
  ]) {
    assert.match(
      runtimeVerifier,
      /expectedDatabaseGrants: expectedRuntimeDatabaseGrants\(\s*database(?:Name|Raw),\s*(?:principal|appUserRaw)\s*\)/u
    );
    assert.match(runtimeVerifier, /privilegedRuntimeRoleOptions/u);
    assert.match(runtimeVerifier, /runtimeLoginIsDisabled/u);
    assert.match(runtimeVerifier, /runtimeRoleOptionsAreCanonical/u);
    assert.match(runtimeVerifier, /affirmativeSystemGrants/u);
  }
  for (const option of [
    "ADMIN",
    "BYPASSRLS",
    "CANCELQUERY",
    "CONTROLCHANGEFEED",
    "CONTROLJOB",
    "CREATEDB",
    "CREATELOGIN",
    "CREATEROLE",
    "MODIFYCLUSTERSETTING",
    "PROVISIONSRC",
    "REPLICATION",
    "SUBJECT",
    "VIEWACTIVITY",
    "VIEWACTIVITYREDACTED",
    "VIEWCLUSTERSETTING",
  ]) {
    assert.ok(systemGrantContract.includes(`"${option}"`), option);
  }
  assert.match(systemGrantContract, /export function privilegedRuntimeRoleOptions/u);
  assert.match(systemGrantContract, /export function runtimeLoginIsDisabled/u);
  assert.match(
    systemGrantContract,
    /export function runtimeRoleOptionsAreCanonical/u
  );
  assert.match(
    runtimeProvisioningVerifier,
    /SHOW SYSTEM GRANTS FOR \$\{appUser\}/u
  );
  for (const runtimeVerifier of [verifier, runtimeRotationVerifier]) {
    assert.match(
      runtimeVerifier,
      /SHOW GRANTS ON DATABASE \$\{databaseSql\} FOR \$\{principalSql\}[\s\S]*?databaseGrants\.rows\.length !== 1[\s\S]*?grant\.database_name !== databaseName[\s\S]*?grant\.grantee !== principal/u
    );
  }
  assert.match(
    workflow,
    /\.proofs\.runtimeFunctionPrivilegeMatrix ==\s*\n?\s*"cluster-wide EXECUTE only on the two canonical resolution routine signatures"/u
  );
  assert.match(
    workflow,
    /\.proofs\.runtimeDatabasePrivilegeMatrix ==\s*\n?\s*"cluster-wide exact five-row non-grantable matrix: public CONNECT\+TEMPORARY on defaultdb\/postgres; runtime principal CONNECT on archon; zero system rows"/u
  );
  assert.match(
    workflow,
    /\.proofs\.runtimeSystemPrivileges ==\s*\n?\s*"exact-empty runtime role options; no affirmative system grants"/u
  );
  assert.match(workflow, /\.clusterGrantProof\.routineGrantCount == 2/u);
  assert.match(workflow, /\.clusterGrantProof\.databaseGrantCount == 5/u);
  assert.match(
    workflow,
    /\.clusterGrantProof\.databaseInventory ==\s*\n?\s*\["archon", "defaultdb", "postgres", "system"\]/u
  );
  assert.match(workflow, /\.clusterGrantProof\.databaseMatrixSha256/u);
  assert.match(
    workflow,
    /\[\.runtimes\[\]\.clusterGrantProof\.databaseMatrixSha256\][\s\S]*?unique \| length\) == 2/u
  );
  assert.match(
    workflow,
    /\.clusterGrantProof\.databaseGrantMatrix == \[[\s\S]*?"databaseName":"archon","grantee":\.principal,"privilegeType":"CONNECT","isGrantable":false[\s\S]*?"databaseName":"defaultdb","grantee":"public","privilegeType":"TEMPORARY","isGrantable":false[\s\S]*?"databaseName":"postgres","grantee":"public","privilegeType":"TEMPORARY","isGrantable":false/u
  );
  assert.match(
    workflow,
    /for runtime_environment in staging production; do[\s\S]*?expected_matrix_sha="\$\(jq -er[\s\S]*?\.clusterGrantProof\.databaseMatrixSha256[\s\S]*?matrix_json="\$\(jq -cer[\s\S]*?\.clusterGrantProof\.databaseGrantMatrix[\s\S]*?actual_matrix_sha="\$\(printf '%s' "\$matrix_json"[\s\S]*?sha256sum[\s\S]*?test "\$actual_matrix_sha" = "\$expected_matrix_sha"/u
  );
  const deploy = readFileSync(
    new URL("../.github/workflows/deploy-aws.yml", import.meta.url),
    "utf8"
  );
  assert.match(
    deploy,
    /\.schemaVersion == 6[\s\S]*?all\(\.runtimes\[\];[\s\S]*?\.clusterGrantProof\.databaseGrantCount == 5[\s\S]*?\.clusterGrantProof\.databaseInventory ==[\s\S]*?\["archon", "defaultdb", "postgres", "system"\][\s\S]*?\.clusterGrantProof\.databaseMatrixSha256/u
  );
  assert.match(verifier, /sql\.ttl\.job\.enabled/u);
  assert.match(verifier, /SHOW SCHEDULES/u);
});

test("readiness: the staging fault-injection recovery path is independently gated", () => {
  const check = evaluate().checks.find(
    (candidate) =>
      candidate.id === "product.staging-fault-injected-recovery"
  );
  assert.ok(check);
  assert.equal(check.criterion, "Production Readiness");
  assert.equal(check.status, "pass", check.detail);
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
  assert.equal(hasExactHostedSmokeContracts(workflow), true);

  for (const [index, block] of smokeBlocks.entries()) {
    assert.ok(block, `AWS smoke block ${index + 1} must exist`);
    assert.match(block, /-X POST "\$APPLICATION_URL\/api\/recall"/u);
    assert.ok(block.includes(safeStatusGate));
    for (const contract of [
      ".database.activeMemories == 9",
      ".memory.persisted == 9",
      ".memory.idempotencyKeys == 9",
      ".memory.contentDigests == 9",
      ".memory.storeVerified == true",
      '.memory.evidence == "live bounded fixed-scope payload-digest verification"',
      ".resolutionLoop.enabled == true",
      ".resolutionLoop.schemaTables == 5",
      ".resolutionLoop.activeSandboxSessions |",
      '.resolutionLoop.transactionIsolation == "SERIALIZABLE"',
      '.resolutionLoop.authorityBoundary ==',
      '"financial-controller-human-gate"',
      '.resolutionLoop.identityAssurance ==',
      '"fixed-demo-role-assertion-not-authenticated"',
      '.resolutionLoop.idempotency ==',
      '"decision-key+database-unique-constraint"',
      '.resolutionLoop.receipt ==',
      '"SHA-256 immutable decision record"',
      '.resolutionLoop.learning ==',
      '"conflict-observation+human-decision"',
      '.resolutionLoop.consolidation ==',
      '"versioned current/superseded state"',
      '.resolutionLoop.forgetting == "CockroachDB row-level TTL"',
      ".resolutionLoop.canonicalMemoryMutable == false",
      '.resolutionLoop.externalSideEffects == "none"',
      '.resolutionLoop.evidence ==',
      '"live fixed-scope sandbox schema query"',
      "(.citations | length) >= 2",
      "(.citations | length) <= 5",
      ".recalled == (.citations | length)",
      '(.answer | contains("€15,375"))',
      '(.answer | contains("€6,775"))',
      ".modelId == $narrator",
      '.trace.retrieval.requestedKind == "payroll_event"',
      ".trace.retrieval.requestedTopK == 5",
      ".answer as $answer |",
      "all(.citations[].marker;",
      "([.citations[].marker] ==",
      "([.citations[].memoryId] | unique | length) == (.citations | length)",
      ".report.audited == 9",
      '.report.contradictions[0].resolution.rule == "importance"',
      '.report.absences[0].subject == "PAY-118"',
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

  for (const mutation of [
    workflow.replaceAll(
      '.status == "reachable"',
      '.status == "degraded"'
    ),
    workflow.replace(
      '.database.database == "archon"',
      '.database.database == "other"'
    ),
    workflow.replace(
      ".trace.retrieval.requestedTopK == 5",
      ".trace.retrieval.requestedTopK == 4"
    ),
    workflow.replace(
      '.report.contradictions[0].resolution.rule == "importance"',
      '.report.contradictions[0].resolution.rule == "recency"'
    ),
    workflow.replace(
      'test("^archon_production_[0-9a-f]{10}$")',
      'test("^archon_production_.+$")'
    ),
  ]) {
    assert.equal(hasExactHostedSmokeContracts(mutation), false);
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
    assert.match(
      block,
      /trap (?:stop_canary_probe|cleanup_deploy_background) EXIT/u
    );
    assert.match(block, /while true; do/u);
    assert.match(block, /\$CANARY_URL\/api\/proof/u);
    assert.match(block, /\$CANARY_URL\/api\/recall/u);
    assert.match(
      block,
      /sam deploy[\s\S]*?--no-progressbar[\s\S]*?stop_canary_probe[\s\S]*?trap - EXIT/u
    );
  }
  assert.match(
    canaryBlocks[0]!,
    /cleanup_deploy_background\(\)[\s\S]*?stop_canary_probe[\s\S]*?stop_drill_observer/u
  );
  assert.match(canaryBlocks[1]!, /trap stop_canary_probe EXIT/u);
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

test("readiness: exact-SHA supply-chain evidence and candidate provenance gate promotion", () => {
  const reportCheck = evaluate().checks.find(
    (candidate) =>
      candidate.id === "tech.pipeline-owned-supply-chain-evidence"
  );
  assert.ok(reportCheck);
  assert.equal(reportCheck.criterion, "Technical Implementation");
  assert.equal(reportCheck.status, "pass", reportCheck.detail);

  const supplyChain = readFileSync(
    new URL("../.github/workflows/supply-chain.yml", import.meta.url),
    "utf8"
  );
  const deploy = readFileSync(
    new URL("../.github/workflows/deploy-aws.yml", import.meta.url),
    "utf8"
  );
  const waivers = readFileSync(
    new URL("../security/waivers.yml", import.meta.url),
    "utf8"
  );
  const trivyIacCompatibilityValidator = readFileSync(
    new URL(
      "../.github/scripts/validate-trivy-iac-compatibility.mjs",
      import.meta.url
    ),
    "utf8"
  );
  const trivySbomPolicyValidator = readFileSync(
    new URL(
      "../.github/scripts/validate-trivy-sbom-policy.mjs",
      import.meta.url
    ),
    "utf8"
  );
  const policyEffectiveTrivy = supplyChain.match(
    /(?:^|\r?\n)      - name: Materialize policy-effective Trivy IaC SARIF\r?\n[\s\S]*?(?=\r?\n      - name: Upload policy-effective Trivy IaC SARIF\r?\n)/u
  )?.[0];
  const sourceGate = deploy.match(
    /(?:^|\r?\n)  source-gate:\r?\n[\s\S]*?(?=\r?\n  [A-Za-z0-9_-]+:\r?\n|$)/u
  )?.[0];
  const buildOnce = deploy.match(
    /(?:^|\r?\n)  build-once:\r?\n[\s\S]*?(?=\r?\n  [A-Za-z0-9_-]+:\r?\n|$)/u
  )?.[0];
  const databaseRelease = deploy.match(
    /(?:^|\r?\n)  database-release:\r?\n[\s\S]*?(?=\r?\n  [A-Za-z0-9_-]+:\r?\n|$)/u
  )?.[0];
  const managedMcp = deploy.match(
    /(?:^|\r?\n)  managed-mcp-production-audit:\r?\n[\s\S]*?(?=\r?\n  [A-Za-z0-9_-]+:\r?\n|$)/u
  )?.[0];
  const staging = deploy.match(
    /(?:^|\r?\n)  deploy-staging:\r?\n[\s\S]*?(?=\r?\n  [A-Za-z0-9_-]+:\r?\n|$)/u
  )?.[0];
  const production = deploy.match(
    /(?:^|\r?\n)  deploy-production:\r?\n[\s\S]*?(?=\r?\n  [A-Za-z0-9_-]+:\r?\n|$)/u
  )?.[0];
  for (const job of [
    sourceGate,
    buildOnce,
    databaseRelease,
    managedMcp,
    staging,
    production,
  ]) {
    assert.ok(job);
  }

  assert.match(
    sourceGate!,
    /name: Require successful exact-SHA Supply Chain evidence/u
  );
  assert.match(
    sourceGate!,
    /actions\/workflows\/supply-chain\.yml\/runs\?branch=main&event=push/u
  );
  assert.match(
    sourceGate!,
    /\.head_sha == \$sha[\s\S]*?\.head_branch == "main"[\s\S]*?\.event == "push"[\s\S]*?\.path == "\.github\/workflows\/supply-chain\.yml"/u
  );
  assert.match(
    buildOnce!,
    /run-id:\s*\$\{\{\s*needs\.source-gate\.outputs\.supply_chain_run_id\s*\}\}/u
  );
  assert.match(
    buildOnce!,
    /gh attestation verify "\$receipt"\s+\\\r?\n\s+--repo "\$GITHUB_REPOSITORY"/u
  );
  assert.match(
    buildOnce!,
    /blocking-zero-unwaived-findings/u
  );
  assert.match(buildOnce!, /waiverLedgerSha256/u);
  assert.match(
    buildOnce!,
    /name: Create exact-SHA candidate evidence binding[\s\S]*?schema: "archon\.aws-candidate\.evidence-binding"[\s\S]*?name: Attest immutable candidate tree and evidence binding[\s\S]*?subject-path: candidate-evidence-binding\.json/u
  );
  assert.match(
    databaseRelease!,
    /needs:\r?\n\s+- build-once/u
  );
  assert.match(managedMcp!, /needs:\r?\n\s+- database-release/u);
  assert.match(staging!, /- managed-mcp-production-audit/u);
  assert.match(production!, /- deploy-staging/u);
  assert.equal(
    (
      deploy.match(
        /name: Verify candidate, Supply Chain, and memory-evaluation provenance/gu
      ) ?? []
    ).length,
    2
  );
  assert.equal(
    (
      deploy.match(
        /gh attestation verify candidate-evidence-binding\.json/gu
      ) ?? []
    ).length,
    2
  );
  assert.equal(
    (
      deploy.match(
        /gh attestation verify supply-chain-release-receipt\.json/gu
      ) ?? []
    ).length,
    2
  );
  assert.match(
    supplyChain,
    /name: Bind exact-SHA supply-chain release evidence/u
  );
  assert.match(supplyChain, /^name: Supply Chain \(enforced\)$/mu);
  assert.doesNotMatch(supplyChain, /audit-first/u);
  assert.match(
    supplyChain,
    /schema: "archon\.supply-chain\.release-evidence"/u
  );
  assert.match(
    supplyChain,
    /mode: "blocking-zero-unwaived-findings"/u
  );
  assert.match(supplyChain, /acceptedWaivers: 0/u);
  assert.match(supplyChain, /unwaivedFindings: 0/u);
  assert.match(
    supplyChain,
    /name: Enforce zero-unwaived static findings/u
  );
  assert.match(
    supplyChain,
    /name: Enforce zero-unwaived infrastructure findings/u
  );
  assert.match(
    supplyChain,
    /name: Enforce zero-unwaived vulnerability and license findings/u
  );
  assert.match(supplyChain, /cfn-lint==1\.53\.1/u);
  assert.match(supplyChain, /sam validate[\s\S]*?--lint/u);
  assert.match(
    supplyChain,
    /for scope in backend frontend lambda-content/u
  );
  assert.match(supplyChain, /"lambdaContent":0/u);
  assert.match(supplyChain, /"lambdaContent":\s*"omitted-root-only"/u);
  assert.match(supplyChain, /"catalogedDependencyPackages":\s*0/u);
  assert.equal((supplyChain.match(/--exit-code 1/gu) ?? []).length, 1);
  assert.equal((supplyChain.match(/--exit-code 0/gu) ?? []).length >= 2, true);
  assert.match(
    supplyChain,
    /validate-trivy-iac-compatibility\.mjs[\s\S]*?--self-test/u
  );
  assert.match(
    supplyChain,
    /trivy-iac-compatibility-findings\.json/u
  );
  assert.match(
    supplyChain,
    /trivy-iac-blocking-findings\.json/u
  );
  assert.match(
    supplyChain,
    /name: Materialize policy-effective Trivy IaC SARIF/u
  );
  assert.ok(policyEffectiveTrivy);
  for (const contract of [
    '.rawFindings == 4',
    '.compatibilityFindings == 4',
    '.blockingFindings == 0',
    '.acceptedWaivers == 0',
    'map(.namespace) == [',
    '.logicalResource == $contract.logicalResource',
    '.scannerResource == $contract.scannerResource',
    '.startLine == $contract.sourceRange.startLine',
    '.endLine == $contract.sourceRange.endLine',
    '.sourceProperty == $contract.sourceProperty',
    '.reason == $contract.reason',
    '.controls == $contract.controls',
    'WebACLId: !Ref CloudFrontWebAclArn',
    'CloudFrontDefaultCertificate: true',
    'KMSMasterKeyID: Fn::ImportValue \\"${AppName}-storage-kms-key-arn\\"',
    'SSEAlgorithm: AES256',
    '"mandatoryWebAclParameter":true',
    '"customDomainAliases":false',
    '"foundationCustomerManagedKey":true',
    '"denyUnexpectedKeyWrites":true',
    '"legacyCloudFrontStandardLogging":true',
    '"sseS3Aes256":true',
    '"customerManagedKeyAbsent":true',
    '"denyInsecureTransport":true',
    '$location.artifactLocation.uri == $finding.target',
    '$location.region.startLine == $finding.startLine',
    '$location.region.endLine == $finding.endLine',
    '$location.region.startColumn == 1',
    '$location.region.endColumn == 1',
    '.results = [] |',
    '$run.results == []',
    '"rawFindings":4',
    '"compatibilityFindings":4',
    '"blockingFindings":0',
    '"acceptedWaivers":0',
    '"rawEvidence":"trivy-iac.sarif"',
  ]) {
    assert.ok(
      policyEffectiveTrivy.includes(contract),
      `policy-effective Trivy gate must retain ${contract}`
    );
  }
  assert.ok(
    policyEffectiveTrivy.includes(
      'raw_sha_before="$(sha256sum "$raw" | awk \'{print $1}\')"'
    )
  );
  assert.ok(
    policyEffectiveTrivy.includes(
      'test "$raw_sha_before" = "$(sha256sum "$raw" | awk \'{print $1}\')"'
    )
  );
  assert.match(
    policyEffectiveTrivy,
    /\(\$run\.results \| length\) == 4[\s\S]*?\$location\.artifactLocation\.uri ==\s+\$contract\.target[\s\S]*?\$location\.region\.startLine ==\s+\$contract\.sourceRange\.startLine[\s\S]*?\$location\.region\.endLine ==\s+\$contract\.sourceRange\.endLine/u
  );
  assert.match(
    policyEffectiveTrivy,
    /jq -e 'length == 0' "\$blocking" >\/dev\/null/u
  );
  assert.match(
    supplyChain,
    /name: Upload policy-effective Trivy IaC SARIF[\s\S]*?sarif_file: retrieved\/iac\/trivy-iac-policy\.sarif[\s\S]*?category: trivy\/iac/u
  );
  assert.doesNotMatch(
    supplyChain,
    /sarif_file: retrieved\/iac\/trivy-iac\.sarif/u
  );
  assert.match(supplyChain, /validate-trivy-sbom-policy\.mjs --self-test/u);
  assert.match(supplyChain, /trivy-sbom-compatibility-findings\.json/u);
  assert.match(supplyChain, /trivy-sbom-blocking-findings\.json/u);
  assert.match(
    supplyChain,
    /--version-file "\$REPORT_DIR\/trivy-version\.txt"/u
  );
  assert.match(supplyChain, /rawFindings == 4/u);
  assert.match(supplyChain, /compatibilityFindings == 4/u);
  assert.match(supplyChain, /rawFindings == 4/u);
  assert.match(supplyChain, /approvedBuildLicenseFindings == 4/u);
  assert.match(supplyChain, /blockingFindings == 0/u);
  assert.match(
    trivyIacCompatibilityValidator,
    /EXPECTED_SCANNER_VERSION = "0\.72\.0"/u
  );
  assert.match(
    trivyIacCompatibilityValidator,
    /ruleId: "AWS-0011"/u
  );
  assert.match(
    trivyIacCompatibilityValidator,
    /ruleId: "AWS-0013"/u
  );
  assert.match(
    trivyIacCompatibilityValidator,
    /ruleId: "AWS-0132"/u
  );
  assert.match(
    trivyIacCompatibilityValidator,
    /EXPECTED_TARGET = "aws\/template\.yaml"/u
  );
  assert.match(
    trivyIacCompatibilityValidator,
    /EXPECTED_BOOTSTRAP_TARGET = "aws\/bootstrap-oidc\.yaml"/u
  );
  assert.match(
    trivyIacCompatibilityValidator,
    /mandatoryWebAcl: true/u
  );
  assert.match(
    trivyIacCompatibilityValidator,
    /dynamicOriginSecret: true/u
  );
  assert.match(
    trivyIacCompatibilityValidator,
    /accessLogging: true/u
  );
  assert.match(
    trivyIacCompatibilityValidator,
    /foundationCustomerManagedKey: true/u
  );
  assert.match(trivyIacCompatibilityValidator, /keyRotation: true/u);
  assert.match(
    trivyIacCompatibilityValidator,
    /legacyCloudFrontStandardLogging: true/u
  );
  assert.match(trivyIacCompatibilityValidator, /sseS3Aes256: true/u);
  assert.match(
    trivyIacCompatibilityValidator,
    /customerManagedKeyAbsent: true/u
  );
  assert.match(
    trivyIacCompatibilityValidator,
    /captured Trivy version must be/u
  );
  assert.match(trivySbomPolicyValidator, /@csstools\/color-helpers/u);
  assert.match(trivySbomPolicyValidator, /lightningcss-linux-x64-musl/u);
  assert.match(trivySbomPolicyValidator, /license: "MIT-0"/u);
  assert.match(trivySbomPolicyValidator, /license: "MPL-2\.0"/u);
  assert.match(
    trivySbomPolicyValidator,
    /resolve\/test\/resolver\/invalid_main/u
  );
  assert.match(
    supplyChain,
    /name: Attest exact-SHA supply-chain release receipt[\s\S]*?actions\/attest-build-provenance@0f67c3f4856b2e3261c31976d6725780e5e4c373/u
  );
  assert.match(
    supplyChain,
    /name: supply-chain-release-\$\{\{\s*github\.sha\s*\}\}-\$\{\{\s*github\.run_id\s*\}\}-\$\{\{\s*github\.run_attempt\s*\}\}/u
  );
  assert.match(
    supplyChain,
    /audit_template edge-waf aws\/edge-waf\.yaml/u
  );
  assert.match(
    supplyChain,
    /audit_template finops aws\/finops\.yaml/u
  );
  assert.match(
    supplyChain,
    /lint_template finops aws\/finops\.yaml/u
  );
  assert.match(supplyChain, /iac\/guard-finops\.txt/u);
  assert.match(
    supplyChain,
    /"aws\/finops\.yaml"/u
  );
  assert.deepEqual(JSON.parse(waivers), {
    schema_version: 1,
    policy: "docs/SUPPLY_CHAIN_SECURITY.md",
    waivers: [],
  });
});

test("readiness: exact-SHA memory evaluation is a required candidate-bound check context", () => {
  const reportCheck = evaluate().checks.find(
    (candidate) =>
      candidate.id === "tech.exact-sha-memory-evaluation-gate"
  );
  assert.ok(reportCheck);
  assert.equal(reportCheck.criterion, "Technical Implementation");
  assert.equal(reportCheck.status, "pass", reportCheck.detail);

  const evaluation = readFileSync(
    new URL("../.github/workflows/memory-evaluation.yml", import.meta.url),
    "utf8"
  );
  const deploy = readFileSync(
    new URL("../.github/workflows/deploy-aws.yml", import.meta.url),
    "utf8"
  );
  const sourceGate = deploy.match(
    /(?:^|\r?\n)  source-gate:\r?\n[\s\S]*?(?=\r?\n  [A-Za-z0-9_-]+:\r?\n|$)/u
  )?.[0];
  const buildOnce = deploy.match(
    /(?:^|\r?\n)  build-once:\r?\n[\s\S]*?(?=\r?\n  [A-Za-z0-9_-]+:\r?\n|$)/u
  )?.[0];
  assert.ok(sourceGate);
  assert.ok(buildOnce);
  assert.match(evaluation, /^name: Memory architecture evaluation$/mu);
  assert.match(
    evaluation,
    /^    name: Longitudinal, scale, and C-SPANN evidence$/mu
  );
  assert.match(
    evaluation,
    /memory-evaluation-\$\{\{\s*env\.SOURCE_SHA\s*\}\}-\$\{\{\s*github\.run_id\s*\}\}-\$\{\{\s*github\.run_attempt\s*\}\}/u
  );
  assert.match(
    sourceGate!,
    /actions\/workflows\/memory-evaluation\.yml\/runs\?branch=main&event=push/u
  );
  assert.match(
    sourceGate!,
    /\.name ==\s*\r?\n\s+"Longitudinal, scale, and C-SPANN evidence"/u
  );
  assert.match(
    sourceGate!,
    /gh run download "\$run_id"[\s\S]*?memory-evaluation-receipt\.json/u
  );
  assert.match(sourceGate!, /actual_receipt_digest/u);
  assert.match(sourceGate!, /receipt_base64=/u);
  assert.match(
    buildOnce!,
    /name: Bind exact-SHA Memory architecture evaluation receipt/u
  );
  assert.match(
    buildOnce!,
    /memoryEvaluation:\s*\{[\s\S]*?memoryEvaluationReceiptSha256[\s\S]*?candidate-evidence-binding\.json/u
  );
  assert.equal(
    (deploy.match(/memory-evaluation-receipt\.json/gu) ?? []).length >= 8,
    true
  );
  assert.equal(
    (
      deploy.match(
        /name: Verify candidate, Supply Chain, and memory-evaluation provenance/gu
      ) ?? []
    ).length,
    2
  );
});

test("readiness: Well-Architected audit is repository-first and live-read-only approval gated", () => {
  const reportCheck = evaluate().checks.find(
    (candidate) =>
      candidate.id === "product.well-architected-evidence-contract"
  );
  assert.ok(reportCheck);
  assert.equal(reportCheck.criterion, "Production Readiness");
  assert.equal(reportCheck.status, "pass", reportCheck.detail);

  const workflow = readFileSync(
    new URL(
      "../.github/workflows/well-architected-audit.yml",
      import.meta.url
    ),
    "utf8"
  );
  const audit = readFileSync(
    new URL(
      "../.github/scripts/well-architected-contract-audit.mjs",
      import.meta.url
    ),
    "utf8"
  );
  const deploy = readFileSync(
    new URL("../.github/workflows/deploy-aws.yml", import.meta.url),
    "utf8"
  );
  const repositoryJob = workflow.match(
    /(?:^|\r?\n)  repository-contract:\r?\n[\s\S]*?(?=\r?\n  [A-Za-z0-9_-]+:\r?\n|$)/u
  )?.[0];
  const liveJob = workflow.match(
    /(?:^|\r?\n)  live-read-only:\r?\n[\s\S]*?(?=\r?\n  [A-Za-z0-9_-]+:\r?\n|$)/u
  )?.[0];
  assert.ok(repositoryJob);
  assert.ok(liveJob);
  assert.doesNotMatch(repositoryJob!, /id-token:\s*write/u);
  assert.doesNotMatch(repositoryJob!, /configure-aws-credentials/u);
  assert.match(
    liveJob!,
    /github\.event_name == 'workflow_dispatch' &&\r?\n\s+inputs\.mode == 'live-read-only'/u
  );
  assert.match(liveJob!, /environment:\r?\n\s+name: production-audit/u);
  assert.match(liveJob!, /test "\$AWS_REGION" = "eu-west-1"/u);
  assert.match(liveJob!, /test "\$FORBIDDEN_REGION" = "us-west-2"/u);
  assert.match(audit, /edge-waf-control-plane-boundary/u);
  assert.match(audit, /finops-control-plane-boundary/u);
  assert.match(audit, /wa04-edge-protection-control-plane-source/u);
  assert.match(audit, /wa05-database-credential-rotation-source/u);
  assert.match(audit, /wa06-fault-injected-recovery-source/u);
  assert.match(audit, /wa07-managed-backup-restore-source/u);
  assert.match(audit, /wa08-hosted-performance-evidence-source/u);
  assert.match(audit, /wa09-finops-controls-source/u);
  assert.match(audit, /AWS::Budgets::Budget/u);
  assert.match(audit, /AWS::CE::AnomalyMonitor/u);
  assert.match(audit, /AWS::CE::AnomalySubscription/u);
  assert.match(audit, /explicit-live-activation-required/u);
  assert.match(audit, /not an application workload region/u);
  assert.equal(
    (workflow.match(/- "aws\/edge-waf\.yaml"/gu) ?? []).length,
    2
  );
  assert.equal(
    (workflow.match(/- "aws\/finops\.yaml"/gu) ?? []).length,
    2
  );
  assert.equal(
    (
      workflow.match(
        /- "\.github\/workflows\/edge-controls\.yml"/gu
      ) ?? []
    ).length,
    2
  );
  assert.equal(
    (
      workflow.match(/- "tests\/staging-recovery-drill\.test\.ts"/gu) ??
      []
    ).length,
    2
  );
  assert.equal(
    (
      workflow.match(
        /- "aws\/fetch-codedeploy-appspec-revision\.sh"/gu
      ) ?? []
    ).length,
    2
  );
  assert.equal(
    (
      workflow.match(
        /- "aws\/select-staging-codedeploy-rollback\.mjs"/gu
      ) ?? []
    ).length,
    2
  );
  assert.doesNotMatch(
    deploy,
    /cloudformation deploy[\s\S]*?--template-file aws\/edge-waf\.yaml/u
  );
  assert.doesNotMatch(
    deploy,
    /cloudformation deploy[\s\S]*?--template-file aws\/finops\.yaml/u
  );
});

test("readiness: WA-10 sustainability intensity evidence is pipeline-owned and claim-safe", () => {
  const reportCheck = evaluate().checks.find(
    (candidate) =>
      candidate.id === "product.sustainability-intensity-evidence"
  );
  assert.ok(reportCheck);
  assert.equal(reportCheck.criterion, "Production Readiness");
  assert.equal(reportCheck.status, "pass", reportCheck.detail);

  const workflow = readFileSync(
    new URL(
      "../.github/workflows/sustainability-intensity-evidence.yml",
      import.meta.url
    ),
    "utf8"
  );
  const script = readFileSync(
    new URL(
      "../aws/measure-sustainability-intensity.sh",
      import.meta.url
    ),
    "utf8"
  );
  assert.match(workflow, /environment:\s+sustainability-audit/u);
  assert.match(workflow, /hosted_load_receipt_sha256/u);
  assert.match(workflow, /comparison_mode == 'compare'/u);
  assert.match(script, /successful_recalls/u);
  assert.match(script, /equivalence_digest/u);
  assert.match(script, /rawResponsesUploaded:\s+false/u);
  assert.match(script, /emissionsMeasured:\s+false/u);
  assert.doesNotMatch(script, /--region us-west-2/u);
});

test("readiness: WA-05 rotation is behaviorally proved and failure-actionable", () => {
  const reportCheck = evaluate().checks.find(
    (candidate) => candidate.id === "product.database-credential-rotation"
  );
  assert.ok(reportCheck);
  assert.equal(reportCheck.criterion, "Production Readiness");
  assert.equal(reportCheck.status, "pass", reportCheck.detail);

  const source = readFileSync(
    new URL("../scripts/readiness.ts", import.meta.url),
    "utf8"
  );
  assert.match(source, /ROTATION_INTERRUPTED_STATE_UNKNOWN/u);
  assert.match(source, /lost Put response reconciles/u);
  assert.match(source, /lost Update response requires exact current observation/u);
  assert.match(source, /concurrent fake-pg refresh coalesces/u);
  assert.match(source, /failed fake-pg candidate never replaces/u);
});

test("readiness: both CloudFormation roles have scoped transform, HTTP API tag, and drift-discovery permissions", () => {
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
  const stagingResourcePolicy = bootstrap.match(
    /  StagingCloudFormationResourcePolicy:[\s\S]*?\n  ProductionCloudFormationResourcePolicy:/u
  )?.[0];
  const productionResourcePolicy = bootstrap.match(
    /  ProductionCloudFormationResourcePolicy:[\s\S]*?\n  CloudFormationCommonExecutionPolicy:/u
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
  assert.match(commonPolicy, /- codedeploy:ListDeployments$/mu);
  const stagingCodeDeployInspection = bootstrap.match(
    /  StagingCodeDeployInspectionPolicy:[\s\S]*?\n  StagingAlarmRoutingInspectionPolicy:/u
  )?.[0];
  assert.ok(stagingCodeDeployInspection);
  const stagingInspectionActions = [
    ...stagingCodeDeployInspection.matchAll(
      /(?:Action:\s+|- )(codedeploy:[A-Za-z]+)$/gmu
    ),
  ].map((match) => match[1]).sort();
  assert.deepEqual(stagingInspectionActions, [
    "codedeploy:GetApplicationRevision",
    "codedeploy:GetDeployment",
    "codedeploy:GetDeploymentGroup",
    "codedeploy:ListDeployments",
  ]);
  assert.match(
    stagingCodeDeployInspection,
    /application:\$\{AppName\}-staging-\*/u
  );
  assert.match(
    stagingCodeDeployInspection,
    /deploymentgroup:\$\{AppName\}-staging-\*\/\*/u
  );
  assert.doesNotMatch(stagingCodeDeployInspection, /Resource: "\*"/u);
  assert.match(commonPolicy, /- logs:DescribeIndexPolicies$/mu);
  assert.ok(stagingResourcePolicy);
  assert.match(
    stagingResourcePolicy,
    /- Sid: StagingLambda[\s\S]*?- lambda:GetProvisionedConcurrencyConfig[\s\S]*?Resource: !Sub "arn:\$\{AWS::Partition\}:lambda:\$\{AWS::Region\}:\$\{AWS::AccountId\}:function:\$\{AppName\}-staging-\*"/u
  );
  assert.ok(productionResourcePolicy);
  assert.match(
    productionResourcePolicy,
    /- Sid: ProductionLambda[\s\S]*?- lambda:GetProvisionedConcurrencyConfig[\s\S]*?Resource: !Sub "arn:\$\{AWS::Partition\}:lambda:\$\{AWS::Region\}:\$\{AWS::AccountId\}:function:\$\{AppName\}-production-\*"/u
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
  const ci = readFileSync(
    new URL("../.github/workflows/ci.yml", import.meta.url),
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
  const recoverySnapshot = readFileSync(
    new URL("../aws/prove-recovery-snapshot.sh", import.meta.url),
    "utf8"
  );

  assert.match(template, /^  ArchonHttpApi:$/mu);
  assert.doesNotMatch(template, /^  ServerlessHttpApi:$/mu);
  assert.match(
    template,
    /HttpApiStageName:\s+Type:\s+String\s+Default:\s+live\s+AllowedValues:\s+- live/u
  );
  assert.match(template, /StageName:\s+!Ref HttpApiStageName/u);
  assert.match(
    template,
    /OriginPath:\s*!Join\s*\["",\s*\["\/",\s*!Ref ArchonHttpApi\.Stage\]\]/u
  );
  assert.match(
    template,
    /DefaultRouteSettings:\s+DetailedMetricsEnabled:\s+true\s+ThrottlingBurstLimit:\s+!Ref ApiThrottleBurst\s+ThrottlingRateLimit:\s+!Ref ApiThrottleRate/u
  );
  assert.match(
    template,
    /ReservedConcurrency:\s+Type:\s+Number[\s\S]*?Default:\s+5[\s\S]*?ApiThrottleRate:\s+Type:\s+Number[\s\S]*?Default:\s+5/u
  );
  assert.match(
    template,
    /ReservedConcurrentExecutions:\s+!Ref ReservedConcurrency/u
  );
  assert.equal(
    (workflow.match(/--arg reservedConcurrency "5"/gu) ?? []).length,
    6
  );
  assert.equal(
    (
      workflow.match(
        /and \.ReservedConcurrency == \$reservedConcurrency/gu
      ) ?? []
    ).length,
    2
  );
  assert.equal(
    (
      workflow.match(
        /select\(\.ParameterKey == "ReservedConcurrency"\)\s+\| \.ParameterValue\] == \[\$reservedConcurrency\]/gu
      ) ?? []
    ).length,
    2
  );
  assert.match(
    template,
    /ReleaseCommitSha:\s+Type:\s+String[\s\S]*?AllowedPattern: "\^\[0-9a-f\]\{40\}\$"/u
  );
  assert.match(template, /RELEASE_COMMIT_SHA:\s+!Ref ReleaseCommitSha/u);
  assert.equal(
    (workflow.match(/ReleaseCommitSha: \$releaseCommitSha/gu) ?? []).length,
    2
  );
  assert.equal(
    (
      workflow.match(
        /select\(\.ParameterKey == "ReleaseCommitSha"\)\s+\| \.ParameterValue\] == \[\$releaseCommitSha\]/gu
      ) ?? []
    ).length,
    2
  );
  assert.equal(
    (
      workflow.match(
        /\.release\.commitSha == \$releaseCommitSha and\s+\.release\.evidence == "server-configured Lambda environment"/gu
      ) ?? []
    ).length,
    2
  );
  assert.match(
    workflow,
    /test\("\^archon_staging_\[0-9a-f\]\{10\}\$"\)/u
  );
  assert.match(
    workflow,
    /test\("\^archon_production_\[0-9a-f\]\{10\}\$"\)/u
  );
  for (const fragment of [
    '.database.engine == "CockroachDB"',
    '.database.deployment == "CockroachDB Cloud on AWS"',
    '.database.role == "persistent agent memory"',
    '.database.transactionIsolation == "SERIALIZABLE"',
    '.database.database == "archon"',
    '.vectorIndex.engine == "native CockroachDB C-SPANN"',
    '.vectorIndex.prefixes == ["tenant_id","embed_model","status","company"]',
    ".resolutionLoop.enabled == true",
    ".resolutionLoop.schemaTables == 5",
    '.resolutionLoop.transactionIsolation == "SERIALIZABLE"',
    '.resolutionLoop.authorityBoundary ==',
    '"financial-controller-human-gate"',
    '.resolutionLoop.identityAssurance ==',
    '"fixed-demo-role-assertion-not-authenticated"',
    '.resolutionLoop.canonicalMemoryMutable == false',
    '.resolutionLoop.externalSideEffects == "none"',
    '.embeddingModel == "amazon.titan-embed-text-v2:0"',
    '.narrationModel == "eu.anthropic.claude-sonnet-4-6"',
    'keys == ["access","company","dataClassification","mode","source","tenantId"]',
    '.status == "reachable"',
    'test("^[a-f0-9]{64}$")',
    ".trace.retrieval.requestedTopK == 5",
    ".report.audited == 9",
    '([.report.contradictions[0].values[].value] | sort) == [18400,18900]',
    '.report.contradictions[0].resolution.rule == "importance"',
    '.report.absences[0].subject == "PAY-118"',
    '.report.absences[0].referencedBy[0].sourceRef == "RECON-2043"',
  ]) {
    assert.equal(
      (workflow.match(new RegExp(
        fragment.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"),
        "gu"
      )) ?? []).length >= 2,
      true,
      fragment
    );
  }
  assert.match(
    template,
    /AccessLogSettings:[\s\S]*?DestinationArn:\s+!Sub "arn:\$\{AWS::Partition\}:logs:\$\{AWS::Region\}:\$\{AWS::AccountId\}:log-group:\$\{ApiVendedAccessLogGroup\}"/u
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
        /name: Prove transformed and live API stage routing before frontend mutation/gu
      ) ?? []
    ).length,
    2
  );
  assert.match(proof, /--template-stage Processed/u);
  assert.match(proof, /aws apigatewayv2 get-stage/u);
  assert.match(proof, /aws cloudfront wait distribution-deployed/u);
  assert.match(proof, /aws cloudfront get-distribution-config/u);
  assert.match(proof, /cloudFrontStatus: "Deployed"/u);
  assert.match(proof, /cloudFrontOriginPath: "\/live"/u);
  assert.match(proof, /directStageHealth: "GET \/live\/api\/health 200"/u);
  assert.match(proof, /sameOriginHealth: "GET \/api\/health 200"/u);
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
    "ApiEndpoint",
    "ApiId",
    "ApiStageName",
    "ApiAccessLogGroupName",
    "DistributionId",
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
    (workflow.match(/API_ENDPOINT="\$\(jq -er/gu) ?? []).length,
    2
  );
  const stageProofPositions = [
    ...workflow.matchAll(
      /name: Prove transformed and live API stage routing before frontend mutation/gu
    ),
  ].map((match) => match.index ?? -1);
  const frontendPositions = [
    ...workflow.matchAll(
      /name: Publish the frontend and invalidate CloudFront/gu
    ),
  ].map((match) => match.index ?? -1);
  assert.equal(stageProofPositions.length, 2);
  assert.equal(frontendPositions.length, 2);
  assert.ok(
    stageProofPositions.every(
      (position, index) => position < frontendPositions[index]
    )
  );
  assert.equal(
    (workflow.match(/--slurpfile apiStage api-stage-proof\.json/gu) ?? [])
      .length,
    2
  );
  assert.equal(
    (workflow.match(/else error\("invalid deployment control proof"\)/gu) ?? [])
      .length,
    2
  );
  assert.equal(
    (workflow.match(/apiStage: \$apiStage\[0\]/gu) ?? []).length,
    2
  );
  assert.equal(
    (workflow.match(/--template-stage Original/gu) ?? []).length,
    5
  );
  assert.equal(
    (workflow.match(/bash aws\/restore-cloudformation-stack\.sh/gu) ?? [])
      .length,
    2
  );
  assert.equal(
    (workflow.match(/bash aws\/delete-greenfield-stack\.sh/gu) ?? [])
      .length,
    4
  );
  assert.equal(
    (
      workflow.match(
        /name: Reconcile an interrupted same-run (?:staging|production) greenfield recovery/gu
      ) ?? []
    ).length,
    2
  );
  assert.equal(
    (
      workflow.match(
        /if: \(failure\(\) \|\| cancelled\(\)\) && steps\.deploy\.outputs\.started == 'true'/gu
      ) ?? []
    ).length,
    4
  );
  assert.equal(
    (
      workflow.match(
        /RECOVERY_CANCELLED: \$\{\{ job\.status == 'cancelled' \}\}/gu
      ) ?? []
    ).length,
    2
  );
  assert.equal(
    (
      workflow.match(
        /bash aws\/serialize-sam-stack-tags\.sh \\\r?\n\s+"\$target_tags" >"\$serialized_tags_file"/gu
      ) ?? []
    ).length,
    2
  );
  assert.equal(
    (
      workflow.match(
        /bash aws\/merge-canonical-stack-tags\.sh \\\r?\n\s+"\$prior_tags" >"\$target_tags"/gu
      ) ?? []
    ).length,
    2
  );
  assert.equal(
    (
      workflow.match(
        /TARGET_STACK_TAGS_SHA256: \$\{\{ steps\.deploy\.outputs\.target_tags_sha256 \}\}/gu
      ) ?? []
    ).length,
    2
  );
  assert.equal(
    (workflow.match(/post_sam_tags="\$\{RUNNER_TEMP:\?\}/gu) ?? []).length,
    2
  );
  assert.equal(
    (workflow.match(/terminally_proved=false/gu) ?? []).length,
    2
  );
  assert.equal(
    (
      workflow.match(
        /actions\/runs\/\$\{GITHUB_RUN_ID\}\/attempts\/\$\{prior_attempt\}\/jobs\?per_page=100/gu
      ) ?? []
    ).length,
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
    20
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
    (workflow.match(/timeout-minutes:\s+105/gu) ?? []).length,
    2
  );
  assert.equal(
    (workflow.match(/test "\$RECOVERY_FAILED" -eq 0/gu) ?? []).length,
    6
  );
  assert.equal(
    (
      workflow.match(
        /name: Build and validate sanitized (?:staging|production) deployment receipt/gu
      ) ?? []
    ).length,
    2
  );
  assert.equal(
    (
      workflow.match(
        /prove-application-s3-access-logging\.sh \\\r?\n\s+validate-preflight/gu
      ) ?? []
    ).length,
    2
  );
  assert.equal(
    (workflow.match(/terminalLiveReproved: true/gu) ?? []).length,
    2
  );
  assert.match(recoverySnapshot, /candidateSha/u);
  assert.match(recoverySnapshot, /executionRoleArn/u);
  assert.match(recoverySnapshot, /manifestSha256/u);
  assert.match(recoverySnapshot, /tagsSha256/u);
  const greenfieldOwnerPayload =
    recoverySnapshot.match(
      /owner_payload="\$\([\s\S]*?\r?\n    \)"\r?\n    greenfield_owner="\$\(/u
    )?.[0] ?? "";
  assert.ok(greenfieldOwnerPayload.length > 0);
  for (const fragment of [
    "--arg account",
    "--arg app",
    "--arg candidate",
    "--arg environment",
    "--arg region",
    "--arg repository",
    "--arg runId",
    "--arg stack",
  ]) {
    assert.ok(greenfieldOwnerPayload.includes(fragment), fragment);
  }
  assert.doesNotMatch(greenfieldOwnerPayload, /runAttempt/u);
  assert.match(
    recoverySnapshot,
    /--arg runAttempt "\$source_deploy_run_attempt"/u
  );
  assert.match(recoverySnapshot, /runAttempt: \$runAttempt/u);
  assert.equal(
    (
      workflow.match(
        /SOURCE_REPOSITORY: \$\{\{ github\.repository \}\}/gu
      ) ?? []
    ).length,
    2
  );
  assert.equal(
    (
      workflow.match(
        /SOURCE_DEPLOY_RUN_ATTEMPT: \$\{\{ github\.run_attempt \}\}/gu
      ) ?? []
    ).length,
    4
  );
  assert.equal(
    (
      workflow.match(
        /SOURCE_DEPLOY_RUN_ID: \$\{\{ github\.run_id \}\}/gu
      ) ?? []
    ).length,
    4
  );
  assert.match(ci, /bash -n aws\/prove-recovery-snapshot\.sh/u);
  assert.match(ci, /bash -n aws\/merge-canonical-stack-tags\.sh/u);
  assert.match(ci, /bash -n aws\/serialize-sam-stack-tags\.sh/u);
  assert.match(restore, /EXPECTED_PREVIOUS_STACK_ID/u);
  assert.match(restore, /change_set_id/u);
  assert.match(restore, /\.ExecutionStatus == "AVAILABLE"/u);
  assert.match(restore, /EXPECTED_PREVIOUS_STACK_TEMPLATE_SHA256/u);
  assert.match(restore, /EXPECTED_PREVIOUS_STACK_PARAMETERS_SHA256/u);
  assert.match(restore, /EXPECTED_PREVIOUS_STACK_TAGS_SHA256/u);
  assert.match(
    restore,
    /--tags "file:\/\/\$\{immutable_tags_file\}"/u
  );
  assert.match(restore, /--slurpfile expectedTags "\$immutable_tags_file"/u);
  assert.match(cleanup, /cloudformation describe-stack-resources/u);
  assert.match(cleanup, /ArchonGreenfieldOwner/u);
  assert.match(cleanup, /s3api get-bucket-tagging/u);
  assert.match(cleanup, /logs list-tags-for-resource/u);
  for (const retainedLogIdentity of [
    'legacy_api_log_group="/aws/apigateway/${APP_NAME}-${ENVIRONMENT}"',
    'vended_api_log_group="/aws/vendedlogs/apigateway/${APP_NAME}-${ENVIRONMENT}"',
    'lambda_log_group="/aws/lambda/${APP_NAME}-${ENVIRONMENT}-api"',
    "ApiAccessLogGroup",
    "ApiVendedAccessLogGroup",
    "ArchonFunctionLogGroup",
  ]) {
    assert.ok(cleanup.includes(retainedLogIdentity), retainedLogIdentity);
  }
  assert.equal(
    (cleanup.match(/^delete_owned_log_group \\$/gmu) ?? []).length,
    3
  );
  assert.match(cleanup, /assert_log_absent\(\)/u);
  assert.match(
    cleanup,
    /retainedLogGroupsDeleted: \$logGroupsDeleted/u
  );
  assert.match(cleanup, /--expected-bucket-owner "\$AWS_ACCOUNT_ID"/u);
  assert.match(cleanup, /REVIEW_IN_PROGRESS/u);
  assert.match(cleanup, /DELETE_FAILED/u);
  assert.match(cleanup, /archon-retry-/u);
  assert.match(bootstrap, /cloudformation:DescribeStackResources/u);
  assert.match(bootstrap, /logs:ListTagsForResource/u);
  const retainedLogDeleteIamBlocks = [
    ...bootstrap.matchAll(
      /- Sid: DeleteFailed(?:Staging|Production)GreenfieldRetainedLogs[\s\S]*?(?=\r?\n              - Sid: InspectFailed(?:Staging|Production)GreenfieldRetainedLogTags)/gu
    ),
  ].map((match) => match[0]);
  const retainedLogInspectIamBlocks = [
    ...bootstrap.matchAll(
      /- Sid: InspectFailed(?:Staging|Production)GreenfieldRetainedLogTags[\s\S]*?(?=\r?\n              - Effect: Allow)/gu
    ),
  ].map((match) => match[0]);
  assert.equal(retainedLogDeleteIamBlocks.length, 2);
  assert.equal(retainedLogInspectIamBlocks.length, 2);
  for (const block of retainedLogDeleteIamBlocks) {
    assert.match(block, /Action: logs:DeleteLogGroup/u);
    assert.equal((block.match(/log-group:/gu) ?? []).length, 3);
    assert.match(block, /\/aws\/apigateway\/\$\{AppName\}-/u);
    assert.match(block, /\/aws\/vendedlogs\/apigateway\/\$\{AppName\}-/u);
    assert.match(block, /\/aws\/lambda\/\$\{AppName\}-/u);
    assert.doesNotMatch(block, /:\*"/u);
  }
  for (const block of retainedLogInspectIamBlocks) {
    assert.match(block, /Action: logs:ListTagsForResource/u);
    assert.equal((block.match(/log-group:/gu) ?? []).length, 3);
    assert.doesNotMatch(block, /:\*"/u);
  }
  assert.equal(
    (
      bootstrap.match(
        /Sid: Expand(?:Staging|Production)ServerlessTransform/gu
      ) ?? []
    ).length,
    2
  );
  assert.equal(
    (bootstrap.match(/- cloudformation:ContinueUpdateRollback$/gmu) ?? [])
      .length,
    2
  );
  assert.equal(
    (bootstrap.match(/- cloudformation:CreateStack$/gmu) ?? []).length,
    0
  );
  assert.equal(
    (bootstrap.match(/- cloudformation:UpdateStack$/gmu) ?? []).length,
    0
  );
  assert.ok(
    (workflow.match(/aws cloudfront wait invalidation-completed/gu) ?? [])
      .length >= 4
  );
  assert.equal(
    (workflow.match(/cloudFrontStatus == "Deployed"/gu) ?? []).length,
    4
  );
  assert.equal(
    (workflow.match(/directStageHealth == "GET \/live\/api\/health 200"/gu) ?? [])
      .length,
    4
  );
  assert.equal(
    (ci.match(/reserved logical ID\|unexpected behaviors/gu) ?? []).length,
    1
  );
  assert.equal(
    (workflow.match(/reserved logical ID\|unexpected behaviors/gu) ?? [])
      .length,
    1
  );
  assert.equal(
    (bootstrap.match(/- cloudformation:GetTemplate$/gmu) ?? []).length,
    7
  );
  assert.equal(
    (bootstrap.match(/- cloudfront:GetDistribution$/gmu) ?? []).length,
    3
  );
  assert.equal(
    (bootstrap.match(/- cloudfront:GetDistributionConfig$/gmu) ?? [])
      .length,
    3
  );
  for (const action of [
    "logs:CreateLogDelivery",
    "logs:PutResourcePolicy",
    "logs:UpdateLogDelivery",
    "logs:DeleteLogDelivery",
    "logs:DescribeIndexPolicies",
    "logs:DescribeLogStreams",
    "logs:DescribeResourcePolicies",
    "logs:FilterLogEvents",
    "logs:GetLogEvents",
    "logs:GetLogDelivery",
    "logs:ListLogDeliveries",
  ]) {
    const expectedCount =
      action === "logs:DescribeLogStreams" ||
      action === "logs:FilterLogEvents" ||
      action === "logs:DescribeResourcePolicies"
        ? 3
        : action === "logs:CreateLogDelivery" ||
            action === "logs:DeleteLogDelivery" ||
            action === "logs:PutResourcePolicy"
          ? 2
          : 1;
    assert.equal(
      (bootstrap.match(new RegExp(`- ${action}$`, "gmu")) ?? []).length,
      expectedCount
    );
  }
  assert.match(
    bootstrap,
    /Sid: ConfigureOnlyCloudFormationEdgeLogDelivery\s+Effect: Allow\s+Action:\s+- logs:CreateLogDelivery\s+- logs:DeleteResourcePolicy\s+- logs:DeleteLogDelivery\s+- logs:DescribeLogGroups\s+- logs:DescribeResourcePolicies\s+- logs:PutResourcePolicy\s+Resource: "\*"\s+Condition:\s+StringEquals:\s+aws:RequestedRegion: us-east-1\s+"ForAnyValue:StringEquals":\s+aws:CalledVia: cloudformation\.amazonaws\.com/u
  );
  assert.match(
    bootstrap,
    /Sid: DescribeOnlyUsEastOneEdgeLogs\s+Effect: Allow\s+Action:\s+- logs:DescribeLogGroups\s+- logs:DescribeResourcePolicies\s+Resource: "\*"\s+Condition:\s+StringEquals:\s+aws:RequestedRegion: us-east-1/u
  );
  assert.equal(
    (
      bootstrap.match(
        /log-group:\/aws\/vendedlogs\/apigateway\/\$\{AppName\}-(?:staging|production)"/gu
      ) ?? []
    ).length,
    6
  );
  assert.equal(
    (
      bootstrap.match(
        /log-group:\/aws\/(?:vendedlogs\/)?apigateway\/\$\{AppName\}-(?:staging|production):\*"/gu
      ) ?? []
    ).length,
    4
  );
  assert.match(
    bootstrap,
    /Sid: VerifyStagingApiAccessLogs[\s\S]*?- logs:DescribeLogStreams\s+- logs:FilterLogEvents[\s\S]*?\$\{AppName\}-staging:\*"/u
  );
  assert.match(
    bootstrap,
    /Sid: VerifyProductionApiAccessLogs[\s\S]*?- logs:DescribeLogStreams\s+- logs:FilterLogEvents[\s\S]*?\$\{AppName\}-production:\*"/u
  );
  assert.match(
    restore,
    /--template-body "file:\/\/\$\{immutable_template_file\}"/u
  );
  assert.match(
    restore,
    /--parameters "file:\/\/\$\{immutable_parameters_file\}"/u
  );
  assert.match(
    restore,
    /--tags "file:\/\/\$\{immutable_tags_file\}"/u
  );
  assert.match(
    restore,
    /\(\(\.\[0\]\.Stacks\[0\]\.Tags \/\/ \[\]\) \| map\(\{Key, Value\}\) \| sort_by\(\.Key\)\)[\s\S]*?\(\$expectedTags\[0\] \| sort_by\(\.Key\)\)/u
  );
  assert.match(restore, /assert_recovery_snapshot_integrity/u);
  assert.match(restore, /cloudformation create-change-set/u);
  assert.match(restore, /--client-token "\$change_set_name"/u);
  assert.match(restore, /cloudformation execute-change-set/u);
  assert.match(restore, /--client-request-token "\$execute_token"/u);
  assert.match(restore, /--no-disable-rollback/u);
  assert.match(restore, /--retain-except-on-create/u);
  assert.match(restore, /cloudformation continue-update-rollback/u);
  assert.doesNotMatch(restore, /\bcloudformation\s+wait\b/u);
  assert.doesNotMatch(cleanup, /\bcloudformation\s+wait\b/u);
  for (const fragment of [
    "read_bounded_poll_setting",
    "assert_poll_phase_budget",
    "ensure_recovery_time_budget",
    "sleep_within_recovery_budget",
    "describe_exact_stack_status",
    "poll_exact_stack_status",
    "poll_exact_change_set_creation",
    "ARCHON_RECOVERY_TOTAL_BUDGET_SECONDS 2400 60 3000",
    "ARCHON_RECOVERY_STABILIZE_POLL_ATTEMPTS 12 1 30",
    "ARCHON_RECOVERY_STABILIZE_POLL_INTERVAL_SECONDS 5 0 10",
    "ARCHON_RECOVERY_CHANGE_SET_POLL_ATTEMPTS 60 1 90",
    "ARCHON_RECOVERY_CHANGE_SET_POLL_INTERVAL_SECONDS 5 0 10",
    "ARCHON_RECOVERY_FINAL_POLL_ATTEMPTS 120 1 180",
    "ARCHON_RECOVERY_FINAL_POLL_INTERVAL_SECONDS 10 0 15",
    'recovery_started_epoch="${ARCHON_RECOVERY_STARTED_EPOCH:-$current_epoch}"',
  ]) {
    assert.ok(restore.includes(fragment), fragment);
  }
  assert.equal(
    (bootstrap.match(/- codedeploy:ListDeployments$/gmu) ?? []).length,
    2
  );
  for (const fragment of [
    "read_bounded_poll_setting",
    "assert_poll_phase_budget",
    "ensure_greenfield_time_budget",
    "sleep_within_greenfield_budget",
    "describe_exact_greenfield_stack_status",
    "poll_exact_greenfield_stack_status",
    "poll_exact_greenfield_stack_deletion",
    "ARCHON_GREENFIELD_TOTAL_BUDGET_SECONDS 2400 60 3000",
    "ARCHON_GREENFIELD_STABILIZE_POLL_ATTEMPTS 12 1 30",
    "ARCHON_GREENFIELD_STABILIZE_POLL_INTERVAL_SECONDS 5 0 10",
    "ARCHON_GREENFIELD_DELETE_POLL_ATTEMPTS 120 1 180",
    "ARCHON_GREENFIELD_DELETE_POLL_INTERVAL_SECONDS 10 0 15",
    'greenfield_started_epoch="${ARCHON_GREENFIELD_STARTED_EPOCH:-$current_epoch}"',
  ]) {
    assert.ok(cleanup.includes(fragment), fragment);
  }
  assert.ok((restore.match(/AWS_MAX_ATTEMPTS=1 aws/gu) ?? []).length >= 2);
  assert.ok((cleanup.match(/AWS_MAX_ATTEMPTS=1 aws/gu) ?? []).length >= 2);
  assert.match(restore, /jq -ser/u);
  assert.match(cleanup, /jq -ser/u);
  assert.match(cleanup, /cloudformation delete-stack/u);
  assert.match(cleanup, /--client-request-token "\$delete_token"/u);
  assert.match(cleanup, /aws:cloudformation:stack-id/u);
  assert.match(cleanup, /aws:cloudformation:stack-name/u);
  assert.match(cleanup, /aws:cloudformation:logical-id/u);
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

test("readiness: CloudFront enforces CSP and cross-origin isolation without unsafe inline styles", () => {
  const template = readFileSync(
    new URL("../aws/template.yaml", import.meta.url),
    "utf8"
  );

  assert.doesNotMatch(template, /style-src 'self' 'unsafe-inline'/u);
  assert.match(
    template,
    /style-src 'self'; upgrade-insecure-requests/u
  );
  assert.match(
    template,
    /Header: Cross-Origin-Embedder-Policy\s+Value: "require-corp"\s+Override: true/u
  );
  assert.match(
    template,
    /Header: Cross-Origin-Opener-Policy\s+Value: "same-origin"\s+Override: true/u
  );
  assert.match(
    template,
    /Header: Cross-Origin-Resource-Policy\s+Value: "same-origin"\s+Override: true/u
  );
});
