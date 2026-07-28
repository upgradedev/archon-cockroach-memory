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
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLASSIFY_SOURCE = join(
  ROOT,
  "aws",
  "classify-durable-recovery-source.sh"
);
const RECOVERY_LEDGER = join(
  ROOT,
  "aws",
  "recovery-intent-ledger.sh"
);
const PUT_RECOVERY_OBJECT = join(
  ROOT,
  "aws",
  "put-durable-recovery-object.sh"
);

const APP_NAME = "archon-memory";
const ACCOUNT_ID = "123456789012";
const AWS_REGION = "eu-west-1";
const ENVIRONMENT = "staging";
const REPOSITORY = "upgradedev/archon-cockroach-memory";
const ARTIFACT_BUCKET =
  `${APP_NAME}-artifacts-${ACCOUNT_ID}-${AWS_REGION}`;
const INTENT_ID = "b".repeat(64);
const CANDIDATE_SHA = "a".repeat(40);
const SOURCE_RUN_ID = "8001";
const SOURCE_RUN_ATTEMPT = "3";
const OWNER_RUN_ID = "9001";
const OWNER_RUN_ATTEMPT = "2";
const PRIOR_OWNER =
  `watchdog-${OWNER_RUN_ID}-${OWNER_RUN_ATTEMPT}-${ENVIRONMENT}`;
const NEXT_OWNER = "watchdog-9100-1-staging";
const TERMINAL_JOB_NAME = "Deploy and smoke staging";

const CONTROLLED_ENV_KEYS = [
  "APP_NAME",
  "AWS_ACCOUNT_ID",
  "AWS_REGION",
  "CANDIDATE_SHA",
  "FAKE_ARTIFACT_BUCKET",
  "FAKE_AWS_CALL_LOG",
  "FAKE_GH_CALL_LOG",
  "FAKE_JOBS_FILE",
  "FAKE_LEDGER_KEY",
  "FAKE_OBJECT_FILE",
  "FAKE_OBJECT_KEY",
  "FAKE_OBJECT_MODE",
  "FAKE_OWNER_RUN_FILE",
  "FAKE_OWNER_RUN_ID",
  "FAKE_OWNER_RUN_ATTEMPT",
  "FAKE_PUT_COUNTER",
  "FAKE_S3_REVISION",
  "FAKE_S3_STATE",
  "FAKE_SOURCE_RUN_FILE",
  "FAKE_SOURCE_RUN_ID",
  "FAKE_SOURCE_RUN_ATTEMPT",
  "GH_TOKEN",
  "GITHUB_REPOSITORY",
  "RECOVERY_ENVIRONMENT",
  "RECOVERY_CONTROL_PROOF_BUCKET",
  "RECOVERY_CONTROL_PROOF_KEY",
  "RECOVERY_CONTROL_PROOF_SHA256",
  "RECOVERY_CONTROL_PROOF_VERSION_ID",
  "RECOVERY_EXPECTED_LEDGER_ETAG",
  "RECOVERY_EXPECTED_LEDGER_LEASE_UNTIL",
  "RECOVERY_EXPECTED_LEDGER_SHA256",
  "RECOVERY_EXPECTED_LEDGER_UPDATED_AT",
  "RECOVERY_EXPECTED_LEDGER_VERSION_ID",
  "RECOVERY_INTENT_ID",
  "RECOVERY_LEASE_OWNER",
  "RECOVERY_PREVIOUS_LEASE_OWNER",
  "RECOVERY_PREVIOUS_OWNER_PROVED_DEAD",
  "RECOVERY_RECEIPT_BUCKET",
  "RECOVERY_RECEIPT_KEY",
  "RECOVERY_RECEIPT_SHA256",
  "RECOVERY_RECEIPT_VERSION_ID",
  "TERMINAL_JOB_NAME",
] as const;

interface WatchdogFixture {
  awsCallLog: string;
  env: NodeJS.ProcessEnv;
  fixture: string;
  ghCallLog: string;
  stateFile: string;
}

function executable(path: string, content: string): void {
  writeFileSync(path, content, "utf8");
  chmodSync(path, 0o755);
}

function isolatedEnv(
  overrides: Record<string, string>
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of CONTROLLED_ENV_KEYS) {
    delete env[key];
  }
  return Object.assign(env, overrides);
}

function runBash(
  script: string,
  args: string[],
  env: NodeJS.ProcessEnv
): SpawnSyncReturns<string> {
  return spawnSync("bash", [script, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env,
  });
}

