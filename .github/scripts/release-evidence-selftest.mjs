#!/usr/bin/env node
//
// Fixture-driven self-test for .github/scripts/assert-release-evidence.sh.
//
// Why this exists. The release receipt's evidence assertions run only in the
// release-evidence job, which is gated on a push to refs/heads/main. They were
// therefore skipped on every pull request, and nothing else evaluated them:
// shellcheck lints shell, actionlint lints workflow syntax, and neither one
// evaluates a jq filter. On 2026-08-04 that gap let a template change reach
// main with every check green. Making Distribution.WebACLId an Fn::If moved
// Trivy's AWS-0011 CauseMetadata.Resource from an "aws/template.yaml:458-544"
// source range to the bare logical resource id "Distribution". The receipt
// failed closed on the merge commit and on every push after it, and Deploy AWS
// died in its first job for six consecutive pushes.
//
// What it does. It synthesises a complete, well-formed evidence tree, runs the
// real contract against it, and requires that it passes. It then applies one
// mutation at a time and requires that each mutated tree is rejected, which is
// what proves each assertion is load-bearing rather than decorative. Fixtures
// are synthesised rather than replayed from a recorded run: recorded artifacts
// rot as the templates move, and a green test over stale inputs looks like
// coverage without being coverage.
//
// The contract itself is not duplicated here. This file only builds inputs and
// checks exit status; assert-release-evidence.sh is the single copy, and the
// receipt step runs that same file. A second copy that drifts from its
// consumer is the exact failure mode being fixed.
//
// Needs bash, jq and Node. No secrets, no AWS credentials, no network.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CONTRACT = resolve(SCRIPT_DIR, "assert-release-evidence.sh");

const SOURCE_SHA = "0f3c1d9a4b7e2c85d06fa31b9e4c7d2085ab6f31";
const RUN_ID = "30977195166";
const RUN_ATTEMPT = "1";
const WAIVER_LEDGER_SHA256 =
  "6b8fbe6a2cbb9b6f8f4a1d2e3c5079ab4d6e8f012345678990abcdef01234567";
const WAIVER_LEDGER_LINE = `${WAIVER_LEDGER_SHA256}  security/waivers.yml\n`;

const TRIVY_VERSION = "0.72.0";
const TRIVY_VERSION_OUTPUT = `Version: ${TRIVY_VERSION}\nVulnerability DB:\n  Version: 2\n`;

const ACTIONLINT_DIAGNOSTIC =
  'unexpected key "queue" for "concurrency" section. expected one of "cancel-in-progress", "group"';
const ACTIONLINT_PATHS = [
  ".github/workflows/bootstrap-aws.yml",
  ".github/workflows/deploy-aws.yml",
  ".github/workflows/edge-controls.yml",
  ".github/workflows/foundation-migration.yml",
  ".github/workflows/recover-aws.yml",
];
// Five files, fourteen diagnostics, matching the counts the receipt pins.
const ACTIONLINT_COUNTS = [2, 5, 3, 2, 2];

const TEMPLATE_TARGET = "aws/template.yaml";
const BOOTSTRAP_TARGET = "aws/bootstrap-oidc.yaml";

// The four source-validated Trivy compatibilities, in the order the receipt
// pins. AWS-0011 is the one that carries the logical resource id: Trivy
// resolves the HasCloudFrontWebAcl condition and pins the finding to the single
// WebACLId property line. Every other finding is raised against a complete
// resource block and carries the "target:start-end" range. Both shapes are
// exercised by the well-formed fixture, and mutations below prove each is
// pinned rather than merely tolerated.
const IAC_CONTRACTS = [
  {
    ruleId: "AWS-0011",
    target: TEMPLATE_TARGET,
    logicalResource: "Distribution",
    namespace: "builtin.aws.cloudfront.aws0011",
    startLine: 471,
    endLine: 471,
    resourceShape: "logical-resource",
  },
  {
    ruleId: "AWS-0013",
    target: TEMPLATE_TARGET,
    logicalResource: "Distribution",
    namespace: "builtin.aws.cloudfront.aws0013",
    startLine: 458,
    endLine: 544,
    resourceShape: "range",
  },
  {
    ruleId: "AWS-0132",
    target: TEMPLATE_TARGET,
    logicalResource: "SpaBucket",
    namespace: "builtin.aws.s3.aws0132",
    startLine: 392,
    endLine: 436,
    resourceShape: "range",
  },
  {
    ruleId: "AWS-0132",
    target: BOOTSTRAP_TARGET,
    logicalResource: "CloudFrontAccessLogBucket",
    namespace: "builtin.aws.s3.aws0132",
    startLine: 214,
    endLine: 283,
    resourceShape: "range",
  },
];

