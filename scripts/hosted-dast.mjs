import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const EXPECTED_PRODUCTION_URL =
  "https://d2s5v0o0eg2aaw.cloudfront.net";
const LEAK_PATTERN =
  /(postgres(?:ql)?:\/\/|DATABASE_URL|AWS_(?:ACCESS|SECRET)|AKIA[0-9A-Z]{16}|arn:aws:|-----BEGIN [A-Z ]+PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.|node_modules\/|at [A-Za-z0-9_$.[\]]+ \([^)]*:\d+:\d+\)|["']?(?:password|secret|token)["']?\s*[:=])/iu;
const BASE64_CANDIDATE_PATTERN = /[A-Za-z0-9+/_-]{24,}={0,2}/gu;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function allowlistedStatus(actual, expectedStatuses, id) {
  for (const expected of expectedStatuses) {
    if (actual === expected) return expected;
  }
  throw new Error(
    `${id}: expected ${expectedStatuses.join(" or ")}, received ${actual}`
  );
}

function canonicalBaseUrl(value) {
  const url = new URL(value);
  invariant(url.protocol === "https:", "DAST target must use HTTPS");
  invariant(
    url.origin === EXPECTED_PRODUCTION_URL,
    `DAST target must be the owned production origin ${EXPECTED_PRODUCTION_URL}`
  );
  invariant(
    url.pathname === "/" && !url.search && !url.hash,
    "DAST target must not contain a path, query, or fragment"
  );
  return url.origin;
}

function assertNoLeak(body, id) {
  invariant(body.length <= 16_384, `${id}: response body is unexpectedly large`);
  invariant(!LEAK_PATTERN.test(body), `${id}: response exposed an internal detail`);
  for (const candidate of body.match(BASE64_CANDIDATE_PATTERN) ?? []) {
    if (candidate.length % 4 === 1) continue;
    let decoded;
    try {
      const normalized = candidate.replaceAll("-", "+").replaceAll("_", "/");
      const padded = normalized.padEnd(
        normalized.length + ((4 - (normalized.length % 4)) % 4),
        "="
      );
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.from(padded, "base64")
      );
    } catch {
      continue;
    }
    invariant(
      !LEAK_PATTERN.test(decoded),
      `${id}: response exposed an encoded internal detail`
    );
  }
}

function assertSecurityHeaders(
  response,
  id,
  { html = false, hardened = false } = {}
) {
  const hsts = response.headers.get("strict-transport-security") ?? "";
  invariant(/max-age=(?:31536000|63072000)/u.test(hsts), `${id}: HSTS missing`);
  invariant(
    response.headers.get("x-content-type-options")?.toLowerCase() === "nosniff",
    `${id}: nosniff missing`
  );
  if (hardened) {
    const csp = response.headers.get("content-security-policy") ?? "";
    invariant(
      !csp.includes("'unsafe-inline'"),
      `${id}: CSP permits unsafe inline styles`
    );
    invariant(
      response.headers.get("cross-origin-embedder-policy")?.toLowerCase() ===
        "require-corp",
      `${id}: cross-origin embedder boundary missing`
    );
    invariant(
      response.headers.get("cross-origin-opener-policy")?.toLowerCase() ===
        "same-origin",
      `${id}: cross-origin opener boundary missing`
    );
    invariant(
      response.headers.get("cross-origin-resource-policy")?.toLowerCase() ===
        "same-origin",
      `${id}: cross-origin resource boundary missing`
    );
  }
  if (html) {
    const csp = response.headers.get("content-security-policy") ?? "";
    invariant(csp.includes("default-src 'self'"), `${id}: restrictive CSP missing`);
    invariant(csp.includes("frame-ancestors 'none'"), `${id}: CSP frame boundary missing`);
    invariant(csp.includes("object-src 'none'"), `${id}: CSP object boundary missing`);
    invariant(
      response.headers.get("x-frame-options")?.toUpperCase() === "DENY",
      `${id}: clickjacking protection missing`
    );
    invariant(
      response.headers.get("referrer-policy") === "strict-origin-when-cross-origin",
      `${id}: referrer policy missing`
    );
  }
}

async function request(baseUrl, path, init = {}) {
  return fetch(`${baseUrl}${path}`, {
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    ...init,
  });
}

