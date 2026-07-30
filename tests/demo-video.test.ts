import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  DEFAULT_SCENE_PLAN,
  EXPECTED_CAPTURE_SCREENSHOTS,
  assertFileEvidence,
  demoVideoRoot,
  fileEvidence,
  loadScenePlan,
  outputPath,
  parseLoudnormMetrics,
  parseSrt,
  serializeSrt,
  validateCaptionsAgainstPlan,
  validateCaptureReceipt,
  validateLoudness,
  validateMediaProbe,
  validateReleaseBinding,
  validateSceneMarkers,
  writeFileAtomic,
} from "../demo/video/lib.mjs";
import { buildFilterGraph } from "../demo/video/build-video.mjs";
import {
  fetchTimestampedNarration,
  generateNarration,
  validateTimestampedNarrationResponse,
} from "../demo/video/generate-narration.mjs";
import {
  DEMO_VIDEO_CHECK_IDS,
  readInitialReceipt,
  requireStoredReleaseBinding,
  requireTrustedWorkflowInvocation,
  requireUnchangedSelections,
  selectExactArtifactInventory,
  selectReleaseEvidenceRuns,
} from "../scripts/demo-video-release-gate.js";
import type {
  DemoVideoReleaseBindingReceipt,
  StoredArtifactSelection,
  StoredRunSelection,
} from "../scripts/demo-video-release-gate.js";
import type { GitHubWorkflowRun } from "../scripts/final-submission-gate.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEMO_VIDEO_WORKFLOW = join(
  ROOT,
  ".github",
  "workflows",
  "demo-video.yml"
);
const VIDEO_PLAN = join(ROOT, "demo", "VIDEO_PLAN.md");
const CAPTURE_PRODUCTION = join(
  ROOT,
  "web",
  "video",
  "capture-production.mjs"
);
const INSTALLER = join(
  ROOT,
  "demo",
  "video",
  "install-pinned-ffmpeg-linux.sh"
);
const BUILD = join(ROOT, "demo", "video", "build-video.mjs");
const VERIFY = join(ROOT, "demo", "video", "verify-video.mjs");
const ASSERT_RECEIPT = join(
  ROOT,
  "demo",
  "video",
  "assert-video-receipt.mjs"
);
const SELFTEST = join(
  ROOT,
  "demo",
  "video",
  "media-gate-selftest.mjs"
);

function alignmentFor(text: string, step = 0.025) {
  const characters = [...text];
  return {
    characters,
    character_start_times_seconds: characters.map(
      (_, index) => index * step
    ),
    character_end_times_seconds: characters.map(
      (_, index) => (index + 1) * step
    ),
  };
}

function canonicalAudioBase64(): string {
  return Buffer.alloc(256, 0x5a).toString("base64");
}

function quotedNarrationBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/(?:^> .+(?:\r?\n|$))+/gmu)].map((match) =>
    match[0]
      .replace(/^> ?/gmu, "")
      .replace(/\s+/gu, " ")
      .trim()
  );
}

