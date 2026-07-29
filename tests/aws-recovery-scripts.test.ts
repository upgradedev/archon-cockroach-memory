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
import assert from "node:assert/strict";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RESTORE_SCRIPT = join(
  ROOT,
  "aws",
  "restore-cloudformation-stack.sh"
);
const CLEANUP_SCRIPT = join(ROOT, "aws", "delete-greenfield-stack.sh");
const SNAPSHOT_SCRIPT = join(ROOT, "aws", "prove-recovery-snapshot.sh");
const TAG_MERGER_SCRIPT = join(
  ROOT,
  "aws",
  "merge-canonical-stack-tags.sh"
);
const TAG_SERIALIZER_SCRIPT = join(
  ROOT,
  "aws",
  "serialize-sam-stack-tags.sh"
);
const ACCOUNT_ID = "123456789012";
const EXECUTION_ROLE_ARN =
  "arn:aws:iam::123456789012:role/archon-cloudformation";
const STACK_ID =
  "arn:aws:cloudformation:eu-west-1:123456789012:stack/archon-memory-staging/stack-uuid";
const GREENFIELD_OWNER = "a".repeat(64);
const RECOVERY_INTENT_ID = "b".repeat(64);
const RETAINED_BUCKET =
  "archon-memory-staging-web-123456789012-eu-west-1";
const API_LOG_GROUP = "/aws/apigateway/archon-memory-staging";
const VENDED_API_LOG_GROUP =
  "/aws/vendedlogs/apigateway/archon-memory-staging";
const LAMBDA_LOG_GROUP = "/aws/lambda/archon-memory-staging-api";
const API_LOG_ARN =
  "arn:aws:logs:eu-west-1:123456789012:log-group:/aws/apigateway/archon-memory-staging";
const VENDED_API_LOG_ARN =
  "arn:aws:logs:eu-west-1:123456789012:log-group:/aws/vendedlogs/apigateway/archon-memory-staging";
const LAMBDA_LOG_ARN =
  "arn:aws:logs:eu-west-1:123456789012:log-group:/aws/lambda/archon-memory-staging-api";

