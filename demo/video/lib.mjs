import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEFAULT_SCENE_PLAN = fileURLToPath(
  new URL("./scene-plan.json", import.meta.url)
);
export const CANONICAL_ORIGIN =
  "https://d2s5v0o0eg2aaw.cloudfront.net";
export const CANONICAL_REPOSITORY =
  "upgradedev/archon-cockroach-memory";
export const VIDEO_SCHEMA_VERSION = 1;
export const EXPECTED_SCENES = Object.freeze([
  Object.freeze({
    id: "hook",
    startSeconds: 0,
    endSeconds: 12,
    color: "#34d399",
  }),
  Object.freeze({
    id: "scope-architecture",
    startSeconds: 12,
    endSeconds: 27,
    color: "#38bdf8",
  }),
  Object.freeze({
    id: "recall-grounding",
    startSeconds: 27,
    endSeconds: 75,
    color: "#fbbf24",
  }),
  Object.freeze({
    id: "audit",
    startSeconds: 75,
    endSeconds: 115,
    color: "#fb7185",
  }),
  Object.freeze({
    id: "proof",
    startSeconds: 115,
    endSeconds: 140,
    color: "#a78bfa",
  }),
  Object.freeze({
    id: "managed-mcp",
    startSeconds: 140,
    endSeconds: 160,
    color: "#22d3ee",
  }),
  Object.freeze({
    id: "close",
    startSeconds: 160,
    endSeconds: 170,
    color: "#f8fafc",
  }),
]);
export const EXPECTED_CAPTURE_SCREENSHOTS = Object.freeze([
  "01-hook.png",
  "02-scope-architecture.png",
  "03-recall-grounding.png",
  "04-audit-conflict.png",
  "05-audit-absence.png",
  "06-proof-ledger.png",
  "07-managed-mcp.png",
  "08-close.png",
]);

let temporaryFileSequence = 0;

function fail(message) {
  throw new Error(message);
}

