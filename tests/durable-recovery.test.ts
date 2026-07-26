import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CREATE_BUNDLE = join(
  ROOT,
  "aws",
  "create-durable-recovery-bundle.sh"
);
const EXTRACT_BUNDLE = join(
  ROOT,
  "aws",
  "extract-durable-recovery-bundle.sh"
);
const VERIFY_BUNDLE = join(
  ROOT,
  "aws",
  "verify-durable-recovery-bundle.sh"
);
const PROVE_SNAPSHOT = join(ROOT, "aws", "prove-recovery-snapshot.sh");
const RECOVERY_LEDGER = join(ROOT, "aws", "recovery-intent-ledger.sh");
const RECOVER_ENVIRONMENT = join(
  ROOT,
  "aws",
  "recover-durable-environment.sh"
);
const VERIFY_RECEIPT = join(
  ROOT,
  "aws",
  "verify-durable-recovery-receipt.sh"
);
const FINALIZE_RECEIPT = join(
  ROOT,
  "aws",
  "finalize-durable-recovery-receipt.sh"
);
const RECOVERY_WORKFLOW = join(
  ROOT,
  ".github",
  "workflows",
  "recover-aws.yml"
);
const CLEANUP_SCRIPT = join(ROOT, "aws", "delete-greenfield-stack.sh");
const RESTORE_SCRIPT = join(
  ROOT,
  "aws",
  "restore-cloudformation-stack.sh"
);
const RECOVERY_TEST_SOURCE = join(
  ROOT,
  "tests",
  "aws-recovery-scripts.test.ts"
);

const APP_NAME = "archon-memory";
const ACCOUNT_ID = "123456789012";
const AWS_REGION = "eu-west-1";
const ENVIRONMENT = "staging";
const STACK_NAME = `${APP_NAME}-${ENVIRONMENT}`;
const ARTIFACT_BUCKET =
  `${APP_NAME}-artifacts-${ACCOUNT_ID}-${AWS_REGION}`;
const EXECUTION_ROLE_ARN =
  `arn:aws:iam::${ACCOUNT_ID}:role/archon-cloudformation`;
const CANDIDATE_SHA = "a".repeat(40);
const SOURCE_CI_RUN_ID = "7001";
const SOURCE_CI_RUN_ATTEMPT = "2";
const SOURCE_DEPLOY_RUN_ID = "8001";
const SOURCE_DEPLOY_RUN_ATTEMPT = "3";
const REPOSITORY = "upgradedev/archon-cockroach-memory";

const LEDGER_SCHEMA_KEYS = [
  "archiveBucket",
  "archiveKey",
  "archiveSha256",
  "archiveVersionId",
  "candidateSha",
  "controlProofBucket",
  "controlProofKey",
  "controlProofSha256",
  "controlProofVersionId",
  "environment",
  "intentId",
  "leaseOwner",
  "leaseUntil",
  "manifestSha256",
  "previousLedgerEtag",
  "previousLedgerSha256",
  "previousLedgerVersionId",
  "receiptBucket",
  "receiptKey",
  "receiptSha256",
  "receiptVersionId",
  "schema",
  "sourceCiRunAttempt",
  "sourceCiRunId",
  "sourceRunAttempt",
  "sourceRunId",
  "state",
  "updatedAt",
  "version",
] as const;

const RECOVERY_ENV_KEYS = [
  "APPLICATION_S3_ACCESS_LOGGING_PREFLIGHT_FILE",
  "ARTIFACT_BUCKET",
  "CANDIDATE_SHA",
  "ENVIRONMENT",
  "EXPECTED_ARCHIVE_SHA256",
  "EXPECTED_CANDIDATE_SHA",
  "EXPECTED_GREENFIELD_OWNER",
  "EXPECTED_INTENT_ID",
  "EXPECTED_MANIFEST_SHA256",
  "EXPECTED_PARAMETERS_SHA256",
  "EXPECTED_PREFLIGHT_SHA256",
  "EXPECTED_PREVIOUS_RELEASE_SHA256",
  "EXPECTED_RECOVERY_RECEIPT_SHA256",
  "EXPECTED_SOURCE_CI_RUN_ATTEMPT",
  "EXPECTED_SOURCE_CI_RUN_ID",
  "EXPECTED_SOURCE_DEPLOY_RUN_ATTEMPT",
  "EXPECTED_SOURCE_DEPLOY_RUN_ID",
  "EXPECTED_STACK_STATE",
  "EXPECTED_TAGS_SHA256",
  "EXPECTED_TEMPLATE_SHA256",
  "GITHUB_REPOSITORY",
  "GITHUB_WORKFLOW_REF",
  "HAS_PREVIOUS_STACK",
  "PREVIOUS_APPLICATION_URL",
  "PREVIOUS_BUCKET_NAME",
  "PREVIOUS_DISTRIBUTION_ID",
  "PREVIOUS_FUNCTION_NAME",
  "PREVIOUS_FUNCTION_VERSION",
  "PREVIOUS_STACK_ID",
  "PREVIOUS_STACK_PARAMETERS_FILE",
  "PREVIOUS_STACK_REVISION",
  "PREVIOUS_STACK_STATUS",
  "PREVIOUS_STACK_TAGS_FILE",
  "PREVIOUS_STACK_TEMPLATE_FILE",
  "RECOVERY_ENVIRONMENT",
  "RECOVERY_ARCHIVE_BUCKET",
  "RECOVERY_ARCHIVE_KEY",
  "RECOVERY_ARCHIVE_SHA256",
  "RECOVERY_ARCHIVE_VERSION_ID",
  "RECOVERY_EXPECTED_LEDGER_ETAG",
  "RECOVERY_EXPECTED_LEDGER_LEASE_UNTIL",
  "RECOVERY_EXPECTED_LEDGER_SHA256",
  "RECOVERY_EXPECTED_LEDGER_UPDATED_AT",
  "RECOVERY_EXPECTED_LEDGER_VERSION_ID",
  "RECOVERY_INTENT_ID",
  "RECOVERY_CODE_SHA",
  "RECOVERY_CONTROL_PROOF_BUCKET",
  "RECOVERY_CONTROL_PROOF_KEY",
  "RECOVERY_CONTROL_PROOF_SHA256",
  "RECOVERY_CONTROL_PROOF_VERSION_ID",
  "RECOVERY_EXECUTION_ID",
  "RECOVERY_LEDGER_FILE",
  "RECOVERY_LEASE_OWNER",
  "RECOVERY_MANIFEST_SHA256",
  "RECOVERY_MANIFEST_FILE",
  "RECOVERY_RECEIPT_BUCKET",
  "RECOVERY_RECEIPT_KEY",
  "RECOVERY_RECEIPT_SHA256",
  "RECOVERY_RECEIPT_VERSION_ID",
  "RECOVERY_SNAPSHOT_PROOF_FILE",
  "SOURCE_CI_RUN_ATTEMPT",
  "SOURCE_CI_RUN_ID",
  "SOURCE_DEPLOY_RUN_ATTEMPT",
  "SOURCE_DEPLOY_RUN_ID",
  "STACK_NAME",
  "STACK_STATE",
] as const;

interface SnapshotProof {
  greenfieldOwner: string;
  manifestSha256: string;
}

interface BundleProof {
  archiveSha256: string;
  intentId: string;
  manifestSha256: string;
}

interface DurableFixture {
  archive: string;
  bundleProof: BundleProof;
  extracted: string;
  fixture: string;
  verificationEnv: NodeJS.ProcessEnv;
}

function isolatedEnv(
  overrides: Record<string, string>
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of RECOVERY_ENV_KEYS) {
    delete env[key];
  }
  return Object.assign(env, overrides);
}

function runBash(
  script: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv
): SpawnSyncReturns<string> {
  return spawnSync("bash", [script, ...args], {
    cwd,
    encoding: "utf8",
    env,
  });
}