function executable(path: string, content: string): void {
  writeFileSync(path, content, "utf8");
  chmodSync(path, 0o755);
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

interface RestoreOptions {
  changeSetHasChanges?: boolean;
  changeSetReason?: string;
  changeSetPollMode?: "success" | "timeout";
  existingExecutedChangeSet?: boolean;
  initialStackStatus?:
    | "UPDATE_IN_PROGRESS"
    | "UPDATE_COMPLETE_CLEANUP_IN_PROGRESS"
    | "UPDATE_COMPLETE"
    | "UPDATE_FAILED"
    | "UPDATE_ROLLBACK_IN_PROGRESS"
    | "UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS"
    | "UPDATE_ROLLBACK_COMPLETE"
    | "UPDATE_ROLLBACK_FAILED";
  liveStackId?: string;
  mutateImmutableRequest?: "template" | "parameters" | "tags";
  noChanges?: boolean;
  recoveryCancelled?: boolean;
  stabilizationPollMode?: "success" | "timeout";
  stackPollMode?: "success" | "timeout" | "wrong-stack-id" | "json-stream";
  tamperSource?: "template" | "parameters" | "tags";
}

function runRestore(options: RestoreOptions = {}) {
  const {
    changeSetHasChanges = false,
    changeSetReason = "No updates are to be performed.",
    changeSetPollMode = "success",
    existingExecutedChangeSet = false,
    initialStackStatus = "UPDATE_COMPLETE",
    liveStackId = STACK_ID,
    mutateImmutableRequest = "",
    noChanges = false,
    recoveryCancelled = false,
    stabilizationPollMode = "success",
    stackPollMode = "success",
    tamperSource,
  } = options;
  const fixture = mkdtempSync(join(tmpdir(), "archon-stack-restore-"));
  const fakeBin = join(fixture, "bin");
  mkdirSync(fakeBin);
  const callLog = join(fixture, "aws-calls.log");
  const changeSetIdFile = join(fixture, "change-set-id");
  const changeSetNameFile = join(fixture, "change-set-name");
  const immutableTemplatePathFile = join(
    fixture,
    "immutable-template-path"
  );
  const immutableParametersPathFile = join(
    fixture,
    "immutable-parameters-path"
  );
  const immutableTagsPathFile = join(fixture, "immutable-tags-path");
  const pollPhaseFile = join(fixture, "poll-phase");
  const stackStatusFile = join(fixture, "stack-status");
  const template = join(fixture, "previous-stack-template.yaml");
  const parameters = join(fixture, "previous-stack-parameters.json");
  const tags = join(fixture, "previous-stack-tags.json");
  writeFileSync(callLog, "", "utf8");
  writeFileSync(changeSetIdFile, "", "utf8");
  writeFileSync(changeSetNameFile, "", "utf8");
  writeFileSync(immutableTemplatePathFile, "", "utf8");
  writeFileSync(immutableParametersPathFile, "", "utf8");
  writeFileSync(immutableTagsPathFile, "", "utf8");
  writeFileSync(pollPhaseFile, "initial", "utf8");
  writeFileSync(stackStatusFile, initialStackStatus, "utf8");
  writeFileSync(
    template,
    "Transform: AWS::Serverless-2016-10-31\nResources: {}\n",
    "utf8"
  );
  const parameterFixture = [
    { ParameterKey: "AlarmTopicArn", ParameterValue: "" },
    { ParameterKey: "PublicDemoCompany", ParameterValue: "Helios SA" },
  ];
  const tagFixture = [
    { Key: "Application", Value: "archon-memory" },
    { Key: "Environment", Value: "staging" },
  ];
  writeFileSync(
    parameters,
    `${JSON.stringify(parameterFixture, null, 2)}\n`,
    "utf8"
  );
  writeFileSync(tags, JSON.stringify(tagFixture), "utf8");
  const templateSha256 = sha256(template);
  const parametersSha256 = sha256(parameters);
  const tagsSha256 = sha256(tags);
  if (tamperSource === "template") {
    writeFileSync(template, `${readFileSync(template, "utf8")}# tampered\n`);
  } else if (tamperSource === "parameters") {
    writeFileSync(
      parameters,
      JSON.stringify([
        ...parameterFixture,
        { ParameterKey: "Environment", ParameterValue: "production" },
      ]),
      "utf8"
    );
  } else if (tamperSource === "tags") {
    writeFileSync(
      tags,
      JSON.stringify([
        ...tagFixture,
        { Key: "Environment", Value: "production" },
      ]),
      "utf8"
    );
  }
  executable(
    join(fakeBin, "aws"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >>"$FAKE_AWS_CALL_LOG"
arg_value() {
  local target="$1"
  shift
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "$target" ]; then
      printf '%s\\n' "$2"
      return
    fi
    shift
  done
  return 1
}
has_arg() {
  local target="$1"
  shift
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "$target" ]; then
      return 0
    fi
    shift
  done
  return 1
}
assert_stack_target() {
  test "$(arg_value --stack-name "$@")" = "$FAKE_LIVE_STACK_ID"
}
assert_change_set_target() {
  actual_change_set="$(arg_value --change-set-name "$@")"
  test "$actual_change_set" = "$(cat "$FAKE_CHANGE_SET_ID_FILE")" ||
    test "$actual_change_set" = "$(cat "$FAKE_CHANGE_SET_NAME_FILE")"
}
case "$*" in
  *"cloudformation describe-stacks"*)
    exact_restored_snapshot=true
    if [ "$FAKE_EXISTING_EXECUTED_CHANGE_SET" = "true" ] &&
       [ "\${ARCHON_RECOVERY_CHANGESET_GENERATION:-0}" = "0" ]; then
      exact_restored_snapshot=false
    fi
    poll_phase="$(cat "$FAKE_POLL_PHASE_FILE")"
    stack_status="$(cat "$FAKE_STACK_STATUS_FILE")"
    reported_stack_id="$FAKE_LIVE_STACK_ID"
    if [ "$poll_phase" = "stabilize" ] &&
       [ "$FAKE_STABILIZATION_POLL_MODE" = "success" ]; then
      case "$stack_status" in
        UPDATE_COMPLETE_CLEANUP_IN_PROGRESS)
          stack_status="UPDATE_COMPLETE"
          ;;
        UPDATE_ROLLBACK_IN_PROGRESS|UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS)
          stack_status="UPDATE_ROLLBACK_COMPLETE"
          ;;
      esac
      printf '%s' "$stack_status" >"$FAKE_STACK_STATUS_FILE"
    elif [ "$poll_phase" = "restore" ]; then
      case "$FAKE_STACK_POLL_MODE" in
        success)
          stack_status="UPDATE_COMPLETE"
          printf '%s' "$stack_status" >"$FAKE_STACK_STATUS_FILE"
          ;;
        timeout)
          stack_status="UPDATE_IN_PROGRESS"
          ;;
        wrong-stack-id)
          stack_status="UPDATE_IN_PROGRESS"
          reported_stack_id="${STACK_ID.replace("stack-uuid", "wrong-stack")}"
          ;;
        json-stream)
          stack_status="UPDATE_IN_PROGRESS"
          ;;
        *) exit 91 ;;
      esac
    fi
    emit_stack_response() {
    jq -n \
      --arg stack "archon-memory-staging" \
      --arg stackId "$reported_stack_id" \
      --arg role "$AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN" \
      --arg status "$stack_status" \
      --argjson parameters "$FAKE_STACK_PARAMETERS_JSON" \
      --argjson tags "$FAKE_STACK_TAGS_JSON" \
      --argjson exactRestoredSnapshot "$exact_restored_snapshot" \
      '{
        Stacks: [{
          StackName: $stack,
          StackId: $stackId,
          RoleARN: $role,
          StackStatus: $status,
          Parameters: (
            if $exactRestoredSnapshot
            then $parameters
            else (
              $parameters
              | map(
                  if .ParameterKey == "PublicDemoCompany"
                  then .ParameterValue = "incorrect-live-value"
                  else .
                  end
                )
            )
            end
          ),
          Tags: $tags
        }]
      }'
    }
    emit_stack_response
    if [ "$poll_phase" = "restore" ] &&
       [ "$FAKE_STACK_POLL_MODE" = "json-stream" ]; then
      emit_stack_response
    fi
    if [ "$poll_phase" = "initial" ]; then
      case "$stack_status" in
        UPDATE_IN_PROGRESS|\
        UPDATE_COMPLETE_CLEANUP_IN_PROGRESS|\
        UPDATE_FAILED|\
        UPDATE_ROLLBACK_IN_PROGRESS|\
        UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS|\
        UPDATE_ROLLBACK_FAILED)
          printf '%s' "stabilize" >"$FAKE_POLL_PHASE_FILE"
          ;;
      esac
    fi ;;
  *"cloudformation get-template"*)
    assert_stack_target "$@"
    test "$(arg_value --template-stage "$@")" = "Original"
    jq -Rs \
      '{
        TemplateBody: (
          if endswith("\n")
          then .[0:-1]
          else .
          end
        )
      }' "$FAKE_SOURCE_TEMPLATE_FILE" ;;
  *"cloudformation continue-update-rollback"*)
    assert_stack_target "$@"
    test "$(arg_value --role-arn "$@")" = \
      "$AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN"
    test "$(arg_value --client-request-token "$@")" = \
      "archon-continue-${RECOVERY_INTENT_ID.slice(0, 48)}"
    printf '%s' "UPDATE_ROLLBACK_IN_PROGRESS" >"$FAKE_STACK_STATUS_FILE"
    printf '%s' "stabilize" >"$FAKE_POLL_PHASE_FILE" ;;
  *"cloudformation cancel-update-stack"*)
    assert_stack_target "$@"
    test "$(cat "$FAKE_STACK_STATUS_FILE")" = "UPDATE_IN_PROGRESS"
    test "$(arg_value --client-request-token "$@")" = \
      "archon-cancel-${RECOVERY_INTENT_ID.slice(0, 48)}"
    printf '%s' "UPDATE_ROLLBACK_IN_PROGRESS" >"$FAKE_STACK_STATUS_FILE"
    printf '%s' "stabilize" >"$FAKE_POLL_PHASE_FILE" ;;
  *"cloudformation rollback-stack"*)
    assert_stack_target "$@"
    test "$(cat "$FAKE_STACK_STATUS_FILE")" = "UPDATE_FAILED"
    test "$(arg_value --role-arn "$@")" = \
      "$AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN"
    test "$(arg_value --client-request-token "$@")" = \
      "archon-rollback-${RECOVERY_INTENT_ID.slice(0, 48)}"
    has_arg --retain-except-on-create "$@"
    printf '%s' "UPDATE_ROLLBACK_IN_PROGRESS" >"$FAKE_STACK_STATUS_FILE"
    printf '%s' "stabilize" >"$FAKE_POLL_PHASE_FILE" ;;
  *"cloudformation create-change-set"*)
    assert_stack_target "$@"
    change_set_name="$(arg_value --change-set-name "$@")"
    test "$(arg_value --client-token "$@")" = "$change_set_name"
    test "$(arg_value --change-set-type "$@")" = "UPDATE"
    test "$(arg_value --role-arn "$@")" = \
      "$AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN"
    test "$(arg_value --description "$@")" = \
      "Restore the exact pre-deployment Archon application stack"
    template_uri="$(arg_value --template-body "$@")"
    parameters_uri="$(arg_value --parameters "$@")"
    tags_uri="$(arg_value --tags "$@")"
    [[ "$template_uri" == file://* ]]
    [[ "$parameters_uri" == file://* ]]
    [[ "$tags_uri" == file://* ]]
    template_path="\${template_uri#file://}"
    parameters_path="\${parameters_uri#file://}"
    tags_path="\${tags_uri#file://}"
    test "$template_path" != "$FAKE_SOURCE_TEMPLATE_FILE"
    test "$parameters_path" != "$FAKE_SOURCE_PARAMETERS_FILE"
    test "$tags_path" != "$FAKE_SOURCE_TAGS_FILE"
    test "$(sha256sum "$template_path" | awk '{print $1}')" = \
      "$EXPECTED_PREVIOUS_STACK_TEMPLATE_SHA256"
    test "$(sha256sum "$parameters_path" | awk '{print $1}')" = \
      "$EXPECTED_PREVIOUS_STACK_PARAMETERS_SHA256"
    test "$(sha256sum "$tags_path" | awk '{print $1}')" = \
      "$EXPECTED_PREVIOUS_STACK_TAGS_SHA256"
    printf '%s' "$template_path" >"$FAKE_IMMUTABLE_TEMPLATE_PATH_FILE"
    printf '%s' "$parameters_path" >"$FAKE_IMMUTABLE_PARAMETERS_PATH_FILE"
    printf '%s' "$tags_path" >"$FAKE_IMMUTABLE_TAGS_PATH_FILE"
    printf '%s' "$change_set_name" >"$FAKE_CHANGE_SET_NAME_FILE"
    change_set_id="arn:aws:cloudformation:eu-west-1:123456789012:changeSet/$change_set_name/change-set-uuid"
    printf '%s' "$change_set_id" >"$FAKE_CHANGE_SET_ID_FILE"
    if [ "$FAKE_EXISTING_EXECUTED_CHANGE_SET" = "true" ] &&
       [[ "$change_set_name" == *-0 ]]; then
      echo "AlreadyExistsException: Change set already exists" >&2
      exit 255
    fi
    case "$FAKE_MUTATE_IMMUTABLE_REQUEST" in
      template)
        chmod 0600 "$template_path"
        printf '%s\\n' "# mutated after create" >>"$template_path"
        ;;
      parameters)
        chmod 0600 "$parameters_path"
        printf '%s\\n' '[]' >"$parameters_path"
        ;;
      tags)
        chmod 0600 "$tags_path"
        printf '%s\\n' '[]' >"$tags_path"
        ;;
      "") ;;
      *) exit 96 ;;
    esac
    jq -n \
      --arg id "$change_set_id" \
      --arg stackId "$FAKE_LIVE_STACK_ID" \
      '{Id:$id,StackId:$stackId}' ;;
  *"cloudformation describe-change-set"*)
    assert_stack_target "$@"
    assert_change_set_target "$@"
    change_set_id="$(cat "$FAKE_CHANGE_SET_ID_FILE")"
    change_set_name="$(cat "$FAKE_CHANGE_SET_NAME_FILE")"
    executed=false
    if [ "$FAKE_EXISTING_EXECUTED_CHANGE_SET" = "true" ] &&
       [[ "$change_set_name" == *-0 ]]; then
      executed=true
    fi
    if [ "$FAKE_CHANGE_SET_POLL_MODE" = "timeout" ]; then
      change_set_status="CREATE_IN_PROGRESS"
      change_set_execution_status="UNAVAILABLE"
    elif [ "$FAKE_NO_CHANGES" = "true" ]; then
      change_set_status="FAILED"
      change_set_execution_status="UNAVAILABLE"
    elif [ "$executed" = "true" ]; then
      change_set_status="CREATE_COMPLETE"
      change_set_execution_status="EXECUTE_COMPLETE"
    else
      change_set_status="CREATE_COMPLETE"
      change_set_execution_status="AVAILABLE"
    fi
    jq -n \
      --arg id "$change_set_id" \
      --arg name "$change_set_name" \
      --arg stackId "$FAKE_LIVE_STACK_ID" \
      --arg reason "$FAKE_CHANGE_SET_REASON" \
      --argjson parameters \
        "$(cat "$(cat "$FAKE_IMMUTABLE_PARAMETERS_PATH_FILE")")" \
      --argjson tags \
        "$(cat "$(cat "$FAKE_IMMUTABLE_TAGS_PATH_FILE")")" \
      --arg status "$change_set_status" \
      --arg executionStatus "$change_set_execution_status" \
      --argjson hasChanges "$FAKE_CHANGE_SET_HAS_CHANGES" \
      '{
        ChangeSetId: $id,
        ChangeSetName: $name,
        StackId: $stackId,
        Description: "Restore the exact pre-deployment Archon application stack",
        Capabilities: ["CAPABILITY_AUTO_EXPAND"],
        Parameters: $parameters,
        Tags: $tags,
        Status: $status,
        ExecutionStatus: $executionStatus,
        StatusReason: $reason,
        Changes: (
          if $hasChanges
          then [{ResourceChange: {Action: "Modify"}}]
          else []
          end
        )
      }' ;;
  *"cloudformation delete-change-set"*)
    assert_stack_target "$@"
    assert_change_set_target "$@" ;;
  *"cloudformation execute-change-set"*)
    assert_stack_target "$@"
    assert_change_set_target "$@"
    test "$(arg_value --client-request-token "$@")" = \
      "execute-$(cat "$FAKE_CHANGE_SET_NAME_FILE")"
    has_arg --no-disable-rollback "$@"
    has_arg --retain-except-on-create "$@"
    printf '%s' "UPDATE_IN_PROGRESS" >"$FAKE_STACK_STATUS_FILE"
    printf '%s' "restore" >"$FAKE_POLL_PHASE_FILE" ;;
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
      AWS_ACCOUNT_ID: ACCOUNT_ID,
      AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN: EXECUTION_ROLE_ARN,
      AWS_REGION: "eu-west-1",
      EXPECTED_PREVIOUS_STACK_ID: STACK_ID,
      EXPECTED_PREVIOUS_STACK_TEMPLATE_SHA256: templateSha256,
      EXPECTED_PREVIOUS_STACK_PARAMETERS_SHA256: parametersSha256,
      EXPECTED_PREVIOUS_STACK_TAGS_SHA256: tagsSha256,
      RECOVERY_INTENT_ID,
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "1",
      PREVIOUS_STACK_TEMPLATE_FILE: template,
      PREVIOUS_STACK_PARAMETERS_FILE: parameters,
      PREVIOUS_STACK_TAGS_FILE: tags,
      FAKE_AWS_CALL_LOG: callLog,
      FAKE_CHANGE_SET_ID_FILE: changeSetIdFile,
      FAKE_CHANGE_SET_NAME_FILE: changeSetNameFile,
      FAKE_IMMUTABLE_TEMPLATE_PATH_FILE: immutableTemplatePathFile,
      FAKE_IMMUTABLE_PARAMETERS_PATH_FILE:
        immutableParametersPathFile,
      FAKE_IMMUTABLE_TAGS_PATH_FILE: immutableTagsPathFile,
      FAKE_POLL_PHASE_FILE: pollPhaseFile,
      FAKE_LIVE_STACK_ID: liveStackId,
      FAKE_STACK_TAGS_JSON: JSON.stringify(tagFixture),
      FAKE_STACK_PARAMETERS_JSON: JSON.stringify(parameterFixture),
      FAKE_EXISTING_EXECUTED_CHANGE_SET: String(
        existingExecutedChangeSet
      ),
      FAKE_MUTATE_IMMUTABLE_REQUEST: mutateImmutableRequest,
      FAKE_PARAMETERS_FILE: parameters,
      FAKE_NO_CHANGES: String(noChanges),
      FAKE_CHANGE_SET_POLL_MODE: changeSetPollMode,
      FAKE_CHANGE_SET_HAS_CHANGES: String(changeSetHasChanges),
      RECOVERY_CANCELLED: String(recoveryCancelled),
      FAKE_SOURCE_TEMPLATE_FILE: template,
      FAKE_SOURCE_PARAMETERS_FILE: parameters,
      FAKE_SOURCE_TAGS_FILE: tags,
      FAKE_STACK_STATUS_FILE: stackStatusFile,
      FAKE_STABILIZATION_POLL_MODE: stabilizationPollMode,
      FAKE_STACK_POLL_MODE: stackPollMode,
      FAKE_CHANGE_SET_REASON: changeSetReason,
      ARCHON_RECOVERY_STABILIZE_POLL_ATTEMPTS: "2",
      ARCHON_RECOVERY_STABILIZE_POLL_INTERVAL_SECONDS: "0",
      ARCHON_RECOVERY_CHANGE_SET_POLL_ATTEMPTS: "2",
      ARCHON_RECOVERY_CHANGE_SET_POLL_INTERVAL_SECONDS: "0",
      ARCHON_RECOVERY_FINAL_POLL_ATTEMPTS: "2",
      ARCHON_RECOVERY_FINAL_POLL_INTERVAL_SECONDS: "0",
    },
  });
  return {
    fixture,
    result,
    calls: readFileSync(callLog, "utf8"),
    changeSetId: readFileSync(changeSetIdFile, "utf8"),
    changeSetName: readFileSync(changeSetNameFile, "utf8"),
    immutableTemplatePath: readFileSync(
      immutableTemplatePathFile,
      "utf8"
    ),
    immutableParametersPath: readFileSync(
      immutableParametersPathFile,
      "utf8"
    ),
    immutableTagsPath: readFileSync(immutableTagsPathFile, "utf8"),
    parameters,
    parameterFixture,
    tags,
    tagFixture,
    template,
  };
}

function findAwsCall(calls: string, operation: string): string {
  const call = calls
    .split(/\r?\n/u)
    .find((candidate) => candidate.includes(operation));
  assert.ok(call, `Expected AWS call containing "${operation}"`);
  return call;
}

test("AWS recovery scripts contain no CloudFormation service waiter", () => {
  for (const script of [RESTORE_SCRIPT, CLEANUP_SCRIPT]) {
    assert.doesNotMatch(
      readFileSync(script, "utf8"),
      /\bcloudformation\s+wait\b/u,
      script
    );
  }
});