function scannerResource(contract) {
  return `${contract.target}:${contract.startLine}-${contract.endLine}`;
}

function causeResource(contract) {
  return contract.resourceShape === "logical-resource"
    ? contract.logicalResource
    : scannerResource(contract);
}

const BUILD_LICENSES = [
  {
    package: "@csstools/color-helpers",
    version: "5.1.0",
    license: "MIT-0",
    resolved:
      "https://registry.npmjs.org/@csstools/color-helpers/-/color-helpers-5.1.0.tgz",
    integrity:
      "sha512-S11EXWJyy0Mz5SYvRmY8nJYTFFd1LCNV+7cXyAgQtOOuzb4EsgfqDufL+9esx72/eLhsRdGZwaldu/h+E4t4BA==",
  },
  {
    package: "lightningcss",
    version: "1.33.0",
    license: "MPL-2.0",
    resolved: "https://registry.npmjs.org/lightningcss/-/lightningcss-1.33.0.tgz",
    integrity:
      "sha512-WkUDrojuJs0xkgGf2udWxa3yGBRxPtxUkB79i6aCZLRgc7PM8fZe9TosfPDcvEpQZbuFASnHYmRLBLUbmLOIIA==",
  },
  {
    package: "lightningcss-linux-x64-gnu",
    version: "1.33.0",
    license: "MPL-2.0",
    resolved:
      "https://registry.npmjs.org/lightningcss-linux-x64-gnu/-/lightningcss-linux-x64-gnu-1.33.0.tgz",
    integrity:
      "sha512-ar+Ju7LmcN0Jo4FpL4hpFybwNG9/3A/Br5KW2n2jyODg3MEZXaDYADdemoNS+BDNfMgKvylJLj4S5tyRActuAg==",
  },
  {
    package: "lightningcss-linux-x64-musl",
    version: "1.33.0",
    license: "MPL-2.0",
    resolved:
      "https://registry.npmjs.org/lightningcss-linux-x64-musl/-/lightningcss-linux-x64-musl-1.33.0.tgz",
    integrity:
      "sha512-RYiYbkokw0trfKqqzfF55lginwEPrD3OJDfTuJzFs1MK6iFnDenaz1fqLLtX4ITG3OktJQXOeTaw1awrBAlZPw==",
  },
];

const LAMBDA_ROOT_PACKAGE_ID =
  "SPDXRef-DocumentRoot-Directory-archon-memory-lambda-zip-content";
const LAMBDA_UUID = "6d1f0b2c-9a34-4e77-b1c5-2f8a7e0d4c93";
const CREATED_AT = "2026-08-04T09:41:17Z";

function actionlintSites() {
  const sites = [];
  ACTIONLINT_PATHS.forEach((filepath, pathIndex) => {
    for (let index = 0; index < ACTIONLINT_COUNTS[pathIndex]; index += 1) {
      const line = 40 + pathIndex * 100 + index * 7;
      sites.push({
        filepath,
        line,
        column: 3,
        endColumn: 8,
        snippet: "  queue: singleton",
      });
    }
  });
  return sites;
}

function actionlintFindings() {
  return actionlintSites().map((site) => ({
    kind: "syntax-check",
    message: ACTIONLINT_DIAGNOSTIC,
    filepath: site.filepath,
    line: site.line,
    column: site.column,
    end_column: site.endColumn,
    snippet: site.snippet,
  }));
}

function actionlintAnchors() {
  // Ten anchors whose counts sum to the fourteen raw diagnostics.
  const counts = [2, 2, 1, 1, 1, 2, 1, 2, 1, 1];
  return counts.map((count, index) => ({
    path: ACTIONLINT_PATHS[index % ACTIONLINT_PATHS.length],
    anchor: `concurrency-${index + 1}`,
    count,
  }));
}

