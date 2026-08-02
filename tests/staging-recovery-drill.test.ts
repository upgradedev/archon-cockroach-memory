import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string): string =>
  readFileSync(resolve(ROOT, path), "utf8");

const workflow = read(".github/workflows/deploy-aws.yml");
const template = read("aws/template.yaml");
const bootstrap = read("aws/bootstrap-oidc.yaml");
const bootstrapPolicy = read("aws/bootstrap-stack-policy.json");
const migrationPolicy = read("aws/foundation-storage-migration-policy.json");
const githubClassifier = read("aws/classify-github-recovery-preflight.sh");
const durableClassifier = read("aws/classify-durable-recovery-source.sh");
const appSpecFetcher = resolve(
  ROOT,
  "aws/fetch-codedeploy-appspec-revision.sh"
);
const selector = resolve(ROOT, "aws/select-staging-codedeploy-rollback.mjs");

const SELECTOR_APPLICATION = "archon-staging-app";
const SELECTOR_GROUP = "archon-staging-group";
const SELECTOR_FUNCTION = "archon-memory-staging-api";
const SELECTOR_STACK =
  "arn:aws:cloudformation:eu-west-1:123456789012:stack/" +
  "archon-memory-staging/11111111-1111-4111-8111-111111111111";
const SELECTOR_PREVIOUS = "41";
const SELECTOR_CANDIDATE = "42";
const SELECTOR_STARTED = Math.floor(
  Date.parse("2026-08-02T10:00:00Z") / 1000
);
const SELECTOR_OBSERVED_AT = "2026-08-02T10:01:00Z";
const SELECTOR_ENDED = SELECTOR_STARTED + 600;

function section(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0, `missing section start: ${start}`);
  assert.ok(endIndex > startIndex, `missing section end: ${end}`);
  return source.slice(startIndex, endIndex);
}

function appSpecContent(
  targetVersion = SELECTOR_CANDIDATE,
  format: "json" | "yaml" = "json"
): string {
  if (format === "yaml") {
    return [
      "version: 0.0",
      "resources:",
      "  - TargetFunction:",
      "      type: AWS::Lambda::Function",
      "      properties:",
      `        name: ${SELECTOR_FUNCTION}`,
      "        alias: live",
      `        currentversion: ${SELECTOR_PREVIOUS}`,
      `        targetversion: ${targetVersion}`,
      "",
    ].join("\n");
  }
  return JSON.stringify({
    version: "0.0",
    Resources: [
      {
        TargetFunction: {
          Type: "AWS::Lambda::Function",
          Properties: {
            Name: SELECTOR_FUNCTION,
            Alias: "live",
            CurrentVersion: SELECTOR_PREVIOUS,
            TargetVersion: targetVersion,
          },
        },
      },
    ],
  });
}

function sourceDeployment(
  options: {
    content?: string;
    createTime?: string;
    deploymentId?: string;
    externalId?: string;
  } = {}
): Record<string, unknown> {
  const content = options.content ?? appSpecContent();
  const sha256 = createHash("sha256").update(content).digest("hex");
  const deploymentId = options.deploymentId ?? "d-SOURCE1";
  return {
    applicationRevision: {
      applicationName: SELECTOR_APPLICATION,
      revision: {
        revisionType: "AppSpecContent",
        appSpecContent: { content, sha256 },
      },
      revisionInfo: { deploymentGroups: [SELECTOR_GROUP] },
    },
    deploymentInfo: {
      applicationName: SELECTOR_APPLICATION,
      autoRollbackConfiguration: {
        enabled: true,
        events: ["DEPLOYMENT_STOP_ON_ALARM"],
      },
      computePlatform: "Lambda",
      createTime: options.createTime ?? "2026-08-02T10:00:30Z",
      creator: "CloudFormation",
      deploymentConfigName:
        "CodeDeployDefault.LambdaCanary10Percent5Minutes",
      deploymentGroupName: SELECTOR_GROUP,
      deploymentId,
      errorInformation: { code: "ALARM_ACTIVE" },
      externalId: options.externalId ?? SELECTOR_STACK,
      revision: {
        revisionType: "AppSpecContent",
        appSpecContent: { content: null, sha256 },
      },
      rollbackInfo: { rollbackDeploymentId: "d-ROLLBACK1" },
      status: "Stopped",
    },
  };
}

