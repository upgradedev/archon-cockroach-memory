import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
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
const SCRIPT = join(ROOT, "aws", "prove-alarm-routing.sh");
const APP_NAME = "archon-memory";
const AWS_ACCOUNT_ID = "123456789012";
const AWS_REGION = "eu-west-1";
const ENVIRONMENT = "staging";
const FOUNDATION_STACK = `${APP_NAME}-delivery-bootstrap`;
const FOUNDATION_STACK_ID =
  `arn:aws:cloudformation:${AWS_REGION}:${AWS_ACCOUNT_ID}:` +
  `stack/${FOUNDATION_STACK}/11111111-2222-3333-4444-555555555555`;
const KEY_ARN =
  `arn:aws:kms:${AWS_REGION}:${AWS_ACCOUNT_ID}:` +
  "key/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const STAGING_TOPIC_ARN =
  `arn:aws:sns:${AWS_REGION}:${AWS_ACCOUNT_ID}:` +
  `${APP_NAME}-staging-alarms`;
const PRODUCTION_TOPIC_ARN =
  `arn:aws:sns:${AWS_REGION}:${AWS_ACCOUNT_ID}:` +
  `${APP_NAME}-production-alarms`;
const STAGING_QUEUE_ARN =
  `arn:aws:sqs:${AWS_REGION}:${AWS_ACCOUNT_ID}:` +
  `${APP_NAME}-staging-alarm-archive`;
const PRODUCTION_QUEUE_ARN =
  `arn:aws:sqs:${AWS_REGION}:${AWS_ACCOUNT_ID}:` +
  `${APP_NAME}-production-alarm-archive`;
const STAGING_QUEUE_URL =
  `https://sqs.${AWS_REGION}.amazonaws.com/${AWS_ACCOUNT_ID}/` +
  `${APP_NAME}-staging-alarm-archive`;
const SUBSCRIPTION_ARN =
  `arn:aws:sns:${AWS_REGION}:${AWS_ACCOUNT_ID}:` +
  `${APP_NAME}-staging-alarms:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`;
const SECRET_MARKER = "must-not-leak-fake-aws-diagnostic";

type FoundationMode = "legacy-inactive" | "inactive" | "partial" | "active";

interface AlarmRun {
  calls: string[];
  process: SpawnSyncReturns<string>;
}