test(
  "stack recovery uses immutable files, the returned ARN, and idempotent execution options",
  { skip: process.platform === "win32" },
  () => {
    const run = runRestore();
    try {
      assert.equal(run.result.status, 0, run.result.stderr);
      assert.match(
        run.changeSetId,
        new RegExp(
          `^arn:aws:cloudformation:eu-west-1:${ACCOUNT_ID}:changeSet/${run.changeSetName}/change-set-uuid$`,
          "u"
        )
      );
      assert.notEqual(run.immutableTemplatePath, run.template);
      assert.notEqual(run.immutableParametersPath, run.parameters);
      assert.notEqual(run.immutableTagsPath, run.tags);

      const createCall = findAwsCall(
        run.calls,
        "cloudformation create-change-set"
      );
      assert.ok(
        createCall.includes(`--stack-name ${STACK_ID}`),
        createCall
      );
      assert.ok(
        createCall.includes(
          `--change-set-name ${run.changeSetName}`
        ),
        createCall
      );
      assert.ok(
        createCall.includes(`--client-token ${run.changeSetName}`),
        createCall
      );
      assert.ok(
        createCall.includes(
          `--template-body file://${run.immutableTemplatePath}`
        ),
        createCall
      );
      assert.ok(
        createCall.includes(
          `--parameters file://${run.immutableParametersPath}`
        ),
        createCall
      );
      assert.ok(
        createCall.includes(`--tags file://${run.immutableTagsPath}`),
        createCall
      );
      assert.doesNotMatch(createCall, /AlarmTopicArn=|PublicDemoCompany=/u);

      for (const operation of [
        "cloudformation describe-change-set",
        "cloudformation execute-change-set",
      ]) {
        const call = findAwsCall(run.calls, operation);
        assert.ok(
          call.includes(`--change-set-name ${run.changeSetId}`),
          call
        );
      }

      const executeCall = findAwsCall(
        run.calls,
        "cloudformation execute-change-set"
      );
      assert.ok(
        executeCall.includes(
          `--client-request-token execute-${run.changeSetName}`
        ),
        executeCall
      );
      assert.ok(executeCall.includes("--no-disable-rollback"), executeCall);
      assert.ok(
        executeCall.includes("--retain-except-on-create"),
        executeCall
      );
      assert.doesNotMatch(run.calls, /cloudformation wait/u);
      const exactStackPolls = run.calls
        .split(/\r?\n/u)
        .filter(
          (call) =>
            call.includes("cloudformation describe-stacks") &&
            call.includes(`--stack-name ${STACK_ID}`)
        );
      assert.ok(exactStackPolls.length >= 1, run.calls);
      const getTemplateCall = findAwsCall(
        run.calls,
        "cloudformation get-template"
      );
      assert.ok(
        getTemplateCall.includes(`--stack-name ${STACK_ID}`),
        getTemplateCall
      );
      assert.ok(
        getTemplateCall.includes("--template-stage Original"),
        getTemplateCall
      );
      assert.deepEqual(
        JSON.parse(readFileSync(run.parameters, "utf8")),
        run.parameterFixture
      );
      assert.deepEqual(
        JSON.parse(readFileSync(run.tags, "utf8")),
        run.tagFixture
      );
    } finally {
      rmSync(run.fixture, { recursive: true, force: true });
    }
  }
);

