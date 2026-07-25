import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROOF_SCRIPT = join(ROOT, "aws", "prove-api-stage-controls.sh");

interface ProofFixture {
  stageName?: string;
  detailedMetrics?: boolean;
  throttlingRate?: number;
  throttlingBurst?: number;
  logStage?: string;
  includeLogEvent?: boolean;
  routeOverride?: boolean;
  legacyDefaultExists?: boolean;
}

function executable(path: string, content: string): void {
  writeFileSync(path, content, "utf8");
  chmodSync(path, 0o755);
}

function processedTemplate(): string {
  return JSON.stringify({
    TemplateBody: {
      Resources: {
        ServerlessHttpApiliveStage: {
          Type: "AWS::ApiGatewayV2::Stage",
          Properties: {
            StageName: "live",
            AutoDeploy: true,
            DefaultRouteSettings: {
              DetailedMetricsEnabled: true,
              ThrottlingBurstLimit: { Ref: "ApiThrottleBurst" },
              ThrottlingRateLimit: { Ref: "ApiThrottleRate" },
            },
            AccessLogSettings: {
              DestinationArn: {
                "Fn::GetAtt": ["ApiVendedAccessLogGroup", "Arn"],
              },
              Format:
                '{"requestId":"$context.requestId","stage":"$context.stage","routeKey":"$context.routeKey","status":"$context.status"}',
            },
          },
        },
      },
    },
  });
}

function runProof(fixture: ProofFixture = {}) {
  const fakeBin = mkdtempSync(join(tmpdir(), "archon-api-stage-proof-"));
  try {
    executable(
      join(fakeBin, "aws"),
      `#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  *"cloudformation get-template"*) printf '%s\\n' "$FAKE_PROCESSED_TEMPLATE" ;;
  *"apigatewayv2 get-stage"*"\\$default"*)
    if [ "$FAKE_LEGACY_DEFAULT_EXISTS" = "true" ]; then
      printf '%s\\n' '{"StageName":"$default"}'
      exit 0
    fi
    echo "NotFoundException: Invalid Stage identifier specified" >&2
    exit 254 ;;
  *"apigatewayv2 get-stage"*) printf '%s\\n' "$FAKE_LIVE_STAGE" ;;
  *"logs describe-log-streams"*) printf '%s\\n' "$FAKE_LOG_STREAMS" ;;
  *"logs filter-log-events"*) printf '%s\\n' "$FAKE_LOG_EVENTS" ;;
  *) echo "Unexpected aws invocation: $*" >&2; exit 97 ;;
esac
`
    );
    executable(
      join(fakeBin, "curl"),
      "#!/usr/bin/env bash\nprintf '%s\\n' '{\"ok\":true}'\n"
    );
    executable(join(fakeBin, "seq"), "#!/usr/bin/env bash\nprintf '1\\n'\n");
    executable(join(fakeBin, "sleep"), "#!/usr/bin/env bash\nexit 0\n");

    const stageName = fixture.stageName ?? "live";
    const logStage = fixture.logStage ?? "live";
    const includeLogEvent = fixture.includeLogEvent ?? true;
    const liveStage = {
      StageName: stageName,
      AutoDeploy: true,
      DefaultRouteSettings: {
        DetailedMetricsEnabled: fixture.detailedMetrics ?? true,
        ThrottlingRateLimit: fixture.throttlingRate ?? 5,
        ThrottlingBurstLimit: fixture.throttlingBurst ?? 10,
      },
      AccessLogSettings: {
        DestinationArn:
          "arn:aws:logs:eu-west-1:123456789012:log-group:/aws/vendedlogs/apigateway/archon-memory-staging:*",
        Format:
          '{"requestId":"$context.requestId","stage":"$context.stage","routeKey":"$context.routeKey","status":"$context.status"}',
      },
      RouteSettings: fixture.routeOverride
        ? {
            "GET /api/health": {
              DetailedMetricsEnabled: false,
              ThrottlingRateLimit: 50,
            },
          }
        : undefined,
    };
    const logEvents = includeLogEvent
      ? {
          events: [
            {
              message: JSON.stringify({
                requestId: "request-123",
                stage: logStage,
                routeKey: "GET /api/health",
                status: "200",
              }),
            },
          ],
        }
      : { events: [] };

    return spawnSync("bash", [PROOF_SCRIPT, "verify"], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        STACK_NAME: "archon-memory-staging",
        API_ID: "api123",
        API_STAGE_NAME: "live",
        API_ACCESS_LOG_GROUP:
          "/aws/vendedlogs/apigateway/archon-memory-staging",
        APPLICATION_URL: "https://example.invalid",
        AWS_ACCOUNT_ID: "123456789012",
        AWS_REGION: "eu-west-1",
        FAKE_PROCESSED_TEMPLATE: processedTemplate(),
        FAKE_LIVE_STAGE: JSON.stringify(liveStage),
        FAKE_LEGACY_DEFAULT_EXISTS: String(
          fixture.legacyDefaultExists ?? false
        ),
        FAKE_LOG_STREAMS: JSON.stringify({
          logStreams: [{ logStreamName: "stream-1" }],
        }),
        FAKE_LOG_EVENTS: JSON.stringify(logEvents),
      },
    });
  } finally {
    rmSync(fakeBin, { recursive: true, force: true });
  }
}