function rollbackDeployment(
  createTime = "2026-08-02T10:02:00Z"
): Record<string, unknown> {
  return {
    applicationRevision: null,
    deploymentInfo: {
      applicationName: SELECTOR_APPLICATION,
      computePlatform: "Lambda",
      createTime,
      creator: "CloudFormationRollback",
      deploymentGroupName: SELECTOR_GROUP,
      deploymentId: "d-ROLLBACK1",
      rollbackInfo: { rollbackTriggeringDeploymentId: "d-SOURCE1" },
      status: "Succeeded",
    },
  };
}

function runSelector(
  records: Record<string, unknown>[],
  expectedTimes: {
    ended?: number;
    observedAt?: string;
    started?: number;
  } = {}
) {
  const fixture = mkdtempSync(join(tmpdir(), "archon-codedeploy-selector-"));
  const input = join(fixture, "deployments.json");
  writeFileSync(input, JSON.stringify(records), "utf8");
  const result = spawnSync(process.execPath, [selector, input], {
    encoding: "utf8",
    env: {
      ...process.env,
      EXPECTED_CANDIDATE_OBSERVED_AT:
        expectedTimes.observedAt ?? SELECTOR_OBSERVED_AT,
      EXPECTED_CANDIDATE_VERSION: SELECTOR_CANDIDATE,
      EXPECTED_CLOUDFORMATION_STACK_ID: SELECTOR_STACK,
      EXPECTED_CODEDEPLOY_APPLICATION: SELECTOR_APPLICATION,
      EXPECTED_CODEDEPLOY_GROUP: SELECTOR_GROUP,
      EXPECTED_DRILL_ENDED_EPOCH: String(
        expectedTimes.ended ?? SELECTOR_ENDED
      ),
      EXPECTED_DRILL_STARTED_EPOCH: String(
        expectedTimes.started ?? SELECTOR_STARTED
      ),
      EXPECTED_LAMBDA_ALIAS: "live",
      EXPECTED_LAMBDA_FUNCTION_NAME: SELECTOR_FUNCTION,
      EXPECTED_PREVIOUS_VERSION: SELECTOR_PREVIOUS,
    },
  });
  rmSync(fixture, { recursive: true, force: true });
  return result;
}

test("staging fault injection is an exact protected manual operation", () => {
  const trigger = section(workflow, "  workflow_dispatch:", "\nconcurrency:");
  for (const input of [
    "operation:",
    "target_sha:",
    "approval_reference:",
    "confirmation:",
  ]) {
    assert.match(trigger, new RegExp(`^      ${input}$`, "mu"));
  }
  assert.match(trigger, /- staging-recovery-drill/u);
  assert.match(
    trigger,
    /FAULT-INJECT-STAGING-RECOVERY-AND-REQUIRE-WATCHDOG/u
  );
  assert.doesNotMatch(trigger, /production-recovery-drill/u);

  const sourceGate = section(
    workflow,
    "      - name: Require successful exact-main push CI source",
    "      - name: Require successful exact-SHA Supply Chain evidence"
  );
  assert.match(sourceGate, /case "\$GITHUB_EVENT_NAME" in/u);
  assert.match(sourceGate, /push\)[\s\S]*?DEPLOY_OPERATION" = "release"/u);
  assert.match(
    sourceGate,
    /workflow_dispatch\)[\s\S]*?DEPLOY_OPERATION" = "staging-recovery-drill"/u
  );
  assert.match(sourceGate, /test "\$DEPLOY_TARGET_SHA" = "\$EXPECTED_SHA"/u);
  assert.ok(
    sourceGate.includes(
      '[[ "$APPROVAL_REFERENCE" =~ ^[A-Za-z0-9][A-Za-z0-9._:/+-]{7,127}$ ]]'
    )
  );
  assert.ok(
    sourceGate.includes(
      '"drill-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"'
    )
  );

  const production = section(
    workflow,
    "  deploy-production:",
    "  hosted-dast-production:"
  );
  assert.match(
    production,
    /if: success\(\) && github\.event_name == 'push'/u
  );
  assert.doesNotMatch(production, /staging-recovery-drill/u);
});

