import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string): string =>
  readFileSync(join(root, path), "utf8");

const workflow = read(".github/workflows/aws-security-baseline.yml");
const script = read("aws/audit-account-security-baseline.sh");
const policy = JSON.parse(
  read("aws/account-security-baseline-audit-policy.json")
) as {
  Version: string;
  Statement: Array<{
    Sid: string;
    Effect: string;
    Action: string | string[];
    Resource: string;
    Condition?: Record<string, Record<string, string>>;
  }>;
};
const contract = JSON.parse(
  read("docs/operations/well-architected-contract.json")
) as {
  controls: Array<Record<string, unknown>>;
  approvalGates: Array<Record<string, unknown>>;
  requiredDocuments: string[];
};

const expectedControlIds = [
  "audit-identity-binding",
  "aws-config-recorder-channel",
  "cloudtrail-multi-region-validation",
  "ebs-default-encryption",
  "guardduty-detector",
  "iam-access-analyzer",
  "iam-password-policy",
  "root-credential-posture",
  "s3-account-public-access-block",
  "security-hub-standards",
];

test("AWS account baseline workflow is manual, protected, and exact-green-main", () => {
  const trigger = workflow.slice(
    workflow.indexOf("on:"),
    workflow.indexOf("concurrency:")
  );
  assert.match(trigger, /^\s{2}workflow_dispatch:/mu);
  assert.doesNotMatch(
    trigger,
    /^\s{2}(?:pull_request|push|schedule|workflow_call):/mu
  );
  assert.match(
    trigger,
    /target_sha:[\s\S]*?required:\s+true[\s\S]*?type:\s+string/u
  );

  assert.match(workflow, /environment:\s+security-audit/u);
  assert.match(workflow, /id-token:\s+write/u);
  assert.match(workflow, /actions:\s+read/u);
  assert.match(workflow, /contents:\s+read/u);
  assert.match(
    workflow,
    /AWS_SECURITY_AUDIT_ROLE_ARN:\s*\$\{\{ vars\.AWS_SECURITY_AUDIT_ROLE_ARN \}\}/u
  );
  assert.match(workflow, /AWS_REGION:\s+eu-west-1/u);
  assert.match(workflow, /test "\$GITHUB_REF" = "refs\/heads\/main"/u);
  assert.equal(
    (workflow.match(/test "\$GITHUB_SHA" = "\$TARGET_SHA"/gu) ?? [])
      .length,
    2
  );
  assert.equal(
    (
      workflow.match(
        /test "\$GITHUB_WORKFLOW_REF" = [\s\S]*?"upgradedev\/archon-cockroach-memory\/\.github\/workflows\/aws-security-baseline\.yml@refs\/heads\/main"/gu
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
  assert.match(
    workflow,
    /\.owners\.security\.status == "assigned"[\s\S]*?\.owners\.security\.value/u
  );
  assert.equal(
    (workflow.match(/::add-mask::%s/gu) ?? []).length,
    3
  );
  assert.doesNotMatch(
    workflow,
    /secrets\.(?:AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY)|aws-access-key-id:|aws-secret-access-key:/u
  );
});

test("workflow actions and sanitized exact-SHA artifact are immutable", () => {
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
  assert.match(workflow, /role-duration-seconds:\s+900/u);
  assert.match(workflow, /mask-aws-account-id:\s+true/u);
  assert.match(workflow, /allowed-account-ids:\s*\$\{\{ env\.AWS_ACCOUNT_ID \}\}/u);
  assert.match(
    workflow,
    /RECEIPT_PATH:\s*\$\{\{ runner\.temp \}\}\/aws-account-security-baseline-receipt\.json/u
  );
  assert.match(
    workflow,
    /name:\s+Upload only the sanitized exact-SHA receipt[\s\S]*?if:\s+always\(\)[\s\S]*?path:\s*\$\{\{ runner\.temp \}\}\/aws-account-security-baseline-receipt\.json[\s\S]*?retention-days:\s+90/u
  );
  assert.match(
    workflow,
    /arn:\(aws\|aws-cn\|aws-us-gov\):\|:assumed-role\/\|AKIA\[0-9A-Z\]\{16\}\|ASIA\[0-9A-Z\]\{16\}/u
  );
  for (const id of expectedControlIds) {
    assert.ok(workflow.includes(`"${id}"`), id);
  }
});

test("reference IAM policy is the exact read-only action set", () => {
  const expectedActions = [
    "access-analyzer:ListAnalyzers",
    "cloudtrail:DescribeTrails",
    "cloudtrail:GetTrailStatus",
    "config:DescribeConfigurationRecorderStatus",
    "config:DescribeConfigurationRecorders",
    "config:DescribeDeliveryChannelStatus",
    "config:DescribeDeliveryChannels",
    "ec2:GetEbsEncryptionByDefault",
    "guardduty:GetDetector",
    "guardduty:ListDetectors",
    "iam:GetAccountPasswordPolicy",
    "iam:GetAccountSummary",
    "s3:GetAccountPublicAccessBlock",
    "securityhub:DescribeHub",
    "securityhub:GetEnabledStandards",
    "sts:GetCallerIdentity",
  ];
  const actions = policy.Statement.flatMap((statement) =>
    Array.isArray(statement.Action) ? statement.Action : [statement.Action]
  ).sort();

  assert.equal(policy.Version, "2012-10-17");
  assert.equal(policy.Statement.length, 4);
  assert.deepEqual(actions, expectedActions);
  assert.ok(
    policy.Statement.every(
      (statement) =>
        statement.Effect === "Allow" && statement.Resource === "*"
    )
  );
  const regional = policy.Statement.find(
    (statement) => statement.Sid === "ReadEuWestOneAccountSecurityPosture"
  );
  assert.deepEqual(regional?.Condition, {
    StringEquals: { "aws:RequestedRegion": "eu-west-1" },
  });
  const trail = policy.Statement.find(
    (statement) => statement.Sid === "ReadMultiRegionTrailPosture"
  );
  assert.deepEqual(trail?.Action, [
    "cloudtrail:DescribeTrails",
    "cloudtrail:GetTrailStatus",
  ]);
  assert.equal(trail?.Condition, undefined);
  assert.ok(
    actions.every((action) =>
      /:(?:Describe|Get|List)[A-Z]/u.test(action)
    )
  );
});

test("audit script has only bounded read operations and ten sanitized controls", () => {
  const operationPattern =
    /\b(sts|iam|s3control|cloudtrail|guardduty|securityhub|configservice|accessanalyzer|ec2)\s+([a-z][a-z0-9-]+)\b/gu;
  const operations = [
    ...new Set(
      [...script.matchAll(operationPattern)].map(
        (match) => `${match[1]} ${match[2]}`
      )
    ),
  ].sort();
  assert.deepEqual(operations, [
    "accessanalyzer list-analyzers",
    "cloudtrail describe-trails",
    "cloudtrail get-trail-status",
    "configservice describe-configuration-recorder-status",
    "configservice describe-configuration-recorders",
    "configservice describe-delivery-channel-status",
    "configservice describe-delivery-channels",
    "ec2 get-ebs-encryption-by-default",
    "guardduty get-detector",
    "guardduty list-detectors",
    "iam get-account-password-policy",
    "iam get-account-summary",
    "s3control get-public-access-block",
    "securityhub describe-hub",
    "securityhub get-enabled-standards",
    "sts get-caller-identity",
  ]);

  for (const id of expectedControlIds) {
    assert.ok(script.includes(`"${id}"`), id);
  }
  assert.match(script, /\[ "\$AWS_REGION" = "eu-west-1" \]/u);
  assert.match(script, /minimumPasswordLength:[\s\S]*?>= 14/u);
  assert.match(script, /PasswordReusePrevention \/\/ 0\) >= 24/u);
  assert.match(script, /\.IsMultiRegionTrail == true/u);
  assert.match(script, /\.LogFileValidationEnabled == true/u);
  assert.match(script, /\.LatestDigestDeliveryTime != null/u);
  assert.match(script, /\.recordingGroup\.allSupported == true/u);
  assert.match(script, /aws-security-baseline\.XXXXXXXXXX/u);
  assert.match(script, /rm -f -- "\$raw_dir"\/\*\.json/u);
  assert.match(script, /accountIdentifierRedacted:\s+true/u);
  assert.match(script, /roleIdentifierRedacted:\s+true/u);
  assert.match(script, /mv -f -- "\$final_receipt" "\$RECEIPT_PATH"/u);
  assert.doesNotMatch(script, /echo\s+"?\$\{?(?:trail_arn|detector_id)/u);
});

test("WA-03 contract and operator documentation preserve honest activation state", () => {
  const wa03 = contract.controls.find((control) => control.id === "WA-03");
  assert.deepEqual(wa03, {
    id: "WA-03",
    name: "Account security baseline",
    scope: "account-or-organization",
    state: "repository-prepared-live-audit-required",
    requiresExternalApproval: true,
    activatedByThisContract: false,
    evidenceWorkflow: ".github/workflows/aws-security-baseline.yml",
    auditScript: "aws/audit-account-security-baseline.sh",
    referencePolicy: "aws/account-security-baseline-audit-policy.json",
    runbook: "docs/runbooks/aws-account-security-baseline.md",
    protectedEnvironment: "security-audit",
    roleVariable: "AWS_SECURITY_AUDIT_ROLE_ARN",
    mutationPermitted: false,
  });
  assert.ok(
    contract.requiredDocuments.includes(
      "docs/runbooks/aws-account-security-baseline.md"
    )
  );
  assert.deepEqual(
    contract.approvalGates.find(
      (gate) => gate.id === "account-security-baseline-audit"
    ),
    {
      id: "account-security-baseline-audit",
      required: true,
      mutationAllowed: false,
      conditions: [
        "exact current main SHA with successful CI CodeQL and Supply Chain",
        "assigned security owner",
        "security-audit environment approval",
        "existing least-privilege AWS_SECURITY_AUDIT_ROLE_ARN",
        "read-only AWS APIs only",
        "sanitized all-pass 10-of-10 receipt",
      ],
    }
  );

  const runbook = read("docs/runbooks/aws-account-security-baseline.md");
  const evidence = read(
    "docs/operations/WELL_ARCHITECTED_EVIDENCE.md"
  );
  const contractAudit = read(
    ".github/scripts/well-architected-contract-audit.mjs"
  );
  const wellArchitectedWorkflow = read(
    ".github/workflows/well-architected-audit.yml"
  );
  assert.match(runbook, /Status: repository-prepared/u);
  assert.match(runbook, /does not enable or remediate/u);
  assert.match(runbook, /environment:security-audit/u);
  assert.match(runbook, /Some services incur charges/u);
  assert.match(evidence, /Protected WA-03 account security audit/u);
  assert.match(evidence, /all-pass `10\/10` exact-SHA receipt/u);
  assert.match(evidence, /AWS Inspector[\s\S]*?outside the WA-03 receipt/u);
  assert.match(contractAudit, /wa03-account-security-baseline-source/u);
  assert.match(
    wellArchitectedWorkflow,
    /\.github\/workflows\/aws-security-baseline\.yml/u
  );
  assert.match(
    wellArchitectedWorkflow,
    /tests\/aws-security-baseline\.test\.ts/u
  );
});