export function requireNonEmptyEnv(name, env = process.env) {
  const value = env[name];
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${name} must be a non-empty environment variable`);
  }
  return value;
}

export function requireExactBooleanAttestation(name, env = process.env) {
  const value = requireNonEmptyEnv(name, env);
  if (value !== "true") {
    fail(`${name} must be the exact string true`);
  }
  return true;
}

function isDescendant(root, candidate) {
  const child = relative(root, candidate);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) &&
    !isAbsolute(child);
}

function assertExistingDirectoryWithoutSymlink(path, label) {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink()) {
    fail(`${label} must not be a symbolic link`);
  }
  if (!metadata.isDirectory()) {
    fail(`${label} must be a directory`);
  }
}

function inspectExistingPath(root, candidate, label) {
  const child = relative(root, candidate);
  let cursor = root;
  for (const part of child.split(sep).filter(Boolean)) {
    cursor = resolve(cursor, part);
    if (!existsSync(cursor)) {
      break;
    }
    const metadata = lstatSync(cursor);
    if (metadata.isSymbolicLink()) {
      fail(`${label} traverses a symbolic link`);
    }
  }
}

export function runnerTemp(env = process.env) {
  const configured = requireNonEmptyEnv("RUNNER_TEMP", env);
  if (!isAbsolute(configured)) {
    fail("RUNNER_TEMP must be absolute");
  }
  const lexical = resolve(configured);
  assertExistingDirectoryWithoutSymlink(lexical, "RUNNER_TEMP");
  return realpathSync(lexical);
}

export function assertRunnerTempPath(
  candidate,
  {
    env = process.env,
    label = "Path",
    mustExist = false,
    allowRunnerTemp = false,
  } = {}
) {
  if (typeof candidate !== "string" || !isAbsolute(candidate)) {
    fail(`${label} must be absolute`);
  }
  const root = runnerTemp(env);
  const target = resolve(candidate);
  if (target !== root && !isDescendant(root, target)) {
    fail(`${label} must remain under RUNNER_TEMP`);
  }
  if (!allowRunnerTemp && target === root) {
    fail(`${label} must be a descendant of RUNNER_TEMP`);
  }
  inspectExistingPath(root, target, label);
  if (mustExist) {
    if (!existsSync(target)) {
      fail(`${label} does not exist`);
    }
    const actual = realpathSync(target);
    if (actual !== root && !isDescendant(root, actual)) {
      fail(`${label} resolves outside RUNNER_TEMP`);
    }
  }
  return target;
}

function createDescendantDirectories(root, target, label) {
  const child = relative(root, target);
  let cursor = root;
  for (const part of child.split(sep).filter(Boolean)) {
    cursor = resolve(cursor, part);
    if (existsSync(cursor)) {
      assertExistingDirectoryWithoutSymlink(cursor, label);
    } else {
      mkdirSync(cursor, { mode: 0o700 });
    }
  }
}

export function demoVideoRoot(env = process.env, { create = true } = {}) {
  const configured = requireNonEmptyEnv("DEMO_VIDEO_ROOT", env);
  const target = assertRunnerTempPath(configured, {
    env,
    label: "DEMO_VIDEO_ROOT",
  });
  const root = runnerTemp(env);
  if (create) {
    createDescendantDirectories(root, target, "DEMO_VIDEO_ROOT");
  } else {
    assertExistingDirectoryWithoutSymlink(target, "DEMO_VIDEO_ROOT");
  }
  const actual = realpathSync(target);
  if (!isDescendant(root, actual)) {
    fail("DEMO_VIDEO_ROOT resolves outside RUNNER_TEMP");
  }
  return actual;
}

export function outputPath(root, relativePath, label = "Output path") {
  if (
    typeof relativePath !== "string" ||
    relativePath === "" ||
    isAbsolute(relativePath)
  ) {
    fail(`${label} must be a non-empty relative path`);
  }
  const target = resolve(root, relativePath);
  if (!isDescendant(root, target)) {
    fail(`${label} escaped DEMO_VIDEO_ROOT`);
  }
  inspectExistingPath(root, target, label);
  return target;
}

export function ensureOutputDirectory(root, relativePath) {
  const target = outputPath(root, relativePath, "Output directory");
  createDescendantDirectories(root, target, "Output directory");
  return target;
}

export function assertInputFile(root, relativePath, label = "Input file") {
  const target = outputPath(root, relativePath, label);
  if (!existsSync(target)) {
    fail(`${label} is missing`);
  }
  inspectExistingPath(root, target, label);
  const metadata = lstatSync(target);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    fail(`${label} must be a regular non-symlink file`);
  }
  const actual = realpathSync(target);
  if (!isDescendant(root, actual)) {
    fail(`${label} resolves outside DEMO_VIDEO_ROOT`);
  }
  return target;
}

export function writeFileAtomic(
  root,
  relativePath,
  value,
  { encoding, mode = 0o600, replace = false } = {}
) {
  const target = outputPath(root, relativePath);
  ensureOutputDirectory(root, relative(root, dirname(target)));
  if (existsSync(target) && !replace) {
    fail(`Refusing to overwrite existing output: ${relativePath}`);
  }
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
    fail(`Refusing to replace symlink output: ${relativePath}`);
  }
  temporaryFileSequence += 1;
  const temporary = `${target}.tmp-${process.pid}-${temporaryFileSequence}`;
  const noFollow = constants.O_NOFOLLOW ?? 0;
  let descriptor;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      mode
    );
    writeFileSync(descriptor, value, encoding ? { encoding } : undefined);
    closeSync(descriptor);
    descriptor = undefined;
    if (existsSync(target) && replace) {
      rmSync(target);
    }
    renameSync(temporary, target);
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    if (existsSync(temporary)) {
      rmSync(temporary);
    }
  }
  return target;
}

export function readJson(path, label = "JSON file") {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail(`${label} must contain a JSON object`);
  }
  return parsed;
}

export function stableJson(value) {
  const normalize = (entry) => {
    if (Array.isArray(entry)) {
      return entry.map(normalize);
    }
    if (entry && typeof entry === "object") {
      return Object.fromEntries(
        Object.keys(entry).sort().map((key) => [key, normalize(entry[key])])
      );
    }
    return entry;
  };
  return `${JSON.stringify(normalize(value), null, 2)}\n`;
}

export function sha256Buffer(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256File(path) {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const descriptor = openSync(path, constants.O_RDONLY | noFollow);
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) {
        hash.update(buffer.subarray(0, bytesRead));
      }
    } while (bytesRead > 0);
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

export function fileEvidence(path, root) {
  const metadata = statSync(path);
  const child = relative(root, path).split(sep).join("/");
  if (!isDescendant(root, path)) {
    fail("Evidence path escaped DEMO_VIDEO_ROOT");
  }
  return {
    path: child,
    bytes: metadata.size,
    sha256: sha256File(path),
  };
}

export function assertSha256(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    fail(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

export function assertFileEvidence(path, evidence, label) {
  if (!evidence || typeof evidence !== "object") {
    fail(`${label} evidence is missing`);
  }
  const expectedHash = assertSha256(evidence.sha256, `${label} hash`);
  const metadata = statSync(path);
  if (
    !Number.isSafeInteger(evidence.bytes) ||
    evidence.bytes <= 0 ||
    evidence.bytes !== metadata.size
  ) {
    fail(`${label} byte count does not match its receipt`);
  }
  const actualHash = sha256File(path);
  if (actualHash !== expectedHash) {
    fail(`${label} hash does not match its receipt`);
  }
  return actualHash;
}

function assertFiniteNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${label} must be a finite number`);
  }
  return value;
}

