#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

const EXPECTED_SCANNER = "Trivy";
const EXPECTED_SCANNER_VERSION = "0.72.0";
const EXPECTED_SYFT_VERSION = "1.50.0";
const EXPECTED_SEVERITIES = Object.freeze([
  "UNKNOWN",
  "MEDIUM",
  "HIGH",
  "CRITICAL",
]);
const FRONTEND_SOURCE_EXCLUSIONS = Object.freeze([
  "./node_modules/resolve/test/resolver/baz/**",
  "./node_modules/resolve/test/resolver/browser_field/**",
  "./node_modules/resolve/test/resolver/false_main/**",
  "./node_modules/resolve/test/resolver/invalid_main/**",
]);
const APPROVED_BUILD_LICENSES = Object.freeze([
  Object.freeze({
    package: "@csstools/color-helpers",
    version: "5.1.0",
    purl: "pkg:npm/%40csstools/color-helpers@5.1.0",
    license: "MIT-0",
    severity: "UNKNOWN",
    category: "unknown",
    location: "/node_modules/@csstools/color-helpers/package.json",
    lockPath: "node_modules/@csstools/color-helpers",
    resolved:
      "https://registry.npmjs.org/@csstools/color-helpers/-/color-helpers-5.1.0.tgz",
    integrity:
      "sha512-S11EXWJyy0Mz5SYvRmY8nJYTFFd1LCNV+7cXyAgQtOOuzb4EsgfqDufL+9esx72/eLhsRdGZwaldu/h+E4t4BA==",
    dev: true,
    optional: false,
    purpose: "Vite CSS build dependency",
  }),
  Object.freeze({
    package: "lightningcss",
    version: "1.33.0",
    purl: "pkg:npm/lightningcss@1.33.0",
    license: "MPL-2.0",
    severity: "MEDIUM",
    category: "reciprocal",
    location: "/node_modules/lightningcss/package.json",
    lockPath: "node_modules/lightningcss",
    resolved:
      "https://registry.npmjs.org/lightningcss/-/lightningcss-1.33.0.tgz",
    integrity:
      "sha512-WkUDrojuJs0xkgGf2udWxa3yGBRxPtxUkB79i6aCZLRgc7PM8fZe9TosfPDcvEpQZbuFASnHYmRLBLUbmLOIIA==",
    dev: true,
    optional: false,
    purpose: "Vite CSS build dependency",
  }),
  Object.freeze({
    package: "lightningcss-linux-x64-gnu",
    version: "1.33.0",
    purl: "pkg:npm/lightningcss-linux-x64-gnu@1.33.0",
    license: "MPL-2.0",
    severity: "MEDIUM",
    category: "reciprocal",
    location: "/node_modules/lightningcss-linux-x64-gnu/package.json",
    lockPath: "node_modules/lightningcss-linux-x64-gnu",
    resolved:
      "https://registry.npmjs.org/lightningcss-linux-x64-gnu/-/lightningcss-linux-x64-gnu-1.33.0.tgz",
    integrity:
      "sha512-ar+Ju7LmcN0Jo4FpL4hpFybwNG9/3A/Br5KW2n2jyODg3MEZXaDYADdemoNS+BDNfMgKvylJLj4S5tyRActuAg==",
    dev: true,
    optional: true,
    cpu: Object.freeze(["x64"]),
    os: Object.freeze(["linux"]),
    purpose: "optional Linux x64 Vite CSS build binary",
  }),
  Object.freeze({
    package: "lightningcss-linux-x64-musl",
    version: "1.33.0",
    purl: "pkg:npm/lightningcss-linux-x64-musl@1.33.0",
    license: "MPL-2.0",
    severity: "MEDIUM",
    category: "reciprocal",
    location: "/node_modules/lightningcss-linux-x64-musl/package.json",
    lockPath: "node_modules/lightningcss-linux-x64-musl",
    resolved:
      "https://registry.npmjs.org/lightningcss-linux-x64-musl/-/lightningcss-linux-x64-musl-1.33.0.tgz",
    integrity:
      "sha512-RYiYbkokw0trfKqqzfF55lginwEPrD3OJDfTuJzFs1MK6iFnDenaz1fqLLtX4ITG3OktJQXOeTaw1awrBAlZPw==",
    dev: true,
    optional: true,
    cpu: Object.freeze(["x64"]),
    os: Object.freeze(["linux"]),
    purpose: "optional Linux x64 musl Vite CSS build binary",
  }),
]);

