// k6 load test for the recall / vector-search path.
//
// Drives concurrent recall requests at the shared HTTP recall server
// (src/http/server.ts), which runs the SAME MemoryAgent.recallAnswer path the AWS
// Lambda demo uses — ANN vector search over the CockroachDB distributed vector
// index, then narration. It asserts, under concurrency, BOTH:
//   • LATENCY   — p95 of the recall request stays under the SLO, and
//   • RECALL@1  — the top cited memory is the exact record we asked for (see
//                 load/seed.ts: exact-text question ⇒ cosine distance 0 ⇒ the
//                 correct record must rank first).
//
// Runs against the CI CockroachDB (the `load` job seeds it, starts the server on
// $BASE_URL, then runs this). Locally: seed a DB, `npm run serve`, then
//   k6 run -e BASE_URL=http://localhost:8787 -e LOAD_N=2000 load/recall.js
//
// SLO reference (see README / docs/BENCHMARK.md): p95 recall latency < 1500 ms and
// recall@1 ≥ 0.99 at 20 concurrent virtual users against a single-node CI cluster.

import http from "k6/http";
import { check } from "k6";
import { Rate } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL || "http://localhost:8787";
const LOAD_N = Number(__ENV.LOAD_N || 2000);
const COMPANY = __ENV.LOAD_COMPANY || "LoadCorp";

const recallCorrect = new Rate("recall_correct");

export const options = {
  scenarios: {
    recall_under_load: {
      executor: "constant-vus",
      vus: Number(__ENV.VUS || 20),
      duration: __ENV.DURATION || "20s",
    },
  },
  thresholds: {
    // p95 recall latency SLO — kept with headroom so the gate is signal, not flake.
    http_req_duration: ["p(95)<1500"],
    // recall@1 correctness under concurrency must hold for essentially every request.
    recall_correct: ["rate>0.99"],
    // no request may error out.
    http_req_failed: ["rate<0.01"],
  },
};

// Must mirror load/seed.ts::memoryText exactly.
function memoryText(i) {
  return `Load-test memory ${i}: unique-token load${i}tok covering topic ${i % 11} for LoadCorp.`;
}

export default function () {
  const i = Math.floor(Math.random() * LOAD_N);
  const question = memoryText(i);
  const res = http.post(
    `${BASE_URL}/recall`,
    JSON.stringify({ question, company: COMPANY, kind: "insight", limit: 5 }),
    { headers: { "Content-Type": "application/json" } }
  );

  const ok200 = check(res, { "status is 200": (r) => r.status === 200 });
  let top = null;
  try {
    const body = res.json();
    top = body && body.citations && body.citations[0] ? body.citations[0].content : null;
  } catch (_e) {
    top = null;
  }
  // recall@1: the exact-text question must return its own record first.
  recallCorrect.add(ok200 && top === question);
}
