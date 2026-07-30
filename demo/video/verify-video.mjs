import { readFileSync } from "node:fs";
import {
  DEFAULT_SCENE_PLAN,
  assertExecutableInRunnerTemp,
  assertFileEvidence,
  assertInputFile,
  demoVideoRoot,
  expectedReleaseSha,
  ffprobeJson,
  fileEvidence,
  isMain,
  loadScenePlan,
  parseLoudnormMetrics,
  parseSrt,
  readJson,
  runCommand,
  runCommandBinary,
  sha256File,
  stableJson,
  validateCaptionsAgainstPlan,
  validateCaptureReceipt,
  validateLoudness,
  validateMediaProbe,
  validateNarrationReceipt,
  validateReleaseBinding,
  validateSceneMarkers,
  writeFileAtomic,
} from "./lib.mjs";

function evidencePathIs(evidence, expected, label) {
  if (evidence?.path !== expected) {
    throw new Error(`${label} receipt path is not canonical`);
  }
}

export function validateBuildReceipt(
  receipt,
  {
    expectedSha,
    plan,
    planSha256,
    files,
  }
) {
  if (
    receipt?.schema !== "archon.demo-video-build" ||
    receipt.version !== 1 ||
    receipt.passed !== true ||
    receipt.releaseSha !== expectedSha ||
    receipt.scenePlanSha256 !== planSha256 ||
    receipt.targetDurationSeconds !== plan.targetDurationSeconds ||
    receipt.width !== plan.width ||
    receipt.height !== plan.height ||
    receipt.fps !== plan.fps ||
    receipt.videoCodec !== "h264" ||
    receipt.videoProfile !== "High" ||
    receipt.pixelFormat !== "yuv420p" ||
    receipt.audioCodec !== "aac" ||
    receipt.audioSampleRate !== 48_000 ||
    receipt.audioChannels !== 2 ||
    receipt.rawVideoTailSeconds !== 2 ||
    receipt.captionsBurned !== true ||
    receipt.captionsLanguage !== "en" ||
    receipt.loudnessTarget?.integratedLufs !== -16 ||
    receipt.loudnessTarget?.loudnessRangeLu !== 7 ||
    receipt.loudnessTarget?.truePeakDbtp !== -1.5 ||
    !Array.isArray(receipt.scenes) ||
    receipt.scenes.length !== plan.scenes.length
  ) {
    throw new Error("Video build receipt misses the canonical media contract");
  }
  for (const [index, scene] of plan.scenes.entries()) {
    const actual = receipt.scenes[index];
    if (
      actual?.id !== scene.id ||
      actual.startSeconds !== scene.startSeconds ||
      actual.endSeconds !== scene.endSeconds
    ) {
      throw new Error(`Video build receipt reordered scene ${scene.id}`);
    }
  }
  const bindings = [
    [
      "Toolchain provenance",
      files.toolchain,
      receipt.inputs?.toolchainProvenance,
    ],
    ["Release binding", files.release, receipt.inputs?.releaseBinding],
    ["Capture receipt", files.captureReceipt, receipt.inputs?.captureReceipt],
    ["Production capture", files.capture, receipt.inputs?.capture],
    [
      "Narration receipt",
      files.narrationReceipt,
      receipt.inputs?.narrationReceipt,
    ],
    [
      "Narration captions",
      files.narrationCaptions,
      receipt.inputs?.narrationCaptions,
    ],
    ["Final video", files.video, receipt.output],
    ["Final captions", files.captions, receipt.captions],
  ];
  for (const [label, path, evidence] of bindings) {
    assertFileEvidence(path, evidence, label);
  }
  const expectedPaths = {
    toolchainProvenance: "toolchain-provenance.json",
    releaseBinding: "release/video-release-binding.json",
    captureReceipt: "capture/capture-receipt.json",
    capture: "capture/production-capture.webm",
    narrationReceipt: "narration/narration-receipt.json",
    narrationCaptions: "narration/captions.en.srt",
  };
  for (const [key, expected] of Object.entries(expectedPaths)) {
    evidencePathIs(receipt.inputs[key], expected, key);
  }
  evidencePathIs(receipt.output, "output/archon-memory-demo.mp4", "video");
  evidencePathIs(receipt.captions, "output/captions.en.srt", "captions");

  if (
    !Array.isArray(receipt.inputs?.narrationAudio) ||
    receipt.inputs.narrationAudio.length !== plan.scenes.length
  ) {
    throw new Error("Video build receipt lacks per-scene narration hashes");
  }
  for (const [index, scene] of plan.scenes.entries()) {
    const evidence = receipt.inputs.narrationAudio[index];
    evidencePathIs(
      evidence,
      `narration/${scene.id}.mp3`,
      `narration ${scene.id}`
    );
    assertFileEvidence(
      files.narrationAudio[index],
      evidence,
      `Narration ${scene.id}`
    );
  }
  return true;
}