test("drill gate refuses greenfield, stale release, or missing push evidence before ARM", () => {
  const gateName =
    "      - name: Authorize the exact existing staging release for fault injection";
  const armName =
    "      - name: Persist and arm the immutable staging recovery intent";
  const deployName =
    "      - name: Deploy staging with recovery-safe SAM canary";
  assert.ok(workflow.indexOf(gateName) < workflow.indexOf(armName));
  assert.ok(workflow.indexOf(armName) < workflow.indexOf(deployName));

  const gate = section(
    workflow,
    gateName,
    "      - name: Enforce staging stack protection and fresh pre-deploy drift gate"
  );
  assert.match(gate, /test "\$HAS_PREVIOUS_STACK" = "true"/u);
  assert.match(gate, /exact_parameter\("ReleaseCommitSha"; \$release\)/u);
  assert.match(gate, /exact_parameter\("RecoveryDrillToken"; "disabled"\)/u);
  assert.match(gate, /exact_parameter\("DatabaseSecretId"; \$databaseSecretId\)/u);
  assert.match(
    gate,
    /actions\/workflows\/deploy-aws\.yml\/runs\?branch=main&event=push&status=success/u
  );
  assert.match(gate, /staging-deployment-receipt-/u);
  assert.match(gate, /\^sha256:\[0-9a-f\]\{64\}\$/u);
  assert.match(gate, /\.expired == false/u);
  assert.match(gate, /\.conclusion == "success"/u);
});

test("manual drill reuses prior release state without database or production MCP mutation", () => {
  const databaseRelease = section(
    workflow,
    "  database-release:",
    "  deploy-staging:"
  );
  const staging = section(
    workflow,
    "  deploy-staging:",
    "  deploy-production:"
  );
  const managedMcp = section(
    workflow,
    "  managed-mcp-production-audit:",
    "  hosted-dast-production:"
  );
  assert.match(databaseRelease, /^    if: github\.event_name == 'push'$/mu);
  assert.match(managedMcp, /^    if: github\.event_name == 'push'$/mu);
  assert.match(staging, /always\(\)/u);
  assert.match(staging, /!cancelled\(\)/u);
  assert.match(staging, /needs\.database-release\.result == 'skipped'/u);
  assert.match(
    staging,
    /needs\.managed-mcp-production-audit\.result == 'skipped'/u
  );
  assert.match(staging, /prior_cockroach_sql_dns=/u);
  assert.match(
    staging,
    /exact_parameter\("CockroachSqlDns"; \$cockroachSqlDns\)/u
  );
  assert.match(staging, /COCKROACH_SQL_DNS=\$prior_cockroach_sql_dns/u);
});

test("candidate failure is real, staging-only, bounded, and observed at 10 percent", () => {
  const deploy = section(
    workflow,
    "      - name: Deploy staging with recovery-safe SAM canary",
    "      - name: Refresh short-lived AWS credentials after staging SAM deployment"
  );
  assert.match(
    deploy,
    /candidate_database_secret_id="\$\{APP_NAME\}\/staging\/recovery-drill-inaccessible-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}"/u
  );
  assert.match(deploy, /test "\$candidate_database_secret_id" != "\$DATABASE_SECRET_ID"/u);
  assert.match(deploy, /--arg databaseSecretId "\$candidate_database_secret_id"/u);
  assert.match(deploy, /AdditionalVersionWeights/u);
  assert.match(deploy, /\.value >= 0\.099/u);
  assert.match(deploy, /\.value <= 0\.101/u);
  assert.match(deploy, /StateValue == "ALARM"/u);
  assert.match(deploy, /ExecutedVersion/u);
  assert.match(deploy, /DEPLOYMENT_STOP_ON_ALARM/u);
  assert.match(deploy, /CodeDeployDefault\.LambdaCanary10Percent5Minutes/u);
  assert.match(deploy, /for _ in \{1\.\.300\}/u);
  assert.match(deploy, /sam_status=\$\?/u);
  assert.match(deploy, /test "\$sam_status" -ne 0/u);
  assert.match(deploy, /exit "\$sam_status"/u);
  assert.doesNotMatch(deploy, /us-west-2/u);
});

