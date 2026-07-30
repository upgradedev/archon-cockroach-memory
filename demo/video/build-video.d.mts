import type { DemoVideoPlan } from "./lib.mjs";

export function validateCaptureProbe(
  probe: unknown,
  plan: DemoVideoPlan,
  rawVideoTrimLeadSeconds: number
): {
  codec: string;
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
  audioStreams: 0;
};

export function buildFilterGraph(
  plan: DemoVideoPlan,
  captionsPath: string,
  rawVideoTrimLeadSeconds: number
): string;

export function buildVideo(options?: {
  env?: NodeJS.ProcessEnv;
  planPath?: string;
}): {
  receipt: Record<string, unknown>;
  receiptPath: string;
  finalPath: string;
};
