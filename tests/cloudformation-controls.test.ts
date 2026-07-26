import { spawnSync, type SpawnSyncReturns } from "node:child_process";
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
import assert from "node:assert/strict";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONTROL_SCRIPT = join(
  ROOT,
  "aws",
  "enforce-cloudformation-controls.sh"
);

const APP_NAME = "archon-memory";
const AWS_ACCOUNT_ID = "123456789012";
const AWS_REGION = "eu-west-1";
const ENVIRONMENT = "staging";
const STACK_NAME = `${APP_NAME}-${ENVIRONMENT}`;
const STACK_ID =
  `arn:aws:cloudformation:${AWS_REGION}:${AWS_ACCOUNT_ID}:` +
  `stack/${STACK_NAME}/11111111-2222-3333-4444-555555555555`;
const EXECUTION_ROLE_ARN =
  `arn:aws:iam::${AWS_ACCOUNT_ID}:role/archon-cloudformation`;
const STACK_REVISION = "2026-07-26T10:20:30.000000+00:00";
const CANDIDATE_SHA = "a".repeat(40);
const DETECTION_ID = "11111111-aaaa-bbbb-cccc-222222222222";
const SECRET_MARKER = "must-not-leak-expected-or-actual-properties";

const STACK_TAGS = [
  { Key: "Application", Value: APP_NAME },
  { Key: "Environment", Value: ENVIRONMENT },
];

function canonicalTagsSha256(
  tags: Array<{ Key: string; Value: string }>
): string {
  const canonical = [...tags]
    .map(({ Key, Value }) => ({ Key, Value }))
    .sort((left, right) =>
      left.Key < right.Key ? -1 : left.Key > right.Key ? 1 : 0
    );
  return createHash("sha256")
    .update(`${JSON.stringify(canonical, null, 2)}\n`)
    .digest("hex");
}

const TAGS_SHA256 = canonicalTagsSha256(STACK_TAGS);

type Mode = "preflight" | "terminal" | "recover" | "audit";
type DriftMode =
  | "in-sync"
  | "drifted"
  | "modified-resource"
  | "timeout"
  | "detection-failed"
  | "api-error";
type DuplicateJsonOperation =
  | "describe-stacks"
  | "update-termination-protection"
  | "detect-stack-drift"
  | "describe-stack-drift-detection-status"
  | "describe-stack-resource-drifts";

interface ControlFixture {
  absent?: boolean;
  candidateSha?: string;
  driftMode?: DriftMode;
  duplicateJsonOperation?: DuplicateJsonOperation;
  environment?: "staging" | "production";
  expectedIdentity?: boolean;
  expectedStackState?: "existing" | "greenfield";
  initialProtection?: boolean;
  protectionUpdate?: "success" | "error" | "ineffective";
  stackId?: string;
  stackRevision?: string;
  stackStatus?:
    | "CREATE_COMPLETE"
    | "UPDATE_COMPLETE"
    | "UPDATE_ROLLBACK_COMPLETE"
    | "UPDATE_IN_PROGRESS";
  tags?: Array<{ Key: string; Value: string }>;
}

interface ControlRun {
  calls: string[];
  process: SpawnSyncReturns<string>;
}

function executable(path: string, content: string): void {
  writeFileSync(path, content, "utf8");
  chmodSync(path, 0o755);
}