function invariant(condition, message) {
  if (!condition) {
    throw new Error(`Trivy SBOM policy validation failed: ${message}`);
  }
}

function parseJson(label, source) {
  try {
    return JSON.parse(source);
  } catch {
    throw new Error(`Trivy SBOM policy validation failed: ${label} is not valid JSON`);
  }
}

function normalizeSource(source) {
  return source.replaceAll("\r\n", "\n");
}

function validateToolLock(toolLock) {
  invariant(toolLock?.schemaVersion === 1, "tool lock schemaVersion must be 1");
  for (const [tool, version] of [
    ["trivy", EXPECTED_SCANNER_VERSION],
    ["syft", EXPECTED_SYFT_VERSION],
  ]) {
    invariant(
      toolLock.tools?.[tool]?.version === version,
      `tool lock must pin ${tool} ${version}`
    );
    invariant(
      /^[0-9a-f]{64}$/u.test(toolLock.tools[tool].sha256),
      `tool lock must retain the ${tool} archive digest`
    );
  }
}

function validateVersionOutput(versionOutput) {
  const lines = normalizeSource(versionOutput)
    .split("\n")
    .filter((line) => line.length > 0);
  invariant(lines.length >= 1, "captured Trivy version output must not be empty");
  invariant(
    lines[0] === `Version: ${EXPECTED_SCANNER_VERSION}`,
    `captured Trivy version must be ${EXPECTED_SCANNER_VERSION}`
  );
}

function validateFrontendWorkflowScope(workflowSource) {
  const normalized = normalizeSource(workflowSource);
  const startMarker = '          "$TOOL_BIN/syft" dir:web \\\n';
  const endMarker = '          "$TOOL_BIN/syft" "dir:$SAM_BUILD_DIR/ArchonFunction" \\\n';
  const start = normalized.indexOf(startMarker);
  invariant(start >= 0, "frontend Syft command must occur exactly once");
  invariant(
    normalized.indexOf(startMarker, start + startMarker.length) === -1,
    "frontend Syft command must not be duplicated"
  );
  const end = normalized.indexOf(endMarker, start + startMarker.length);
  invariant(end > start, "frontend Syft command must precede the Lambda-content command");
  const command = normalized.slice(start, end);
  const exclusions = [...command.matchAll(/--exclude '([^']+)'/gu)].map(
    (match) => match[1]
  );
  invariant(
    JSON.stringify(exclusions) ===
      JSON.stringify(["./dist/**", ...FRONTEND_SOURCE_EXCLUSIONS]),
    "frontend Syft exclusions must be the exact dist and resolve-fixture source list"
  );
  invariant(
    command.includes("--select-catalogers javascript") &&
      command.includes("--select-catalogers +javascript-package-cataloger"),
    "frontend Syft must retain both JavaScript catalogers"
  );
  invariant(
    !command.includes("./node_modules/**"),
    "broad node_modules exclusion is prohibited"
  );
}

function validateLockEntry(lock, policy) {
  const entry = lock.packages?.[policy.lockPath];
  invariant(entry && typeof entry === "object", `${policy.package} lock entry is required`);
  invariant(entry.version === policy.version, `${policy.package} version drifted`);
  invariant(entry.dev === policy.dev, `${policy.package} must remain development-only`);
  invariant(
    (entry.optional ?? false) === policy.optional,
    `${policy.package} optional flag drifted`
  );
  invariant(entry.resolved === policy.resolved, `${policy.package} resolved URL drifted`);
  invariant(entry.integrity === policy.integrity, `${policy.package} integrity drifted`);
  if (policy.cpu !== undefined) {
    invariant(JSON.stringify(entry.cpu) === JSON.stringify(policy.cpu), `${policy.package} CPU boundary drifted`);
  }
  if (policy.os !== undefined) {
    invariant(JSON.stringify(entry.os) === JSON.stringify(policy.os), `${policy.package} OS boundary drifted`);
  }
}

function artifactLocations(artifact) {
  invariant(Array.isArray(artifact.locations), "Syft artifact locations must be an array");
  return artifact.locations.map((location) => location?.path);
}