function iacStatus() {
  return {
    schema: "archon.trivy-iac.compatibility",
    version: 2,
    mode: "blocking-exact-source-validated-parser-compatibilities",
    scanner: "Trivy",
    scannerVersion: TRIVY_VERSION,
    versionEvidence: {
      toolLock: TRIVY_VERSION,
      capturedCli: TRIVY_VERSION,
      sarifDriver: TRIVY_VERSION,
    },
    thresholdSeverities: ["MEDIUM", "HIGH", "CRITICAL"],
    rawFindings: 4,
    compatibilityFindings: 4,
    blockingFindings: 0,
    acceptedWaivers: 0,
    effectiveExitCode: 0,
    sourceEvidence: {
      applicationTemplate: TEMPLATE_TARGET,
      foundationTemplate: BOOTSTRAP_TARGET,
    },
    compatibilities: IAC_CONTRACTS.map((contract) => ({
      ruleId: contract.ruleId,
      target: contract.target,
      logicalResource: contract.logicalResource,
      namespace: contract.namespace,
      findingType: "CloudFormation Security Check",
      legacyAlias: null,
      severity: "HIGH",
      status: "FAIL",
      scannerResource: scannerResource(contract),
      sourceRange: { startLine: contract.startLine, endLine: contract.endLine },
    })),
  };
}

function iacReport() {
  const byTarget = new Map();
  for (const contract of IAC_CONTRACTS) {
    if (!byTarget.has(contract.target)) {
      byTarget.set(contract.target, []);
    }
    byTarget.get(contract.target).push({
      Type: "CloudFormation Security Check",
      ID: contract.ruleId,
      Severity: "HIGH",
      Status: "FAIL",
      CauseMetadata: {
        Resource: causeResource(contract),
        StartLine: contract.startLine,
        EndLine: contract.endLine,
      },
    });
  }
  // A real report also carries PASS entries; keeping one proves the
  // Status == "FAIL" filter is doing work rather than the counts lining up by
  // accident.
  byTarget.get(TEMPLATE_TARGET).push({
    Type: "CloudFormation Security Check",
    ID: "AWS-0089",
    Severity: "LOW",
    Status: "PASS",
    CauseMetadata: { Resource: `${TEMPLATE_TARGET}:12-18`, StartLine: 12, EndLine: 18 },
  });
  return {
    SchemaVersion: 2,
    ArtifactName: ".",
    ArtifactType: "filesystem",
    Results: [...byTarget.entries()].map(([target, misconfigurations]) => ({
      Target: target,
      Class: "config",
      Type: "cloudformation",
      Misconfigurations: misconfigurations,
    })),
  };
}

function iacSarif() {
  return {
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "Trivy",
            version: TRIVY_VERSION,
            rules: ["AWS-0011", "AWS-0013", "AWS-0132"].map((id) => ({
              id,
              name: "Misconfiguration",
            })),
          },
        },
        results: IAC_CONTRACTS.map((contract) => ({
          ruleId: contract.ruleId,
          level: "error",
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: contract.target },
                region: {
                  startLine: contract.startLine,
                  endLine: contract.endLine,
                  startColumn: 1,
                  endColumn: 1,
                },
              },
            },
          ],
        })),
      },
    ],
  };
}

function iacCompatibilityFindings() {
  return IAC_CONTRACTS.map((contract) => ({
    ruleId: contract.ruleId,
    namespace: contract.namespace,
    target: contract.target,
    logicalResource: contract.logicalResource,
    findingType: "CloudFormation Security Check",
    legacyAlias: null,
    severity: "HIGH",
    status: "FAIL",
    scannerResource: scannerResource(contract),
    startLine: contract.startLine,
    endLine: contract.endLine,
  }));
}

function templateStatus() {
  return {
    mode: "blocking",
    applicationExitCode: 0,
    foundationExitCode: 0,
    edgeWafControlPlaneExitCode: 0,
    finopsControlPlaneExitCode: 0,
    templates: [
      "aws/template.yaml",
      "aws/bootstrap-oidc.yaml",
      "aws/edge-waf.yaml",
      "aws/finops.yaml",
    ],
  };
}

function sbomStatus() {
  return {
    schema: "archon.trivy-sbom.compatibility",
    version: 1,
    mode: "blocking-exact-build-license-compatibility",
    scanner: "Trivy",
    scannerVersion: TRIVY_VERSION,
    inventoryScanner: "Syft",
    inventoryScannerVersion: "1.50.0",
    versionEvidence: {
      trivyToolLock: TRIVY_VERSION,
      trivyCapturedCli: TRIVY_VERSION,
      syftToolLock: "1.50.0",
    },
    scanners: ["vuln", "license"],
    severities: ["UNKNOWN", "MEDIUM", "HIGH", "CRITICAL"],
    rawExitCodes: { backend: 0, frontend: 1, lambdaContent: 0 },
    reportResultsEncoding: {
      backend: "array",
      frontend: "array",
      lambdaContent: "omitted-root-only",
    },
    lambdaInventory: {
      contract: "exact-root-only",
      spdxVersion: "SPDX-2.3",
      sourceName: "archon-memory-lambda-zip-content",
      rootPackageId: LAMBDA_ROOT_PACKAGE_ID,
      totalPackages: 1,
      catalogedDependencyPackages: 0,
      relationships: 1,
    },
    rawFindings: 4,
    vulnerabilityFindings: 0,
    licenseFindings: 4,
    approvedBuildLicenseFindings: 4,
    blockingFindings: 0,
    acceptedWaivers: 0,
    effectiveExitCode: 0,
    sourceExclusions: [
      "./node_modules/resolve/test/resolver/baz/**",
      "./node_modules/resolve/test/resolver/browser_field/**",
      "./node_modules/resolve/test/resolver/false_main/**",
      "./node_modules/resolve/test/resolver/invalid_main/**",
    ],
    approvedBuildLicenses: BUILD_LICENSES.map((entry) => ({
      package: entry.package,
      version: entry.version,
      license: entry.license,
      resolved: entry.resolved,
      integrity: entry.integrity,
      dev: true,
    })),
  };
}

