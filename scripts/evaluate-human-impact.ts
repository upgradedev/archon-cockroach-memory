/**
 * Pipeline-only human-evaluation and quantified business-impact evidence gate.
 *
 * Raw qualified-study records are read from RUNNER_TEMP and are never uploaded by
 * this program. Only aggregate results, a disclosure-safe input manifest, and a
 * canonical SHA-256-sealed receipt are written beneath RUNNER_TEMP.
 */

import { createHash } from "node:crypto";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  canonicalJson,
  evaluateHumanImpact,
  sha256,
} from "../src/evaluation/human-impact.js";

interface Arguments {
  input: string;
  output: string;
  sourceSha: string;
}

function fail(message: string): never {
  throw new Error(message);
}

function parseArguments(argv: readonly string[]): Arguments {
  if (argv[0] !== "evaluate") {
    fail("Usage: evaluate-human-impact.ts evaluate --input FILE --output DIR --source-sha SHA");
  }
  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || values.has(key)) {
      fail("Human-impact evaluator arguments are malformed or duplicated.");
    }
    values.set(key, value);
  }
  const expected = ["--input", "--output", "--source-sha"];
  if (
    values.size !== expected.length ||
    expected.some((key) => !values.has(key))
  ) {
    fail("Human-impact evaluator requires exact input, output, and source SHA arguments.");
  }
  return {
    input: values.get("--input") as string,
    output: values.get("--output") as string,
    sourceSha: values.get("--source-sha") as string,
  };
}