test("CodeDeploy selector proves the exact stack, drill window, AppSpec, and rollback relation", () => {
  const unrelated = sourceDeployment({
    content: appSpecContent("99"),
    deploymentId: "d-UNRELATED1",
  });
  const result = runSelector([
    unrelated,
    sourceDeployment(),
    rollbackDeployment(),
  ]);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const proof = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(proof.relationProved, true);
  assert.deepEqual(proof.sourceBinding, {
    appSpecSha256: createHash("sha256")
      .update(appSpecContent())
      .digest("hex"),
    candidateVersionMatched: true,
    createTimeWithinDrillWindow: true,
    externalStackIdMatched: true,
    functionAliasMatched: true,
    functionNameMatched: true,
    previousVersionMatched: true,
  });
  assert.equal(
    (proof.source as { deploymentId: string }).deploymentId,
    "d-SOURCE1"
  );
  assert.equal(
    (proof.rollback as { deploymentId: string }).deploymentId,
    "d-ROLLBACK1"
  );
});

test("CodeDeploy selector accepts the strict documented YAML Lambda AppSpec shape", () => {
  const result = runSelector([
    sourceDeployment({ content: appSpecContent(SELECTOR_CANDIDATE, "yaml") }),
    rollbackDeployment(),
  ]);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});

test(
  "AppSpec fetcher sends the exact deployment SHA in the documented AWS request shape",
  { skip: process.platform === "win32" },
  () => {
    const fixture = mkdtempSync(join(tmpdir(), "archon-appspec-fetcher-"));
    const fakeBin = join(fixture, "bin");
    const detail = join(fixture, "deployment.json");
    const output = join(fixture, "revision.json");
    const awsLog = join(fixture, "aws.log");
    const content = appSpecContent();
    const sha256 = createHash("sha256").update(content).digest("hex");
    mkdirSync(fakeBin);
    writeFileSync(awsLog, "", "utf8");
    writeFileSync(
      detail,
      JSON.stringify(sourceDeployment({ content })),
      "utf8"
    );
    const fakeAws = join(fakeBin, "aws");
    writeFileSync(
      fakeAws,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >>"$FAKE_AWS_LOG"
test "$1" = "deploy"
test "$2" = "get-application-revision"
shift 2
application=""
region=""
request=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --application-name) application="$2"; shift 2 ;;
    --revision) request="\${2#file://}"; shift 2 ;;
    --region) region="$2"; shift 2 ;;
    --output) test "$2" = "json"; shift 2 ;;
    *) exit 97 ;;
  esac
done
test "$application" = "$FAKE_APPLICATION"
test "$region" = "eu-west-1"
jq -e --arg sha "$FAKE_SHA" '
  . == {
    revisionType: "AppSpecContent",
    appSpecContent: {sha256: $sha}
  }
' "$request" >/dev/null
jq -n \\
  --arg application "$FAKE_APPLICATION" \\
  --arg content "$FAKE_CONTENT" \\
  --arg sha "$FAKE_SHA" '
    {
      applicationName: $application,
      revision: {
        revisionType: "AppSpecContent",
        appSpecContent: {content: $content, sha256: $sha}
      },
      revisionInfo: {deploymentGroups: []}
    }
