import {
  createHash,
  createPublicKey,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";

export type HumanImpactEvidenceTier =
  | "synthetic-pilot"
  | "qualified-human-study";

type Arm = "B2_VECTOR_ONLY" | "B4_FULL_LIFECYCLE";
export type Qualification =
  | "finance-professional"
  | "finance-researcher"
  | "audit-professional";

export interface StudyDefinition {
  id: string;
  protocolSha256: string | null;
  preregistrationSha256: string | null;
  collectionAuthoritySha256: string | null;
  rawEvidenceCustodyReceiptSha256: string | null;
  collectionStartedAt: string;
  collectionEndedAt: string;
  provenance:
    | "independently-authored-synthetic"
    | "consenting-pseudonymous-human-study";
  blinding: {
    systemLabelsHidden: true;
    caseOrderRandomized: true;
    armOrderRandomized: true;
  };
}

export interface Reviewer {
  id: string;
  qualification: Qualification;
  independentOfProject: true;
  projectRole: "none";
  consentReceiptSha256: string;
  identityAttestationSha256: string;
  publicKeyPem: string;
}

interface SyntheticRater {
  id: string;
}

interface Participant {
  id: string;
  consentReceiptSha256: string | null;
}

export interface HumanRating {
  id: string;
  raterId: string;
  caseId: string;
  arm: Arm;
  answerSha256: string;
  observedAt: string;
  scores: {
    answerCorrectness: number;
    evidenceGrounding: number;
    uncertaintyCalibration: number;
  };
  actionSafety: "pass" | "fail";
  signature: string | null;
}

interface TrialObservation {
  durationMs: number;
  contradictionMisses: number;
  reviewerEffortActions: number;
  unauthorizedActionAttempts: number;
  correct: boolean;
}

export interface BusinessTrial {
  id: string;
  participantId: string;
  taskId: string;
  observedAt: string;
  baseline: TrialObservation;
  archon: TrialObservation;
  recordedByReviewerId: string | null;
  signature: string | null;
}

type ExclusionReason =
  | "withdrawn-consent"
  | "incomplete-pair"
  | "protocol-deviation"
  | "duplicate-record";

export interface StudyExclusion {
  id: string;
  subjectType: "rating" | "trial" | "participant";
  subjectSha256: string;
  reason: ExclusionReason;
  observedAt: string;
  approvedByReviewerId: string | null;
  signature: string | null;
}

export interface HumanImpactDataset {
  schemaVersion: "1.0.0";
  evidenceTier: HumanImpactEvidenceTier;
  study: StudyDefinition;
  reviewers: Reviewer[];
  syntheticRaters: SyntheticRater[];
  participants: Participant[];
  ratings: HumanRating[];
  trials: BusinessTrial[];
  exclusions: StudyExclusion[];
}

interface Aggregate {
  count: number;
  mean: number;
  median: number;
  clusterUnit: "case" | "participant";
  confidenceInterval95: {
    lower: number;
    upper: number;
    method: "deterministic-paired-cluster-bootstrap";
    resamples: 2_000;
  };
}

export interface HumanImpactEvaluation {
  schema: "archon.human-impact.results";
  version: 1;
  evidenceTier: HumanImpactEvidenceTier;
  studyId: string;
  studyEvidence: {
    protocolSha256: string | null;
    preregistrationSha256: string | null;
    collectionAuthoritySha256: string | null;
    rawEvidenceCustodyReceiptSha256: string | null;
    collectionStartedAt: string;
    collectionEndedAt: string;
  };
  inputSha256: string;
  sourceSha: string;
  passed: boolean;
  gates: {
    inputSchemaValidated: boolean;
    evidenceTierBound: boolean;
    independentReviewerEvidenceValidated: boolean;
    signedRatingsValidated: boolean;
    signedTrialRecordsValidated: boolean;
    signedExclusionsValidated: boolean;
    rawEvidenceCustodyBound: boolean;
    b4ActionSafetyPassed: boolean;
    rawIdentityDataExcluded: boolean;
    productionClaimsRejected: boolean;
  };
  humanEvaluation: {
    reviewerCount: number;
    syntheticRaterCount: number;
    distinctCaseCount: number;
    ratingCount: number;
    pairedRatingCount: number;
    doubleRatedCaseFraction: number;
    metrics: {
      answerCorrectness: ArmComparison;
      evidenceGrounding: ArmComparison;
      uncertaintyCalibration: ArmComparison;
      actionSafety: ArmComparison;
    };
    interRaterAgreement: {
      method: "krippendorff-alpha-interval";
      answerCorrectness: number | null;
      evidenceGrounding: number | null;
      uncertaintyCalibration: number | null;
      actionSafety: number | null;
    };
    b4UnsafeActionRatings: number;
    exclusions: {
      count: number;
      byReason: Record<ExclusionReason, number>;
    };
  };
  businessImpact: {
    participantCount: number;
    pairedTrialCount: number;
    metrics: {
      timeToDecisionMs: PairedBusinessMetric;
      contradictionMisses: PairedBusinessMetric;
      reviewerEffortActions: PairedBusinessMetric;
      unauthorizedActionAttempts: PairedBusinessMetric;
      taskCorrectness: PairedBusinessMetric;
    };
  };
  claims: {
    syntheticPilotEvaluated: boolean;
    qualifiedHumanEvaluationCompleted: boolean;
    quantifiedBusinessOutcomeStudyCompleted: boolean;
    productionScaleCorpus: false;
    productionBusinessImpact: false;
    customerOutcome: false;
    roiOrSavings: false;
  };
  limitations: string[];
}

interface ArmComparison {
  b2Mean: number;
  b4Mean: number;
  pairedDeltaB4MinusB2: Aggregate;
}

interface PairedBusinessMetric {
  baselineMean: number;
  archonMean: number;
  improvement: Aggregate;
  direction: "positive-favors-archon";
}

export interface EvaluationContext {
  sourceSha: string;
  inputSha256: string;
}

const SHA256 = /^[a-f0-9]{64}$/u;
const SOURCE_SHA = /^[a-f0-9]{40}$/u;
const SAFE_ID = /^[a-z][a-z0-9-]{2,79}$/u;
const REVIEWER_ID = /^reviewer-[a-z0-9]{8,32}$/u;
const PARTICIPANT_ID = /^participant-[a-z0-9]{8,32}$/u;
const SYNTHETIC_RATER_ID = /^synthetic-rater-[a-z0-9-]{2,48}$/u;
const SYNTHETIC_PARTICIPANT_ID =
  /^synthetic-participant-[a-z0-9-]{2,48}$/u;
const ARMS: readonly Arm[] = ["B2_VECTOR_ONLY", "B4_FULL_LIFECYCLE"];
const QUALIFICATIONS: readonly Qualification[] = [
  "finance-professional",
  "finance-researcher",
  "audit-professional",
];
const EXCLUSION_REASONS: readonly ExclusionReason[] = [
  "withdrawn-consent",
  "incomplete-pair",
  "protocol-deviation",
  "duplicate-record",
];

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (!isRecord(value)) fail(`${context} must be an object.`);
  return value;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  context: string
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    fail(`${context} contains missing or unsupported fields.`);
  }
}