interface AlarmRunOptions {
  alarmActionState?: "cross-environment" | "expected" | "none";
  queuePolicy?: object;
  topicPolicy?: object;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value)}\n`, "utf8");
}

function foundation(mode: FoundationMode): object {
  const parameters =
    mode === "legacy-inactive"
      ? []
      : [
          {
            ParameterKey: "AlarmRoutingEnabled",
            ParameterValue: mode === "active" ? "true" : "false",
          },
        ];
  const outputs =
    mode === "active"
      ? [
          {
            OutputKey: "AlarmRoutingContractVersion",
            OutputValue: "1",
          },
          {
            OutputKey: "AlarmNotificationsKeyArn",
            OutputValue: KEY_ARN,
          },
          {
            OutputKey: "StagingAlarmTopicArn",
            OutputValue: STAGING_TOPIC_ARN,
          },
          {
            OutputKey: "ProductionAlarmTopicArn",
            OutputValue: PRODUCTION_TOPIC_ARN,
          },
          {
            OutputKey: "StagingAlarmArchiveQueueArn",
            OutputValue: STAGING_QUEUE_ARN,
          },
          {
            OutputKey: "ProductionAlarmArchiveQueueArn",
            OutputValue: PRODUCTION_QUEUE_ARN,
          },
        ]
      : mode === "partial"
        ? [
            {
              OutputKey: "StagingAlarmTopicArn",
              OutputValue: STAGING_TOPIC_ARN,
            },
          ]
        : [];
  return {
    Stacks: [
      {
        EnableTerminationProtection: true,
        Outputs: outputs,
        Parameters: parameters,
        StackId: FOUNDATION_STACK_ID,
        StackName: FOUNDATION_STACK,
        StackStatus: "UPDATE_COMPLETE",
      },
    ],
  };
}

const keyPolicy = {
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "EnableAccountAdministration",
      Effect: "Allow",
      Principal: {
        AWS: `arn:aws:iam::${AWS_ACCOUNT_ID}:root`,
      },
      Action: "kms:*",
      Resource: "*",
    },
    {
      Sid: "AllowCloudWatchAlarmEncryption",
      Effect: "Allow",
      Principal: { Service: "cloudwatch.amazonaws.com" },
      Action: ["kms:Decrypt", "kms:GenerateDataKey*"],
      Resource: "*",
      Condition: {
        StringEquals: { "aws:SourceAccount": AWS_ACCOUNT_ID },
        ArnLike: {
          "aws:SourceArn": [
            `arn:aws:cloudwatch:${AWS_REGION}:${AWS_ACCOUNT_ID}:` +
              `alarm:${APP_NAME}-staging-*`,
            `arn:aws:cloudwatch:${AWS_REGION}:${AWS_ACCOUNT_ID}:` +
              `alarm:${APP_NAME}-production-*`,
          ],
        },
      },
    },
    {
      Sid: "AllowSnsEncryptedQueueDelivery",
      Effect: "Allow",
      Principal: { Service: "sns.amazonaws.com" },
      Action: ["kms:Decrypt", "kms:GenerateDataKey*"],
      Resource: "*",
      Condition: {
        StringEquals: { "aws:SourceAccount": AWS_ACCOUNT_ID },
      },
    },
  ],
};

const topicPolicy = {
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "AllowAccountTopicAdministration",
      Effect: "Allow",
      Principal: {
        AWS: `arn:aws:iam::${AWS_ACCOUNT_ID}:root`,
      },
      Action: [
        "sns:AddPermission",
        "sns:DeleteTopic",
        "sns:GetTopicAttributes",
        "sns:ListSubscriptionsByTopic",
        "sns:Publish",
        "sns:RemovePermission",
        "sns:SetTopicAttributes",
        "sns:Subscribe",
      ],
      Resource: [STAGING_TOPIC_ARN, PRODUCTION_TOPIC_ARN],
    },
    {
      Sid: "AllowStagingCloudWatchAlarmPublish",
      Effect: "Allow",
      Principal: { Service: "cloudwatch.amazonaws.com" },
      Action: "sns:Publish",
      Resource: STAGING_TOPIC_ARN,
      Condition: {
        StringEquals: { "aws:SourceAccount": AWS_ACCOUNT_ID },
        ArnLike: {
          "aws:SourceArn":
            `arn:aws:cloudwatch:${AWS_REGION}:${AWS_ACCOUNT_ID}:` +
            `alarm:${APP_NAME}-staging-*`,
        },
      },
    },
    {
      Sid: "AllowProductionCloudWatchAlarmPublish",
      Effect: "Allow",
      Principal: { Service: "cloudwatch.amazonaws.com" },
      Action: "sns:Publish",
      Resource: PRODUCTION_TOPIC_ARN,
      Condition: {
        StringEquals: { "aws:SourceAccount": AWS_ACCOUNT_ID },
        ArnLike: {
          "aws:SourceArn":
            `arn:aws:cloudwatch:${AWS_REGION}:${AWS_ACCOUNT_ID}:` +
            `alarm:${APP_NAME}-production-*`,
        },
      },
    },
    {
      Sid: "DenyInsecureTransport",
      Effect: "Deny",
      Principal: "*",
      Action: "sns:*",
      Resource: [STAGING_TOPIC_ARN, PRODUCTION_TOPIC_ARN],
      Condition: { Bool: { "aws:SecureTransport": "false" } },
    },
  ],
};

const queuePolicy = {
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "AllowStagingAlarmArchiveDelivery",
      Effect: "Allow",
      Principal: { Service: "sns.amazonaws.com" },
      Action: "sqs:SendMessage",
      Resource: STAGING_QUEUE_ARN,
      Condition: {
        StringEquals: { "aws:SourceAccount": AWS_ACCOUNT_ID },
        ArnEquals: { "aws:SourceArn": STAGING_TOPIC_ARN },
      },
    },
    {
      Sid: "AllowProductionAlarmArchiveDelivery",
      Effect: "Allow",
      Principal: { Service: "sns.amazonaws.com" },
      Action: "sqs:SendMessage",
      Resource: PRODUCTION_QUEUE_ARN,
      Condition: {
        StringEquals: { "aws:SourceAccount": AWS_ACCOUNT_ID },
        ArnEquals: { "aws:SourceArn": PRODUCTION_TOPIC_ARN },
      },
    },
    {
      Sid: "DenyStagingAlarmArchiveInjection",
      Effect: "Deny",
      Principal: "*",
      Action: "sqs:SendMessage",
      Resource: STAGING_QUEUE_ARN,
      Condition: {
        ArnNotLike: { "aws:SourceArn": STAGING_TOPIC_ARN },
      },
    },
    {
      Sid: "DenyProductionAlarmArchiveInjection",
      Effect: "Deny",
      Principal: "*",
      Action: "sqs:SendMessage",
      Resource: PRODUCTION_QUEUE_ARN,
      Condition: {
        ArnNotLike: { "aws:SourceArn": PRODUCTION_TOPIC_ARN },
      },
    },
    {
      Sid: "DenyInsecureTransport",
      Effect: "Deny",
      Principal: "*",
      Action: "sqs:*",
      Resource: [STAGING_QUEUE_ARN, PRODUCTION_QUEUE_ARN],
      Condition: { Bool: { "aws:SecureTransport": "false" } },
    },
  ],
};

function alarms(
  actionState: NonNullable<AlarmRunOptions["alarmActionState"]>
): object {
  const topic =
    actionState === "cross-environment"
      ? PRODUCTION_TOPIC_ARN
      : STAGING_TOPIC_ARN;
  return {
    CompositeAlarms: [],
    MetricAlarms: [
      `${APP_NAME}-staging-lambda-errors`,
      `${APP_NAME}-staging-lambda-canary-errors-v42`,
      `${APP_NAME}-staging-lambda-throttles`,
      `${APP_NAME}-staging-api-5xx`,
    ].map((AlarmName) => ({
      ActionsEnabled: true,
      AlarmActions: actionState === "none" ? [] : [topic],
      AlarmName,
      InsufficientDataActions: [],
      OKActions: [],
    })),
  };
}

function runAlarmProof(
  mode: "discover" | "verify",
  foundationMode: FoundationMode,
  options: AlarmRunOptions = {}
): AlarmRun {
  const work = mkdtempSync(join(tmpdir(), "archon-alarm-routing-"));
  const fakeBin = join(work, "bin");
  const callsFile = join(work, "calls.log");
  mkdirSync(fakeBin);
  writeFileSync(callsFile, "", "utf8");

  const fixtures: Record<string, unknown> = {
    foundation: foundation(foundationMode),
    keyDescription: {
      KeyMetadata: {
        Arn: KEY_ARN,
        Enabled: true,
        KeyManager: "CUSTOMER",
        KeySpec: "SYMMETRIC_DEFAULT",
        KeyState: "Enabled",
        KeyUsage: "ENCRYPT_DECRYPT",
        MultiRegion: false,
      },
    },
    keyRotation: { KeyRotationEnabled: true },
    keyPolicy: { Policy: JSON.stringify(keyPolicy) },
    keyTags: {
      Tags: [
        { TagKey: "Application", TagValue: APP_NAME },
        {
          TagKey: "DataClassification",
          TagValue: "alarm-notifications",
        },
        { TagKey: "ManagedBy", TagValue: "CloudFormation" },
      ],
    },
    topic: {
      Attributes: {
        KmsMasterKeyId: KEY_ARN,
        Owner: AWS_ACCOUNT_ID,
        Policy: JSON.stringify(options.topicPolicy ?? topicPolicy),
        SubscriptionsConfirmed: "1",
        SubscriptionsDeleted: "0",
        SubscriptionsPending: "0",
        TopicArn: STAGING_TOPIC_ARN,
      },
    },
    topicTags: {
      Tags: [
        { Key: "Application", Value: APP_NAME },
        {
          Key: "DataClassification",
          Value: "alarm-notifications",
        },
        { Key: "Environment", Value: ENVIRONMENT },
        { Key: "ManagedBy", Value: "CloudFormation" },
      ],
    },
    subscriptions: {
      Subscriptions: [
        {
          Endpoint: STAGING_QUEUE_ARN,
          Protocol: "sqs",
          SubscriptionArn: SUBSCRIPTION_ARN,
          TopicArn: STAGING_TOPIC_ARN,
        },
      ],
    },
    subscription: {
      Attributes: {
        Endpoint: STAGING_QUEUE_ARN,
        Owner: AWS_ACCOUNT_ID,
        PendingConfirmation: "false",
        Protocol: "sqs",
        RawMessageDelivery: "false",
        SubscriptionArn: SUBSCRIPTION_ARN,
        TopicArn: STAGING_TOPIC_ARN,
      },
    },
    queueUrl: { QueueUrl: STAGING_QUEUE_URL },
    queue: {
      Attributes: {
        KmsDataKeyReusePeriodSeconds: "300",
        KmsMasterKeyId: KEY_ARN,
        MessageRetentionPeriod: "1209600",
        Policy: JSON.stringify(options.queuePolicy ?? queuePolicy),
        QueueArn: STAGING_QUEUE_ARN,
        ReceiveMessageWaitTimeSeconds: "20",
        VisibilityTimeout: "60",
      },
    },
    queueTags: {
      Tags: {
        Application: APP_NAME,
        DataClassification: "alarm-notifications",
        Environment: ENVIRONMENT,
        ManagedBy: "CloudFormation",
      },
    },
    alarms: alarms(
      options.alarmActionState ??
        (foundationMode === "active" ? "expected" : "none")
    ),
  };
  const paths: Record<string, string> = {};
  for (const [name, fixture] of Object.entries(fixtures)) {
    const path = join(work, `${name}.json`);
    writeJson(path, fixture);
    paths[name] = path;
  }

  const fakeAws = join(fakeBin, "aws");
  writeFileSync(
    fakeAws,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >>"$FAKE_CALLS_FILE"
case "$*" in
  *"cloudformation describe-stacks"*) cat "$FAKE_FOUNDATION" ;;
  *"kms describe-key"*) cat "$FAKE_KEY_DESCRIPTION" ;;
  *"kms get-key-rotation-status"*) cat "$FAKE_KEY_ROTATION" ;;
  *"kms get-key-policy"*) cat "$FAKE_KEY_POLICY" ;;
  *"kms list-resource-tags"*) cat "$FAKE_KEY_TAGS" ;;
  *"sns get-topic-attributes"*) cat "$FAKE_TOPIC" ;;
  *"sns list-tags-for-resource"*) cat "$FAKE_TOPIC_TAGS" ;;
  *"sns list-subscriptions-by-topic"*) cat "$FAKE_SUBSCRIPTIONS" ;;
  *"sns get-subscription-attributes"*) cat "$FAKE_SUBSCRIPTION" ;;
  *"sqs get-queue-url"*) cat "$FAKE_QUEUE_URL" ;;
  *"sqs get-queue-attributes"*) cat "$FAKE_QUEUE" ;;
  *"sqs list-queue-tags"*) cat "$FAKE_QUEUE_TAGS" ;;
  *"cloudwatch describe-alarms"*) cat "$FAKE_ALARMS" ;;
  *)
    printf '%s\\n' "unexpected AWS call: ${SECRET_MARKER}" >&2
    exit 97
    ;;
esac
`,
    "utf8"
  );
  chmodSync(fakeAws, 0o755);

  try {
    const processResult = spawnSync("bash", [SCRIPT, mode], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        APP_NAME,
        AWS_ACCOUNT_ID,
        AWS_REGION,
        ENVIRONMENT,
        FAKE_ALARMS: paths.alarms,
        FAKE_CALLS_FILE: callsFile,
        FAKE_FOUNDATION: paths.foundation,
        FAKE_KEY_DESCRIPTION: paths.keyDescription,
        FAKE_KEY_POLICY: paths.keyPolicy,
        FAKE_KEY_ROTATION: paths.keyRotation,
        FAKE_KEY_TAGS: paths.keyTags,
        FAKE_QUEUE: paths.queue,
        FAKE_QUEUE_TAGS: paths.queueTags,
        FAKE_QUEUE_URL: paths.queueUrl,
        FAKE_SUBSCRIPTION: paths.subscription,
        FAKE_SUBSCRIPTIONS: paths.subscriptions,
        FAKE_TOPIC: paths.topic,
        FAKE_TOPIC_TAGS: paths.topicTags,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
    });
    const calls = readFileSync(callsFile, "utf8")
      .split(/\r?\n/u)
      .filter(Boolean);
    return { calls, process: processResult };
  } finally {
    rmSync(work, { force: true, recursive: true });
  }
}