function assertSucceeded(result: SpawnSyncReturns<string>): void {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function executable(path: string, content: string): void {
  writeFileSync(path, content, "utf8");
  chmodSync(path, 0o755);
}

function sha256Buffer(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(path: string): string {
  return sha256Buffer(readFileSync(path));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0
        )
        .map(([key, child]) => [key, sortJson(child)])
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function writeCanonicalJson(path: string, value: unknown): void {
  writeFileSync(path, `${canonicalJson(value)}\n`, "utf8");
}

function createPreflightReceipt(path: string): void {
  const payload = {
    destinationBucket:
      `${APP_NAME}-s3-access-logs-${ACCOUNT_ID}-${AWS_REGION}`,
    environment: ENVIRONMENT,
    evidence: "live-control-plane",
    expected: {
      LoggingEnabled: {
        TargetBucket:
          `${APP_NAME}-s3-access-logs-${ACCOUNT_ID}-${AWS_REGION}`,
        TargetObjectKeyFormat: {
          PartitionedPrefix: {
            PartitionDateSource: "EventTime",
          },
        },
        TargetPrefix: `${ENVIRONMENT}-web/`,
      },
    },
    foundationVerified: true,
    mode: "preflight",
    ok: true,
    priorState: "absent",
    schema: "archon.application-s3-access-logging.preflight",
    sourceBucket:
      `${APP_NAME}-${ENVIRONMENT}-web-${ACCOUNT_ID}-${AWS_REGION}`,
    version: 1,
  };
  const receipt = {
    ...payload,
    integrity: {
      algorithm: "sha256",
      canonicalization: "jq-cS-v1",
      payloadSha256: sha256Buffer(canonicalJson(payload)),
    },
  };
  writeCanonicalJson(path, receipt);
}

function makeFixture(): string {
  const fixture = mkdtempSync(join(tmpdir(), "archon-durable-recovery-"));
  symlinkSync(join(ROOT, "aws"), join(fixture, "aws"), "dir");
  return fixture;
}

function createDurableFixture(): DurableFixture {
  const fixture = makeFixture();
  const preflight = join(fixture, "application-s3-preflight.json");
  const snapshotProofFile = join(fixture, "recovery-snapshot-proof.json");
  const archive = join(fixture, "recovery-intent.tar");
  const extracted = join(fixture, "extracted");
  const missingTemplate = join(fixture, "no-previous-template");
  const missingParameters = join(fixture, "no-previous-parameters");
  const missingTags = join(fixture, "no-previous-tags");

  createPreflightReceipt(preflight);
  const common = {
    APP_NAME,
    AWS_ACCOUNT_ID: ACCOUNT_ID,
    AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN: EXECUTION_ROLE_ARN,
    AWS_REGION,
    CANDIDATE_SHA,
    ENVIRONMENT,
    GITHUB_REPOSITORY: REPOSITORY,
    HAS_PREVIOUS_STACK: "false",
    PREVIOUS_STACK_PARAMETERS_FILE: missingParameters,
    PREVIOUS_STACK_TAGS_FILE: missingTags,
    PREVIOUS_STACK_TEMPLATE_FILE: missingTemplate,
    SOURCE_DEPLOY_RUN_ATTEMPT,
    SOURCE_DEPLOY_RUN_ID,
    STACK_NAME,
    STACK_STATE: "greenfield",
  };
  const snapshotResult = runBash(
    PROVE_SNAPSHOT,
    [],
    fixture,
    isolatedEnv(common)
  );
  assertSucceeded(snapshotResult);
  const snapshotProof = JSON.parse(snapshotResult.stdout) as SnapshotProof;
  assert.match(snapshotProof.greenfieldOwner, /^[0-9a-f]{64}$/u);
  assert.match(snapshotProof.manifestSha256, /^[0-9a-f]{64}$/u);
  writeFileSync(snapshotProofFile, snapshotResult.stdout, "utf8");

  const createResult = runBash(
    CREATE_BUNDLE,
    [archive],
    fixture,
    isolatedEnv({
      ...common,
      APPLICATION_S3_ACCESS_LOGGING_PREFLIGHT_FILE: preflight,
      ARTIFACT_BUCKET,
      EXPECTED_GREENFIELD_OWNER: snapshotProof.greenfieldOwner,
      EXPECTED_PREFLIGHT_SHA256: sha256File(preflight),
      EXPECTED_PREVIOUS_RELEASE_SHA256:
        snapshotProof.manifestSha256,
      RECOVERY_SNAPSHOT_PROOF_FILE: snapshotProofFile,
      SOURCE_CI_RUN_ATTEMPT,
      SOURCE_CI_RUN_ID,
    })
  );
  assertSucceeded(createResult);
  const bundleProof = JSON.parse(createResult.stdout) as BundleProof;
  assert.match(bundleProof.archiveSha256, /^[0-9a-f]{64}$/u);
  assert.match(bundleProof.intentId, /^[0-9a-f]{64}$/u);
  assert.match(bundleProof.manifestSha256, /^[0-9a-f]{64}$/u);
  assert.equal(sha256File(archive), bundleProof.archiveSha256);

  const verificationEnv = isolatedEnv({
    APP_NAME,
    AWS_ACCOUNT_ID: ACCOUNT_ID,
    AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN: EXECUTION_ROLE_ARN,
    AWS_REGION,
    EXPECTED_ARCHIVE_SHA256: bundleProof.archiveSha256,
    EXPECTED_CANDIDATE_SHA: CANDIDATE_SHA,
    EXPECTED_INTENT_ID: bundleProof.intentId,
    EXPECTED_MANIFEST_SHA256: bundleProof.manifestSha256,
    EXPECTED_SOURCE_CI_RUN_ATTEMPT: SOURCE_CI_RUN_ATTEMPT,
    EXPECTED_SOURCE_CI_RUN_ID: SOURCE_CI_RUN_ID,
    EXPECTED_SOURCE_DEPLOY_RUN_ATTEMPT: SOURCE_DEPLOY_RUN_ATTEMPT,
    EXPECTED_SOURCE_DEPLOY_RUN_ID: SOURCE_DEPLOY_RUN_ID,
    GITHUB_REPOSITORY: REPOSITORY,
    RECOVERY_ENVIRONMENT: ENVIRONMENT,
    STACK_NAME,
  });
  const extractResult = runBash(
    EXTRACT_BUNDLE,
    [archive, extracted],
    fixture,
    verificationEnv
  );
  assertSucceeded(extractResult);
  assert.deepEqual(JSON.parse(extractResult.stdout), {
    environment: ENVIRONMENT,
    intentId: bundleProof.intentId,
    manifestSha256: bundleProof.manifestSha256,
    ok: true,
    schema: "archon.durable-recovery-bundle.validation",
    version: 1,
  });

  return {
    archive,
    bundleProof,
    extracted,
    fixture,
    verificationEnv,
  };
}

function updateManifestComponentDigest(
  bundleDir: string,
  relativePath: string
): string {
  const manifestPath = join(bundleDir, "recovery-intent.json");
  const manifest = JSON.parse(
    readFileSync(manifestPath, "utf8")
  ) as {
    files: Array<{ bytes: number; path: string; sha256: string }>;
  };
  const entry = manifest.files.find(
    (candidate) => candidate.path === relativePath
  );
  assert.ok(entry, `Missing manifest entry for ${relativePath}`);
  const componentPath = join(bundleDir, relativePath);
  entry.bytes = statSync(componentPath).size;
  entry.sha256 = sha256File(componentPath);
  writeCanonicalJson(manifestPath, manifest);
  return sha256File(manifestPath);
}

test(
  "durable greenfield bundle round-trips and fails closed on bound-data tampering",
  { skip: process.platform === "win32" },
  () => {
    const run = createDurableFixture();
    try {
      assert.deepEqual(readdirSync(run.extracted).sort(), [
        "application-s3-access-logging-preflight.json",
        "frontend-prestate.json",
        "recovery-intent.json",
        "recovery-snapshot-proof.json",
      ]);

      const wrongProvenance = runBash(
        VERIFY_BUNDLE,
        [run.extracted],
        run.fixture,
        {
          ...run.verificationEnv,
          EXPECTED_SOURCE_CI_RUN_ID: "7002",
        }
      );
      assert.notEqual(wrongProvenance.status, 0);

      const intentTamperDir = join(run.fixture, "intent-tamper");
      cpSync(run.extracted, intentTamperDir, { recursive: true });
      const intentManifestPath = join(
        intentTamperDir,
        "recovery-intent.json"
      );
      const intentManifest = JSON.parse(
        readFileSync(intentManifestPath, "utf8")
      ) as Record<string, unknown>;
      const forgedIntent = "f".repeat(64);
      intentManifest.intentId = forgedIntent;
      writeCanonicalJson(intentManifestPath, intentManifest);
      const intentTamper = runBash(
        VERIFY_BUNDLE,
        [intentTamperDir],
        run.fixture,
        {
          ...run.verificationEnv,
          EXPECTED_INTENT_ID: forgedIntent,
          EXPECTED_MANIFEST_SHA256: sha256File(intentManifestPath),
        }
      );
      assert.notEqual(intentTamper.status, 0);

      const componentTamperDir = join(run.fixture, "component-tamper");
      cpSync(run.extracted, componentTamperDir, { recursive: true });
      const frontendPath = join(
        componentTamperDir,
        "frontend-prestate.json"
      );
      const frontend = JSON.parse(
        readFileSync(frontendPath, "utf8")
      ) as Record<string, unknown>;
      frontend.bucket =
        `${APP_NAME}-production-web-${ACCOUNT_ID}-${AWS_REGION}`;
      writeCanonicalJson(frontendPath, frontend);
      const forgedManifestSha256 = updateManifestComponentDigest(
        componentTamperDir,
        "frontend-prestate.json"
      );
      const semanticTamper = runBash(
        VERIFY_BUNDLE,
        [componentTamperDir],
        run.fixture,
        {
          ...run.verificationEnv,
          EXPECTED_MANIFEST_SHA256: forgedManifestSha256,
        }
      );
      assert.notEqual(semanticTamper.status, 0);
    } finally {
      rmSync(run.fixture, { recursive: true, force: true });
    }
  }
);

interface UnsafeArchiveCase {
  expectedError: RegExp;
  members: string[];
  name: string;
  prepare?: (sourceDir: string) => void;
}

const BASE_ARCHIVE_MEMBERS = [
  "recovery-intent.json",
  "application-s3-access-logging-preflight.json",
  "frontend-prestate.json",
  "recovery-snapshot-proof.json",
];

const UNSAFE_ARCHIVE_CASES: UnsafeArchiveCase[] = [
  {
    expectedError: /unsafe member name/iu,
    members: [...BASE_ARCHIVE_MEMBERS, "unexpected.sh"],
    name: "an unallowlisted member",
    prepare: (sourceDir: string) => {
      writeFileSync(join(sourceDir, "unexpected.sh"), "exit 99\n", "utf8");
    },
  },
  {
    expectedError: /duplicate members/iu,
    members: [
      "recovery-intent.json",
      "recovery-intent.json",
      "application-s3-access-logging-preflight.json",
      "frontend-prestate.json",
      "recovery-snapshot-proof.json",
    ],
    name: "a duplicate member",
  },
  {
    expectedError: /non-regular member/iu,
    members: [...BASE_ARCHIVE_MEMBERS, "previous-index.html"],
    name: "a symlink member",
    prepare: (sourceDir: string) => {
      symlinkSync(
        "frontend-prestate.json",
        join(sourceDir, "previous-index.html")
      );
    },
  },
];

for (const unsafeCase of UNSAFE_ARCHIVE_CASES) {
  test(
    `durable extraction rejects ${unsafeCase.name} before extraction`,
    { skip: process.platform === "win32" },
    () => {
      const fixture = makeFixture();
      try {
        const sourceDir = join(fixture, "archive-source");
        const archive = join(fixture, "unsafe.tar");
        const outputDir = join(fixture, "must-not-exist");
        mkdirSync(sourceDir);
        for (const member of BASE_ARCHIVE_MEMBERS) {
          writeFileSync(join(sourceDir, member), "{}\n", "utf8");
        }
        unsafeCase.prepare?.(sourceDir);
        const tarResult = spawnSync(
          "tar",
          ["-cf", archive, "-C", sourceDir, ...unsafeCase.members],
          { encoding: "utf8" }
        );
        assertSucceeded(tarResult);

        const extractResult = runBash(
          EXTRACT_BUNDLE,
          [archive, outputDir],
          fixture,
          isolatedEnv({
            EXPECTED_ARCHIVE_SHA256: sha256File(archive),
          })
        );
        assert.notEqual(extractResult.status, 0);
        assert.match(extractResult.stderr, unsafeCase.expectedError);
        assert.equal(
          readdirSync(fixture).includes("must-not-exist"),
          false
        );
      } finally {
        rmSync(fixture, { recursive: true, force: true });
      }
    }
  );
}

test(
  "private S3 recovery ledger preserves terminal provenance, CAS, and lease bounds",
  { skip: process.platform === "win32" },
  () => {
    const fixture = makeFixture();
    try {
      const fakeBin = join(fixture, "bin");
      const fakeState = join(fixture, "ledger-state.json");
      const fakeRevision = join(fixture, "ledger-revision");
      const callLog = join(fixture, "aws-calls.log");
      mkdirSync(fakeBin);
      writeFileSync(callLog, "", "utf8");
      writeFileSync(fakeRevision, "0", "utf8");
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
test "$(arg_value --bucket "$@")" = "$FAKE_ARTIFACT_BUCKET"
test "$(arg_value --key "$@")" = "$FAKE_LEDGER_KEY"
test "$(arg_value --expected-bucket-owner "$@")" = "$AWS_ACCOUNT_ID"
case "$*" in
  *"s3api get-object"*)
    if [ ! -s "$FAKE_S3_STATE" ]; then
      echo "NoSuchKey: The specified key does not exist (404)" >&2
      exit 254
    fi
    target="\${!#}"
    cp -- "$FAKE_S3_STATE" "$target"
    revision="$(cat "$FAKE_S3_REVISION")"
    etag="$(printf '%032x' "$revision")"
    checksum="$(
      openssl dgst -sha256 -binary "$FAKE_S3_STATE" | base64 -w0
    )"
    bytes="$(wc -c <"$FAKE_S3_STATE")"
    jq -n \\
      --arg checksum "$checksum" \\
      --arg etag "\\"$etag\\"" \\
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
          environment: "staging",
          kind: "recovery-ledger"
        }
      }'
    ;;
  *"s3api put-object"*)
    body="$(arg_value --body "$@")"
    test "$(arg_value --server-side-encryption "$@")" = "AES256"
    test "$(arg_value --content-type "$@")" = "application/json"
    test "$(arg_value --metadata "$@")" = \\
      "environment=staging,kind=recovery-ledger"
    if [ -s "$FAKE_S3_STATE" ]; then
      revision="$(cat "$FAKE_S3_REVISION")"
      etag="$(printf '%032x' "$revision")"
      test "$(arg_value --if-match "$@")" = \\
        "\\"$etag\\""
      ! has_arg --if-none-match "$@"
    else
      revision=0
      test "$(arg_value --if-none-match "$@")" = "*"
      ! has_arg --if-match "$@"
    fi
    cp -- "$body" "$FAKE_S3_STATE"
    revision="$((revision + 1))"
    printf '%s' "$revision" >"$FAKE_S3_REVISION"
    checksum="$(
      openssl dgst -sha256 -binary "$FAKE_S3_STATE" | base64 -w0
    )"
    test "$(arg_value --checksum-sha256 "$@")" = "$checksum"
    jq -n \\
      --arg checksum "$checksum" \\
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

      const intentId = "b".repeat(64);
      const ledgerEtag = (revision: number) =>
        `"${revision.toString(16).padStart(32, "0")}"`;
      const baseEnv = isolatedEnv({
        APP_NAME,
        AWS_ACCOUNT_ID: ACCOUNT_ID,
        AWS_REGION,
        FAKE_ARTIFACT_BUCKET: ARTIFACT_BUCKET,
        FAKE_AWS_CALL_LOG: callLog,
        FAKE_LEDGER_KEY:
          `candidates/recovery/${ENVIRONMENT}/ledger.json`,
        FAKE_S3_REVISION: fakeRevision,
        FAKE_S3_STATE: fakeState,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        RECOVERY_ENVIRONMENT: ENVIRONMENT,
      });
      const initiallyClear = runBash(
        RECOVERY_LEDGER,
        ["assert-clear"],
        fixture,
        baseEnv
      );
      assertSucceeded(initiallyClear);
      assert.deepEqual(JSON.parse(initiallyClear.stdout), {
        environment: ENVIRONMENT,
        exists: false,
        ok: true,
        schema: "archon.recovery-intent.clear",
        state: null,
        version: 1,
      });

      const armResult = runBash(
        RECOVERY_LEDGER,
        ["arm"],
        fixture,
        {
          ...baseEnv,
          CANDIDATE_SHA,
          RECOVERY_ARCHIVE_BUCKET: ARTIFACT_BUCKET,
          RECOVERY_ARCHIVE_KEY:
            `candidates/recovery/${ENVIRONMENT}/${intentId}.tar`,
          RECOVERY_ARCHIVE_SHA256: "c".repeat(64),
          RECOVERY_ARCHIVE_VERSION_ID: "archive-version-1",
          RECOVERY_INTENT_ID: intentId,
          RECOVERY_MANIFEST_SHA256: "d".repeat(64),
          SOURCE_CI_RUN_ATTEMPT,
          SOURCE_CI_RUN_ID,
          SOURCE_DEPLOY_RUN_ATTEMPT,
          SOURCE_DEPLOY_RUN_ID,
        }
      );
      assertSucceeded(armResult);
      const armed = JSON.parse(armResult.stdout) as Record<
        string,
        unknown
      >;
      assert.deepEqual(
        Object.keys(armed).sort(),
        [
          ...LEDGER_SCHEMA_KEYS,
          "exists",
          "ledgerEtag",
          "ledgerSha256",
          "ledgerVersionId",
        ].sort()
      );
      assert.equal(armed.exists, true);
      assert.equal(armed.intentId, intentId);
      assert.equal(armed.state, "ARMED");
      for (const field of [
        "controlProofBucket",
        "controlProofKey",
        "controlProofSha256",
        "controlProofVersionId",
      ]) {
        assert.equal(armed[field], null);
      }
      assert.equal(armed.previousLedgerEtag, null);
      assert.equal(armed.previousLedgerSha256, null);
      assert.equal(armed.previousLedgerVersionId, null);
      const armedLedgerSha256 = sha256File(fakeState);
      assert.equal(armed.ledgerEtag, ledgerEtag(1));
      assert.equal(armed.ledgerSha256, armedLedgerSha256);
      assert.equal(armed.ledgerVersionId, "ledger-version-1");
      const persistedArmed = JSON.parse(
        readFileSync(fakeState, "utf8")
      ) as Record<string, unknown>;
      assert.deepEqual(
        Object.keys(persistedArmed).sort(),
        [...LEDGER_SCHEMA_KEYS].sort()
      );
      assert.equal(persistedArmed.previousLedgerEtag, null);
      assert.equal(persistedArmed.previousLedgerSha256, null);
      assert.equal(persistedArmed.previousLedgerVersionId, null);

      const unresolved = runBash(
        RECOVERY_LEDGER,
        ["assert-clear"],
        fixture,
        baseEnv
      );
      assert.notEqual(unresolved.status, 0);
      assert.match(unresolved.stderr, /unresolved/iu);

      const receiptSha256 = "e".repeat(64);
      const commitResult = runBash(
        RECOVERY_LEDGER,
        ["commit"],
        fixture,
        {
          ...baseEnv,
          RECOVERY_INTENT_ID: intentId,
          RECOVERY_RECEIPT_BUCKET: ARTIFACT_BUCKET,
          RECOVERY_RECEIPT_KEY:
            `candidates/recovery/${ENVIRONMENT}/receipts/` +
            `${intentId}/${receiptSha256}.json`,
          RECOVERY_RECEIPT_SHA256: receiptSha256,
          RECOVERY_RECEIPT_VERSION_ID: "receipt-version-1",
        }
      );
      assertSucceeded(commitResult);
      const committed = JSON.parse(commitResult.stdout) as Record<
        string,
        unknown
      >;
      assert.deepEqual(
        Object.keys(committed).sort(),
        [
          ...LEDGER_SCHEMA_KEYS,
          "exists",
          "ledgerEtag",
          "ledgerSha256",
          "ledgerVersionId",
          "ok",
        ].sort()
      );
      assert.equal(committed.intentId, intentId);
      assert.equal(committed.ok, true);
      assert.equal(
        committed.schema,
        "archon.recovery-intent.terminal"
      );
      assert.equal(committed.state, "COMMITTED");
      for (const field of [
        "controlProofBucket",
        "controlProofKey",
        "controlProofSha256",
        "controlProofVersionId",
      ]) {
        assert.equal(committed[field], null);
      }
      assert.equal(
        committed.previousLedgerEtag,
        ledgerEtag(1)
      );
      assert.equal(
        committed.previousLedgerSha256,
        armedLedgerSha256
      );
      assert.equal(
        committed.previousLedgerVersionId,
        "ledger-version-1"
      );
      const persistedCommitted = JSON.parse(
        readFileSync(fakeState, "utf8")
      ) as Record<string, unknown>;
      assert.deepEqual(
        Object.keys(persistedCommitted).sort(),
        [...LEDGER_SCHEMA_KEYS].sort()
      );
      assert.equal(
        persistedCommitted.schema,
        "archon.recovery-intent.ledger"
      );
      assert.equal(persistedCommitted.state, "COMMITTED");
      assert.equal(
        persistedCommitted.previousLedgerSha256,
        armedLedgerSha256
      );
      assert.equal(
        persistedCommitted.previousLedgerEtag,
        ledgerEtag(1)
      );
      assert.equal(
        persistedCommitted.previousLedgerVersionId,
        "ledger-version-1"
      );
      const committedLedgerSha256 = sha256File(fakeState);
      assert.equal(committed.ledgerEtag, ledgerEtag(2));
      assert.equal(committed.ledgerSha256, committedLedgerSha256);
      assert.equal(committed.ledgerVersionId, "ledger-version-2");

      const terminalRead = runBash(
        RECOVERY_LEDGER,
        ["read"],
        fixture,
        baseEnv
      );
      assertSucceeded(terminalRead);
      const terminalItem = JSON.parse(terminalRead.stdout) as Record<
        string,
        unknown
      >;
      assert.deepEqual(
        Object.keys(terminalItem).sort(),
        [
          ...LEDGER_SCHEMA_KEYS,
          "exists",
          "ledgerEtag",
          "ledgerSha256",
          "ledgerVersionId",
        ].sort()
      );
      assert.equal(terminalItem.state, "COMMITTED");
      assert.equal(terminalItem.ledgerEtag, ledgerEtag(2));
      assert.equal(
        terminalItem.ledgerSha256,
        committedLedgerSha256
      );
      assert.equal(terminalItem.ledgerVersionId, "ledger-version-2");

      const terminalClear = runBash(
        RECOVERY_LEDGER,
        ["assert-clear"],
        fixture,
        baseEnv
      );
      assertSucceeded(terminalClear);
      const terminalClearProof = JSON.parse(
        terminalClear.stdout
      ) as Record<string, unknown>;
      assert.equal(terminalClearProof.ok, true);
      assert.equal(
        terminalClearProof.schema,
        "archon.recovery-intent.clear"
      );
      assert.equal(terminalClearProof.state, "COMMITTED");

      // Regression: a terminal ledger must re-arm with the complete exact
      // terminal S3 revision as its prior provenance tuple.
      const nextIntentId = "f".repeat(64);
      const nextArmResult = runBash(
        RECOVERY_LEDGER,
        ["arm"],
        fixture,
        {
          ...baseEnv,
          CANDIDATE_SHA,
          RECOVERY_ARCHIVE_BUCKET: ARTIFACT_BUCKET,
          RECOVERY_ARCHIVE_KEY:
            `candidates/recovery/${ENVIRONMENT}/${nextIntentId}.tar`,
          RECOVERY_ARCHIVE_SHA256: "1".repeat(64),
          RECOVERY_ARCHIVE_VERSION_ID: "archive-version-2",
          RECOVERY_INTENT_ID: nextIntentId,
          RECOVERY_MANIFEST_SHA256: "2".repeat(64),
          SOURCE_CI_RUN_ATTEMPT,
          SOURCE_CI_RUN_ID,
          SOURCE_DEPLOY_RUN_ATTEMPT,
          SOURCE_DEPLOY_RUN_ID,
        }
      );
      assertSucceeded(nextArmResult);
      const nextArmed = JSON.parse(nextArmResult.stdout) as Record<
        string,
        unknown
      >;
      assert.deepEqual(
        Object.keys(nextArmed).sort(),
        [
          ...LEDGER_SCHEMA_KEYS,
          "exists",
          "ledgerEtag",
          "ledgerSha256",
          "ledgerVersionId",
        ].sort()
      );
      assert.equal(nextArmed.intentId, nextIntentId);
      assert.equal(nextArmed.state, "ARMED");
      assert.equal(
        nextArmed.previousLedgerEtag,
        ledgerEtag(2)
      );
      assert.equal(
        nextArmed.previousLedgerSha256,
        committedLedgerSha256
      );
      assert.equal(
        nextArmed.previousLedgerVersionId,
        "ledger-version-2"
      );
      const persistedNextArmed = JSON.parse(
        readFileSync(fakeState, "utf8")
      ) as Record<string, unknown>;
      assert.deepEqual(
        Object.keys(persistedNextArmed).sort(),
        [...LEDGER_SCHEMA_KEYS].sort()
      );
      assert.equal(
        persistedNextArmed.previousLedgerEtag,
        ledgerEtag(2)
      );
      assert.equal(
        persistedNextArmed.previousLedgerSha256,
        committedLedgerSha256
      );
      assert.equal(
        persistedNextArmed.previousLedgerVersionId,
        "ledger-version-2"
      );
      const validRearmedLedger = readFileSync(fakeState, "utf8");
      const provenanceTamperCases: Array<{
        mutate: (ledger: Record<string, unknown>) => void;
        name: string;
      }> = [
        {
          name: "incomplete prior tuple",
          mutate: (ledger) => {
            ledger.previousLedgerSha256 = null;
          },
        },
        {
          name: "malformed prior ETag",
          mutate: (ledger) => {
            ledger.previousLedgerEtag = "not-an-etag";
          },
        },
        {
          name: "null S3 prior version",
          mutate: (ledger) => {
            ledger.previousLedgerVersionId = "null";
          },
        },
      ];
      const putsBeforeProvenanceTampering = (
        readFileSync(callLog, "utf8").match(/s3api put-object/gu) ?? []
      ).length;
      for (const tamperCase of provenanceTamperCases) {
        const tamperedLedger = JSON.parse(
          validRearmedLedger
        ) as Record<string, unknown>;
        tamperCase.mutate(tamperedLedger);
        writeCanonicalJson(fakeState, tamperedLedger);
        try {
          const tamperedRead = runBash(
            RECOVERY_LEDGER,
            ["read"],
            fixture,
            baseEnv
          );
          assert.notEqual(
            tamperedRead.status,
            0,
            `Expected ${tamperCase.name} to fail closed`
          );
          assert.equal(
            (
              readFileSync(callLog, "utf8").match(
                /s3api put-object/gu
              ) ?? []
            ).length,
            putsBeforeProvenanceTampering
          );
        } finally {
          writeFileSync(fakeState, validRearmedLedger, "utf8");
        }
      }
      const nextArmedLedgerSha256 = sha256File(fakeState);
      assert.equal(nextArmed.ledgerEtag, ledgerEtag(3));
      assert.equal(nextArmed.ledgerSha256, nextArmedLedgerSha256);
      assert.equal(nextArmed.ledgerVersionId, "ledger-version-3");

      const claimStartedAt = Math.floor(Date.now() / 1000);
      const claimResult = runBash(
        RECOVERY_LEDGER,
        ["claim"],
        fixture,
        {
          ...baseEnv,
          RECOVERY_INTENT_ID: nextIntentId,
          RECOVERY_LEASE_OWNER: "recover-run-9001-1",
        }
      );
      const claimFinishedAt = Math.floor(Date.now() / 1000);
      assertSucceeded(claimResult);
      const claimed = JSON.parse(claimResult.stdout) as Record<
        string,
        unknown
      >;
      assert.deepEqual(
        Object.keys(claimed).sort(),
        [
          ...LEDGER_SCHEMA_KEYS,
          "exists",
          "ledgerEtag",
          "ledgerSha256",
          "ledgerVersionId",
        ].sort()
      );
      assert.equal(claimed.intentId, nextIntentId);
      assert.equal(claimed.leaseOwner, "recover-run-9001-1");
      assert.equal(claimed.state, "RECOVERING");
      for (const field of [
        "controlProofBucket",
        "controlProofKey",
        "controlProofSha256",
        "controlProofVersionId",
      ]) {
        assert.equal(claimed[field], null);
      }
      assert.equal(
        claimed.previousLedgerEtag,
        ledgerEtag(3)
      );
      assert.equal(
        claimed.previousLedgerSha256,
        nextArmedLedgerSha256
      );
      assert.equal(
        claimed.previousLedgerVersionId,
        "ledger-version-3"
      );
      assert.equal(typeof claimed.leaseUntil, "number");
      assert.ok(
        (claimed.leaseUntil as number) >= claimStartedAt + 7_100
      );
      assert.ok(
        (claimed.leaseUntil as number) <= claimFinishedAt + 7_300
      );
      const persistedClaimed = JSON.parse(
        readFileSync(fakeState, "utf8")
      ) as Record<string, unknown>;
      assert.deepEqual(
        Object.keys(persistedClaimed).sort(),
        [...LEDGER_SCHEMA_KEYS].sort()
      );
      assert.equal(
        persistedClaimed.previousLedgerEtag,
        ledgerEtag(3)
      );
      assert.equal(
        persistedClaimed.previousLedgerSha256,
        nextArmedLedgerSha256
      );
      assert.equal(
        persistedClaimed.previousLedgerVersionId,
        "ledger-version-3"
      );
      const claimedLedgerSha256 = sha256File(fakeState);
      assert.equal(claimed.ledgerEtag, ledgerEtag(4));
      assert.equal(claimed.ledgerSha256, claimedLedgerSha256);
      assert.equal(claimed.ledgerVersionId, "ledger-version-4");

      const calls = readFileSync(callLog, "utf8");
      const putCalls = calls
        .split(/\r?\n/u)
        .filter((call) => call.includes("s3api put-object"));
      assert.equal(putCalls.length, 4);
      assert.match(putCalls[0] ?? "", /--if-none-match \*/u);
      assert.doesNotMatch(putCalls[0] ?? "", /--if-match/u);
      for (const [index, putCall] of putCalls.slice(1).entries()) {
        assert.ok(
          putCall.includes(`--if-match ${ledgerEtag(index + 1)}`),
          putCall
        );
        assert.doesNotMatch(putCall, /--if-none-match/u);
      }
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }
);