export function runFullDecode(ffmpeg, videoPath, env = process.env) {
  runCommand(
    ffmpeg,
    [
      "-hide_banner",
      "-nostdin",
      "-v",
      "error",
      "-xerror",
      "-i",
      videoPath,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0",
      "-f",
      "null",
      "-",
    ],
    {
      label: "FFmpeg full decode",
      env: { ...env, LC_ALL: "C.UTF-8", LANG: "C.UTF-8", TZ: "UTC" },
      maxBuffer: 64 * 1024 * 1024,
    }
  );
  return true;
}

export function measureLoudness(ffmpeg, videoPath, env = process.env) {
  const result = runCommand(
    ffmpeg,
    [
      "-hide_banner",
      "-nostdin",
      "-nostats",
      "-i",
      videoPath,
      "-map",
      "0:a:0",
      "-af",
      "loudnorm=I=-16:LRA=7:TP=-1.5:print_format=json",
      "-f",
      "null",
      "-",
    ],
    {
      label: "FFmpeg loudness analysis",
      env: { ...env, LC_ALL: "C.UTF-8", LANG: "C.UTF-8", TZ: "UTC" },
      maxBuffer: 64 * 1024 * 1024,
    }
  );
  const metrics = parseLoudnormMetrics(result.stderr);
  validateLoudness(metrics);
  return metrics;
}

function hexRgb(color) {
  const match = /^#(?<red>[0-9a-f]{2})(?<green>[0-9a-f]{2})(?<blue>[0-9a-f]{2})$/iu.exec(
    color
  );
  if (!match?.groups) {
    throw new Error(`Invalid scene marker color: ${color}`);
  }
  return [
    Number.parseInt(match.groups.red, 16),
    Number.parseInt(match.groups.green, 16),
    Number.parseInt(match.groups.blue, 16),
  ];
}

export function sampleSceneMarkers(
  ffmpeg,
  videoPath,
  plan,
  markerSample,
  env = process.env,
  { channelTolerance = 20 } = {}
) {
  const x = markerSample?.x;
  const y = markerSample?.y;
  if (
    !Number.isSafeInteger(x) ||
    !Number.isSafeInteger(y) ||
    x < 0 ||
    y < 0 ||
    x >= plan.width ||
    y >= plan.height
  ) {
    throw new Error("Scene marker sample coordinate is invalid");
  }
  const samples = [];
  for (const scene of plan.scenes) {
    const sampleTimeSeconds = Math.min(
      scene.startSeconds + 2,
      scene.endSeconds - 0.25
    );
    const result = runCommandBinary(
      ffmpeg,
      [
        "-hide_banner",
        "-nostdin",
        "-v",
        "error",
        "-ss",
        sampleTimeSeconds.toFixed(3),
        "-i",
        videoPath,
        "-frames:v",
        "1",
        "-vf",
        `format=rgb24,crop=1:1:${x}:${y}`,
        "-f",
        "rawvideo",
        "pipe:1",
      ],
      {
        label: `FFmpeg scene marker sample ${scene.id}`,
        env: { ...env, LC_ALL: "C.UTF-8", LANG: "C.UTF-8", TZ: "UTC" },
      }
    );
    if (result.stdout.length !== 3) {
      throw new Error(`Scene ${scene.id} did not yield exactly one RGB pixel`);
    }
    const expectedRgb = hexRgb(scene.color);
    const actualRgb = [...result.stdout];
    const channelDelta = actualRgb.map((value, index) =>
      Math.abs(value - expectedRgb[index])
    );
    if (channelDelta.some((value) => value > channelTolerance)) {
      throw new Error(
        `Final-media scene marker pixel does not match ${scene.id}`
      );
    }
    samples.push({
      id: scene.id,
      sampleTimeSeconds,
      expectedColor: scene.color,
      actualRgb,
      maxChannelDelta: Math.max(...channelDelta),
      passed: true,
    });
  }
  return samples;
}

