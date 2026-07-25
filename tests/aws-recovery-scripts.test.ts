import { spawnSync } from "node:child_process";
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
const RESTORE_SCRIPT = join(
  ROOT,
  "aws",
  "restore-cloudformation-stack.sh"
);
const CLEANUP_SCRIPT = join(ROOT, "aws", "delete-greenfield-stack.sh");

function executable(path: string, content: string): void {
  writeFileSync(path, content, "utf8");
  chmodSync(path, 0o755);
}

function runRestore(
  noChanges = false,
  changeSetReason = "The submitted information did not contain changes."
) {
  const fixture = mkdtempSync(join(tmpdir(), "archon-stack-restore-"));
  const fakeBin = join(fixture, "bin");
  mkdirSync(fakeBin);
  const callLog = join(fixture, "aws-calls.log");
  const template = join(fixture, "previous-stack-template.yaml");
  const parameters = join(fixture, "previous-stack-parameters.json");
  writeFileSync(
    template,
    "Transform: AWS::Serverless-2016-10-31\nResources: {}\n",
    "utf8"
  );
  const parameterFixture = [
    { ParameterKey: "AlarmTopicArn", ParameterValue: "" },
    { ParameterKey: "PublicDemoCompany", ParameterValue: "Helios SA" },
  ];
  writeFileSync(parameters, JSON.stringify(parameterFixture), "utf8");
  executable(
    join(fakeBin, "aws"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >>"$FAKE_AWS_CALL_LOG"
case "$*" in
  *"cloudformation create-change-set"*) printf '%s\\n' '{}' ;;
  *"cloudformation wait change-set-create-complete"*)
    if [ "$FAKE_NO_CHANGES" = "true" ]; then exit 255; fi ;;
  *"cloudformation describe-change-set"*)
    jq -n --arg reason "$FAKE_CHANGE_SET_REASON" \
      '{Status:"FAILED",StatusReason:$reason}' ;;
  *"cloudformation delete-change-set"*) ;;
  *"cloudformation execute-change-set"*) ;;
  *"cloudformation wait stack-update-complete"*) ;;
  *) echo "Unexpected aws invocation: $*" >&2; exit 97 ;;
esac
`
  );
  const result = spawnSync("bash", [RESTORE_SCRIPT], {
    cwd: fixture,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      STACK_NAME: "archon-memory-staging",
      AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN:
        "arn:aws:iam::123456789012:role/archon-cloudformation",
      AWS_REGION: "eu-west-1",
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "1",
      PREVIOUS_STACK_TEMPLATE_FILE: template,
      PREVIOUS_STACK_PARAMETERS_FILE: parameters,
      FAKE_AWS_CALL_LOG: callLog,
      FAKE_NO_CHANGES: String(noChanges),
      FAKE_CHANGE_SET_REASON: changeSetReason,
    },
  });
  return {
    fixture,
    result,
    calls: readFileSync(callLog, "utf8"),
    parameters,
    parameterFixture,
  };
}

test(
  "stack recovery passes exact empty and whitespace values through a JSON parameter file",
  { skip: process.platform === "win32" },
  () => {
    const run = runRestore();
    try {
      assert.equal(run.result.status, 0, run.result.stderr);
      assert.match(
        run.calls,
        new RegExp(
          `cloudformation create-change-set[\\s\\S]*--parameters file://${run.parameters.replaceAll("\\", "\\\\")}`,
          "u"
        )
      );
      assert.doesNotMatch(run.calls, /AlarmTopicArn=|PublicDemoCompany=/u);
      assert.match(run.calls, /cloudformation execute-change-set/u);
      assert.match(run.calls, /cloudformation wait stack-update-complete/u);
      assert.deepEqual(
        JSON.parse(readFileSync(run.parameters, "utf8")),
        run.parameterFixture
      );
    } finally {
      rmSync(run.fixture, { recursive: true, force: true });
    }
  }
);

test(
  "stack recovery fails closed on a non-no-change change-set error",
  { skip: process.platform === "win32" },
  () => {
    const run = runRestore(true, "Access denied while creating the change set");
    try {
      assert.notEqual(run.result.status, 0);
      assert.doesNotMatch(run.calls, /cloudformation delete-change-set/u);
      assert.doesNotMatch(run.calls, /cloudformation execute-change-set/u);
    } finally {
      rmSync(run.fixture, { recursive: true, force: true });
    }
  }
);

test(
  "stack recovery accepts only the explicit CloudFormation no-change result",
  { skip: process.platform === "win32" },
  () => {
    const run = runRestore(true);
    try {
      assert.equal(run.result.status, 0, run.result.stderr);
      assert.match(run.calls, /cloudformation describe-change-set/u);
      assert.match(run.calls, /cloudformation delete-change-set/u);
      assert.doesNotMatch(run.calls, /cloudformation execute-change-set/u);
    } finally {
      rmSync(run.fixture, { recursive: true, force: true });
    }
  }
);

