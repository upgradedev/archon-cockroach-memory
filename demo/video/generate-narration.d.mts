import type {
  CaptionCue,
  DemoVideoPlan,
  DemoVideoScene,
} from "./lib.mjs";

export interface TimestampedNarrationResult {
  audio: Buffer;
  cues: CaptionCue[];
  alignmentDuration: number;
}

export const NARRATION_MAX_WORDS_PER_MINUTE: 85;

export function validateNarrationWordBudgets(
  plan: DemoVideoPlan
): true;

export function validateTimestampedNarrationResponse(
  payload: unknown,
  scene: DemoVideoScene
): TimestampedNarrationResult;

export function fetchTimestampedNarration(
  scene: DemoVideoScene,
  voice: DemoVideoPlan["voice"],
  apiKey: string,
  options?: { fetchImpl?: typeof fetch }
): Promise<TimestampedNarrationResult>;

export function generateNarration(options?: {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  planPath?: string;
}): Promise<{
  receipt: Record<string, unknown>;
  receiptPath: string;
  captions: string;
}>;