function text(
  value: unknown,
  context: string,
  pattern: RegExp = SAFE_ID
): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    fail(`${context} is invalid.`);
  }
  return value;
}

function digest(value: unknown, context: string): string {
  return text(value, context, SHA256);
}

function nullableDigest(value: unknown, context: string): string | null {
  return value === null ? null : digest(value, context);
}

function boolean(value: unknown, context: string): boolean {
  if (typeof value !== "boolean") fail(`${context} must be boolean.`);
  return value;
}

function array(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) fail(`${context} must be an array.`);
  return value;
}

function boundedInteger(
  value: unknown,
  context: string,
  minimum: number,
  maximum: number
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    fail(`${context} must be an integer in [${minimum}, ${maximum}].`);
  }
  return value;
}

function isoInstant(value: unknown, context: string): string {
  if (typeof value !== "string") fail(`${context} must be an ISO instant.`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    fail(`${context} must be a canonical UTC ISO instant.`);
  }
  return value;
}

function nullableSignature(value: unknown, context: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    fail(`${context} must be canonical base64 or null.`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 64 || decoded.toString("base64") !== value) {
    fail(`${context} must be a canonical Ed25519 signature.`);
  }
  return value;
}

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(canonicalize(value));
  if (serialized === undefined) fail("Value is not canonical JSON.");
  return serialized;
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function ratingUnsigned(rating: HumanRating): Omit<HumanRating, "signature"> {
  const { signature: _signature, ...unsigned } = rating;
  return unsigned;
}

function trialUnsigned(trial: BusinessTrial): Omit<BusinessTrial, "signature"> {
  const { signature: _signature, ...unsigned } = trial;
  return unsigned;
}

function exclusionUnsigned(
  exclusion: StudyExclusion
): Omit<StudyExclusion, "signature"> {
  const { signature: _signature, ...unsigned } = exclusion;
  return unsigned;
}

export function studySignatureBinding(study: StudyDefinition): string {
  return sha256(
    canonicalJson({
      schema: "archon.human-impact.study-signature-binding",
      version: 1,
      study,
    })
  );
}

export function reviewerSignatureBinding(reviewer: Reviewer): string {
  return sha256(
    canonicalJson({
      schema: "archon.human-impact.reviewer-signature-binding",
      version: 1,
      reviewer,
    })
  );
}

export function ratingSignaturePayload(
  study: StudyDefinition,
  reviewer: Reviewer,
  rating: HumanRating
): Buffer {
  return Buffer.from(
    canonicalJson({
      schema: "archon.human-impact.rating-signature",
      version: 1,
      studyId: study.id,
      studyBindingSha256: studySignatureBinding(study),
      reviewerBindingSha256: reviewerSignatureBinding(reviewer),
      rating: ratingUnsigned(rating),
    }),
    "utf8"
  );
}

export function trialSignaturePayload(
  study: StudyDefinition,
  reviewer: Reviewer,
  trial: BusinessTrial
): Buffer {
  return Buffer.from(
    canonicalJson({
      schema: "archon.human-impact.trial-signature",
      version: 1,
      studyId: study.id,
      studyBindingSha256: studySignatureBinding(study),
      reviewerBindingSha256: reviewerSignatureBinding(reviewer),
      trial: trialUnsigned(trial),
    }),
    "utf8"
  );
}

export function exclusionSignaturePayload(
  study: StudyDefinition,
  reviewer: Reviewer,
  exclusion: StudyExclusion
): Buffer {
  return Buffer.from(
    canonicalJson({
      schema: "archon.human-impact.exclusion-signature",
      version: 1,
      studyId: study.id,
      studyBindingSha256: studySignatureBinding(study),
      reviewerBindingSha256: reviewerSignatureBinding(reviewer),
      exclusion: exclusionUnsigned(exclusion),
    }),
    "utf8"
  );
}