function validateFrontendInventory(frontendSyft, frontendLock) {
  invariant(frontendLock?.lockfileVersion === 3, "frontend lockfileVersion must be 3");
  invariant(frontendLock.packages && typeof frontendLock.packages === "object", "frontend lockfile packages map is required");
  invariant(Array.isArray(frontendSyft?.artifacts), "frontend Syft artifacts must be an array");

  for (const policy of APPROVED_BUILD_LICENSES) {
    validateLockEntry(frontendLock, policy);
    const artifacts = frontendSyft.artifacts.filter(
      (artifact) => artifact?.name === policy.package
    );
    invariant(artifacts.length === 1, `${policy.package} must have exactly one Syft artifact`);
    const artifact = artifacts[0];
    invariant(artifact.version === policy.version, `${policy.package} Syft version drifted`);
    invariant(artifact.type === "npm", `${policy.package} Syft type must be npm`);
    invariant(artifact.purl === policy.purl, `${policy.package} Syft purl drifted`);
    invariant(
      artifact.foundBy === "javascript-package-cataloger",
      `${policy.package} must be source-observed by javascript-package-cataloger`
    );
    invariant(
      artifactLocations(artifact).includes(policy.location),
      `${policy.package} Syft location drifted`
    );
    invariant(
      JSON.stringify(artifact.licenses) ===
        JSON.stringify([
          {
            value: policy.license,
            spdxExpression: policy.license,
            type: "declared",
            urls: [],
            locations: [
              {
                path: policy.location,
                accessPath: policy.location,
                annotations: { evidence: "primary" },
              },
            ],
          },
        ]),
      `${policy.package} Syft declared-license evidence drifted`
    );
  }

  const resolveEntry = frontendLock.packages["node_modules/resolve"];
  invariant(
    resolveEntry?.version === "1.22.12" && resolveEntry.dev === true,
    "resolve 1.22.12 must remain a development dependency at the fixture-exclusion boundary"
  );
  const fixturePackageJsonPaths = FRONTEND_SOURCE_EXCLUSIONS.map((exclusion) =>
    exclusion.replace(/^\./u, "").replace(/\/\*\*$/u, "/package.json")
  );
  for (const artifact of frontendSyft.artifacts) {
    invariant(
      !artifactLocations(artifact).some((path) => fixturePackageJsonPaths.includes(path)),
      "resolve test fixtures must not appear as dependency artifacts"
    );
  }
  if (frontendSyft.files !== undefined) {
    invariant(Array.isArray(frontendSyft.files), "frontend Syft files must be an array when present");
    for (const file of frontendSyft.files) {
      const path = file?.location?.path;
      invariant(
        !fixturePackageJsonPaths.includes(path),
        "resolve test fixture package manifests must be excluded from the Syft source"
      );
    }
  }
}

function flattenReport(scope, report) {
  invariant(report && typeof report === "object", `${scope} Trivy report must be an object`);
  invariant(report.SchemaVersion === 2, `${scope} Trivy SchemaVersion must be 2`);
  invariant(Array.isArray(report.Results), `${scope} Trivy Results must be an array`);
  const findings = [];
  for (const result of report.Results) {
    invariant(result && typeof result === "object", `${scope} Trivy result must be an object`);
    if (result.Vulnerabilities !== undefined) {
      invariant(Array.isArray(result.Vulnerabilities), `${scope} Vulnerabilities must be an array`);
      for (const finding of result.Vulnerabilities) {
        findings.push({ scope, kind: "vulnerability", result, finding });
      }
    }
    if (result.Licenses !== undefined) {
      invariant(Array.isArray(result.Licenses), `${scope} Licenses must be an array`);
      for (const finding of result.Licenses) {
        findings.push({ scope, kind: "license", result, finding });
      }
    }
  }
  return findings;
}

function normalizeFinding(entry) {
  const { scope, kind, result, finding } = entry;
  if (kind === "vulnerability") {
    return {
      scope,
      kind,
      target: result.Target ?? null,
      package: finding?.PkgName ?? null,
      installedVersion: finding?.InstalledVersion ?? null,
      vulnerabilityId: finding?.VulnerabilityID ?? null,
      severity: finding?.Severity ?? null,
    };
  }
  return {
    scope,
    kind,
    target: result.Target ?? null,
    package: finding?.PkgName ?? null,
    license: finding?.Name ?? null,
    severity: finding?.Severity ?? null,
    category: finding?.Category ?? null,
    filePath: finding?.FilePath ?? null,
    confidence: finding?.Confidence ?? null,
  };
}

