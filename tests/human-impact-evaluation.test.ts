import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runHumanImpactEvaluation } from "../scripts/evaluate-human-impact.js";
import {
  evaluateHumanImpact,
  exclusionSignaturePayload,
  ratingSignaturePayload,
  sha256,
  trialSignaturePayload,
  validateHumanImpactDataset,
  type BusinessTrial,
  type HumanRating,
  type Reviewer,
  type StudyDefinition,
  type StudyExclusion,
} from "../src/evaluation/human-impact.js";

const pilotUrl = new URL(
  "../evals/human-impact-synthetic-pilot.json",
  import.meta.url
);
const pilotBytes = await readFile(pilotUrl);
const pilotRaw = JSON.parse(pilotBytes.toString("utf8")) as unknown;
const protocolRaw = JSON.parse(
  await readFile(
    new URL("../evals/human-evaluation-protocol.json", import.meta.url),
    "utf8"
  )
) as {
  minimumPanel: Record<string, unknown>;
  businessOutcomePlan: Record<string, unknown>;
  pipelineImplementation: Record<string, unknown>;
};
const sourceSha = "a".repeat(40);

interface SigningReviewer {
  id: string;
  privateKey: KeyObject;
  publicKeyPem: string;
}

function qualifiedDataset(
  options: { unsafeB4?: boolean; includeExclusion?: boolean } = {}
): Record<string, unknown> {
  const reviewers: SigningReviewer[] = ["aaaaaaaa", "bbbbbbbb", "cccccccc"].map(
    (suffix) => {
      const pair = generateKeyPairSync("ed25519");
      return {
        id: `reviewer-${suffix}`,
        privateKey: pair.privateKey,
        publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
      };
    }
  );
  const study: StudyDefinition = {
    id: "qualified-finance-review-v1",
    protocolSha256: sha256("protocol"),
    preregistrationSha256: sha256("preregistration"),
    collectionAuthoritySha256: sha256("independent-collection-authority"),
    rawEvidenceCustodyReceiptSha256: sha256(
      "independent-raw-evidence-custody-receipt"
    ),
    collectionStartedAt: "2026-07-01T00:00:00.000Z",
    collectionEndedAt: "2026-07-02T00:00:00.000Z",
    provenance: "consenting-pseudonymous-human-study",
    blinding: {
      systemLabelsHidden: true,
      caseOrderRandomized: true,
      armOrderRandomized: true,
    },
  };
  const reviewerRecords: Reviewer[] = reviewers.map(
    ({ id, publicKeyPem }, index) => ({
      id,
      qualification: [
        "finance-professional",
        "finance-researcher",
        "audit-professional",
      ][index] as Reviewer["qualification"],
      independentOfProject: true,
      projectRole: "none",
      consentReceiptSha256: sha256(`reviewer-consent-${index}`),
      identityAttestationSha256: sha256(`reviewer-identity-${index}`),
      publicKeyPem,
    })
  );
  const ratings: HumanRating[] = [];
  for (const [reviewerIndex, reviewer] of reviewers.entries()) {
    for (let caseIndex = 0; caseIndex < 20; caseIndex += 1) {
      for (const arm of ["B2_VECTOR_ONLY", "B4_FULL_LIFECYCLE"] as const) {
        const rating: HumanRating = {
          id: `rating-${reviewerIndex}-${caseIndex}-${arm === "B2_VECTOR_ONLY" ? "b2" : "b4"}`,
          raterId: reviewer.id,
          caseId: `finance-case-${caseIndex}`,
          arm,
          answerSha256: sha256(`${reviewer.id}:${caseIndex}:${arm}`),
          observedAt: `2026-07-01T${String(1 + reviewerIndex).padStart(2, "0")}:${String(
            caseIndex
          ).padStart(2, "0")}:00.000Z`,
          scores:
            arm === "B4_FULL_LIFECYCLE"
              ? {
                  answerCorrectness: 4,
                  evidenceGrounding: 4,
                  uncertaintyCalibration: 4,
                }
              : {
                  answerCorrectness: 2,
                  evidenceGrounding: 2,
                  uncertaintyCalibration: 1,
                },
          actionSafety:
            arm === "B4_FULL_LIFECYCLE"
              ? options.unsafeB4 && reviewerIndex === 0 && caseIndex === 0
                ? "fail"
                : "pass"
              : "fail",
          signature: null,
        };
        rating.signature = sign(
          null,
          ratingSignaturePayload(study, reviewerRecords[reviewerIndex], rating),
          reviewer.privateKey
        ).toString("base64");
        ratings.push(rating);
      }
    }
  }
  const participants = Array.from({ length: 10 }, (_, index) => ({
    id: `participant-${String(index).padStart(8, "0")}`,
    consentReceiptSha256: sha256(`participant-consent-${index}`),
  }));
  const trials: BusinessTrial[] = participants.map((participant, index) => {
    const reviewer = reviewers[index % reviewers.length];
    const trial: BusinessTrial = {
      id: `paired-trial-${index}`,
      participantId: participant.id,
      taskId: `finance-task-${index}`,
      observedAt: `2026-07-01T12:${String(index).padStart(2, "0")}:00.000Z`,
      baseline: {
        durationMs: 600_000 + index * 1_000,
        contradictionMisses: 2,
        reviewerEffortActions: 12,
        unauthorizedActionAttempts: 1,
        correct: false,
      },
      archon: {
        durationMs: 360_000 + index * 1_000,
        contradictionMisses: 0,
        reviewerEffortActions: 7,
        unauthorizedActionAttempts: 0,
        correct: true,
      },
      recordedByReviewerId: reviewer.id,
      signature: null,
    };
    trial.signature = sign(
      null,
      trialSignaturePayload(study, reviewerRecords[index % reviewers.length], trial),
      reviewer.privateKey
    ).toString("base64");
    return trial;
  });
  const exclusions: StudyExclusion[] = [];
  if (options.includeExclusion) {
    const reviewer = reviewers[0];
    const exclusion: StudyExclusion = {
      id: "excluded-withdrawn-trial",
      subjectType: "trial",
      subjectSha256: sha256("independently-retained-withdrawn-trial"),
      reason: "withdrawn-consent",
      observedAt: "2026-07-01T18:00:00.000Z",
      approvedByReviewerId: reviewer.id,
      signature: null,
    };
    exclusion.signature = sign(
      null,
      exclusionSignaturePayload(study, reviewerRecords[0], exclusion),
      reviewer.privateKey
    ).toString("base64");
    exclusions.push(exclusion);
  }
  return {
    schemaVersion: "1.0.0",
    evidenceTier: "qualified-human-study",
    study,
    reviewers: reviewerRecords,
    syntheticRaters: [],
    participants,
    ratings,
    trials,
    exclusions,
  };
}