export function validateScenePlan(plan, { canonical = true } = {}) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    fail("Scene plan must be an object");
  }
  if (
    plan.schema !== "archon.demo-video-plan" ||
    plan.version !== VIDEO_SCHEMA_VERSION
  ) {
    fail("Scene plan schema/version is not supported");
  }
  const duration = assertFiniteNumber(
    plan.targetDurationSeconds,
    "targetDurationSeconds"
  );
  if (
    !Number.isSafeInteger(plan.width) ||
    !Number.isSafeInteger(plan.height) ||
    !Number.isSafeInteger(plan.fps) ||
    plan.width <= 0 ||
    plan.height <= 0 ||
    plan.fps <= 0
  ) {
    fail("Scene plan media dimensions and fps must be positive integers");
  }
  if (!Array.isArray(plan.scenes) || plan.scenes.length === 0) {
    fail("Scene plan must contain scenes");
  }
  let cursor = 0;
  const ids = new Set();
  for (const [index, scene] of plan.scenes.entries()) {
    if (
      !scene ||
      typeof scene !== "object" ||
      typeof scene.id !== "string" ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(scene.id) ||
      ids.has(scene.id)
    ) {
      fail(`Scene ${index + 1} has an invalid or duplicate id`);
    }
    ids.add(scene.id);
    const start = assertFiniteNumber(
      scene.startSeconds,
      `Scene ${scene.id} start`
    );
    const end = assertFiniteNumber(
      scene.endSeconds,
      `Scene ${scene.id} end`
    );
    if (start !== cursor || end <= start) {
      fail(`Scene ${scene.id} is not contiguous and positive-duration`);
    }
    if (
      typeof scene.narration !== "string" ||
      scene.narration.trim() !== scene.narration ||
      scene.narration.length < 20
    ) {
      fail(`Scene ${scene.id} narration is invalid`);
    }
    cursor = end;
  }
  if (cursor !== duration) {
    fail("Scene plan does not end at targetDurationSeconds");
  }
  if (canonical) {
    if (
      duration !== 170 ||
      plan.width !== 1920 ||
      plan.height !== 1080 ||
      plan.fps !== 30 ||
      plan.scenes.length !== EXPECTED_SCENES.length
    ) {
      fail("Scene plan does not match the canonical 170-second contract");
    }
    if (
      plan.voice?.provider !== "ElevenLabs" ||
      plan.voice?.voiceId !== "pNInz6obpgDQGcFmaJgB" ||
      plan.voice?.modelId !== "eleven_multilingual_v2" ||
      plan.voice?.outputFormat !== "mp3_44100_128"
    ) {
      fail("Scene plan voice contract is not canonical");
    }
    for (const [index, expected] of EXPECTED_SCENES.entries()) {
      const scene = plan.scenes[index];
      if (
        scene.id !== expected.id ||
        scene.startSeconds !== expected.startSeconds ||
        scene.endSeconds !== expected.endSeconds ||
        scene.color !== expected.color
      ) {
        fail(`Scene ${index + 1} does not match the canonical contract`);
      }
    }
  }
  return plan;
}

export function loadScenePlan(path = DEFAULT_SCENE_PLAN) {
  return validateScenePlan(readJson(path, "Scene plan"));
}

export function scenePlanEvidence(path = DEFAULT_SCENE_PLAN) {
  return {
    path: "demo/video/scene-plan.json",
    sha256: sha256File(path),
  };
}

export function normalizeTranscript(value) {
  if (typeof value !== "string") {
    fail("Transcript must be a string");
  }
  return value
    .normalize("NFKC")
    .replaceAll("\u2018", "'")
    .replaceAll("\u2019", "'")
    .replace(/\s+/gu, " ")
    .trim();
}

