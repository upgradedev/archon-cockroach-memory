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
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PREFLIGHT = join(
  ROOT,
  "aws",
  "classify-github-recovery-preflight.sh"
);
const REPOSITORY = "upgradedev/archon-cockroach-memory";
const SOURCE_RUN_ID = 8_001;
const SOURCE_RUN_ATTEMPT = 1;
const CANDIDATE_SHA = "a".repeat(40);
const RECOVERY_RUN_ID = 9_001;
const RECOVERY_RUN_ATTEMPT = 2;

interface Fixture {
  awsCallLog: string;
  env: NodeJS.ProcessEnv;
  fixture: string;
  ghCallLog: string;
}

interface FixtureOptions {
  artifacts?: Array<Record<string, unknown>>;
  artifactsTotalCount?: number;
  jobs?: Array<Record<string, unknown>>;
  jobsTotalCount?: number;
  recoveryRun?: Record<string, unknown>;
  runsTotalCount?: number;
  sourceRun?: Record<string, unknown>;
}

function executable(path: string, content: string): void {
  writeFileSync(path, content, "utf8");
  chmodSync(path, 0o755);
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value)}\n`, "utf8");
}

function runPreflight(env: NodeJS.ProcessEnv): SpawnSyncReturns<string> {
  return spawnSync("bash", [PREFLIGHT], {
    cwd: ROOT,
    encoding: "utf8",
    env,
  });
}

function assertSucceeded(result: SpawnSyncReturns<string>): void {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function sourceRun(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    conclusion: "failure",
    event: "push",
    head_branch: "main",
    head_repository: { full_name: REPOSITORY },
    head_sha: CANDIDATE_SHA,
    id: SOURCE_RUN_ID,
    name: "Deploy AWS",
    path: ".github/workflows/deploy-aws.yml",
    repository: { full_name: REPOSITORY },
    run_attempt: SOURCE_RUN_ATTEMPT,
    status: "completed",
    workflow_id: 71,
    ...overrides,
  };
}

function job(
  id: number,
  name: string,
  conclusion: string,
  steps: Array<Record<string, unknown>> = []
): Record<string, unknown> {
  return { conclusion, id, name, status: "completed", steps };
}

function candidateJobs(): Array<Record<string, unknown>> {
  return [
    job(101, "Deploy and smoke staging", "failure", [
      {
        conclusion: "success",
        name: "Persist and arm the immutable staging recovery intent",
      },
      {
        conclusion: "skipped",
        name: "Commit the receipt-bound staging recovery intent",
      },
    ]),
    job(102, "Promote identical candidate to production", "skipped"),
  ];
}

function successfulRecoveryRun(): Record<string, unknown> {
  return {
    conclusion: "success",
    event: "schedule",
    head_branch: "main",
    head_repository: { full_name: REPOSITORY },
    id: RECOVERY_RUN_ID,
    name: "Recover AWS",
    path: ".github/workflows/recover-aws.yml",
    repository: { full_name: REPOSITORY },
    run_attempt: RECOVERY_RUN_ATTEMPT,
    status: "completed",
    workflow_id: 72,
  };
}

function createFixture(options: FixtureOptions = {}): Fixture {
  const fixture = mkdtempSync(join(tmpdir(), "archon-github-preflight-"));
  const fakeBin = join(fixture, "bin");
  const sourceRunFile = join(fixture, "source-run.json");
  const runsFile = join(fixture, "runs.json");
  const jobsFile = join(fixture, "jobs.json");
  const artifactsFile = join(fixture, "artifacts.json");
  const recoveryRunFile = join(fixture, "recovery-run.json");
  const awsCallLog = join(fixture, "aws-calls.log");
  const ghCallLog = join(fixture, "gh-calls.log");
  const exactSourceRun = options.sourceRun ?? sourceRun();
  const jobs = options.jobs ?? candidateJobs();
  const artifacts = options.artifacts ?? [];
  mkdirSync(fakeBin);
  writeFileSync(awsCallLog, "", "utf8");
  writeFileSync(ghCallLog, "", "utf8");
  writeJson(sourceRunFile, exactSourceRun);
  writeJson(runsFile, {
    total_count: options.runsTotalCount ?? 1,
    workflow_runs: [exactSourceRun],
  });
  writeJson(jobsFile, {
    jobs,
    total_count: options.jobsTotalCount ?? jobs.length,
  });
  writeJson(artifactsFile, {
    artifacts,
    total_count: options.artifactsTotalCount ?? artifacts.length,
  });
  writeJson(
    recoveryRunFile,
    options.recoveryRun ?? successfulRecoveryRun()
  );

  executable(
    join(fakeBin, "aws"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$FAKE_AWS_CALL_LOG"
exit 99
`
  );
  executable(
    join(fakeBin, "gh"),
    `#!/usr/bin/env bash
set -euo pipefail
test "$#" -eq 2
test "$1" = "api"
endpoint="$2"
printf '%s\n' "$endpoint" >>"$FAKE_GH_CALL_LOG"
case "$endpoint" in
  "repos/$GITHUB_REPOSITORY/actions/workflows/deploy-aws.yml/runs?branch=main&per_page=100&page=1")
    cat "$FAKE_RUNS_FILE"
    ;;
  "repos/$GITHUB_REPOSITORY/actions/runs/$FAKE_SOURCE_RUN_ID/attempts/$FAKE_SOURCE_RUN_ATTEMPT")
    cat "$FAKE_SOURCE_RUN_FILE"
    ;;
  "repos/$GITHUB_REPOSITORY/actions/runs/$FAKE_SOURCE_RUN_ID/attempts/$FAKE_SOURCE_RUN_ATTEMPT/jobs?per_page=100")
    cat "$FAKE_JOBS_FILE"
    ;;
  "repos/$GITHUB_REPOSITORY/actions/artifacts?per_page=100&page=1")
    cat "$FAKE_ARTIFACTS_FILE"
    ;;
  "repos/$GITHUB_REPOSITORY/actions/runs/$FAKE_RECOVERY_RUN_ID/attempts/$FAKE_RECOVERY_RUN_ATTEMPT")
    cat "$FAKE_RECOVERY_RUN_FILE"
    ;;
  *)
    echo "Unexpected GitHub API lookup: $endpoint" >&2
    exit 98
    ;;
esac
`
  );

  return {
    awsCallLog,
    fixture,
    ghCallLog,
    env: {
      ...process.env,
      FAKE_ARTIFACTS_FILE: artifactsFile,
      FAKE_AWS_CALL_LOG: awsCallLog,
      FAKE_GH_CALL_LOG: ghCallLog,
      FAKE_JOBS_FILE: jobsFile,
      FAKE_RECOVERY_RUN_FILE: recoveryRunFile,
      FAKE_RECOVERY_RUN_ATTEMPT: String(RECOVERY_RUN_ATTEMPT),
      FAKE_RECOVERY_RUN_ID: String(RECOVERY_RUN_ID),
      FAKE_RUNS_FILE: runsFile,
      FAKE_SOURCE_RUN_FILE: sourceRunFile,
      FAKE_SOURCE_RUN_ATTEMPT: String(SOURCE_RUN_ATTEMPT),
      FAKE_SOURCE_RUN_ID: String(SOURCE_RUN_ID),
      GH_TOKEN: "test-token",
      GITHUB_REPOSITORY: REPOSITORY,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    },
  };
}