function assertSucceeded(result: SpawnSyncReturns<string>): void {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function assertFailed(result: SpawnSyncReturns<string>): void {
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0, result.stdout);
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value)}\n`, "utf8");
}

function recoveryLedger(
  state: "ARMED" | "RECOVERING",
  environment: "staging" | "production" = ENVIRONMENT
): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    archiveBucket: ARTIFACT_BUCKET,
    archiveKey:
      `candidates/recovery/${environment}/${INTENT_ID}.tar`,
    archiveSha256: "c".repeat(64),
    archiveVersionId: "archive-version-1",
    candidateSha: CANDIDATE_SHA,
    controlProofBucket: null,
    controlProofKey: null,
    controlProofSha256: null,
    controlProofVersionId: null,
    environment,
    intentId: INTENT_ID,
    leaseOwner:
      state === "RECOVERING"
        ? `watchdog-${OWNER_RUN_ID}-${OWNER_RUN_ATTEMPT}-${environment}`
        : null,
    leaseUntil: state === "RECOVERING" ? now + 7_200 : null,
    manifestSha256: "d".repeat(64),
    previousLedgerEtag:
      state === "RECOVERING" ? `"${"e".repeat(32)}"` : null,
    previousLedgerSha256:
      state === "RECOVERING" ? "f".repeat(64) : null,
    previousLedgerVersionId:
      state === "RECOVERING" ? "ledger-version-0" : null,
    receiptBucket: null,
    receiptKey: null,
    receiptSha256: null,
    receiptVersionId: null,
    schema: "archon.recovery-intent.ledger",
    sourceCiRunAttempt: "2",
    sourceCiRunId: "7001",
    sourceRunAttempt: SOURCE_RUN_ATTEMPT,
    sourceRunId: SOURCE_RUN_ID,
    state,
    updatedAt: now,
    version: 1,
  };
}

function sourceRun(path: string): Record<string, unknown> {
  return {
    conclusion: "failure",
    event: "workflow_run",
    head_branch: "main",
    head_repository: { full_name: REPOSITORY },
    head_sha: CANDIDATE_SHA,
    id: Number(SOURCE_RUN_ID),
    name: "Deploy AWS",
    path,
    repository: { full_name: REPOSITORY },
    run_attempt: Number(SOURCE_RUN_ATTEMPT),
    status: "completed",
    workflow_id: 71,
  };
}

function ownerRun(
  path: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    conclusion: "failure",
    event: "schedule",
    head_branch: "main",
    head_repository: { full_name: REPOSITORY },
    id: Number(OWNER_RUN_ID),
    name: "Recover AWS",
    path,
    repository: { full_name: REPOSITORY },
    run_attempt: Number(OWNER_RUN_ATTEMPT),
    status: "completed",
    workflow_id: 72,
    ...overrides,
  };
}

function terminalJobs(jobName = TERMINAL_JOB_NAME): Record<string, unknown> {
  return {
    jobs: [
      {
        conclusion: "timed_out",
        name: jobName,
        status: "completed",
      },
    ],
  };
}

function createWatchdogFixture(
  ledger: Record<string, unknown>,
  owner: Record<string, unknown> = ownerRun(
    ".github/workflows/recover-aws.yml"
  ),
  source: Record<string, unknown> = sourceRun(
    ".github/workflows/deploy-aws.yml"
  ),
  environment: "staging" | "production" = ENVIRONMENT,
  terminalJobName = TERMINAL_JOB_NAME
): WatchdogFixture {
  const fixture = mkdtempSync(join(tmpdir(), "archon-watchdog-"));
  const fakeBin = join(fixture, "bin");
  const stateFile = join(fixture, "ledger.json");
  const revisionFile = join(fixture, "revision");
  const awsCallLog = join(fixture, "aws-calls.log");
  const ghCallLog = join(fixture, "gh-calls.log");
  const ownerFile = join(fixture, "owner.json");
  const sourceFile = join(fixture, "source.json");
  const jobsFile = join(fixture, "jobs.json");
  mkdirSync(fakeBin);
  writeJson(stateFile, ledger);
  writeFileSync(revisionFile, "1", "utf8");
  writeFileSync(awsCallLog, "", "utf8");
  writeFileSync(ghCallLog, "", "utf8");
  writeJson(ownerFile, owner);
  writeJson(sourceFile, source);
  writeJson(jobsFile, terminalJobs(terminalJobName));

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
      return 0
    fi
    shift
  done
  return 1
}
test "$1" = "s3api"
test "$(arg_value --bucket "$@")" = "$FAKE_ARTIFACT_BUCKET"
test "$(arg_value --key "$@")" = "$FAKE_LEDGER_KEY"
test "$(arg_value --expected-bucket-owner "$@")" = "$AWS_ACCOUNT_ID"
case "$2" in
  get-object)
    target="\${!#}"
    cp -- "$FAKE_S3_STATE" "$target"
    revision="$(cat "$FAKE_S3_REVISION")"
    etag="$(printf '%032x' "$revision")"
    checksum="$(
      openssl dgst -sha256 -binary "$FAKE_S3_STATE" | base64 -w0
    )"
    bytes="$(wc -c <"$FAKE_S3_STATE")"
    jq -n --arg checksum "$checksum" --arg etag "\\"$etag\\"" \\
      --arg versionId "ledger-version-$revision" \\
      --argjson bytes "$bytes" \\
      '{
        VersionId: $versionId,
        ETag: $etag,
        ChecksumSHA256: $checksum,
        ServerSideEncryption: "AES256",
        ContentLength: $bytes,
        ContentType: "application/json",
        Metadata: {
          environment: env.RECOVERY_ENVIRONMENT,
          kind: "recovery-ledger"
        }
      }'
    ;;
  put-object)
    body="$(arg_value --body "$@")"
    revision="$(cat "$FAKE_S3_REVISION")"
    etag="$(printf '%032x' "$revision")"
    test "$(arg_value --if-match "$@")" = "\\"$etag\\""
    test "$(arg_value --content-type "$@")" = "application/json"
    test "$(arg_value --metadata "$@")" = \\
      "environment=$RECOVERY_ENVIRONMENT,kind=recovery-ledger"
    cp -- "$body" "$FAKE_S3_STATE"
    revision="$((revision + 1))"
    printf '%s' "$revision" >"$FAKE_S3_REVISION"
    checksum="$(
      openssl dgst -sha256 -binary "$FAKE_S3_STATE" | base64 -w0
    )"
    test "$(arg_value --checksum-sha256 "$@")" = "$checksum"
    jq -n --arg checksum "$checksum" \\
      --arg versionId "ledger-version-$revision" \\
      '{
        VersionId: $versionId,
        ChecksumSHA256: $checksum,
        ServerSideEncryption: "AES256"
      }'
    ;;
  *) exit 97 ;;
esac
`
  );

  executable(
    join(fakeBin, "gh"),
    `#!/usr/bin/env bash
set -euo pipefail
test "$#" -eq 2
test "$1" = "api"
endpoint="$2"
printf '%s\\n' "$endpoint" >>"$FAKE_GH_CALL_LOG"
case "$endpoint" in
  "repos/$GITHUB_REPOSITORY/actions/runs/$FAKE_OWNER_RUN_ID/attempts/$FAKE_OWNER_RUN_ATTEMPT")
    cat "$FAKE_OWNER_RUN_FILE"
    ;;
  "repos/$GITHUB_REPOSITORY/actions/runs/$FAKE_SOURCE_RUN_ID/attempts/$FAKE_SOURCE_RUN_ATTEMPT")
    cat "$FAKE_SOURCE_RUN_FILE"
    ;;
  "repos/$GITHUB_REPOSITORY/actions/runs/$FAKE_SOURCE_RUN_ID/attempts/$FAKE_SOURCE_RUN_ATTEMPT/jobs?per_page=100")
    cat "$FAKE_JOBS_FILE"
    ;;
  *)
    echo "Unexpected GitHub API lookup: $endpoint" >&2
    exit 98
    ;;
esac
`
  );

  const env = isolatedEnv({
    APP_NAME,
    AWS_ACCOUNT_ID: ACCOUNT_ID,
    AWS_REGION,
    FAKE_ARTIFACT_BUCKET: ARTIFACT_BUCKET,
    FAKE_AWS_CALL_LOG: awsCallLog,
    FAKE_GH_CALL_LOG: ghCallLog,
    FAKE_JOBS_FILE: jobsFile,
    FAKE_LEDGER_KEY:
      `candidates/recovery/${environment}/ledger.json`,
    FAKE_OWNER_RUN_FILE: ownerFile,
    FAKE_OWNER_RUN_ID: OWNER_RUN_ID,
    FAKE_OWNER_RUN_ATTEMPT: OWNER_RUN_ATTEMPT,
    FAKE_S3_REVISION: revisionFile,
    FAKE_S3_STATE: stateFile,
    FAKE_SOURCE_RUN_FILE: sourceFile,
    FAKE_SOURCE_RUN_ID: SOURCE_RUN_ID,
    FAKE_SOURCE_RUN_ATTEMPT: SOURCE_RUN_ATTEMPT,
    GH_TOKEN: "test-token",
    GITHUB_REPOSITORY: REPOSITORY,
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    RECOVERY_ENVIRONMENT: environment,
    TERMINAL_JOB_NAME: terminalJobName,
  });
  return { awsCallLog, env, fixture, ghCallLog, stateFile };
}