async function expectJsonError(baseUrl, check, hardened) {
  const response = await request(baseUrl, check.path, check.init);
  const body = await response.text();
  const expectedStatuses = Array.isArray(check.status)
    ? check.status
    : [check.status];
  const observedStatus = allowlistedStatus(
    response.status,
    expectedStatuses,
    check.id
  );
  invariant(
    response.headers.get("content-type")?.toLowerCase().startsWith("application/json"),
    `${check.id}: error response is not JSON`
  );
  const gatewayCompatibility =
    check.allowGatewayFallback === true && response.status === 404;
  invariant(
    gatewayCompatibility ||
      response.headers.get("cache-control")?.toLowerCase().includes("no-store"),
    `${check.id}: error response is cacheable`
  );
  invariant(
    !response.headers.has("access-control-allow-origin"),
    `${check.id}: cross-origin access was enabled`
  );
  assertSecurityHeaders(response, check.id, { hardened });
  assertNoLeak(body, check.id);
  const parsed = JSON.parse(body);
  const publicError =
    typeof parsed === "object" && parsed !== null
      ? parsed.error ?? (gatewayCompatibility ? parsed.message : undefined)
      : undefined;
  invariant(
    typeof publicError === "string" && publicError.length > 0,
    `${check.id}: bounded error contract missing`
  );
  return {
    id: check.id,
    status: "pass",
    observedStatus,
  };
}