test(
  "stack recovery advances generation when an executed change set did not restore the bound snapshot",
  { skip: process.platform === "win32" },
  () => {
    const run = runRestore({ existingExecutedChangeSet: true });
    try {
      assert.equal(run.result.status, 0, run.result.stderr);
      const changeSetPrefix =
        `archon-recovery-${RECOVERY_INTENT_ID.slice(0, 48)}`;
      const createCalls = run.calls
        .split(/\r?\n/u)
        .filter((call) =>
          call.includes("cloudformation create-change-set")
        );
      assert.equal(createCalls.length, 2);
      assert.match(
        createCalls[0] ?? "",
        new RegExp(`--change-set-name ${changeSetPrefix}-0(?:\\s|$)`, "u")
      );
      assert.match(
        createCalls[1] ?? "",
        new RegExp(`--change-set-name ${changeSetPrefix}-1(?:\\s|$)`, "u")
      );
      const executeCalls = run.calls
        .split(/\r?\n/u)
        .filter((call) =>
          call.includes("cloudformation execute-change-set")
        );
      assert.equal(executeCalls.length, 1);
      assert.match(
        executeCalls[0] ?? "",
        new RegExp(
          `changeSet/${changeSetPrefix}-1/change-set-uuid(?:\\s|$)`,
          "u"
        )
      );
      assert.doesNotMatch(
        executeCalls[0] ?? "",
        new RegExp(`changeSet/${changeSetPrefix}-0/`, "u")
      );
      const exactSnapshotChecks = run.calls
        .split(/\r?\n/u)
        .filter((call) =>
          call.includes(
            "cloudformation get-template"
          )
        );
      assert.equal(exactSnapshotChecks.length, 2);
      assert.ok(
        exactSnapshotChecks.every((call) =>
          call.includes("--template-stage Original")
        )
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
    const run = runRestore({
      changeSetReason: "Access denied while creating the change set",
      initialStackStatus: "UPDATE_ROLLBACK_COMPLETE",
      noChanges: true,
    });
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
  "stack recovery rejects a no-change reason paired with resource changes",
  { skip: process.platform === "win32" },
  () => {
    const run = runRestore({
      changeSetHasChanges: true,
      initialStackStatus: "UPDATE_ROLLBACK_COMPLETE",
      noChanges: true,
    });
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
  "stack recovery accepts an exact no-change result from UPDATE_ROLLBACK_COMPLETE",
  { skip: process.platform === "win32" },
  () => {
    const run = runRestore({
      initialStackStatus: "UPDATE_ROLLBACK_COMPLETE",
      noChanges: true,
    });
    try {
      assert.equal(run.result.status, 0, run.result.stderr);
      const describeCall = findAwsCall(
        run.calls,
        "cloudformation describe-change-set"
      );
      const deleteCall = findAwsCall(
        run.calls,
        "cloudformation delete-change-set"
      );
      assert.ok(
        describeCall.includes(`--change-set-name ${run.changeSetId}`),
        describeCall
      );
      assert.ok(
        deleteCall.includes(`--change-set-name ${run.changeSetId}`),
        deleteCall
      );
      assert.doesNotMatch(run.calls, /cloudformation execute-change-set/u);
    } finally {
      rmSync(run.fixture, { recursive: true, force: true });
    }
  }
);

test(
  "stack recovery repairs UPDATE_ROLLBACK_FAILED before restoring",
  { skip: process.platform === "win32" },
  () => {
    const run = runRestore({
      initialStackStatus: "UPDATE_ROLLBACK_FAILED",
    });
    try {
      assert.equal(run.result.status, 0, run.result.stderr);
      const continueCall = findAwsCall(
        run.calls,
        "cloudformation continue-update-rollback"
      );
      assert.ok(
        continueCall.includes(`--stack-name ${STACK_ID}`),
        continueCall
      );
      assert.ok(
        continueCall.includes(
          `--client-request-token archon-continue-${RECOVERY_INTENT_ID.slice(0, 48)}`
        ),
        continueCall
      );
      assert.ok(
        continueCall.includes(`--role-arn ${EXECUTION_ROLE_ARN}`),
        continueCall
      );
      const exactStackPoll = run.calls
        .split(/\r?\n/u)
        .find(
          (call) =>
            call.includes("cloudformation describe-stacks") &&
            call.includes(`--stack-name ${STACK_ID}`)
        );
      assert.ok(exactStackPoll, run.calls);
      assert.doesNotMatch(run.calls, /cloudformation wait/u);
      assert.ok(
        run.calls.indexOf("cloudformation continue-update-rollback") <
          run.calls.indexOf("cloudformation create-change-set")
      );
      assert.match(run.calls, /cloudformation execute-change-set/u);
    } finally {
      rmSync(run.fixture, { recursive: true, force: true });
    }
  }
);

for (const activeRecovery of [
  {
    initialStackStatus: "UPDATE_IN_PROGRESS",
    operation: "cloudformation cancel-update-stack",
  },
  {
    initialStackStatus: "UPDATE_COMPLETE_CLEANUP_IN_PROGRESS",
    operation: null,
  },
  {
    initialStackStatus: "UPDATE_FAILED",
    operation: "cloudformation rollback-stack",
  },
  {
    initialStackStatus: "UPDATE_ROLLBACK_IN_PROGRESS",
    operation: null,
  },
  {
    initialStackStatus: "UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS",
    operation: null,
  },
] as const) {
  test(
    `stack recovery stabilizes ${activeRecovery.initialStackStatus} before restoring`,
    { skip: process.platform === "win32" },
    () => {
      const run = runRestore({
        initialStackStatus: activeRecovery.initialStackStatus,
      });
      try {
        assert.equal(run.result.status, 0, run.result.stderr);
        const createCall = findAwsCall(
          run.calls,
          "cloudformation create-change-set"
        );
        const exactStackPolls = run.calls
          .split(/\r?\n/u)
          .filter(
            (call) =>
              call.includes("cloudformation describe-stacks") &&
              call.includes(`--stack-name ${STACK_ID}`)
          );
        assert.ok(exactStackPolls.length >= 1, run.calls);
        assert.ok(
          run.calls.indexOf(exactStackPolls[0] ?? "") <
            run.calls.indexOf(createCall)
        );
        if (activeRecovery.operation !== null) {
          const operationCall = findAwsCall(
            run.calls,
            activeRecovery.operation
          );
          assert.ok(operationCall.includes(`--stack-name ${STACK_ID}`));
          assert.ok(
            run.calls.indexOf(operationCall) <
              run.calls.indexOf(createCall)
          );
        }
        assert.doesNotMatch(run.calls, /cloudformation wait/u);
      } finally {
        rmSync(run.fixture, { recursive: true, force: true });
      }
    }
  );
}

test(
  "cancelled stack recovery hands UPDATE_IN_PROGRESS rollback to CloudFormation",
  { skip: process.platform === "win32" },
  () => {
    const run = runRestore({
      initialStackStatus: "UPDATE_IN_PROGRESS",
      recoveryCancelled: true,
    });
    try {
      assert.equal(run.result.status, 0, run.result.stderr);
      const cancelCall = findAwsCall(
        run.calls,
        "cloudformation cancel-update-stack"
      );
      assert.ok(cancelCall.includes(`--stack-name ${STACK_ID}`));
      assert.ok(
        cancelCall.includes(
          `--client-request-token archon-cancel-${RECOVERY_INTENT_ID.slice(0, 48)}`
        )
      );
      assert.doesNotMatch(
        run.calls,
        /cloudformation wait/u
      );
      assert.doesNotMatch(
        run.calls,
        /cloudformation create-change-set/u
      );
      assert.match(run.result.stdout, /handed off durably/u);
    } finally {
      rmSync(run.fixture, { recursive: true, force: true });
    }
  }
);

for (const mutation of ["template", "parameters", "tags"] as const) {
  test(
    `stack recovery rejects ${mutation} mutation after change-set creation`,
    { skip: process.platform === "win32" },
    () => {
      const run = runRestore({ mutateImmutableRequest: mutation });
      try {
        assert.notEqual(run.result.status, 0);
        assert.match(run.calls, /cloudformation create-change-set/u);
        assert.doesNotMatch(
          run.calls,
          /cloudformation describe-change-set/u
        );
        assert.doesNotMatch(
          run.calls,
          /cloudformation execute-change-set/u
        );
      } finally {
        rmSync(run.fixture, { recursive: true, force: true });
      }
    }
  );
}

for (const tamperSource of ["template", "parameters", "tags"] as const) {
  test(
    `stack recovery rejects a tampered source ${tamperSource} before any AWS call`,
    { skip: process.platform === "win32" },
    () => {
      const run = runRestore({ tamperSource });
      try {
        assert.notEqual(run.result.status, 0);
        assert.equal(run.calls, "");
      } finally {
        rmSync(run.fixture, { recursive: true, force: true });
      }
    }
  );
}

test(
  "stack recovery rejects a replacement stack before creating a change set",
  { skip: process.platform === "win32" },
  () => {
    const replacementStackId = STACK_ID.replace("stack-uuid", "replacement");
    const run = runRestore({ liveStackId: replacementStackId });
    try {
      assert.notEqual(run.result.status, 0);
      assert.match(run.calls, /cloudformation describe-stacks/u);
      assert.doesNotMatch(run.calls, /cloudformation create-change-set/u);
    } finally {
      rmSync(run.fixture, { recursive: true, force: true });
    }
  }
);

test(
  "stack recovery bounds change-set polling and leaves it for a later watchdog",
  { skip: process.platform === "win32" },
  () => {
    const run = runRestore({ changeSetPollMode: "timeout" });
    try {
      assert.notEqual(run.result.status, 0);
      const describeCalls = run.calls
        .split(/\r?\n/u)
        .filter((call) =>
          call.includes("cloudformation describe-change-set")
        );
      assert.equal(describeCalls.length, 2, run.calls);
      assert.ok(
        describeCalls.every((call) =>
          call.includes(`--change-set-name ${run.changeSetId}`)
        ),
        run.calls
      );
      assert.doesNotMatch(run.calls, /cloudformation execute-change-set/u);
      assert.doesNotMatch(run.calls, /cloudformation wait/u);
      assert.match(run.result.stderr, /later watchdog retry/u);
    } finally {
      rmSync(run.fixture, { recursive: true, force: true });
    }
  }
);

test(
  "stack recovery bounds initial stabilization and preserves AWS handoff",
  { skip: process.platform === "win32" },
  () => {
    const run = runRestore({
      initialStackStatus: "UPDATE_IN_PROGRESS",
      stabilizationPollMode: "timeout",
    });
    try {
      assert.notEqual(run.result.status, 0);
      assert.match(run.calls, /cloudformation cancel-update-stack/u);
      const exactPolls = run.calls
        .split(/\r?\n/u)
        .filter(
          (call) =>
            call.includes("cloudformation describe-stacks") &&
            call.includes(`--stack-name ${STACK_ID}`)
        );
      assert.equal(exactPolls.length, 2, run.calls);
      assert.doesNotMatch(run.calls, /cloudformation create-change-set/u);
      assert.doesNotMatch(run.calls, /cloudformation wait/u);
      assert.match(run.result.stderr, /later watchdog retry/u);
    } finally {
      rmSync(run.fixture, { recursive: true, force: true });
    }
  }
);

for (const pollFailure of [
  { name: "timeout", mode: "timeout" },
  { name: "wrong StackId", mode: "wrong-stack-id" },
  { name: "multiple-object JSON stream", mode: "json-stream" },
] as const) {
  test(
    `stack recovery fails closed on final polling ${pollFailure.name}`,
    { skip: process.platform === "win32" },
    () => {
      const run = runRestore({ stackPollMode: pollFailure.mode });
      try {
        assert.notEqual(run.result.status, 0);
        assert.match(run.calls, /cloudformation execute-change-set/u);
        assert.match(run.calls, /cloudformation describe-stacks/u);
        assert.doesNotMatch(run.calls, /cloudformation get-template/u);
        assert.doesNotMatch(run.calls, /cloudformation wait/u);
        assert.match(run.result.stderr, /later watchdog retry/u);
      } finally {
        rmSync(run.fixture, { recursive: true, force: true });
      }
    }
  );
}

interface SnapshotOptions {
  appName?: string;
  candidateSha?: string;
  environment?: "staging" | "production";
  repository?: string;
  runAttempt?: string;
  runId?: string;
}

function runSnapshot(
  stackState: "existing" | "greenfield",
  options: SnapshotOptions = {}
) {
  const {
    appName = "archon-memory",
    candidateSha = "c".repeat(40),
    environment = "staging",
    repository = "upgradedev/archon-cockroach-memory",
    runAttempt = "1",
    runId = "123",
  } = options;
  const fixture = mkdtempSync(join(tmpdir(), "archon-recovery-snapshot-"));
  const template = join(fixture, "previous-stack-template.yaml");
  const parameters = join(fixture, "previous-stack-parameters.json");
  const tags = join(fixture, "previous-stack-tags.json");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    APP_NAME: appName,
    ENVIRONMENT: environment,
    AWS_ACCOUNT_ID: ACCOUNT_ID,
    AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN: EXECUTION_ROLE_ARN,
    AWS_REGION: "eu-west-1",
    STACK_NAME: `${appName}-${environment}`,
    STACK_STATE: stackState,
    HAS_PREVIOUS_STACK: String(stackState === "existing"),
    CANDIDATE_SHA: candidateSha,
    GITHUB_REPOSITORY: repository,
    GITHUB_RUN_ID: runId,
    GITHUB_RUN_ATTEMPT: runAttempt,
    SOURCE_DEPLOY_RUN_ATTEMPT: runAttempt,
    SOURCE_DEPLOY_RUN_ID: runId,
    SOURCE_REPOSITORY: repository,
    PREVIOUS_STACK_TEMPLATE_FILE: template,
    PREVIOUS_STACK_PARAMETERS_FILE: parameters,
    PREVIOUS_STACK_TAGS_FILE: tags,
  };
  if (stackState === "existing") {
    writeFileSync(
      template,
      "Transform: AWS::Serverless-2016-10-31\nResources: {}\n",
      "utf8"
    );
    writeFileSync(
      parameters,
      JSON.stringify([
        { ParameterKey: "Environment", ParameterValue: environment },
      ]),
      "utf8"
    );
    writeFileSync(
      tags,
      JSON.stringify([
        { Key: "Application", Value: appName },
        { Key: "Environment", Value: environment },
      ]),
      "utf8"
    );
    Object.assign(env, {
      EXPECTED_TAGS_SHA256: sha256(tags),
      PREVIOUS_STACK_ID: STACK_ID,
      PREVIOUS_STACK_STATUS: "UPDATE_COMPLETE",
      PREVIOUS_STACK_REVISION: "2026-07-26T12:00:00Z",
      PREVIOUS_FUNCTION_NAME: `${appName}-${environment}-api`,
      PREVIOUS_FUNCTION_VERSION: "42",
      PREVIOUS_APPLICATION_URL: "https://example.test",
    });
  }
  const result = spawnSync("bash", [SNAPSHOT_SCRIPT], {
    cwd: fixture,
    encoding: "utf8",
    env,
  });
  return { fixture, result };
}

test(
  "canonical stack tag merger backfills identity without weakening recovery snapshots",
  { skip: process.platform === "win32" },
  () => {
    const fixture = mkdtempSync(join(tmpdir(), "archon-canonical-tags-"));
    const tagsFile = join(fixture, "tags.json");
    const run = (
      tags: Array<{ Key: string; Value: string }>,
      environment = "staging",
      greenfieldOwner = ""
    ) => {
      writeFileSync(tagsFile, JSON.stringify(tags), "utf8");
      return spawnSync("bash", [TAG_MERGER_SCRIPT, tagsFile], {
        encoding: "utf8",
        env: {
          ...process.env,
          APP_NAME: "archon-memory",
          ENVIRONMENT: environment,
          GREENFIELD_OWNER: greenfieldOwner,
        },
      });
    };

    try {
      const legacy = run([]);
      assert.equal(legacy.status, 0, legacy.stderr);
      assert.deepEqual(JSON.parse(legacy.stdout), [
        { Key: "Application", Value: "archon-memory" },
        { Key: "Environment", Value: "staging" },
      ]);

      const existing = run([
        { Key: "Environment", Value: "wrong" },
        { Key: "Owner", Value: "Finance Platform" },
        { Key: "Application", Value: "wrong" },
        { Key: "ArchonGreenfieldOwner", Value: "legacy-owner" },
      ]);
      assert.equal(existing.status, 0, existing.stderr);
      assert.deepEqual(JSON.parse(existing.stdout), [
        { Key: "Application", Value: "archon-memory" },
        { Key: "ArchonGreenfieldOwner", Value: "legacy-owner" },
        { Key: "Environment", Value: "staging" },
        { Key: "Owner", Value: "Finance Platform" },
      ]);

      const greenfield = run(
        [{ Key: "ArchonGreenfieldOwner", Value: "wrong" }],
        "production",
        GREENFIELD_OWNER
      );
      assert.equal(greenfield.status, 0, greenfield.stderr);
      assert.deepEqual(JSON.parse(greenfield.stdout), [
        { Key: "Application", Value: "archon-memory" },
        { Key: "ArchonGreenfieldOwner", Value: GREENFIELD_OWNER },
        { Key: "Environment", Value: "production" },
      ]);

      for (const rejected of [
        [
          { Key: "Owner", Value: "one" },
          { Key: "Owner", Value: "two" },
        ],
        [{ Key: "aws:reserved", Value: "value" }],
      ]) {
        const result = run(rejected);
        assert.notEqual(result.status, 0, JSON.stringify(rejected));
      }
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }
);

test(
  "SAM tag serializer preserves legal parser-sensitive values and rejects ambiguity",
  { skip: process.platform === "win32" },
  () => {
    const fixture = mkdtempSync(join(tmpdir(), "archon-sam-tags-"));
    const tagsFile = join(fixture, "tags.json");
    const tags = [
      { Key: "Owner=Team", Value: 'alpha beta=a"b' },
      { Key: "-leading", Value: "O'Reilly" },
    ];
    try {
      writeFileSync(tagsFile, JSON.stringify(tags), "utf8");
      const serialized = spawnSync(
        "bash",
        [TAG_SERIALIZER_SCRIPT, tagsFile],
        { encoding: "utf8" }
      );
      assert.equal(serialized.status, 0, serialized.stderr);
      assert.equal(
        serialized.stdout,
        `${tags
          .map(
            ({ Key, Value }) =>
              `${JSON.stringify(Key)}=${JSON.stringify(Value)}`
          )
          .join("\n")}\n`
      );

      for (const rejected of [
        [{ Key: "Owner", Value: "a\\b" }],
        [{ Key: "Owner", Value: "line\nbreak" }],
        [
          { Key: "Owner", Value: "one" },
          { Key: "Owner", Value: "two" },
        ],
      ]) {
        writeFileSync(tagsFile, JSON.stringify(rejected), "utf8");
        const result = spawnSync(
          "bash",
          [TAG_SERIALIZER_SCRIPT, tagsFile],
          { encoding: "utf8" }
        );
        assert.notEqual(result.status, 0, JSON.stringify(rejected));
      }
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }
);

test(
  "recovery snapshot binds the candidate and exact existing release files",
  { skip: process.platform === "win32" },
  () => {
    const first = runSnapshot("existing");
    const second = runSnapshot("existing", {
      candidateSha: "d".repeat(40),
    });
    try {
      assert.equal(first.result.status, 0, first.result.stderr);
      assert.equal(second.result.status, 0, second.result.stderr);
      const firstProof = JSON.parse(first.result.stdout);
      const secondProof = JSON.parse(second.result.stdout);
      assert.match(firstProof.manifestSha256, /^[0-9a-f]{64}$/u);
      assert.match(firstProof.templateSha256, /^[0-9a-f]{64}$/u);
      assert.match(firstProof.parametersSha256, /^[0-9a-f]{64}$/u);
      assert.match(firstProof.tagsSha256, /^[0-9a-f]{64}$/u);
      assert.equal(firstProof.greenfieldOwner, null);
      assert.notEqual(
        firstProof.manifestSha256,
        secondProof.manifestSha256,
        "candidate SHA must be part of the canonical recovery manifest"
      );
    } finally {
      rmSync(first.fixture, { recursive: true, force: true });
      rmSync(second.fixture, { recursive: true, force: true });
    }
  }
);

test(
  "greenfield owner is rerun-stable while the manifest binds the attempt",
  { skip: process.platform === "win32" },
  () => {
    const first = runSnapshot("greenfield");
    const retry = runSnapshot("greenfield", { runAttempt: "2" });
    const differentCandidate = runSnapshot("greenfield", {
      candidateSha: "d".repeat(40),
    });
    const differentRun = runSnapshot("greenfield", { runId: "124" });
    const differentEnvironment = runSnapshot("greenfield", {
      environment: "production",
    });
    const differentRepository = runSnapshot("greenfield", {
      repository: "upgradedev/archon-cockroach-memory-fork",
    });
    const differentApp = runSnapshot("greenfield", {
      appName: "archon-memory-next",
    });
    try {
      assert.equal(first.result.status, 0, first.result.stderr);
      assert.equal(retry.result.status, 0, retry.result.stderr);
      assert.equal(
        differentCandidate.result.status,
        0,
        differentCandidate.result.stderr
      );
      assert.equal(
        differentRun.result.status,
        0,
        differentRun.result.stderr
      );
      assert.equal(
        differentEnvironment.result.status,
        0,
        differentEnvironment.result.stderr
      );
      assert.equal(
        differentRepository.result.status,
        0,
        differentRepository.result.stderr
      );
      assert.equal(
        differentApp.result.status,
        0,
        differentApp.result.stderr
      );
      const firstProof = JSON.parse(first.result.stdout);
      const retryProof = JSON.parse(retry.result.stdout);
      assert.match(firstProof.greenfieldOwner, /^[0-9a-f]{64}$/u);
      assert.equal(firstProof.tagsSha256, null);
      assert.equal(retryProof.tagsSha256, null);
      assert.equal(firstProof.greenfieldOwner, retryProof.greenfieldOwner);
      assert.notEqual(
        firstProof.manifestSha256,
        retryProof.manifestSha256
      );
      for (const changed of [
        differentCandidate,
        differentRun,
        differentEnvironment,
        differentRepository,
        differentApp,
      ]) {
        assert.notEqual(
          firstProof.greenfieldOwner,
          JSON.parse(changed.result.stdout).greenfieldOwner
        );
      }
    } finally {
      for (const run of [
        first,
        retry,
        differentCandidate,
        differentRun,
        differentEnvironment,
        differentRepository,
        differentApp,
      ]) {
        rmSync(run.fixture, { recursive: true, force: true });
      }
    }
  }
);

interface CleanupOptions {
  actualOwner?: string | null;
  actualRoleArn?: string;
  actualStackId?: string;
  actualResourceOwner?: string | null;
  apiLogAbsent?: boolean;
  apiLogLogicalId?: string;
  bucketAbsent?: boolean;
  bucketError?: string;
  bucketLogicalId?: string;
  deletePollMode?: "success" | "timeout" | "wrong-stack-id" | "json-stream";
  lambdaLogAbsent?: boolean;
  lambdaLogLogicalId?: string;
  vendedApiLogAbsent?: boolean;
  vendedApiLogLogicalId?: string;
  resourceApplication?: string;
  resourceEnvironment?: string;
  resourceStackId?: string;
  resourceStackName?: string;
  recoveryCancelled?: boolean;
  stackAbsent?: boolean;
  stackStatus?:
    | "REVIEW_IN_PROGRESS"
    | "CREATE_IN_PROGRESS"
    | "CREATE_COMPLETE"
    | "CREATE_FAILED"
    | "ROLLBACK_IN_PROGRESS"
    | "ROLLBACK_COMPLETE"
    | "ROLLBACK_FAILED"
    | "UPDATE_IN_PROGRESS"
    | "UPDATE_COMPLETE_CLEANUP_IN_PROGRESS"
    | "UPDATE_COMPLETE"
    | "UPDATE_FAILED"
    | "UPDATE_ROLLBACK_IN_PROGRESS"
    | "UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS"
    | "UPDATE_ROLLBACK_COMPLETE"
    | "UPDATE_ROLLBACK_FAILED"
    | "DELETE_IN_PROGRESS"
    | "DELETE_FAILED";
  stabilizationPollMode?: "success" | "timeout";
  terminationProtection?: boolean;
  expectedOwner?: string;
  terminationProtectionUpdate?:
    | "success"
    | "error"
    | "wrong-stack-id"
    | "remains-enabled";
}

function runCleanup(options: CleanupOptions = {}) {
  const expectedOwner = options.expectedOwner ?? GREENFIELD_OWNER;
  const {
    actualOwner = expectedOwner,
    actualRoleArn = EXECUTION_ROLE_ARN,
    actualStackId = STACK_ID,
    actualResourceOwner = expectedOwner,
    apiLogAbsent = false,
    apiLogLogicalId = "ApiAccessLogGroup",
    bucketAbsent = false,
    bucketError = "",
    bucketLogicalId = "SpaBucket",
    deletePollMode = "success",
    lambdaLogAbsent = false,
    lambdaLogLogicalId = "ArchonFunctionLogGroup",
    vendedApiLogAbsent = false,
    vendedApiLogLogicalId = "ApiVendedAccessLogGroup",
    resourceApplication = "archon-memory",
    resourceEnvironment = "staging",
    resourceStackId = STACK_ID,
    resourceStackName = "archon-memory-staging",
    recoveryCancelled = false,
    stackAbsent = false,
    stackStatus = "CREATE_COMPLETE",
    stabilizationPollMode = "success",
    terminationProtection = false,
    terminationProtectionUpdate = "success",
  } = options;
  const fixture = mkdtempSync(join(tmpdir(), "archon-greenfield-cleanup-"));
  const fakeBin = join(fixture, "bin");
  mkdirSync(fakeBin);
  const callLog = join(fixture, "aws-calls.log");
  const listCount = join(fixture, "list-count");
  const pollPhaseFile = join(fixture, "poll-phase");
  const stackStatusFile = join(fixture, "stack-status");
  const terminationProtectionFile = join(
    fixture,
    "termination-protection"
  );
  writeFileSync(callLog, "", "utf8");
  writeFileSync(listCount, "0", "utf8");
  writeFileSync(pollPhaseFile, "initial", "utf8");
  writeFileSync(stackStatusFile, stackStatus, "utf8");
  writeFileSync(
    terminationProtectionFile,
    String(terminationProtection),
    "utf8"
  );
  const deleteToken =
    stackStatus === "DELETE_FAILED"
      ? `archon-retry-${RECOVERY_INTENT_ID.slice(0, 32)}-test-123-2-0`
      : `archon-delete-${RECOVERY_INTENT_ID.slice(0, 48)}`;
  executable(
    join(fakeBin, "aws"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >>"$FAKE_AWS_CALL_LOG"
arg_value() {
  local target="$1"
  shift
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "$target" ]; then
      printf '%s\\n' "$2"
      return
    fi
    shift
  done
  return 1
}
has_arg() {
  local target="$1"
  shift
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "$target" ]; then
      return 0
    fi
    shift
  done
  return 1
}
case "$*" in
  *"cloudformation describe-stacks"*)
    if [ "$FAKE_STACK_ABSENT" = "true" ]; then
      echo "ValidationError: Stack does not exist" >&2
      exit 255
    fi
    stack_target="$(arg_value --stack-name "$@")"
    if [ "$stack_target" != "$STACK_NAME" ] &&
       [ "$stack_target" != "$FAKE_STACK_ID" ]; then
      exit 92
    fi
    poll_phase="$(cat "$FAKE_POLL_PHASE_FILE")"
    stack_status="$(cat "$FAKE_STACK_STATUS_FILE")"
    reported_stack_id="$FAKE_STACK_ID"
    if [ "$poll_phase" = "delete" ]; then
      case "$FAKE_DELETE_POLL_MODE" in
        success)
          echo "ValidationError: Stack with id $FAKE_STACK_ID does not exist" >&2
          exit 255
          ;;
        timeout)
          stack_status="DELETE_IN_PROGRESS"
          ;;
        wrong-stack-id)
          stack_status="DELETE_IN_PROGRESS"
          reported_stack_id="${STACK_ID.replace("stack-uuid", "wrong-stack")}"
          ;;
        json-stream)
          stack_status="DELETE_IN_PROGRESS"
          ;;
        *) exit 90 ;;
      esac
    elif [ "$poll_phase" = "stabilize" ] &&
         [ "$FAKE_STABILIZATION_POLL_MODE" = "success" ]; then
      case "$stack_status" in
        ROLLBACK_IN_PROGRESS)
          stack_status="ROLLBACK_COMPLETE"
          ;;
        UPDATE_COMPLETE_CLEANUP_IN_PROGRESS)
          stack_status="UPDATE_COMPLETE"
          ;;
        UPDATE_ROLLBACK_IN_PROGRESS|UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS)
          stack_status="UPDATE_ROLLBACK_COMPLETE"
          ;;
      esac
      printf '%s' "$stack_status" >"$FAKE_STACK_STATUS_FILE"
    fi
    emit_stack_response() {
    jq -n \
      --arg stack "$STACK_NAME" \
      --arg stackId "$reported_stack_id" \
      --arg owner "$FAKE_ACTUAL_OWNER" \
      --arg role "$FAKE_ACTUAL_ROLE_ARN" \
      --arg status "$stack_status" \
      --argjson protected "$(cat "$FAKE_TERMINATION_PROTECTION_FILE")" \
      '{
        Stacks: [{
          StackName: $stack,
          StackId: $stackId,
          StackStatus: $status,
          RoleARN: $role,
          EnableTerminationProtection: $protected,
          Tags: (
            if $owner == ""
            then []
            else [
              {Key:"ArchonGreenfieldOwner",Value:$owner},
              {Key:"Application",Value:"archon-memory"},
              {Key:"Environment",Value:"staging"}
            ]
            end
          )
        }]
      }'
    }
    emit_stack_response
    if [ "$poll_phase" = "delete" ] &&
       [ "$FAKE_DELETE_POLL_MODE" = "json-stream" ]; then
      emit_stack_response
    fi
    if [ "$poll_phase" = "initial" ]; then
      case "$stack_status" in
        DELETE_IN_PROGRESS)
          printf '%s' "delete" >"$FAKE_POLL_PHASE_FILE"
          ;;
        ROLLBACK_IN_PROGRESS|\
        UPDATE_IN_PROGRESS|\
        UPDATE_COMPLETE_CLEANUP_IN_PROGRESS|\
        UPDATE_FAILED|\
        UPDATE_ROLLBACK_IN_PROGRESS|\
        UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS|\
        UPDATE_ROLLBACK_FAILED)
          printf '%s' "stabilize" >"$FAKE_POLL_PHASE_FILE"
          ;;
      esac
    fi ;;
  *"cloudformation update-termination-protection"*)
    test "$(arg_value --stack-name "$@")" = "$FAKE_STACK_ID"
    has_arg --no-enable-termination-protection "$@"
    ! has_arg --enable-termination-protection "$@"
    case "$FAKE_TERMINATION_PROTECTION_UPDATE" in
      success)
        printf '%s' "false" >"$FAKE_TERMINATION_PROTECTION_FILE"
        update_stack_id="$FAKE_STACK_ID"
        ;;
      error)
        echo "AccessDenied: unable to update termination protection" >&2
        exit 254
        ;;
      wrong-stack-id)
        update_stack_id="${STACK_ID.replace("stack-uuid", "wrong-stack")}"
        ;;
      remains-enabled)
        update_stack_id="$FAKE_STACK_ID"
        ;;
      *)
        exit 91
        ;;
    esac
    jq -n --arg stackId "$update_stack_id" '{StackId: $stackId}' ;;
  *"cloudformation describe-stack-resources"*)
    test "$(arg_value --stack-name "$@")" = "$FAKE_STACK_ID"
    jq -n \
      --arg bucket "$FAKE_BUCKET" \
      --arg apiLog "$FAKE_API_LOG_GROUP" \
      --arg vendedApiLog "$FAKE_VENDED_API_LOG_GROUP" \
      --arg lambdaLog "$FAKE_LAMBDA_LOG_GROUP" \
      '{
        StackResources: [
          {
            LogicalResourceId: "SpaBucket",
            ResourceType: "AWS::S3::Bucket",
            PhysicalResourceId: $bucket
          },
          {
            LogicalResourceId: "ApiAccessLogGroup",
            ResourceType: "AWS::Logs::LogGroup",
            PhysicalResourceId: $apiLog
          },
          {
            LogicalResourceId: "ApiVendedAccessLogGroup",
            ResourceType: "AWS::Logs::LogGroup",
            PhysicalResourceId: $vendedApiLog
          },
          {
            LogicalResourceId: "ArchonFunctionLogGroup",
            ResourceType: "AWS::Logs::LogGroup",
            PhysicalResourceId: $lambdaLog
          }
        ]
      }' ;;
  *"cloudformation delete-stack"*)
    test "$(arg_value --stack-name "$@")" = "$FAKE_STACK_ID"
    test "$(cat "$FAKE_TERMINATION_PROTECTION_FILE")" = "false"
    test "$(arg_value --role-arn "$@")" = \
      "$AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN"
    test "$(arg_value --client-request-token "$@")" = "$FAKE_DELETE_TOKEN"
    ! has_arg --retain-except-on-create "$@"
    printf '%s' "DELETE_IN_PROGRESS" >"$FAKE_STACK_STATUS_FILE"
    printf '%s' "delete" >"$FAKE_POLL_PHASE_FILE" ;;
  *"cloudformation cancel-update-stack"*)
    test "$(arg_value --stack-name "$@")" = "$FAKE_STACK_ID"
    test "$(cat "$FAKE_STACK_STATUS_FILE")" = "UPDATE_IN_PROGRESS"
    test "$(arg_value --client-request-token "$@")" = \
      "archon-cancel-${RECOVERY_INTENT_ID.slice(0, 48)}"
    printf '%s' "UPDATE_ROLLBACK_IN_PROGRESS" >"$FAKE_STACK_STATUS_FILE"
    printf '%s' "stabilize" >"$FAKE_POLL_PHASE_FILE" ;;
  *"cloudformation rollback-stack"*)
    test "$(arg_value --stack-name "$@")" = "$FAKE_STACK_ID"
    test "$(cat "$FAKE_STACK_STATUS_FILE")" = "UPDATE_FAILED"
    test "$(arg_value --role-arn "$@")" = \
      "$AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN"
    test "$(arg_value --client-request-token "$@")" = \
      "archon-rollback-${RECOVERY_INTENT_ID.slice(0, 48)}"
    has_arg --retain-except-on-create "$@"
    printf '%s' "UPDATE_ROLLBACK_IN_PROGRESS" >"$FAKE_STACK_STATUS_FILE"
    printf '%s' "stabilize" >"$FAKE_POLL_PHASE_FILE" ;;
  *"cloudformation continue-update-rollback"*)
    test "$(arg_value --stack-name "$@")" = "$FAKE_STACK_ID"
    test "$(arg_value --role-arn "$@")" = \
      "$AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN"
    test "$(arg_value --client-request-token "$@")" = \
      "archon-continue-${RECOVERY_INTENT_ID.slice(0, 48)}"
    printf '%s' "UPDATE_ROLLBACK_IN_PROGRESS" >"$FAKE_STACK_STATUS_FILE"
    printf '%s' "stabilize" >"$FAKE_POLL_PHASE_FILE" ;;
  *"s3api get-bucket-tagging"*)
    test "$(arg_value --bucket "$@")" = "$FAKE_BUCKET"
    test "$(arg_value --expected-bucket-owner "$@")" = "$AWS_ACCOUNT_ID"
    if [ -n "$FAKE_BUCKET_ERROR" ]; then
      echo "$FAKE_BUCKET_ERROR" >&2
      exit 254
    elif [ "$FAKE_BUCKET_ABSENT" = "true" ]; then
      echo "NoSuchBucket: The specified bucket does not exist (404)" >&2
      exit 254
    fi
    jq -n \
      --arg owner "$FAKE_RESOURCE_OWNER" \
      --arg app "$FAKE_RESOURCE_APPLICATION" \
      --arg environment "$FAKE_RESOURCE_ENVIRONMENT" \
      --arg stackId "$FAKE_RESOURCE_STACK_ID" \
      --arg stackName "$FAKE_RESOURCE_STACK_NAME" \
      --arg logicalId "$FAKE_BUCKET_LOGICAL_ID" \
      '{
        TagSet: [
          {Key:"ArchonGreenfieldOwner",Value:$owner},
          {Key:"Application",Value:$app},
          {Key:"Environment",Value:$environment},
          {Key:"aws:cloudformation:stack-id",Value:$stackId},
          {Key:"aws:cloudformation:stack-name",Value:$stackName},
          {Key:"aws:cloudformation:logical-id",Value:$logicalId}
        ]
      }' ;;
  *"s3api get-bucket-location"*)
    test "$(arg_value --bucket "$@")" = "$FAKE_BUCKET"
    test "$(arg_value --expected-bucket-owner "$@")" = "$AWS_ACCOUNT_ID"
    if [ -n "$FAKE_BUCKET_ERROR" ]; then
      echo "$FAKE_BUCKET_ERROR" >&2
      exit 254
    elif [ "$FAKE_BUCKET_ABSENT" = "true" ]; then
      echo "NoSuchBucket: The specified bucket does not exist (404)" >&2
      exit 254
    fi
    printf '%s\\n' '{"LocationConstraint":"eu-west-1"}' ;;
  *"s3api list-object-versions"*)
    test "$FAKE_BUCKET_ABSENT" = "false"
    test "$(arg_value --bucket "$@")" = "$FAKE_BUCKET"
    test "$(arg_value --expected-bucket-owner "$@")" = "$AWS_ACCOUNT_ID"
    count="$(cat "$FAKE_LIST_COUNT")"
    if [ "$count" = "0" ]; then
      printf '1' >"$FAKE_LIST_COUNT"
      printf '%s\\n' '{"Versions":[{"Key":"index.html","VersionId":"v1"}],"DeleteMarkers":[{"Key":"old.js","VersionId":"d1"}]}'
    else
      printf '%s\\n' '{"Versions":[],"DeleteMarkers":[]}'
    fi ;;
  *"s3api delete-objects"*)
    test "$FAKE_BUCKET_ABSENT" = "false"
    test "$(arg_value --bucket "$@")" = "$FAKE_BUCKET"
    test "$(arg_value --expected-bucket-owner "$@")" = "$AWS_ACCOUNT_ID"
    printf '%s\\n' '{}' ;;
  *"s3api delete-bucket"*)
    test "$FAKE_BUCKET_ABSENT" = "false"
    test "$(arg_value --bucket "$@")" = "$FAKE_BUCKET"
    test "$(arg_value --expected-bucket-owner "$@")" = "$AWS_ACCOUNT_ID" ;;
  *"logs list-tags-for-resource"*)
    resource_arn="$(arg_value --resource-arn "$@")"
    case "$resource_arn" in
      "$FAKE_API_LOG_ARN")
        resource_absent="$FAKE_API_LOG_ABSENT"
        logical_id="$FAKE_API_LOG_LOGICAL_ID"
        ;;
      "$FAKE_VENDED_API_LOG_ARN")
        resource_absent="$FAKE_VENDED_API_LOG_ABSENT"
        logical_id="$FAKE_VENDED_API_LOG_LOGICAL_ID"
        ;;
      "$FAKE_LAMBDA_LOG_ARN")
        resource_absent="$FAKE_LAMBDA_LOG_ABSENT"
        logical_id="$FAKE_LAMBDA_LOG_LOGICAL_ID"
        ;;
      *) exit 95 ;;
    esac
    if [ "$resource_absent" = "true" ]; then
      echo "ResourceNotFoundException: The specified log group does not exist" >&2
      exit 254
    fi
    jq -n \
      --arg owner "$FAKE_RESOURCE_OWNER" \
      --arg app "$FAKE_RESOURCE_APPLICATION" \
      --arg environment "$FAKE_RESOURCE_ENVIRONMENT" \
      --arg stackId "$FAKE_RESOURCE_STACK_ID" \
      --arg stackName "$FAKE_RESOURCE_STACK_NAME" \
      --arg logicalId "$logical_id" \
      '{
        tags: {
          ArchonGreenfieldOwner: $owner,
          Application: $app,
          Environment: $environment,
          "aws:cloudformation:stack-id": $stackId,
          "aws:cloudformation:stack-name": $stackName,
          "aws:cloudformation:logical-id": $logicalId
        }
      }' ;;
  *"logs delete-log-group"*)
    log_group="$(arg_value --log-group-name "$@")"
    case "$log_group" in
      "$FAKE_API_LOG_GROUP") resource_absent="$FAKE_API_LOG_ABSENT" ;;
      "$FAKE_VENDED_API_LOG_GROUP")
        resource_absent="$FAKE_VENDED_API_LOG_ABSENT"
        ;;
      "$FAKE_LAMBDA_LOG_GROUP")
        resource_absent="$FAKE_LAMBDA_LOG_ABSENT"
        ;;
      *) exit 94 ;;
    esac
    if [ "$resource_absent" = "true" ]; then
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
      AWS_ACCOUNT_ID: ACCOUNT_ID,
      AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN: EXECUTION_ROLE_ARN,
      AWS_REGION: "eu-west-1",
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "2",
      STACK_NAME: "archon-memory-staging",
      GREENFIELD_OWNER: expectedOwner,
      RECOVERY_EXECUTION_ID: "test-123-2",
      RECOVERY_INTENT_ID,
      FAKE_AWS_CALL_LOG: callLog,
      FAKE_ACTUAL_ROLE_ARN: actualRoleArn,
      FAKE_API_LOG_ABSENT: String(apiLogAbsent),
      FAKE_API_LOG_ARN: API_LOG_ARN,
      FAKE_API_LOG_GROUP: API_LOG_GROUP,
      FAKE_API_LOG_LOGICAL_ID: apiLogLogicalId,
      FAKE_VENDED_API_LOG_ABSENT: String(vendedApiLogAbsent),
      FAKE_VENDED_API_LOG_ARN: VENDED_API_LOG_ARN,
      FAKE_VENDED_API_LOG_GROUP: VENDED_API_LOG_GROUP,
      FAKE_VENDED_API_LOG_LOGICAL_ID: vendedApiLogLogicalId,
      FAKE_BUCKET: RETAINED_BUCKET,
      FAKE_BUCKET_ABSENT: String(bucketAbsent),
      FAKE_BUCKET_ERROR: bucketError,
      FAKE_BUCKET_LOGICAL_ID: bucketLogicalId,
      FAKE_DELETE_POLL_MODE: deletePollMode,
      FAKE_DELETE_TOKEN: deleteToken,
      FAKE_LAMBDA_LOG_ABSENT: String(lambdaLogAbsent),
      FAKE_LAMBDA_LOG_ARN: LAMBDA_LOG_ARN,
      FAKE_LAMBDA_LOG_GROUP: LAMBDA_LOG_GROUP,
      FAKE_LAMBDA_LOG_LOGICAL_ID: lambdaLogLogicalId,
      FAKE_LIST_COUNT: listCount,
      FAKE_POLL_PHASE_FILE: pollPhaseFile,
      FAKE_STACK_ABSENT: String(stackAbsent),
      FAKE_STACK_ID: actualStackId,
      FAKE_STACK_STATUS_FILE: stackStatusFile,
      FAKE_ACTUAL_OWNER: actualOwner ?? "",
      FAKE_RESOURCE_OWNER: actualResourceOwner ?? "",
      FAKE_RESOURCE_APPLICATION: resourceApplication,
      FAKE_RESOURCE_ENVIRONMENT: resourceEnvironment,
      FAKE_RESOURCE_STACK_ID: resourceStackId,
      FAKE_RESOURCE_STACK_NAME: resourceStackName,
      FAKE_TERMINATION_PROTECTION_FILE: terminationProtectionFile,
      FAKE_TERMINATION_PROTECTION_UPDATE:
        terminationProtectionUpdate,
      FAKE_STABILIZATION_POLL_MODE: stabilizationPollMode,
      RECOVERY_CANCELLED: String(recoveryCancelled),
      ARCHON_GREENFIELD_STABILIZE_POLL_ATTEMPTS: "2",
      ARCHON_GREENFIELD_STABILIZE_POLL_INTERVAL_SECONDS: "0",
      ARCHON_GREENFIELD_DELETE_POLL_ATTEMPTS: "2",
      ARCHON_GREENFIELD_DELETE_POLL_INTERVAL_SECONDS: "0",
    },
  });
  return {
    fixture,
    result,
    calls: readFileSync(callLog, "utf8"),
    terminationProtectionFile,
  };
}