function runGreenfieldPreflight(error: string) {
  const fakeBin = mkdtempSync(join(tmpdir(), "archon-api-stage-preflight-"));
  try {
    executable(
      join(fakeBin, "aws"),
      `#!/usr/bin/env bash
if [[ "$*" == *"cloudformation describe-stacks"* ]]; then
  printf '%s\\n' "$FAKE_DESCRIBE_ERROR" >&2
  exit 255
fi
echo "Unexpected aws invocation: $*" >&2
exit 97
`
    );
    return spawnSync("bash", [PROOF_SCRIPT, "preflight"], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        STACK_NAME: "archon-memory-staging",
        API_ACCESS_LOG_GROUP: "/aws/apigateway/archon-memory-staging",
        AWS_REGION: "eu-west-1",
        FAKE_DESCRIBE_ERROR: error,
      },
    });
  } finally {
    rmSync(fakeBin, { recursive: true, force: true });
  }
}

function runExistingPreflight(
  liveStageError = "",
  includeVendedLogOutput = true
) {
  const fakeBin = mkdtempSync(join(tmpdir(), "archon-api-stage-preflight-"));
  try {
    executable(
      join(fakeBin, "aws"),
      `#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  *"cloudformation describe-stacks"*) printf '%s\\n' "$FAKE_CURRENT_STACK" ;;
  *"cloudformation get-template"*) printf '%s\\n' '{"TemplateBody":{}}' ;;
  *"apigatewayv2 get-stage"*"stage-name live"*)
    if [ -n "$FAKE_LIVE_STAGE_ERROR" ]; then
      printf '%s\\n' "$FAKE_LIVE_STAGE_ERROR" >&2
      exit 255
    fi
    printf '%s\\n' '{"StageName":"live"}' ;;
  *"apigatewayv2 get-stage"*"stage-name \\$default"*)
    printf '%s\\n' '{"StageName":"$default"}' ;;
  *"logs describe-log-streams"*) printf '%s\\n' '{"logStreams":[]}' ;;
  *"logs filter-log-events"*) printf '%s\\n' '{"events":[]}' ;;
  *) echo "Unexpected aws invocation: $*" >&2; exit 97 ;;
esac
`
    );
    const currentStack = {
      Stacks: [
        {
          Outputs: [
            {
              OutputKey: "ApiEndpoint",
              OutputValue:
                "https://api123.execute-api.eu-west-1.amazonaws.com/live",
            },
            ...(includeVendedLogOutput
              ? [
                  {
                    OutputKey: "ApiAccessLogGroupName",
                    OutputValue:
                      "/aws/vendedlogs/apigateway/archon-memory-staging",
                  },
                ]
              : []),
          ],
        },
      ],
    };
    return spawnSync("bash", [PROOF_SCRIPT, "preflight"], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        STACK_NAME: "archon-memory-staging",
        API_ACCESS_LOG_GROUP: "/aws/apigateway/archon-memory-staging",
        AWS_REGION: "eu-west-1",
        FAKE_CURRENT_STACK: JSON.stringify(currentStack),
        FAKE_LIVE_STAGE_ERROR: liveStageError,
      },
    });
  } finally {
    rmSync(fakeBin, { recursive: true, force: true });
  }
}