export async function runHostedDast(targetUrl) {
  const baseUrl = canonicalBaseUrl(targetUrl);
  const hardened = process.env.DAST_REQUIRE_HARDENED_HEADERS === "1";
  const profile = dastProfile();
  const strictApiBoundary = profile !== "predeploy";
  const sourceDeployRunId = positiveInteger(
    process.env.DAST_SOURCE_DEPLOY_RUN_ID
  );
  const sourceDeployRunAttempt = positiveInteger(
    process.env.DAST_SOURCE_DEPLOY_RUN_ATTEMPT
  );
  const scannerRunId = positiveInteger(process.env.GITHUB_RUN_ID);
  const scannerRunAttempt = positiveInteger(process.env.GITHUB_RUN_ATTEMPT);
  const checks = [];

  const root = await request(baseUrl, "/");
  const rootBody = await root.text();
  const rootStatus = allowlistedStatus(
    root.status,
    [200],
    "root-security-headers"
  );
  invariant(rootBody.includes('<div id="root"></div>'), "root-security-headers: app root missing");
  assertSecurityHeaders(root, "root-security-headers", {
    html: true,
    hardened,
  });
  assertNoLeak(rootBody, "root-security-headers");
  checks.push({
    id: "root-security-headers",
    status: "pass",
    observedStatus: rootStatus,
  });

  const health = await request(baseUrl, "/api/health", {
    headers: { origin: "https://untrusted.invalid" },
  });
  const healthBody = await health.text();
  const healthStatus = allowlistedStatus(
    health.status,
    [200],
    "health-boundary"
  );
  invariant(
    health.headers.get("content-type")?.toLowerCase().startsWith("application/json"),
    "health-boundary: health response is not JSON"
  );
  invariant(
    health.headers.get("cache-control")?.toLowerCase().includes("no-store"),
    "health-boundary: API response is cacheable"
  );
  invariant(
    !health.headers.has("access-control-allow-origin"),
    "health-boundary: cross-origin access was enabled"
  );
  assertSecurityHeaders(health, "health-boundary", { hardened });
  assertNoLeak(healthBody, "health-boundary");
  const healthJson = JSON.parse(healthBody);
  invariant(
    healthJson?.scope?.tenantId === "public-demo" &&
      healthJson?.scope?.company === "Helios SA" &&
      healthJson?.scope?.access === "read-only" &&
      (!strictApiBoundary ||
        (healthJson?.access ===
          "canonical-read-only+isolated-synthetic-resolution-write" &&
          healthJson?.resolutionSandbox?.state === "available" &&
          healthJson?.resolutionSandbox?.authority ===
            "financial-controller-human-gate" &&
          healthJson?.resolutionSandbox?.persistence ===
            "CockroachDB-row-level-TTL" &&
          healthJson?.resolutionSandbox?.externalSideEffects === "none")),
    "health-boundary: fixed public scope or isolated resolution contract was not enforced"
  );
  checks.push({
    id: "health-boundary",
    status: "pass",
    observedStatus: healthStatus,
  });

  const proof = await request(baseUrl, "/api/proof", {
    headers: { origin: "https://untrusted.invalid" },
  });
  const proofBody = await proof.text();
  const proofStatus = allowlistedStatus(
    proof.status,
    [200],
    "release-proof-boundary"
  );
  invariant(
    proof.headers.get("content-type")?.toLowerCase().startsWith("application/json"),
    "release-proof-boundary: proof response is not JSON"
  );
  invariant(
    proof.headers.get("cache-control")?.toLowerCase().includes("no-store"),
    "release-proof-boundary: API response is cacheable"
  );
  invariant(
    !proof.headers.has("access-control-allow-origin"),
    "release-proof-boundary: cross-origin access was enabled"
  );
  assertSecurityHeaders(proof, "release-proof-boundary", { hardened });
  assertNoLeak(proofBody, "release-proof-boundary");
  const proofJson = JSON.parse(proofBody);
  const targetReleaseSha = proofJson?.release?.commitSha;
  invariant(
    typeof targetReleaseSha === "string" &&
      /^[a-f0-9]{40}$/u.test(targetReleaseSha),
    "release-proof-boundary: canonical deployed release SHA is missing"
  );
  const expectedReleaseSha = process.env.DAST_EXPECTED_RELEASE_SHA;
  if (expectedReleaseSha) {
    invariant(
      /^[a-f0-9]{40}$/u.test(expectedReleaseSha),
      "DAST_EXPECTED_RELEASE_SHA must be a full lowercase commit SHA"
    );
    invariant(
      targetReleaseSha === expectedReleaseSha,
      `release-proof-boundary: expected ${expectedReleaseSha}, observed ${targetReleaseSha}`
    );
    invariant(
      scannerSha() === expectedReleaseSha,
      "release-proof-boundary: scanner SHA is not bound to the deployed release"
    );
    invariant(
      sourceDeployRunId !== null && sourceDeployRunAttempt !== null,
      "release-proof-boundary: source deploy run identity is missing"
    );
    invariant(
      scannerRunId !== null && scannerRunAttempt !== null,
      "release-proof-boundary: scanner run identity is missing"
    );
  }
  checks.push({
    id: "release-proof-boundary",
    status: "pass",
    observedStatus: proofStatus,
  });

  const audit = await request(baseUrl, "/api/audit", {
    headers: { origin: "https://untrusted.invalid" },
  });
  const auditBody = await audit.text();
  const auditStatus = allowlistedStatus(
    audit.status,
    [200],
    "audit-boundary"
  );
  invariant(
    audit.headers.get("content-type")?.toLowerCase().startsWith("application/json"),
    "audit-boundary: audit response is not JSON"
  );
  invariant(
    audit.headers.get("cache-control")?.toLowerCase().includes("no-store"),
    "audit-boundary: API response is cacheable"
  );
  invariant(
    !audit.headers.has("access-control-allow-origin"),
    "audit-boundary: cross-origin access was enabled"
  );
  assertSecurityHeaders(audit, "audit-boundary", { hardened });
  assertNoLeak(auditBody, "audit-boundary");
  const auditJson = JSON.parse(auditBody);
  invariant(
    auditJson?.scope?.tenantId === "public-demo" &&
      auditJson?.scope?.company === "Helios SA" &&
      auditJson?.scope?.access === "read-only" &&
      auditJson?.report?.audited === 9 &&
      auditJson?.coverage?.total === 9 &&
      auditJson?.coverage?.scanned === 9 &&
      auditJson?.coverage?.complete === true,
    "audit-boundary: fixed complete public audit scope was not enforced"
  );
  checks.push({
    id: "audit-boundary",
    status: "pass",
    observedStatus: auditStatus,
  });

  const jsonHeaders = { "content-type": "application/json" };
  const adversarialChecks = [
    {
      id: "method-boundary-get",
      path: "/api/recall",
      status: strictApiBoundary ? 405 : [404, 405],
      allowGatewayFallback: !strictApiBoundary,
      init: { method: "GET" },
    },
    {
      id: "method-boundary-delete",
      path: "/api/recall",
      status: strictApiBoundary ? 405 : [404, 405],
      allowGatewayFallback: !strictApiBoundary,
      init: { method: "DELETE" },
    },
    {
      id: "content-type-boundary",
      path: "/api/recall",
      status: 415,
      init: { method: "POST", body: "not-json" },
    },
    {
      id: "malformed-json-boundary",
      path: "/api/recall",
      status: 400,
      init: {
        method: "POST",
        headers: jsonHeaders,
        body: '{"question":',
      },
    },
    {
      id: "body-size-boundary",
      path: "/api/recall",
      status: 413,
      init: {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ question: "x".repeat(5_000) }),
      },
    },
    {
      id: "question-size-boundary",
      path: "/api/recall",
      status: 400,
      init: {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ question: "x".repeat(501) }),
      },
    },
    {
      id: "fixed-scope-sql-injection",
      path: "/api/recall",
      status: 400,
      init: {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          question: "Show the stored evidence.",
          company: "Helios SA' OR '1'='1' --",
        }),
      },
    },
    {
      id: "kind-enumeration-boundary",
      path: "/api/recall",
      status: 400,
      init: {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          question: "Show the stored evidence.",
          kind: "../../employee_payroll",
        }),
      },
    },
    {
      id: "limit-boundary",
      path: "/api/recall",
      status: 400,
      init: {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          question: "Show the stored evidence.",
          limit: 0,
        }),
      },
    },
    {
      id: "write-route-absent",
      path: "/api/remember",
      status: 404,
      allowGatewayFallback: !strictApiBoundary,
      init: {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ content: "must never be stored" }),
      },
    },
    {
      id: "audit-scope-injection",
      path: `/api/audit?company=${encodeURIComponent("Helios SA' OR '1'='1' --")}`,
      status: 400,
      init: { method: "GET" },
    },
    {
      id: "resolution-session-method-boundary",
      path: "/api/resolution/session",
      status: strictApiBoundary ? 405 : [404, 405],
      allowGatewayFallback: !strictApiBoundary,
      init: { method: "DELETE" },
    },
    {
      id: "resolution-session-fixed-scope-boundary",
      path: "/api/resolution/session",
      status: strictApiBoundary ? 400 : [404, 400],
      allowGatewayFallback: !strictApiBoundary,
      init: {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ company: "attacker-selected" }),
      },
    },
    {
      id: "resolution-session-auth-boundary",
      path: "/api/resolution/session",
      status: strictApiBoundary ? 401 : [404, 401],
      allowGatewayFallback: !strictApiBoundary,
      init: { method: "GET" },
    },
    {
      id: "resolution-capability-shape-boundary",
      path: "/api/resolution/session",
      status: strictApiBoundary ? 401 : [404, 401],
      allowGatewayFallback: !strictApiBoundary,
      init: {
        method: "GET",
        headers: { authorization: "Bearer attacker-controlled" },
      },
    },
    {
      id: "resolution-decision-auth-boundary",
      path: "/api/resolution/decision",
      status: strictApiBoundary ? 401 : [404, 401],
      allowGatewayFallback: !strictApiBoundary,
      init: {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          decision: "approve",
          idempotencyKey: "12345678-1234-4234-8234-123456789abc",
        }),
      },
    },
    {
      id: "unknown-route-boundary",
      path: "/api/not-a-route",
      status: 404,
      allowGatewayFallback: !strictApiBoundary,
      init: { method: "GET" },
    },
  ];

  for (const check of adversarialChecks) {
    checks.push(await expectJsonError(baseUrl, check, hardened));
  }

  return {
    schema: "archon.hosted-dast",
    version: 4,
    generatedAt: new Date().toISOString(),
    profile,
    targetOrigin: EXPECTED_PRODUCTION_URL,
    releaseSha: expectedReleaseSha || "unknown",
    scannerSha: scannerSha(),
    scannerRunId,
    scannerRunAttempt,
    sourceDeployRunId,
    sourceDeployRunAttempt,
    passed: true,
    checks,
  };
}