test(
  "GitHub preflight exits before protected work for an active deploy",
  { skip: process.platform === "win32" },
  () => {
    const fixture = createFixture({
      sourceRun: sourceRun({ conclusion: null, status: "in_progress" }),
    });
    try {
      const result = runPreflight(fixture.env);
      assertSucceeded(result);
      const proof = JSON.parse(result.stdout) as {
        environments: Record<string, Record<string, unknown>>;
      };
      for (const environment of ["staging", "production"]) {
        assert.equal(proof.environments[environment]?.action, "noop");
        assert.equal(
          proof.environments[environment]?.reason,
          "source-deploy-active"
        );
      }
      assert.equal(readFileSync(fixture.awsCallLog, "utf8"), "");
      assert.doesNotMatch(
        readFileSync(fixture.ghCallLog, "utf8"),
        /\/actions\/runs\//u
      );
    } finally {
      rmSync(fixture.fixture, { recursive: true, force: true });
    }
  }
);

test(
  "GitHub preflight fails closed on an unknown listed deploy status",
  { skip: process.platform === "win32" },
  () => {
    const fixture = createFixture({
      sourceRun: sourceRun({ conclusion: null, status: "mystery" }),
    });
    try {
      const result = runPreflight(fixture.env);
      assert.equal(result.error, undefined);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /The Deploy AWS run status is invalid\./u);
      assert.equal(result.stdout, "");
      assert.equal(readFileSync(fixture.awsCallLog, "utf8"), "");
      assert.doesNotMatch(
        readFileSync(fixture.ghCallLog, "utf8"),
        /\/actions\/runs\//u
      );
    } finally {
      rmSync(fixture.fixture, { recursive: true, force: true });
    }
  }
);