export function formatSrtTimestamp(seconds) {
  const value = assertFiniteNumber(seconds, "SRT timestamp");
  if (value < 0 || value >= 24 * 60 * 60) {
    fail("SRT timestamp is outside the supported range");
  }
  const milliseconds = Math.round(value * 1000);
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const secs = Math.floor((milliseconds % 60_000) / 1000);
  const millis = milliseconds % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(
    2,
    "0"
  )}:${String(secs).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

export function parseSrtTimestamp(value) {
  const match =
    /^(?<hours>\d{2}):(?<minutes>[0-5]\d):(?<seconds>[0-5]\d),(?<milliseconds>\d{3})$/u.exec(
      value
    );
  if (!match?.groups) {
    fail(`Invalid SRT timestamp: ${value}`);
  }
  return (
    Number(match.groups.hours) * 3600 +
    Number(match.groups.minutes) * 60 +
    Number(match.groups.seconds) +
    Number(match.groups.milliseconds) / 1000
  );
}

export function serializeSrt(cues) {
  if (!Array.isArray(cues) || cues.length === 0) {
    fail("At least one caption cue is required");
  }
  return `${cues
    .map(
      (cue, index) =>
        `${index + 1}\n${formatSrtTimestamp(
          cue.startSeconds
        )} --> ${formatSrtTimestamp(cue.endSeconds)}\n${cue.text}`
    )
    .join("\n\n")}\n`;
}

export function parseSrt(value) {
  const normalized = String(value).replace(/\r\n?/gu, "\n").trim();
  if (normalized === "") {
    fail("SRT is empty");
  }
  return normalized.split(/\n{2,}/u).map((block, index) => {
    const lines = block.split("\n");
    if (lines.length < 3 || Number(lines[0]) !== index + 1) {
      fail(`SRT cue ${index + 1} has an invalid index or body`);
    }
    const timing =
      /^(?<start>\d{2}:[0-5]\d:[0-5]\d,\d{3}) --> (?<end>\d{2}:[0-5]\d:[0-5]\d,\d{3})$/u.exec(
        lines[1]
      );
    if (!timing?.groups) {
      fail(`SRT cue ${index + 1} has invalid timing`);
    }
    const text = lines.slice(2).join("\n").trim();
    if (text === "" || text.includes("-->")) {
      fail(`SRT cue ${index + 1} has invalid text`);
    }
    return {
      index: index + 1,
      startSeconds: parseSrtTimestamp(timing.groups.start),
      endSeconds: parseSrtTimestamp(timing.groups.end),
      text,
    };
  });
}

export function alignmentToCues(alignment, scene) {
  const characters = alignment?.characters;
  const starts = alignment?.character_start_times_seconds;
  const ends = alignment?.character_end_times_seconds;
  if (
    !Array.isArray(characters) ||
    !Array.isArray(starts) ||
    !Array.isArray(ends) ||
    characters.length === 0 ||
    characters.length !== starts.length ||
    characters.length !== ends.length
  ) {
    fail(`Scene ${scene.id} has incomplete ElevenLabs alignment arrays`);
  }
  if (characters.some((character) => typeof character !== "string")) {
    fail(`Scene ${scene.id} alignment contains a non-string character`);
  }
  const alignedTranscript = characters.join("");
  if (alignedTranscript !== scene.narration) {
    fail(`Scene ${scene.id} alignment does not exactly bind its narration`);
  }
  let previousStart = -1;
  for (let index = 0; index < characters.length; index += 1) {
    const start = assertFiniteNumber(
      starts[index],
      `Scene ${scene.id} alignment start`
    );
    const end = assertFiniteNumber(
      ends[index],
      `Scene ${scene.id} alignment end`
    );
    if (start < 0 || start < previousStart || end < start) {
      fail(`Scene ${scene.id} alignment timing is invalid`);
    }
    previousStart = start;
  }
  const sceneDuration = scene.endSeconds - scene.startSeconds;
  const alignmentDuration = Math.max(...ends);
  if (alignmentDuration > sceneDuration + 0.001) {
    fail(
      `Scene ${scene.id} narration lasts ${alignmentDuration.toFixed(3)} seconds and exceeds its ${sceneDuration}-second window`
    );
  }

  const words = [];
  let wordStart;
  let wordEnd;
  let wordText = "";
  const flushWord = () => {
    if (wordText !== "") {
      words.push({ text: wordText, start: wordStart, end: wordEnd });
      wordStart = undefined;
      wordEnd = undefined;
      wordText = "";
    }
  };
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    if (/\s/u.test(character)) {
      flushWord();
      continue;
    }
    if (wordStart === undefined) {
      wordStart = starts[index];
    }
    wordEnd = ends[index];
    wordText += character;
  }
  flushWord();
  if (words.length === 0) {
    fail(`Scene ${scene.id} alignment contains no spoken words`);
  }

  const cues = [];
  let group = [];
  const flushGroup = () => {
    if (group.length === 0) return;
    cues.push({
      sceneId: scene.id,
      startSeconds: scene.startSeconds + group[0].start,
      endSeconds: scene.startSeconds + group.at(-1).end,
      text: group.map((word) => word.text).join(" "),
    });
    group = [];
  };
  for (const word of words) {
    const candidate = [...group, word];
    const candidateText = candidate.map((entry) => entry.text).join(" ");
    const candidateDuration = word.end - candidate[0].start;
    if (
      group.length > 0 &&
      (candidate.length > 8 ||
        candidateText.length > 48 ||
        candidateDuration > 4.5)
    ) {
      flushGroup();
    }
    group.push(word);
    if (/[.!?]$/u.test(word.text)) {
      flushGroup();
    }
  }
  flushGroup();
  return { cues, alignmentDuration };
}