export function verifyVideo({
  env = process.env,
  planPath = DEFAULT_SCENE_PLAN,
} = {}) {
  const root = demoVideoRoot(env, { create: false });
  const plan = loadScenePlan(planPath);
  const planSha256 = sha256File(planPath);
  const expectedSha = expectedReleaseSha(env);
  const ffmpeg = assertExecutableInRunnerTemp(
    env.FFMPEG,
    "FFMPEG",
    env
  );
  const ffprobe = assertExecutableInRunnerTemp(
    env.FFPROBE,
    "FFPROBE",
    env
  );

  const files = {
    toolchain: assertInputFile(
      root,
      "toolchain-provenance.json",
      "Toolchain provenance"
    ),
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
    buildReceipt: assertInputFile(
      root,
      "output/video-build-receipt.json",
      "Video build receipt"
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
    narrationAudio: plan.scenes.map((scene) =>
      assertInputFile(
        root,
        `narration/${scene.id}.mp3`,
        `Narration ${scene.id}`
      )
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
  const build = readJson(files.buildReceipt, "Video build receipt");
  validateBuildReceipt(build, {
    expectedSha,
    plan,
    planSha256,
    files,
  });

  const narrationCaptionsHash = sha256File(files.narrationCaptions);
  const finalCaptionsHash = sha256File(files.captions);
  if (narrationCaptionsHash !== finalCaptionsHash) {
    throw new Error("Final captions differ from timestamped narration");
  }
  const cues = parseSrt(readFileSync(files.captions, "utf8"));
  validateCaptionsAgainstPlan(cues, plan);
  validateSceneMarkers(capture.scenes ?? capture.sceneMarkers, plan);

  const media = validateMediaProbe(ffprobeJson(ffprobe, files.video), {
    durationSeconds: plan.targetDurationSeconds,
    width: plan.width,
    height: plan.height,
    fps: plan.fps,
  });
  const markerPixels = sampleSceneMarkers(
    ffmpeg,
    files.video,
    plan,
    capture.markerSample,
    env
  );
  const fullDecodePassed = runFullDecode(ffmpeg, files.video, env);
  const loudness = measureLoudness(ffmpeg, files.video, env);
  const checks = [
    { id: "release-binding-hash", passed: true },
    { id: "capture-receipt-and-hash", passed: true },
    { id: "narration-receipt-and-hashes", passed: true },
    { id: "build-receipt-and-hashes", passed: true },
    { id: "media-contract", passed: true },
    { id: "full-audio-video-decode", passed: fullDecodePassed },
    { id: "loudness-contract", passed: true },
    { id: "alignment-derived-caption-transcript", passed: true },
    { id: "caption-burn-build-binding", passed: true },
    { id: "ordered-scene-markers", passed: true },
    { id: "final-media-scene-marker-pixels", passed: true },
  ];
  const receipt = {
    schema: "archon.demo-video-verification",
    version: 1,
    passed: checks.every((check) => check.passed),
    releaseSha: expectedSha,
    scenePlanSha256: planSha256,
    checks,
    media,
    loudness,
    fullDecodePassed,
    captions: {
      language: "en",
      cueCount: cues.length,
      alignmentDerived: true,
      burnedIntoVideoByPinnedBuild: true,
      transcriptMatchesEveryScene: true,
      file: fileEvidence(files.captions, root),
    },
    sceneMarkers: {
      count: plan.scenes.length,
      exactOrderAndTiming: true,
      pixelMeasuredInFinalMedia: true,
      sample: capture.markerSample,
      results: markerPixels,
    },
    bindings: {
      release: fileEvidence(files.release, root),
      captureReceipt: fileEvidence(files.captureReceipt, root),
      narrationReceipt: fileEvidence(files.narrationReceipt, root),
      buildReceipt: fileEvidence(files.buildReceipt, root),
      video: fileEvidence(files.video, root),
    },
  };
  const receiptPath = writeFileAtomic(
    root,
    "output/video-verification-receipt.json",
    stableJson(receipt),
    { encoding: "utf8" }
  );
  return { receipt, receiptPath };
}

if (isMain(import.meta.url)) {
  try {
    const { receiptPath } = verifyVideo();
    process.stdout.write(`Video verification receipt: ${receiptPath}\n`);
  } catch (error) {
    process.stderr.write(`Video verification gate failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