test(
  "API stage proof accepts only the exact live control and access-log contract",
  { skip: process.platform === "win32" },
  () => {
    const result = runProof();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      stage: "live",
      legacyDefaultStageAbsent: true,
      detailedMetrics: true,
      throttlingRate: 5,
      throttlingBurst: 10,
      accessLogGroup: "/aws/vendedlogs/apigateway/archon-memory-staging",
      accessLogEvent: "GET /api/health 200",
    });
  }
);

test(
  "API stage preflight permits only an explicit missing live stage during the legacy migration",
  { skip: process.platform === "win32" },
  () => {
    const result = runExistingPreflight(
      "NotFoundException: Invalid Stage identifier specified",
      false
    );
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.state, "existing");
    assert.equal(receipt.currentStage, "$default");
    assert.equal(
      receipt.accessLogGroup,
      "/aws/apigateway/archon-memory-staging"
    );
  }
);

test(
  "API stage preflight fails closed when reading live is unauthorized even if default exists",
  { skip: process.platform === "win32" },
  () => {
    const result = runExistingPreflight(
      "AccessDenied: not authorized to perform apigateway:GET",
      false
    );
    assert.notEqual(result.status, 0);
  }
);

for (const [name, fixture] of [
  ["wrong live stage", { stageName: "$default" }],
  ["missing detailed metrics", { detailedMetrics: false }],
  ["wrong throttle rate", { throttlingRate: 6 }],
  ["wrong throttle burst", { throttlingBurst: 11 }],
  ["missing access-log event", { includeLogEvent: false }],
  ["access log from the wrong stage", { logStage: "$default" }],
  ["a per-route control override", { routeOverride: true }],
  ["a remaining legacy default stage", { legacyDefaultExists: true }],
] as const) {
  test(
    `API stage proof rejects ${name}`,
    { skip: process.platform === "win32" },
    () => {
      const result = runProof(fixture);
      assert.notEqual(result.status, 0);
    }
  );
}

test(
  "API stage preflight defers only an explicit greenfield stack",
  { skip: process.platform === "win32" },
  () => {
    const result = runGreenfieldPreflight(
      "ValidationError: Stack with id archon-memory-staging does not exist"
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      mode: "preflight",
      state: "greenfield",
      deferredToPostDeploy: true,
    });
  }
);

test(
  "API stage preflight follows the deployed vended log-group output during migration",
  { skip: process.platform === "win32" },
  () => {
    const result = runExistingPreflight();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      mode: "preflight",
      state: "existing",
      currentStage: "live",
      accessLogGroup:
        "/aws/vendedlogs/apigateway/archon-memory-staging",
      permissions: [
        "cloudformation:GetTemplate",
        "apigateway:GET",
        "logs:DescribeLogStreams",
        "logs:FilterLogEvents",
      ],
    });
  }
);

test(
  "API stage preflight fails closed on an authorization error",
  { skip: process.platform === "win32" },
  () => {
    const result = runGreenfieldPreflight(
      "AccessDenied: not authorized to perform cloudformation:DescribeStacks"
    );
    assert.notEqual(result.status, 0);
  }
);