function sbomPolicyReport(scope) {
  return {
    SchemaVersion: 2,
    Trivy: { Version: TRIVY_VERSION },
    ArtifactName: `supply-chain-reports/sbom/${scope}.spdx.json`,
    ArtifactType: "spdx",
    CreatedAt: CREATED_AT,
    Results: [],
  };
}

function lambdaPolicyReport() {
  return {
    SchemaVersion: 2,
    Trivy: { Version: TRIVY_VERSION },
    ArtifactName: "supply-chain-reports/sbom/lambda-content.spdx.json",
    ArtifactType: "spdx",
    CreatedAt: CREATED_AT,
    ReportID: LAMBDA_UUID,
  };
}

function lambdaSpdx() {
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: "archon-memory-lambda-zip-content",
    documentNamespace: `https://anchore.com/syft/dir/archon-memory-lambda-zip-content-${LAMBDA_UUID}`,
    creationInfo: {
      created: CREATED_AT,
      creators: ["Organization: Anchore, Inc", "Tool: syft-1.50.0"],
      licenseListVersion: "3.28",
    },
    packages: [
      {
        name: "archon-memory-lambda-zip-content",
        SPDXID: LAMBDA_ROOT_PACKAGE_ID,
        supplier: "NOASSERTION",
        downloadLocation: "NOASSERTION",
        filesAnalyzed: false,
        licenseConcluded: "NOASSERTION",
        licenseDeclared: "NOASSERTION",
        copyrightText: "NOASSERTION",
        primaryPackagePurpose: "FILE",
      },
    ],
    relationships: [
      {
        spdxElementId: "SPDXRef-DOCUMENT",
        relatedSpdxElement: LAMBDA_ROOT_PACKAGE_ID,
        relationshipType: "DESCRIBES",
      },
    ],
  };
}

function sbomCompatibilityFindings() {
  return BUILD_LICENSES.map((entry) => ({
    scope: "frontend",
    kind: "build-license",
    cataloger: "javascript-package-cataloger",
    package: entry.package,
    version: entry.version,
    license: entry.license,
    resolved: entry.resolved,
    integrity: entry.integrity,
    dev: true,
  }));
}

