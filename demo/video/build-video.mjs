import {
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import {
  DEFAULT_SCENE_PLAN,
  assertExecutableInRunnerTemp,
  assertFileEvidence,
  assertInputFile,
  demoVideoRoot,
  ensureOutputDirectory,
  escapeFfmpegFilterPath,
  expectedReleaseSha,
  ffprobeJson,
  fileEvidence,
  isMain,
  loadScenePlan,
  outputPath,
  readJson,
  runCommand,
  sha256File,
  stableJson,
  validateCaptureReceipt,
  validateNarrationReceipt,
  validateReleaseBinding,
  writeFileAtomic,
} from "./lib.mjs";

function requireExactReleaseReceiptPath(root, env) {
  const expected = outputPath(
    root,
    "release/video-release-binding.json",
    "Release binding"
  );
  const configured = env.DEMO_VIDEO_RELEASE_RECEIPT;
  if (
    typeof configured !== "string" ||
    configured === "" ||
    configured !== expected
  ) {
    throw new Error(
      "DEMO_VIDEO_RELEASE_RECEIPT must be the exact release binding under DEMO_VIDEO_ROOT"
    );
  }
  return assertInputFile(
    root,
    "release/video-release-binding.json",
    "Release binding"
  );
}

function parseCaptureFrameRate(video) {
  for (const value of [video.avg_frame_rate, video.r_frame_rate]) {
    const match = /^(\d+)\/(\d+)$/u.exec(String(value));
    if (!match || Number(match[2]) === 0) continue;
    const rate = Number(match[1]) / Number(match[2]);
    if (Number.isFinite(rate) && rate >= 20 && rate <= 60) {
      return rate;
    }
  }
  throw new Error("Capture frame rate is outside the sane 20-60fps range");
}

export function validateCaptureProbe(
  probe,
  plan,
  rawVideoTrimLeadSeconds
) {
  const streams = Array.isArray(probe?.streams) ? probe.streams : [];
  const videos = streams.filter((stream) => stream.codec_type === "video");
  const audios = streams.filter((stream) => stream.codec_type === "audio");
  if (videos.length !== 1 || audios.length !== 0) {
    throw new Error(
      "Browser capture must contain exactly one silent video stream"
    );
  }
  const video = videos[0];
  const duration = Number(probe?.format?.duration);
  const fps = parseCaptureFrameRate(video);
  if (
    !Number.isFinite(duration) ||
    duration + 0.12 <
      rawVideoTrimLeadSeconds + plan.targetDurationSeconds
  ) {
    throw new Error("Browser capture is shorter than the canonical timeline");
  }
  if (
    video.width !== plan.width ||
    video.height !== plan.height ||
    fps < 20 ||
    fps > 60
  ) {
    throw new Error(
      "Browser capture dimensions or frame rate are outside the sane range"
    );
  }
  return {
    codec: video.codec_name,
    durationSeconds: duration,
    width: video.width,
    height: video.height,
    fps,
    audioStreams: 0,
  };
}

function audioFilters(plan) {
  const filters = [];
  const labels = [];
  plan.scenes.forEach((scene, index) => {
    const input = index + 1;
    const duration = scene.endSeconds - scene.startSeconds;
    const delayMilliseconds = Math.round(scene.startSeconds * 1000);
    const label = `scene_audio_${index}`;
    filters.push(
      `[${input}:a:0]aresample=48000,` +
        `atrim=start=0:end=${duration},asetpts=PTS-STARTPTS,` +
        `apad=pad_dur=${duration},atrim=start=0:end=${duration},` +
        `adelay=${delayMilliseconds}:all=1[${label}]`
    );
    labels.push(`[${label}]`);
  });
  filters.push(
    `${labels.join("")}amix=inputs=${labels.length}:duration=longest:` +
      "dropout_transition=0:normalize=0," +
      "loudnorm=I=-16:LRA=7:TP=-1.5," +
      "aresample=48000," +
      "aformat=sample_fmts=fltp:sample_rates=48000:" +
      "channel_layouts=stereo," +
      `atrim=start=0:end=${plan.targetDurationSeconds}[audio_out]`
  );
  return filters;
}

export function buildFilterGraph(
  plan,
  captionsPath,
  rawVideoTrimLeadSeconds
) {
  const videoEnd =
    rawVideoTrimLeadSeconds + plan.targetDurationSeconds;
  const escapedCaptions = escapeFfmpegFilterPath(captionsPath);
  const subtitleStyle =
    "FontName=DejaVu Sans,FontSize=24,PrimaryColour=&H00FFFFFF," +
    "OutlineColour=&H00101820,BackColour=&H80000000," +
    "BorderStyle=3,Outline=1,Shadow=0,MarginV=42,Alignment=2";
  return [
    `[0:v:0]trim=start=${rawVideoTrimLeadSeconds}:end=${videoEnd},` +
      `setpts=PTS-STARTPTS,fps=${plan.fps},` +
      `scale=${plan.width}:${plan.height}:` +
      "force_original_aspect_ratio=decrease:flags=lanczos," +
      `pad=${plan.width}:${plan.height}:(ow-iw)/2:(oh-ih)/2:` +
      "color=0x07111f,setsar=1," +
      `subtitles='${escapedCaptions}':charenc=UTF-8:` +
      `force_style='${subtitleStyle}',format=yuv420p[video_out]`,
    ...audioFilters(plan),
  ].join(";");
}

function sanitizedToolVersion(executable, label) {
  const { stdout } = runCommand(executable, ["-version"], { label });
  const firstLine = stdout.split(/\r?\n/u)[0]?.trim() ?? "";
  if (
    !firstLine.startsWith(`${label} version `) ||
    !firstLine.includes("1fdbca85aa")
  ) {
    throw new Error(`${label} does not match the pinned Archon build`);
  }
  return firstLine;
}

export function buildVideo({
  env = process.env,
  planPath = DEFAULT_SCENE_PLAN,
} = {}) {
  const root = demoVideoRoot(env, { create: false });
  ensureOutputDirectory(root, "output");
  const expectedSha = expectedReleaseSha(env);
  const plan = loadScenePlan(planPath);
  const planSha256 = sha256File(planPath);
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
  const ffmpegVersion = sanitizedToolVersion(ffmpeg, "ffmpeg");
  const ffprobeVersion = sanitizedToolVersion(ffprobe, "ffprobe");
  const toolchainPath = assertInputFile(
    root,
    "toolchain-provenance.json",
    "Toolchain provenance"
  );
  const toolchain = readJson(toolchainPath, "Toolchain provenance");
  if (
    toolchain.schema !== "archon.demo-video-toolchain" ||
    toolchain.version !== 1 ||
    toolchain.passed !== true ||
    toolchain.provider !== "BtbN/FFmpeg-Builds" ||
    toolchain.releaseTag !== "autobuild-2026-08-03-14-02" ||
    toolchain.ffmpegVersion !== "n7.1.5-12-g1fdbca85aa" ||
    toolchain.archive?.bytes !== 119_354_960 ||
    toolchain.archive?.sha256 !==
      "2164fd331d6578dc3c5b0becf9f86bf21d4fbb0424e2bb54240945203560b242" ||
    toolchain.binaries?.ffmpegSha256 !== sha256File(ffmpeg) ||
    toolchain.binaries?.ffprobeSha256 !== sha256File(ffprobe) ||
    toolchain.capabilities?.gpl !== true ||
    toolchain.capabilities?.libass !== true ||
    toolchain.capabilities?.libx264 !== true ||
    toolchain.capabilities?.aac !== true
  ) {
    throw new Error("FFmpeg toolchain provenance misses the exact pin");
  }

  const releasePath = requireExactReleaseReceiptPath(root, env);
  const release = readJson(releasePath, "Release binding");
  validateReleaseBinding(release, expectedSha);

  const capturePath = assertInputFile(
    root,
    "capture/production-capture.webm",
    "Production browser capture"
  );
  const captureReceiptPath = assertInputFile(
    root,
    "capture/capture-receipt.json",
    "Capture receipt"
  );
  const captureReceipt = readJson(captureReceiptPath, "Capture receipt");
  validateCaptureReceipt(captureReceipt, {
    expectedSha,
    planSha256,
    capturePath,
    root,
    release,
  });
  const rawVideoTrimLeadSeconds = Number(
    captureReceipt.rawVideoTrimLeadSeconds
  );
  if (
    !Number.isFinite(rawVideoTrimLeadSeconds) ||
    rawVideoTrimLeadSeconds < 0 ||
    rawVideoTrimLeadSeconds > 90
  ) {
    throw new Error("Capture trim lead must be between zero and 90 seconds");
  }
  const captureMedia = validateCaptureProbe(
    ffprobeJson(ffprobe, capturePath),
    plan,
    rawVideoTrimLeadSeconds
  );

  const narrationReceiptPath = assertInputFile(
    root,
    "narration/narration-receipt.json",
    "Narration receipt"
  );
  const narrationReceipt = readJson(
    narrationReceiptPath,
    "Narration receipt"
  );
  validateNarrationReceipt(narrationReceipt, {
    plan,
    planSha256,
    root,
    expectedSha,
  });
  const narrationCaptionsPath = assertInputFile(
    root,
    "narration/captions.en.srt",
    "Narration captions"
  );
  const outputCaptionsPath = writeFileAtomic(
    root,
    "output/captions.en.srt",
    readFileSync(narrationCaptionsPath)
  );
  assertFileEvidence(
    outputCaptionsPath,
    narrationReceipt.captions,
    "Copied captions"
  );

  const audioPaths = plan.scenes.map((scene) =>
    assertInputFile(
      root,
      `narration/${scene.id}.mp3`,
      `Narration audio ${scene.id}`
    )
  );
  const finalPath = outputPath(
    root,
    "output/archon-memory-demo.mp4",
    "Final video"
  );
  const partialPath = outputPath(
    root,
    "output/archon-memory-demo.partial.mp4",
    "Partial final video"
  );
  if (existsSync(finalPath) || existsSync(partialPath)) {
    throw new Error("Refusing to overwrite an existing final video");
  }
  const filterGraph = buildFilterGraph(
    plan,
    outputCaptionsPath,
    rawVideoTrimLeadSeconds
  );
  const args = [
    "-hide_banner",
    "-nostdin",
    "-n",
    "-i",
    capturePath,
    ...audioPaths.flatMap((path) => ["-i", path]),
    "-filter_complex",
    filterGraph,
    "-map",
    "[video_out]",
    "-map",
    "[audio_out]",
    "-c:v",
    "libx264",
    "-profile:v",
    "high",
    "-level:v",
    "4.1",
    "-pix_fmt",
    "yuv420p",
    "-preset",
    "slow",
    "-crf",
    "18",
    "-r",
    String(plan.fps),
    "-g",
    String(plan.fps * 2),
    "-keyint_min",
    String(plan.fps * 2),
    "-sc_threshold",
    "0",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-t",
    String(plan.targetDurationSeconds),
    "-movflags",
    "+faststart",
    "-metadata",
    "title=Archon Memory — exact-release demo",
    "-metadata",
    `comment=release ${expectedSha}`,
    "-f",
    "mp4",
    partialPath,
  ];
  try {
    runCommand(ffmpeg, args, {
      label: "ffmpeg",
      env: {
        ...env,
        LC_ALL: "C.UTF-8",
        LANG: "C.UTF-8",
        TZ: "UTC",
      },
      maxBuffer: 64 * 1024 * 1024,
    });
    if (
      !existsSync(partialPath) ||
      lstatSync(partialPath).isSymbolicLink() ||
      !lstatSync(partialPath).isFile()
    ) {
      throw new Error("FFmpeg did not create a regular final video");
    }
    renameSync(partialPath, finalPath);
  } finally {
    if (existsSync(partialPath)) {
      rmSync(partialPath);
    }
  }

  const receipt = {
    schema: "archon.demo-video-build",
    version: 1,
    passed: true,
    releaseSha: expectedSha,
    scenePlanSha256: planSha256,
    targetDurationSeconds: plan.targetDurationSeconds,
    width: plan.width,
    height: plan.height,
    fps: plan.fps,
    videoCodec: "h264",
    videoProfile: "High",
    pixelFormat: "yuv420p",
    audioCodec: "aac",
    audioSampleRate: 48_000,
    audioChannels: 2,
    loudnessTarget: {
      integratedLufs: -16,
      loudnessRangeLu: 7,
      truePeakDbtp: -1.5,
    },
    captionsBurned: true,
    captionsLanguage: "en",
    rawVideoTrimLeadSeconds,
    rawVideoTailSeconds: captureReceipt.rawVideoTailSeconds,
    captureMedia,
    toolchain: {
      ffmpegVersion,
      ffprobeVersion,
    },
    inputs: {
      toolchainProvenance: fileEvidence(toolchainPath, root),
      releaseBinding: fileEvidence(releasePath, root),
      captureReceipt: fileEvidence(captureReceiptPath, root),
      capture: fileEvidence(capturePath, root),
      narrationReceipt: fileEvidence(narrationReceiptPath, root),
      narrationCaptions: fileEvidence(narrationCaptionsPath, root),
      narrationAudio: audioPaths.map((path) => fileEvidence(path, root)),
    },
    output: fileEvidence(finalPath, root),
    captions: fileEvidence(outputCaptionsPath, root),
    scenes: plan.scenes.map((scene) => ({
      id: scene.id,
      startSeconds: scene.startSeconds,
      endSeconds: scene.endSeconds,
    })),
  };
  const receiptPath = writeFileAtomic(
    root,
    "output/video-build-receipt.json",
    stableJson(receipt),
    { encoding: "utf8" }
  );
  return { receipt, receiptPath, finalPath };
}

if (isMain(import.meta.url)) {
  try {
    const { receiptPath } = buildVideo();
    process.stdout.write(`Video build receipt: ${receiptPath}\n`);
  } catch (error) {
    process.stderr.write(`Video build gate failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