function exactRecoverEnv(run: WatchdogFixture): NodeJS.ProcessEnv {
  const ledger = JSON.parse(
    readFileSync(run.stateFile, "utf8")
  ) as Record<string, unknown>;
  const receiptSha256 = "1".repeat(64);
  const controlProofSha256 = "2".repeat(64);
  return {
    ...run.env,
    RECOVERY_CONTROL_PROOF_BUCKET: ARTIFACT_BUCKET,
    RECOVERY_CONTROL_PROOF_KEY:
      `candidates/recovery/${ENVIRONMENT}/controls/${INTENT_ID}/` +
      `${controlProofSha256}.json`,
    RECOVERY_CONTROL_PROOF_SHA256: controlProofSha256,
    RECOVERY_CONTROL_PROOF_VERSION_ID: "control-version-1",
    RECOVERY_EXPECTED_LEDGER_ETAG:
      `"${(1).toString(16).padStart(32, "0")}"`,
    RECOVERY_EXPECTED_LEDGER_LEASE_UNTIL: String(ledger.leaseUntil),
    RECOVERY_EXPECTED_LEDGER_SHA256: createHash("sha256")
      .update(readFileSync(run.stateFile))
      .digest("hex"),
    RECOVERY_EXPECTED_LEDGER_UPDATED_AT: String(ledger.updatedAt),
    RECOVERY_EXPECTED_LEDGER_VERSION_ID: "ledger-version-1",
    RECOVERY_INTENT_ID: INTENT_ID,
    RECOVERY_LEASE_OWNER: String(ledger.leaseOwner),
    RECOVERY_RECEIPT_BUCKET: ARTIFACT_BUCKET,
    RECOVERY_RECEIPT_KEY:
      `candidates/recovery/${ENVIRONMENT}/receipts/${INTENT_ID}/` +
      `${receiptSha256}.json`,
    RECOVERY_RECEIPT_SHA256: receiptSha256,
    RECOVERY_RECEIPT_VERSION_ID: "receipt-version-1",
  };
}