test(
  "GitHub preflight fails closed on a truncated workflow-runs response",
  { skip: process.platform === "win32" },
  () => {
    const fixture = createFixture({ runsTotalCount: 2 });
    try {
      const result = runPreflight(fixture.env);
      assert.equal(result.error, undefined);
      assert.notEqual(result.status, 0);
      assert.match(
        result.stderr,
        /The Deploy AWS workflow-runs response is incomplete or ambiguous\./u
      );
      assert.equal(result.stdout, "");
      assert.equal(readFileSync(fixture.awsCallLog, "utf8"), "");
      assert.doesNotMatch(
        readFileSync(fixture.ghCallLog, "utf8"),
        /\/actions\/runs\//u
      );
    } finally {
      rmSync(fixture.fixture, { recursive: true, force: true });
    }
  }
);

test(
  "GitHub preflight fails closed on a truncated jobs response",
  { skip: process.platform === "win32" },
  () => {
    const fixture = createFixture({
      jobsTotalCount: candidateJobs().length + 1,
    });
    try {
      const result = runPreflight(fixture.env);
      assert.equal(result.error, undefined);
      assert.notEqual(result.status, 0);
      assert.match(
        result.stderr,
        /The Deploy AWS jobs response is incomplete or ambiguous\./u
      );
      assert.equal(result.stdout, "");
      assert.equal(readFileSync(fixture.awsCallLog, "utf8"), "");
      const calls = readFileSync(fixture.ghCallLog, "utf8");
      assert.match(calls, /\/jobs\?per_page=100$/mu);
      assert.doesNotMatch(calls, /\/actions\/artifacts\?/u);
    } finally {
      rmSync(fixture.fixture, { recursive: true, force: true });
    }
  }
);

test(
  "GitHub preflight fails closed on a truncated recovery-artifact response",
  { skip: process.platform === "win32" },
  () => {
    const fixture = createFixture({ artifactsTotalCount: 1 });
    try {
      const result = runPreflight(fixture.env);
      assert.equal(result.error, undefined);
      assert.notEqual(result.status, 0);
      assert.match(
        result.stderr,
        /The recovery artifact response is incomplete or ambiguous\./u
      );
      assert.equal(result.stdout, "");
      assert.equal(readFileSync(fixture.awsCallLog, "utf8"), "");
      assert.match(
        readFileSync(fixture.ghCallLog, "utf8"),
        /\/actions\/artifacts\?per_page=100&page=1$/mu
      );
    } finally {
      rmSync(fixture.fixture, { recursive: true, force: true });
    }
  }
);