// A complete, well-formed evidence set. Every mutation below starts from a
// fresh copy of this.
function fixtureEvidence() {
  return {
    env: {
      GITHUB_EVENT_NAME: "push",
      GITHUB_REF: "refs/heads/main",
      GITHUB_RUN_ID: RUN_ID,
      GITHUB_RUN_ATTEMPT: RUN_ATTEMPT,
      SOURCE_SHA,
    },
    receiptInputsInsideEvidence: false,
    symlink: false,
    files: {
      "static/shellcheck-status.json": {
        mode: "blocking",
        exitCode: 0,
        trackedFiles: 9,
      },
      "static/actionlint.raw.json": actionlintFindings(),
      "static/actionlint-all.json": actionlintFindings(),
      "static/actionlint-blocking-findings.json": [],
      "static/actionlint-queue-compatibility.json": actionlintFindings(),
      "static/actionlint-status.json": {
        mode: "blocking-exact-parser-compatibility",
        effectiveExitCode: 0,
        rawExitCode: 1,
        rawFindings: 14,
        blockingFindings: 0,
        compatibility: {
          analyzer: "actionlint",
          version: "1.7.12",
          feature: "concurrency.queue",
          diagnostic: ACTIONLINT_DIAGNOSTIC,
          acceptedDiagnostics: 14,
          expectedPaths: ACTIONLINT_PATHS,
          expectedDiagnostics: actionlintSites(),
          sourceAnchors: actionlintAnchors(),
        },
      },
      "static/zizmor-status.json": {
        mode: "blocking",
        jsonExitCode: 0,
        sarifExitCode: 0,
      },
      "static/waiver-ledger.sha256": WAIVER_LEDGER_LINE,
      "iac/cfn-lint-status.json": templateStatus(),
      "iac/cfn-lint-finops.json": { mode: "blocking", findings: [] },
      "iac/guard-current-status.json": templateStatus(),
      "iac/guard-edge-waf.txt": "PASS aws/edge-waf.yaml\n",
      "iac/guard-finops.txt": "PASS aws/finops.yaml\n",
      "iac/trivy-iac-status.json": iacStatus(),
      "iac/trivy-iac.json": iacReport(),
      "iac/trivy-iac.sarif": iacSarif(),
      "iac/trivy-iac-compatibility-findings.json": iacCompatibilityFindings(),
      "iac/trivy-iac-blocking-findings.json": [],
      "iac/trivy-version.txt": TRIVY_VERSION_OUTPUT,
      "sbom/provenance.json": {
        schemaVersion: 1,
        sourceSha: SOURCE_SHA,
        runId: RUN_ID,
        runAttempt: RUN_ATTEMPT,
        enforcement: "blocking",
        canonicalArtifact: "SAM ArchonFunction Lambda ZIP content",
        containerPath: "retired-non-release",
      },
      "sbom/trivy-sbom-status.json": sbomStatus(),
      "sbom/trivy-backend-policy.json": sbomPolicyReport("backend"),
      "sbom/trivy-frontend-policy.json": sbomPolicyReport("frontend"),
      "sbom/trivy-lambda-content-policy.json": lambdaPolicyReport(),
      "sbom/lambda-content.spdx.json": lambdaSpdx(),
      "sbom/trivy-sbom-compatibility-findings.json": sbomCompatibilityFindings(),
      "sbom/trivy-sbom-blocking-findings.json": [],
      "sbom/trivy-version.txt": TRIVY_VERSION_OUTPUT,
      "sbom/waiver-ledger.sha256": WAIVER_LEDGER_LINE,
      "sbom/lambda-zip-content.sha256": `${"c".repeat(64)}  handler.js\n`,
      "sbom/sbom-inputs-and-documents.sha256": `${"d".repeat(64)}  backend.spdx.json\n`,
      "sbom/backend.spdx.json": { spdxVersion: "SPDX-2.3", name: "backend" },
      "sbom/backend.syft.json": { schema: { version: "16.0.36" } },
      "sbom/frontend.spdx.json": { spdxVersion: "SPDX-2.3", name: "frontend" },
      "sbom/frontend.syft.json": { schema: { version: "16.0.36" } },
    },
  };
}

function serialise(value) {
  return typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
}

function materialise(candidate) {
  const root = mkdtempSync(join(tmpdir(), "archon-release-evidence-"));
  const evidenceRoot = join(root, "evidence");
  for (const [relative, value] of Object.entries(candidate.files)) {
    const target = join(evidenceRoot, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, serialise(value), { encoding: "utf8", mode: 0o600 });
  }
  // The three scope directories must exist even when a fixture removes every
  // file inside one of them.
  for (const scope of ["static", "iac", "sbom"]) {
    mkdirSync(join(evidenceRoot, scope), { recursive: true });
  }
  if (candidate.symlink) {
    symlinkSync(
      join(evidenceRoot, "sbom", "provenance.json"),
      join(evidenceRoot, "sbom", "provenance-link.json")
    );
  }
  const receiptInputsDir = candidate.receiptInputsInsideEvidence
    ? join(evidenceRoot, "receipt-inputs")
    : join(root, "receipt-inputs");
  mkdirSync(receiptInputsDir, { recursive: true });
  return { root, evidenceRoot, receiptInputsDir };
}

function posix(path) {
  return path.replace(/\\/g, "/");
}

