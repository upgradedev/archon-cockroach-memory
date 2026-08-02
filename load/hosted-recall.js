// Bounded hosted-path load evidence for the deployed Archon Memory application.
//
// This script intentionally does not seed or mutate data. It asks one fixed,
// rights-safe question against the immutable public demo scope and validates the
// complete grounded-recall contract on every response. The workflow that owns
// this script binds BASE_URL to an approved CloudFront origin and proves the
// exact deployed release before k6 is allowed to send traffic.

import http from "k6/http";
import { check, fail } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";
import {
  HOSTED_RECALL_KIND,
  HOSTED_RECALL_QUESTION,
  validateHostedRecallResponse,
} from "./hosted-recall-contract.js";

const BASE_URL = (__ENV.BASE_URL || "").replace(/\/$/u, "");
const RELEASE_SHA = __ENV.RELEASE_SHA || "";
const TOTAL_ITERATIONS = Number(__ENV.TOTAL_ITERATIONS || 60);
const VUS = Number(__ENV.VUS || 3);
const MAX_DURATION_SECONDS = Number(__ENV.MAX_DURATION_SECONDS || 300);
const P95_LATENCY_MS = Number(__ENV.P95_LATENCY_MS || 5000);
const MAX_ERROR_RATE = Number(__ENV.MAX_ERROR_RATE || 0.01);

if (!/^https:\/\/[a-z0-9-]+\.cloudfront\.net$/u.test(BASE_URL)) {
  throw new Error("BASE_URL must be one bare HTTPS CloudFront origin.");
}
if (!/^[0-9a-f]{40}$/u.test(RELEASE_SHA)) {
  throw new Error("RELEASE_SHA must be one exact lowercase commit SHA.");
}
if (
  !Number.isInteger(TOTAL_ITERATIONS) ||
  TOTAL_ITERATIONS < 20 ||
  TOTAL_ITERATIONS > 200
) {
  throw new Error("TOTAL_ITERATIONS must be an integer from 20 through 200.");
}
if (!Number.isInteger(VUS) || VUS < 2 || VUS > 10 || VUS > TOTAL_ITERATIONS) {
  throw new Error("VUS must be an integer from 2 through 10 and not exceed iterations.");
}
if (
  !Number.isInteger(MAX_DURATION_SECONDS) ||
  MAX_DURATION_SECONDS < 60 ||
  MAX_DURATION_SECONDS > 600
) {
  throw new Error("MAX_DURATION_SECONDS must be an integer from 60 through 600.");
}
if (!Number.isInteger(P95_LATENCY_MS) || P95_LATENCY_MS < 500 || P95_LATENCY_MS > 30000) {
  throw new Error("P95_LATENCY_MS must be an integer from 500 through 30000.");
}
if (!Number.isFinite(MAX_ERROR_RATE) || MAX_ERROR_RATE < 0 || MAX_ERROR_RATE > 0.05) {
  throw new Error("MAX_ERROR_RATE must be between 0 and 0.05.");
}

const recallContract = new Rate("hosted_recall_contract");
const groundedCitations = new Rate("hosted_grounded_citations");
const scopeIsolation = new Rate("hosted_scope_isolation");
const recallHttpFailure = new Rate("hosted_recall_http_failure");
const recallDuration = new Trend("hosted_recall_duration_ms", true);
const successfulRecalls = new Counter("hosted_successful_recalls");

export const options = {
  discardResponseBodies: false,
  scenarios: {
    hosted_recall: {
      executor: "shared-iterations",
      vus: VUS,
      iterations: TOTAL_ITERATIONS,
      maxDuration: `${MAX_DURATION_SECONDS}s`,
      gracefulStop: "0s",
    },
  },
  thresholds: {
    hosted_recall_duration_ms: [`p(95)<${P95_LATENCY_MS}`],
    hosted_recall_http_failure: [`rate<=${MAX_ERROR_RATE}`],
    hosted_recall_contract: ["rate>=1"],
    hosted_grounded_citations: ["rate>=1"],
    hosted_scope_isolation: ["rate>=1"],
    hosted_successful_recalls: [`count>=${TOTAL_ITERATIONS}`],
  },
};

function parseResponse(response) {
  try {
    return response.json();
  } catch (_error) {
    return null;
  }
}

export function setup() {
  const response = http.get(`${BASE_URL}/api/proof`, {
    redirects: 0,
    tags: { name: "GET /api/proof preflight" },
    timeout: "30s",
  });
  const body = parseResponse(response);
  const exactRelease =
    response.status === 200 &&
    body &&
    body.release &&
    body.release.commitSha === RELEASE_SHA &&
    body.release.evidence === "server-configured Lambda environment";
  if (!exactRelease) {
    fail("Hosted target does not prove the exact authorized release.");
  }
  return { releaseSha: RELEASE_SHA };
}

export default function () {
  const response = http.post(
    `${BASE_URL}/api/recall`,
    JSON.stringify({
      question: HOSTED_RECALL_QUESTION,
      kind: HOSTED_RECALL_KIND,
      limit: 5,
    }),
    {
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "archon-hosted-load-evidence/1",
      },
      redirects: 0,
      tags: { name: "POST /api/recall hosted evidence" },
      timeout: "30s",
    }
  );
  const body = parseResponse(response);
  const { contractOk, citationsOk, isolated } =
    validateHostedRecallResponse({ status: response.status, body });

  recallDuration.add(response.timings.duration);
  recallHttpFailure.add(response.status !== 200);
  recallContract.add(Boolean(contractOk));
  groundedCitations.add(Boolean(citationsOk));
  scopeIsolation.add(Boolean(isolated));
  if (contractOk && citationsOk && isolated) {
    successfulRecalls.add(1);
  }
  check(response, {
    "hosted recall response is contract-valid": () => Boolean(contractOk),
    "hosted recall is grounded in complete citations": () => Boolean(citationsOk),
    "hosted recall preserves the three-axis isolation canary": () =>
      Boolean(isolated),
  });
}