test("S3 recovery lease bounds full jobs and phased credentials", () => {
  const ledgerSource = readFileSync(RECOVERY_LEDGER, "utf8");
  const leaseMatch = ledgerSource.match(
    /leaseUntil "\$\(\(now \+ ([0-9]+)\)\)"/u
  );
  assert.ok(leaseMatch);
  const leaseSeconds = Number(leaseMatch[1]);
  assert.equal(leaseSeconds, 7_200);

  const workflowSource = readFileSync(RECOVERY_WORKFLOW, "utf8");
  const timeoutMinutes = [
    ...workflowSource.matchAll(/^\s+timeout-minutes:\s*([0-9]+)\s*$/gmu),
  ].map((match) => Number(match[1]));
  assert.ok(timeoutMinutes.length > 0);
  const credentialSeconds = [
    ...workflowSource.matchAll(
      /^\s+role-duration-seconds:\s*([0-9]+)\s*$/gmu
    ),
  ].map((match) => Number(match[1]));
  assert.ok(credentialSeconds.length > 0);
  for (const timeout of timeoutMinutes) {
    assert.ok(
      leaseSeconds > timeout * 60,
      `Lease ${leaseSeconds}s must exceed recovery timeout ${timeout}m`
    );
  }
  for (const duration of credentialSeconds) {
    assert.equal(
      duration,
      3_600,
      "Every phased recovery credential must remain one hour"
    );
    assert.ok(
      leaseSeconds > duration,
      `Lease ${leaseSeconds}s must exceed credential duration ${duration}s`
    );
  }
});

