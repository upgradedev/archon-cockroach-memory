import { readFileSync } from "node:fs";
import {
  DEFAULT_SCENE_PLAN,
  assertFileEvidence,
  assertInputFile,
  demoVideoRoot,
  expectedReleaseSha,
  isMain,
  loadScenePlan,
  parseSrt,
  readJson,
  sha256File,
  validateCaptionsAgainstPlan,
  validateCaptureReceipt,
  validateLoudness,
  validateNarrationReceipt,
  validateReleaseBinding,
  validateSceneMarkers,
} from "./lib.mjs";
import { validateBuildReceipt } from "./verify-video.mjs";

const EXPECTED_CHECKS = Object.freeze([
  "release-binding-hash",
  "capture-receipt-and-hash",
  "narration-receipt-and-hashes",
  "build-receipt-and-hashes",
  "media-contract",
  "full-audio-video-decode",
  "loudness-contract",
  "alignment-derived-caption-transcript",
  "caption-burn-build-binding",
  "ordered-scene-markers",
  "final-media-scene-marker-pixels",
]);

export function validateVerificationReceipt(
  receipt,
  { expectedSha, plan, planSha256, files }
) {
  if (
    receipt?.schema !== "archon.demo-video-verification" ||
    receipt.version !== 1 ||
    receipt.passed !== true ||
    receipt.releaseSha !== expectedSha ||
    receipt.scenePlanSha256 !== planSha256 ||
    receipt.fullDecodePassed !== true ||
    receipt.captions?.language !== "en" ||
    receipt.captions?.alignmentDerived !== true ||
    receipt.captions?.burnedIntoVideoByPinnedBuild !== true ||
    receipt.captions?.transcriptMatchesEveryScene !== true ||
    receipt.sceneMarkers?.count !== plan.scenes.length ||
    receipt.sceneMarkers?.exactOrderAndTiming !== true ||
    receipt.sceneMarkers?.pixelMeasuredInFinalMedia !== true ||
    !Array.isArray(receipt.sceneMarkers?.results) ||
    receipt.sceneMarkers.results.length !== plan.scenes.length
  ) {
    throw new Error("Verification receipt is not a terminal pass");
  }
  if (
    !Array.isArray(receipt.checks) ||
    receipt.checks.length !== EXPECTED_CHECKS.length
  ) {
    throw new Error("Verification receipt has an incomplete check inventory");
  }
  for (const [index, id] of EXPECTED_CHECKS.entries()) {
    if (receipt.checks[index]?.id !== id || receipt.checks[index].passed !== true) {
      throw new Error(`Verification check ${id} is missing or failed`);
    }
  }
  for (const [index, scene] of plan.scenes.entries()) {
    const sample = receipt.sceneMarkers.results[index];
    if (
      sample?.id !== scene.id ||
      sample.expectedColor !== scene.color ||
      sample.passed !== true ||
      !Number.isFinite(sample.sampleTimeSeconds) ||
      !Number.isFinite(sample.maxChannelDelta) ||
      sample.maxChannelDelta < 0 ||
      sample.maxChannelDelta > 20 ||
      !Array.isArray(sample.actualRgb) ||
      sample.actualRgb.length !== 3 ||
      sample.actualRgb.some(
        (channel) =>
          !Number.isSafeInteger(channel) || channel < 0 || channel > 255
      )
    ) {
      throw new Error(`Final-media marker proof is invalid for ${scene.id}`);
    }
  }
  const bindings = [
    [
      "Release binding",
      files.release,
      receipt.bindings?.release,
      "release/video-release-binding.json",
    ],
    [
      "Capture receipt",
      files.captureReceipt,
      receipt.bindings?.captureReceipt,
      "capture/capture-receipt.json",
    ],
    [
      "Narration receipt",
      files.narrationReceipt,
      receipt.bindings?.narrationReceipt,
      "narration/narration-receipt.json",
    ],
    [
      "Build receipt",
      files.buildReceipt,
      receipt.bindings?.buildReceipt,
      "output/video-build-receipt.json",
    ],
    [
      "Final video",
      files.video,
      receipt.bindings?.video,
      "output/archon-memory-demo.mp4",
    ],
    [
      "Final captions",
      files.captions,
      receipt.captions?.file,
      "output/captions.en.srt",
    ],
  ];
  for (const [label, path, evidence, expectedPath] of bindings) {
    if (evidence?.path !== expectedPath) {
      throw new Error(`${label} verification path is not canonical`);
    }
    assertFileEvidence(path, evidence, label);
  }
  validateLoudness(receipt.loudness);
  return true;
}