export function validateCaptionsAgainstPlan(cues, plan) {
  if (!Array.isArray(cues) || cues.length < plan.scenes.length) {
    fail("Caption track does not contain enough cues for every scene");
  }
  let previousEnd = 0;
  const textByScene = new Map(plan.scenes.map((scene) => [scene.id, []]));
  for (const [index, cue] of cues.entries()) {
    const start = assertFiniteNumber(
      cue.startSeconds,
      `Caption ${index + 1} start`
    );
    const end = assertFiniteNumber(cue.endSeconds, `Caption ${index + 1} end`);
    if (start < previousEnd - 0.001 || end <= start) {
      fail(`Caption ${index + 1} overlaps or has non-positive duration`);
    }
    if (end > plan.targetDurationSeconds + 0.001) {
      fail(`Caption ${index + 1} exceeds the target runtime`);
    }
    const scene = plan.scenes.find(
      (candidate) =>
        start >= candidate.startSeconds - 0.001 &&
        end <= candidate.endSeconds + 0.001
    );
    if (!scene) {
      fail(`Caption ${index + 1} crosses a scene boundary`);
    }
    textByScene.get(scene.id).push(cue.text);
    previousEnd = end;
  }
  for (const scene of plan.scenes) {
    const actual = normalizeTranscript(textByScene.get(scene.id).join(" "));
    const expected = normalizeTranscript(scene.narration);
    if (actual !== expected) {
      fail(`Caption transcript does not match scene ${scene.id}`);
    }
  }
  return true;
}

export function validateSceneMarkers(markers, plan) {
  if (!Array.isArray(markers) || markers.length !== plan.scenes.length) {
    fail("Capture receipt must bind exactly one marker per scene");
  }
  for (const [index, scene] of plan.scenes.entries()) {
    const marker = markers[index];
    if (
      marker?.id !== scene.id ||
      marker.startSeconds !== scene.startSeconds ||
      marker.endSeconds !== scene.endSeconds ||
      (marker.markerObserved !== true && marker.observed !== true)
    ) {
      fail(`Capture scene marker ${scene.id} is missing, reordered, or false`);
    }
  }
  return true;
}

export function validateReleaseBinding(receipt, expectedSha) {
  if (
    receipt?.schema !== "archon.demo-video-release-binding" ||
    receipt.version !== 1 ||
    receipt.passed !== true ||
    receipt.repository !== CANONICAL_REPOSITORY ||
    receipt.ref !== "refs/heads/main" ||
    receipt.demoUrl !== CANONICAL_ORIGIN ||
    receipt.releaseSha !== expectedSha ||
    !/^[0-9a-f]{40}$/u.test(receipt.releaseSha)
  ) {
    fail("Release binding does not identify the exact protected main release");
  }
  return true;
}