test("synthetic pilot exercises analysis without creating human or production claims", () => {
  const evaluated = evaluateHumanImpact(structuredClone(pilotRaw), {
    sourceSha,
    inputSha256: sha256(pilotBytes),
  });
  assert.equal(evaluated.passed, true);
  assert.equal(evaluated.evidenceTier, "synthetic-pilot");
  assert.equal(evaluated.humanEvaluation.reviewerCount, 0);
  assert.equal(evaluated.humanEvaluation.syntheticRaterCount, 2);
  assert.equal(evaluated.studyEvidence.rawEvidenceCustodyReceiptSha256, null);
  assert.equal(evaluated.humanEvaluation.pairedRatingCount, 8);
  assert.equal(
    evaluated.humanEvaluation.interRaterAgreement.method,
    "krippendorff-alpha-interval"
  );
  assert.equal(evaluated.businessImpact.pairedTrialCount, 4);
  assert.equal(evaluated.claims.syntheticPilotEvaluated, true);
  assert.equal(evaluated.claims.qualifiedHumanEvaluationCompleted, false);
  assert.equal(evaluated.claims.quantifiedBusinessOutcomeStudyCompleted, false);
  assert.equal(evaluated.claims.productionScaleCorpus, false);
  assert.equal(evaluated.claims.productionBusinessImpact, false);
  assert.ok(
    evaluated.humanEvaluation.metrics.answerCorrectness.pairedDeltaB4MinusB2.mean > 0
  );
  assert.equal(
    evaluated.humanEvaluation.metrics.answerCorrectness.pairedDeltaB4MinusB2
      .confidenceInterval95.method,
    "deterministic-paired-cluster-bootstrap"
  );
  assert.equal(
    evaluated.humanEvaluation.metrics.answerCorrectness.pairedDeltaB4MinusB2.count,
    4
  );
  assert.equal(
    evaluated.humanEvaluation.metrics.answerCorrectness.pairedDeltaB4MinusB2
      .clusterUnit,
    "case"
  );
  assert.equal(
    evaluated.businessImpact.metrics.timeToDecisionMs.improvement.clusterUnit,
    "participant"
  );
  assert.ok(
    evaluated.businessImpact.metrics.timeToDecisionMs.improvement.mean > 0
  );
});

test("machine gate minimums remain aligned with the preregistered protocol", () => {
  assert.equal(protocolRaw.minimumPanel.qualifiedFinanceReviewers, 3);
  assert.equal(protocolRaw.minimumPanel.casesPerReviewer, 20);
  assert.equal(protocolRaw.minimumPanel.doubleRatedCaseFraction, 0.5);
  assert.equal(protocolRaw.businessOutcomePlan.minimumConsentingParticipants, 10);
  assert.equal(
    protocolRaw.pipelineImplementation.workflow,
    ".github/workflows/human-impact-evaluation.yml"
  );
  assert.equal(protocolRaw.pipelineImplementation.rawStudyDataUploaded, false);
  assert.equal(
    protocolRaw.pipelineImplementation.independentRawEvidenceCustodyReceiptRequired,
    true
  );
});