const DEPLOY_WORKFLOW_PATHS = [
  ".github/workflows/deploy-aws.yml",
  ".github/workflows/deploy-aws.yml@main",
  ".github/workflows/deploy-aws.yml@refs/heads/main",
] as const;

const RECOVERY_WORKFLOW_PATHS = [
  ".github/workflows/recover-aws.yml",
  ".github/workflows/recover-aws.yml@main",
  ".github/workflows/recover-aws.yml@refs/heads/main",
] as const;

const ENVIRONMENT_JOB_CASES = [
  {
    environment: "staging" as const,
    terminalJobName: "Deploy and smoke staging",
  },
  {
    environment: "production" as const,
    terminalJobName: "Promote identical candidate to production",
  },
] as const;

test(
  "classifier accepts every documented Deploy AWS path and only exact run lookups",
  { skip: process.platform === "win32" },
  () => {
    for (const workflowPath of DEPLOY_WORKFLOW_PATHS) {
      const run = createWatchdogFixture(
        recoveryLedger("ARMED"),
        undefined,
        sourceRun(workflowPath)
      );
      try {
        const result = runBash(CLASSIFY_SOURCE, [], run.env);
        assertSucceeded(result);
        const proof = JSON.parse(result.stdout) as Record<
          string,
          unknown
        >;
        assert.equal(proof.action, "recover");
        assert.equal(proof.intentId, INTENT_ID);
        assert.equal(proof.previousLeaseOwner, null);
        assert.equal(proof.previousOwnerProvedDead, false);

        const calls = readFileSync(run.ghCallLog, "utf8")
          .trim()
          .split(/\r?\n/u);
        assert.deepEqual(calls, [
          `repos/${REPOSITORY}/actions/runs/${SOURCE_RUN_ID}` +
            `/attempts/${SOURCE_RUN_ATTEMPT}`,
          `repos/${REPOSITORY}/actions/runs/${SOURCE_RUN_ID}` +
            `/attempts/${SOURCE_RUN_ATTEMPT}/jobs?per_page=100`,
        ]);
        assert.doesNotMatch(
          readFileSync(run.ghCallLog, "utf8"),
          /\/actions\/workflows\//u
        );
      } finally {
        rmSync(run.fixture, { recursive: true, force: true });
      }
    }
  }
);