function runCleanup(resourcesAbsent = false) {
  const fixture = mkdtempSync(join(tmpdir(), "archon-greenfield-cleanup-"));
  const fakeBin = join(fixture, "bin");
  mkdirSync(fakeBin);
  const callLog = join(fixture, "aws-calls.log");
  const listCount = join(fixture, "list-count");
  writeFileSync(listCount, "0", "utf8");
  executable(
    join(fakeBin, "aws"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >>"$FAKE_AWS_CALL_LOG"
case "$*" in
  *"cloudformation describe-stacks"*)
    if [ "$FAKE_RESOURCES_ABSENT" = "true" ]; then
      echo "ValidationError: Stack does not exist" >&2
      exit 255
    fi
    printf '%s\\n' '{"Stacks":[{}]}' ;;
  *"cloudformation delete-stack"*|*"cloudformation wait stack-delete-complete"*) ;;
  *"s3api get-bucket-location"*)
    if [ "$FAKE_RESOURCES_ABSENT" = "true" ]; then
      echo "NoSuchBucket: The specified bucket does not exist (404)" >&2
      exit 254
    fi
    printf '%s\\n' '{"LocationConstraint":"eu-west-1"}' ;;
  *"s3api list-object-versions"*)
    count="$(cat "$FAKE_LIST_COUNT")"
    if [ "$count" = "0" ]; then
      printf '1' >"$FAKE_LIST_COUNT"
      printf '%s\\n' '{"Versions":[{"Key":"index.html","VersionId":"v1"}],"DeleteMarkers":[{"Key":"old.js","VersionId":"d1"}]}'
    else
      printf '%s\\n' '{"Versions":[],"DeleteMarkers":[]}'
    fi ;;
  *"s3api delete-objects"*) printf '%s\\n' '{}' ;;
  *"s3api delete-bucket"*) ;;
  *"logs delete-log-group"*)
    if [ "$FAKE_RESOURCES_ABSENT" = "true" ]; then
      echo "ResourceNotFoundException: The specified log group does not exist" >&2
      exit 254
    fi ;;
  *) echo "Unexpected aws invocation: $*" >&2; exit 97 ;;
esac
`
  );
  const result = spawnSync("bash", [CLEANUP_SCRIPT], {
    cwd: fixture,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      APP_NAME: "archon-memory",
      ENVIRONMENT: "staging",
      AWS_ACCOUNT_ID: "123456789012",
      AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN:
        "arn:aws:iam::123456789012:role/archon-cloudformation",
      AWS_REGION: "eu-west-1",
      STACK_NAME: "archon-memory-staging",
      FAKE_AWS_CALL_LOG: callLog,
      FAKE_LIST_COUNT: listCount,
      FAKE_RESOURCES_ABSENT: String(resourcesAbsent),
    },
  });
  return {
    fixture,
    result,
    calls: readFileSync(callLog, "utf8"),
  };
}

test(
  "greenfield cleanup deletes the stack and every version before exact retained resources",
  { skip: process.platform === "win32" },
  () => {
    const run = runCleanup();
    try {
      assert.equal(run.result.status, 0, run.result.stderr);
      assert.deepEqual(JSON.parse(run.result.stdout), {
        ok: true,
        state: "greenfield-cleaned",
        stack: "archon-memory-staging",
        stackDeleted: true,
        retainedBucketDeleted: true,
        retainedLogGroupsDeleted: 2,
      });
      assert.match(run.calls, /cloudformation delete-stack/u);
      assert.match(run.calls, /cloudformation wait stack-delete-complete/u);
      assert.match(run.calls, /s3api delete-objects/u);
      assert.match(
        run.calls,
        /s3api delete-bucket --bucket archon-memory-staging-web-123456789012-eu-west-1/u
      );
      assert.match(
        run.calls,
        /logs delete-log-group --log-group-name \/aws\/apigateway\/archon-memory-staging/u
      );
      assert.match(
        run.calls,
        /logs delete-log-group --log-group-name \/aws\/lambda\/archon-memory-staging-api/u
      );
    } finally {
      rmSync(run.fixture, { recursive: true, force: true });
    }
  }
);

test(
  "greenfield cleanup is retry-safe when rollback already removed exact resources",
  { skip: process.platform === "win32" },
  () => {
    const run = runCleanup(true);
    try {
      assert.equal(run.result.status, 0, run.result.stderr);
      assert.deepEqual(JSON.parse(run.result.stdout), {
        ok: true,
        state: "greenfield-cleaned",
        stack: "archon-memory-staging",
        stackDeleted: false,
        retainedBucketDeleted: false,
        retainedLogGroupsDeleted: 0,
      });
      assert.doesNotMatch(run.calls, /cloudformation delete-stack/u);
      assert.doesNotMatch(run.calls, /s3api list-object-versions/u);
      assert.doesNotMatch(run.calls, /s3api delete-bucket/u);
    } finally {
      rmSync(run.fixture, { recursive: true, force: true });
    }
  }
);