function assertRunnerOwnedOutput(output: string, runnerTemp: string): string {
  const root = resolve(runnerTemp);
  const target = resolve(output);
  const pathFromRoot = relative(root, target);
  if (
    target === root ||
    pathFromRoot === "" ||
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`) ||
    resolve(root, pathFromRoot) !== target
  ) {
    fail("Output must be a dedicated directory below RUNNER_TEMP.");
  }
  return target;
}

function isBelow(path: string, parent: string): boolean {
  const parentPath = resolve(parent);
  const targetPath = resolve(path);
  const pathFromParent = relative(parentPath, targetPath);
  return (
    targetPath !== parentPath &&
    pathFromParent !== "" &&
    pathFromParent !== ".." &&
    !pathFromParent.startsWith(`..${sep}`) &&
    resolve(parentPath, pathFromParent) === targetPath
  );
}

function canonicalSeal(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

async function writeJson(path: string, value: unknown): Promise<Buffer> {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  return bytes;
}

export async function runHumanImpactEvaluation(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv = process.env
): Promise<{ passed: boolean; receiptPath: string }> {
  if (environment.CI !== "true" || environment.GITHUB_ACTIONS !== "true") {
    fail("Human-impact evidence may run only in GitHub Actions CI.");
  }
  const runnerTemp = environment.RUNNER_TEMP;
  if (!runnerTemp) fail("RUNNER_TEMP is required.");
  const args = parseArguments(argv);
  if (!/^[a-f0-9]{40}$/u.test(args.sourceSha)) fail("source SHA is invalid.");
  const output = assertRunnerOwnedOutput(args.output, runnerTemp);
  const input = resolve(args.input);
  const inputHandle = await open(input, "r");
  let inputBytes: Buffer;
  try {
    const inputMetadata = await inputHandle.stat();
    if (
      !inputMetadata.isFile() ||
      inputMetadata.size < 2 ||
      inputMetadata.size > 2_000_000
    ) {
      fail("Human-impact input must be a bounded regular JSON file.");
    }
    inputBytes = await inputHandle.readFile();
    if (inputBytes.length !== inputMetadata.size) {
      fail("Human-impact input changed while it was being read.");
    }
  } finally {
    await inputHandle.close();
  }
  const inputSha256 = sha256(inputBytes);
  let raw: unknown;
  try {
    raw = JSON.parse(inputBytes.toString("utf8")) as unknown;
  } catch {
    fail("Human-impact input is not valid JSON.");
  }
  const results = evaluateHumanImpact(raw, {
    sourceSha: args.sourceSha,
    inputSha256,
  });
  if (
    results.evidenceTier === "qualified-human-study" &&
    !isBelow(input, runnerTemp)
  ) {
    fail("Qualified human-study input must be ephemeral under RUNNER_TEMP.");
  }
  const approvalReference = environment.HUMAN_IMPACT_APPROVAL_REFERENCE ?? "";
  const approvalReferenceValid =
    /^[A-Za-z0-9][A-Za-z0-9._:/+-]{7,127}$/u.test(approvalReference);
  if (
    results.evidenceTier === "qualified-human-study" &&
    !approvalReferenceValid
  ) {
    fail("Qualified human-study evidence requires a protected approval reference.");
  }
  if (
    results.evidenceTier === "synthetic-pilot" &&
    approvalReference.length !== 0
  ) {
    fail("Synthetic pilot evidence must not carry a human-study approval reference.");
  }

  await mkdir(output, { recursive: false, mode: 0o700 });
  const resultsName = "human-impact-results.json";
  const manifestName = "human-impact-input-manifest.json";
  const receiptName = "human-impact-receipt.json";
  const resultsBytes = await writeJson(resolve(output, resultsName), results);
  const manifest = {
    schema: "archon.human-impact.input-manifest",
    version: 1,
    evidenceTier: results.evidenceTier,
    sourceSha: args.sourceSha,
    input: {
      sha256: inputSha256,
      bytes: inputBytes.length,
      rawDatasetUploaded: false,
      rawReviewerIdsUploaded: false,
      rawParticipantIdsUploaded: false,
      rawRatingsUploaded: false,
      rawTrialsUploaded: false,
      rawExclusionsUploaded: false,
      rawSignaturesUploaded: false,
    },
    cohorts: {
      reviewerCount: results.humanEvaluation.reviewerCount,
      syntheticRaterCount: results.humanEvaluation.syntheticRaterCount,
      participantCount: results.businessImpact.participantCount,
      ratingCount: results.humanEvaluation.ratingCount,
      pairedTrialCount: results.businessImpact.pairedTrialCount,
      exclusionCount: results.humanEvaluation.exclusions.count,
    },
  };
  const manifestBytes = await writeJson(resolve(output, manifestName), manifest);
  const receiptBody = {
    schema: "archon.human-impact.receipt",
    version: 1,
    generatedAt: new Date().toISOString(),
    repository: environment.GITHUB_REPOSITORY ?? "unknown",
    sourceSha: args.sourceSha,
    workflow: {
      runId: environment.GITHUB_RUN_ID ?? "unknown",
      runAttempt: environment.GITHUB_RUN_ATTEMPT ?? "unknown",
    },
    evidenceTier: results.evidenceTier,
    passed: results.passed,
    gates: results.gates,
    claims: results.claims,
    input: {
      sha256: inputSha256,
      bytes: inputBytes.length,
      rawDatasetUploaded: false,
    },
    approval: {
      required: results.evidenceTier === "qualified-human-study",
      referenceProvided: approvalReferenceValid,
      referenceSha256:
        approvalReferenceValid ? sha256(approvalReference) : null,
      rawReferenceStored: false,
    },
    artifacts: [
      {
        file: resultsName,
        sha256: sha256(resultsBytes),
        bytes: resultsBytes.length,
      },
      {
        file: manifestName,
        sha256: sha256(manifestBytes),
        bytes: manifestBytes.length,
      },
    ],
    limitations: results.limitations,
  };
  const receipt = {
    ...receiptBody,
    seal: {
      algorithm: "sha256-canonical-json",
      digest: canonicalSeal(receiptBody),
    },
  };
  const receiptPath = resolve(output, receiptName);
  await writeJson(receiptPath, receipt);

  for (const artifact of receipt.artifacts) {
    if (basename(artifact.file) !== artifact.file) {
      fail("Receipt artifact paths must be basenames.");
    }
    const bytes = await readFile(resolve(output, artifact.file));
    if (sha256(bytes) !== artifact.sha256 || bytes.length !== artifact.bytes) {
      fail(`Receipt artifact seal failed for ${artifact.file}.`);
    }
  }
  const { seal, ...unsealed } = receipt;
  if (canonicalSeal(unsealed) !== seal.digest) fail("Receipt seal verification failed.");
  return { passed: results.passed, receiptPath };
}

async function main(): Promise<void> {
  const result = await runHumanImpactEvaluation(process.argv.slice(2));
  process.stdout.write(
    `${JSON.stringify({ passed: result.passed, receipt: basename(result.receiptPath) })}\n`
  );
  if (!result.passed) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown failure";
    process.stderr.write(`Human-impact evaluation failed: ${message}\n`);
    process.exitCode = 1;
  });
}
