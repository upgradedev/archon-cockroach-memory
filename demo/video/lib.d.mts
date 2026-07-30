export interface DemoVideoScene {
  id: string;
  title?: string;
  startSeconds: number;
  endSeconds: number;
  color: string;
  narration: string;
}

export interface DemoVideoPlan {
  schema: "archon.demo-video-plan";
  version: 1;
  targetDurationSeconds: number;
  width: number;
  height: number;
  fps: number;
  voice: {
    provider: "ElevenLabs";
    voiceId: string;
    modelId: string;
    outputFormat: string;
  };
  scenes: DemoVideoScene[];
}

export interface CaptionCue {
  index?: number;
  sceneId?: string;
  startSeconds: number;
  endSeconds: number;
  text: string;
}

export interface FileEvidence {
  path: string;
  bytes: number;
  sha256: string;
}

export interface LoudnessMetrics {
  integratedLufs: number;
  truePeakDbtp: number;
  loudnessRangeLu: number;
  thresholdLufs: number;
  targetOffsetLu: number;
}

export const DEFAULT_SCENE_PLAN: string;
export const CANONICAL_ORIGIN: string;
export const CANONICAL_REPOSITORY: string;
export const VIDEO_SCHEMA_VERSION: number;
export const EXPECTED_SCENES: readonly Readonly<{
  id: string;
  startSeconds: number;
  endSeconds: number;
  color: string;
}>[];
export const EXPECTED_CAPTURE_SCREENSHOTS: readonly string[];

export function loadScenePlan(path?: string): DemoVideoPlan;
export function validateScenePlan(
  plan: unknown,
  options?: { canonical?: boolean }
): DemoVideoPlan;
export function alignmentToCues(
  alignment: unknown,
  scene: DemoVideoScene
): { cues: CaptionCue[]; alignmentDuration: number };
export function parseSrt(value: string): CaptionCue[];
export function serializeSrt(cues: CaptionCue[]): string;
export function validateCaptionsAgainstPlan(
  cues: CaptionCue[],
  plan: DemoVideoPlan
): true;
export function validateSceneMarkers(
  markers: unknown,
  plan: DemoVideoPlan
): true;
export function validateReleaseBinding(
  receipt: unknown,
  expectedSha: string
): true;
export function validateCaptureReceipt(
  receipt: unknown,
  options: {
    expectedSha: string;
    planSha256: string;
    capturePath: string;
    root: string;
    release: unknown;
  }
): true;
export function runnerTemp(env?: NodeJS.ProcessEnv): string;
export function demoVideoRoot(
  env?: NodeJS.ProcessEnv,
  options?: { create?: boolean }
): string;
export function outputPath(
  root: string,
  relativePath: string,
  label?: string
): string;
export function writeFileAtomic(
  root: string,
  relativePath: string,
  value: string | NodeJS.ArrayBufferView,
  options?: {
    encoding?: BufferEncoding;
    mode?: number;
    replace?: boolean;
  }
): string;
export function fileEvidence(path: string, root: string): FileEvidence;
export function assertFileEvidence(
  path: string,
  evidence: FileEvidence,
  label: string
): string;
export function parseLoudnormMetrics(stderr: string): LoudnessMetrics;
export function validateLoudness(metrics: LoudnessMetrics): true;
export function validateMediaProbe(
  probe: unknown,
  expected: {
    durationSeconds: number;
    width: number;
    height: number;
    fps: number;
    durationToleranceSeconds?: number;
    avToleranceSeconds?: number;
    strictCodecs?: boolean;
  }
): {
  durationSeconds: number;
  videoDurationSeconds: number;
  audioDurationSeconds: number;
  width: number;
  height: number;
  fps: number;
  videoCodec: string;
  videoProfile: string;
  pixelFormat: string;
  audioCodec: string;
  audioSampleRate: number;
  audioChannels: number;
};