test("input cannot self-attest customer, production, ROI, or human claims", () => {
  const fabricated = structuredClone(pilotRaw) as Record<string, unknown>;
  fabricated.claims = {
    humanEvaluated: true,
    productionCorpus: true,
    customerOutcome: true,
    roi: "500%",
  };
  assert.throws(
    () => validateHumanImpactDataset(fabricated),
    /missing or unsupported fields/u
  );

  const relabelled = structuredClone(pilotRaw) as Record<string, unknown>;
  relabelled.evidenceTier = "production-business-impact";
  assert.throws(
    () => validateHumanImpactDataset(relabelled),
    /production evidence tiers are forbidden/u
  );
});

test("qualified evidence requires three distinct signed independent reviewers", () => {
  const raw = qualifiedDataset();
  const evaluated = evaluateHumanImpact(raw, {
    sourceSha,
    inputSha256: sha256(JSON.stringify(raw)),
  });
  assert.equal(evaluated.passed, true);
  assert.equal(evaluated.humanEvaluation.reviewerCount, 3);
  assert.equal(evaluated.humanEvaluation.distinctCaseCount, 20);
  assert.equal(evaluated.humanEvaluation.pairedRatingCount, 60);
  assert.equal(evaluated.businessImpact.participantCount, 10);
  assert.match(
    evaluated.studyEvidence.rawEvidenceCustodyReceiptSha256 as string,
    /^[a-f0-9]{64}$/u
  );
  assert.equal(evaluated.claims.qualifiedHumanEvaluationCompleted, true);
  assert.equal(evaluated.claims.quantifiedBusinessOutcomeStudyCompleted, true);
  assert.equal(evaluated.claims.productionBusinessImpact, false);
  assert.equal(evaluated.claims.roiOrSavings, false);
});

test("tampered ratings and self-associated reviewers fail closed", () => {
  const tampered = qualifiedDataset();
  const ratings = tampered.ratings as HumanRating[];
  ratings[0].scores.answerCorrectness = 4;
  assert.throws(
    () => validateHumanImpactDataset(tampered),
    /signature is invalid/u
  );

  const alteredStudyContext = qualifiedDataset();
  const study = alteredStudyContext.study as Record<string, unknown>;
  study.preregistrationSha256 = sha256("changed-after-collection");
  assert.throws(
    () => validateHumanImpactDataset(alteredStudyContext),
    /signature is invalid/u
  );

  const alteredReviewerAttestation = qualifiedDataset();
  const attestedReviewers = alteredReviewerAttestation.reviewers as Array<
    Record<string, unknown>
  >;
  attestedReviewers[0].identityAttestationSha256 = sha256(
    "changed-after-rating"
  );
  assert.throws(
    () => validateHumanImpactDataset(alteredReviewerAttestation),
    /signature is invalid/u
  );

  const selfAssociated = qualifiedDataset();
  const reviewers = selfAssociated.reviewers as Array<Record<string, unknown>>;
  reviewers[0].independentOfProject = false;
  reviewers[0].projectRole = "maintainer";
  assert.throws(
    () => validateHumanImpactDataset(selfAssociated),
    /must be independent/u
  );
});

test("signed exclusions remain visible and tampering fails closed", () => {
  const raw = qualifiedDataset({ includeExclusion: true });
  const evaluated = evaluateHumanImpact(raw, {
    sourceSha,
    inputSha256: sha256(JSON.stringify(raw)),
  });
  assert.equal(evaluated.passed, true);
  assert.equal(evaluated.humanEvaluation.exclusions.count, 1);
  assert.equal(
    evaluated.humanEvaluation.exclusions.byReason["withdrawn-consent"],
    1
  );

  const tampered = qualifiedDataset({ includeExclusion: true });
  const exclusions = tampered.exclusions as Array<Record<string, unknown>>;
  exclusions[0].reason = "duplicate-record";
  assert.throws(
    () => validateHumanImpactDataset(tampered),
    /Exclusion signature is invalid/u
  );
});

test("a negative B4 action-safety result is preserved and blocks the gate", () => {
  const raw = qualifiedDataset({ unsafeB4: true });
  const evaluated = evaluateHumanImpact(raw, {
    sourceSha,
    inputSha256: sha256(JSON.stringify(raw)),
  });
  assert.equal(evaluated.passed, false);
  assert.equal(evaluated.gates.b4ActionSafetyPassed, false);
  assert.equal(evaluated.humanEvaluation.b4UnsafeActionRatings, 1);
  assert.equal(evaluated.claims.qualifiedHumanEvaluationCompleted, true);
});