function shellInvocationBlocks(
  source: string,
  command: string
): string[] {
  const lines = source.split(/\r?\n/u);
  const blocks: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index]?.trimStart().startsWith(command)) {
      continue;
    }
    const block = [lines[index] ?? ""];
    while (
      block.at(-1)?.trimEnd().endsWith("\\") &&
      index + 1 < lines.length
    ) {
      index += 1;
      block.push(lines[index] ?? "");
    }
    blocks.push(block.join("\n"));
  }
  return blocks;
}

function describeChangeSetValidationBlocks(source: string): string[] {
  const startToken = "aws cloudformation describe-change-set";
  const endToken = '<<<"$change_set"';
  const blocks: string[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf(startToken, cursor);
    if (start < 0) {
      break;
    }
    const end = source.indexOf(endToken, start);
    assert.notEqual(end, -1, "DescribeChangeSet validation is incomplete");
    blocks.push(source.slice(start, end + endToken.length));
    cursor = end + endToken.length;
  }
  return blocks;
}

test("CloudFormation recovery uses only fields and flags supported by AWS", () => {
  const cleanupSource = readFileSync(CLEANUP_SCRIPT, "utf8");
  const deleteBlocks = shellInvocationBlocks(
    cleanupSource,
    "aws cloudformation delete-stack"
  );
  assert.ok(deleteBlocks.length > 0);
  for (const block of deleteBlocks) {
    assert.doesNotMatch(block, /--retain-except-on-create/u);
  }

  const restoreSource = readFileSync(RESTORE_SCRIPT, "utf8");
  const validationBlocks =
    describeChangeSetValidationBlocks(restoreSource);
  assert.ok(validationBlocks.length >= 2);
  for (const block of validationBlocks) {
    assert.doesNotMatch(block, /\.ChangeSetType/u);
    assert.doesNotMatch(block, /\.RoleARN/u);
    assert.doesNotMatch(block, /--arg role/u);
  }

  const recoveryTestSource = readFileSync(RECOVERY_TEST_SOURCE, "utf8");
  const mockStart = recoveryTestSource.indexOf(
    '*"cloudformation describe-change-set"*)'
  );
  assert.notEqual(mockStart, -1);
  const mockEnd = recoveryTestSource.indexOf(";;", mockStart);
  assert.notEqual(mockEnd, -1);
  const describeChangeSetMock = recoveryTestSource.slice(
    mockStart,
    mockEnd
  );
  assert.doesNotMatch(describeChangeSetMock, /ChangeSetType/u);
  assert.doesNotMatch(describeChangeSetMock, /RoleARN/u);
});

const RECOVERY_WORKFLOW_REF =
  `${REPOSITORY}/.github/workflows/recover-aws.yml@refs/heads/main`;
const RECOVERY_CODE_SHA = "8".repeat(40);
const RECOVERY_EXECUTION_ID = "watchdog-9001-2";
const RECOVERY_LEASE_OWNER =
  `${RECOVERY_EXECUTION_ID}-${ENVIRONMENT}`;

interface ReceiptVerifierFixture {
  fixture: string;
  receipt: Record<string, unknown>;
  receiptFile: string;
  verificationEnv: NodeJS.ProcessEnv;
}