test(
  "GitHub preflight emits an exact armed uncommitted candidate",
  { skip: process.platform === "win32" },
  () => {
    const fixture = createFixture();
    try {
      const result = runPreflight(fixture.env);
      assertSucceeded(result);
      const proof = JSON.parse(result.stdout) as {
        awsCredentialsUsed: boolean;
        classificationSource: string;
        environments: Record<string, Record<string, unknown>>;
      };
      assert.equal(proof.awsCredentialsUsed, false);
      assert.equal(
        proof.classificationSource,
        "github-actions-metadata-only"
      );
      assert.deepEqual(proof.environments.staging, {
        action: "recover",
        candidateSha: CANDIDATE_SHA,
        reason: "uncommitted-armed-environment-job",
        sourceRunAttempt: String(SOURCE_RUN_ATTEMPT),
        sourceRunId: String(SOURCE_RUN_ID),
      });
      assert.equal(proof.environments.production?.action, "noop");
      assert.equal(readFileSync(fixture.awsCallLog, "utf8"), "");
    } finally {
      rmSync(fixture.fixture, { recursive: true, force: true });
    }
  }
);

test(
  "GitHub preflight accepts the protected staging drill dispatch as a staging-only candidate",
  { skip: process.platform === "win32" },
  () => {
    const fixture = createFixture({
      sourceRun: sourceRun({ event: "workflow_dispatch" }),
    });
    try {
      const result = runPreflight(fixture.env);
      assertSucceeded(result);
      const proof = JSON.parse(result.stdout) as {
        environments: Record<string, Record<string, unknown>>;
      };
      assert.deepEqual(proof.environments.staging, {
        action: "recover",
        candidateSha: CANDIDATE_SHA,
        reason: "uncommitted-armed-environment-job",
        sourceRunAttempt: String(SOURCE_RUN_ATTEMPT),
        sourceRunId: String(SOURCE_RUN_ID),
      });
      assert.equal(proof.environments.production?.action, "noop");
      assert.equal(readFileSync(fixture.awsCallLog, "utf8"), "");
    } finally {
      rmSync(fixture.fixture, { recursive: true, force: true });
    }
  }
);

test(
  "GitHub preflight never promotes dispatch metadata into a production recovery candidate",
  { skip: process.platform === "win32" },
  () => {
    const fixture = createFixture({
      jobs: [
        job(101, "Deploy and smoke staging", "failure", [
          {
            conclusion: "success",
            name: "Persist and arm the immutable staging recovery intent",
          },
          {
            conclusion: "skipped",
            name: "Commit the receipt-bound staging recovery intent",
          },
        ]),
        job(103, "Promote identical candidate to production", "failure", [
          {
            conclusion: "success",
            name: "Persist and arm the immutable production recovery intent",
          },
          {
            conclusion: "skipped",
            name: "Commit the receipt-bound production recovery intent",
          },
        ]),
      ],
      sourceRun: sourceRun({ event: "workflow_dispatch" }),
    });
    try {
      const result = runPreflight(fixture.env);
      assertSucceeded(result);
      const proof = JSON.parse(result.stdout) as {
        environments: Record<string, Record<string, unknown>>;
      };
      assert.equal(proof.environments.staging?.action, "recover");
      assert.deepEqual(proof.environments.production, {
        action: "noop",
        candidateSha: null,
        reason: "no-github-recovery-candidate",
        sourceRunAttempt: null,
        sourceRunId: null,
      });
      assert.equal(readFileSync(fixture.awsCallLog, "utf8"), "");
    } finally {
      rmSync(fixture.fixture, { recursive: true, force: true });
    }
  }
);