test(
  "classifier accepts only the exact environment terminal-job tuple",
  { skip: process.platform === "win32" },
  () => {
    for (const { environment, terminalJobName } of ENVIRONMENT_JOB_CASES) {
      const run = createWatchdogFixture(
        recoveryLedger("ARMED", environment),
        undefined,
        undefined,
        environment,
        terminalJobName
      );
      try {
        const result = runBash(CLASSIFY_SOURCE, [], run.env);
        assertSucceeded(result);
        const proof = JSON.parse(result.stdout) as Record<
          string,
          unknown
        >;
        assert.equal(proof.action, "recover");
        assert.equal(proof.environment, environment);
      } finally {
        rmSync(run.fixture, { recursive: true, force: true });
      }
    }

    const invalidPairs = [
      {
        environment: "staging" as const,
        terminalJobName: "Promote identical candidate to production",
      },
      {
        environment: "production" as const,
        terminalJobName: "Deploy and smoke staging",
      },
      {
        environment: "staging" as const,
        terminalJobName: "Deploy staging",
      },
      {
        environment: "production" as const,
        terminalJobName: "Deploy and smoke production",
      },
    ];
    for (const { environment, terminalJobName } of invalidPairs) {
      const exactTerminalJobName =
        environment === "staging"
          ? "Deploy and smoke staging"
          : "Promote identical candidate to production";
      const run = createWatchdogFixture(
        recoveryLedger("ARMED", environment),
        undefined,
        undefined,
        environment,
        exactTerminalJobName
      );
      try {
        const result = runBash(CLASSIFY_SOURCE, [], {
          ...run.env,
          TERMINAL_JOB_NAME: terminalJobName,
        });
        assertFailed(result);
        assert.equal(readFileSync(run.awsCallLog, "utf8"), "");
        assert.equal(readFileSync(run.ghCallLog, "utf8"), "");
      } finally {
        rmSync(run.fixture, { recursive: true, force: true });
      }
    }
  }
);

test(
  "active exact prior watchdog owner causes a noop without source lookup",
  { skip: process.platform === "win32" },
  () => {
    const run = createWatchdogFixture(
      recoveryLedger("RECOVERING"),
      ownerRun(".github/workflows/recover-aws.yml@main", {
        conclusion: null,
        status: "in_progress",
      })
    );
    try {
      const result = runBash(CLASSIFY_SOURCE, [], {
        ...run.env,
        RECOVERY_LEASE_OWNER: NEXT_OWNER,
      });
      assertSucceeded(result);
      const proof = JSON.parse(result.stdout) as Record<
        string,
        unknown
      >;
      assert.equal(proof.action, "noop");
      assert.equal(proof.reason, "active-recovery-lease");
      assert.equal(proof.ledgerState, "RECOVERING");
      assert.deepEqual(
        readFileSync(run.ghCallLog, "utf8").trim().split(/\r?\n/u),
        [
          `repos/${REPOSITORY}/actions/runs/${OWNER_RUN_ID}` +
            `/attempts/${OWNER_RUN_ATTEMPT}`,
        ]
      );
    } finally {
      rmSync(run.fixture, { recursive: true, force: true });
    }
  }
);

test(
  "failed exact prior watchdog owner is proved dead for every documented path",
  { skip: process.platform === "win32" },
  () => {
    for (const workflowPath of RECOVERY_WORKFLOW_PATHS) {
      const run = createWatchdogFixture(
        recoveryLedger("RECOVERING"),
        ownerRun(workflowPath)
      );
      try {
        const result = runBash(CLASSIFY_SOURCE, [], {
          ...run.env,
          RECOVERY_LEASE_OWNER: NEXT_OWNER,
        });
        assertSucceeded(result);
        const proof = JSON.parse(result.stdout) as Record<
          string,
          unknown
        >;
        assert.equal(proof.action, "recover");
        assert.equal(proof.previousOwnerProvedDead, true);
        assert.equal(proof.previousLeaseOwner, PRIOR_OWNER);
        assert.equal(proof.sourceRunId, SOURCE_RUN_ID);
        assert.equal(proof.sourceRunAttempt, SOURCE_RUN_ATTEMPT);
      } finally {
        rmSync(run.fixture, { recursive: true, force: true });
      }
    }
  }
);

test(
  "classifier rejects mismatched or successful prior watchdog owners",
  { skip: process.platform === "win32" },
  () => {
    const invalidOwners = [
      ownerRun(".github/workflows/not-recovery.yml"),
      ownerRun(".github/workflows/recover-aws.yml", {
        repository: { full_name: "attacker/fork" },
      }),
      ownerRun(".github/workflows/recover-aws.yml", {
        conclusion: "success",
      }),
    ];
    for (const invalidOwner of invalidOwners) {
      const run = createWatchdogFixture(
        recoveryLedger("RECOVERING"),
        invalidOwner
      );
      try {
        const result = runBash(CLASSIFY_SOURCE, [], {
          ...run.env,
          RECOVERY_LEASE_OWNER: NEXT_OWNER,
        });
        assertFailed(result);
        assert.equal(
          readFileSync(run.ghCallLog, "utf8")
            .trim()
            .split(/\r?\n/u).length,
          1
        );
      } finally {
        rmSync(run.fixture, { recursive: true, force: true });
      }
    }
  }
);

