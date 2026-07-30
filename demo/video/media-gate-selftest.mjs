import { rmSync, writeFileSync } from "node:fs";
import {
  assertExecutableInRunnerTemp,
  assertFileEvidence,
  demoVideoRoot,
  ensureOutputDirectory,
  ffprobeJson,
  fileEvidence,
  isMain,
  outputPath,
  parseSrt,
  runCommand,
  serializeSrt,
  validateCaptionsAgainstPlan,
  validateMediaProbe,
  validateSceneMarkers,
  validateScenePlan,
  writeFileAtomic,
} from "./lib.mjs";
import {
  runFullDecode,
  sampleSceneMarkers,
} from "./verify-video.mjs";

function expectFailure(callback, pattern, label) {
  try {
    callback();
  } catch (error) {
    if (pattern.test(error.message)) return;
    throw new Error(`${label} failed for an unexpected reason: ${error.message}`);
  }
  throw new Error(`${label} did not fail closed`);
}

function syntheticPlan() {
  const ids = [
    "hook",
    "scope-architecture",
    "recall-grounding",
    "audit",
    "proof",
    "managed-mcp",
    "close",
  ];
  return validateScenePlan(
    {
      schema: "archon.demo-video-plan",
      version: 1,
      targetDurationSeconds: ids.length,
      width: 320,
      height: 180,
      fps: 30,
      scenes: ids.map((id, index) => ({
        id,
        startSeconds: index,
        endSeconds: index + 1,
        color: [
          "#34d399",
          "#38bdf8",
          "#fbbf24",
          "#fb7185",
          "#a78bfa",
          "#22d3ee",
          "#f8fafc",
        ][index],
        narration: `Synthetic narration contract for scene ${id}.`,
      })),
    },
    { canonical: false }
  );
}

function createMedia(
  ffmpeg,
  path,
  audioDurationSeconds,
  plan,
  { reorderMarkers = false } = {}
) {
  const markerColors = plan.scenes.map((scene) => scene.color);
  if (reorderMarkers) {
    [markerColors[1], markerColors[2]] = [
      markerColors[2],
      markerColors[1],
    ];
  }
  const markerFilters = plan.scenes
    .map(
      (scene, index) =>
        "drawbox=x=294:y=154:w=20:h=20:" +
        `color=${markerColors[index]}:t=fill:` +
        `enable='gte(t,${scene.startSeconds})*lt(t,${scene.endSeconds})'`
    )
    .join(",");
  runCommand(
    ffmpeg,
    [
      "-hide_banner",
      "-nostdin",
      "-n",
      "-f",
      "lavfi",
      "-i",
      `color=c=0x07111f:s=320x180:r=30:d=${plan.targetDurationSeconds}`,
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=880:sample_rate=48000:duration=${audioDurationSeconds}`,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-vf",
      markerFilters,
      "-c:v",
      "libx264",
      "-profile:v",
      "high",
      "-pix_fmt",
      "yuv420p",
      "-r",
      "30",
      "-c:a",
      "aac",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-t",
      String(plan.targetDurationSeconds),
      "-f",
      "mp4",
      path,
    ],
    { label: "FFmpeg media-gate self-test" }
  );
}

export function runMediaGateSelftest({ env = process.env } = {}) {
  const root = demoVideoRoot(env, { create: false });
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
  const selftest = outputPath(root, "selftest", "Self-test directory");
  ensureOutputDirectory(root, "selftest");
  const good = outputPath(root, "selftest/good.mp4");
  const badAv = outputPath(root, "selftest/bad-av.mp4");
  const badMarkers = outputPath(root, "selftest/bad-markers.mp4");
  const plan = syntheticPlan();
  const markerSample = { x: 300, y: 160, width: 20, height: 20 };

  try {
    createMedia(ffmpeg, good, plan.targetDurationSeconds, plan);
    const goodMetrics = validateMediaProbe(ffprobeJson(ffprobe, good), {
      durationSeconds: plan.targetDurationSeconds,
      width: 320,
      height: 180,
      fps: 30,
      durationToleranceSeconds: 0.15,
      avToleranceSeconds: 0.15,
    });
    runFullDecode(ffmpeg, good, env);
    sampleSceneMarkers(ffmpeg, good, plan, markerSample, env);

    createMedia(ffmpeg, badAv, 1, plan);
    expectFailure(
      () =>
        validateMediaProbe(ffprobeJson(ffprobe, badAv), {
          durationSeconds: plan.targetDurationSeconds,
          width: 320,
          height: 180,
          fps: 30,
          durationToleranceSeconds: 0.15,
          avToleranceSeconds: 0.15,
        }),
      /duration|Audio\/video/u,
      "A/V mismatch mutant"
    );

    createMedia(
      ffmpeg,
      badMarkers,
      plan.targetDurationSeconds,
      plan,
      { reorderMarkers: true }
    );
    expectFailure(
      () =>
        sampleSceneMarkers(
          ffmpeg,
          badMarkers,
          plan,
          markerSample,
          env
        ),
      /marker pixel/u,
      "Final-media scene-order mutant"
    );

    const markers = plan.scenes.map((scene) => ({
      id: scene.id,
      startSeconds: scene.startSeconds,
      endSeconds: scene.endSeconds,
      markerObserved: true,
    }));
    validateSceneMarkers(markers, plan);
    const reordered = [...markers];
    [reordered[1], reordered[2]] = [reordered[2], reordered[1]];
    expectFailure(
      () => validateSceneMarkers(reordered, plan),
      /reordered/u,
      "Scene-order mutant"
    );

    const cues = plan.scenes.map((scene) => ({
      startSeconds: scene.startSeconds + 0.05,
      endSeconds: scene.endSeconds - 0.05,
      text: scene.narration,
    }));
    const parsedCues = parseSrt(serializeSrt(cues));
    validateCaptionsAgainstPlan(parsedCues, plan);
    const mismatchedCues = parsedCues.map((cue, index) => ({
      ...cue,
      text: index === 3 ? "Tampered caption transcript." : cue.text,
    }));
    expectFailure(
      () => validateCaptionsAgainstPlan(mismatchedCues, plan),
      /does not match/u,
      "Caption-transcript mutant"
    );

    const hashFixture = writeFileAtomic(
      root,
      "selftest/hash-fixture.txt",
      "immutable receipt-bound fixture\n",
      { encoding: "utf8" }
    );
    const evidence = fileEvidence(hashFixture, root);
    assertFileEvidence(hashFixture, evidence, "Self-test hash fixture");
    writeFileSync(hashFixture, "tampered receipt-bound fixture\n", "utf8");
    expectFailure(
      () => assertFileEvidence(hashFixture, evidence, "Self-test hash fixture"),
      /byte count|hash/u,
      "Receipt/hash mutant"
    );

    return {
      passed: true,
      goodMedia: goodMetrics,
      rejectedMutants: [
        "audio-video-duration-mismatch",
        "final-media-scene-marker-reorder",
        "scene-marker-reorder",
        "caption-transcript-mismatch",
        "receipt-hash-tamper",
      ],
    };
  } finally {
    rmSync(selftest, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  try {
    const result = runMediaGateSelftest();
    process.stdout.write(
      `Media gate self-test passed; rejected ${result.rejectedMutants.length} mutants.\n`
    );
  } catch (error) {
    process.stderr.write(`Media gate self-test failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