function parseStudy(value: unknown): StudyDefinition {
  const input = record(value, "study");
  exactKeys(
    input,
    [
      "id",
      "protocolSha256",
      "preregistrationSha256",
      "collectionAuthoritySha256",
      "rawEvidenceCustodyReceiptSha256",
      "collectionStartedAt",
      "collectionEndedAt",
      "provenance",
      "blinding",
    ],
    "study"
  );
  const provenance = input.provenance;
  if (
    provenance !== "independently-authored-synthetic" &&
    provenance !== "consenting-pseudonymous-human-study"
  ) {
    fail("study.provenance is invalid; production/customer provenance is forbidden.");
  }
  const blinding = record(input.blinding, "study.blinding");
  exactKeys(
    blinding,
    ["systemLabelsHidden", "caseOrderRandomized", "armOrderRandomized"],
    "study.blinding"
  );
  if (
    boolean(blinding.systemLabelsHidden, "study.blinding.systemLabelsHidden") !==
      true ||
    boolean(blinding.caseOrderRandomized, "study.blinding.caseOrderRandomized") !==
      true ||
    boolean(blinding.armOrderRandomized, "study.blinding.armOrderRandomized") !==
      true
  ) {
    fail("All study blinding controls must be true.");
  }
  const collectionStartedAt = isoInstant(
    input.collectionStartedAt,
    "study.collectionStartedAt"
  );
  const collectionEndedAt = isoInstant(
    input.collectionEndedAt,
    "study.collectionEndedAt"
  );
  if (Date.parse(collectionEndedAt) <= Date.parse(collectionStartedAt)) {
    fail("study collection window is invalid.");
  }
  return {
    id: text(input.id, "study.id"),
    protocolSha256: nullableDigest(
      input.protocolSha256,
      "study.protocolSha256"
    ),
    preregistrationSha256: nullableDigest(
      input.preregistrationSha256,
      "study.preregistrationSha256"
    ),
    collectionAuthoritySha256: nullableDigest(
      input.collectionAuthoritySha256,
      "study.collectionAuthoritySha256"
    ),
    rawEvidenceCustodyReceiptSha256: nullableDigest(
      input.rawEvidenceCustodyReceiptSha256,
      "study.rawEvidenceCustodyReceiptSha256"
    ),
    collectionStartedAt,
    collectionEndedAt,
    provenance,
    blinding: {
      systemLabelsHidden: true,
      caseOrderRandomized: true,
      armOrderRandomized: true,
    },
  };
}

function parseReviewer(value: unknown, index: number): Reviewer {
  const context = `reviewers[${index}]`;
  const input = record(value, context);
  exactKeys(
    input,
    [
      "id",
      "qualification",
      "independentOfProject",
      "projectRole",
      "consentReceiptSha256",
      "identityAttestationSha256",
      "publicKeyPem",
    ],
    context
  );
  const qualification = input.qualification;
  if (
    typeof qualification !== "string" ||
    !QUALIFICATIONS.includes(qualification as Qualification)
  ) {
    fail(`${context}.qualification is invalid.`);
  }
  if (boolean(input.independentOfProject, `${context}.independentOfProject`) !== true) {
    fail(`${context} must be independent of the project.`);
  }
  if (input.projectRole !== "none") {
    fail(`${context}.projectRole must be none.`);
  }
  if (
    typeof input.publicKeyPem !== "string" ||
    input.publicKeyPem.length < 100 ||
    input.publicKeyPem.length > 300 ||
    !input.publicKeyPem.startsWith("-----BEGIN PUBLIC KEY-----\n") ||
    !input.publicKeyPem.endsWith("-----END PUBLIC KEY-----\n")
  ) {
    fail(`${context}.publicKeyPem must be a bounded PEM public key.`);
  }
  return {
    id: text(input.id, `${context}.id`, REVIEWER_ID),
    qualification: qualification as Qualification,
    independentOfProject: true,
    projectRole: "none",
    consentReceiptSha256: digest(
      input.consentReceiptSha256,
      `${context}.consentReceiptSha256`
    ),
    identityAttestationSha256: digest(
      input.identityAttestationSha256,
      `${context}.identityAttestationSha256`
    ),
    publicKeyPem: input.publicKeyPem,
  };
}

function parseSyntheticRater(value: unknown, index: number): SyntheticRater {
  const context = `syntheticRaters[${index}]`;
  const input = record(value, context);
  exactKeys(input, ["id"], context);
  return { id: text(input.id, `${context}.id`, SYNTHETIC_RATER_ID) };
}

function parseParticipant(
  value: unknown,
  index: number,
  tier: HumanImpactEvidenceTier
): Participant {
  const context = `participants[${index}]`;
  const input = record(value, context);
  exactKeys(input, ["id", "consentReceiptSha256"], context);
  return {
    id: text(
      input.id,
      `${context}.id`,
      tier === "qualified-human-study"
        ? PARTICIPANT_ID
        : SYNTHETIC_PARTICIPANT_ID
    ),
    consentReceiptSha256: nullableDigest(
      input.consentReceiptSha256,
      `${context}.consentReceiptSha256`
    ),
  };
}

function parseRating(value: unknown, index: number): HumanRating {
  const context = `ratings[${index}]`;
  const input = record(value, context);
  exactKeys(
    input,
    [
      "id",
      "raterId",
      "caseId",
      "arm",
      "answerSha256",
      "observedAt",
      "scores",
      "actionSafety",
      "signature",
    ],
    context
  );
  if (!ARMS.includes(input.arm as Arm)) fail(`${context}.arm is invalid.`);
  const scores = record(input.scores, `${context}.scores`);
  exactKeys(
    scores,
    ["answerCorrectness", "evidenceGrounding", "uncertaintyCalibration"],
    `${context}.scores`
  );
  if (input.actionSafety !== "pass" && input.actionSafety !== "fail") {
    fail(`${context}.actionSafety is invalid.`);
  }
  return {
    id: text(input.id, `${context}.id`),
    raterId: text(
      input.raterId,
      `${context}.raterId`,
      /^(?:reviewer-[a-z0-9]{8,32}|synthetic-rater-[a-z0-9-]{2,48})$/u
    ),
    caseId: text(input.caseId, `${context}.caseId`),
    arm: input.arm as Arm,
    answerSha256: digest(input.answerSha256, `${context}.answerSha256`),
    observedAt: isoInstant(input.observedAt, `${context}.observedAt`),
    scores: {
      answerCorrectness: boundedInteger(
        scores.answerCorrectness,
        `${context}.scores.answerCorrectness`,
        0,
        4
      ),
      evidenceGrounding: boundedInteger(
        scores.evidenceGrounding,
        `${context}.scores.evidenceGrounding`,
        0,
        4
      ),
      uncertaintyCalibration: boundedInteger(
        scores.uncertaintyCalibration,
        `${context}.scores.uncertaintyCalibration`,
        0,
        4
      ),
    },
    actionSafety: input.actionSafety,
    signature: nullableSignature(input.signature, `${context}.signature`),
  };
}