function mutatePolicyStatement(
  policy: object,
  sid: string,
  mutate: (statement: Record<string, unknown>) => void
): object {
  const copy = JSON.parse(JSON.stringify(policy)) as {
    Statement: Array<Record<string, unknown>>;
  };
  const statement = copy.Statement.find((candidate) => candidate.Sid === sid);
  assert.ok(statement, `missing fixture statement ${sid}`);
  mutate(statement);
  return copy;
}

test("alarm routing: legacy foundation remains safely inactive with one read", () => {
  const result = runAlarmProof("verify", "legacy-inactive");
  assert.equal(result.process.status, 0, result.process.stderr);
  const proof = JSON.parse(result.process.stdout) as {
    alarmCount: null;
    state: string;
    topicArn: null;
  };
  assert.equal(proof.state, "legacy-inactive-not-provisioned");
  assert.equal(proof.topicArn, null);
  assert.equal(proof.alarmCount, null);
  assert.equal(result.calls.length, 1);
  assert.match(result.calls[0] ?? "", /cloudformation describe-stacks/u);
});

test("alarm routing: explicit false foundation remains safely inactive", () => {
  const result = runAlarmProof("verify", "inactive");
  assert.equal(result.process.status, 0, result.process.stderr);
  const proof = JSON.parse(result.process.stdout) as {
    alarmCount: number;
    state: string;
  };
  assert.equal(proof.state, "inactive-not-provisioned");
  assert.equal(proof.alarmCount, 4);
  assert.equal(result.calls.length, 2);
  assert.match(result.calls[1] ?? "", /cloudwatch describe-alarms/u);
});