export function assertVideoReceipt({
  env = process.env,
  planPath = DEFAULT_SCENE_PLAN,
} = {}) {
  const root = demoVideoRoot(env, { create: false });
  const plan = loadScenePlan(planPath);
  const planSha256 = sha256File(planPath);
  const expectedSha = expectedReleaseSha(env);
  const files = {
    release: assertInputFile(
      root,
      "release/video-release-binding.json",
      "Release binding"
    ),
    captureReceipt: assertInputFile(
      root,
      "capture/capture-receipt.json",
      "Capture receipt"
    ),
    capture: assertInputFile(
      root,
      "capture/production-capture.webm",
      "Production capture"
    ),
    narrationReceipt: assertInputFile(
      root,
      "narration/narration-receipt.json",
      "Narration receipt"
    ),
    narrationCaptions: assertInputFile(
      root,
      "narration/captions.en.srt",
      "Narration captions"
    ),
    narrationAudio: plan.scenes.map((scene) =>
      assertInputFile(
        root,
        `narration/${scene.id}.mp3`,
        `Narration ${scene.id}`
      )
    ),
    buildReceipt: assertInputFile(
      root,
      "output/video-build-receipt.json",
      "Build receipt"
    ),
    verificationReceipt: assertInputFile(
      root,
      "output/video-verification-receipt.json",
      "Verification receipt"
    ),
    video: assertInputFile(
      root,
      "output/archon-memory-demo.mp4",
      "Final video"
    ),
    captions: assertInputFile(
      root,
      "output/captions.en.srt",
      "Final captions"
    ),
    toolchain: assertInputFile(
      root,
      "toolchain-provenance.json",
      "Toolchain provenance"
    ),
  };

  const release = readJson(files.release, "Release binding");
  validateReleaseBinding(release, expectedSha);
  const capture = readJson(files.captureReceipt, "Capture receipt");
  validateCaptureReceipt(capture, {
    expectedSha,
    planSha256,
    capturePath: files.capture,
    root,
    release,
  });
  const narration = readJson(
    files.narrationReceipt,
    "Narration receipt"
  );
  validateNarrationReceipt(narration, {
    plan,
    planSha256,
    root,
    expectedSha,
  });
  const build = readJson(files.buildReceipt, "Build receipt");
  validateBuildReceipt(build, {
    expectedSha,
    plan,
    planSha256,
    files,
  });
  const verification = readJson(
    files.verificationReceipt,
    "Verification receipt"
  );
  validateVerificationReceipt(verification, {
    expectedSha,
    plan,
    planSha256,
    files,
  });

  const toolchain = readJson(files.toolchain, "Toolchain provenance");
  if (
    toolchain.schema !== "archon.demo-video-toolchain" ||
    toolchain.version !== 1 ||
    toolchain.passed !== true ||
    toolchain.provider !== "BtbN/FFmpeg-Builds" ||
    toolchain.releaseTag !== "autobuild-2026-07-19-13-12" ||
    toolchain.ffmpegVersion !== "n7.1.5-2-g998de74adf" ||
    toolchain.archive?.bytes !== 119_354_960 ||
    toolchain.archive?.sha256 !==
      "b8ed29dc71fe17f05f43e2d9dbfde89edf43270c3de13ce3c4d70f5df1f47e61"
  ) {
    throw new Error("Toolchain provenance does not match the exact pin");
  }
  if (
    build.inputs?.toolchainProvenance?.path !==
    "toolchain-provenance.json"
  ) {
    throw new Error("Build receipt does not bind toolchain provenance");
  }
  assertFileEvidence(
    files.toolchain,
    build.inputs.toolchainProvenance,
    "Toolchain provenance"
  );

  if (sha256File(files.narrationCaptions) !== sha256File(files.captions)) {
    throw new Error("Caption hashes disagree at the terminal gate");
  }
  validateCaptionsAgainstPlan(
    parseSrt(readFileSync(files.captions, "utf8")),
    plan
  );
  validateSceneMarkers(capture.scenes ?? capture.sceneMarkers, plan);

  return {
    passed: true,
    releaseSha: expectedSha,
    videoSha256: sha256File(files.video),
    captionsSha256: sha256File(files.captions),
    verificationReceiptSha256: sha256File(files.verificationReceipt),
    receiptCount: 6,
  };
}

if (isMain(import.meta.url)) {
  try {
    const result = assertVideoReceipt();
    process.stdout.write(
      `Terminal video receipt assertion passed for ${result.releaseSha}; ` +
        `video sha256 ${result.videoSha256}\n`
    );
  } catch (error) {
    process.stderr.write(
      `Terminal video receipt assertion failed: ${error.message}\n`
    );
    process.exitCode = 1;
  }
}