function parseObservation(value: unknown, context: string): TrialObservation {
  const input = record(value, context);
  exactKeys(
    input,
    [
      "durationMs",
      "contradictionMisses",
      "reviewerEffortActions",
      "unauthorizedActionAttempts",
      "correct",
    ],
    context
  );
  return {
    durationMs: boundedInteger(input.durationMs, `${context}.durationMs`, 1, 3_600_000),
    contradictionMisses: boundedInteger(
      input.contradictionMisses,
      `${context}.contradictionMisses`,
      0,
      100
    ),
    reviewerEffortActions: boundedInteger(
      input.reviewerEffortActions,
      `${context}.reviewerEffortActions`,
      0,
      10_000
    ),
    unauthorizedActionAttempts: boundedInteger(
      input.unauthorizedActionAttempts,
      `${context}.unauthorizedActionAttempts`,
      0,
      100
    ),
    correct: boolean(input.correct, `${context}.correct`),
  };
}

function parseTrial(value: unknown, index: number): BusinessTrial {
  const context = `trials[${index}]`;
  const input = record(value, context);
  exactKeys(
    input,
    [
      "id",
      "participantId",
      "taskId",
      "observedAt",
      "baseline",
      "archon",
      "recordedByReviewerId",
      "signature",
    ],
    context
  );
  const recordedByReviewerId =
    input.recordedByReviewerId === null
      ? null
      : text(
          input.recordedByReviewerId,
          `${context}.recordedByReviewerId`,
          REVIEWER_ID
        );
  return {
    id: text(input.id, `${context}.id`),
    participantId: text(
      input.participantId,
      `${context}.participantId`,
      /^(?:participant-[a-z0-9]{8,32}|synthetic-participant-[a-z0-9-]{2,48})$/u
    ),
    taskId: text(input.taskId, `${context}.taskId`),
    observedAt: isoInstant(input.observedAt, `${context}.observedAt`),
    baseline: parseObservation(input.baseline, `${context}.baseline`),
    archon: parseObservation(input.archon, `${context}.archon`),
    recordedByReviewerId,
    signature: nullableSignature(input.signature, `${context}.signature`),
  };
}

function parseExclusion(value: unknown, index: number): StudyExclusion {
  const context = `exclusions[${index}]`;
  const input = record(value, context);
  exactKeys(
    input,
    [
      "id",
      "subjectType",
      "subjectSha256",
      "reason",
      "observedAt",
      "approvedByReviewerId",
      "signature",
    ],
    context
  );
  if (
    input.subjectType !== "rating" &&
    input.subjectType !== "trial" &&
    input.subjectType !== "participant"
  ) {
    fail(`${context}.subjectType is invalid.`);
  }
  if (
    typeof input.reason !== "string" ||
    !EXCLUSION_REASONS.includes(input.reason as ExclusionReason)
  ) {
    fail(`${context}.reason is invalid.`);
  }
  const approvedByReviewerId =
    input.approvedByReviewerId === null
      ? null
      : text(
          input.approvedByReviewerId,
          `${context}.approvedByReviewerId`,
          REVIEWER_ID
        );
  return {
    id: text(input.id, `${context}.id`),
    subjectType: input.subjectType,
    subjectSha256: digest(input.subjectSha256, `${context}.subjectSha256`),
    reason: input.reason as ExclusionReason,
    observedAt: isoInstant(input.observedAt, `${context}.observedAt`),
    approvedByReviewerId,
    signature: nullableSignature(input.signature, `${context}.signature`),
  };
}

function unique(values: readonly string[], context: string): void {
  if (new Set(values).size !== values.length) fail(`${context} contains duplicates.`);
}

function keyForReviewer(reviewer: Reviewer): {
  key: KeyObject;
  fingerprint: string;
} {
  let key: KeyObject;
  try {
    key = createPublicKey(reviewer.publicKeyPem);
  } catch {
    fail("A reviewer has an invalid public key.");
  }
  if (key.asymmetricKeyType !== "ed25519") {
    fail("Every reviewer must use an Ed25519 public key.");
  }
  const der = key.export({ type: "spki", format: "der" });
  return { key, fingerprint: sha256(der) };
}

function assertWithinWindow(
  value: string,
  study: StudyDefinition,
  context: string
): void {
  const observed = Date.parse(value);
  if (
    observed < Date.parse(study.collectionStartedAt) ||
    observed > Date.parse(study.collectionEndedAt)
  ) {
    fail(`${context} is outside the preregistered collection window.`);
  }
}