export function validateCaptureReceipt(
  receipt,
  { expectedSha, planSha256, capturePath, root, release }
) {
  if (
    receipt?.schema !== "archon.demo-video-capture" ||
    receipt.version !== 1 ||
    receipt.passed !== true ||
    receipt.releaseSha !== expectedSha ||
    receipt.canonicalOrigin !== CANONICAL_ORIGIN ||
    receipt.scenePlanSha256 !== planSha256 ||
    receipt.width !== 1920 ||
    receipt.height !== 1080 ||
    receipt.compositionTargetFps !== 30 ||
    receipt.rawVideoTailSeconds !== 2 ||
    receipt.sceneCount !== 7 ||
    receipt.liveProofBefore !== true ||
    receipt.liveProofAfter !== true ||
    receipt.cspEnforcedBefore !== true ||
    receipt.cspEnforcedAfter !== true ||
    receipt.recordingCspBypassedForOwnedOverlay !== true ||
    receipt.crossOriginRequests !== 0 ||
    receipt.consoleErrors !== 0 ||
    receipt.pageErrors !== 0
  ) {
    fail("Capture receipt does not satisfy the exact live-capture contract");
  }
  if (
    receipt.evidenceRuns?.deploy !== release?.selectedRuns?.deploy?.id ||
    receipt.evidenceRuns?.dast !== release?.selectedRuns?.hostedDast?.id ||
    receipt.evidenceRuns?.managedMcp !==
      release?.selectedRuns?.managedMcp?.id ||
    receipt.evidenceRuns?.recovery !== release?.selectedRuns?.recovery?.id
  ) {
    fail("Capture evidence cards do not bind the selected release runs");
  }
  const markers = receipt.scenes ?? receipt.sceneMarkers;
  const plan = loadScenePlan();
  validateSceneMarkers(markers, plan);
  if (
    receipt.markerSample?.x !== 1876 ||
    receipt.markerSample?.y !== 1036 ||
    receipt.markerSample?.width !== 40 ||
    receipt.markerSample?.height !== 40 ||
    !Array.isArray(receipt.sceneMarkers) ||
    receipt.sceneMarkers.length !== plan.scenes.length
  ) {
    fail("Capture receipt does not bind the canonical pixel marker geometry");
  }
  for (const [index, scene] of plan.scenes.entries()) {
    if (receipt.sceneMarkers[index]?.color !== scene.color) {
      fail(`Capture receipt does not bind marker color for ${scene.id}`);
    }
  }
  assertFileEvidence(
    capturePath,
    receipt.capture ?? receipt.video,
    "Production capture"
  );
  if (
    receipt.capture?.path !== relative(root, capturePath).split(sep).join("/")
    || receipt.captureSha256 !== receipt.capture?.sha256
  ) {
    fail("Capture receipt path does not identify the production capture");
  }
  if (
    !Array.isArray(receipt.screenshots) ||
    receipt.screenshots.length !== EXPECTED_CAPTURE_SCREENSHOTS.length
  ) {
    fail("Capture receipt must bind the eight canonical screenshots");
  }
  for (const [index, name] of EXPECTED_CAPTURE_SCREENSHOTS.entries()) {
    const expectedPath = `capture/${name}`;
    const evidence = receipt.screenshots[index];
    if (evidence?.path !== expectedPath) {
      fail(`Capture screenshot receipt path is invalid for ${name}`);
    }
    const screenshotPath = assertInputFile(
      root,
      expectedPath,
      `Capture screenshot ${name}`
    );
    assertFileEvidence(
      screenshotPath,
      evidence,
      `Capture screenshot ${name}`
    );
  }
  return true;
}