test("alarm routing: inactive verify rejects stale alarm actions", () => {
  const result = runAlarmProof("verify", "inactive", {
    alarmActionState: "expected",
  });
  assert.notEqual(result.process.status, 0);
  assert.match(
    result.process.stderr,
    /CloudWatch alarms retain actions while alarm routing is inactive/u
  );
  assert.equal(result.calls.length, 2);
});

test("alarm routing: partial foundation output fails before resource reads", () => {
  const result = runAlarmProof("discover", "partial");
  assert.notEqual(result.process.status, 0);
  assert.equal(result.calls.length, 1);
  assert.match(
    result.process.stderr,
    /outputs exist while the foundation switch is inactive/u
  );
  assert.doesNotMatch(result.process.stderr, new RegExp(SECRET_MARKER, "u"));
});

test("alarm routing: active discovery proves encrypted archive topology", () => {
  const result = runAlarmProof("discover", "active");
  assert.equal(result.process.status, 0, result.process.stderr);
  const proof = JSON.parse(result.process.stdout) as {
    alarmCount: null;
    archiveQueueArn: string;
    keyArn: string;
    state: string;
    topicArn: string;
  };
  assert.equal(proof.state, "active");
  assert.equal(proof.keyArn, KEY_ARN);
  assert.equal(proof.topicArn, STAGING_TOPIC_ARN);
  assert.equal(proof.archiveQueueArn, STAGING_QUEUE_ARN);
  assert.equal(proof.alarmCount, null);
  assert.equal(result.calls.length, 12);
  assert.equal(
    result.calls.some((call) => call.includes("cloudwatch describe-alarms")),
    false
  );
});

