import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
// The runtime-neutral module is the exact implementation imported by k6.
// @ts-ignore TypeScript does not emit declarations for the shipped JS module.
import {
  HOSTED_RECALL_KIND,
  HOSTED_RECALL_QUESTION,
  validateHostedRecallResponse,
} from "../load/hosted-recall-contract.js";
import { handleRecall } from "../src/http/handler.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");
const workflow = read(".github/workflows/hosted-load-evidence.yml");
const load = read("load/hosted-recall.js");
const contract = read("load/hosted-recall-contract.js");
const ci = read(".github/workflows/ci.yml");
const objectives = read("docs/operations/SLO_AND_OWNERSHIP.md");

function validHostedRecallBody(): Record<string, any> {
  return {
    question: HOSTED_RECALL_QUESTION,
    answer:
      "The true employer cost was €15,375 [1], while the off-bank payroll wedge was €6,775 [2].",
    recalled: 2,
    grounding: {
      status: "verified",
      checks: { citations: true, numerics: true, claims: true },
    },
    consistencyOk: true,
    citations: [
      {
        marker: "[1]",
        memoryId: "00000000-0000-4000-8000-000000000001",
        sourceRef: "synthetic://payroll/2026-04/employer-cost",
        kind: HOSTED_RECALL_KIND,
        company: "Helios SA",
        period: "2026-04",
        content: "The true employer cost was €15,375.",
        score: 0.91,
      },
      {
        marker: "[2]",
        memoryId: "00000000-0000-4000-8000-000000000002",
        sourceRef: "synthetic://payroll/2026-04/off-bank-wedge",
        kind: HOSTED_RECALL_KIND,
        company: "Helios SA",
        period: "2026-04",
        content: "The off-bank payroll wedge was €6,775.",
        score: 0.84,
      },
    ],
    trace: {
      scope: {
        tenantId: "public-demo",
        company: "Helios SA",
        mode: "fixed-synthetic-demo",
        access: "read-only",
        dataClassification: "synthetic-public-demo",
        source: "server-configured",
      },
      retrieval: {
        database: "CockroachDB",
        index: "native C-SPANN vector index",
        metric: "cosine",
        embeddingModel: "amazon.titan-embed-text-v2:0",
        requestedKind: HOSTED_RECALL_KIND,
        requestedTopK: 5,
        recalled: 2,
      },
    },
  };
}

test("hosted load is manual, protected, bounded, and exact-release gated", () => {
  const trigger = workflow.slice(
    workflow.indexOf("on:"),
    workflow.indexOf("concurrency:")
  );
  assert.match(trigger, /^\s+workflow_dispatch:/mu);
  assert.doesNotMatch(
    trigger,
    /^\s+(?:push|pull_request|schedule|workflow_call):/mu
  );
  assert.match(
    workflow,
    /environment:\s+\$\{\{ inputs\.environment == 'production' && 'production-audit' \|\| 'staging' \}\}/u
  );
  assert.match(workflow, /RUN-%s-HOSTED-LOAD-EVIDENCE/u);
  assert.match(workflow, /test "\$TOTAL_ITERATIONS" -ge 20/u);
  assert.match(workflow, /test "\$TOTAL_ITERATIONS" -le 200/u);
  assert.match(workflow, /test "\$VUS" -ge 2/u);
  assert.match(workflow, /test "\$VUS" -le 10/u);
  assert.match(workflow, /test "\$P95_LATENCY_MS" -le 30000/u);
  assert.match(workflow, /test "\$MAX_ERROR_RATE_BPS" -le 500/u);
  assert.match(workflow, /--max-redirs 0/u);
  assert.match(workflow, /\^https:\/\/[a-z0-9-]\+\\\.cloudfront\\\.net\$/u);
});