export function validateNarrationReceipt(
  receipt,
  { plan, planSha256, root, expectedSha }
) {
  if (
    receipt?.schema !== "archon.demo-video-narration" ||
    receipt.version !== 1 ||
    receipt.passed !== true ||
    receipt.provider !== "ElevenLabs" ||
    receipt.modelId !== plan.voice.modelId ||
    receipt.voiceId !== plan.voice.voiceId ||
    receipt.outputFormat !== plan.voice.outputFormat ||
    receipt.voiceRightsAttested !== true ||
    receipt.allAlignmentsValid !== true ||
    receipt.sceneCount !== plan.scenes.length ||
    receipt.scenePlanSha256 !== planSha256 ||
    receipt.sourceSha !== expectedSha ||
    !/^[0-9a-f]{40}$/u.test(receipt.sourceSha) ||
    !Array.isArray(receipt.scenes) ||
    receipt.scenes.length !== plan.scenes.length
  ) {
    fail("Narration receipt does not satisfy the timestamped voice contract");
  }
  for (const [index, scene] of plan.scenes.entries()) {
    const evidence = receipt.scenes[index];
    if (
      evidence?.id !== scene.id ||
      evidence.startSeconds !== scene.startSeconds ||
      evidence.endSeconds !== scene.endSeconds ||
      evidence.alignmentValid !== true
    ) {
      fail(`Narration receipt does not bind scene ${scene.id}`);
    }
    const audio = assertInputFile(
      root,
      `narration/${scene.id}.mp3`,
      `Narration audio ${scene.id}`
    );
    if (evidence.audio?.path !== `narration/${scene.id}.mp3`) {
      fail(`Narration receipt path is invalid for scene ${scene.id}`);
    }
    assertFileEvidence(audio, evidence.audio, `Narration audio ${scene.id}`);
  }
  const captions = assertInputFile(
    root,
    "narration/captions.en.srt",
    "Narration captions"
  );
  if (receipt.captions?.path !== "narration/captions.en.srt") {
    fail("Narration caption receipt path is invalid");
  }
  assertFileEvidence(captions, receipt.captions, "Narration captions");
  validateCaptionsAgainstPlan(
    parseSrt(readFileSync(captions, "utf8")),
    plan
  );
  return true;
}

export function runCommand(
  executable,
  args,
  { env = process.env, label = executable, maxBuffer = 32 * 1024 * 1024 } = {}
) {
  if (!Array.isArray(args) || args.some((value) => typeof value !== "string")) {
    fail(`${label} arguments must be an array of strings`);
  }
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    env,
    maxBuffer,
    shell: false,
    windowsHide: true,
  });
  if (result.error) {
    fail(`${label} failed to start: ${result.error.message}`);
  }
  if (result.signal || result.status !== 0) {
    const detail = String(result.stderr ?? "").trim().slice(-4000);
    fail(
      `${label} failed with ${result.signal ?? `exit ${result.status}`}${
        detail ? `: ${detail}` : ""
      }`
    );
  }
  return {
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

export function runCommandBinary(
  executable,
  args,
  { env = process.env, label = executable, maxBuffer = 1024 * 1024 } = {}
) {
  if (!Array.isArray(args) || args.some((value) => typeof value !== "string")) {
    fail(`${label} arguments must be an array of strings`);
  }
  const result = spawnSync(executable, args, {
    encoding: null,
    env,
    maxBuffer,
    shell: false,
    windowsHide: true,
  });
  if (result.error) {
    fail(`${label} failed to start: ${result.error.message}`);
  }
  if (result.signal || result.status !== 0) {
    const detail = Buffer.from(result.stderr ?? [])
      .toString("utf8")
      .trim()
      .slice(-4000);
    fail(
      `${label} failed with ${result.signal ?? `exit ${result.status}`}${
        detail ? `: ${detail}` : ""
      }`
    );
  }
  return {
    stdout: Buffer.from(result.stdout ?? []),
    stderr: Buffer.from(result.stderr ?? []),
  };
}

export function ffprobeJson(ffprobe, mediaPath) {
  const { stdout } = runCommand(
    ffprobe,
    [
      "-v",
      "error",
      "-show_format",
      "-show_streams",
      "-print_format",
      "json",
      mediaPath,
    ],
    { label: "ffprobe" }
  );
  let result;
  try {
    result = JSON.parse(stdout);
  } catch (error) {
    fail(`ffprobe did not emit valid JSON: ${error.message}`);
  }
  return result;
}

function numericMediaField(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    fail(`${label} is missing from ffprobe output`);
  }
  return number;
}

function frameRate(value) {
  const match = /^(\d+)\/(\d+)$/u.exec(String(value));
  if (!match || Number(match[2]) === 0) {
    fail("Video frame rate is invalid");
  }
  return Number(match[1]) / Number(match[2]);
}