test("alarm routing: proof rejects broadened SNS account administration", () => {
  const broadenedTopicPolicy = mutatePolicyStatement(
    topicPolicy,
    "AllowAccountTopicAdministration",
    (statement) => {
      statement.Principal = "*";
    }
  );
  const result = runAlarmProof("discover", "active", {
    topicPolicy: broadenedTopicPolicy,
  });
  assert.notEqual(result.process.status, 0);
  assert.match(
    result.process.stderr,
    /SNS topic attributes or policy are outside/u
  );
});

test("alarm routing: proof validates the other environment SNS grant", () => {
  const broadenedTopicPolicy = mutatePolicyStatement(
    topicPolicy,
    "AllowProductionCloudWatchAlarmPublish",
    (statement) => {
      statement.Resource = "*";
    }
  );
  const result = runAlarmProof("discover", "active", {
    topicPolicy: broadenedTopicPolicy,
  });
  assert.notEqual(result.process.status, 0);
  assert.match(
    result.process.stderr,
    /SNS topic attributes or policy are outside/u
  );
});

test("alarm routing: proof rejects a weakened archive producer deny", () => {
  const weakenedQueuePolicy = mutatePolicyStatement(
    queuePolicy,
    "DenyStagingAlarmArchiveInjection",
    (statement) => {
      statement.Condition = {
        ArnNotLike: { "aws:SourceArn": "*" },
      };
    }
  );
  const result = runAlarmProof("discover", "active", {
    queuePolicy: weakenedQueuePolicy,
  });
  assert.notEqual(result.process.status, 0);
  assert.match(
    result.process.stderr,
    /SQS archive queue attributes or policy are outside/u
  );
});