test(
  "attempt 2 can clean an attempt-1 failed greenfield stack",
  { skip: process.platform === "win32" },
  () => {
    const attemptOne = runSnapshot("greenfield", { runAttempt: "1" });
    const attemptTwo = runSnapshot("greenfield", { runAttempt: "2" });
    let cleanup: ReturnType<typeof runCleanup> | undefined;
    try {
      assert.equal(attemptOne.result.status, 0, attemptOne.result.stderr);
      assert.equal(attemptTwo.result.status, 0, attemptTwo.result.stderr);
      const attemptOneProof = JSON.parse(attemptOne.result.stdout);
      const attemptTwoProof = JSON.parse(attemptTwo.result.stdout);
      assert.equal(
        attemptOneProof.greenfieldOwner,
        attemptTwoProof.greenfieldOwner
      );

      cleanup = runCleanup({
        actualOwner: attemptOneProof.greenfieldOwner,
        actualResourceOwner: attemptOneProof.greenfieldOwner,
        apiLogAbsent: true,
        bucketAbsent: true,
        expectedOwner: attemptTwoProof.greenfieldOwner,
        lambdaLogAbsent: true,
        stackStatus: "CREATE_FAILED",
        vendedApiLogAbsent: true,
      });
      assert.equal(cleanup.result.status, 0, cleanup.result.stderr);
      const deleteStackCall = findAwsCall(
        cleanup.calls,
        "cloudformation delete-stack"
      );
      assert.ok(
        deleteStackCall.includes(`--stack-name ${STACK_ID}`),
        deleteStackCall
      );
      assert.doesNotMatch(cleanup.calls, /cloudformation wait/u);
    } finally {
      rmSync(attemptOne.fixture, { recursive: true, force: true });
      rmSync(attemptTwo.fixture, { recursive: true, force: true });
      if (cleanup) {
        rmSync(cleanup.fixture, { recursive: true, force: true });
      }
    }
  }
);

