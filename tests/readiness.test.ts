import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  allCockroachImagesPinned,
  allComposeImagesPinned,
  allDockerfileBasesPinned,
  allSetupNodeStepsPinned,
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
  generatedArtifactPaths,
  GENERATED_ARTIFACT_BASENAMES,
  hasExactAwsDeliveryConcurrency,
  hasExactAwsRecoveryTrigger,
  hasExactCiTrigger,
  hasExactCodeqlActionPins,
  hasExactDependabotReleaseFreeze,
  hasExactHostedSmokeContracts,
  hasExactSubmissionReadinessTrigger,
  hasExactSubmissionWorkflowContract,
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

test("readiness: centralized S3 access logging is a first-class product gate", () => {
  const check = evaluate().checks.find(
    (candidate) =>
      candidate.id === "product.s3-access-logging-foundation"
  );
  assert.ok(check);
  assert.equal(check.criterion, "Production Readiness");
  assert.equal(check.status, "pass", check.detail);
});

test("readiness: dormant encrypted alarm routing is a first-class product gate", () => {
  const check = evaluate().checks.find(
    (candidate) =>
      candidate.id === "product.dormant-encrypted-alarm-routing"
  );
  assert.ok(check);
  assert.equal(check.criterion, "Production Readiness");
  assert.equal(check.status, "pass", check.detail);
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
  assert.equal(hasExactAwsDeliveryConcurrency(foundationWorkflow), true);
  assert.equal(hasExactAwsDeliveryConcurrency(deploy), true);
  assert.equal(hasExactAwsDeliveryConcurrency(recovery), true);
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
    6
  );
  assert.match(ledger, /--argjson leaseUntil "\$\(\(now \+ 7200\)\)"/u);
  assert.equal(
    (
      recovery.match(
        /uses: actions\/checkout@[0-9a-f]{40}[^\r\n]*\r?\n        with:\r?\n          ref: \$\{\{ github\.sha \}\}\r?\n          fetch-depth: 0/gu
      ) ?? []
    ).length,
    2
  );
  assert.equal(
    (
      recovery.match(
        /github\.repository == 'upgradedev\/archon-cockroach-memory' &&\r?\n\s+github\.ref == 'refs\/heads\/main'/gu
      ) ?? []
    ).length,
    2
  );
  assert.equal(
    (
      recovery.match(
        /test "\$GITHUB_REF" = "refs\/heads\/main"/gu
      ) ?? []
    ).length,
    2
  );
  assert.equal(
    (
      recovery.match(
        /test "\$GITHUB_REF_TYPE" = "branch"/gu
      ) ?? []
    ).length,
    2
  );
  assert.equal(
    (
      recovery.match(
        /test "\$GITHUB_WORKFLOW_REF" = \\\r?\n\s+"upgradedev\/archon-cockroach-memory\/\.github\/workflows\/recover-aws\.yml@refs\/heads\/main"/gu
      ) ?? []
    ).length,
    2
  );
  assert.equal(
    (
      recovery.match(
        /test "\$\(git rev-parse HEAD\)" = "\$GITHUB_SHA"/gu
      ) ?? []
    ).length,
    2
  );
  assert.equal(
    (
      recovery.match(
        /git fetch --no-tags origin \\\r?\n\s+\+refs\/heads\/main:refs\/remotes\/origin\/main/gu
      ) ?? []
    ).length,
    2
  );
  assert.equal(
    (
      recovery.match(
        /test "\$\(git rev-parse origin\/main\)" = "\$GITHUB_SHA"/gu
      ) ?? []
    ).length,
    2
  );
  assert.match(
    recovery,
    /recover-staging:[\s\S]*?if: >-\r?\n\s+github\.repository == 'upgradedev\/archon-cockroach-memory' &&\r?\n\s+github\.ref == 'refs\/heads\/main'\r?\n\s+runs-on:/u
  );
  assert.match(
    recovery,
    /recover-production:[\s\S]*?needs:\r?\n\s+- recover-staging\r?\n\s+if: >-\r?\n\s+always\(\) &&\r?\n\s+github\.repository == 'upgradedev\/archon-cockroach-memory' &&\r?\n\s+github\.ref == 'refs\/heads\/main'\r?\n\s+runs-on:/u
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
  }
  const samCredentialRefreshPositions = [
    ...deploy.matchAll(
      /name: Refresh short-lived AWS credentials for (?:staging|production) SAM deployment/gu
    ),
  ].map((match) => match.index ?? -1);
  assert.equal(samCredentialRefreshPositions.length, 2);
  for (const [index, refreshPosition] of samCredentialRefreshPositions.entries()) {
    assert.ok(refreshPosition < samPositions[index]);
    assert.equal(
      (
        deploy
          .slice(refreshPosition, samPositions[index])
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
    (deploy.match(/\.state == "ARMED"/gu) ?? []).length,
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
    16
  );
  assert.equal(
    (
      recovery.match(
        /bash aws\/classify-durable-recovery-source\.sh >"\$classification"\r?\n\s+jq -e -s/gu
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
    2
  );
  assert.equal(
    (
      recovery.match(
        /name: Upload (?:staging|production) daily protection and drift audit/gu
      ) ?? []
    ).length,
    2
  );
  assert.equal(
    (
      recovery.match(
        /github\.event_name == 'schedule' &&\r?\n\s+github\.event\.schedule == '17 4 \* \* \*'/gu
      ) ?? []
    ).length,
    4
  );
  assert.equal(
    (
      recovery.match(
        /github\.event_name == 'workflow_dispatch' &&\r?\n\s+inputs\.operation == 'audit'/gu
      ) ?? []
    ).length,
    4
  );
  assert.equal(
    (
      recovery.match(
        /\$\{\{ runner\.temp \}\}\/(?:staging|production)-cloudformation-controls-audit\.json/gu
      ) ?? []
    ).length,
    2
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
  assert.match(ledger, /--server-side-encryption AES256/u);
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

test("readiness: every workflow action and Node runtime is pinned exhaustively", () => {
  const workflows = repositoryWorkflowTexts();
  const versions = workflows.flatMap(setupNodeVersions);
  assert.equal(versions.length, EXPECTED_SETUP_NODE_STEPS);
  assert.deepEqual(
    [...new Set(versions)],
    [PINNED_NODE_VERSION]
  );
  assert.equal(allSetupNodeStepsPinned(workflows), true);
  assert.equal(allWorkflowActionsPinned(workflows), true);
  assert.equal(EXPECTED_WORKFLOW_ACTION_REFS, 82);

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
  assert.equal(dockerfiles.length, 1);
  assert.equal(EXPECTED_COCKROACH_IMAGE_REFS, 8);
  assert.equal(EXPECTED_COMPOSE_IMAGE_REFS, 4);
  assert.equal(EXPECTED_DOCKERFILE_BASE_REFS, 1);
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
    5
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

test("readiness: CI runs once for main pushes and for every pull request", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/ci.yml", import.meta.url),
    "utf8"
  );
  assert.equal(hasExactCiTrigger(workflow), true);
  const repositoryWorkflows = repositoryWorkflowSources();
  const recoveryWorkflow = repositoryWorkflows.find(
    (entry) => entry.name === "recover-aws.yml"
  );
  const submissionWorkflow = repositoryWorkflows.find(
    (entry) => entry.name === "submission-readiness.yml"
  );
  assert.ok(recoveryWorkflow);
  assert.ok(submissionWorkflow);
  assert.equal(hasExactAwsRecoveryTrigger(recoveryWorkflow.source), true);
  assert.equal(
    hasExactSubmissionReadinessTrigger(submissionWorkflow.source),
    true
  );
  assert.equal(
    hasExactSubmissionWorkflowContract(submissionWorkflow.source),
    true
  );
  assert.equal(
    hasExactAwsRecoveryTrigger(
      recoveryWorkflow.source.replace(
        "          - audit",
        "          - deploy"
      )
    ),
    false
  );
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
  assert.equal(repositoryWorkflows.length, 9);
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
                /    branches:\r?\n      - main\r?\n/u,
                '    branches:\n      - release\n'
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
    "on:\n  push:\n    branches: [main]\n  pull_request:\n  workflow_dispatch:",
    "on:\n  push:\n    branches: [main]\n  pull_request:\nname: CI\non:\n  workflow_dispatch:",
    "on:\n  push:\n    branches: [main]\n  pull_request:\nname: CI\non :\n  workflow_dispatch:",
    "on:\n  push:\n    branches: [main]\n  pull_request:\nname: CI\n\"on\":\n  workflow_dispatch:",
    "on:\n  push:\n    branches: [main]\n  pull_request:\nname: CI\n\"o\\u006e\":\n  workflow_dispatch:",
  ]) {
    assert.equal(hasExactCiTrigger(invalid), false, invalid);
  }
});

test("readiness: generated receipts and nested build directories fail closed", () => {
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
      (check) => check.id === "tech.managed-mcp-receipt-v2-gate"
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

test("readiness: Managed MCP source and both protected workflows pin receipt v2 exactly", () => {
  const audit = readFileSync(
    new URL("../scripts/cloud-mcp-audit.ts", import.meta.url),
    "utf8"
  );
  for (const pattern of [
    /MANAGED_MCP_RECEIPT_SCHEMA_VERSION\s*=\s*2/u,
    /tenantId:\s*"public-demo"/u,
    /company:\s*"Helios SA"/u,
    /status:\s*"active"/u,
    /embedModel:\s*"amazon\.titan-embed-text-v2:0"/u,
    /FORCE_INDEX=idx_agent_memory_active_scope/u,
    /LIMIT 10[\s\S]*LIMIT 1/u,
    /parseManagedMcpAggregateResult/u,
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

  const exactGateFragments = [
    'keys == ["aggregate","bound","calledTools","checkedAt","database","endpoint","mode","ok","proofs","redactions","schemaVersion","scope","toolsAdvertised"]',
    ".schemaVersion == 2",
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
    '.calledTools == ["get_cluster","list_tables","get_table_schema","select_query"]',
    ".proofs == [",
    '"detail":"Live cluster metadata returned through CockroachDB Cloud Managed MCP."',
    '"detail":"`agent_memory` is present in the configured application database."',
    '"detail":"Live schema exposes VECTOR(1024) and a native vector index."',
    '"detail":"The fixed-scope, index-forced, ten-row-sentinel aggregate is exactly 9/9/9."',
    "length == 4",
    'map(.name) == ["get_cluster","list_tables","get_table_schema","select_query"]',
    '.redactions == ["API key","cluster identifier","SQL credentials","memory content","embeddings"]',
    'grep -Fq -- "$CCLOUD_API_KEY"',
    'grep -Fq -- "$COCKROACH_CLUSTER_ID"',
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
      'jq -e --arg database "$COCKROACH_DATABASE"'
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
  }
  assert.match(
    standalone,
    /- name: Upload the sanitized proof receipt[\s\S]*?if: success\(\)[\s\S]*?if-no-files-found: error[\s\S]*?retention-days: 90/u
  );
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
      "(.citations | length) >= 2",
      "(.citations | length) <= 5",
      ".recalled == (.citations | length)",
      '(.answer | contains("€15,375"))',
      '(.answer | contains("€6,775"))',
      ".modelId == $narrator",
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
    workflow.replace(
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
    4
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
    3
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
    1
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
