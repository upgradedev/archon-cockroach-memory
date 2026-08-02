// Runtime-neutral validator for the hosted recall evidence contract.
//
// This module intentionally imports neither k6 nor Node APIs. The shipped k6
// workload and the pipeline-owned behavioral fixtures both execute this exact
// function, so the fixture suite cannot drift into a second implementation of
// the response contract.

export const HOSTED_RECALL_QUESTION =
  "What was the true employer cost and the off-bank payroll wedge for April 2026?";
export const HOSTED_RECALL_KIND = "payroll_event";

const FORBIDDEN_CANARIES = [
  "Synthetic isolation canary",
  "Synthetic wrong-tenant canary",
  "Synthetic retracted-status canary",
];
const EXACT_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function asRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function exactPublicScope(value) {
  const scope = asRecord(value);
  return (
    scope !== null &&
    Object.keys(scope).sort().join("\n") ===
      [
        "access",
        "company",
        "dataClassification",
        "mode",
        "source",
        "tenantId",
      ]
        .sort()
        .join("\n") &&
    scope.tenantId === "public-demo" &&
    scope.company === "Helios SA" &&
    scope.mode === "fixed-synthetic-demo" &&
    scope.access === "read-only" &&
    scope.dataClassification === "synthetic-public-demo" &&
    scope.source === "server-configured"
  );
}

/**
 * Validate one parsed /api/recall response without throwing on malformed data.
 *
 * @param {{ status: unknown, body: unknown }} response
 * @returns {{ contractOk: boolean, citationsOk: boolean, isolated: boolean }}
 */
export function validateHostedRecallResponse(response) {
  const body = asRecord(response && response.body);
  const citations = Array.isArray(body && body.citations) ? body.citations : [];
  const grounding = asRecord(body && body.grounding);
  const groundingChecks = asRecord(grounding && grounding.checks);
  const trace = asRecord(body && body.trace);
  const retrieval = asRecord(trace && trace.retrieval);
  const answer = body && typeof body.answer === "string" ? body.answer : "";

  const contractOk = Boolean(
    response &&
      response.status === 200 &&
      body &&
      body.question === HOSTED_RECALL_QUESTION &&
      Number.isInteger(body.recalled) &&
      body.recalled >= 2 &&
      body.recalled <= 5 &&
      body.recalled === citations.length &&
      retrieval &&
      retrieval.database === "CockroachDB" &&
      retrieval.index === "native C-SPANN vector index" &&
      retrieval.metric === "cosine" &&
      retrieval.embeddingModel === "amazon.titan-embed-text-v2:0" &&
      retrieval.requestedKind === HOSTED_RECALL_KIND &&
      retrieval.requestedTopK === 5 &&
      retrieval.recalled === body.recalled &&
      exactPublicScope(trace && trace.scope) &&
      body.consistencyOk === true
  );

  const citationsOk = Boolean(
    contractOk &&
      grounding &&
      (grounding.status === "verified" || grounding.status === "extractive") &&
      groundingChecks &&
      groundingChecks.citations === true &&
      groundingChecks.numerics === true &&
      groundingChecks.claims === true &&
      answer.includes("€15,375") &&
      answer.includes("€6,775") &&
      citations.every(
        (value, index) => {
          const citation = asRecord(value);
          return (
            citation !== null &&
            citation.marker === `[${index + 1}]` &&
            typeof citation.memoryId === "string" &&
            EXACT_UUID.test(citation.memoryId) &&
            typeof citation.sourceRef === "string" &&
            citation.sourceRef.length > 0 &&
            citation.kind === HOSTED_RECALL_KIND &&
            citation.company === "Helios SA" &&
            citation.period === "2026-04" &&
            typeof citation.content === "string" &&
            citation.content.length > 0 &&
            typeof citation.score === "number" &&
            Number.isFinite(citation.score) &&
            citation.score >= 0.15 &&
            citation.score <= 1 &&
            answer.includes(citation.marker)
          );
        }
      ) &&
      new Set(citations.map((citation) => citation.memoryId)).size ===
        citations.length &&
      citations.some(
        (citation) =>
          asRecord(citation) !== null && citation.content.includes("€15,375")
      ) &&
      citations.some(
        (citation) =>
          asRecord(citation) !== null && citation.content.includes("€6,775")
      )
  );

  let serialized = "";
  try {
    serialized = body ? JSON.stringify(body) : "";
  } catch (_error) {
    return { contractOk, citationsOk, isolated: false };
  }
  const isolated = Boolean(
    contractOk &&
      FORBIDDEN_CANARIES.every((canary) => !serialized.includes(canary))
  );

  return { contractOk, citationsOk, isolated };
}