test(
  "greenfield cleanup deletes the exact stack and retained resources idempotently",
  { skip: process.platform === "win32" },
  () => {
    const run = runCleanup();
    try {
      assert.equal(run.result.status, 0, run.result.stderr);
      assert.deepEqual(JSON.parse(run.result.stdout), {
        ok: true,
        schema: "archon.greenfield-cleanup.proof",
        version: 1,
        state: "greenfield-cleaned",
        stack: "archon-memory-staging",
        stackId: STACK_ID,
        stackDeleted: true,
        retainedBucketDeleted: true,
        retainedLogGroupsDeleted: 3,
      });
      const deleteStackCall = findAwsCall(
        run.calls,
        "cloudformation delete-stack"
      );
      assert.ok(
        deleteStackCall.includes(`--stack-name ${STACK_ID}`),
        deleteStackCall
      );
      assert.ok(
        deleteStackCall.includes(`--role-arn ${EXECUTION_ROLE_ARN}`),
        deleteStackCall
      );
      assert.ok(
        deleteStackCall.includes(
          `--client-request-token archon-delete-${RECOVERY_INTENT_ID.slice(0, 48)}`
        ),
        deleteStackCall
      );
      const calls = run.calls.trim().split(/\r?\n/u);
      const deleteIndex = calls.findIndex((call) =>
        call.includes("cloudformation delete-stack")
      );
      const finalPollIndex = calls.findIndex(
        (call, index) =>
          index > deleteIndex &&
          call.includes("cloudformation describe-stacks") &&
          call.includes(`--stack-name ${STACK_ID}`)
      );
      assert.ok(deleteIndex >= 0, run.calls);
      assert.ok(finalPollIndex > deleteIndex, run.calls);
      assert.doesNotMatch(run.calls, /cloudformation wait/u);
      assert.match(run.calls, /s3api delete-objects/u);
      assert.match(
        run.calls,
        /s3api delete-objects[\s\S]*--expected-bucket-owner 123456789012/u
      );
      assert.match(
        run.calls,
        new RegExp(`s3api delete-bucket --bucket ${RETAINED_BUCKET}`, "u")
      );
      assert.match(
        run.calls,
        /logs delete-log-group --log-group-name \/aws\/apigateway\/archon-memory-staging/u
      );
      assert.match(
        run.calls,
        /logs delete-log-group --log-group-name \/aws\/vendedlogs\/apigateway\/archon-memory-staging/u
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
    const run = runCleanup({
      apiLogAbsent: true,
      bucketAbsent: true,
      lambdaLogAbsent: true,
      stackAbsent: true,
      vendedApiLogAbsent: true,
    });
    try {
      assert.equal(run.result.status, 0, run.result.stderr);
      assert.deepEqual(JSON.parse(run.result.stdout), {
        ok: true,
        schema: "archon.greenfield-cleanup.proof",
        version: 1,
        state: "greenfield-stack-absent",
        stack: "archon-memory-staging",
        stackId: null,
        stackDeleted: false,
        retainedBucketDeleted: false,
        retainedLogGroupsDeleted: 0,
      });
      assert.doesNotMatch(run.calls, /cloudformation delete-stack/u);
      assert.doesNotMatch(run.calls, /s3api list-object-versions/u);
      assert.doesNotMatch(run.calls, /s3api delete-bucket/u);
      assert.doesNotMatch(run.calls, /logs delete-log-group/u);
    } finally {
      rmSync(run.fixture, { recursive: true, force: true });
    }
  }
);

test(
  "stack-absent cleanup completes an exact-owner mixed partial retry",
  { skip: process.platform === "win32" },
  () => {
    const run = runCleanup({
      apiLogAbsent: true,
      bucketAbsent: false,
      lambdaLogAbsent: false,
      stackAbsent: true,
      vendedApiLogAbsent: true,
    });
    try {
      assert.equal(run.result.status, 0, run.result.stderr);
      assert.deepEqual(JSON.parse(run.result.stdout), {
        ok: true,
        schema: "archon.greenfield-cleanup.proof",
        version: 1,
        state: "greenfield-cleaned",
        stack: "archon-memory-staging",
        stackId: STACK_ID,
        stackDeleted: false,
        retainedBucketDeleted: true,
        retainedLogGroupsDeleted: 1,
      });
      assert.doesNotMatch(
        run.calls,
        /cloudformation describe-stack-resources/u
      );
      assert.doesNotMatch(run.calls, /cloudformation delete-stack/u);
      assert.match(run.calls, /s3api get-bucket-tagging/u);
      assert.match(run.calls, /s3api delete-bucket/u);
      assert.doesNotMatch(
        run.calls,
        /logs delete-log-group --log-group-name \/aws\/apigateway\//u
      );
      assert.doesNotMatch(
        run.calls,
        /logs delete-log-group --log-group-name \/aws\/vendedlogs\/apigateway\//u
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
  "greenfield cleanup rejects retained resources without the run owner",
  { skip: process.platform === "win32" },
  () => {
    const run = runCleanup({ actualResourceOwner: "b".repeat(64) });
    try {
      assert.notEqual(run.result.status, 0);
      assert.match(run.calls, /cloudformation describe-stack-resources/u);
      assert.match(run.calls, /s3api get-bucket-tagging/u);
      assert.doesNotMatch(run.calls, /cloudformation delete-stack/u);
      assert.doesNotMatch(run.calls, /s3api delete-/u);
      assert.doesNotMatch(run.calls, /logs delete-log-group/u);
    } finally {
      rmSync(run.fixture, { recursive: true, force: true });
    }
  }
);

for (const systemIdentityFailure of [
  {
    name: "Application",
    resourceApplication: "another-application",
  },
  {
    name: "Environment",
    resourceEnvironment: "production",
  },
  {
    name: "aws:cloudformation:stack-id",
    resourceStackId: STACK_ID.replace("stack-uuid", "replacement"),
  },
  {
    name: "aws:cloudformation:stack-name",
    resourceStackName: "archon-memory-production",
  },
  {
    name: "aws:cloudformation:logical-id",
    bucketLogicalId: "AnotherBucket",
  },
  {
    name: "API log logical-id",
    apiLogLogicalId: "AnotherApiLog",
  },
  {
    name: "vended API log logical-id",
    vendedApiLogLogicalId: "AnotherVendedApiLog",
  },
  {
    name: "Lambda log logical-id",
    lambdaLogLogicalId: "AnotherLambdaLog",
  },
] as const) {
  test(
    `greenfield cleanup rejects mismatched ${systemIdentityFailure.name} identity`,
    { skip: process.platform === "win32" },
    () => {
      const run = runCleanup(systemIdentityFailure);
      try {
        assert.notEqual(run.result.status, 0);
        assert.match(run.calls, /s3api get-bucket-tagging/u);
        assert.doesNotMatch(run.calls, /cloudformation delete-stack/u);
        assert.doesNotMatch(run.calls, /s3api delete-/u);
        assert.doesNotMatch(run.calls, /logs delete-log-group/u);
      } finally {
        rmSync(run.fixture, { recursive: true, force: true });
      }
    }
  );
}

test(
  "DELETE_IN_PROGRESS cleanup polls only the exact StackId",
  { skip: process.platform === "win32" },
  () => {
    const run = runCleanup({
      apiLogAbsent: true,
      bucketAbsent: true,
      lambdaLogAbsent: true,
      stackStatus: "DELETE_IN_PROGRESS",
      vendedApiLogAbsent: true,
    });
    try {
      assert.equal(run.result.status, 0, run.result.stderr);
      assert.doesNotMatch(run.calls, /cloudformation delete-stack/u);
      const exactPoll = run.calls
        .split(/\r?\n/u)
        .find(
          (call) =>
            call.includes("cloudformation describe-stacks") &&
            call.includes(`--stack-name ${STACK_ID}`)
        );
      assert.ok(exactPoll, run.calls);
      assert.doesNotMatch(run.calls, /cloudformation wait/u);
      assert.deepEqual(JSON.parse(run.result.stdout), {
        ok: true,
        schema: "archon.greenfield-cleanup.proof",
        version: 1,
        state: "greenfield-cleaned",
        stack: "archon-memory-staging",
        stackId: STACK_ID,
        stackDeleted: true,
        retainedBucketDeleted: false,
        retainedLogGroupsDeleted: 0,
      });
    } finally {
      rmSync(run.fixture, { recursive: true, force: true });
    }
  }
);

test(
  "greenfield cleanup bounds initial stabilization and preserves AWS handoff",
  { skip: process.platform === "win32" },
  () => {
    const run = runCleanup({
      apiLogAbsent: true,
      bucketAbsent: true,
      lambdaLogAbsent: true,
      stabilizationPollMode: "timeout",
      stackStatus: "UPDATE_IN_PROGRESS",
      vendedApiLogAbsent: true,
    });
    try {
      assert.notEqual(run.result.status, 0);
      assert.match(run.calls, /cloudformation cancel-update-stack/u);
      const exactPolls = run.calls
        .split(/\r?\n/u)
        .filter(
          (call) =>
            call.includes("cloudformation describe-stacks") &&
            call.includes(`--stack-name ${STACK_ID}`)
        );
      assert.equal(exactPolls.length, 2, run.calls);
      assert.doesNotMatch(
        run.calls,
        /cloudformation describe-stack-resources/u
      );
      assert.doesNotMatch(run.calls, /cloudformation delete-stack/u);
      assert.doesNotMatch(run.calls, /cloudformation wait/u);
      assert.match(run.result.stderr, /later watchdog retry/u);
    } finally {
      rmSync(run.fixture, { recursive: true, force: true });
    }
  }
);

for (const deletePollFailure of [
  { name: "timeout", mode: "timeout" },
  { name: "wrong StackId", mode: "wrong-stack-id" },
  { name: "multiple-object JSON stream", mode: "json-stream" },
] as const) {
  test(
    `greenfield cleanup fails closed on delete polling ${deletePollFailure.name}`,
    { skip: process.platform === "win32" },
    () => {
      const run = runCleanup({
        apiLogAbsent: true,
        bucketAbsent: true,
        deletePollMode: deletePollFailure.mode,
        lambdaLogAbsent: true,
        stackStatus: "DELETE_IN_PROGRESS",
        vendedApiLogAbsent: true,
      });
      try {
        assert.notEqual(run.result.status, 0);
        assert.doesNotMatch(run.calls, /cloudformation delete-stack/u);
        const exactPolls = run.calls
          .split(/\r?\n/u)
          .filter(
            (call) =>
              call.includes("cloudformation describe-stacks") &&
              call.includes(`--stack-name ${STACK_ID}`)
          );
        assert.ok(exactPolls.length >= 1, run.calls);
        assert.doesNotMatch(run.calls, /s3api delete-/u);
        assert.doesNotMatch(run.calls, /logs delete-log-group/u);
        assert.doesNotMatch(run.calls, /cloudformation wait/u);
        assert.match(run.result.stderr, /later watchdog retry/u);
      } finally {
        rmSync(run.fixture, { recursive: true, force: true });
      }
    }
  );
}

for (const activeCleanup of [
  {
    stackStatus: "CREATE_IN_PROGRESS",
    operation: "cloudformation delete-stack",
  },
  {
    stackStatus: "ROLLBACK_IN_PROGRESS",
    operation: null,
  },
  {
    stackStatus: "UPDATE_IN_PROGRESS",
    operation: "cloudformation cancel-update-stack",
  },
  {
    stackStatus: "UPDATE_COMPLETE_CLEANUP_IN_PROGRESS",
    operation: null,
  },
  {
    stackStatus: "UPDATE_FAILED",
    operation: "cloudformation rollback-stack",
  },
  {
    stackStatus: "UPDATE_ROLLBACK_IN_PROGRESS",
    operation: null,
  },
  {
    stackStatus: "UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS",
    operation: null,
  },
] as const) {
  test(
    `greenfield cleanup converges exact-owner ${activeCleanup.stackStatus}`,
    { skip: process.platform === "win32" },
    () => {
      const run = runCleanup({
        apiLogAbsent: true,
        bucketAbsent: true,
        lambdaLogAbsent: true,
        stackStatus: activeCleanup.stackStatus,
        vendedApiLogAbsent: true,
      });
      try {
        assert.equal(run.result.status, 0, run.result.stderr);
        const deleteCall = findAwsCall(
          run.calls,
          "cloudformation delete-stack"
        );
        assert.ok(
          !deleteCall.includes("--retain-except-on-create"),
          deleteCall
        );
        const exactPolls = run.calls
          .split(/\r?\n/u)
          .filter(
            (call) =>
              call.includes("cloudformation describe-stacks") &&
              call.includes(`--stack-name ${STACK_ID}`)
          );
        assert.ok(exactPolls.length >= 1, run.calls);
        assert.ok(
          run.calls.indexOf(exactPolls[0] ?? "") <=
            run.calls.indexOf(deleteCall)
        );
        if (activeCleanup.operation !== null) {
          const convergenceCall = findAwsCall(
            run.calls,
            activeCleanup.operation
          );
          assert.ok(
            convergenceCall.includes(`--stack-name ${STACK_ID}`),
            convergenceCall
          );
          assert.ok(
            run.calls.indexOf(convergenceCall) <=
              run.calls.indexOf(deleteCall)
          );
        }
        assert.doesNotMatch(run.calls, /cloudformation wait/u);
      } finally {
        rmSync(run.fixture, { recursive: true, force: true });
      }
    }
  );
}

test(
  "cancelled greenfield CREATE_IN_PROGRESS hands deletion to CloudFormation",
  { skip: process.platform === "win32" },
  () => {
    const run = runCleanup({
      recoveryCancelled: true,
      stackStatus: "CREATE_IN_PROGRESS",
    });
    try {
      assert.equal(run.result.status, 0, run.result.stderr);
      const deleteCall = findAwsCall(
        run.calls,
        "cloudformation delete-stack"
      );
      assert.ok(deleteCall.includes(`--stack-name ${STACK_ID}`));
      assert.ok(!deleteCall.includes("--retain-except-on-create"));
      assert.doesNotMatch(
        run.calls,
        /cloudformation wait/u
      );
      assert.doesNotMatch(
        run.calls,
        /cloudformation describe-stack-resources/u
      );
      assert.match(run.result.stdout, /handed off durably/u);
    } finally {
      rmSync(run.fixture, { recursive: true, force: true });
    }
  }
);

test(
  "cancelled greenfield UPDATE_IN_PROGRESS hands rollback to CloudFormation",
  { skip: process.platform === "win32" },
  () => {
    const run = runCleanup({
      recoveryCancelled: true,
      stackStatus: "UPDATE_IN_PROGRESS",
    });
    try {
      assert.equal(run.result.status, 0, run.result.stderr);
      const cancelCall = findAwsCall(
        run.calls,
        "cloudformation cancel-update-stack"
      );
      assert.ok(cancelCall.includes(`--stack-name ${STACK_ID}`));
      assert.ok(
        cancelCall.includes(
          `--client-request-token archon-cancel-${RECOVERY_INTENT_ID.slice(0, 48)}`
        )
      );
      assert.doesNotMatch(run.calls, /cloudformation delete-stack/u);
      assert.doesNotMatch(
        run.calls,
        /cloudformation wait/u
      );
    } finally {
      rmSync(run.fixture, { recursive: true, force: true });
    }
  }
);

for (const retryableStatus of [
  "REVIEW_IN_PROGRESS",
  "CREATE_FAILED",
  "ROLLBACK_FAILED",
  "UPDATE_COMPLETE",
  "UPDATE_ROLLBACK_COMPLETE",
  "UPDATE_ROLLBACK_FAILED",
  "DELETE_FAILED",
] satisfies CleanupOptions["stackStatus"][]) {
  test(
    `greenfield cleanup retries exact-owner ${retryableStatus}`,
    { skip: process.platform === "win32" },
    () => {
      const run = runCleanup({
        apiLogAbsent: true,
        bucketAbsent: true,
        lambdaLogAbsent: true,
        stackStatus: retryableStatus,
        vendedApiLogAbsent: true,
      });
      try {
        assert.equal(run.result.status, 0, run.result.stderr);
        const deleteCall = findAwsCall(
          run.calls,
          "cloudformation delete-stack"
        );
        assert.ok(deleteCall.includes(`--stack-name ${STACK_ID}`));
        assert.doesNotMatch(deleteCall, /FORCE_DELETE_STACK/u);
        if (retryableStatus === "DELETE_FAILED") {
          assert.ok(
            deleteCall.includes(
              `--client-request-token archon-retry-${RECOVERY_INTENT_ID.slice(0, 32)}-test-123-2-0`
            )
          );
          assert.doesNotMatch(
            deleteCall,
            new RegExp(
              `--client-request-token archon-delete-${RECOVERY_INTENT_ID.slice(0, 48)}(?:\\s|$)`,
              "u"
            )
          );
        }
      } finally {
        rmSync(run.fixture, { recursive: true, force: true });
      }
    }
  );
}

test(
  "greenfield cleanup rejects an ambiguous HTTP 404 as bucket absence",
  { skip: process.platform === "win32" },
  () => {
    const run = runCleanup({
      apiLogAbsent: true,
      bucketError: "HTTP 404 Not Found from an untrusted endpoint",
      lambdaLogAbsent: true,
      stackAbsent: true,
      vendedApiLogAbsent: true,
    });
    try {
      assert.notEqual(run.result.status, 0);
      assert.match(run.calls, /s3api get-bucket-tagging/u);
      assert.doesNotMatch(run.calls, /s3api delete-bucket/u);
      assert.doesNotMatch(run.calls, /logs delete-log-group/u);
    } finally {
      rmSync(run.fixture, { recursive: true, force: true });
    }
  }
);

test(
  "protected greenfield cleanup re-proves, disables, re-proves, then deletes the exact stack",
  { skip: process.platform === "win32" },
  () => {
    const run = runCleanup({ terminationProtection: true });
    try {
      assert.equal(run.result.status, 0, run.result.stderr);
      const calls = run.calls
        .trim()
        .split(/\r?\n/u)
        .filter(Boolean);
      const describeIndexes = calls
        .map((call, index) =>
          call.includes("cloudformation describe-stacks")
            ? index
            : -1
        )
        .filter((index) => index >= 0);
      const updateIndex = calls.findIndex((call) =>
        call.includes(
          "cloudformation update-termination-protection"
        )
      );
      const deleteIndex = calls.findIndex((call) =>
        call.includes("cloudformation delete-stack")
      );

      assert.equal(describeIndexes.length, 4, run.calls);
      assert.ok(updateIndex >= 0, run.calls);
      assert.ok(deleteIndex >= 0, run.calls);
      assert.match(
        calls[describeIndexes[0]],
        /--stack-name archon-memory-staging(?:\s|$)/u
      );
      assert.match(
        calls[describeIndexes[1]],
        new RegExp(`--stack-name ${STACK_ID}(?:\\s|$)`, "u")
      );
      assert.match(
        calls[describeIndexes[2]],
        new RegExp(`--stack-name ${STACK_ID}(?:\\s|$)`, "u")
      );
      assert.match(
        calls[describeIndexes[3]],
        new RegExp(`--stack-name ${STACK_ID}(?:\\s|$)`, "u")
      );
      assert.ok(describeIndexes[0] < describeIndexes[1]);
      assert.ok(describeIndexes[1] < updateIndex);
      assert.ok(updateIndex < describeIndexes[2]);
      assert.ok(describeIndexes[2] < deleteIndex);
      assert.ok(deleteIndex < describeIndexes[3]);

      const updateCall = calls[updateIndex];
      assert.match(
        updateCall,
        /(?:^|\s)--no-enable-termination-protection(?:\s|$)/u
      );
      assert.doesNotMatch(
        updateCall,
        /(?:^|\s)--enable-termination-protection(?:\s|$)/u
      );
      assert.match(
        updateCall,
        new RegExp(`--stack-name ${STACK_ID}(?:\\s|$)`, "u")
      );
      assert.equal(
        readFileSync(run.terminationProtectionFile, "utf8"),
        "false"
      );
      assert.deepEqual(JSON.parse(run.result.stdout), {
        ok: true,
        schema: "archon.greenfield-cleanup.proof",
        version: 1,
        state: "greenfield-cleaned",
        stack: "archon-memory-staging",
        stackId: STACK_ID,
        stackDeleted: true,
        retainedBucketDeleted: true,
        retainedLogGroupsDeleted: 3,
      });
    } finally {
      rmSync(run.fixture, { recursive: true, force: true });
    }
  }
);

for (const protectionFailure of [
  {
    name: "update API error",
    terminationProtectionUpdate: "error",
  },
  {
    name: "wrong update StackId",
    terminationProtectionUpdate: "wrong-stack-id",
  },
  {
    name: "protection remaining enabled",
    terminationProtectionUpdate: "remains-enabled",
  },
] as const) {
  test(
    `protected greenfield cleanup fails closed on ${protectionFailure.name}`,
    { skip: process.platform === "win32" },
    () => {
      const run = runCleanup({
        terminationProtection: true,
        terminationProtectionUpdate:
          protectionFailure.terminationProtectionUpdate,
      });
      try {
        assert.notEqual(run.result.status, 0);
        const updateCall = findAwsCall(
          run.calls,
          "cloudformation update-termination-protection"
        );
        assert.match(
          updateCall,
          /(?:^|\s)--no-enable-termination-protection(?:\s|$)/u
        );
        assert.match(
          updateCall,
          new RegExp(`--stack-name ${STACK_ID}(?:\\s|$)`, "u")
        );
        assert.doesNotMatch(
          run.calls,
          /cloudformation delete-stack/u
        );
        assert.doesNotMatch(run.calls, /s3api delete-/u);
        assert.doesNotMatch(run.calls, /logs delete-log-group/u);
      } finally {
        rmSync(run.fixture, { recursive: true, force: true });
      }
    }
  );
}

for (const ownershipFailure of [
  { name: "a mismatched run owner", actualOwner: "b".repeat(64) },
  { name: "a missing run owner", actualOwner: null },
  {
    name: "a mismatched execution role",
    actualRoleArn:
      `arn:aws:iam::${ACCOUNT_ID}:role/another-cloudformation-role`,
  },
  {
    name: "a mismatched StackId",
    actualStackId: STACK_ID.replace(
      "archon-memory-staging",
      "archon-memory-production"
    ),
  },
] as const) {
  test(
    `greenfield cleanup rejects ${ownershipFailure.name} before mutation`,
    { skip: process.platform === "win32" },
    () => {
      const run = runCleanup(ownershipFailure);
      try {
        assert.notEqual(run.result.status, 0);
        assert.match(run.calls, /cloudformation describe-stacks/u);
        assert.doesNotMatch(
          run.calls,
          /cloudformation update-termination-protection/u
        );
        assert.doesNotMatch(run.calls, /cloudformation delete-stack/u);
        assert.doesNotMatch(run.calls, /s3api /u);
        assert.doesNotMatch(run.calls, /logs /u);
      } finally {
        rmSync(run.fixture, { recursive: true, force: true });
      }
    }
  );
}