test(
  "ledger only permits an active takeover for the exact proved-dead owner",
  { skip: process.platform === "win32" },
  () => {
    const run = createWatchdogFixture(recoveryLedger("RECOVERING"));
    const claimEnv = {
      ...run.env,
      RECOVERY_INTENT_ID: INTENT_ID,
      RECOVERY_LEASE_OWNER: NEXT_OWNER,
    };
    try {
      const withoutProof = runBash(
        RECOVERY_LEDGER,
        ["claim"],
        claimEnv
      );
      assertFailed(withoutProof);

      const mismatchedProof = runBash(
        RECOVERY_LEDGER,
        ["claim"],
        {
          ...claimEnv,
          RECOVERY_PREVIOUS_LEASE_OWNER:
            "watchdog-9002-1-staging",
          RECOVERY_PREVIOUS_OWNER_PROVED_DEAD: "true",
        }
      );
      assertFailed(mismatchedProof);
      assert.equal(
        (JSON.parse(readFileSync(run.stateFile, "utf8")) as {
          leaseOwner: string;
        }).leaseOwner,
        PRIOR_OWNER
      );
      assert.doesNotMatch(
        readFileSync(run.awsCallLog, "utf8"),
        /s3api put-object/u
      );

      const exactProof = runBash(
        RECOVERY_LEDGER,
        ["claim"],
        {
          ...claimEnv,
          RECOVERY_PREVIOUS_LEASE_OWNER: PRIOR_OWNER,
          RECOVERY_PREVIOUS_OWNER_PROVED_DEAD: "true",
        }
      );
      assertSucceeded(exactProof);
      const claimed = JSON.parse(exactProof.stdout) as Record<
        string,
        unknown
      >;
      assert.equal(claimed.state, "RECOVERING");
      assert.equal(claimed.leaseOwner, NEXT_OWNER);
      assert.equal(
        (
          readFileSync(run.awsCallLog, "utf8").match(
            /s3api put-object/gu
          ) ?? []
        ).length,
        1
      );
    } finally {
      rmSync(run.fixture, { recursive: true, force: true });
    }
  }
);

test(
  "RECOVERED CAS requires the exact current RECOVERING tuple",
  { skip: process.platform === "win32" },
  () => {
    const run = createWatchdogFixture(recoveryLedger("RECOVERING"));
    try {
      const exact = exactRecoverEnv(run);
      const updatedAt = Number(exact.RECOVERY_EXPECTED_LEDGER_UPDATED_AT);
      const leaseUntil = Number(
        exact.RECOVERY_EXPECTED_LEDGER_LEASE_UNTIL
      );
      const mismatches: Array<[string, string]> = [
        ["RECOVERY_EXPECTED_LEDGER_ETAG", `"${"0".repeat(32)}"`],
        ["RECOVERY_EXPECTED_LEDGER_SHA256", "0".repeat(64)],
        [
          "RECOVERY_EXPECTED_LEDGER_VERSION_ID",
          "ledger-version-stale",
        ],
        [
          "RECOVERY_EXPECTED_LEDGER_UPDATED_AT",
          String(updatedAt + 1),
        ],
        [
          "RECOVERY_EXPECTED_LEDGER_LEASE_UNTIL",
          String(leaseUntil - 1),
        ],
      ];
      for (const [name, value] of mismatches) {
        const result = runBash(RECOVERY_LEDGER, ["recover"], {
          ...exact,
          [name]: value,
        });
        assertFailed(result);
      }
      const controlMismatches: Array<[string, string]> = [
        ["RECOVERY_CONTROL_PROOF_BUCKET", `wrong-${ARTIFACT_BUCKET}`],
        [
          "RECOVERY_CONTROL_PROOF_KEY",
          `candidates/recovery/${ENVIRONMENT}/controls/${INTENT_ID}/` +
            `${"3".repeat(64)}.json`,
        ],
        ["RECOVERY_CONTROL_PROOF_SHA256", "3".repeat(64)],
        ["RECOVERY_CONTROL_PROOF_VERSION_ID", "null"],
      ];
      for (const [name, value] of controlMismatches) {
        const result = runBash(RECOVERY_LEDGER, ["recover"], {
          ...exact,
          [name]: value,
        });
        assertFailed(result);
      }
      assert.doesNotMatch(
        readFileSync(run.awsCallLog, "utf8"),
        /s3api put-object/u
      );

      const recovered = runBash(RECOVERY_LEDGER, ["recover"], exact);
      assertSucceeded(recovered);
      const terminal = JSON.parse(recovered.stdout) as Record<
        string,
        unknown
      >;
      assert.equal(terminal.state, "RECOVERED");
      assert.equal(
        terminal.previousLedgerEtag,
        exact.RECOVERY_EXPECTED_LEDGER_ETAG
      );
      assert.equal(
        terminal.previousLedgerSha256,
        exact.RECOVERY_EXPECTED_LEDGER_SHA256
      );
      assert.equal(
        terminal.previousLedgerVersionId,
        exact.RECOVERY_EXPECTED_LEDGER_VERSION_ID
      );
      assert.equal(
        terminal.controlProofBucket,
        exact.RECOVERY_CONTROL_PROOF_BUCKET
      );
      assert.equal(
        terminal.controlProofKey,
        exact.RECOVERY_CONTROL_PROOF_KEY
      );
      assert.equal(
        terminal.controlProofSha256,
        exact.RECOVERY_CONTROL_PROOF_SHA256
      );
      assert.equal(
        terminal.controlProofVersionId,
        exact.RECOVERY_CONTROL_PROOF_VERSION_ID
      );
      assert.equal(
        (
          readFileSync(run.awsCallLog, "utf8").match(
            /s3api put-object/gu
          ) ?? []
        ).length,
        1
      );
    } finally {
      rmSync(run.fixture, { recursive: true, force: true });
    }
  }
);