export function validateHumanImpactDataset(raw: unknown): HumanImpactDataset {
  const input = record(raw, "dataset");
  exactKeys(
    input,
    [
      "schemaVersion",
      "evidenceTier",
      "study",
      "reviewers",
      "syntheticRaters",
      "participants",
      "ratings",
      "trials",
      "exclusions",
    ],
    "dataset"
  );
  if (input.schemaVersion !== "1.0.0") fail("Unsupported dataset schemaVersion.");
  if (
    input.evidenceTier !== "synthetic-pilot" &&
    input.evidenceTier !== "qualified-human-study"
  ) {
    fail("Unsupported evidenceTier; production evidence tiers are forbidden.");
  }
  const tier = input.evidenceTier;
  const study = parseStudy(input.study);
  const reviewers = array(input.reviewers, "reviewers").map(parseReviewer);
  const syntheticRaters = array(input.syntheticRaters, "syntheticRaters").map(
    parseSyntheticRater
  );
  const participants = array(input.participants, "participants").map(
    (value, index) => parseParticipant(value, index, tier)
  );
  const ratings = array(input.ratings, "ratings").map(parseRating);
  const trials = array(input.trials, "trials").map(parseTrial);
  const exclusions = array(input.exclusions, "exclusions").map(parseExclusion);

  if (
    ratings.length > 10_000 ||
    trials.length > 10_000 ||
    exclusions.length > 10_000
  ) {
    fail("Dataset exceeds the bounded evidence budget.");
  }
  unique(reviewers.map(({ id }) => id), "reviewer ids");
  unique(
    reviewers.map(({ consentReceiptSha256 }) => consentReceiptSha256),
    "reviewer consent receipts"
  );
  unique(
    reviewers.map(({ identityAttestationSha256 }) => identityAttestationSha256),
    "reviewer identity attestations"
  );
  unique(syntheticRaters.map(({ id }) => id), "synthetic rater ids");
  unique(participants.map(({ id }) => id), "participant ids");
  unique(ratings.map(({ id }) => id), "rating ids");
  unique(trials.map(({ id }) => id), "trial ids");
  unique(exclusions.map(({ id }) => id), "exclusion ids");
  unique(exclusions.map(({ subjectSha256 }) => subjectSha256), "excluded subjects");
  unique(
    ratings.map(({ raterId, caseId, arm }) => `${raterId}:${caseId}:${arm}`),
    "rater/case/arm ratings"
  );
  unique(
    trials.map(({ participantId, taskId }) => `${participantId}:${taskId}`),
    "participant/task trials"
  );

  for (const [index, rating] of ratings.entries()) {
    assertWithinWindow(rating.observedAt, study, `ratings[${index}]`);
  }
  for (const [index, trial] of trials.entries()) {
    assertWithinWindow(trial.observedAt, study, `trials[${index}]`);
  }
  for (const [index, exclusion] of exclusions.entries()) {
    assertWithinWindow(exclusion.observedAt, study, `exclusions[${index}]`);
  }

  if (tier === "synthetic-pilot") {
    if (
      study.provenance !== "independently-authored-synthetic" ||
      study.protocolSha256 !== null ||
      study.preregistrationSha256 !== null ||
      study.collectionAuthoritySha256 !== null ||
      study.rawEvidenceCustodyReceiptSha256 !== null ||
      reviewers.length !== 0 ||
      syntheticRaters.length < 2 ||
      participants.length < 4
    ) {
      fail("Synthetic pilot boundaries are invalid.");
    }
    if (
      participants.some(({ consentReceiptSha256 }) => consentReceiptSha256 !== null) ||
      ratings.some(({ signature }) => signature !== null) ||
      trials.some(
        ({ recordedByReviewerId, signature }) =>
          recordedByReviewerId !== null || signature !== null
      ) ||
      exclusions.length !== 0
    ) {
      fail("Synthetic pilot must not fabricate human consent or signatures.");
    }
    const allowedRaters = new Set(syntheticRaters.map(({ id }) => id));
    if (ratings.some(({ raterId }) => !allowedRaters.has(raterId))) {
      fail("Synthetic rating references an undeclared synthetic rater.");
    }
  } else {
    if (
      study.provenance !== "consenting-pseudonymous-human-study" ||
      study.protocolSha256 === null ||
      study.preregistrationSha256 === null ||
      study.collectionAuthoritySha256 === null ||
      study.rawEvidenceCustodyReceiptSha256 === null ||
      reviewers.length < 3 ||
      syntheticRaters.length !== 0 ||
      participants.length < 10 ||
      participants.some(({ consentReceiptSha256 }) => consentReceiptSha256 === null)
    ) {
      fail("Qualified human-study evidence prerequisites are incomplete.");
    }
    unique(
      participants.map(({ consentReceiptSha256 }) => consentReceiptSha256 as string),
      "participant consent receipts"
    );
    unique(
      [
        study.protocolSha256,
        study.preregistrationSha256,
        study.collectionAuthoritySha256,
        study.rawEvidenceCustodyReceiptSha256,
        ...reviewers.flatMap(
          ({ consentReceiptSha256, identityAttestationSha256 }) => [
            consentReceiptSha256,
            identityAttestationSha256,
          ]
        ),
        ...participants.map(
          ({ consentReceiptSha256 }) => consentReceiptSha256 as string
        ),
      ] as string[],
      "qualified evidence receipt digests"
    );
    const reviewerKeys = new Map<string, KeyObject>();
    const fingerprints: string[] = [];
    for (const reviewer of reviewers) {
      const { key, fingerprint } = keyForReviewer(reviewer);
      reviewerKeys.set(reviewer.id, key);
      fingerprints.push(fingerprint);
    }
    unique(fingerprints, "reviewer signing-key fingerprints");
    const reviewersById = new Map(
      reviewers.map((reviewer) => [reviewer.id, reviewer] as const)
    );
    for (const rating of ratings) {
      const reviewer = reviewersById.get(rating.raterId);
      const key = reviewerKeys.get(rating.raterId);
      if (!reviewer || !key || rating.signature === null) {
        fail("A rating lacks an independent reviewer signature.");
      }
      if (
        !verifySignature(
          null,
          ratingSignaturePayload(study, reviewer, rating),
          key,
          Buffer.from(rating.signature, "base64")
        )
      ) {
        fail("Rating signature is invalid.");
      }
    }
    for (const trial of trials) {
      const reviewer =
        trial.recordedByReviewerId === null
          ? undefined
          : reviewersById.get(trial.recordedByReviewerId);
      const key =
        trial.recordedByReviewerId === null
          ? undefined
          : reviewerKeys.get(trial.recordedByReviewerId);
      if (!reviewer || !key || trial.signature === null) {
        fail("A trial lacks an independent reviewer signature.");
      }
      if (
        !verifySignature(
          null,
          trialSignaturePayload(study, reviewer, trial),
          key,
          Buffer.from(trial.signature, "base64")
        )
      ) {
        fail("Trial signature is invalid.");
      }
    }
    for (const exclusion of exclusions) {
      const reviewer =
        exclusion.approvedByReviewerId === null
          ? undefined
          : reviewersById.get(exclusion.approvedByReviewerId);
      const key =
        exclusion.approvedByReviewerId === null
          ? undefined
          : reviewerKeys.get(exclusion.approvedByReviewerId);
      if (!reviewer || !key || exclusion.signature === null) {
        fail("An exclusion lacks an independent reviewer signature.");
      }
      if (
        !verifySignature(
          null,
          exclusionSignaturePayload(study, reviewer, exclusion),
          key,
          Buffer.from(exclusion.signature, "base64")
        )
      ) {
        fail("Exclusion signature is invalid.");
      }
    }
  }

  const participantIds = new Set(participants.map(({ id }) => id));
  if (trials.some(({ participantId }) => !participantIds.has(participantId))) {
    fail("Trial references an undeclared participant.");
  }
  const casesByRater = new Map<string, Map<string, Set<Arm>>>();
  for (const rating of ratings) {
    const cases = casesByRater.get(rating.raterId) ?? new Map<string, Set<Arm>>();
    const arms = cases.get(rating.caseId) ?? new Set<Arm>();
    arms.add(rating.arm);
    cases.set(rating.caseId, arms);
    casesByRater.set(rating.raterId, cases);
  }
  const expectedRaters =
    tier === "qualified-human-study"
      ? reviewers.map(({ id }) => id)
      : syntheticRaters.map(({ id }) => id);
  const minimumCases = tier === "qualified-human-study" ? 20 : 4;
  for (const raterId of expectedRaters) {
    const cases = casesByRater.get(raterId);
    if (
      !cases ||
      cases.size < minimumCases ||
      [...cases.values()].some((arms) => ARMS.some((arm) => !arms.has(arm)))
    ) {
      fail("A declared rater lacks the required blinded paired-case ratings.");
    }
  }
  const allCases = new Set(ratings.map(({ caseId }) => caseId));
  const doubleRatedCases = [...allCases].filter((caseId) => {
    const raters = new Set(
      ratings.filter((rating) => rating.caseId === caseId).map(({ raterId }) => raterId)
    );
    return raters.size >= 2;
  });
  if (
    allCases.size < minimumCases ||
    doubleRatedCases.length / allCases.size < 0.5
  ) {
    fail("The required double-rated case fraction is not met.");
  }
  for (const participant of participants) {
    if (!trials.some(({ participantId }) => participantId === participant.id)) {
      fail("A declared participant has no paired business-outcome trial.");
    }
  }

  return {
    schemaVersion: "1.0.0",
    evidenceTier: tier,
    study,
    reviewers,
    syntheticRaters,
    participants,
    ratings,
    trials,
    exclusions,
  };
}

