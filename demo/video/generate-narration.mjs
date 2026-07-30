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
const CANONICAL_VOICE = Object.freeze({
  voiceId: "pNInz6obpgDQGcFmaJgB",
  modelId: "eleven_multilingual_v2",
  outputFormat: "mp3_44100_128",
});
export const NARRATION_MAX_WORDS_PER_MINUTE = 85;

function canonicalNarrationForScene(scene) {
  let id;
  let narration;
  switch (scene?.id) {
    case "hook":
      id = "hook";
      narration =
        "Agent memory can hold plausible but wrong financial facts. Archon Memory exposes persistent disagreement before financial decisions.";
      break;
    case "scope-architecture":
      id = "scope-architecture";
      narration =
        "On AWS serverless, this public synthetic demo keeps relational truth, provenance, audit, and native vector memory in one serializable CockroachDB system.";
      break;
    case "recall-grounding":
      id = "recall-grounding";
      narration =
        "Facts are stored idempotently with provenance, lifecycle, and payload-bound digests. Titan embeds the question; CockroachDB recalls through native C-SPANN under exact tenant, model, lifecycle, and company scopes. The result reports employer cost of fifteen thousand three hundred seventy-five euros and an off-bank wedge of six thousand seven hundred seventy-five euros. Every claim links to stored memory. Failed citation, numeric, or claim checks trigger deterministic evidence.";
      break;
    case "audit":
      id = "audit";
      narration =
        "Semantic recall is not a complete audit. This bounded pass finds an invoice conflict: eighteen thousand four hundred versus eighteen thousand nine hundred euros. It recommends higher-importance evidence without rewriting either record. It also finds payment PAY-118 referenced but never stored. Unknown stays unknown.";
      break;
    case "proof":
      id = "proof";
      narration =
        "The proof ledger binds the release, database, role, region, and vector index. It verifies nine memories, nine idempotency keys, and nine content digests. Evaluations cover larger corpora, RF-three placement, and recall after one node stops.";
      break;
    case "managed-mcp":
      id = "managed-mcp";
      narration =
        "Separately, CockroachDB Cloud Managed MCP makes four hosted read-only calls and accepts the fixed-scope nine-nine-nine result. Its receipt exposes no credentials, connection material, memory text, or embeddings.";
      break;
    case "close":
      id = "close";
      narration =
        "Archon Memory makes hidden memory inspectable and contradiction-aware. The demo and source are public.";
      break;
    default:
      throw new Error("Narration scene is outside the canonical allowlist");
  }
  if (scene.narration !== narration) {
    throw new Error(`Scene ${id} narration differs from the canonical allowlist`);
  }
  return Object.freeze({ id, narration });
}

export function validateNarrationWordBudgets(plan) {
  if (!Array.isArray(plan?.scenes) || plan.scenes.length === 0) {
    throw new Error("Narration word budgets require a non-empty scene plan");
  }
  for (const scene of plan.scenes) {
    const durationSeconds = scene?.endSeconds - scene?.startSeconds;
    if (
      typeof scene?.id !== "string" ||
      typeof scene?.narration !== "string" ||
      scene.narration.trim() === "" ||
      !Number.isFinite(durationSeconds) ||
      durationSeconds <= 0
    ) {
      throw new Error("Narration word budgets received an invalid scene");
    }
    const wordCount = scene.narration.trim().split(/\s+/u).length;
    const maximumWords = Math.floor(
      (durationSeconds * NARRATION_MAX_WORDS_PER_MINUTE) / 60
    );
    if (wordCount > maximumWords) {
      throw new Error(
        `Scene ${scene.id} has ${wordCount} words; its deterministic ${NARRATION_MAX_WORDS_PER_MINUTE}-WPM budget allows ${maximumWords}`
      );
    }
  }
  return true;
}

function requireCanonicalVoice(voice) {
  if (
    voice?.voiceId !== CANONICAL_VOICE.voiceId ||
    voice?.modelId !== CANONICAL_VOICE.modelId ||
    voice?.outputFormat !== CANONICAL_VOICE.outputFormat
  ) {
    throw new Error("ElevenLabs voice configuration is outside the allowlist");
  }
}

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
  const canonicalScene = canonicalNarrationForScene(scene);
  requireCanonicalVoice(voice);
  const endpoint = new URL(
    `/v1/text-to-speech/${CANONICAL_VOICE.voiceId}/with-timestamps`,
    ELEVENLABS_ORIGIN
  );
  endpoint.searchParams.set("output_format", CANONICAL_VOICE.outputFormat);
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
      text: canonicalScene.narration,
      model_id: CANONICAL_VOICE.modelId,
      voice_settings: VOICE_SETTINGS,
    }),
  });
  if (!response.ok) {
    throw new Error(
      `ElevenLabs timestamped narration failed for ${canonicalScene.id} with HTTP ${response.status}`
    );
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new Error(
      `ElevenLabs returned a non-JSON response for ${canonicalScene.id}`
    );
  }
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error(
      `ElevenLabs returned invalid JSON for ${canonicalScene.id}: ${error.message}`
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
  const plan = loadScenePlan(planPath);
  requireCanonicalVoice(plan.voice);
  for (const scene of plan.scenes) {
    canonicalNarrationForScene(scene);
  }
  validateNarrationWordBudgets(plan);
  const planSha256 = sha256File(planPath);
  const apiKey = requireNonEmptyEnv("ELEVENLABS_API_KEY", env);
  const root = demoVideoRoot(env);
  ensureOutputDirectory(root, "narration");
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