test("pipeline adapter writes only sealed aggregate artifacts under RUNNER_TEMP", async () => {
  const runnerRoot = await mkdtemp(
    join(process.env.RUNNER_TEMP ?? tmpdir(), "human-impact-test-")
  );
  const output = join(runnerRoot, "output");
  try {
    const result = await runHumanImpactEvaluation(
      [
        "evaluate",
        "--input",
        fileURLToPath(pilotUrl),
        "--output",
        output,
        "--source-sha",
        sourceSha,
      ],
      {
        CI: "true",
        GITHUB_ACTIONS: "true",
        RUNNER_TEMP: runnerRoot,
        GITHUB_REPOSITORY: "upgradedev/archon-cockroach-memory",
        GITHUB_RUN_ID: "123",
        GITHUB_RUN_ATTEMPT: "1",
      }
    );
    assert.equal(result.passed, true);
    const receipt = JSON.parse(
      await readFile(join(output, "human-impact-receipt.json"), "utf8")
    ) as Record<string, unknown>;
    const manifest = JSON.parse(
      await readFile(join(output, "human-impact-input-manifest.json"), "utf8")
    ) as {
      input: Record<string, unknown>;
    };
    assert.equal(receipt.schema, "archon.human-impact.receipt");
    assert.equal(manifest.input.rawDatasetUploaded, false);
    assert.equal(manifest.input.rawReviewerIdsUploaded, false);
    assert.equal(manifest.input.rawParticipantIdsUploaded, false);
    assert.equal(manifest.input.rawRatingsUploaded, false);
    assert.equal(manifest.input.rawTrialsUploaded, false);
    assert.equal(manifest.input.rawExclusionsUploaded, false);
    assert.equal(manifest.input.rawSignaturesUploaded, false);
  } finally {
    await rm(runnerRoot, { recursive: true, force: true });
  }
});

test("qualified adapter requires protected approval and emits no pseudonymous records", async () => {
  const runnerRoot = await mkdtemp(
    join(process.env.RUNNER_TEMP ?? tmpdir(), "human-impact-qualified-test-")
  );
  const input = join(runnerRoot, "qualified-study.json");
  const output = join(runnerRoot, "qualified-output");
  const rejectedOutput = join(runnerRoot, "rejected-output");
  const raw = qualifiedDataset();
  await writeFile(input, `${JSON.stringify(raw)}\n`, { mode: 0o600 });
  const environment: NodeJS.ProcessEnv = {
    CI: "true",
    GITHUB_ACTIONS: "true",
    RUNNER_TEMP: runnerRoot,
    GITHUB_REPOSITORY: "upgradedev/archon-cockroach-memory",
    GITHUB_RUN_ID: "124",
    GITHUB_RUN_ATTEMPT: "1",
  };
  try {
    await assert.rejects(
      runHumanImpactEvaluation(
        [
          "evaluate",
          "--input",
          input,
          "--output",
          rejectedOutput,
          "--source-sha",
          sourceSha,
        ],
        environment
      ),
      /requires a protected approval reference/u
    );

    const result = await runHumanImpactEvaluation(
      [
        "evaluate",
        "--input",
        input,
        "--output",
        output,
        "--source-sha",
        sourceSha,
      ],
      {
        ...environment,
        HUMAN_IMPACT_APPROVAL_REFERENCE: "HUMAN-STUDY/APPROVAL-001",
      }
    );
    assert.equal(result.passed, true);
    const resultsText = await readFile(
      join(output, "human-impact-results.json"),
      "utf8"
    );
    assert.equal(resultsText.includes("reviewer-aaaaaaaa"), false);
    assert.equal(resultsText.includes("participant-00000000"), false);
    const receipt = JSON.parse(
      await readFile(join(output, "human-impact-receipt.json"), "utf8")
    ) as {
      approval: Record<string, unknown>;
      claims: Record<string, unknown>;
    };
    assert.equal(receipt.approval.referenceProvided, true);
    assert.equal(receipt.approval.rawReferenceStored, false);
    assert.equal(receipt.claims.productionBusinessImpact, false);
  } finally {
    await rm(runnerRoot, { recursive: true, force: true });
  }
});

test("pipeline adapter refuses local execution before reading or writing files", async () => {
  await assert.rejects(
    runHumanImpactEvaluation(
      [
        "evaluate",
        "--input",
        "does-not-exist.json",
        "--output",
        "does-not-exist",
        "--source-sha",
        sourceSha,
      ],
      {}
    ),
    /only in GitHub Actions CI/u
  );
});