function runContract(candidate, { keep = false } = {}) {
  const { root, evidenceRoot, receiptInputsDir } = materialise(candidate);
  let cleanup = !keep;
  try {
    const result = spawnSync("bash", [posix(CONTRACT)], {
      encoding: "utf8",
      env: {
        ...process.env,
        ...candidate.env,
        EVIDENCE_ROOT: posix(evidenceRoot),
        RECEIPT_INPUTS_DIR: posix(receiptInputsDir),
      },
    });
    if (result.error) {
      throw result.error;
    }
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      root,
      receiptInputsDir,
    };
  } catch (error) {
    cleanup = true;
    throw error;
  } finally {
    if (cleanup) {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

function requireJq() {
  // Probe through bash, because bash is what has to resolve jq when the
  // contract runs, and resolution rules differ between the two.
  const probe = spawnSync("bash", ["-c", "command -v jq >/dev/null && jq --version"], {
    encoding: "utf8",
  });
  if (probe.error || probe.status !== 0) {
    process.stderr.write(
      "release-evidence-selftest: jq is required to evaluate the release " +
        "evidence contract and was not found on PATH. Refusing to report a " +
        "pass without executing the assertions.\n"
    );
    process.exit(2);
  }
}

// One mutation per assertion the contract makes. Each must be rejected; a
// mutation that survives means the assertion it targets is not load-bearing.
function mutations() {
  const cases = [];
  const add = (name, apply) => cases.push({ name, apply });

  add("event name is not a push", (candidate) => {
    candidate.env.GITHUB_EVENT_NAME = "pull_request";
  });
  add("ref is not refs/heads/main", (candidate) => {
    candidate.env.GITHUB_REF = "refs/heads/feature";
  });
  add("source sha is not a full commit sha", (candidate) => {
    candidate.env.SOURCE_SHA = "0f3c1d9";
  });
  add("run id is not a positive integer", (candidate) => {
    candidate.env.GITHUB_RUN_ID = "0";
  });
  add("run attempt is not a positive integer", (candidate) => {
    candidate.env.GITHUB_RUN_ATTEMPT = "abc";
  });
  add("receipt inputs would land inside the hashed evidence tree", (candidate) => {
    candidate.receiptInputsInsideEvidence = true;
  });
  add("a required evidence file is missing", (candidate) => {
    delete candidate.files["iac/guard-finops.txt"];
  });
  add("a required evidence file is empty", (candidate) => {
    candidate.files["sbom/backend.syft.json"] = "";
  });
  add("the evidence tree contains a symlink", (candidate) => {
    candidate.symlink = true;
  });

  add("provenance is bound to a different source sha", (candidate) => {
    candidate.files["sbom/provenance.json"].sourceSha =
      "1111111111111111111111111111111111111111";
  });
  add("provenance enforcement is not blocking", (candidate) => {
    candidate.files["sbom/provenance.json"].enforcement = "advisory";
  });
  add("shellcheck did not exit clean", (candidate) => {
    candidate.files["static/shellcheck-status.json"].exitCode = 1;
  });
  add("actionlint raw diagnostic count drifted", (candidate) => {
    candidate.files["static/actionlint-status.json"].rawFindings = 13;
  });
  add("actionlint compatibility no longer covers every expected path", (candidate) => {
    const status = candidate.files["static/actionlint-status.json"];
    status.compatibility.expectedDiagnostics =
      status.compatibility.expectedDiagnostics.filter(
        (site) => site.filepath !== ".github/workflows/recover-aws.yml"
      );
  });
  add("actionlint source anchors no longer sum to the raw diagnostics", (candidate) => {
    candidate.files["static/actionlint-status.json"].compatibility.sourceAnchors[0].count = 5;
  });
  add("a raw actionlint diagnostic moved off its pinned site", (candidate) => {
    candidate.files["static/actionlint.raw.json"][0].line += 1;
  });
  add("the actionlint queue-compatibility set lost an entry", (candidate) => {
    candidate.files["static/actionlint-queue-compatibility.json"].pop();
  });
  add("the full actionlint finding set changed size", (candidate) => {
    candidate.files["static/actionlint-all.json"].pop();
  });
  add("actionlint reported a blocking finding", (candidate) => {
    candidate.files["static/actionlint-blocking-findings.json"].push({
      kind: "syntax-check",
      message: "something else",
    });
  });
  add("zizmor did not exit clean", (candidate) => {
    candidate.files["static/zizmor-status.json"].sarifExitCode = 1;
  });
  add("cfn-lint did not cover every current template", (candidate) => {
    candidate.files["iac/cfn-lint-status.json"].templates.pop();
  });
  add("CloudFormation Guard did not exit clean", (candidate) => {
    candidate.files["iac/guard-current-status.json"].applicationExitCode = 1;
  });

  add("the published Trivy status changed its raw finding count", (candidate) => {
    candidate.files["iac/trivy-iac-status.json"].rawFindings = 5;
  });
  add("a published scanner resource disagrees with its source range", (candidate) => {
    candidate.files["iac/trivy-iac-status.json"].compatibilities[1].scannerResource =
      "aws/template.yaml:458-545";
  });
  add("the published compatibility rule order changed", (candidate) => {
    const status = candidate.files["iac/trivy-iac-status.json"];
    const first = status.compatibilities[0];
    status.compatibilities[0] = status.compatibilities[1];
    status.compatibilities[1] = first;
  });

  // The shape that actually broke, pinned in both directions.
  add("AWS-0011 reverted to the source-range cause metadata shape", (candidate) => {
    const finding = rawFinding(candidate, "AWS-0011", TEMPLATE_TARGET);
    finding.CauseMetadata.Resource = scannerResource(IAC_CONTRACTS[0]);
  });
  add("AWS-0013 switched to the logical-resource cause metadata shape", (candidate) => {
    const finding = rawFinding(candidate, "AWS-0013", TEMPLATE_TARGET);
    finding.CauseMetadata.Resource = "Distribution";
  });
  add("AWS-0011 names a logical resource it is not raised against", (candidate) => {
    const finding = rawFinding(candidate, "AWS-0011", TEMPLATE_TARGET);
    finding.CauseMetadata.Resource = "SpaBucket";
  });
  add("raw cause metadata lines disagree with the published source range", (candidate) => {
    const finding = rawFinding(candidate, "AWS-0011", TEMPLATE_TARGET);
    finding.CauseMetadata.EndLine += 3;
  });
  add("a fifth raw Trivy finding appeared", (candidate) => {
    candidate.files["iac/trivy-iac.json"].Results[0].Misconfigurations.push({
      Type: "CloudFormation Security Check",
      ID: "AWS-9999",
      Severity: "HIGH",
      Status: "FAIL",
      CauseMetadata: {
        Resource: `${TEMPLATE_TARGET}:10-20`,
        StartLine: 10,
        EndLine: 20,
      },
    });
  });
  add("a raw Trivy finding changed severity", (candidate) => {
    rawFinding(candidate, "AWS-0013", TEMPLATE_TARGET).Severity = "MEDIUM";
  });
  add("a raw Trivy finding carries a legacy AVD alias", (candidate) => {
    rawFinding(candidate, "AWS-0011", TEMPLATE_TARGET).AVDID = "AVD-AWS-0011";
  });
  add("a raw Trivy finding changed type", (candidate) => {
    rawFinding(candidate, "AWS-0132", BOOTSTRAP_TARGET).Type = "Dockerfile Security Check";
  });

  add("a compatibility finding changed policy namespace", (candidate) => {
    candidate.files["iac/trivy-iac-compatibility-findings.json"][0].namespace =
      "builtin.aws.cloudfront.aws0099";
  });
  add("a compatibility finding line range contradicts its scanner resource", (candidate) => {
    candidate.files["iac/trivy-iac-compatibility-findings.json"][2].endLine += 1;
  });
  add("a SARIF region drifted from the published source range", (candidate) => {
    candidate.files["iac/trivy-iac.sarif"].runs[0].results[3].locations[0]
      .physicalLocation.region.endLine -= 1;
  });
  add("the SARIF driver advertises an unexpected rule set", (candidate) => {
    candidate.files["iac/trivy-iac.sarif"].runs[0].tool.driver.rules.push({
      id: "AWS-0099",
      name: "Misconfiguration",
    });
  });
  add("the IaC Trivy version drifted", (candidate) => {
    candidate.files["iac/trivy-version.txt"] = "Version: 0.72.1\n";
  });
  add("Trivy reported a blocking IaC finding", (candidate) => {
    candidate.files["iac/trivy-iac-blocking-findings.json"].push({ ruleId: "AWS-0001" });
  });

  add("an approved build license integrity hash changed", (candidate) => {
    candidate.files["sbom/trivy-sbom-status.json"].approvedBuildLicenses[0].integrity =
      "sha512-0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000==";
  });
  add("the SBOM status reported a vulnerability finding", (candidate) => {
    candidate.files["sbom/trivy-sbom-status.json"].vulnerabilityFindings = 1;
  });
  add("a scoped SBOM policy report names the wrong artifact", (candidate) => {
    candidate.files["sbom/trivy-frontend-policy.json"].ArtifactName =
      "supply-chain-reports/sbom/backend.spdx.json";
  });
  add("the lambda policy report gained a results block", (candidate) => {
    candidate.files["sbom/trivy-lambda-content-policy.json"].Results = [];
  });
  add("the lambda SPDX inventory gained a cataloged package", (candidate) => {
    candidate.files["sbom/lambda-content.spdx.json"].packages.push({
      name: "left-pad",
      SPDXID: "SPDXRef-Package-left-pad",
    });
  });
  add("the lambda SPDX document namespace is not a Syft directory namespace", (candidate) => {
    candidate.files["sbom/lambda-content.spdx.json"].documentNamespace =
      "https://example.com/syft/dir/archon-memory-lambda-zip-content";
  });
  add("a build-license compatibility finding is no longer build-only", (candidate) => {
    candidate.files["sbom/trivy-sbom-compatibility-findings.json"][1].dev = false;
  });
  add("Trivy reported a blocking SBOM finding", (candidate) => {
    candidate.files["sbom/trivy-sbom-blocking-findings.json"].push({ package: "left-pad" });
  });
  add("the SBOM Trivy version drifted", (candidate) => {
    candidate.files["sbom/trivy-version.txt"] = "Version: 0.72.1\n";
  });
  add("the two waiver ledger digests disagree", (candidate) => {
    candidate.files["sbom/waiver-ledger.sha256"] = `${"e".repeat(64)}  security/waivers.yml\n`;
  });
  add("the waiver ledger digest is not a sha256", (candidate) => {
    const line = "not-a-digest  security/waivers.yml\n";
    candidate.files["static/waiver-ledger.sha256"] = line;
    candidate.files["sbom/waiver-ledger.sha256"] = line;
  });

  return cases;
}

function rawFinding(candidate, ruleId, target) {
  const result = candidate.files["iac/trivy-iac.json"].Results.find(
    (entry) => entry.Target === target
  );
  const finding = result.Misconfigurations.find(
    (entry) => entry.ID === ruleId && entry.Status === "FAIL"
  );
  assert.ok(finding, `fixture has no FAIL ${ruleId} for ${target}`);
  return finding;
}

function runSelfTest() {
  requireJq();

  const base = fixtureEvidence();
  const accepted = runContract(base, { keep: true });
  if (accepted.status !== 0) {
    rmSync(accepted.root, { recursive: true, force: true });
    process.stderr.write(
      "release-evidence-selftest: the well-formed evidence set was REJECTED.\n" +
        "This means the contract and the fixtures disagree; one of them is wrong.\n" +
        `--- contract stderr ---\n${accepted.stderr}\n` +
        `--- contract stdout ---\n${accepted.stdout}\n`
    );
    process.exit(1);
  }

  // The receipt is built from these two derived values, so they are part of the
  // contract, not incidental output.
  const scannerResources = JSON.parse(
    readFileSync(join(accepted.receiptInputsDir, "trivy-scanner-resources.json"), "utf8")
  );
  assert.deepEqual(
    scannerResources,
    IAC_CONTRACTS.map((contract) => ({
      ruleId: contract.ruleId,
      target: contract.target,
      logicalResource: contract.logicalResource,
      scannerResource: scannerResource(contract),
    }))
  );
  const waiverDigest = readFileSync(
    join(accepted.receiptInputsDir, "waiver-ledger-sha256.txt"),
    "utf8"
  ).trim();
  assert.equal(waiverDigest, WAIVER_LEDGER_SHA256);
  rmSync(accepted.root, { recursive: true, force: true });

  const cases = mutations();
  const survivors = [];
  let skipped = 0;
  for (const mutation of cases) {
    const candidate = fixtureEvidence();
    mutation.apply(candidate);
    let result;
    try {
      result = runContract(candidate);
    } catch (error) {
      if (candidate.symlink && isSymlinkPermissionError(error)) {
        skipped += 1;
        process.stderr.write(
          `release-evidence-selftest: SKIPPED "${mutation.name}" ` +
            "(this platform does not permit creating symlinks).\n"
        );
        continue;
      }
      throw error;
    }
    if (result.status === 0) {
      survivors.push(mutation.name);
    }
  }

  if (survivors.length > 0) {
    process.stderr.write(
      "release-evidence-selftest: the contract ACCEPTED mutated evidence.\n" +
        "Each line below is an assertion that is no longer load-bearing:\n" +
        survivors.map((name) => `  - ${name}\n`).join("")
    );
    process.exit(1);
  }

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      cases: 1 + cases.length - skipped,
      mutations: cases.length - skipped,
      skipped,
      policy: "fail-closed",
    })}\n`
  );
}

function isSymlinkPermissionError(error) {
  return (
    error && (error.code === "EPERM" || error.code === "EACCES" || error.code === "ENOSYS")
  );
}

if (process.argv.length === 3 && process.argv[2] === "--self-test") {
  runSelfTest();
} else {
  process.stderr.write(
    "usage: node .github/scripts/release-evidence-selftest.mjs --self-test\n"
  );
  process.exit(2);
}