function matchesApprovedLicense(entry, policy) {
  return (
    entry.scope === "frontend" &&
    entry.kind === "license" &&
    entry.result.Target === "Node.js" &&
    entry.result.Class === "license" &&
    entry.finding?.PkgName === policy.package &&
    entry.finding?.Name === policy.license &&
    entry.finding?.Severity === policy.severity &&
    entry.finding?.Category === policy.category &&
    entry.finding?.FilePath === "" &&
    entry.finding?.Confidence === 1
  );
}

function validateRawExitCodes(findings, rawExitCodes) {
  for (const scope of ["backend", "frontend", "lambda-content"]) {
    const expected = findings.some((entry) => entry.scope === scope) ? 1 : 0;
    invariant(
      rawExitCodes[scope] === expected,
      `${scope} Trivy policy exit code must be ${expected}`
    );
  }
}

function evaluate({
  backendReport,
  frontendReport,
  lambdaReport,
  frontendSyft,
  frontendLock,
  workflowSource,
  toolLock,
  versionOutput,
  rawExitCodes,
}) {
  validateToolLock(toolLock);
  validateVersionOutput(versionOutput);
  validateFrontendWorkflowScope(workflowSource);
  validateFrontendInventory(frontendSyft, frontendLock);

  const findings = [
    ...flattenReport("backend", backendReport),
    ...flattenReport("frontend", frontendReport),
    ...flattenReport("lambda-content", lambdaReport),
  ];
  validateRawExitCodes(findings, rawExitCodes);

  const compatibilityFindings = [];
  const blockingFindings = [];
  for (const entry of findings) {
    const matchedPolicy = APPROVED_BUILD_LICENSES.find((policy) =>
      matchesApprovedLicense(entry, policy)
    );
    if (matchedPolicy === undefined) {
      blockingFindings.push(normalizeFinding(entry));
      continue;
    }
    compatibilityFindings.push({
      scope: "frontend",
      kind: "build-license",
      package: matchedPolicy.package,
      version: matchedPolicy.version,
      purl: matchedPolicy.purl,
      license: matchedPolicy.license,
      severity: matchedPolicy.severity,
      category: matchedPolicy.category,
      cataloger: "javascript-package-cataloger",
      location: matchedPolicy.location,
      resolved: matchedPolicy.resolved,
      integrity: matchedPolicy.integrity,
      dev: matchedPolicy.dev,
      optional: matchedPolicy.optional,
      purpose: matchedPolicy.purpose,
    });
  }

  invariant(
    compatibilityFindings.length === APPROVED_BUILD_LICENSES.length &&
      new Set(compatibilityFindings.map((finding) => finding.package)).size ===
        APPROVED_BUILD_LICENSES.length,
    "the exact four build-only license findings must be present once each"
  );
  compatibilityFindings.sort(
    (left, right) =>
      APPROVED_BUILD_LICENSES.findIndex(
        (policy) => policy.package === left.package
      ) -
      APPROVED_BUILD_LICENSES.findIndex(
        (policy) => policy.package === right.package
      )
  );

  const vulnerabilityFindings = findings.filter(
    (entry) => entry.kind === "vulnerability"
  ).length;
  const licenseFindings = findings.filter((entry) => entry.kind === "license").length;
  const effectiveExitCode = blockingFindings.length === 0 ? 0 : 1;
  return {
    compatibilityFindings,
    blockingFindings,
    status: {
      schema: "archon.trivy-sbom.compatibility",
      version: 1,
      mode: "blocking-exact-build-license-compatibility",
      scanner: EXPECTED_SCANNER,
      scannerVersion: EXPECTED_SCANNER_VERSION,
      inventoryScanner: "Syft",
      inventoryScannerVersion: EXPECTED_SYFT_VERSION,
      versionEvidence: {
        trivyToolLock: EXPECTED_SCANNER_VERSION,
        trivyCapturedCli: EXPECTED_SCANNER_VERSION,
        syftToolLock: EXPECTED_SYFT_VERSION,
      },
      scanners: ["vuln", "license"],
      severities: [...EXPECTED_SEVERITIES],
      rawExitCodes: {
        backend: rawExitCodes.backend,
        frontend: rawExitCodes.frontend,
        lambdaContent: rawExitCodes["lambda-content"],
      },
      rawFindings: findings.length,
      vulnerabilityFindings,
      licenseFindings,
      approvedBuildLicenseFindings: compatibilityFindings.length,
      blockingFindings: blockingFindings.length,
      acceptedWaivers: 0,
      effectiveExitCode,
      sourceExclusions: [...FRONTEND_SOURCE_EXCLUSIONS],
      approvedBuildLicenses: compatibilityFindings.map((finding) => ({
        package: finding.package,
        version: finding.version,
        purl: finding.purl,
        license: finding.license,
        severity: finding.severity,
        category: finding.category,
        cataloger: finding.cataloger,
        location: finding.location,
        resolved: finding.resolved,
        integrity: finding.integrity,
        dev: finding.dev,
        optional: finding.optional,
        purpose: finding.purpose,
      })),
    },
  };
}