'
`,
      "utf8"
    );
    chmodSync(fakeAws, 0o755);
    try {
      const result = spawnSync(
        "bash",
        [appSpecFetcher, detail, SELECTOR_APPLICATION, output],
        {
          cwd: ROOT,
          encoding: "utf8",
          env: {
            ...process.env,
            AWS_REGION: "eu-west-1",
            FAKE_APPLICATION: SELECTOR_APPLICATION,
            FAKE_AWS_LOG: awsLog,
            FAKE_CONTENT: content,
            FAKE_SHA: sha256,
            PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          },
        }
      );
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      const revision = JSON.parse(readFileSync(output, "utf8")) as {
        revision: { appSpecContent: { sha256: string } };
      };
      assert.equal(revision.revision.appSpecContent.sha256, sha256);
      assert.match(
        readFileSync(awsLog, "utf8"),
        /^deploy get-application-revision /u
      );
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }
);

test("CodeDeploy selector fails closed on unbound or ambiguous source evidence", () => {
  const invalidSources = [
    sourceDeployment({ content: appSpecContent("99") }),
    sourceDeployment({
      createTime: "2026-08-02T09:40:00Z",
    }),
    sourceDeployment({
      externalId:
        "arn:aws:cloudformation:eu-west-1:123456789012:stack/" +
        "other-stack/11111111-1111-4111-8111-111111111111",
    }),
  ];
  for (const invalidSource of invalidSources) {
    const result = runSelector([invalidSource, rollbackDeployment()]);
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /CodeDeploy recovery evidence rejected:/u);
  }

  const duplicate = sourceDeployment({ deploymentId: "d-SOURCE2" });
  const duplicateInfo = duplicate.deploymentInfo as {
    rollbackInfo: { rollbackDeploymentId: string };
  };
  duplicateInfo.rollbackInfo.rollbackDeploymentId = "d-ROLLBACK1";
  const ambiguous = runSelector([
    sourceDeployment(),
    duplicate,
    rollbackDeployment(),
  ]);
  assert.equal(ambiguous.error, undefined);
  assert.notEqual(ambiguous.status, 0);
  assert.equal(ambiguous.stdout, "");
});

test("CodeDeploy selector rejects reversed runner and deployment chronology", () => {
  const observedBeforeStart = runSelector(
    [sourceDeployment(), rollbackDeployment()],
    {
      observedAt: "2026-08-02T09:59:59Z",
    }
  );
  assert.equal(observedBeforeStart.error, undefined);
  assert.notEqual(observedBeforeStart.status, 0);
  assert.equal(observedBeforeStart.stdout, "");

  const endedBeforeObservation = runSelector(
    [sourceDeployment(), rollbackDeployment()],
    {
      ended: SELECTOR_STARTED + 30,
    }
  );
  assert.equal(endedBeforeObservation.error, undefined);
  assert.notEqual(endedBeforeObservation.status, 0);
  assert.equal(endedBeforeObservation.stdout, "");

  const rollbackBeforeSource = runSelector([
    sourceDeployment(),
    rollbackDeployment("2026-08-02T10:00:29Z"),
  ]);
  assert.equal(rollbackBeforeSource.error, undefined);
  assert.notEqual(rollbackBeforeSource.status, 0);
  assert.equal(rollbackBeforeSource.stdout, "");
});

test("receipt requires Stopped ALARM_ACTIVE, related successful rollback, and automatic prestate proof", () => {
  const evidence = section(
    workflow,
    "      - name: Prove alarm-triggered CodeDeploy and CloudFormation rollback",
    "      - name: Publish the frontend and invalidate CloudFront"
  );
  assert.match(evidence, /steps\.deploy\.outcome == 'failure'/u);
  assert.match(evidence, /staging-recovery-drill-started-epoch/u);
  assert.match(evidence, /fetch-codedeploy-appspec-revision\.sh/u);
  assert.match(evidence, /select-staging-codedeploy-rollback\.mjs/u);
  assert.match(evidence, /EXPECTED_CLOUDFORMATION_STACK_ID/u);
  assert.match(evidence, /EXPECTED_CANDIDATE_OBSERVED_AT/u);
  assert.match(evidence, /sourceBinding\.externalStackIdMatched/u);
  assert.match(evidence, /sourceBinding\.appSpecSha256/u);
  assert.match(evidence, /sourceStatus: "Stopped"/u);
  assert.match(evidence, /sourceErrorCode: "ALARM_ACTIVE"/u);
  assert.match(evidence, /rollbackRelationProved: true/u);
  assert.match(evidence, /"UPDATE_ROLLBACK_COMPLETE"/u);
  assert.match(evidence, /cmp --silent previous-stack-template\.yaml/u);
  assert.match(evidence, /previous-stack-parameters\.json/u);
  assert.match(evidence, /previous-stack-tags\.json/u);
  assert.match(
    evidence,
    /\(\.Stacks\[0\]\.Outputs \/\/ \[\]\) \| sort_by\(\.OutputKey\)/u
  );
  assert.match(evidence, /AdditionalVersionWeights \/\/ \{\}\) == \{\}/u);
  assert.match(evidence, /\.memory\.persisted == 9/u);
  assert.match(evidence, /version: 2/u);
  assert.match(evidence, /behaviorFaultInjected: true/u);
  assert.match(evidence, /secretMaterialCreated: false/u);
  assert.match(evidence, /productionMutationPermitted: false/u);
  assert.match(evidence, /rawAwsIdentifiersStored: false/u);
  assert.match(evidence, /secretValuesRead: false/u);

  const handoff = section(
    workflow,
    "      - name: Finalize the sanitized staging recovery drill handoff",
    "      - name: Upload staging receipt"
  );
  assert.match(handoff, /steps\.fault_injection\.outcome == 'success'/u);
  assert.match(handoff, /ledgerStateAfterInlineRecovery: "ARMED"/u);
  assert.match(handoff, /watchdogTerminalRecoveryPending: true/u);
  assert.match(handoff, /terminalRecoveryClaimed: false/u);
  assert.match(handoff, /actions\/attest-build-provenance@0f67c3f/u);
  assert.match(handoff, /retention-days: 90/u);
  assert.match(handoff, /rm -f -- "\$\{RUNNER_TEMP:\?\}"\/staging-recovery-drill-\*/u);
});

test("template and least-privilege foundation authorize only read-only staging evidence", () => {
  assert.match(
    template,
    /RecoveryDrillToken:\r?\n\s+Type: String[\s\S]*?AllowedPattern: "\^\(disabled\|drill-\[1-9\]\[0-9\]\*-\[1-9\]\[0-9\]\*\)\$"/u
  );
  assert.match(
    template,
    /Rules:\r?\n\s+RecoveryDrillIsStagingOnly:\r?\n\s+RuleCondition: !Not \[!Equals \[!Ref RecoveryDrillToken, disabled\]\][\s\S]*?Assert: !Equals \[!Ref Environment, staging\]/u
  );
  assert.match(template, /RECOVERY_DRILL_TOKEN: !Ref RecoveryDrillToken/u);
  assert.match(template, /Type: Canary10Percent5Minutes/u);
  assert.match(template, /- !Ref LambdaCanaryErrorAlarm/u);

  const inspectionPolicy = section(
    bootstrap,
    "  StagingCodeDeployInspectionPolicy:",
    "  StagingAlarmRoutingInspectionPolicy:"
  );
  assert.match(inspectionPolicy, /Roles:\r?\n\s+- !Ref StagingDeployRole/u);
  const inspectionActions = [
    ...inspectionPolicy.matchAll(
      /(?:Action:\s+|- )(codedeploy:[A-Za-z]+)$/gmu
    ),
  ].map((match) => match[1]).sort();
  assert.deepEqual(inspectionActions, [
    "codedeploy:GetApplicationRevision",
    "codedeploy:GetDeployment",
    "codedeploy:GetDeploymentGroup",
    "codedeploy:ListDeployments",
  ]);
  assert.match(
    inspectionPolicy,
    /Resource: !Sub >-\r?\n\s+arn:\$\{AWS::Partition\}:codedeploy:\$\{AWS::Region\}:\$\{AWS::AccountId\}:application:\$\{AppName\}-staging-\*/u
  );
  assert.match(
    inspectionPolicy,
    /Resource: !Sub >-\r?\n\s+arn:\$\{AWS::Partition\}:codedeploy:\$\{AWS::Region\}:\$\{AWS::AccountId\}:deploymentgroup:\$\{AppName\}-staging-\*\/\*/u
  );
  assert.match(inspectionPolicy, /aws:RequestedRegion: !Ref AWS::Region/u);
  assert.doesNotMatch(inspectionPolicy, /Resource: "\*"/u);
  assert.equal((inspectionPolicy.match(/Effect: Allow/gu) ?? []).length, 2);
  assert.match(bootstrapPolicy, /LogicalResourceId\/StagingCodeDeployInspectionPolicy/u);
  assert.match(migrationPolicy, /"logicalResourceId": "StagingCodeDeployInspectionPolicy"/u);
  assert.match(migrationPolicy, /"resourceType": "AWS::IAM::Policy"/u);
});

test("watchdog classifiers accept dispatch evidence only for staging", () => {
  assert.match(
    githubClassifier,
    /if \[ "\$run_event" != "workflow_dispatch" \]; then[\s\S]*?classify_environment_job production/u
  );
  assert.match(githubClassifier, /\.event == "workflow_run"/u);
  assert.doesNotMatch(
    githubClassifier,
    /deploy-aws\.yml\/runs\?branch=main&event=push/u
  );
  assert.match(
    durableClassifier,
    /\.event == "workflow_dispatch" and \$environment == "staging"/u
  );
  assert.match(durableClassifier, /\.event == "workflow_run"/u);
  assert.doesNotMatch(
    durableClassifier,
    /\.event == "workflow_dispatch" and \$environment == "production"/u
  );
});