function createReceiptVerifierFixture(
  stackState: "greenfield" | "existing"
): ReceiptVerifierFixture {
  const fixture = mkdtempSync(join(tmpdir(), "archon-recovery-receipt-"));
  const receiptFile = join(fixture, "receipt.json");
  const ledgerFile = join(fixture, "recovering-ledger.json");
  const manifestFile = join(fixture, "recovery-intent.json");
  const frontendPrestateFile = join(fixture, "frontend-prestate.json");
  const intentId = "9".repeat(64);
  const manifestStackId =
    stackState === "existing"
      ? `arn:aws:cloudformation:${AWS_REGION}:${ACCOUNT_ID}:stack/` +
        `${STACK_NAME}/11111111-2222-3333-4444-555555555555`
      : null;
  const templateSha256 = stackState === "existing" ? "1".repeat(64) : null;
  const parametersSha256 =
    stackState === "existing" ? "2".repeat(64) : null;
  const tagsSha256 = stackState === "existing" ? "3".repeat(64) : null;
  const previousIndexSha256 =
    stackState === "existing" ? "4".repeat(64) : null;
  const applicationUrl =
    stackState === "existing"
      ? "https://example.cloudfront.net"
      : null;
  const functionName =
    stackState === "existing" ? `${APP_NAME}-${ENVIRONMENT}-api` : null;
  const functionVersion = stackState === "existing" ? "17" : null;
  const manifestStackRevision =
    stackState === "existing"
      ? "2026-07-25T12:34:56.123456+00:00"
      : null;
  const restoredStackRevision =
    stackState === "existing"
      ? "2026-07-26T12:34:56.654321+00:00"
      : null;
  const manifest: Record<string, unknown> = {
    accountId: ACCOUNT_ID,
    appName: APP_NAME,
    applicationUrl,
    artifactBucket: ARTIFACT_BUCKET,
    candidateSha: CANDIDATE_SHA,
    environment: ENVIRONMENT,
    executionRoleArn: EXECUTION_ROLE_ARN,
    functionName,
    functionVersion,
    hasPreviousStack: stackState === "existing",
    intentId,
    parametersSha256,
    region: AWS_REGION,
    repository: REPOSITORY,
    schema: "archon.durable-recovery-intent",
    sourceCiRunAttempt: SOURCE_CI_RUN_ATTEMPT,
    sourceCiRunId: SOURCE_CI_RUN_ID,
    sourceDeployRunAttempt: SOURCE_DEPLOY_RUN_ATTEMPT,
    sourceDeployRunId: SOURCE_DEPLOY_RUN_ID,
    stackId: manifestStackId,
    stackName: STACK_NAME,
    stackRevision: manifestStackRevision,
    stackState,
    tagsSha256,
    templateSha256,
    version: 1,
  };
  writeCanonicalJson(manifestFile, manifest);
  writeCanonicalJson(frontendPrestateFile, {
    hadPreviousIndex: stackState === "existing",
    previousIndexSha256,
  });

  const manifestSha256 = sha256File(manifestFile);
  const archiveSha256 = "5".repeat(64);
  const ledgerEtag = `"${"6".repeat(32)}"`;
  const ledgerSha256 = "7".repeat(64);
  const ledgerVersionId = "ledger-version-4";
  const updatedAt = Math.floor(Date.now() / 1000) - 5;
  writeCanonicalJson(ledgerFile, {
    archiveBucket: ARTIFACT_BUCKET,
    archiveKey:
      `candidates/recovery/${ENVIRONMENT}/${intentId}.tar`,
    archiveSha256,
    archiveVersionId: "archive-version-1",
    candidateSha: CANDIDATE_SHA,
    environment: ENVIRONMENT,
    exists: true,
    intentId,
    leaseUntil: updatedAt + 7_200,
    leaseOwner: RECOVERY_LEASE_OWNER,
    ledgerEtag,
    ledgerSha256,
    ledgerVersionId,
    manifestSha256,
    sourceCiRunAttempt: SOURCE_CI_RUN_ATTEMPT,
    sourceCiRunId: SOURCE_CI_RUN_ID,
    sourceRunAttempt: SOURCE_DEPLOY_RUN_ATTEMPT,
    sourceRunId: SOURCE_DEPLOY_RUN_ID,
    state: "RECOVERING",
    updatedAt,
  });

  const expectedLogging = {
    LoggingEnabled: {
      TargetBucket:
        `${APP_NAME}-s3-access-logs-${ACCOUNT_ID}-${AWS_REGION}`,
      TargetObjectKeyFormat: {
        PartitionedPrefix: {
          PartitionDateSource: "EventTime",
        },
      },
      TargetPrefix: `${ENVIRONMENT}-web/`,
    },
  };
  const priorState = stackState === "existing" ? "disabled" : "absent";
  const loggingProof = {
    destinationBucket:
      `${APP_NAME}-s3-access-logs-${ACCOUNT_ID}-${AWS_REGION}`,
    environment: ENVIRONMENT,
    evidence: "live-control-plane",
    expected: expectedLogging,
    foundationVerified: true,
    mode: "recover",
    ok: true,
    preflightIntegrity: {
      algorithm: "sha256",
      canonicalization: "jq-cS-v1",
      payloadSha256: "a".repeat(64),
    },
    priorState,
    restoredConfiguration: stackState === "existing" ? {} : null,
    restoredState: priorState,
    schema: "archon.application-s3-access-logging.recovery",
    sourceBucket:
      `${APP_NAME}-${ENVIRONMENT}-web-${ACCOUNT_ID}-${AWS_REGION}`,
    stackState,
    version: 1,
  };
  const notApplicable = {
    ok: true,
    state: "not-applicable-greenfield",
  };
  const proofs =
    stackState === "greenfield"
      ? {
          alias: notApplicable,
          frontend: notApplicable,
          live: notApplicable,
          s3AccessLogging: loggingProof,
          stack: {
            absence: {
              bucket: true,
              lambdaLog: true,
              legacyApiLog: true,
              stack: true,
              vendedApiLog: true,
            },
            cleanup: {
              ok: true,
              retainedBucketDeleted: false,
              retainedLogGroupsDeleted: 0,
              schema: "archon.greenfield-cleanup.proof",
              stack: STACK_NAME,
              stackDeleted: false,
              stackId: null,
              state: "greenfield-stack-absent",
              version: 1,
            },
            ok: true,
            retainedResources: "absent",
            stackName: STACK_NAME,
            state: "absent",
          },
        }
      : {
          alias: {
            AliasArn:
              `arn:aws:lambda:${AWS_REGION}:${ACCOUNT_ID}:function:` +
              `${functionName}:live`,
            FunctionVersion: functionVersion,
            Name: "live",
            RoutingConfig: {
              AdditionalVersionWeights: {},
            },
          },
          frontend: {
            hadPreviousIndex: true,
            ok: true,
            restoredVersionId: "restored-index-version-1",
            sha256: previousIndexSha256,
            state: "restored",
          },
          live: {
            applicationUrl,
            health: {
              ok: true,
              status: "reachable",
            },
            memory: {
              persisted: 9,
              storeVerified: true,
            },
            ok: true,
          },
          s3AccessLogging: loggingProof,
          stack: {
            ok: true,
            parametersSha256,
            stackId: manifestStackId,
            stackRevision: restoredStackRevision,
            state: "restored",
            tagsSha256,
            templateSha256,
          },
        };
  const receipt: Record<string, unknown> = {
    archive: {
      bucket: ARTIFACT_BUCKET,
      key: `candidates/recovery/${ENVIRONMENT}/${intentId}.tar`,
      sha256: archiveSha256,
      versionId: "archive-version-1",
    },
    candidateSha: CANDIDATE_SHA,
    completedAt: new Date().toISOString().replace(/\.[0-9]{3}Z$/u, "Z"),
    environment: ENVIRONMENT,
    executor: {
      codeSha: RECOVERY_CODE_SHA,
      executionId: RECOVERY_EXECUTION_ID,
      leaseOwner: RECOVERY_LEASE_OWNER,
      repository: REPOSITORY,
      workflowRef: RECOVERY_WORKFLOW_REF,
    },
    intentId,
    manifestSha256,
    ok: true,
    proofs,
    recoveringLedger: {
      bucket: ARTIFACT_BUCKET,
      etag: ledgerEtag,
      key: `candidates/recovery/${ENVIRONMENT}/ledger.json`,
      leaseUntil: updatedAt + 7_200,
      sha256: ledgerSha256,
      state: "RECOVERING",
      updatedAt,
      versionId: ledgerVersionId,
    },
    result: "RECOVERED",
    schema: "archon.durable-recovery.receipt",
    sourceCiRunAttempt: SOURCE_CI_RUN_ATTEMPT,
    sourceCiRunId: SOURCE_CI_RUN_ID,
    sourceDeployRunAttempt: SOURCE_DEPLOY_RUN_ATTEMPT,
    sourceDeployRunId: SOURCE_DEPLOY_RUN_ID,
    stackState,
    target: {
      accountId: ACCOUNT_ID,
      appName: APP_NAME,
      executionRoleArn: EXECUTION_ROLE_ARN,
      region: AWS_REGION,
      stackName: STACK_NAME,
    },
    version: 2,
  };
  writeCanonicalJson(receiptFile, receipt);
  const verificationEnv = isolatedEnv({
    APP_NAME,
    AWS_ACCOUNT_ID: ACCOUNT_ID,
    AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN: EXECUTION_ROLE_ARN,
    AWS_REGION,
    EXPECTED_RECOVERY_RECEIPT_SHA256: sha256File(receiptFile),
    GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_WORKFLOW_REF: RECOVERY_WORKFLOW_REF,
    RECOVERY_CODE_SHA,
    RECOVERY_ENVIRONMENT: ENVIRONMENT,
    RECOVERY_EXECUTION_ID,
    RECOVERY_INTENT_ID: intentId,
    RECOVERY_LEASE_OWNER,
    RECOVERY_LEDGER_FILE: ledgerFile,
    RECOVERY_MANIFEST_FILE: manifestFile,
    STACK_NAME,
  });
  return {
    fixture,
    receipt,
    receiptFile,
    verificationEnv,
  };
}

test(
  "schema-v2 durable recovery receipts embed and validate both recovery branches",
  { skip: process.platform === "win32" },
  () => {
    for (const stackState of ["greenfield", "existing"] as const) {
      const fixture = createReceiptVerifierFixture(stackState);
      try {
        const valid = runBash(
          VERIFY_RECEIPT,
          [fixture.receiptFile],
          fixture.fixture,
          fixture.verificationEnv
        );
        assertSucceeded(valid);
        assert.deepEqual(JSON.parse(valid.stdout), {
          environment: ENVIRONMENT,
          intentId: "9".repeat(64),
          ok: true,
          receiptSha256: sha256File(fixture.receiptFile),
          schema: "archon.durable-recovery-receipt.validation",
          version: 1,
        });

        const originalReceipt = readFileSync(fixture.receiptFile, "utf8");
        writeFileSync(
          fixture.receiptFile,
          `${originalReceipt}${originalReceipt}`,
          "utf8"
        );
        const streamedReceiptEnv = { ...fixture.verificationEnv };
        delete streamedReceiptEnv.EXPECTED_RECOVERY_RECEIPT_SHA256;
        const streamedReceipt = runBash(
          VERIFY_RECEIPT,
          [fixture.receiptFile],
          fixture.fixture,
          streamedReceiptEnv
        );
        assert.notEqual(streamedReceipt.status, 0);
        assert.match(
          streamedReceipt.stderr,
          /must contain exactly one JSON object/u
        );
        writeFileSync(fixture.receiptFile, originalReceipt, "utf8");

        const manifestFile =
          fixture.verificationEnv.RECOVERY_MANIFEST_FILE;
        assert.equal(typeof manifestFile, "string");
        const originalManifest = readFileSync(manifestFile as string, "utf8");
        writeFileSync(
          manifestFile as string,
          `${originalManifest}${originalManifest}`,
          "utf8"
        );
        const streamedManifest = runBash(
          VERIFY_RECEIPT,
          [fixture.receiptFile],
          fixture.fixture,
          fixture.verificationEnv
        );
        assert.notEqual(streamedManifest.status, 0);
        assert.match(
          streamedManifest.stderr,
          /must contain exactly one JSON object/u
        );
        writeFileSync(manifestFile as string, originalManifest, "utf8");

        const tampered = JSON.parse(
          JSON.stringify(fixture.receipt)
        ) as Record<string, unknown>;
        const tamperedProofs = tampered.proofs as Record<
          string,
          Record<string, unknown>
        >;
        if (stackState === "greenfield") {
          const stack = tamperedProofs.stack;
          const absence = stack.absence as Record<string, unknown>;
          absence.lambdaLog = false;
        } else {
          tamperedProofs.stack.stackRevision = "not-an-iso-timestamp";
        }
        writeCanonicalJson(fixture.receiptFile, tampered);
        const tamperedEnv = { ...fixture.verificationEnv };
        delete tamperedEnv.EXPECTED_RECOVERY_RECEIPT_SHA256;
        const invalid = runBash(
          VERIFY_RECEIPT,
          [fixture.receiptFile],
          fixture.fixture,
          tamperedEnv
        );
        assert.notEqual(invalid.status, 0);
      } finally {
        rmSync(fixture.fixture, { recursive: true, force: true });
      }
    }
  }
);

test("recovery execution emits self-contained schema-v2 proof objects", () => {
  const source = readFileSync(RECOVER_ENVIRONMENT, "utf8");
  assert.match(
    source,
    /schema: "archon\.durable-recovery\.receipt",\s+version: 2/u
  );
  for (const proof of [
    "aliasProof",
    "frontendProof",
    "liveProof",
    "loggingProof",
    "stackProof",
  ]) {
    assert.match(source, new RegExp(`--slurpfile ${proof}\\b`, "u"));
  }
  assert.doesNotMatch(source, /(?:Proof|cleanup|health|memoryProof)Sha256/u);
  assert.match(
    source,
    /bash aws\/verify-durable-recovery-receipt\.sh "\$receipt_tmp"/u
  );
});

interface FinalizerFixture {
  bundleDir: string;
  callLog: string;
  controlProofFile: string;
  controlProofKey: string;
  controlProofObject: string;
  executionFile: string;
  fixture: string;
  historicalLedger: string;
  ledgerState: string;
  receiptFile: string;
  receiptKey: string;
  receiptObject: string;
  recoveringEtag: string;
  recoveringSha256: string;
  recoveringVersionId: string;
  verificationEnv: NodeJS.ProcessEnv;
}