function fixturePolicyReport(licenses = []) {
  return {
    SchemaVersion: 2,
    Results:
      licenses.length === 0
        ? []
        : [
            {
              Target: "Node.js",
              Class: "license",
              Licenses: licenses,
            },
          ],
  };
}

function fixtureFrontendSyft() {
  return {
    artifacts: APPROVED_BUILD_LICENSES.map((policy) => ({
      name: policy.package,
      version: policy.version,
      type: "npm",
      foundBy: "javascript-package-cataloger",
      purl: policy.purl,
      locations: [{ path: policy.location }],
      licenses: [
        {
          value: policy.license,
          spdxExpression: policy.license,
          type: "declared",
          urls: [],
          locations: [
            {
              path: policy.location,
              accessPath: policy.location,
              annotations: { evidence: "primary" },
            },
          ],
        },
      ],
    })),
    files: [],
  };
}

function fixtureFrontendLock() {
  const packages = {
    "": { name: "fixture", version: "1.0.0" },
    "node_modules/resolve": {
      version: "1.22.12",
      resolved: "https://registry.npmjs.org/resolve/-/resolve-1.22.12.tgz",
      dev: true,
    },
  };
  for (const policy of APPROVED_BUILD_LICENSES) {
    packages[policy.lockPath] = {
      version: policy.version,
      resolved: policy.resolved,
      integrity: policy.integrity,
      dev: true,
      ...(policy.optional ? { optional: true } : {}),
      ...(policy.cpu === undefined ? {} : { cpu: [...policy.cpu] }),
      ...(policy.os === undefined ? {} : { os: [...policy.os] }),
    };
  }
  return { lockfileVersion: 3, packages };
}

function fixtureWorkflow() {
  return `          "$TOOL_BIN/syft" dir:web \\
            --exclude './dist/**' \\
            --exclude './node_modules/resolve/test/resolver/baz/**' \\
            --exclude './node_modules/resolve/test/resolver/browser_field/**' \\
            --exclude './node_modules/resolve/test/resolver/false_main/**' \\
            --exclude './node_modules/resolve/test/resolver/invalid_main/**' \\
            --select-catalogers javascript \\
            --select-catalogers +javascript-package-cataloger \\
            --source-name archon-memory-control-room \\
            --output fixture
          "$TOOL_BIN/syft" "dir:$SAM_BUILD_DIR/ArchonFunction" \\
            --output fixture
`;
}

function fixtureToolLock() {
  return {
    schemaVersion: 1,
    tools: {
      trivy: { version: EXPECTED_SCANNER_VERSION, sha256: "a".repeat(64) },
      syft: { version: EXPECTED_SYFT_VERSION, sha256: "b".repeat(64) },
    },
  };
}

function fixtureLicenses() {
  return APPROVED_BUILD_LICENSES.map((policy) => ({
    Severity: policy.severity,
    Category: policy.category,
    PkgName: policy.package,
    FilePath: "",
    Name: policy.license,
    Confidence: 1,
  }));
}