function runControl(
  mode: Mode,
  fixture: ControlFixture = {}
): ControlRun {
  const work = mkdtempSync(join(tmpdir(), "archon-cfn-controls-"));
  const fakeBin = join(work, "bin");
  const callsFile = join(work, "aws-calls.log");
  const protectionFile = join(work, "termination-protection");
  const pollCountFile = join(work, "poll-count");
  mkdirSync(fakeBin);
  writeFileSync(callsFile, "", "utf8");
  writeFileSync(
    protectionFile,
    String(fixture.initialProtection ?? true),
    "utf8"
  );
  writeFileSync(pollCountFile, "0", "utf8");

  executable(
    join(fakeBin, "aws"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >>"$FAKE_CALLS_FILE"

arg_value() {
  local target="$1"
  shift
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "$target" ]; then
      printf '%s\\n' "$2"
      return 0
    fi
    shift
  done
  return 1
}

assert_exact_stack_id() {
  test "$(arg_value --stack-name "$@")" = "$FAKE_STACK_ID"
}

emit_json() {
  local operation="$1"
  local payload
  payload="$(cat)"
  printf '%s\\n' "$payload"
  if [ "$FAKE_DUPLICATE_JSON_OPERATION" = "$operation" ]; then
    printf '%s\\n' "$payload"
  fi
}

case "$*" in
  *"cloudformation describe-stacks"*)
    target="$(arg_value --stack-name "$@")"
    if [ "$FAKE_STACK_ABSENT" = "true" ]; then
      echo "An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id $target does not exist" >&2
      exit 255
    fi
    if [ "$target" != "$STACK_NAME" ] &&
       [ "$target" != "$EXPECTED_STACK_ID" ]; then
      echo "unexpected stack target: ${SECRET_MARKER}" >&2
      exit 96
    fi
    jq -n \
      --arg stackId "$FAKE_STACK_ID" \
      --arg stackName "$STACK_NAME" \
      --arg roleArn "$AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN" \
      --arg status "$FAKE_STACK_STATUS" \
      --arg revision "$FAKE_STACK_REVISION" \
      --argjson protected "$(cat "$FAKE_PROTECTION_FILE")" \
      --argjson tags "$FAKE_STACK_TAGS" \
      '{
        Stacks: [{
          CreationTime: "2026-07-01T00:00:00.000000+00:00",
          EnableTerminationProtection: $protected,
          LastUpdatedTime: $revision,
          RoleARN: $roleArn,
          StackId: $stackId,
          StackName: $stackName,
          StackStatus: $status,
          Tags: $tags
        }]
      }' |
      emit_json describe-stacks
    ;;
  *"cloudformation update-termination-protection"*)
    assert_exact_stack_id "$@"
    case " $* " in
      *" --enable-termination-protection "*) ;;
      *) exit 95 ;;
    esac
    if [ "$FAKE_PROTECTION_UPDATE" = "error" ]; then
      echo "AccessDenied ${SECRET_MARKER}" >&2
      exit 254
    fi
    if [ "$FAKE_PROTECTION_UPDATE" = "success" ]; then
      printf '%s' "true" >"$FAKE_PROTECTION_FILE"
    fi
    jq -n --arg stackId "$FAKE_STACK_ID" '{StackId: $stackId}' |
      emit_json update-termination-protection
    ;;
  *"cloudformation detect-stack-drift"*)
    assert_exact_stack_id "$@"
    if [ "$FAKE_DRIFT_MODE" = "api-error" ]; then
      echo "AccessDenied ${SECRET_MARKER}" >&2
      exit 254
    fi
    jq -n \
      --arg detectionId "$FAKE_DETECTION_ID" \
      '{StackDriftDetectionId: $detectionId}' |
      emit_json detect-stack-drift
    ;;
  *"cloudformation describe-stack-drift-detection-status"*)
    test "$(arg_value --stack-drift-detection-id "$@")" = \
      "$FAKE_DETECTION_ID"
    count="$(( $(cat "$FAKE_POLL_COUNT_FILE") + 1 ))"
    printf '%s' "$count" >"$FAKE_POLL_COUNT_FILE"
    case "$FAKE_DRIFT_MODE" in
      timeout)
        detection_status="DETECTION_IN_PROGRESS"
        stack_drift_status="NOT_CHECKED"
        drifted_count=0
        ;;
      detection-failed)
        detection_status="DETECTION_FAILED"
        stack_drift_status="UNKNOWN"
        drifted_count=0
        ;;
      drifted)
        detection_status="DETECTION_COMPLETE"
        stack_drift_status="DRIFTED"
        drifted_count=1
        ;;
      *)
        detection_status="DETECTION_COMPLETE"
        stack_drift_status="IN_SYNC"
        drifted_count=0
        ;;
    esac
    jq -n \
      --arg detectionId "$FAKE_DETECTION_ID" \
      --arg stackId "$FAKE_STACK_ID" \
      --arg detectionStatus "$detection_status" \
      --arg stackDriftStatus "$stack_drift_status" \
      --arg reason "$SECRET_MARKER" \
      --argjson driftedCount "$drifted_count" \
      '{
        DetectionStatus: $detectionStatus,
        DetectionStatusReason: $reason,
        DriftedStackResourceCount: $driftedCount,
        StackDriftDetectionId: $detectionId,
        StackDriftStatus: $stackDriftStatus,
        StackId: $stackId
      }' |
      emit_json describe-stack-drift-detection-status
    ;;
  *"cloudformation describe-stack-resource-drifts"*)
    assert_exact_stack_id "$@"
    if [ "$FAKE_DRIFT_MODE" = "modified-resource" ]; then
      resource_status="MODIFIED"
    else
      resource_status="IN_SYNC"
    fi
    jq -n \
      --arg resourceStatus "$resource_status" \
      --arg secret "$SECRET_MARKER" \
      '{
        StackResourceDrifts: [{
          ActualProperties: $secret,
          ExpectedProperties: $secret,
          LogicalResourceId: "ApplicationFunction",
          PhysicalResourceId: "application-function",
          ResourceType: "AWS::Lambda::Function",
          StackResourceDriftStatus: $resourceStatus,
          Timestamp: "2026-07-26T10:21:00.000000+00:00"
        }]
      }' |
      emit_json describe-stack-resource-drifts
    ;;
  *)
    echo "Unexpected aws invocation: ${SECRET_MARKER}" >&2
    exit 97
    ;;
