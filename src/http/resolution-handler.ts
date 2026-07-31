import {
  extractResolutionToken,
  issueResolutionToken,
  parseResolutionDecision,
  ResolutionError,
  resolutionTokenHash,
  type ResolutionStore,
} from "../memory/resolution.js";
import { cockroachResolutionStore } from "../memory/resolution-store.js";

export interface ResolutionHttpResponse {
  status: number;
  body: Record<string, unknown>;
}

function publicResolutionError(error: unknown): ResolutionHttpResponse {
  if (error instanceof ResolutionError) {
    return {
      status: error.status,
      body: { error: error.publicMessage },
    };
  }
  throw error;
}

export async function handleCreateResolutionSession(
  raw: unknown,
  store: ResolutionStore = cockroachResolutionStore
): Promise<ResolutionHttpResponse> {
  if (
    typeof raw !== "object" ||
    raw === null ||
    Array.isArray(raw) ||
    Object.keys(raw as Record<string, unknown>).length !== 0
  ) {
    return {
      status: 400,
      body: {
        error:
          "Resolution sessions accept an empty JSON object; the scenario is fixed and synthetic.",
      },
    };
  }
  const token = issueResolutionToken();
  try {
    const snapshot = await store.createSession(resolutionTokenHash(token));
    return {
      status: 201,
      body: {
        sessionToken: token,
        tokenType: "Bearer",
        snapshot,
      },
    };
  } catch (error) {
    return publicResolutionError(error);
  }
}

export async function handleGetResolutionSession(
  authorization: string | undefined,
  store: ResolutionStore = cockroachResolutionStore
): Promise<ResolutionHttpResponse> {
  try {
    const token = extractResolutionToken(authorization);
    const snapshot = await store.getSession(resolutionTokenHash(token));
    return { status: 200, body: { snapshot } };
  } catch (error) {
    return publicResolutionError(error);
  }
}

export async function handleResolutionDecision(
  authorization: string | undefined,
  raw: unknown,
  store: ResolutionStore = cockroachResolutionStore
): Promise<ResolutionHttpResponse> {
  try {
    const token = extractResolutionToken(authorization);
    const request = parseResolutionDecision(raw);
    const snapshot = await store.decide(
      resolutionTokenHash(token),
      request
    );
    return {
      status: 200,
      body: {
        snapshot,
        idempotent: true,
      },
    };
  } catch (error) {
    return publicResolutionError(error);
  }
}