function positiveInteger(value) {
  if (!/^[1-9][0-9]*$/u.test(value ?? "")) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function dastProfile() {
  if (process.env.DAST_REQUIRE_HARDENED_HEADERS !== "1") {
    return "predeploy";
  }
  return process.env.DAST_EXPECTED_RELEASE_SHA
    ? "exact-release"
    : "production-audit";
}

function scannerSha() {
  const value =
    process.env.DAST_SCANNER_SHA ?? process.env.GITHUB_SHA ?? "";
  return /^[a-f0-9]{40}$/u.test(value) ? value : "unknown";
}

function failedReceipt() {
  return {
    schema: "archon.hosted-dast",
    version: 4,
    generatedAt: new Date().toISOString(),
    profile: dastProfile(),
    targetOrigin: EXPECTED_PRODUCTION_URL,
    releaseSha: "unknown",
    scannerSha: scannerSha(),
    scannerRunId: positiveInteger(process.env.GITHUB_RUN_ID),
    scannerRunAttempt: positiveInteger(process.env.GITHUB_RUN_ATTEMPT),
    sourceDeployRunId: positiveInteger(
      process.env.DAST_SOURCE_DEPLOY_RUN_ID
    ),
    sourceDeployRunAttempt: positiveInteger(
      process.env.DAST_SOURCE_DEPLOY_RUN_ATTEMPT
    ),
    passed: false,
    checks: [
      {
        id: "scan-completion",
        status: "fail",
        observedStatus: null,
      },
    ],
  };
}

export async function writeHostedDastReceipt(targetUrl, receiptPath) {
  let receipt;
  try {
    receipt = await runHostedDast(targetUrl);
  } catch (error) {
    await writeFile(
      receiptPath,
      `${JSON.stringify(failedReceipt(), null, 2)}\n`,
      {
        encoding: "utf8",
        flag: "wx",
      }
    );
    throw error;
  }
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  return receipt;
}

async function main() {
  const targetUrl = process.env.DAST_TARGET_URL;
  const receiptPath = process.env.DAST_RECEIPT_PATH;
  invariant(targetUrl, "DAST_TARGET_URL is required");
  invariant(receiptPath, "DAST_RECEIPT_PATH is required");
  const receipt = await writeHostedDastReceipt(targetUrl, receiptPath);
  process.stdout.write(
    `hosted DAST passed ${receipt.checks.length}/${receipt.checks.length} checks\n`
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