test("hosted load source is bound to current green deployed main", () => {
  assert.match(workflow, /test "\$GITHUB_REF" = "refs\/heads\/main"/u);
  assert.match(workflow, /test "\$GITHUB_SHA" = "\$TARGET_SHA"/u);
  assert.match(
    workflow,
    /test "\$\(git rev-parse origin\/main\)" = "\$TARGET_SHA"/u
  );
  assert.match(workflow, /prove_workflow ci\.yml CI/u);
  assert.match(workflow, /prove_workflow codeql\.yml CodeQL/u);
  assert.match(workflow, /supply-chain\.yml "Supply Chain \(enforced\)"/u);
  assert.match(workflow, /deploy-aws\.yml "Deploy AWS"/u);
  assert.match(
    workflow,
    /\.release\.commitSha == \$sha[\s\S]*?\.database\.engine == "CockroachDB"[\s\S]*?\.database\.region == "eu-west-1"[\s\S]*?\.vectorIndex\.engine == "native CockroachDB C-SPANN"[\s\S]*?\.vectorIndex\.enabled == true/u
  );
  assert.doesNotMatch(
    workflow,
    /id-token:\s+write|configure-aws-credentials|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY/u
  );
});

test("hosted k6 validates grounded C-SPANN recall and scope isolation", () => {
  assert.match(load, /executor:\s+"shared-iterations"/u);
  assert.match(load, /iterations:\s+TOTAL_ITERATIONS/u);
  assert.match(load, /p\(95\)<\$\{P95_LATENCY_MS\}/u);
  assert.match(load, /hosted_recall_contract/u);
  assert.match(load, /hosted_grounded_citations/u);
  assert.match(load, /hosted_scope_isolation/u);
  assert.match(load, /hosted_recall_duration_ms/u);
  assert.match(load, /hosted_recall_http_failure/u);
  assert.match(load, /hosted_successful_recalls/u);
  assert.match(load, /validateHostedRecallResponse/u);
  assert.match(load, /\.\/hosted-recall-contract\.js/u);
  assert.match(load, /hosted_recall_contract:\s*\["rate>=1"\]/u);
  assert.match(load, /hosted_grounded_citations:\s*\["rate>=1"\]/u);
  assert.match(load, /hosted_scope_isolation:\s*\["rate>=1"\]/u);
  assert.match(
    load,
    /hosted_successful_recalls:\s*\[`count>=\$\{TOTAL_ITERATIONS\}`\]/u
  );
  assert.doesNotMatch(
    load,
    /http_req_duration:\s*\[|http_req_failed:\s*\[/u
  );
  assert.match(contract, /database === "CockroachDB"/u);
  assert.match(contract, /index === "native C-SPANN vector index"/u);
  assert.match(contract, /embeddingModel === "amazon\.titan-embed-text-v2:0"/u);
  assert.match(contract, /requestedKind === HOSTED_RECALL_KIND/u);
  assert.match(contract, /requestedTopK === 5/u);
  assert.match(contract, /exactPublicScope/u);
  assert.match(contract, /grounding\.status === "verified"/u);
  assert.match(contract, /grounding\.status === "extractive"/u);
  assert.match(contract, /groundingChecks\.citations === true/u);
  assert.match(contract, /groundingChecks\.numerics === true/u);
  assert.match(contract, /groundingChecks\.claims === true/u);
  assert.match(contract, /body\.consistencyOk === true/u);
  assert.match(contract, /answer\.includes\("€15,375"\)/u);
  assert.match(contract, /answer\.includes\("€6,775"\)/u);
  assert.match(contract, /EXACT_UUID\.test\(citation\.memoryId\)/u);
  assert.match(contract, /citation\.marker === `\[\$\{index \+ 1\}\]`/u);
  assert.match(contract, /citation\.sourceRef/u);
  assert.match(contract, /citation\.period === "2026-04"/u);
  assert.match(contract, /citation\.score >= 0\.15/u);
  assert.match(contract, /citation\.score <= 1/u);
  assert.match(contract, /citation\.company === "Helios SA"/u);
  assert.match(contract, /citation\.kind === HOSTED_RECALL_KIND/u);
  assert.match(contract, /Synthetic isolation canary/u);
  assert.doesNotMatch(contract, /from "(?:k6|node:)|__ENV/u);
  assert.doesNotMatch(load, /(?:seed|remember|resolve)\(/u);
});

test("the exact shipped validator accepts an actual handler response fixture", async () => {
  const fixture = validHostedRecallBody();
  const fakeAgent = {
    embeddingModelId: "amazon.titan-embed-text-v2:0",
    recallAnswer: async () => ({
      answer: fixture.answer,
      hits: [{}, {}],
      citations: fixture.citations,
      modelId: "fixture-narrator",
      grounding: fixture.grounding,
      consistency: { ok: true, findings: [] },
    }),
  } as unknown as Parameters<typeof handleRecall>[1];
  const response = await handleRecall(
    {
      question: HOSTED_RECALL_QUESTION,
      kind: "payroll_event",
      limit: 5,
    },
    fakeAgent
  );
  assert.equal(response.status, 200);
  assert.deepEqual(
    validateHostedRecallResponse({
      status: response.status,
      body: response.body,
    }),
    { contractOk: true, citationsOk: true, isolated: true }
  );
});

test("the exact shipped validator fails closed across contract, grounding, and isolation drift", () => {
  const missingGrounding = validHostedRecallBody();
  delete missingGrounding.grounding;
  assert.deepEqual(
    validateHostedRecallResponse({ status: 200, body: missingGrounding }),
    { contractOk: true, citationsOk: false, isolated: true }
  );

  const wrongScope = validHostedRecallBody();
  wrongScope.trace.scope.tenantId = "other-tenant";
  assert.deepEqual(
    validateHostedRecallResponse({ status: 200, body: wrongScope }),
    { contractOk: false, citationsOk: false, isolated: false }
  );

  const duplicateCitation = validHostedRecallBody();
  duplicateCitation.citations[1].memoryId =
    duplicateCitation.citations[0].memoryId;
  assert.deepEqual(
    validateHostedRecallResponse({ status: 200, body: duplicateCitation }),
    { contractOk: true, citationsOk: false, isolated: true }
  );

  const malformedCitation = validHostedRecallBody();
  malformedCitation.citations[1] = null;
  assert.deepEqual(
    validateHostedRecallResponse({ status: 200, body: malformedCitation }),
    { contractOk: true, citationsOk: false, isolated: true }
  );

  const wrongKind = validHostedRecallBody();
  wrongKind.citations[1].kind = "validation";
  assert.deepEqual(
    validateHostedRecallResponse({ status: 200, body: wrongKind }),
    { contractOk: true, citationsOk: false, isolated: true }
  );

  const wrongRequestedKind = validHostedRecallBody();
  wrongRequestedKind.trace.retrieval.requestedKind = "validation";
  assert.deepEqual(
    validateHostedRecallResponse({ status: 200, body: wrongRequestedKind }),
    { contractOk: false, citationsOk: false, isolated: false }
  );

  const leakedCanary = validHostedRecallBody();
  leakedCanary.trace.debug = "Synthetic wrong-tenant canary";
  assert.deepEqual(
    validateHostedRecallResponse({ status: 200, body: leakedCanary }),
    { contractOk: true, citationsOk: true, isolated: false }
  );

  assert.deepEqual(
    validateHostedRecallResponse({ status: 503, body: validHostedRecallBody() }),
    { contractOk: false, citationsOk: false, isolated: false }
  );
  assert.deepEqual(
    validateHostedRecallResponse({ status: 200, body: null }),
    { contractOk: false, citationsOk: false, isolated: false }
  );
});

test("main CI parses the shipped k6 module without making hosted requests", () => {
  assert.match(ci, /name: Inspect hosted-load module without network/u);
  assert.match(ci, /k6 inspect[\s\S]*?load\/hosted-recall\.js >\/dev\/null/u);
  assert.match(ci, /BASE_URL:\s+https:\/\/d111111abcdef8\.cloudfront\.net/u);
  assert.match(ci, /RELEASE_SHA:\s+"0{40}"/u);
  assert.match(ci, /TOTAL_ITERATIONS:\s+"20"/u);
  assert.match(ci, /VUS:\s+"2"/u);
  assert.match(ci, /MAX_DURATION_SECONDS:\s+"60"/u);
  assert.match(ci, /P95_LATENCY_MS:\s+"5000"/u);
  assert.match(ci, /MAX_ERROR_RATE:\s+"0\.01"/u);
  for (const variable of [
    "BASE_URL",
    "RELEASE_SHA",
    "TOTAL_ITERATIONS",
    "VUS",
    "MAX_DURATION_SECONDS",
    "P95_LATENCY_MS",
    "MAX_ERROR_RATE",
  ]) {
    assert.match(ci, new RegExp(`-e ${variable}="\\$${variable}"`, "u"));
  }
  assert.match(
    ci,
    /Prove pinned k6 machine-readable summary schema without network/u
  );
  assert.match(ci, /--new-machine-readable-summary/u);
  assert.match(ci, /load\/k6-summary-schema-smoke\.js/u);
  assert.match(ci, /\.version == "1\.0\.0"/u);
  assert.match(ci, /\.results\.metrics/u);
  assert.match(ci, /rm -f -- "\$summary"/u);
});

test("receipt is sanitized, threshold-enforced, and honest about evidence", () => {
  assert.match(workflow, /--new-machine-readable-summary/u);
  assert.match(workflow, /schema: "archon\.hosted-load-evidence"/u);
  assert.match(workflow, /version:\s+2/u);
  assert.match(workflow, /measurementWindow:/u);
  assert.match(workflow, /contractSource:\s+"load\/hosted-recall\.js"/u);
  assert.match(workflow, /contractSourceSha256:\s+\$workloadContractSha256/u);
  assert.match(workflow, /load\/hosted-recall-contract\.js/u);
  assert.match(workflow, /sha256\(canonical-sha256sum-manifest\)/u);
  assert.match(workflow, /hosted-load-contract\.sha256/u);
  assert.match(workflow, /sha256sum --check --strict/u);
  assert.match(workflow, /measurementStartedAt/u);
  assert.match(workflow, /measurementCompletedAt/u);
  assert.match(workflow, /measurementDuration/u);
  assert.match(workflow, /hosted_recall_duration_ms/u);
  assert.match(workflow, /hosted_recall_http_failure/u);
  assert.match(workflow, /hosted_successful_recalls/u);
  assert.match(workflow, /successfulRecalls:/u);
  assert.match(workflow, /\(\$summary\[0\]\) as \$document/u);
  assert.match(workflow, /\$document\.version == "1\.0\.0"/u);
  assert.match(workflow, /\$document\.results\.metrics/u);
  assert.match(workflow, /map\(\.name\)/u);
  assert.match(workflow, /from_entries/u);
  assert.match(
    workflow,
    /\$metrics\.hosted_successful_recalls\.values\.count\s*== \$iterations/u
  );
  assert.match(
    workflow,
    /\.observed\.successfulRecalls\s*== \.workload\.iterations/u
  );
  assert.match(
    workflow,
    /\.workload\.contractSourceSha256 == \$contractDigest/u
  );
  assert.match(workflow, /\.rawSummary\.sha256 == \$summaryDigest/u);
  assert.match(
    workflow,
    /layout: "k6-machine-readable-results-metrics-array"/u
  );
  assert.match(workflow, /summarySha256/u);
  assert.match(workflow, /alignment_wait="\$\(\(62 - current_second\)\)"/u);
  assert.match(workflow, /sleep "\$alignment_wait"/u);
  assert.match(workflow, /p95LatencyMs:/u);
  assert.match(workflow, /errorRate:/u);
  assert.match(workflow, /groundingRate:/u);
  assert.match(workflow, /isolationRate:/u);
  assert.match(workflow, /dataMutation: false/u);
  assert.match(
    workflow,
    /This is a bounded hosted-path measurement, not a production traffic claim\./u
  );
  assert.match(workflow, /The corpus is synthetic and rights-safe\./u);
  assert.match(workflow, /not an inferred business SLA/u);
  assert.match(workflow, /retention-days:\s+90/u);
  assert.match(objectives, /Hosted Load Evidence/u);
  assert.match(
    objectives,
    /does not silently convert them into a business SLA/u
  );
});

test("all hosted-load third-party actions are immutable", () => {
  const uses = [...workflow.matchAll(/^\s+uses:\s+([^\s#]+)/gmu)].map(
    (match) => match[1]
  );
  assert.equal(uses.length, 4);
  for (const action of uses) {
    assert.match(action, /^[^@]+@[a-f0-9]{40}$/u);
  }
  assert.equal(
    (workflow.match(/persist-credentials:\s+false/gu) ?? []).length,
    2
  );
});