test(
  "RECOVERED CAS rejects an expired exact lease without mutation",
  { skip: process.platform === "win32" },
  () => {
    const ledger = recoveryLedger("RECOVERING");
    const now = Math.floor(Date.now() / 1000);
    ledger.updatedAt = now - 120;
    ledger.leaseUntil = now - 60;
    const run = createWatchdogFixture(ledger);
    try {
      const result = runBash(
        RECOVERY_LEDGER,
        ["recover"],
        exactRecoverEnv(run)
      );
      assertFailed(result);
      assert.equal(
        (
          JSON.parse(readFileSync(run.stateFile, "utf8")) as {
            state: string;
          }
        ).state,
        "RECOVERING"
      );
      assert.doesNotMatch(
        readFileSync(run.awsCallLog, "utf8"),
        /s3api put-object/u
      );
    } finally {
      rmSync(run.fixture, { recursive: true, force: true });
    }
  }
);

test(
  "ledger reads reject JSON streams before any mutation",
  { skip: process.platform === "win32" },
  () => {
    const run = createWatchdogFixture(recoveryLedger("RECOVERING"));
    try {
      const ledgerJson = readFileSync(run.stateFile, "utf8");
      writeFileSync(run.stateFile, `${ledgerJson}${ledgerJson}`, "utf8");
      const result = runBash(RECOVERY_LEDGER, ["read"], run.env);
      assertFailed(result);
      assert.match(
        result.stderr,
        /must contain exactly one JSON object/u
      );
      assert.doesNotMatch(
        readFileSync(run.awsCallLog, "utf8"),
        /s3api put-object/u
      );
    } finally {
      rmSync(run.fixture, { recursive: true, force: true });
    }
  }
);

interface ObjectFixture {
  callLog: string;
  env: NodeJS.ProcessEnv;
  fixture: string;
  objectFile: string;
  objectKey: string;
}