function runSelfTest() {
  const base = {
    backendReport: fixturePolicyReport(),
    frontendReport: fixturePolicyReport(fixtureLicenses()),
    lambdaReport: fixturePolicyReport(),
    frontendSyft: fixtureFrontendSyft(),
    frontendLock: fixtureFrontendLock(),
    workflowSource: fixtureWorkflow(),
    toolLock: fixtureToolLock(),
    versionOutput: `Version: ${EXPECTED_SCANNER_VERSION}\n`,
    rawExitCodes: { backend: 0, frontend: 1, "lambda-content": 0 },
  };
  const result = evaluate(base);
  assert.equal(result.status.rawFindings, 4);
  assert.equal(result.status.approvedBuildLicenseFindings, 4);
  assert.equal(result.status.blockingFindings, 0);
  assert.equal(result.status.effectiveExitCode, 0);

  const unexpectedLicense = fixturePolicyReport([
    ...fixtureLicenses(),
    {
      Severity: "UNKNOWN",
      Category: "unknown",
      PkgName: "unexpected",
      FilePath: "",
      Name: "NOASSERTION",
      Confidence: 1,
    },
  ]);
  const blocked = evaluate({ ...base, frontendReport: unexpectedLicense });
  assert.equal(blocked.status.blockingFindings, 1);
  assert.equal(blocked.status.effectiveExitCode, 1);

  const driftedLock = fixtureFrontendLock();
  driftedLock.packages["node_modules/lightningcss"].dev = false;
  const driftedIntegrityLock = fixtureFrontendLock();
  driftedIntegrityLock.packages["node_modules/lightningcss"].integrity =
    "sha512-drifted";
  const driftedSyftLicense = fixtureFrontendSyft();
  driftedSyftLicense.artifacts[1].licenses[0].spdxExpression = "MIT";
  const failures = [
    { ...base, frontendLock: driftedLock },
    { ...base, frontendLock: driftedIntegrityLock },
    { ...base, frontendSyft: driftedSyftLicense },
    {
      ...base,
      workflowSource: fixtureWorkflow().replace(
        "            --exclude './node_modules/resolve/test/resolver/baz/**' \\\n",
        ""
      ),
    },
    { ...base, versionOutput: "Version: 0.72.1\n" },
    {
      ...base,
      rawExitCodes: { backend: 0, frontend: 0, "lambda-content": 0 },
    },
  ];
  for (const candidate of failures) {
    assert.throws(() => evaluate(candidate));
  }
  process.stdout.write(
    `${JSON.stringify({ ok: true, cases: 3 + failures.length, policy: "fail-closed" })}\n`
  );
}

function parseArguments(argv) {
  const allowed = new Set([
    "--backend-report",
    "--frontend-report",
    "--lambda-report",
    "--frontend-syft",
    "--frontend-lock",
    "--workflow",
    "--tool-lock",
    "--version-file",
    "--backend-exit-code",
    "--frontend-exit-code",
    "--lambda-exit-code",
    "--compatibility-output",
    "--blocking-output",
    "--status-output",
  ]);
  invariant(argv.length % 2 === 0, "arguments must be flag/value pairs");
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    invariant(allowed.has(flag), `unexpected argument ${flag}`);
    invariant(!values.has(flag), `duplicate argument ${flag}`);
    invariant(typeof value === "string" && value.length > 0, `${flag} requires a value`);
    values.set(flag, value);
  }
  for (const flag of allowed) {
    invariant(values.has(flag), `missing required argument ${flag}`);
  }
  return values;
}

function parseExitCode(args, flag) {
  const value = Number.parseInt(args.get(flag), 10);
  invariant(value === 0 || value === 1, `${flag} must be 0 or 1`);
  return value;
}

function read(path) {
  return readFileSync(path, "utf8");
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

if (process.argv.length === 3 && process.argv[2] === "--self-test") {
  runSelfTest();
} else {
  const args = parseArguments(process.argv.slice(2));
  const result = evaluate({
    backendReport: parseJson("backend Trivy report", read(args.get("--backend-report"))),
    frontendReport: parseJson("frontend Trivy report", read(args.get("--frontend-report"))),
    lambdaReport: parseJson("Lambda-content Trivy report", read(args.get("--lambda-report"))),
    frontendSyft: parseJson("frontend Syft report", read(args.get("--frontend-syft"))),
    frontendLock: parseJson("frontend lockfile", read(args.get("--frontend-lock"))),
    workflowSource: read(args.get("--workflow")),
    toolLock: parseJson("tool lock", read(args.get("--tool-lock"))),
    versionOutput: read(args.get("--version-file")),
    rawExitCodes: {
      backend: parseExitCode(args, "--backend-exit-code"),
      frontend: parseExitCode(args, "--frontend-exit-code"),
      "lambda-content": parseExitCode(args, "--lambda-exit-code"),
    },
  });
  writeJson(args.get("--compatibility-output"), result.compatibilityFindings);
  writeJson(args.get("--blocking-output"), result.blockingFindings);
  writeJson(args.get("--status-output"), result.status);
  process.exitCode = result.status.effectiveExitCode;
}