export function validateMediaProbe(
  probe,
  {
    durationSeconds,
    width,
    height,
    fps,
    durationToleranceSeconds = 0.12,
    avToleranceSeconds = 0.12,
    strictCodecs = true,
  }
) {
  const streams = Array.isArray(probe?.streams) ? probe.streams : [];
  const videos = streams.filter((stream) => stream.codec_type === "video");
  const audios = streams.filter((stream) => stream.codec_type === "audio");
  if (videos.length !== 1 || audios.length !== 1 || streams.length !== 2) {
    fail("Final media must contain exactly one video and one audio stream");
  }
  const video = videos[0];
  const audio = audios[0];
  const containerDuration = numericMediaField(
    probe?.format?.duration,
    "Container duration"
  );
  const videoDuration = numericMediaField(
    video.duration ?? probe?.format?.duration,
    "Video duration"
  );
  const audioDuration = numericMediaField(audio.duration, "Audio duration");
  if (
    Math.abs(containerDuration - durationSeconds) > durationToleranceSeconds ||
    Math.abs(videoDuration - durationSeconds) > durationToleranceSeconds ||
    Math.abs(audioDuration - durationSeconds) > durationToleranceSeconds
  ) {
    fail("Container, video, or audio duration misses the exact target");
  }
  if (Math.abs(videoDuration - audioDuration) > avToleranceSeconds) {
    fail("Audio/video duration mismatch exceeds tolerance");
  }
  if (
    video.width !== width ||
    video.height !== height ||
    Math.abs(frameRate(video.avg_frame_rate ?? video.r_frame_rate) - fps) >
      0.001
  ) {
    fail("Video dimensions or frame rate miss the exact contract");
  }
  if (strictCodecs) {
    if (
      video.codec_name !== "h264" ||
      video.profile !== "High" ||
      video.pix_fmt !== "yuv420p" ||
      audio.codec_name !== "aac" ||
      Number(audio.sample_rate) !== 48_000 ||
      Number(audio.channels) !== 2
    ) {
      fail("Video/audio codec contract is not H264 High/yuv420p/AAC 48k stereo");
    }
  }
  return {
    durationSeconds: containerDuration,
    videoDurationSeconds: videoDuration,
    audioDurationSeconds: audioDuration,
    width: video.width,
    height: video.height,
    fps: frameRate(video.avg_frame_rate ?? video.r_frame_rate),
    videoCodec: video.codec_name,
    videoProfile: video.profile,
    pixelFormat: video.pix_fmt,
    audioCodec: audio.codec_name,
    audioSampleRate: Number(audio.sample_rate),
    audioChannels: Number(audio.channels),
  };
}

export function parseLoudnormMetrics(stderr) {
  const blocks = String(stderr).match(/\{[^{}]*"input_i"[^{}]*\}/gu) ?? [];
  if (blocks.length === 0) {
    fail("FFmpeg loudnorm analysis did not emit JSON metrics");
  }
  let parsed;
  try {
    parsed = JSON.parse(blocks.at(-1));
  } catch (error) {
    fail(`FFmpeg loudnorm metrics are invalid JSON: ${error.message}`);
  }
  const result = {
    integratedLufs: Number(parsed.input_i),
    truePeakDbtp: Number(parsed.input_tp),
    loudnessRangeLu: Number(parsed.input_lra),
    thresholdLufs: Number(parsed.input_thresh),
    targetOffsetLu: Number(parsed.target_offset),
  };
  if (Object.values(result).some((value) => !Number.isFinite(value))) {
    fail("FFmpeg loudnorm metrics contain a non-finite measurement");
  }
  return result;
}

export function validateLoudness(metrics) {
  if (
    metrics.integratedLufs < -17 ||
    metrics.integratedLufs > -15 ||
    metrics.truePeakDbtp > -1 ||
    metrics.loudnessRangeLu < 0 ||
    metrics.loudnessRangeLu > 12
  ) {
    fail("Final audio misses the -16 LUFS / true-peak / LRA contract");
  }
  return true;
}

export function expectedReleaseSha(env = process.env) {
  const value = requireNonEmptyEnv("DEMO_VIDEO_EXPECTED_SHA", env);
  if (!/^[0-9a-f]{40}$/u.test(value)) {
    fail("DEMO_VIDEO_EXPECTED_SHA must be a lowercase 40-character SHA");
  }
  return value;
}

export function assertExecutableInRunnerTemp(path, label, env = process.env) {
  const target = assertRunnerTempPath(path, {
    env,
    label,
    mustExist: true,
  });
  const metadata = lstatSync(target);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    fail(`${label} must be a regular non-symlink file`);
  }
  if ((metadata.mode & 0o111) === 0) {
    fail(`${label} must be executable`);
  }
  return target;
}

export function escapeFfmpegFilterPath(path) {
  return path
    .replaceAll("\\", "\\\\")
    .replaceAll(":", "\\:")
    .replaceAll("'", "\\'")
    .replaceAll(",", "\\,")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]");
}

export function isMain(importMetaUrl) {
  if (!process.argv[1]) return false;
  return pathToFileURL(resolve(process.argv[1])).href === importMetaUrl;
}
