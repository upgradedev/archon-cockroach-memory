import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  ".."
);
const runnerTemp = process.env.RUNNER_TEMP;

if (!runnerTemp) {
  throw new Error(
    "Backend coverage is CI-only: RUNNER_TEMP must identify the ephemeral runner directory."
  );
}

const resolvedRunnerTemp = resolve(runnerTemp);
const lcovPath = resolve(
  resolvedRunnerTemp,
  "archon-coverage",
  "backend",
  "lcov.info"
);
if (!lcovPath.startsWith(`${resolvedRunnerTemp}${sep}`)) {
  throw new Error("Backend coverage destination escaped RUNNER_TEMP.");
}

const packageJson = JSON.parse(
  readFileSync(join(repositoryRoot, "package.json"), "utf8")
);
const canonicalTestCommand = packageJson?.scripts?.test;
if (typeof canonicalTestCommand !== "string") {
  throw new Error("Canonical test command is missing from package.json.");
}

const testFiles =
  canonicalTestCommand.match(/\btests\/[A-Za-z0-9._/-]+\.test\.ts\b/gu) ?? [];
if (
  testFiles.length === 0 ||
  new Set(testFiles).size !== testFiles.length ||
  !testFiles.includes("tests/readiness.test.ts") ||
  !testFiles.includes("tests/hosted-dast.test.ts") ||
  !testFiles.includes("tests/aws-service-semantics.test.ts")
) {
  throw new Error("Canonical backend test inventory is missing or ambiguous.");
}

mkdirSync(dirname(lcovPath), { recursive: true });

const result = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "--test",
    "--experimental-test-coverage",
    "--test-coverage-include=src/**/*.ts",
    "--test-coverage-lines=90",
    "--test-coverage-branches=80",
    "--test-coverage-functions=90",
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    "--test-reporter=lcov",
    `--test-reporter-destination=${lcovPath}`,
    "--test-concurrency=1",
    ...testFiles,
  ],
  {
    cwd: repositoryRoot,
    env: process.env,
    stdio: "inherit",
  }
);

if (result.error) throw result.error;
if (result.signal) {
  throw new Error(`Backend coverage runner terminated by ${result.signal}.`);
}
process.exitCode = result.status ?? 1;