function createObjectFixture(
  mode: "head-success" | "retry-success"
): ObjectFixture {
  const fixture = mkdtempSync(join(tmpdir(), "archon-recovery-put-"));
  const fakeBin = join(fixture, "bin");
  const callLog = join(fixture, "aws-calls.log");
  const counter = join(fixture, "put-counter");
  const objectFile = join(fixture, "intent.tar");
  const objectKey =
    `candidates/recovery/${ENVIRONMENT}/${INTENT_ID}.tar`;
  mkdirSync(fakeBin);
  writeFileSync(callLog, "", "utf8");
  writeFileSync(counter, "0", "utf8");
  writeFileSync(objectFile, "immutable recovery fixture\n", "utf8");

  executable(
    join(fakeBin, "sleep"),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'sleep %s\\n' "$*" >>"$FAKE_AWS_CALL_LOG"
`
  );
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
      return 0
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
test "$1" = "s3api"
test "$(arg_value --bucket "$@")" = "$FAKE_ARTIFACT_BUCKET"
test "$(arg_value --key "$@")" = "$FAKE_OBJECT_KEY"
test "$(arg_value --expected-bucket-owner "$@")" = "$AWS_ACCOUNT_ID"
checksum="$(
  openssl dgst -sha256 -binary "$FAKE_OBJECT_FILE" | base64 -w0
)"
bytes="$(wc -c <"$FAKE_OBJECT_FILE")"
case "$2" in
  put-object)
    count="$(cat "$FAKE_PUT_COUNTER")"
    count="$((count + 1))"
    printf '%s' "$count" >"$FAKE_PUT_COUNTER"
    test "$(arg_value --body "$@")" = "$FAKE_OBJECT_FILE"
    test "$(arg_value --if-none-match "$@")" = "*"
    test "$(arg_value --checksum-sha256 "$@")" = "$checksum"
    test "$(arg_value --content-type "$@")" = "application/x-tar"
    test "$(arg_value --metadata "$@")" = \\
      "environment=staging,intent-id=$RECOVERY_INTENT_ID,kind=intent"
    if [ "$FAKE_OBJECT_MODE" = "head-success" ] ||
       [ "$count" -eq 1 ]; then
      echo "ConditionalRequestConflict: status code: 409" >&2
      exit 255
    fi
    jq -n --arg checksum "$checksum" '{
      VersionId: "object-version-1",
      ChecksumSHA256: $checksum,
      ServerSideEncryption: "AES256"
    }'
    ;;
  head-object)
    if [ "$FAKE_OBJECT_MODE" = "retry-success" ] &&
       [ "$(cat "$FAKE_PUT_COUNTER")" -eq 1 ] &&
       ! has_arg --version-id "$@"; then
      echo "Not Found (404)" >&2
      exit 254
    fi
    if has_arg --version-id "$@"; then
      test "$(arg_value --version-id "$@")" = "object-version-1"
    fi
    jq -n --arg checksum "$checksum" --argjson bytes "$bytes" '{
      VersionId: "object-version-1",
      ChecksumSHA256: $checksum,
      ServerSideEncryption: "AES256",
      ContentLength: $bytes,
      ContentType: "application/x-tar",
      Metadata: {
        environment: "staging",
        "intent-id": $ENV.RECOVERY_INTENT_ID,
        kind: "intent"
      }
    }'
    ;;
  *) exit 97 ;;
esac
`
  );

  return {
    callLog,
    env: isolatedEnv({
      APP_NAME,
      AWS_ACCOUNT_ID: ACCOUNT_ID,
      AWS_REGION,
      FAKE_ARTIFACT_BUCKET: ARTIFACT_BUCKET,
      FAKE_AWS_CALL_LOG: callLog,
      FAKE_OBJECT_FILE: objectFile,
      FAKE_OBJECT_KEY: objectKey,
      FAKE_OBJECT_MODE: mode,
      FAKE_PUT_COUNTER: counter,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      RECOVERY_ENVIRONMENT: ENVIRONMENT,
      RECOVERY_INTENT_ID: INTENT_ID,
    }),
    fixture,
    objectFile,
    objectKey,
  };
}

for (const objectCase of [
  {
    expectedPuts: 1,
    expectedSleep: false,
    mode: "head-success" as const,
    name: "accepts an exact HEAD after an ambiguous S3 409",
  },
  {
    expectedPuts: 2,
    expectedSleep: true,
    mode: "retry-success" as const,
    name: "retries a 409 with no visible object and then succeeds",
  },
]) {
  test(
    objectCase.name,
    { skip: process.platform === "win32" },
    () => {
      const run = createObjectFixture(objectCase.mode);
      try {
        const result = runBash(
          PUT_RECOVERY_OBJECT,
          [run.objectFile, run.objectKey],
          run.env
        );
        assertSucceeded(result);
        const proof = JSON.parse(result.stdout) as Record<
          string,
          unknown
        >;
        assert.equal(proof.ok, true);
        assert.equal(proof.intentId, INTENT_ID);
        assert.equal(proof.key, run.objectKey);
        assert.equal(proof.versionId, "object-version-1");
        assert.equal(
          proof.sha256,
          createHash("sha256")
            .update(readFileSync(run.objectFile))
            .digest("hex")
        );

        const calls = readFileSync(run.callLog, "utf8");
        assert.equal(
          (calls.match(/s3api put-object/gu) ?? []).length,
          objectCase.expectedPuts
        );
        assert.equal(
          (calls.match(/s3api head-object/gu) ?? []).length,
          2
        );
        assert.equal(
          calls.includes("sleep 1"),
          objectCase.expectedSleep
        );
      } finally {
        rmSync(run.fixture, { recursive: true, force: true });
      }
    }
  );
}