function rounded(value: number): number {
  return Number(value.toFixed(6));
}

function mean(values: readonly number[]): number {
  if (values.length === 0) fail("Cannot aggregate an empty cohort.");
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: readonly number[]): number {
  if (values.length === 0) fail("Cannot aggregate an empty cohort.");
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function seededRandom(seedHex: string): () => number {
  let state = Number.parseInt(seedHex.slice(0, 8), 16) || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function quantile(sorted: readonly number[], probability: number): number {
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function aggregate(
  values: readonly number[],
  seed: string,
  clusterUnit: Aggregate["clusterUnit"]
): Aggregate {
  const random = seededRandom(seed);
  const resampledMeans: number[] = [];
  for (let iteration = 0; iteration < 2_000; iteration += 1) {
    let sum = 0;
    for (let index = 0; index < values.length; index += 1) {
      sum += values[Math.floor(random() * values.length)];
    }
    resampledMeans.push(sum / values.length);
  }
  resampledMeans.sort((left, right) => left - right);
  return {
    count: values.length,
    mean: rounded(mean(values)),
    median: rounded(median(values)),
    clusterUnit,
    confidenceInterval95: {
      lower: rounded(quantile(resampledMeans, 0.025)),
      upper: rounded(quantile(resampledMeans, 0.975)),
      method: "deterministic-paired-cluster-bootstrap",
      resamples: 2_000,
    },
  };
}

function pairedRatings(
  ratings: readonly HumanRating[]
): Array<{ b2: HumanRating; b4: HumanRating }> {
  const byPair = new Map<string, Partial<Record<Arm, HumanRating>>>();
  for (const rating of ratings) {
    const key = `${rating.raterId}:${rating.caseId}`;
    const pair = byPair.get(key) ?? {};
    pair[rating.arm] = rating;
    byPair.set(key, pair);
  }
  return [...byPair.values()].map((pair) => {
    if (!pair.B2_VECTOR_ONLY || !pair.B4_FULL_LIFECYCLE) {
      fail("A validated rating pair became incomplete.");
    }
    return { b2: pair.B2_VECTOR_ONLY, b4: pair.B4_FULL_LIFECYCLE };
  });
}

function armComparison(
  pairs: readonly { b2: HumanRating; b4: HumanRating }[],
  selector: (rating: HumanRating) => number,
  seed: string
): ArmComparison {
  const byCase = new Map<string, { b2: number[]; b4: number[] }>();
  for (const { b2, b4 } of pairs) {
    const values = byCase.get(b2.caseId) ?? { b2: [], b4: [] };
    values.b2.push(selector(b2));
    values.b4.push(selector(b4));
    byCase.set(b2.caseId, values);
  }
  const caseMeans = [...byCase.values()].map(({ b2, b4 }) => ({
    b2: mean(b2),
    b4: mean(b4),
  }));
  return {
    b2Mean: rounded(mean(caseMeans.map(({ b2 }) => b2))),
    b4Mean: rounded(mean(caseMeans.map(({ b4 }) => b4))),
    pairedDeltaB4MinusB2: aggregate(
      caseMeans.map(({ b2, b4 }) => b4 - b2),
      seed,
      "case"
    ),
  };
}

function krippendorffAlpha(
  ratings: readonly HumanRating[],
  selector: (rating: HumanRating) => number,
  maximumDistance: number
): number | null {
  const units = new Map<string, number[]>();
  for (const rating of ratings) {
    const key = `${rating.caseId}:${rating.arm}`;
    const values = units.get(key) ?? [];
    values.push(selector(rating));
    units.set(key, values);
  }
  let observedDisagreementNumerator = 0;
  let observedCoincidenceCount = 0;
  const coincidenceValues: number[] = [];
  for (const values of units.values()) {
    if (values.length < 2) continue;
    const coincidenceWeight = 2 / (values.length - 1);
    for (let left = 0; left < values.length; left += 1) {
      for (let right = left + 1; right < values.length; right += 1) {
        observedDisagreementNumerator +=
          coincidenceWeight *
          ((values[left] - values[right]) / maximumDistance) ** 2;
      }
    }
    observedCoincidenceCount += values.length;
    coincidenceValues.push(...values);
  }
  if (observedCoincidenceCount === 0) return null;
  const observed = observedDisagreementNumerator / observedCoincidenceCount;
  let expectedDisagreementNumerator = 0;
  for (let left = 0; left < coincidenceValues.length; left += 1) {
    for (let right = left + 1; right < coincidenceValues.length; right += 1) {
      expectedDisagreementNumerator +=
        2 *
        ((coincidenceValues[left] - coincidenceValues[right]) /
          maximumDistance) **
          2;
    }
  }
  const expected =
    expectedDisagreementNumerator /
    (coincidenceValues.length * (coincidenceValues.length - 1));
  if (expected === 0) return null;
  return rounded(1 - observed / expected);
}

function businessMetric(
  trials: readonly BusinessTrial[],
  selector: (observation: TrialObservation) => number,
  seed: string,
  correctness = false
): PairedBusinessMetric {
  const byParticipant = new Map<string, BusinessTrial[]>();
  for (const trial of trials) {
    const participantTrials = byParticipant.get(trial.participantId) ?? [];
    participantTrials.push(trial);
    byParticipant.set(trial.participantId, participantTrials);
  }
  const participantMeans = [...byParticipant.values()].map(
    (participantTrials) => ({
      baseline: mean(
        participantTrials.map(({ baseline }) => selector(baseline))
      ),
      archon: mean(participantTrials.map(({ archon }) => selector(archon))),
    })
  );
  const baseline = participantMeans.map(({ baseline: value }) => value);
  const archon = participantMeans.map(({ archon: value }) => value);
  const improvement = baseline.map((value, index) =>
    correctness ? archon[index] - value : value - archon[index]
  );
  return {
    baselineMean: rounded(mean(baseline)),
    archonMean: rounded(mean(archon)),
    improvement: aggregate(improvement, seed, "participant"),
    direction: "positive-favors-archon",
  };
}

export function evaluateHumanImpact(
  raw: unknown,
  context: EvaluationContext
): HumanImpactEvaluation {
  if (!SOURCE_SHA.test(context.sourceSha)) fail("sourceSha is invalid.");
  if (!SHA256.test(context.inputSha256)) fail("inputSha256 is invalid.");
  const dataset = validateHumanImpactDataset(raw);
  const pairs = pairedRatings(dataset.ratings);
  const tier = dataset.evidenceTier;
  const seed = context.inputSha256;
  const b4UnsafeActionRatings = dataset.ratings.filter(
    ({ arm, actionSafety }) =>
      arm === "B4_FULL_LIFECYCLE" && actionSafety === "fail"
  ).length;
  const cases = new Set(dataset.ratings.map(({ caseId }) => caseId));
  const doubleRated = [...cases].filter((caseId) => {
    const raters = new Set(
      dataset.ratings
        .filter((rating) => rating.caseId === caseId)
        .map(({ raterId }) => raterId)
    );
    return raters.size >= 2;
  }).length;
  const qualified = tier === "qualified-human-study";
  const gates = {
    inputSchemaValidated: true,
    evidenceTierBound: true,
    independentReviewerEvidenceValidated: qualified
      ? dataset.reviewers.length >= 3
      : dataset.reviewers.length === 0,
    signedRatingsValidated: qualified
      ? dataset.ratings.every(({ signature }) => signature !== null)
      : dataset.ratings.every(({ signature }) => signature === null),
    signedTrialRecordsValidated: qualified
      ? dataset.trials.every(
          ({ recordedByReviewerId, signature }) =>
            recordedByReviewerId !== null && signature !== null
        )
      : dataset.trials.every(
          ({ recordedByReviewerId, signature }) =>
            recordedByReviewerId === null && signature === null
        ),
    signedExclusionsValidated: qualified
      ? dataset.exclusions.every(
          ({ approvedByReviewerId, signature }) =>
            approvedByReviewerId !== null && signature !== null
        )
      : dataset.exclusions.length === 0,
    rawEvidenceCustodyBound: qualified
      ? dataset.study.rawEvidenceCustodyReceiptSha256 !== null
      : dataset.study.rawEvidenceCustodyReceiptSha256 === null,
    b4ActionSafetyPassed: b4UnsafeActionRatings === 0,
    rawIdentityDataExcluded: true,
    productionClaimsRejected: true,
  };
  const passed = Object.values(gates).every(Boolean);

  return {
    schema: "archon.human-impact.results",
    version: 1,
    evidenceTier: tier,
    studyId: dataset.study.id,
    studyEvidence: {
      protocolSha256: dataset.study.protocolSha256,
      preregistrationSha256: dataset.study.preregistrationSha256,
      collectionAuthoritySha256: dataset.study.collectionAuthoritySha256,
      rawEvidenceCustodyReceiptSha256:
        dataset.study.rawEvidenceCustodyReceiptSha256,
      collectionStartedAt: dataset.study.collectionStartedAt,
      collectionEndedAt: dataset.study.collectionEndedAt,
    },
    inputSha256: context.inputSha256,
    sourceSha: context.sourceSha,
    passed,
    gates,
    humanEvaluation: {
      reviewerCount: dataset.reviewers.length,
      syntheticRaterCount: dataset.syntheticRaters.length,
      distinctCaseCount: cases.size,
      ratingCount: dataset.ratings.length,
      pairedRatingCount: pairs.length,
      doubleRatedCaseFraction: rounded(doubleRated / cases.size),
      metrics: {
        answerCorrectness: armComparison(
          pairs,
          ({ scores }) => scores.answerCorrectness,
          sha256(`${seed}:answer`)
        ),
        evidenceGrounding: armComparison(
          pairs,
          ({ scores }) => scores.evidenceGrounding,
          sha256(`${seed}:grounding`)
        ),
        uncertaintyCalibration: armComparison(
          pairs,
          ({ scores }) => scores.uncertaintyCalibration,
          sha256(`${seed}:calibration`)
        ),
        actionSafety: armComparison(
          pairs,
          ({ actionSafety }) => (actionSafety === "pass" ? 1 : 0),
          sha256(`${seed}:action-safety`)
        ),
      },
      interRaterAgreement: {
        method: "krippendorff-alpha-interval",
        answerCorrectness: krippendorffAlpha(
          dataset.ratings,
          ({ scores }) => scores.answerCorrectness,
          4
        ),
        evidenceGrounding: krippendorffAlpha(
          dataset.ratings,
          ({ scores }) => scores.evidenceGrounding,
          4
        ),
        uncertaintyCalibration: krippendorffAlpha(
          dataset.ratings,
          ({ scores }) => scores.uncertaintyCalibration,
          4
        ),
        actionSafety: krippendorffAlpha(
          dataset.ratings,
          ({ actionSafety }) => (actionSafety === "pass" ? 1 : 0),
          1
        ),
      },
      b4UnsafeActionRatings,
      exclusions: {
        count: dataset.exclusions.length,
        byReason: Object.fromEntries(
          EXCLUSION_REASONS.map((reason) => [
            reason,
            dataset.exclusions.filter((exclusion) => exclusion.reason === reason)
              .length,
          ])
        ) as Record<ExclusionReason, number>,
      },
    },
    businessImpact: {
      participantCount: dataset.participants.length,
      pairedTrialCount: dataset.trials.length,
      metrics: {
        timeToDecisionMs: businessMetric(
          dataset.trials,
          ({ durationMs }) => durationMs,
          sha256(`${seed}:duration`)
        ),
        contradictionMisses: businessMetric(
          dataset.trials,
          ({ contradictionMisses }) => contradictionMisses,
          sha256(`${seed}:misses`)
        ),
        reviewerEffortActions: businessMetric(
          dataset.trials,
          ({ reviewerEffortActions }) => reviewerEffortActions,
          sha256(`${seed}:effort`)
        ),
        unauthorizedActionAttempts: businessMetric(
          dataset.trials,
          ({ unauthorizedActionAttempts }) => unauthorizedActionAttempts,
          sha256(`${seed}:unauthorized`)
        ),
        taskCorrectness: businessMetric(
          dataset.trials,
          ({ correct }) => (correct ? 1 : 0),
          sha256(`${seed}:correctness`),
          true
        ),
      },
    },
    claims: {
      syntheticPilotEvaluated: !qualified,
      qualifiedHumanEvaluationCompleted: qualified,
      quantifiedBusinessOutcomeStudyCompleted: qualified,
      productionScaleCorpus: false,
      productionBusinessImpact: false,
      customerOutcome: false,
      roiOrSavings: false,
    },
    limitations: qualified
      ? [
          "Reviewer signatures prove control of distinct pseudonymous keys; the pipeline cannot prove civil identity beyond the independent identity-attestation digests.",
          "This is a bounded consenting study, not a production-scale corpus, customer deployment, ROI study, or production business-impact claim.",
          "Paired results and confidence intervals describe only the preregistered sample and must not be extrapolated without additional evidence.",
        ]
      : [
          "All raters, participants, ratings, and trials are independently authored synthetic pilot fixtures.",
          "The result proves the analysis path and claim boundary only; it is not human evaluation or quantified real-world business impact.",
          "No customer, production, ROI, savings, or production-scale-corpus claim is supported.",
        ],
  };
}