test(
  "GitHub preflight preserves trusted legacy workflow-run deploy history",
  { skip: process.platform === "win32" },
  () => {
    const fixture = createFixture({
      sourceRun: sourceRun({ event: "workflow_run" }),
    });
    try {
      const result = runPreflight(fixture.env);
      assertSucceeded(result);
      const proof = JSON.parse(result.stdout) as {
        environments: Record<string, Record<string, unknown>>;
      };
      assert.equal(proof.environments.staging?.action, "recover");
      assert.equal(
        proof.environments.staging?.sourceRunId,
        String(SOURCE_RUN_ID)
      );
      assert.equal(readFileSync(fixture.awsCallLog, "utf8"), "");
    } finally {
      rmSync(fixture.fixture, { recursive: true, force: true });
    }
  }
);

test(
  "GitHub preflight rejects every non-deploy event before protected work",
  { skip: process.platform === "win32" },
  () => {
    const fixture = createFixture({
      sourceRun: sourceRun({ event: "schedule" }),
    });
    try {
      const result = runPreflight(fixture.env);
      assert.equal(result.error, undefined);
      assert.notEqual(result.status, 0);
      assert.equal(readFileSync(fixture.awsCallLog, "utf8"), "");
    } finally {
      rmSync(fixture.fixture, { recursive: true, force: true });
    }
  }
);

test(
  "GitHub preflight suppresses a receipt-bound successful watchdog",
  { skip: process.platform === "win32" },
  () => {
    const artifactName =
      `staging-recovery-receipt-${SOURCE_RUN_ID}-` +
      `${SOURCE_RUN_ATTEMPT}-${RECOVERY_RUN_ID}-${RECOVERY_RUN_ATTEMPT}`;
    const fixture = createFixture({
      artifacts: [
        {
          expired: false,
          id: 501,
          name: artifactName,
          workflow_run: { id: RECOVERY_RUN_ID },
        },
      ],
    });
    try {
      const result = runPreflight(fixture.env);
      assertSucceeded(result);
      const proof = JSON.parse(result.stdout) as {
        environments: Record<string, Record<string, unknown>>;
      };
      assert.equal(proof.environments.staging?.action, "noop");
      assert.equal(
        proof.environments.staging?.reason,
        "successful-recovery-receipt-proved"
      );
      assert.equal(readFileSync(fixture.awsCallLog, "utf8"), "");
      assert.match(
        readFileSync(fixture.ghCallLog, "utf8"),
        new RegExp(
          `/actions/runs/${RECOVERY_RUN_ID}/attempts/` +
            `${RECOVERY_RUN_ATTEMPT}$`,
          "mu"
        )
      );
    } finally {
      rmSync(fixture.fixture, { recursive: true, force: true });
    }
  }
);

test(
  "GitHub preflight accepts a receipt from a trusted legacy workflow-run watchdog",
  { skip: process.platform === "win32" },
  () => {
    const artifactName =
      `staging-recovery-receipt-${SOURCE_RUN_ID}-` +
      `${SOURCE_RUN_ATTEMPT}-${RECOVERY_RUN_ID}-${RECOVERY_RUN_ATTEMPT}`;
    const fixture = createFixture({
      artifacts: [
        {
          expired: false,
          id: 502,
          name: artifactName,
          workflow_run: { id: RECOVERY_RUN_ID },
        },
      ],
      recoveryRun: {
        ...successfulRecoveryRun(),
        event: "workflow_run",
      },
      sourceRun: sourceRun({ event: "workflow_run" }),
    });
    try {
      const result = runPreflight(fixture.env);
      assertSucceeded(result);
      const proof = JSON.parse(result.stdout) as {
        environments: Record<string, Record<string, unknown>>;
      };
      assert.equal(proof.environments.staging?.action, "noop");
      assert.equal(
        proof.environments.staging?.reason,
        "successful-recovery-receipt-proved"
      );
      assert.equal(readFileSync(fixture.awsCallLog, "utf8"), "");
    } finally {
      rmSync(fixture.fixture, { recursive: true, force: true });
    }
  }
);
