import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import {
  DEFAULT_SCENE_PLAN,
  alignmentToCues,
  demoVideoRoot,
  ensureOutputDirectory,
  expectedReleaseSha,
  fileEvidence,
  isMain,
  loadScenePlan,
  requireExactBooleanAttestation,
  requireNonEmptyEnv,
  serializeSrt,
  sha256File,
  stableJson,
  validateCaptionsAgainstPlan,
  writeFileAtomic,
} from "./lib.mjs";

const ELEVENLABS_ORIGIN = "https://api.elevenlabs.io";
const VOICE_SETTINGS = Object.freeze({
  stability: 0.5,
  similarity_boost: 0.75,
  style: 0,
  use_speaker_boost: true,
  speed: 1,
});

function decodeCanonicalBase64(value, sceneId) {
  if (
    typeof value !== "string" ||
    value.length < 128 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)
  ) {
    throw new Error(`Scene ${sceneId} returned invalid base64 audio`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 0 || decoded.toString("base64") !== value) {
    throw new Error(`Scene ${sceneId} returned non-canonical base64 audio`);
  }
  return decoded;
}

export function validateTimestampedNarrationResponse(payload, scene) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`Scene ${scene.id} returned a non-object response`);
  }
  if (!Object.hasOwn(payload, "alignment")) {
    throw new Error(
      `Scene ${scene.id} lacks original ElevenLabs timestamps; no fallback is allowed`
    );
  }
  const audio = decodeCanonicalBase64(payload.audio_base64, scene.id);
  const { cues, alignmentDuration } = alignmentToCues(
    payload.alignment,
    scene
  );
  return { audio, cues, alignmentDuration };
}

export async function fetchTimestampedNarration(
  scene,
  voice,
  apiKey,
  { fetchImpl = globalThis.fetch } = {}
) {
  if (typeof fetchImpl !== "function") {
    throw new Error("A standards-compatible fetch implementation is required");
  }
  const endpoint = new URL(
    `/v1/text-to-speech/${encodeURIComponent(
      voice.voiceId
    )}/with-timestamps`,
    ELEVENLABS_ORIGIN
  );
  endpoint.searchParams.set("output_format", voice.outputFormat);
  const response = await fetchImpl(endpoint, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "xi-api-key": apiKey,
    },
    body: JSON.stringify({
      text: scene.narration,
      model_id: voice.modelId,
      voice_settings: VOICE_SETTINGS,
    }),
  });
  if (!response.ok) {
    throw new Error(
      `ElevenLabs timestamped narration failed for ${scene.id} with HTTP ${response.status}`
    );
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new Error(
      `ElevenLabs returned a non-JSON response for ${scene.id}`
    );
  }
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error(
      `ElevenLabs returned invalid JSON for ${scene.id}: ${error.message}`
    );
  }
  return validateTimestampedNarrationResponse(payload, scene);
}

export async function generateNarration({
  env = process.env,
  fetchImpl = globalThis.fetch,
  planPath = DEFAULT_SCENE_PLAN,
} = {}) {
  const sourceSha = expectedReleaseSha(env);
  if (env.GITHUB_SHA !== sourceSha) {
    throw new Error(
      "Narration generation must run from the exact release SHA"
    );
  }
  requireExactBooleanAttestation(
    "DEMO_VIDEO_VOICE_RIGHTS_ATTESTED",
    env
  );
  const apiKey = requireNonEmptyEnv("ELEVENLABS_API_KEY", env);
  const root = demoVideoRoot(env);
  ensureOutputDirectory(root, "narration");
  const plan = loadScenePlan(planPath);
  const planSha256 = sha256File(planPath);
  const allCues = [];
  const scenes = [];

  for (const scene of plan.scenes) {
    const result = await fetchTimestampedNarration(
      scene,
      plan.voice,
      apiKey,
      { fetchImpl }
    );
    const relativeAudioPath = `narration/${scene.id}.mp3`;
    const audioPath = writeFileAtomic(
      root,
      relativeAudioPath,
      result.audio
    );
    allCues.push(...result.cues);
    scenes.push({
      id: scene.id,
      startSeconds: scene.startSeconds,
      endSeconds: scene.endSeconds,
      alignmentDurationSeconds: result.alignmentDuration,
      alignmentValid: true,
      audio: fileEvidence(audioPath, root),
    });
  }

  validateCaptionsAgainstPlan(allCues, plan);
  const captionsPath = writeFileAtomic(
    root,
    "narration/captions.en.srt",
    serializeSrt(allCues),
    { encoding: "utf8" }
  );
  const receipt = {
    schema: "archon.demo-video-narration",
    version: 1,
    passed: true,
    provider: plan.voice.provider,
    voiceId: plan.voice.voiceId,
    modelId: plan.voice.modelId,
    outputFormat: plan.voice.outputFormat,
    voiceSettings: VOICE_SETTINGS,
    voiceRightsAttested: true,
    timestampEndpoint: "with-timestamps",
    alignmentSource: "alignment",
    fallbackUsed: false,
    allAlignmentsValid: true,
    sceneCount: plan.scenes.length,
    scenePlanSha256: planSha256,
    sourceSha,
    captions: fileEvidence(captionsPath, root),
    scenes,
  };
  const receiptPath = writeFileAtomic(
    root,
    "narration/narration-receipt.json",
    stableJson(receipt),
    { encoding: "utf8" }
  );
  return {
    receipt,
    receiptPath,
    captions: readFileSync(captionsPath, "utf8"),
  };
}

if (isMain(import.meta.url)) {
  generateNarration()
    .then(({ receiptPath }) => {
      process.stdout.write(
        `Timestamped narration receipt: ${receiptPath}\n`
      );
    })
    .catch((error) => {
      process.stderr.write(`Narration gate failed: ${error.message}\n`);
      process.exitCode = 1;
    });
}