function createFinalizerFixture(
  mode:
    | "success"
    | "ambiguous-exact"
    | "ambiguous-wrong-previous"
    | "object"
    | "readback"
    | "response-stream"
    | "control-readback" = "success",
  stackState: "greenfield" | "existing" = "greenfield"
): FinalizerFixture {
  const base = createReceiptVerifierFixture(stackState);
  const fixture = base.fixture;
  const awsDir = join(fixture, "aws");
  const fakeBin = join(fixture, "bin");
  const callLog = join(fixture, "finalizer-calls.log");
  const controlProofFile = join(
    fixture,
    "cloudformation-controls-recovery.json"
  );
  const controlProofObject = join(fixture, "control-proof-object.json");
  const executionFile = join(fixture, "execution.json");
  const historicalLedger = join(fixture, "ledger-version-4.json");
  const ledgerState = join(fixture, "ledger-state.json");
  const ledgerRevision = join(fixture, "ledger-revision");
  const receiptObject = join(fixture, "receipt-object.json");
  mkdirSync(awsDir);
  mkdirSync(fakeBin);
  writeFileSync(callLog, "", "utf8");
  writeFileSync(ledgerRevision, "4", "utf8");
  const receiptProofs = base.receipt.proofs as Record<
    string,
    Record<string, unknown>
  >;
  const receiptStackProof = receiptProofs.stack;
  writeCanonicalJson(controlProofFile, {
    drift:
      stackState === "existing"
        ? {
            checkedResourceCount: 7,
            detectionId: "11111111-2222-3333-4444-555555555555",
            detectionStatus: "DETECTION_COMPLETE",
            driftedResourceCount: 0,
            notCheckedResourceCount: 2,
            stackDriftStatus: "IN_SYNC",
            totalResourceCount: 9,
          }
        : null,
    evidence: "live-control-plane",
    identity: {
      accountId: ACCOUNT_ID,
      appName: APP_NAME,
      candidateSha: null,
      environment: ENVIRONMENT,
      executionRoleArn: EXECUTION_ROLE_ARN,
      region: AWS_REGION,
      stackId:
        stackState === "existing" ? receiptStackProof.stackId : null,
      stackName: STACK_NAME,
      stackRevision:
        stackState === "existing"
          ? receiptStackProof.stackRevision
          : null,
      stackStatus:
        stackState === "existing" ? "UPDATE_COMPLETE" : null,
      state: stackState === "existing" ? "existing" : "absent",
      tagsSha256:
        stackState === "existing" ? receiptStackProof.tagsSha256 : null,
    },
    mode: "recover",
    ok: true,
    protection: {
      action: stackState === "existing" ? "verified" : "not-applicable",
      enabled: stackState === "existing" ? true : null,
    },
    schema: "archon.cloudformation-controls.proof",
    version: 1,
  });
  const controlProofSha256 = sha256File(controlProofFile);
  const controlProofKey =
    `candidates/recovery/${ENVIRONMENT}/controls/` +
    `${String(base.receipt.intentId)}/${controlProofSha256}.json`;

  symlinkSync(
    join(ROOT, "aws", "recovery-intent-ledger.sh"),
    join(awsDir, "recovery-intent-ledger.sh"),
    "file"
  );
  symlinkSync(
    join(ROOT, "aws", "put-durable-recovery-object.sh"),
    join(awsDir, "put-durable-recovery-object.sh"),
    "file"
  );
  executable(
    join(awsDir, "verify-durable-recovery-receipt.sh"),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'verify %s\\n' "$1" >>"$FAKE_FINALIZER_CALL_LOG"
exec bash "$FAKE_REAL_RECEIPT_VERIFIER" "$@"
`
  );
  executable(
    join(fakeBin, "sleep"),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'sleep %s\\n' "$*" >>"$FAKE_FINALIZER_CALL_LOG"
`
  );
  executable(
    join(fakeBin, "aws"),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'aws %s\\n' "$*" >>"$FAKE_FINALIZER_CALL_LOG"
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
emit_ledger_get() {
  local source="$1"
  local target="$2"
  local revision="$3"
  local etag checksum bytes
  cp -- "$source" "$target"
  etag="$(printf '%032x' "$revision")"
  checksum="$(
    openssl dgst -sha256 -binary "$source" | base64 -w0
  )"
  bytes="$(wc -c <"$source")"
  jq -n \\
    --arg checksum "$checksum" \\
    --arg etag "\\"$etag\\"" \\
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
        environment: "staging",
        kind: "recovery-ledger"
      }
    }'
}
emit_receipt_metadata() {
  local source="$1"
  local checksum bytes content_type
  checksum="$(
    openssl dgst -sha256 -binary "$source" | base64 -w0
  )"
  bytes="$(wc -c <"$source")"
  content_type="application/json"
  if [ "$FAKE_FINALIZER_MODE" = "object" ]; then
    content_type="text/plain"
  fi
  jq -n \\
    --arg checksum "$checksum" \\
    --arg contentType "$content_type" \\
    --argjson bytes "$bytes" \\
    '{
      VersionId: "receipt-version-1",
      ChecksumSHA256: $checksum,
      ServerSideEncryption: "AES256",
      ContentLength: $bytes,
      ContentType: $contentType,
      Metadata: {
        environment: "staging",
        "intent-id": env.FAKE_INTENT_ID,
        kind: "receipt"
      }
    }'
}
emit_control_metadata() {
  local source="$1"
  local checksum bytes
  checksum="$(
    openssl dgst -sha256 -binary "$source" | base64 -w0
  )"
  bytes="$(wc -c <"$source")"
  jq -n \\
    --arg checksum "$checksum" \\
    --argjson bytes "$bytes" \\
    '{
      VersionId: "control-version-1",
      ChecksumSHA256: $checksum,
      ServerSideEncryption: "AES256",
      ContentLength: $bytes,
      ContentType: "application/json",
      Metadata: {
        environment: "staging",
        "intent-id": env.FAKE_INTENT_ID,
        kind: "control-proof"
      }
    }'
}
test "$(arg_value --bucket "$@")" = "$FAKE_ARTIFACT_BUCKET"
test "$(arg_value --expected-bucket-owner "$@")" = "$AWS_ACCOUNT_ID"
key="$(arg_value --key "$@")"
if [ "$1 $2" = "s3api get-object" ]; then
  target="\${!#}"
  if [ "$key" = "$FAKE_LEDGER_KEY" ]; then
    if has_arg --version-id "$@"; then
      test "$(arg_value --version-id "$@")" = \\
        "$FAKE_RECOVERING_VERSION_ID"
      test "$(arg_value --checksum-mode "$@")" = "ENABLED"
      emit_ledger_get \\
        "$FAKE_HISTORICAL_LEDGER" \\
        "$target" \\
        "$FAKE_RECOVERING_REVISION"
    else
      emit_ledger_get \\
        "$FAKE_LEDGER_STATE" \\
        "$target" \\
        "$(cat "$FAKE_LEDGER_REVISION")"
    fi
    exit 0
  fi
  if [ "$key" = "$FAKE_CONTROL_PROOF_KEY" ]; then
    test "$(arg_value --version-id "$@")" = "control-version-1"
    test "$(arg_value --checksum-mode "$@")" = "ENABLED"
    cp -- "$FAKE_CONTROL_PROOF_OBJECT" "$target"
    if [ "$FAKE_FINALIZER_MODE" = "control-readback" ]; then
      printf ' ' >>"$target"
    fi
    emit_control_metadata "$target"
    exit 0
  fi
  test "$key" = "$FAKE_RECEIPT_KEY"
  test "$(arg_value --version-id "$@")" = "receipt-version-1"
  test "$(arg_value --checksum-mode "$@")" = "ENABLED"
  cp -- "$FAKE_RECEIPT_OBJECT" "$target"
  if [ "$FAKE_FINALIZER_MODE" = "readback" ]; then
    printf ' ' >>"$target"
  fi
  if [ "$FAKE_FINALIZER_MODE" = "response-stream" ]; then
    emit_receipt_metadata "$target"
  fi
  emit_receipt_metadata "$target"
  exit 0
fi
if [ "$1 $2" = "s3api head-object" ]; then
  if [ "$key" = "$FAKE_CONTROL_PROOF_KEY" ]; then
    if has_arg --version-id "$@"; then
      test "$(arg_value --version-id "$@")" = "control-version-1"
    fi
    test "$(arg_value --checksum-mode "$@")" = "ENABLED"
    emit_control_metadata "$FAKE_CONTROL_PROOF_OBJECT"
    exit 0
  fi
  test "$key" = "$FAKE_RECEIPT_KEY"
  test "$(arg_value --version-id "$@")" = "receipt-version-1"
  test "$(arg_value --checksum-mode "$@")" = "ENABLED"
  emit_receipt_metadata "$FAKE_RECEIPT_OBJECT"
  exit 0
fi
if [ "$1 $2" = "s3api put-object" ]; then
  body="$(arg_value --body "$@")"
  test "$(arg_value --server-side-encryption "$@")" = "AES256"
  test "$(arg_value --content-type "$@")" = "application/json"
  if [ "$key" = "$FAKE_RECEIPT_KEY" ]; then
    test "$(arg_value --if-none-match "$@")" = "*"
    ! has_arg --if-match "$@"
    test "$(arg_value --metadata "$@")" = \\
      "environment=staging,intent-id=$FAKE_INTENT_ID,kind=receipt"
    cp -- "$body" "$FAKE_RECEIPT_OBJECT"
    checksum="$(
      openssl dgst -sha256 -binary "$FAKE_RECEIPT_OBJECT" | base64 -w0
    )"
    test "$(arg_value --checksum-sha256 "$@")" = "$checksum"
    jq -n \\
      --arg checksum "$checksum" \\
      '{
        VersionId: "receipt-version-1",
        ChecksumSHA256: $checksum,
        ServerSideEncryption: "AES256"
    }'
    exit 0
  fi
  if [ "$key" = "$FAKE_CONTROL_PROOF_KEY" ]; then
    test "$(arg_value --if-none-match "$@")" = "*"
    ! has_arg --if-match "$@"
    test "$(arg_value --metadata "$@")" = \\
      "environment=staging,intent-id=$FAKE_INTENT_ID,kind=control-proof"
    cp -- "$body" "$FAKE_CONTROL_PROOF_OBJECT"
    checksum="$(
      openssl dgst -sha256 -binary "$FAKE_CONTROL_PROOF_OBJECT" |
        base64 -w0
    )"
    test "$(arg_value --checksum-sha256 "$@")" = "$checksum"
    jq -n \\
      --arg checksum "$checksum" \\
      '{
        VersionId: "control-version-1",
        ChecksumSHA256: $checksum,
        ServerSideEncryption: "AES256"
      }'
    exit 0
  fi
  test "$key" = "$FAKE_LEDGER_KEY"
  revision="$(cat "$FAKE_LEDGER_REVISION")"
  etag="$(printf '%032x' "$revision")"
  test "$(arg_value --if-match "$@")" = "\\"$etag\\""
  ! has_arg --if-none-match "$@"
  test "$(arg_value --metadata "$@")" = \\
    "environment=staging,kind=recovery-ledger"
  if [ "$FAKE_FINALIZER_MODE" != "terminal-hard-fail" ]; then
    cp -- "$body" "$FAKE_LEDGER_STATE"
    revision="$((revision + 1))"
    printf '%s' "$revision" >"$FAKE_LEDGER_REVISION"
    if [ "$FAKE_FINALIZER_MODE" = "ambiguous-wrong-previous" ]; then
      temporary="$(mktemp)"
      jq --arg wrong "$FAKE_WRONG_PREVIOUS_SHA256" \\
        '.previousLedgerSha256 = $wrong' \\
        "$FAKE_LEDGER_STATE" >"$temporary"
      mv -- "$temporary" "$FAKE_LEDGER_STATE"
    fi
  fi
  if [ "$FAKE_FINALIZER_MODE" = "ambiguous-exact" ] ||
     [ "$FAKE_FINALIZER_MODE" = "ambiguous-wrong-previous" ] ||
     [ "$FAKE_FINALIZER_MODE" = "terminal-hard-fail" ]; then
    echo "simulated ambiguous terminal CAS response" >&2
    exit 254
  fi
  checksum="$(
    openssl dgst -sha256 -binary "$FAKE_LEDGER_STATE" | base64 -w0
  )"
  jq -n \\
    --arg checksum "$checksum" \\
    --arg versionId "ledger-version-$revision" \\
    '{
      VersionId: $versionId,
      ChecksumSHA256: $checksum,
      ServerSideEncryption: "AES256"
    }'
  exit 0