esac
`
  );

  const environment = fixture.environment ?? ENVIRONMENT;
  const stackName = `${APP_NAME}-${environment}`;
  const stackId = fixture.stackId ?? STACK_ID;
  const stackRevision = fixture.stackRevision ?? STACK_REVISION;
  const tags = fixture.tags ?? STACK_TAGS;
  const expectedIdentity =
    fixture.expectedIdentity ?? !fixture.absent;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    APP_NAME,
    AWS_ACCOUNT_ID,
    AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN: EXECUTION_ROLE_ARN,
    AWS_REGION,
    CANDIDATE_SHA: fixture.candidateSha ?? CANDIDATE_SHA,
    CFN_DRIFT_POLL_ATTEMPTS: "2",
    CFN_DRIFT_POLL_INTERVAL_SECONDS: "0",
    ENVIRONMENT: environment,
    FAKE_CALLS_FILE: callsFile,
    FAKE_DETECTION_ID: DETECTION_ID,
    FAKE_DRIFT_MODE: fixture.driftMode ?? "in-sync",
    FAKE_DUPLICATE_JSON_OPERATION: fixture.duplicateJsonOperation ?? "",
    FAKE_POLL_COUNT_FILE: pollCountFile,
    FAKE_PROTECTION_FILE: protectionFile,
    FAKE_PROTECTION_UPDATE: fixture.protectionUpdate ?? "success",
    FAKE_STACK_ABSENT: String(fixture.absent ?? false),
    FAKE_STACK_ID: stackId,
    FAKE_STACK_REVISION: stackRevision,
    FAKE_STACK_STATUS: fixture.stackStatus ?? "UPDATE_COMPLETE",
    FAKE_STACK_TAGS: JSON.stringify(tags),
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    STACK_NAME: stackName,
  };
  if (mode === "recover") {
    env.EXPECTED_STACK_STATE =
      fixture.expectedStackState ??
      (fixture.absent ? "greenfield" : "existing");
  } else {
    delete env.EXPECTED_STACK_STATE;
  }
  if (expectedIdentity) {
    env.EXPECTED_STACK_ID = STACK_ID;
    env.EXPECTED_STACK_REVISION = STACK_REVISION;
    env.EXPECTED_TAGS_SHA256 = TAGS_SHA256;
  } else {
    delete env.EXPECTED_STACK_ID;
    delete env.EXPECTED_STACK_REVISION;
    delete env.EXPECTED_TAGS_SHA256;
  }

  let processResult: SpawnSyncReturns<string>;
  try {
    processResult = spawnSync("bash", [CONTROL_SCRIPT, mode], {
      cwd: ROOT,
      encoding: "utf8",
      env,
    });
    return {
      calls: readFileSync(callsFile, "utf8")
        .trim()
        .split(/\r?\n/u)
        .filter(Boolean),
      process: processResult,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function assertSucceeded(result: ControlRun): void {
  assert.equal(result.process.error, undefined);
  assert.equal(
    result.process.status,
    0,
    result.process.stderr || result.process.stdout
  );
}

test("existing preflight proves exact protected identity and fresh in-sync drift", () => {
  const result = runControl("preflight");
  assertSucceeded(result);

  const proof = JSON.parse(result.process.stdout);
  assert.deepEqual(Object.keys(proof).sort(), [
    "drift",
    "evidence",
    "identity",
    "mode",
    "ok",
    "protection",
    "schema",
    "version",
  ]);
  assert.equal(proof.schema, "archon.cloudformation-controls.proof");
  assert.equal(proof.version, 1);
  assert.equal(proof.mode, "preflight");
  assert.equal(proof.evidence, "live-control-plane");
  assert.deepEqual(proof.identity, {
    accountId: AWS_ACCOUNT_ID,
    appName: APP_NAME,
    candidateSha: CANDIDATE_SHA,
    environment: ENVIRONMENT,
    executionRoleArn: EXECUTION_ROLE_ARN,
    region: AWS_REGION,
    stackId: STACK_ID,
    stackName: STACK_NAME,
    stackRevision: STACK_REVISION,
    stackStatus: "UPDATE_COMPLETE",
    state: "existing",
    tagsSha256: TAGS_SHA256,
  });
  assert.deepEqual(proof.protection, {
    action: "verified",
    enabled: true,
  });
  assert.deepEqual(proof.drift, {
    checkedResourceCount: 1,
    detectionId: DETECTION_ID,
    detectionStatus: "DETECTION_COMPLETE",
    driftedResourceCount: 0,
    notCheckedResourceCount: 0,
    stackDriftStatus: "IN_SYNC",
    totalResourceCount: 1,
  });
  assert.equal(
    result.calls.filter((call) =>
      call.includes("update-termination-protection")
    ).length,
    0
  );
  assert.equal(
    result.calls.filter((call) =>
      call.includes("detect-stack-drift")
    ).length,
    1
  );
});

test("existing preflight enables and re-proves termination protection", () => {
  const result = runControl("preflight", {
    initialProtection: false,
  });
  assertSucceeded(result);
  const proof = JSON.parse(result.process.stdout);
  assert.deepEqual(proof.protection, {
    action: "enabled",
    enabled: true,
  });
  const updateIndex = result.calls.findIndex((call) =>
    call.includes("update-termination-protection")
  );
  const driftIndex = result.calls.findIndex((call) =>
    call.includes("detect-stack-drift")
  );
  assert.ok(updateIndex >= 0);
  assert.ok(driftIndex > updateIndex);
});

test("preflight fails when protection enablement errors or cannot be re-proved", () => {
  for (const protectionUpdate of [
    "error",
    "ineffective",
  ] satisfies Array<"error" | "ineffective">) {
    const result = runControl("preflight", {
      initialProtection: false,
      protectionUpdate,
    });
    assert.notEqual(result.process.status, 0);
    assert.equal(
      result.calls.some((call) => call.includes("detect-stack-drift")),
      false
    );
    assert.doesNotMatch(
      `${result.process.stdout}\n${result.process.stderr}`,
      new RegExp(SECRET_MARKER, "u")
    );
  }
});

test("greenfield preflight proves absence without protection mutation or drift", () => {
  const result = runControl("preflight", {
    absent: true,
    expectedIdentity: false,
  });
  assertSucceeded(result);
  const proof = JSON.parse(result.process.stdout);
  assert.equal(proof.identity.state, "absent");
  assert.equal(proof.identity.stackId, null);
  assert.equal(proof.identity.stackRevision, null);
  assert.equal(proof.identity.tagsSha256, null);
  assert.deepEqual(proof.protection, {
    action: "not-applicable",
    enabled: null,
  });
  assert.equal(proof.drift, null);
  assert.equal(result.calls.length, 1);
  assert.match(result.calls[0], /cloudformation describe-stacks/u);
});

test("greenfield recovery proves exact absence without protection or drift", () => {
  const result = runControl("recover", {
    absent: true,
    expectedIdentity: false,
  });
  assertSucceeded(result);
  const proof = JSON.parse(result.process.stdout);
  assert.equal(proof.mode, "recover");
  assert.equal(proof.identity.state, "absent");
  assert.deepEqual(proof.protection, {
    action: "not-applicable",
    enabled: null,
  });
  assert.equal(proof.drift, null);
  assert.equal(result.calls.length, 1);

  const survivingStack = runControl("recover", {
    expectedIdentity: false,
    expectedStackState: "greenfield",
  });
  assert.notEqual(survivingStack.process.status, 0);
  assert.equal(
    survivingStack.calls.some((call) =>
      call.includes("update-termination-protection")
    ),
    false
  );
  assert.equal(
    survivingStack.calls.some((call) =>
      call.includes("detect-stack-drift")
    ),
    false
  );
});

test("terminal enables protection before running fresh drift", () => {
  const result = runControl("terminal", {
    initialProtection: false,
  });
  assertSucceeded(result);
  const proof = JSON.parse(result.process.stdout);
  assert.deepEqual(proof.protection, {
    action: "enabled",
    enabled: true,
  });
  const updateIndex = result.calls.findIndex((call) =>
    call.includes("update-termination-protection")
  );
  const driftIndex = result.calls.findIndex((call) =>
    call.includes("detect-stack-drift")
  );
  assert.ok(updateIndex >= 0);
  assert.ok(driftIndex > updateIndex);
});

test("recover enforces controls while audit remains read-only", () => {
  const recovered = runControl("recover", {
    initialProtection: false,
  });
  assertSucceeded(recovered);
  assert.equal(
    JSON.parse(recovered.process.stdout).protection.action,
    "enabled"
  );

  const audited = runControl("audit");
  assertSucceeded(audited);
  assert.equal(
    audited.calls.some((call) =>
      call.includes("update-termination-protection")
    ),
    false
  );
  assert.equal(JSON.parse(audited.process.stdout).mode, "audit");
});

test("drifted, modified, timed-out, and failed detections fail closed", () => {
  for (const driftMode of [
    "drifted",
    "modified-resource",
    "timeout",
    "detection-failed",
    "api-error",
  ] satisfies DriftMode[]) {
    const result = runControl("audit", { driftMode });
    assert.notEqual(
      result.process.status,
      0,
      `expected ${driftMode} to fail`
    );
    assert.doesNotMatch(
      `${result.process.stdout}\n${result.process.stderr}`,
      new RegExp(SECRET_MARKER, "u")
    );
  }
});

test(
  "every live CloudFormation boundary rejects duplicate valid JSON documents",
  () => {
    const cases: Array<{
      mode?: Mode;
      operation: DuplicateJsonOperation;
      fixture?: ControlFixture;
    }> = [
      { operation: "describe-stacks" },
      {
        mode: "terminal",
        operation: "update-termination-protection",
        fixture: { initialProtection: false },
      },
      { operation: "detect-stack-drift" },
      { operation: "describe-stack-drift-detection-status" },
      { operation: "describe-stack-resource-drifts" },
    ];

    for (const { mode = "audit", operation, fixture = {} } of cases) {
      const result = runControl(mode, {
        ...fixture,
        duplicateJsonOperation: operation,
      });
      assert.equal(
        result.calls.some((call) => call.includes(operation)),
        true,
        `expected the ${operation} boundary to be exercised`
      );
      assert.notEqual(
        result.process.status,
        0,
        `expected duplicate ${operation} JSON documents to fail`
      );
      assert.doesNotMatch(
        `${result.process.stdout}\n${result.process.stderr}`,
        new RegExp(SECRET_MARKER, "u")
      );
    }
  }
);

test("proof output is sanitized and never persists resource properties", () => {
  const result = runControl("audit");
  assertSucceeded(result);
  const combined = `${result.process.stdout}\n${result.process.stderr}`;
  assert.doesNotMatch(combined, /ExpectedProperties|ActualProperties/u);
  assert.doesNotMatch(combined, new RegExp(SECRET_MARKER, "u"));
  const proof = JSON.parse(result.process.stdout);
  assert.deepEqual(Object.keys(proof.drift).sort(), [
    "checkedResourceCount",
    "detectionId",
    "detectionStatus",
    "driftedResourceCount",
    "notCheckedResourceCount",
    "stackDriftStatus",
    "totalResourceCount",
  ]);
});

test("wrong stack target fails before mutation or drift", () => {
  const wrongStackId =
    `arn:aws:cloudformation:${AWS_REGION}:999999999999:` +
    `stack/${STACK_NAME}/11111111-2222-3333-4444-555555555555`;
  const result = runControl("terminal", {
    initialProtection: false,
    stackId: wrongStackId,
  });
  assert.notEqual(result.process.status, 0);
  assert.equal(
    result.calls.some((call) =>
      call.includes("update-termination-protection")
    ),
    false
  );
  assert.equal(
    result.calls.some((call) => call.includes("detect-stack-drift")),
    false
  );
});

test("strict target and provenance validation happens before AWS", () => {
  const wrongRegion = runControl("audit", {
    environment: "production",
  });
  assert.notEqual(wrongRegion.process.status, 0);
  assert.deepEqual(wrongRegion.calls, []);

  const invalidCandidate = runControl("audit", {
    candidateSha: "not-a-git-sha",
  });
  assert.notEqual(invalidCandidate.process.status, 0);
  assert.deepEqual(invalidCandidate.calls, []);
});