test("workflow initializes runner-temp paths only after runner assignment", () => {
  const workflow = readFileSync(DEMO_VIDEO_WORKFLOW, "utf8");

  assert.doesNotMatch(
    workflow,
    /DEMO_VIDEO_(?:ROOT|RELEASE_RECEIPT):\s*\$\{\{\s*runner\.temp/u
  );
  assert.equal(
    (
      workflow.match(
        /echo "DEMO_VIDEO_ROOT=\$\{RUNNER_TEMP\}\/archon-demo-video" >>"\$\{GITHUB_ENV\}"/gu
      ) ?? []
    ).length,
    4
  );
  assert.equal(
    (
      workflow.match(
        /echo "DEMO_VIDEO_RELEASE_RECEIPT=\$\{RUNNER_TEMP\}\/archon-demo-video\/release\/video-release-binding\.json" >>"\$\{GITHUB_ENV\}"/gu
      ) ?? []
    ).length,
    2
  );
});

function releaseBindingFixture(): {
  now: number;
  receipt: DemoVideoReleaseBindingReceipt;
} {
  const sha = "a".repeat(40);
  const now = Date.parse("2026-07-30T14:00:00.000Z");
  const run = (
    id: number,
    event: string,
    workflowPath: string,
    completedAt: string
  ): StoredRunSelection => ({
    id,
    attempt: 1,
    event,
    workflowPath,
    headSha: sha,
    completedAt,
  });
  const selectedRuns = {
    ci: run(101, "push", ".github/workflows/ci.yml", "2026-07-30T12:40:00.000Z"),
    codeql: run(
      102,
      "push",
      ".github/workflows/codeql.yml",
      "2026-07-30T12:45:00.000Z"
    ),
    deploy: run(
      103,
      "workflow_run",
      ".github/workflows/deploy-aws.yml",
      "2026-07-30T13:00:00.000Z"
    ),
    hostedDast: run(
      104,
      "workflow_run",
      ".github/workflows/security-dast.yml",
      "2026-07-30T13:10:00.000Z"
    ),
    managedMcp: run(
      105,
      "workflow_dispatch",
      ".github/workflows/managed-mcp-audit.yml",
      "2026-07-30T13:20:00.000Z"
    ),
    recovery: run(
      106,
      "workflow_dispatch",
      ".github/workflows/recover-aws.yml",
      "2026-07-30T13:30:00.000Z"
    ),
  };
  const artifact = (
    id: number,
    name: string,
    workflowRunId: number,
    createdAt: string,
    updatedAt: string
  ): StoredArtifactSelection => ({
    id,
    name,
    sizeInBytes: 4096,
    digest: `sha256:${id.toString(16).padStart(64, "0")}`,
    workflowRunId,
    headSha: sha,
    createdAt,
    updatedAt,
  });
  const selectedArtifacts = {
    hostedDast: artifact(
      201,
      `hosted-dast-${sha}-103-1-1`,
      104,
      "2026-07-30T13:08:00.000Z",
      "2026-07-30T13:09:00.000Z"
    ),
    hostedDastZap: artifact(
      202,
      `zap-baseline-${sha}-1`,
      104,
      "2026-07-30T13:08:10.000Z",
      "2026-07-30T13:09:10.000Z"
    ),
    managedMcp: artifact(
      203,
      "managed-mcp-proof-105-1",
      105,
      "2026-07-30T13:18:00.000Z",
      "2026-07-30T13:19:00.000Z"
    ),
    recoveryStaging: artifact(
      204,
      "staging-cloudformation-controls-audit-106-1",
      106,
      "2026-07-30T13:28:00.000Z",
      "2026-07-30T13:29:00.000Z"
    ),
    recoveryProduction: artifact(
      205,
      "production-cloudformation-controls-audit-106-1",
      106,
      "2026-07-30T13:28:15.000Z",
      "2026-07-30T13:29:15.000Z"
    ),
  };
  return {
    now,
    receipt: {
      schema: "archon.demo-video-release-binding",
      version: 1,
      repository: "upgradedev/archon-cockroach-memory",
      ref: "refs/heads/main",
      releaseSha: sha,
      demoUrl: "https://d2s5v0o0eg2aaw.cloudfront.net",
      sourceGateRunId: 999,
      sourceGateRunAttempt: 1,
      passed: true,
      selectedRuns,
      selectedArtifacts,
      liveProof: {
        endpoint:
          "https://d2s5v0o0eg2aaw.cloudfront.net/api/proof",
        generatedAt: "2026-07-30T13:35:00.000Z",
        releaseSha: sha,
        database: "CockroachDB",
        deployment: "CockroachDB Cloud on AWS",
        region: "eu-west-1",
        vectorEngine: "native CockroachDB C-SPANN",
        vectorDimensions: 1024,
        persisted: 9,
        idempotencyKeys: 9,
        contentDigests: 9,
      },
      checks: DEMO_VIDEO_CHECK_IDS.map((id) => ({
        id,
        status: "pass",
      })),
    },
  };
}

function workflowRunFixture(
  id: number,
  name: string,
  path: string,
  event: string,
  sha: string,
  startedAt: string,
  completedAt: string
): GitHubWorkflowRun {
  return {
    id,
    name,
    display_title: `${name} fixture`,
    path,
    event,
    head_branch: "main",
    head_sha: sha,
    status: "completed",
    conclusion: "success",
    run_attempt: 1,
    html_url: `https://github.com/upgradedev/archon-cockroach-memory/actions/runs/${id}`,
    run_started_at: startedAt,
    updated_at: completedAt,
  };
}

function artifactApiFixture(
  id: number,
  name: string,
  run: GitHubWorkflowRun,
  digestCharacter: string
) {
  return {
    id,
    name,
    size_in_bytes: 4096,
    archive_download_url:
      `https://api.github.com/repos/upgradedev/archon-cockroach-memory/` +
      `actions/artifacts/${id}/zip`,
    digest: `sha256:${digestCharacter.repeat(64)}`,
    expired: false,
    created_at: "2026-07-30T13:08:00.000Z",
    updated_at: "2026-07-30T13:09:00.000Z",
    workflow_run: {
      id: run.id,
      head_sha: run.head_sha,
    },
  };
}

test("demo video plan is the canonical contiguous 170-second story", () => {
  const plan = loadScenePlan();
  assert.equal(DEFAULT_SCENE_PLAN, join(ROOT, "demo", "video", "scene-plan.json"));
  assert.equal(plan.targetDurationSeconds, 170);
  assert.equal(plan.width, 1920);
  assert.equal(plan.height, 1080);
  assert.equal(plan.fps, 30);
  assert.deepEqual(
    plan.scenes.map(
      ({ id, startSeconds, endSeconds, color }: {
        id: string;
        startSeconds: number;
        endSeconds: number;
        color: string;
      }) => ({ id, startSeconds, endSeconds, color })
    ),
    [
      { id: "hook", startSeconds: 0, endSeconds: 12, color: "#34d399" },
      {
        id: "scope-architecture",
        startSeconds: 12,
        endSeconds: 27,
        color: "#38bdf8",
      },
      {
        id: "recall-grounding",
        startSeconds: 27,
        endSeconds: 75,
        color: "#fbbf24",
      },
      { id: "audit", startSeconds: 75, endSeconds: 115, color: "#fb7185" },
      { id: "proof", startSeconds: 115, endSeconds: 140, color: "#a78bfa" },
      {
        id: "managed-mcp",
        startSeconds: 140,
        endSeconds: 160,
        color: "#22d3ee",
      },
      { id: "close", startSeconds: 160, endSeconds: 170, color: "#f8fafc" },
    ]
  );
  assert.deepEqual(
    quotedNarrationBlocks(readFileSync(VIDEO_PLAN, "utf8")),
    plan.scenes.map((scene: { narration: string }) => scene.narration)
  );
});

test("capture receipt binds exactly eight screenshots retained in the final package", () => {
  const configuredRunnerTemp = process.env.RUNNER_TEMP;
  assert.ok(
    configuredRunnerTemp,
    "RUNNER_TEMP must be supplied by the CI test runner"
  );
  const ciTemp = realpathSync(configuredRunnerTemp);
  const fixture = mkdtempSync(join(ciTemp, "archon-screenshot-unit-"));
  const root = join(fixture, "video-root");
  mkdirSync(root);
  try {
    const plan = loadScenePlan();
    const capturePath = writeFileAtomic(
      root,
      "capture/production-capture.webm",
      Buffer.from("synthetic capture fixture", "utf8")
    );
    const screenshots = EXPECTED_CAPTURE_SCREENSHOTS.map(
      (name, index) => {
        const path = writeFileAtomic(
          root,
          `capture/${name}`,
          Buffer.from(`synthetic png fixture ${index + 1}`, "utf8")
        );
        return fileEvidence(path, root);
      }
    );
    const sceneMarkers = plan.scenes.map(
      (scene: {
        id: string;
        startSeconds: number;
        endSeconds: number;
        color: string;
      }) => ({
        id: scene.id,
        startSeconds: scene.startSeconds,
        endSeconds: scene.endSeconds,
        color: scene.color,
        markerObserved: true,
      })
    );
    const release = {
      selectedRuns: {
        deploy: { id: 101 },
        hostedDast: { id: 102 },
        managedMcp: { id: 103 },
        recovery: { id: 104 },
      },
    };
    const capture = fileEvidence(capturePath, root);
    const receipt = {
      schema: "archon.demo-video-capture",
      version: 1,
      passed: true,
      releaseSha: "a".repeat(40),
      canonicalOrigin: "https://d2s5v0o0eg2aaw.cloudfront.net",
      scenePlanSha256: "b".repeat(64),
      width: 1920,
      height: 1080,
      compositionTargetFps: 30,
      rawVideoTailSeconds: 2,
      sceneCount: 7,
      liveProofBefore: true,
      liveProofAfter: true,
      cspEnforcedBefore: true,
      cspEnforcedAfter: true,
      recordingCspBypassedForOwnedOverlay: true,
      crossOriginRequests: 0,
      consoleErrors: 0,
      pageErrors: 0,
      evidenceRuns: {
        deploy: 101,
        dast: 102,
        managedMcp: 103,
        recovery: 104,
      },
      markerSample: {
        x: 1876,
        y: 1036,
        width: 40,
        height: 40,
      },
      scenes: sceneMarkers,
      sceneMarkers,
      capture,
      video: capture,
      captureSha256: capture.sha256,
      screenshots,
    };
    const validate = (candidate: unknown) =>
      validateCaptureReceipt(candidate, {
        expectedSha: "a".repeat(40),
        planSha256: "b".repeat(64),
        capturePath,
        root,
        release,
      });

    assert.equal(validate(receipt), true);

    const missing = structuredClone(receipt);
    missing.screenshots.pop();
    assert.throws(() => validate(missing), /eight canonical screenshots/u);

    const reordered = structuredClone(receipt);
    [reordered.screenshots[0], reordered.screenshots[1]] = [
      reordered.screenshots[1]!,
      reordered.screenshots[0]!,
    ];
    assert.throws(() => validate(reordered), /path is invalid/u);

    const tampered = structuredClone(receipt);
    tampered.screenshots[0]!.sha256 = "c".repeat(64);
    assert.throws(() => validate(tampered), /hash does not match/u);

    const workflow = readFileSync(DEMO_VIDEO_WORKFLOW, "utf8");
    for (const name of EXPECTED_CAPTURE_SCREENSHOTS) {
      assert.equal(
        workflow.includes(
          `runner.temp }}/archon-demo-video/capture/${name}`
        ),
        true
      );
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("ElevenLabs captions are derived only from exact original alignment", () => {
  const scene = loadScenePlan().scenes[0];
  const response = {
    audio_base64: canonicalAudioBase64(),
    alignment: alignmentFor(scene.narration),
  };
  const result = validateTimestampedNarrationResponse(response, scene);
  assert.equal(result.audio.length, 256);
  assert.ok(result.cues.length > 1);
  assert.equal(
    result.cues.map((cue: { text: string }) => cue.text).join(" "),
    scene.narration
  );

  assert.throws(
    () =>
      validateTimestampedNarrationResponse(
        {
          audio_base64: canonicalAudioBase64(),
          normalized_alignment: alignmentFor(scene.narration),
        },
        scene
      ),
    /no fallback/u
  );
  assert.throws(
    () =>
      validateTimestampedNarrationResponse(
        {
          audio_base64: canonicalAudioBase64(),
          alignment: alignmentFor(`${scene.narration} tampered`),
        },
        scene
      ),
    /does not exactly bind/u
  );
});

test("timestamped narration request uses the exact ElevenLabs endpoint and model", async () => {
  const plan = loadScenePlan();
  const scene = plan.scenes[0];
  let observedUrl = "";
  let observedInit: RequestInit | undefined;
  const result = await fetchTimestampedNarration(
    scene,
    plan.voice,
    "unit-test-key-not-a-real-secret",
    {
      fetchImpl: async (
        input: Parameters<typeof fetch>[0],
        init?: RequestInit
      ) => {
        observedUrl = String(input);
        observedInit = init;
        return Response.json({
          audio_base64: canonicalAudioBase64(),
          alignment: alignmentFor(scene.narration),
        });
      },
    }
  );
  const url = new URL(observedUrl);
  assert.equal(url.origin, "https://api.elevenlabs.io");
  assert.equal(
    url.pathname,
    `/v1/text-to-speech/${plan.voice.voiceId}/with-timestamps`
  );
  assert.equal(url.searchParams.get("output_format"), "mp3_44100_128");
  assert.equal(observedInit?.method, "POST");
  const body = JSON.parse(String(observedInit?.body));
  assert.equal(body.model_id, "eleven_multilingual_v2");
  assert.equal(body.text, scene.narration);
  assert.ok(result.cues.length > 0);
});

test("timestamped narration rejects scene or voice drift before any request", async () => {
  const plan = loadScenePlan();
  const scene = plan.scenes[0];
  let fetchCalls = 0;
  const fetchImpl: typeof fetch = async () => {
    fetchCalls += 1;
    throw new Error("fetch must not be reached");
  };

  await assert.rejects(
    fetchTimestampedNarration(
      { ...scene, narration: `${scene.narration} drift` },
      plan.voice,
      "unit-test-key-not-a-real-secret",
      { fetchImpl }
    ),
    /canonical allowlist/u
  );
  await assert.rejects(
    fetchTimestampedNarration(
      scene,
      { ...plan.voice, voiceId: "not-allowlisted" },
      "unit-test-key-not-a-real-secret",
      { fetchImpl }
    ),
    /voice configuration is outside the allowlist/u
  );
  assert.equal(fetchCalls, 0);
});

test("narration rejects a GITHUB_SHA mismatch before secrets, files, or API calls", async () => {
  let fetchCalls = 0;
  await assert.rejects(
    generateNarration({
      env: {
        DEMO_VIDEO_EXPECTED_SHA: "a".repeat(40),
        GITHUB_SHA: "b".repeat(40),
      },
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("The network must not be reached");
      },
      planPath: join(ROOT, "does-not-exist-before-sha-gate.json"),
    }),
    /exact release SHA/u
  );
  assert.equal(fetchCalls, 0);
});

test("SRT parser and transcript gate reject scene-crossing or changed captions", () => {
  const plan = loadScenePlan();
  const cues = plan.scenes.map(
    (scene: {
      startSeconds: number;
      endSeconds: number;
      narration: string;
    }) => ({
      startSeconds: scene.startSeconds + 0.1,
      endSeconds: scene.endSeconds - 0.1,
      text: scene.narration,
    })
  );
  const parsed = parseSrt(serializeSrt(cues));
  assert.equal(validateCaptionsAgainstPlan(parsed, plan), true);
  assert.throws(
    () =>
      validateCaptionsAgainstPlan(
        parsed.map((cue, index) => ({
          ...cue,
          text: index === 2 ? "Changed transcript." : cue.text,
        })),
        plan
      ),
    /does not match/u
  );
  assert.throws(
    () =>
      validateCaptionsAgainstPlan(
        parsed.map((cue, index) => ({
          ...cue,
          endSeconds: index === 0 ? 12.5 : cue.endSeconds,
        })),
        plan
      ),
    /scene boundary|overlaps/u
  );
});

test("scene marker receipt gate rejects a reordered scene", () => {
  const plan = loadScenePlan();
  const markers = plan.scenes.map(
    (scene: { id: string; startSeconds: number; endSeconds: number }) => ({
      id: scene.id,
      startSeconds: scene.startSeconds,
      endSeconds: scene.endSeconds,
      markerObserved: true,
    })
  );
  assert.equal(validateSceneMarkers(markers, plan), true);
  [markers[2], markers[3]] = [markers[3], markers[2]];
  assert.throws(
    () => validateSceneMarkers(markers, plan),
    /reordered/u
  );
});

test("runner-temp guard rejects traversal and symlink escape", () => {
  const configuredRunnerTemp = process.env.RUNNER_TEMP;
  assert.ok(
    configuredRunnerTemp,
    "RUNNER_TEMP must be supplied by the CI test runner"
  );
  const ciTemp = realpathSync(configuredRunnerTemp);
  const fixture = mkdtempSync(join(ciTemp, "archon-video-unit-"));
  const root = join(fixture, "video-root");
  const outside = join(fixture, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  const env = {
    ...process.env,
    RUNNER_TEMP: ciTemp,
    DEMO_VIDEO_ROOT: root,
  };
  try {
    assert.equal(demoVideoRoot(env, { create: false }), realpathSync(root));
    assert.throws(
      () => outputPath(root, "../outside/escape.txt"),
      /escaped/u
    );
    symlinkSync(outside, join(root, "linked"), "dir");
    assert.throws(
      () => outputPath(root, "linked/escape.txt"),
      /symbolic link/u
    );
    const path = writeFileAtomic(root, "safe/receipt.json", "{}\n", {
      encoding: "utf8",
    });
    const evidence = fileEvidence(path, root);
    assert.equal(assertFileEvidence(path, evidence, "fixture"), evidence.sha256);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("media probe gate requires exact final codecs, fps, and A/V duration", () => {
  const probe = {
    format: { duration: "170.000" },
    streams: [
      {
        codec_type: "video",
        codec_name: "h264",
        profile: "High",
        pix_fmt: "yuv420p",
        width: 1920,
        height: 1080,
        avg_frame_rate: "30/1",
        duration: "170.000",
      },
      {
        codec_type: "audio",
        codec_name: "aac",
        sample_rate: "48000",
        channels: 2,
        duration: "170.000",
      },
    ],
  };
  const metrics = validateMediaProbe(probe, {
    durationSeconds: 170,
    width: 1920,
    height: 1080,
    fps: 30,
  });
  assert.equal(metrics.videoProfile, "High");
  assert.equal(metrics.audioSampleRate, 48_000);
  assert.throws(
    () =>
      validateMediaProbe(
        {
          ...probe,
          streams: [
            probe.streams[0],
            { ...probe.streams[1], duration: "168.500" },
          ],
        },
        {
          durationSeconds: 170,
          width: 1920,
          height: 1080,
          fps: 30,
        }
      ),
    /duration|Audio\/video/u
  );
});

test("loudness parser and gate enforce the final LUFS/peak contract", () => {
  const metrics = parseLoudnormMetrics(`
    [Parsed_loudnorm_0] {
      "input_i" : "-16.10",
      "input_tp" : "-1.42",
      "input_lra" : "3.20",
      "input_thresh" : "-26.20",
      "target_offset" : "0.10"
    }
  `);
  assert.equal(validateLoudness(metrics), true);
  assert.throws(
    () => validateLoudness({ ...metrics, truePeakDbtp: -0.2 }),
    /misses/u
  );
});

test("build filter and source bind subtitles, exact encoding, and full verification", () => {
  const plan = loadScenePlan();
  const graph = buildFilterGraph(
    plan,
    "/runner/_temp/archon-demo-video/output/captions.en.srt",
    2
  );
  assert.match(graph, /subtitles='/u);
  assert.match(graph, /loudnorm=I=-16:LRA=7:TP=-1\.5/u);
  assert.match(graph, /atrim=start=0:end=170\[audio_out\]/u);
  const build = readFileSync(BUILD, "utf8");
  assert.match(build, /"-profile:v",\s+"high"/u);
  assert.match(build, /"-pix_fmt",\s+"yuv420p"/u);
  assert.match(build, /"-c:a",\s+"aac"/u);
  assert.match(build, /"-ar",\s+"48000"/u);
  assert.match(build, /"-t",\s+String\(plan\.targetDurationSeconds\)/u);
  const verify = readFileSync(VERIFY, "utf8");
  assert.match(verify, /"-xerror"/u);
  assert.match(verify, /sampleSceneMarkers/u);
  assert.match(verify, /format=rgb24,crop=1:1:\$\{x\}:\$\{y\}/u);
  assert.match(verify, /full-audio-video-decode/u);
});

test("pinned installer is immutable, path-confined, and avoids pipefail SIGPIPE", () => {
  const installer = readFileSync(INSTALLER, "utf8");
  assert.match(installer, /autobuild-2026-07-19-13-12/u);
  assert.match(installer, /n7\.1\.5-2-g998de74adf/u);
  assert.match(
    installer,
    /ffmpeg-n7\.1\.5-2-g998de74adf-linux64-gpl-7\.1\.tar\.xz/u
  );
  assert.match(installer, /119354960/u);
  assert.match(
    installer,
    /b8ed29dc71fe17f05f43e2d9dbfde89edf43270c3de13ce3c4d70f5df1f47e61/u
  );
  assert.match(installer, /archive-entries\.txt/u);
  assert.doesNotMatch(installer, /tar -tJf "\$\{archive\}" \|/u);
  assert.doesNotMatch(installer, /-encoders 2>\/dev\/null \|/u);
  assert.doesNotMatch(installer, /-filters 2>\/dev\/null \|/u);
  assert.match(installer, /archon\.demo-video-toolchain/u);
  assert.match(installer, /FFMPEG=%s/u);
  assert.match(installer, /FFPROBE=%s/u);
});

test("release, terminal receipt, and CI media mutant gates are source-bound", () => {
  assert.equal(
    validateReleaseBinding(
      {
        schema: "archon.demo-video-release-binding",
        version: 1,
        passed: true,
        repository: "upgradedev/archon-cockroach-memory",
        ref: "refs/heads/main",
        demoUrl: "https://d2s5v0o0eg2aaw.cloudfront.net",
        releaseSha: "a".repeat(40),
      },
      "a".repeat(40)
    ),
    true
  );
  const receiptGate = readFileSync(ASSERT_RECEIPT, "utf8");
  assert.match(receiptGate, /toolchainProvenance/u);
  assert.match(receiptGate, /verificationReceiptSha256/u);
  assert.match(receiptGate, /final-media-scene-marker-pixels/u);
  const selftest = readFileSync(SELFTEST, "utf8");
  assert.match(selftest, /bad-av\.mp4/u);
  assert.match(selftest, /bad-markers\.mp4/u);
  assert.match(selftest, /sampleSceneMarkers/u);
  assert.match(selftest, /Caption-transcript mutant/u);
  assert.match(selftest, /Receipt\/hash mutant/u);
  assert.doesNotMatch(selftest, /\bfetch\s*\(/u);

  const workflow = readFileSync(DEMO_VIDEO_WORKFLOW, "utf8");
  assert.match(
    workflow,
    /package_artifact_digest="sha256:\$\{ARTIFACT_DIGEST\}"/u
  );
  assert.equal(
    (
      workflow.match(
        /ref:\s*\$\{\{\s*inputs\.exact_sha\s*\}\}/gu
      ) ?? []
    ).length,
    4
  );
  assert.doesNotMatch(workflow, /ref:\s*main\s*$/mu);
  assert.match(
    workflow,
    /--arg packageArtifactDigest "\$\{package_artifact_digest\}"/u
  );
  assert.doesNotMatch(
    workflow,
    /\$\{ARTIFACT_DIGEST\}" =~ \^sha256:/u
  );
});

test("capture diagnostics fail closed through a bounded credential sanitizer", () => {
  const capture = readFileSync(CAPTURE_PRODUCTION, "utf8");
  assert.match(capture, /function sanitizedFailureMessage\(error\)/u);
  assert.match(capture, /\[redacted\]/u);
  assert.match(capture, /\.replace\(\/\[\\r\\n\\t\]\+\/gu, " "\)/u);
  assert.match(capture, /\.slice\(0, 500\)/u);
  assert.match(
    capture,
    /Production capture failed closed in the hosted CI runner: \$\{sanitizedFailureMessage\(/u
  );
  assert.doesNotMatch(capture, /console\.error\(\s*error\s*\)/u);
});

test("release gate accepts only a trusted exact-main workflow invocation", () => {
  const sha = "b".repeat(40);
  const invocation = {
    repository: "upgradedev/archon-cockroach-memory",
    eventName: "workflow_dispatch",
    ref: "refs/heads/main",
    workflowRef:
      "upgradedev/archon-cockroach-memory/.github/workflows/demo-video.yml@refs/heads/main",
    githubSha: sha,
    expectedSha: sha,
    runId: 9001,
    runAttempt: 1,
  };
  assert.doesNotThrow(() => requireTrustedWorkflowInvocation(invocation));
  assert.throws(
    () =>
      requireTrustedWorkflowInvocation({
        ...invocation,
        workflowRef:
          "attacker/fork/.github/workflows/demo-video.yml@refs/heads/main",
      }),
    /identity/u
  );
  assert.throws(
    () =>
      requireTrustedWorkflowInvocation({
        ...invocation,
        githubSha: "c".repeat(40),
      }),
    /identity/u
  );
});

test("release receipt is exact and terminal selection validation is immutable", () => {
  const { receipt, now } = releaseBindingFixture();
  const before = JSON.stringify(receipt);
  const validated = requireStoredReleaseBinding(
    structuredClone(receipt),
    {
      sha: receipt.releaseSha,
      runId: receipt.sourceGateRunId,
      runAttempt: receipt.sourceGateRunAttempt,
      now,
    }
  );
  assert.deepEqual(validated, receipt);
  requireUnchangedSelections(
    validated,
    structuredClone(receipt.selectedRuns),
    structuredClone(receipt.selectedArtifacts)
  );
  assert.equal(JSON.stringify(receipt), before);

  assert.throws(
    () =>
      requireStoredReleaseBinding(
        { ...structuredClone(receipt), unexpected: true },
        {
          sha: receipt.releaseSha,
          runId: receipt.sourceGateRunId,
          runAttempt: receipt.sourceGateRunAttempt,
          now,
        }
      ),
    /malformed/u
  );

  const artifactDrift = structuredClone(receipt.selectedArtifacts);
  artifactDrift.managedMcp.digest = `sha256:${"f".repeat(64)}`;
  assert.throws(
    () =>
      requireUnchangedSelections(
        receipt,
        structuredClone(receipt.selectedRuns),
        artifactDrift
      ),
    /selection changed/u
  );

  const runDrift = structuredClone(receipt.selectedRuns);
  runDrift.hostedDast.id += 1;
  assert.throws(
    () =>
      requireUnchangedSelections(
        receipt,
        runDrift,
        structuredClone(receipt.selectedArtifacts)
      ),
    /selection changed/u
  );
});

test("release receipt is read through one no-follow file descriptor", () => {
  const configuredRunnerTemp = process.env.RUNNER_TEMP;
  assert.ok(
    configuredRunnerTemp,
    "RUNNER_TEMP must be supplied by the CI test runner"
  );
  const ciTemp = realpathSync(configuredRunnerTemp);
  const fixture = mkdtempSync(join(ciTemp, "archon-release-receipt-unit-"));
  try {
    const { receipt, now } = releaseBindingFixture();
    const receiptPath = writeFileAtomic(
      fixture,
      "video-release-binding.json",
      `${JSON.stringify(receipt, null, 2)}\n`,
      { encoding: "utf8" }
    );
    assert.deepEqual(
      readInitialReceipt(receiptPath, {
        sha: receipt.releaseSha,
        runId: receipt.sourceGateRunId,
        runAttempt: receipt.sourceGateRunAttempt,
        now,
      }),
      receipt
    );

    const linkedPath = join(fixture, "linked-release-binding.json");
    symlinkSync(receiptPath, linkedPath, "file");
    assert.throws(
      () =>
        readInitialReceipt(linkedPath, {
          sha: receipt.releaseSha,
          runId: receipt.sourceGateRunId,
          runAttempt: receipt.sourceGateRunAttempt,
          now,
        }),
      /without following links/u
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("release run selector rejects wrong-event or wrong-SHA evidence", () => {
  const sha = "d".repeat(40);
  const runs = {
    ci: [
      workflowRunFixture(
        301,
        "CI",
        ".github/workflows/ci.yml",
        "push",
        sha,
        "2026-07-30T12:00:00.000Z",
        "2026-07-30T12:10:00.000Z"
      ),
    ],
    codeql: [
      workflowRunFixture(
        302,
        "CodeQL",
        ".github/workflows/codeql.yml",
        "push",
        sha,
        "2026-07-30T12:00:00.000Z",
        "2026-07-30T12:11:00.000Z"
      ),
    ],
    deploy: [
      workflowRunFixture(
        303,
        "Deploy AWS",
        ".github/workflows/deploy-aws.yml",
        "workflow_run",
        sha,
        "2026-07-30T12:12:00.000Z",
        "2026-07-30T12:40:00.000Z"
      ),
    ],
    dast: [
      workflowRunFixture(
        304,
        "Hosted DAST",
        ".github/workflows/security-dast.yml",
        "workflow_run",
        sha,
        "2026-07-30T12:41:00.000Z",
        "2026-07-30T12:50:00.000Z"
      ),
    ],
    mcp: [
      workflowRunFixture(
        305,
        "Cockroach Cloud Managed MCP Audit",
        ".github/workflows/managed-mcp-audit.yml",
        "workflow_dispatch",
        sha,
        "2026-07-30T12:51:00.000Z",
        "2026-07-30T12:55:00.000Z"
      ),
    ],
    recovery: [
      workflowRunFixture(
        306,
        "Recover AWS",
        ".github/workflows/recover-aws.yml",
        "workflow_dispatch",
        sha,
        "2026-07-30T12:56:00.000Z",
        "2026-07-30T13:00:00.000Z"
      ),
    ],
  };
  const selected = selectReleaseEvidenceRuns(runs, sha);
  assert.deepEqual(
    [
      selected.ci.id,
      selected.codeql.id,
      selected.deploy.id,
      selected.dast.id,
      selected.mcp.id,
      selected.recovery.id,
    ],
    [301, 302, 303, 304, 305, 306]
  );
  assert.throws(
    () =>
      selectReleaseEvidenceRuns(
        {
          ...runs,
          dast: [{ ...runs.dast[0], event: "workflow_dispatch" }],
        },
        sha
      ),
    /not successful/u
  );
  assert.throws(
    () =>
      selectReleaseEvidenceRuns(
        {
          ...runs,
          mcp: [{ ...runs.mcp[0], head_sha: "e".repeat(40) }],
        },
        sha
      ),
    /not successful/u
  );
});

test("artifact selector rejects duplicates, extras, and digest drift", () => {
  const sha = "f".repeat(40);
  const run = workflowRunFixture(
    401,
    "Hosted DAST",
    ".github/workflows/security-dast.yml",
    "workflow_run",
    sha,
    "2026-07-30T13:00:00.000Z",
    "2026-07-30T13:10:00.000Z"
  );
  const names = ["exact-receipt", "exact-zap"] as const;
  const receipt = artifactApiFixture(501, names[0], run, "a");
  const zap = artifactApiFixture(502, names[1], run, "b");
  const inventory = {
    total_count: 2,
    artifacts: [receipt, zap],
  };
  const selected = selectExactArtifactInventory(
    inventory,
    names,
    run,
    Date.parse("2026-07-30T13:20:00.000Z")
  );
  assert.deepEqual(Object.keys(selected).sort(), [...names].sort());

  assert.throws(
    () =>
      selectExactArtifactInventory(
        {
          total_count: 2,
          artifacts: [receipt, { ...zap, name: names[0] }],
        },
        names,
        run,
        Date.parse("2026-07-30T13:20:00.000Z")
      ),
    /inventory/u
  );
  assert.throws(
    () =>
      selectExactArtifactInventory(
        {
          total_count: 3,
          artifacts: [
            receipt,
            zap,
            artifactApiFixture(503, "unexpected", run, "c"),
          ],
        },
        names,
        run,
        Date.parse("2026-07-30T13:20:00.000Z")
      ),
    /inventory/u
  );
  assert.throws(
    () =>
      selectExactArtifactInventory(
        {
          total_count: 2,
          artifacts: [
            { ...receipt, digest: "sha256:not-a-digest" },
            zap,
          ],
        },
        names,
        run,
        Date.parse("2026-07-30T13:20:00.000Z")
      ),
    /canonical digest-bearing metadata/u
  );
});

test("artifact selector allows valid prior attempts but pins the current attempt", () => {
  const sha = "9".repeat(40);
  const run = {
    ...workflowRunFixture(
      601,
      "Cockroach Cloud Managed MCP Audit",
      ".github/workflows/managed-mcp-audit.yml",
      "workflow_dispatch",
      sha,
      "2026-07-30T13:00:00.000Z",
      "2026-07-30T13:30:00.000Z"
    ),
    run_attempt: 2,
  };
  const currentName = `managed-mcp-proof-${run.id}-2`;
  const priorName = `managed-mcp-proof-${run.id}-1`;
  const current = artifactApiFixture(701, currentName, run, "a");
  const prior = {
    ...artifactApiFixture(702, priorName, run, "b"),
    expired: true,
    created_at: "2026-07-29T13:02:00.000Z",
    updated_at: "2026-07-29T13:03:00.000Z",
  };
  const selected = selectExactArtifactInventory(
    { total_count: 2, artifacts: [prior, current] },
    [currentName],
    run,
    Date.parse("2026-07-30T13:35:00.000Z"),
    [priorName]
  );
  assert.equal(selected[currentName]?.id, current.id);

  assert.throws(
    () =>
      selectExactArtifactInventory(
        {
          total_count: 3,
          artifacts: [
            prior,
            current,
            { ...current, id: 703 },
          ],
        },
        [currentName],
        run,
        Date.parse("2026-07-30T13:35:00.000Z"),
        [priorName]
      ),
    /inventory/u
  );
  assert.throws(
    () =>
      selectExactArtifactInventory(
        {
          total_count: 2,
          artifacts: [
            { ...prior, digest: "sha256:invalid" },
            current,
          ],
        },
        [currentName],
        run,
        Date.parse("2026-07-30T13:35:00.000Z"),
        [priorName]
      ),
    /canonical digest-bearing metadata/u
  );
});