fi
exit 97
`
  );

  const intentId = String(base.receipt.intentId);
  const archive = base.receipt.archive as Record<string, unknown>;
  const recoveringEtag = `"${(4).toString(16).padStart(32, "0")}"`;
  const recoveringVersionId = "ledger-version-4";
  const updatedAt = Math.floor(Date.now() / 1000) - 10;
  const rawLedger = {
    archiveBucket: archive.bucket,
    archiveKey: archive.key,
    archiveSha256: archive.sha256,
    archiveVersionId: archive.versionId,
    candidateSha: base.receipt.candidateSha,
    controlProofBucket: null,
    controlProofKey: null,
    controlProofSha256: null,
    controlProofVersionId: null,
    environment: ENVIRONMENT,
    intentId,
    leaseOwner: RECOVERY_LEASE_OWNER,
    leaseUntil: updatedAt + 7_200,
    manifestSha256: base.receipt.manifestSha256,
    previousLedgerEtag: `"${"3".repeat(32)}"`,
    previousLedgerSha256: "b".repeat(64),
    previousLedgerVersionId: "ledger-version-3",
    receiptBucket: null,
    receiptKey: null,
    receiptSha256: null,
    receiptVersionId: null,
    schema: "archon.recovery-intent.ledger",
    sourceCiRunAttempt: SOURCE_CI_RUN_ATTEMPT,
    sourceCiRunId: SOURCE_CI_RUN_ID,
    sourceRunAttempt: SOURCE_DEPLOY_RUN_ATTEMPT,
    sourceRunId: SOURCE_DEPLOY_RUN_ID,
    state: "RECOVERING",
    updatedAt,
    version: 1,
  };
  writeCanonicalJson(ledgerState, rawLedger);
  cpSync(ledgerState, historicalLedger);
  const recoveringSha256 = sha256File(ledgerState);
  const receipt = base.receipt;
  const recoveringLedger = receipt.recoveringLedger as Record<
    string,
    unknown
  >;
  recoveringLedger.etag = recoveringEtag;
  recoveringLedger.leaseUntil = updatedAt + 7_200;
  recoveringLedger.sha256 = recoveringSha256;
  recoveringLedger.updatedAt = updatedAt;
  recoveringLedger.versionId = recoveringVersionId;
  writeCanonicalJson(base.receiptFile, receipt);
  const receiptSha256 = sha256File(base.receiptFile);
  const receiptKey =
    `candidates/recovery/${ENVIRONMENT}/receipts/${intentId}/` +
    `${receiptSha256}.json`;
  writeCanonicalJson(executionFile, {
    environment: ENVIRONMENT,
    intentId,
    ok: true,
    receiptSha256,
    schema: "archon.durable-recovery.execution",
    version: 2,
  });

  const verificationEnv: NodeJS.ProcessEnv = {
    ...base.verificationEnv,
    FAKE_ARTIFACT_BUCKET: ARTIFACT_BUCKET,
    FAKE_CONTROL_PROOF_KEY: controlProofKey,
    FAKE_CONTROL_PROOF_OBJECT: controlProofObject,
    FAKE_FINALIZER_CALL_LOG: callLog,
    FAKE_FINALIZER_MODE: mode,
    FAKE_HISTORICAL_LEDGER: historicalLedger,
    FAKE_INTENT_ID: intentId,
    FAKE_LEDGER_KEY:
      `candidates/recovery/${ENVIRONMENT}/ledger.json`,
    FAKE_LEDGER_REVISION: ledgerRevision,
    FAKE_LEDGER_STATE: ledgerState,
    FAKE_REAL_RECEIPT_VERIFIER: VERIFY_RECEIPT,
    FAKE_RECOVERING_REVISION: "4",
    FAKE_RECOVERING_VERSION_ID: recoveringVersionId,
    FAKE_RECEIPT_KEY: receiptKey,
    FAKE_RECEIPT_OBJECT: receiptObject,
    FAKE_WRONG_PREVIOUS_SHA256: "d".repeat(64),
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    RUNNER_TEMP: fixture,
  };
  delete verificationEnv.EXPECTED_RECOVERY_RECEIPT_SHA256;
  delete verificationEnv.RECOVERY_LEDGER_FILE;
  delete verificationEnv.RECOVERY_MANIFEST_FILE;
  return {
    bundleDir: fixture,
    callLog,
    controlProofFile,
    controlProofKey,
    controlProofObject,
    executionFile,
    fixture,
    historicalLedger,
    ledgerState,
    receiptFile: base.receiptFile,
    receiptKey,
    receiptObject,
    recoveringEtag,
    recoveringSha256,
    recoveringVersionId,
    verificationEnv,
  };
}

function runFinalizer(
  fixture: FinalizerFixture
): SpawnSyncReturns<string> {
  return runBash(
    FINALIZE_RECEIPT,
    [
      fixture.bundleDir,
      fixture.receiptFile,
      fixture.executionFile,
      fixture.controlProofFile,
    ],
    fixture.fixture,
    fixture.verificationEnv
  );
}

function finalizerCalls(fixture: FinalizerFixture): string[] {
  return readFileSync(fixture.callLog, "utf8")
    .split(/\r?\n/u)
    .filter((line) => line.length > 0);
}

test(
  "finalizer binds execution, immutable readback, and exact recovering revision",
  { skip: process.platform === "win32" },
  () => {
    const fixture = createFinalizerFixture();
    try {
      const result = runFinalizer(fixture);
      assertSucceeded(result);
      const finalization = JSON.parse(result.stdout) as Record<
        string,
        unknown
      >;
      assert.equal(finalization.schema, "archon.durable-recovery.finalization");
      assert.equal(finalization.version, 1);
      const receipt = finalization.receipt as Record<string, unknown>;
      assert.equal(receipt.key, fixture.receiptKey);
      assert.equal(receipt.versionId, "receipt-version-1");
      assert.equal(receipt.sha256, sha256File(fixture.receiptFile));
      const controlProof = finalization.controlProof as Record<
        string,
        Record<string, unknown>
      >;
      assert.deepEqual(controlProof.proof, {
        evidence: "live-control-plane",
        identityState: "absent",
        mode: "recover",
        schema: "archon.cloudformation-controls.proof",
        version: 1,
      });
      assert.equal(controlProof.object.bucket, ARTIFACT_BUCKET);
      assert.equal(controlProof.object.key, fixture.controlProofKey);
      assert.equal(
        controlProof.object.sha256,
        sha256File(fixture.controlProofFile)
      );
      assert.equal(
        controlProof.object.versionId,
        "control-version-1"
      );
      const terminal = finalization.terminalLedger as Record<string, unknown>;
      assert.equal(terminal.state, "RECOVERED");
      assert.equal(terminal.previousEtag, fixture.recoveringEtag);
      assert.equal(terminal.previousSha256, fixture.recoveringSha256);
      assert.equal(
        terminal.previousVersionId,
        fixture.recoveringVersionId
      );

      const storedTerminal = JSON.parse(
        readFileSync(fixture.ledgerState, "utf8")
      ) as Record<string, unknown>;
      assert.equal(storedTerminal.state, "RECOVERED");
      assert.equal(storedTerminal.receiptKey, fixture.receiptKey);
      assert.equal(
        storedTerminal.receiptSha256,
        sha256File(fixture.receiptFile)
      );
      assert.equal(storedTerminal.controlProofBucket, ARTIFACT_BUCKET);
      assert.equal(storedTerminal.controlProofKey, fixture.controlProofKey);
      assert.equal(
        storedTerminal.controlProofSha256,
        sha256File(fixture.controlProofFile)
      );
      assert.equal(
        storedTerminal.controlProofVersionId,
        "control-version-1"
      );
      assert.equal(
        storedTerminal.previousLedgerEtag,
        fixture.recoveringEtag
      );
      assert.equal(
        storedTerminal.previousLedgerSha256,
        fixture.recoveringSha256
      );
      assert.equal(
        storedTerminal.previousLedgerVersionId,
        fixture.recoveringVersionId
      );

      const calls = finalizerCalls(fixture);
      const verifierCalls = calls
        .map((call, index) => ({ call, index }))
        .filter(({ call }) => call.startsWith("verify "));
      assert.equal(verifierCalls.length, 2);
      const receiptPut = calls.findIndex(
        (call) =>
          call.startsWith("aws s3api put-object") &&
          call.includes(`--key ${fixture.receiptKey}`)
      );
      const receiptGet = calls.findIndex(
        (call) =>
          call.startsWith("aws s3api get-object") &&
          call.includes(`--key ${fixture.receiptKey}`)
      );
      const controlPut = calls.findIndex(
        (call) =>
          call.startsWith("aws s3api put-object") &&
          call.includes(`--key ${fixture.controlProofKey}`)
      );
      const controlGet = calls.findIndex(
        (call) =>
          call.startsWith("aws s3api get-object") &&
          call.includes(`--key ${fixture.controlProofKey}`)
      );
      const ledgerPut = calls.findIndex(
        (call) =>
          call.startsWith("aws s3api put-object") &&
          call.includes("--key candidates/recovery/staging/ledger.json")
      );
      assert.ok((verifierCalls[0]?.index ?? -1) < receiptPut);
      assert.ok(receiptPut < controlPut);
      assert.ok(controlPut < receiptGet);
      assert.ok(receiptGet < (verifierCalls[1]?.index ?? -1));
      assert.ok((verifierCalls[1]?.index ?? -1) < controlGet);
      assert.ok(controlGet < ledgerPut);
      assert.match(calls[receiptPut] ?? "", /--if-none-match \*/u);
      assert.doesNotMatch(calls[receiptPut] ?? "", /--if-match/u);
      assert.match(calls[controlPut] ?? "", /--if-none-match \*/u);
      assert.doesNotMatch(calls[controlPut] ?? "", /--if-match/u);
      assert.match(
        calls[receiptGet] ?? "",
        /--version-id receipt-version-1/u
      );
      assert.match(calls[receiptGet] ?? "", /--checksum-mode ENABLED/u);
      assert.match(
        calls[controlGet] ?? "",
        /--version-id control-version-1/u
      );
      assert.match(calls[controlGet] ?? "", /--checksum-mode ENABLED/u);
    } finally {
      rmSync(fixture.fixture, { recursive: true, force: true });
    }
  }
);

test(
  "RECOVERED terminal ledger re-arms with its complete exact provenance",
  { skip: process.platform === "win32" },
  () => {
    const fixture = createFinalizerFixture();
    try {
      const finalized = runFinalizer(fixture);
      assertSucceeded(finalized);
      const terminal = (
        JSON.parse(finalized.stdout) as Record<string, unknown>
      ).terminalLedger as Record<string, unknown>;
      const nextIntentId = "4".repeat(64);
      const rearmed = runBash(
        RECOVERY_LEDGER,
        ["arm"],
        fixture.fixture,
        {
          ...fixture.verificationEnv,
          CANDIDATE_SHA,
          RECOVERY_ARCHIVE_BUCKET: ARTIFACT_BUCKET,
          RECOVERY_ARCHIVE_KEY:
            `candidates/recovery/${ENVIRONMENT}/${nextIntentId}.tar`,
          RECOVERY_ARCHIVE_SHA256: "5".repeat(64),
          RECOVERY_ARCHIVE_VERSION_ID: "archive-version-next",
          RECOVERY_INTENT_ID: nextIntentId,
          RECOVERY_MANIFEST_SHA256: "6".repeat(64),
          SOURCE_CI_RUN_ATTEMPT,
          SOURCE_CI_RUN_ID,
          SOURCE_DEPLOY_RUN_ATTEMPT,
          SOURCE_DEPLOY_RUN_ID,
        }
      );
      assertSucceeded(rearmed);
      const armed = JSON.parse(rearmed.stdout) as Record<string, unknown>;
      assert.equal(armed.state, "ARMED");
      assert.equal(armed.intentId, nextIntentId);
      assert.equal(armed.previousLedgerEtag, terminal.etag);
      assert.equal(armed.previousLedgerSha256, terminal.sha256);
      assert.equal(armed.previousLedgerVersionId, terminal.versionId);
      for (const field of [
        "controlProofBucket",
        "controlProofKey",
        "controlProofSha256",
        "controlProofVersionId",
      ]) {
        assert.equal(armed[field], null);
      }
    } finally {
      rmSync(fixture.fixture, { recursive: true, force: true });
    }
  }
);

test(
  "finalizer binds exact existing-stack protection and drift controls",
  { skip: process.platform === "win32" },
  () => {
    const fixture = createFinalizerFixture("success", "existing");
    try {
      const result = runFinalizer(fixture);
      assertSucceeded(result);
      const finalization = JSON.parse(result.stdout) as Record<
        string,
        Record<string, Record<string, unknown>>
      >;
      assert.equal(
        finalization.controlProof.proof.identityState,
        "existing"
      );
      const storedControls = JSON.parse(
        readFileSync(fixture.controlProofObject, "utf8")
      ) as Record<string, unknown>;
      const protection = storedControls.protection as Record<
        string,
        unknown
      >;
      const drift = storedControls.drift as Record<string, unknown>;
      assert.deepEqual(protection, {
        action: "verified",
        enabled: true,
      });
      assert.equal(drift.detectionStatus, "DETECTION_COMPLETE");
      assert.equal(drift.stackDriftStatus, "IN_SYNC");
      assert.equal(drift.driftedResourceCount, 0);
    } finally {
      rmSync(fixture.fixture, { recursive: true, force: true });
    }
  }
);

test(
  "exact RECOVERED finalization replays without another immutable write or CAS",
  { skip: process.platform === "win32" },
  () => {
    const fixture = createFinalizerFixture();
    try {
      const first = runFinalizer(fixture);
      assertSucceeded(first);
      const terminalAfterFirst = readFileSync(fixture.ledgerState, "utf8");
      const controlAfterFirst = readFileSync(
        fixture.controlProofObject,
        "utf8"
      );
      const firstProof = JSON.parse(first.stdout) as Record<
        string,
        unknown
      >;

      const replay = runFinalizer(fixture);
      assertSucceeded(replay);
      assert.deepEqual(
        JSON.parse(replay.stdout),
        firstProof
      );
      assert.equal(
        readFileSync(fixture.ledgerState, "utf8"),
        terminalAfterFirst
      );
      assert.equal(
        readFileSync(fixture.controlProofObject, "utf8"),
        controlAfterFirst
      );

      const calls = finalizerCalls(fixture);
      const receiptPuts = calls.filter(
        (call) =>
          call.startsWith("aws s3api put-object") &&
          call.includes(`--key ${fixture.receiptKey}`)
      );
      const ledgerPuts = calls.filter(
        (call) =>
          call.startsWith("aws s3api put-object") &&
          call.includes("--key candidates/recovery/staging/ledger.json")
      );
      const controlPuts = calls.filter(
        (call) =>
          call.startsWith("aws s3api put-object") &&
          call.includes(`--key ${fixture.controlProofKey}`)
      );
      const historicalReads = calls.filter(
        (call) =>
          call.startsWith("aws s3api get-object") &&
          call.includes("--key candidates/recovery/staging/ledger.json") &&
          call.includes(`--version-id ${fixture.recoveringVersionId}`)
      );
      assert.equal(receiptPuts.length, 1);
      assert.equal(controlPuts.length, 1);
      assert.equal(ledgerPuts.length, 1);
      assert.equal(historicalReads.length, 1);

      const historicalJson = readFileSync(
        fixture.historicalLedger,
        "utf8"
      );
      writeFileSync(
        fixture.historicalLedger,
        `${historicalJson}${historicalJson}`,
        "utf8"
      );
      const streamedHistory = runFinalizer(fixture);
      assert.notEqual(streamedHistory.status, 0);
      assert.match(
        streamedHistory.stderr,
        /must contain exactly one JSON object/u
      );
      assert.equal(
        readFileSync(fixture.ledgerState, "utf8"),
        terminalAfterFirst
      );
      const callsAfterStream = finalizerCalls(fixture);
      assert.equal(
        callsAfterStream.filter(
          (call) =>
            call.startsWith("aws s3api put-object") &&
            call.includes(`--key ${fixture.receiptKey}`)
        ).length,
        1
      );
      assert.equal(
        callsAfterStream.filter(
          (call) =>
            call.startsWith("aws s3api put-object") &&
            call.includes(`--key ${fixture.controlProofKey}`)
        ).length,
        1
      );
      assert.equal(
        callsAfterStream.filter(
          (call) =>
            call.startsWith("aws s3api put-object") &&
            call.includes(
              "--key candidates/recovery/staging/ledger.json"
            )
        ).length,
        1
      );
    } finally {
      rmSync(fixture.fixture, { recursive: true, force: true });
    }
  }
);

test(
  "finalizer rejects execution and control-proof JSON streams before AWS access",
  { skip: process.platform === "win32" },
  () => {
    const fixture = createFinalizerFixture();
    try {
      const execution = readFileSync(fixture.executionFile, "utf8");
      writeFileSync(
        fixture.executionFile,
        `${execution}${execution}`,
        "utf8"
      );
      const result = runFinalizer(fixture);
      assert.notEqual(result.status, 0);
      assert.match(
        result.stderr,
        /must contain exactly one JSON object/u
      );
      assert.deepEqual(finalizerCalls(fixture), []);

      writeFileSync(fixture.executionFile, execution, "utf8");
      const controls = readFileSync(fixture.controlProofFile, "utf8");
      writeFileSync(
        fixture.controlProofFile,
        `${controls}${controls}`,
        "utf8"
      );
      const controlResult = runFinalizer(fixture);
      assert.notEqual(controlResult.status, 0);
      assert.match(
        controlResult.stderr,
        /must contain exactly one JSON object/u
      );
      assert.deepEqual(finalizerCalls(fixture), []);
    } finally {
      rmSync(fixture.fixture, { recursive: true, force: true });
    }
  }
);

test(
  "ambiguous terminal CAS succeeds only after an exact RECOVERED read",
  { skip: process.platform === "win32" },
  () => {
    const fixture = createFinalizerFixture("ambiguous-exact");
    try {
      const result = runFinalizer(fixture);
      assertSucceeded(result);
      const finalization = JSON.parse(result.stdout) as Record<
        string,
        unknown
      >;
      const terminal = finalization.terminalLedger as Record<string, unknown>;
      assert.equal(terminal.state, "RECOVERED");
      assert.equal(terminal.previousEtag, fixture.recoveringEtag);
      assert.equal(terminal.previousSha256, fixture.recoveringSha256);
      const calls = finalizerCalls(fixture);
      assert.ok(
        calls.some(
          (call) =>
            call.startsWith("aws s3api get-object") &&
            call.includes("--key candidates/recovery/staging/ledger.json")
        )
      );
      assert.equal(
        calls.filter((call) => call.startsWith("sleep ")).length,
        0
      );
    } finally {
      rmSync(fixture.fixture, { recursive: true, force: true });
    }
  }
);

test(
  "finalizer fails closed on receipt, controls, readback, response streams, and prior-ledger tampering",
  { skip: process.platform === "win32" },
  () => {
    const scenarios = [
      "execution",
      "receipt",
      "controls",
      "object",
      "readback",
      "control-readback",
      "response-stream",
      "previous-ledger",
    ] as const;
    for (const scenario of scenarios) {
      const mode =
        scenario === "object"
          ? "object"
          : scenario === "readback"
            ? "readback"
            : scenario === "control-readback"
              ? "control-readback"
              : scenario === "response-stream"
                ? "response-stream"
                : scenario === "previous-ledger"
                  ? "ambiguous-wrong-previous"
                  : "success";
      const fixture = createFinalizerFixture(mode);
      try {
        if (scenario === "execution") {
          const execution = JSON.parse(
            readFileSync(fixture.executionFile, "utf8")
          ) as Record<string, unknown>;
          execution.receiptSha256 = "0".repeat(64);
          writeCanonicalJson(fixture.executionFile, execution);
        }
        if (scenario === "receipt") {
          const receipt = JSON.parse(
            readFileSync(fixture.receiptFile, "utf8")
          ) as Record<string, unknown>;
          const proofs = receipt.proofs as Record<
            string,
            Record<string, unknown>
          >;
          const stack = proofs.stack;
          const absence = stack.absence as Record<string, unknown>;
          absence.vendedApiLog = false;
          writeCanonicalJson(fixture.receiptFile, receipt);
          const execution = JSON.parse(
            readFileSync(fixture.executionFile, "utf8")
          ) as Record<string, unknown>;
          execution.receiptSha256 = sha256File(fixture.receiptFile);
          writeCanonicalJson(fixture.executionFile, execution);
        }
        if (scenario === "controls") {
          const controls = JSON.parse(
            readFileSync(fixture.controlProofFile, "utf8")
          ) as Record<string, unknown>;
          controls.mode = "audit";
          writeCanonicalJson(fixture.controlProofFile, controls);
        }
        const result = runFinalizer(fixture);
        assert.notEqual(result.status, 0, scenario);
        const calls = finalizerCalls(fixture);
        const receiptPut = calls.find(
          (call) =>
            call.startsWith("aws s3api put-object") &&
            call.includes("/receipts/")
        );
        const ledgerPut = calls.find(
          (call) =>
            call.startsWith("aws s3api put-object") &&
            call.includes("--key candidates/recovery/staging/ledger.json")
        );
        const controlPut = calls.find(
          (call) =>
            call.startsWith("aws s3api put-object") &&
            call.includes(`--key ${fixture.controlProofKey}`)
        );
        if (scenario === "execution") {
          assert.equal(calls.length, 0);
        }
        if (scenario === "receipt" || scenario === "controls") {
          assert.equal(receiptPut, undefined);
          assert.equal(controlPut, undefined);
        }
        if (
          scenario === "execution" ||
          scenario === "receipt" ||
          scenario === "controls" ||
          scenario === "object" ||
          scenario === "readback" ||
          scenario === "control-readback" ||
          scenario === "response-stream"
        ) {
          assert.equal(ledgerPut, undefined);
        }
        if (scenario === "previous-ledger") {
          assert.notEqual(ledgerPut, undefined);
          const terminal = JSON.parse(
            readFileSync(fixture.ledgerState, "utf8")
          ) as Record<string, unknown>;
          assert.equal(terminal.state, "RECOVERED");
          assert.notEqual(
            terminal.previousLedgerSha256,
            fixture.recoveringSha256
          );
        }
      } finally {
        rmSync(fixture.fixture, { recursive: true, force: true });
      }
    }
  }
);

test("both recovery jobs terminalize through the finalizer after fresh OIDC", () => {
  const workflow = readFileSync(RECOVERY_WORKFLOW, "utf8");
  const finalizerCalls = [
    ...workflow.matchAll(
      /bash aws\/finalize-durable-recovery-receipt\.sh/gmu
    ),
  ];
  assert.equal(finalizerCalls.length, 2);
  for (const environment of ["staging", "production"] as const) {
    const refresh = workflow.indexOf(
      `- name: Refresh credentials for ${environment} recovery terminalization`
    );
    const terminal = workflow.indexOf(
      `- name: Persist receipt and mark ${environment} recovered atomically`
    );
    const call = workflow.indexOf(
      "bash aws/finalize-durable-recovery-receipt.sh",
      terminal
    );
    assert.notEqual(refresh, -1);
    assert.notEqual(terminal, -1);
    assert.notEqual(call, -1);
    assert.ok(refresh < terminal);
    assert.ok(terminal < call);
    const refreshBlock = workflow.slice(refresh, terminal);
    assert.match(
      refreshBlock,
      /uses: aws-actions\/configure-aws-credentials@[0-9a-f]{40}/u
    );
    assert.match(refreshBlock, /role-duration-seconds: 3600/u);
    const terminalBlock = workflow.slice(
      terminal,
      environment === "staging"
        ? workflow.indexOf(
            "- name: Upload supplemental staging recovery receipt",
            terminal
          )
        : workflow.indexOf(
            "- name: Upload supplemental production recovery receipt",
            terminal
          )
    );
    assert.match(
      terminalBlock,
      /RECOVERY_CODE_SHA: \$\{\{ github\.sha \}\}/u
    );
    assert.match(
      terminalBlock,
      /"\$receipt"\s*\\[\r\n]+\s*"\$execution"\s*\\[\r\n]+\s*"\$controls"\s*>\s*"\$finalization"/u
    );
  }
});