test("alarm routing: active verify accepts exactly four routed alarms", () => {
  const result = runAlarmProof("verify", "active");
  assert.equal(result.process.status, 0, result.process.stderr);
  assert.equal(
    (JSON.parse(result.process.stdout) as { alarmCount: number }).alarmCount,
    4
  );
  assert.equal(result.calls.length, 13);
});

test("alarm routing: active verify rejects a cross-environment topic", () => {
  const result = runAlarmProof("verify", "active", {
    alarmActionState: "cross-environment",
  });
  assert.notEqual(result.process.status, 0);
  assert.match(
    result.process.stderr,
    /CloudWatch alarms are not exclusively wired/u
  );
  assert.equal(
    result.calls.some((call) => call.includes("cloudwatch describe-alarms")),
    true
  );
});

test("alarm routing: source contract is dormant, protected, and CI-gated", () => {
  const foundationSource = readFileSync(
    join(ROOT, "aws", "bootstrap-oidc.yaml"),
    "utf8"
  );
  const stackPolicy = readFileSync(
    join(ROOT, "aws", "bootstrap-stack-policy.json"),
    "utf8"
  );
  const deploy = readFileSync(
    join(ROOT, ".github", "workflows", "deploy-aws.yml"),
    "utf8"
  );
  const ci = readFileSync(
    join(ROOT, ".github", "workflows", "ci.yml"),
    "utf8"
  );
  const packageSource = readFileSync(join(ROOT, "package.json"), "utf8");

  assert.match(
    foundationSource,
    /AlarmRoutingEnabled:\r?\n\s+Type: String\r?\n\s+Default: "false"/u
  );
  assert.match(
    foundationSource,
    /EnableAlarmRouting: !Equals \[!Ref AlarmRoutingEnabled, "true"\]/u
  );
  for (const logicalId of [
    "AlarmNotificationsKey",
    "AlarmNotificationsKeyAlias",
    "StagingAlarmTopic",
    "ProductionAlarmTopic",
    "StagingAlarmArchiveQueue",
    "ProductionAlarmArchiveQueue",
    "StagingAlarmArchiveSubscription",
    "ProductionAlarmArchiveSubscription",
  ]) {
    assert.match(
      foundationSource,
      new RegExp(
        `  ${logicalId}:\\r?\\n[\\s\\S]*?Condition: EnableAlarmRouting`,
        "u"
      )
    );
    assert.match(
      stackPolicy,
      new RegExp(`LogicalResourceId/${logicalId}`, "u")
    );
  }
  assert.match(
    foundationSource,
    /AlarmStateInspectionPolicy:\r?\n\s+Type: AWS::IAM::Policy\r?\n\s+Properties:[\s\S]*?Roles:\r?\n\s+- !Ref StagingDeployRole\r?\n\s+- !Ref ProductionDeployRole[\s\S]*?Action: cloudwatch:DescribeAlarms\r?\n\s+Resource: "\*"/u
  );
  assert.match(
    stackPolicy,
    /LogicalResourceId\/AlarmStateInspectionPolicy/u
  );
  assert.match(foundationSource, /EnableKeyRotation: true/u);
  assert.match(
    foundationSource,
    /DenyStagingAlarmArchiveInjection[\s\S]*?ArnNotLike:[\s\S]*?aws:SourceArn: !Ref StagingAlarmTopic/u
  );
  assert.match(
    foundationSource,
    /DenyProductionAlarmArchiveInjection[\s\S]*?ArnNotLike:[\s\S]*?aws:SourceArn: !Ref ProductionAlarmTopic/u
  );
  assert.equal(
    (
      foundationSource.match(
        /KmsMasterKeyId: !GetAtt AlarmNotificationsKey\.Arn/gu
      ) ?? []
    ).length,
    4
  );
  assert.doesNotMatch(deploy, /secrets\.ALARM_TOPIC_ARN/u);
  assert.doesNotMatch(deploy, /if \[ -n "\$ALARM_TOPIC_ARN" \]/u);
  assert.equal(
    (deploy.match(/AlarmTopicArn: \$alarmTopicArn/gu) ?? []).length,
    2
  );
  assert.match(
    deploy,
    /parameter_overrides_file="\$\{RUNNER_TEMP:\?\}\/staging-sam-parameters\.yaml"/u
  );
  assert.match(
    deploy,
    /parameter_overrides_file="\$\{RUNNER_TEMP:\?\}\/production-sam-parameters\.yaml"/u
  );
  assert.doesNotMatch(deploy, /sam-parameters\.json/u);
  assert.match(
    deploy,
    /JSON support is intentionally disabled upstream/u
  );
  assert.equal(
    (deploy.match(/--arg reservedConcurrency "5"/gu) ?? []).length,
    6
  );
  assert.equal(
    (
      deploy.match(
        /ReservedConcurrency: \$reservedConcurrency/gu
      ) ?? []
    ).length,
    2
  );
  assert.equal(
    (
      deploy.match(
        /and \.ReservedConcurrency == \$reservedConcurrency/gu
      ) ?? []
    ).length,
    2
  );
  assert.equal(
    (
      deploy.match(
        /and \.AlarmTopicArn == \$alarmTopicArn/gu
      ) ?? []
    ).length,
    2
  );
  assert.equal(
    (
      deploy.match(
        /--parameter-overrides "file:\/\/\$\{parameter_overrides_file\}"/gu
      ) ?? []
    ).length,
    2
  );
  assert.doesNotMatch(deploy, /"AlarmTopicArn=\$ALARM_TOPIC_ARN"/u);
  assert.equal(
    (deploy.match(/bash aws\/prove-alarm-routing\.sh discover/gu) ?? [])
      .length,
    2
  );
  assert.equal(
    (deploy.match(/bash aws\/prove-alarm-routing\.sh verify/gu) ?? [])
      .length,
    2
  );
  assert.equal(
    (
      deploy.match(
        /\.state == "legacy-inactive-not-provisioned"\s+and \.alarmCount == null/gu
      ) ?? []
    ).length,
    2
  );
  assert.equal(
    (deploy.match(/\.state == "inactive-not-provisioned"/gu) ?? []).length,
    4
  );
  assert.equal(
    (
      deploy.match(
        /ALARM_TOPIC_ARN: \$\{\{ steps\.alarm_routing\.outputs\.topic_arn \}\}/gu
      ) ?? []
    ).length,
    2
  );
  assert.match(ci, /bash -n aws\/prove-alarm-routing\.sh/u);
  assert.match(packageSource, /tests\/alarm-routing\.test\.ts/u);
});
