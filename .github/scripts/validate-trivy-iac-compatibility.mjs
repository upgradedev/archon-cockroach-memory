#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

const EXPECTED_SCANNER = "Trivy";
const EXPECTED_SCANNER_VERSION = "0.72.0";
const EXPECTED_RULE_ID = "AWS-0013";
const EXPECTED_LEGACY_ALIAS = null;
const EXPECTED_TARGET = "aws/template.yaml";
const EXPECTED_RESOURCE = "Distribution";
const EXPECTED_SEVERITY = "HIGH";
const EXPECTED_NAMESPACE = "builtin.aws.cloudfront.aws0013";
const EXPECTED_PRIMARY_URL =
  "https://avd.aquasec.com/misconfig/aws-0013";
const EXPECTED_REASON =
  "CloudFrontDefaultCertificate cannot declare MinimumProtocolVersion; the generated cloudfront.net demo hostname is retained while every viewer, API, and custom-origin path enforces HTTPS.";

function invariant(condition, message) {
  if (!condition) {
    throw new Error(`Trivy IaC compatibility validation failed: ${message}`);
  }
}

function parseJson(label, source) {
  try {
    return JSON.parse(source);
  } catch {
    throw new Error(
      `Trivy IaC compatibility validation failed: ${label} is not valid JSON`
    );
  }
}

function normalizeSource(source) {
  return source.replaceAll("\r\n", "\n");
}

function extractSingleTwoSpaceBlock(source, name) {
  const lines = normalizeSource(source).split("\n");
  const marker = `  ${name}:`;
  const starts = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] === marker) {
      starts.push(index);
    }
  }
  invariant(starts.length === 1, `${name} must occur exactly once`);
  const start = starts[0];
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (
      /^\S/u.test(lines[index]) ||
      /^  [A-Za-z0-9][A-Za-z0-9]*:$/u.test(lines[index])
    ) {
      end = index;
      break;
    }
  }
  let lastSourceLine = end;
  while (
    lastSourceLine > start + 1 &&
    lines[lastSourceLine - 1].trim() === ""
  ) {
    lastSourceLine -= 1;
  }
  return {
    source: lines.slice(start, lastSourceLine).join("\n"),
    startLine: start + 1,
    endLine: lastSourceLine,
  };
}

function count(source, pattern) {
  return source.match(pattern)?.length ?? 0;
}

function validateTemplateContract(templateSource) {
  const normalized = normalizeSource(templateSource);
  invariant(
    !/trivy(?:-|\s*:)ignore/iu.test(normalized),
    "inline Trivy ignores are prohibited"
  );

  const webAclParameter = extractSingleTwoSpaceBlock(
    normalized,
    "CloudFrontWebAclArn"
  ).source;
  invariant(
    /^\s{4}Type: String$/mu.test(webAclParameter),
    "CloudFrontWebAclArn must remain a String parameter"
  );
  invariant(
    !/^\s{4}Default:/mu.test(webAclParameter),
    "CloudFrontWebAclArn must remain mandatory without a default"
  );
  invariant(
    webAclParameter.includes(
      'AllowedPattern: "^arn:aws:wafv2:us-east-1:[0-9]{12}:global/webacl/[A-Za-z0-9_-]+/[0-9a-f-]+$"'
    ),
    "CloudFrontWebAclArn must remain constrained to a us-east-1 global WebACL ARN"
  );

  const distribution = extractSingleTwoSpaceBlock(
    normalized,
    EXPECTED_RESOURCE
  );
  const source = distribution.source;
  invariant(
    count(source, /^\s{4}Type: AWS::CloudFront::Distribution$/gmu) === 1,
    "Distribution must remain an AWS::CloudFront::Distribution"
  );
  invariant(
    count(
      source,
      /^\s{8}WebACLId: !Ref CloudFrontWebAclArn$/gmu
    ) === 1,
    "Distribution must bind the mandatory WebACL directly"
  );
  invariant(
    count(source, /^\s{8}Logging:$/gmu) === 1 &&
      /\n        Logging:\n          Bucket: !Sub >-\n            \$\{AppName\}-cloudfront-access-logs-\$\{AWS::AccountId\}-\$\{AWS::Region\}\.s3\.amazonaws\.com\n          IncludeCookies: false\n          Prefix: !Sub "\$\{Environment\}\/"/u.test(
        source
      ),
    "Distribution access logging must remain enabled with the deterministic archive destination"
  );
  invariant(
    count(source, /^\s{12}OriginCustomHeaders:$/gmu) === 1 &&
      count(
        source,
        /^\s{14}- HeaderName: x-archon-origin-verify$/gmu
      ) === 1 &&
      count(
        source,
        /\{\{resolve:secretsmanager:\$\{AppName\}\/\$\{Environment\}\/origin-verification:SecretString:ORIGIN_VERIFY_TOKEN\}\}/gu
      ) === 1,
    "the API origin must retain its dynamic Secrets Manager verification header"
  );
  invariant(
    count(
      source,
      /^\s{14}OriginProtocolPolicy: https-only$/gmu
    ) === 1 &&
      /\n              OriginSSLProtocols:\n                - TLSv1\.2/u.test(
        source
      ),
    "the API custom origin must remain HTTPS-only with TLS 1.2"
  );
  invariant(
    count(
      source,
      /^\s{10}ViewerProtocolPolicy: redirect-to-https$/gmu
    ) === 1,
    "the default viewer behavior must continue redirecting HTTP to HTTPS"
  );
  invariant(
    count(
      source,
      /^\s{12}ViewerProtocolPolicy: https-only$/gmu
    ) === 1 &&
      count(source, /^\s{10}- PathPattern: \/api\/\*$/gmu) === 1,
    "the API viewer behavior must remain HTTPS-only"
  );
  invariant(
    count(
      source,
      /^\s{10}CloudFrontDefaultCertificate: true$/gmu
    ) === 1,
    "the compatibility boundary requires exactly one CloudFront default certificate"
  );
  invariant(
    !/MinimumProtocolVersion:/u.test(source),
    "MinimumProtocolVersion cannot accompany CloudFrontDefaultCertificate"
  );
  invariant(
    !/^\s+Aliases:/mu.test(source),
    "the default-certificate compatibility boundary cannot include a custom domain"
  );

  return {
    distributionStartLine: distribution.startLine,
    distributionEndLine: distribution.endLine,
  };
}

function flattenMisconfigurations(report) {
  invariant(report && typeof report === "object", "Trivy report must be an object");
  invariant(report.SchemaVersion === 2, "Trivy JSON SchemaVersion must be 2");
  if (report.Trivy !== undefined) {
    invariant(
      report.Trivy?.Version === EXPECTED_SCANNER_VERSION,
      `optional Trivy JSON metadata must identify version ${EXPECTED_SCANNER_VERSION}`
    );
  }
  invariant(Array.isArray(report.Results), "Trivy Results must be an array");

  const findings = [];
  for (const result of report.Results) {
    invariant(
      result && typeof result === "object",
      "each Trivy result must be an object"
    );
    if (result.Misconfigurations === undefined) {
      continue;
    }
    invariant(
      Array.isArray(result.Misconfigurations),
      "Misconfigurations must be an array"
    );
    for (const finding of result.Misconfigurations) {
      findings.push({ result, finding });
    }
  }
  return findings;
}

function validateJsonFinding(report, templateContract) {
  const findings = flattenMisconfigurations(report);
  invariant(findings.length === 1, "raw Trivy JSON must contain exactly one finding");

  const { result, finding } = findings[0];
  invariant(result.Target === EXPECTED_TARGET, "finding target must be aws/template.yaml");
  invariant(result.Class === "config", "finding class must be config");
  invariant(result.Type === "cloudformation", "finding type must be cloudformation");
  invariant(finding?.ID === EXPECTED_RULE_ID, "finding ID must be AWS-0013");
  invariant(
    (finding.AVDID ?? null) === EXPECTED_LEGACY_ALIAS,
    "Trivy 0.72.0 AWS-0013 must not report a legacy AVDID alias"
  );
  invariant(finding.Severity === EXPECTED_SEVERITY, "finding severity must be HIGH");
  invariant(finding.Status === "FAIL", "finding status must be FAIL");
  invariant(
    finding.Namespace === EXPECTED_NAMESPACE,
    "finding namespace must be the built-in AWS-0013 rule"
  );
  invariant(
    finding.Title ===
      "CloudFront distribution uses outdated SSL/TLS protocols.",
    "finding title does not match AWS-0013"
  );
  invariant(
    Number.isInteger(finding.CauseMetadata?.StartLine) &&
      Number.isInteger(finding.CauseMetadata?.EndLine) &&
      finding.CauseMetadata.StartLine ===
        templateContract.distributionStartLine &&
      finding.CauseMetadata.EndLine ===
        templateContract.distributionEndLine,
    "finding location must equal the complete Distribution source block"
  );
  const expectedScannerResource =
    `${EXPECTED_TARGET}:${finding.CauseMetadata.StartLine}-` +
    `${finding.CauseMetadata.EndLine}`;
  invariant(
    finding.CauseMetadata.Resource === expectedScannerResource,
    "finding scanner resource must be the exact aws/template.yaml source range"
  );
  invariant(
    finding.PrimaryURL === EXPECTED_PRIMARY_URL,
    "finding reference must resolve to the canonical AWS-0013 record"
  );
  return { result, finding };
}

function validateSarif(sarif, templateContract) {
  invariant(sarif?.version === "2.1.0", "SARIF version must be 2.1.0");
  invariant(Array.isArray(sarif.runs) && sarif.runs.length === 1, "SARIF must contain one run");
  const run = sarif.runs[0];
  invariant(run.tool?.driver?.name === EXPECTED_SCANNER, "SARIF driver must be Trivy");
  invariant(
    run.tool.driver.version === EXPECTED_SCANNER_VERSION,
    `SARIF driver version must be ${EXPECTED_SCANNER_VERSION}`
  );
  invariant(
    Array.isArray(run.results) && run.results.length === 1,
    "SARIF must retain exactly one raw result"
  );
  const result = run.results[0];
  invariant(result.ruleId === EXPECTED_RULE_ID, "SARIF ruleId must be AWS-0013");
  invariant(result.level === "error", "HIGH AWS-0013 must remain a SARIF error");
  invariant(
    Array.isArray(result.locations) && result.locations.length === 1,
    "SARIF result must have exactly one location"
  );
  const location = result.locations[0].physicalLocation;
  invariant(
    location?.artifactLocation?.uri === EXPECTED_TARGET,
    "SARIF location must be aws/template.yaml"
  );
  invariant(
    Number.isInteger(location.region?.startLine) &&
      Number.isInteger(location.region?.endLine) &&
      location.region.startLine === templateContract.distributionStartLine &&
      location.region.endLine === templateContract.distributionEndLine,
    "SARIF location must equal the complete Distribution source block"
  );
  invariant(
    location.region.startColumn === 1 && location.region.endColumn === 1,
    "SARIF location columns must retain Trivy 0.72.0's complete-block coordinates"
  );
  const rules = run.tool.driver.rules;
  invariant(Array.isArray(rules), "SARIF driver rules must be an array");
  invariant(
    rules.filter((rule) => rule?.id === EXPECTED_RULE_ID).length === 1,
    "SARIF must contain exactly one AWS-0013 rule descriptor"
  );
}

function validateToolLock(toolLock) {
  invariant(toolLock?.schemaVersion === 1, "tool lock schemaVersion must be 1");
  invariant(
    toolLock.tools?.trivy?.version === EXPECTED_SCANNER_VERSION,
    `tool lock must pin Trivy ${EXPECTED_SCANNER_VERSION}`
  );
  invariant(
    /^[0-9a-f]{64}$/u.test(toolLock.tools.trivy.sha256),
    "tool lock must retain the Trivy archive digest"
  );
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

function evaluate({
  report,
  sarif,
  templateSource,
  toolLock,
  versionOutput,
}) {
  validateToolLock(toolLock);
  validateVersionOutput(versionOutput);
  const templateContract = validateTemplateContract(templateSource);
  const { finding } = validateJsonFinding(report, templateContract);
  validateSarif(sarif, templateContract);

  const compatibilityFinding = {
    ruleId: EXPECTED_RULE_ID,
    legacyAlias: EXPECTED_LEGACY_ALIAS,
    severity: EXPECTED_SEVERITY,
    status: "FAIL",
    target: EXPECTED_TARGET,
    logicalResource: EXPECTED_RESOURCE,
    scannerResource: finding.CauseMetadata.Resource,
    namespace: EXPECTED_NAMESPACE,
    startLine: finding.CauseMetadata.StartLine,
    endLine: finding.CauseMetadata.EndLine,
    reason: EXPECTED_REASON,
  };
  return {
    compatibilityFindings: [compatibilityFinding],
    blockingFindings: [],
    status: {
      schema: "archon.trivy-iac.compatibility",
      version: 1,
      mode: "blocking-exact-cloudfront-default-certificate-compatibility",
      scanner: EXPECTED_SCANNER,
      scannerVersion: EXPECTED_SCANNER_VERSION,
      versionEvidence: {
        toolLock: EXPECTED_SCANNER_VERSION,
        capturedCli: EXPECTED_SCANNER_VERSION,
        sarifDriver: EXPECTED_SCANNER_VERSION,
      },
      thresholdSeverities: ["MEDIUM", "HIGH", "CRITICAL"],
      rawFindings: 1,
      compatibilityFindings: 1,
      blockingFindings: 0,
      acceptedWaivers: 0,
      effectiveExitCode: 0,
      compatibility: {
        ruleId: EXPECTED_RULE_ID,
        severity: EXPECTED_SEVERITY,
        target: EXPECTED_TARGET,
        logicalResource: EXPECTED_RESOURCE,
        scannerResource: finding.CauseMetadata.Resource,
        sourceRange: {
          startLine: finding.CauseMetadata.StartLine,
          endLine: finding.CauseMetadata.EndLine,
        },
        sourceProperty: "CloudFrontDefaultCertificate: true",
        reason: EXPECTED_REASON,
        controls: {
          defaultViewerHttpsRedirect: true,
          apiViewerHttpsOnly: true,
          customOriginHttpsOnly: true,
          mandatoryWebAcl: true,
          dynamicOriginSecret: true,
          accessLogging: true,
          customDomainAliases: false,
        },
      },
    },
  };
}

function fixtureTemplate() {
  return `Parameters:
  CloudFrontWebAclArn:
    Type: String
    AllowedPattern: "^arn:aws:wafv2:us-east-1:[0-9]{12}:global/webacl/[A-Za-z0-9_-]+/[0-9a-f-]+$"
Resources:
  Distribution:
    Type: AWS::CloudFront::Distribution
    Properties:
      DistributionConfig:
        WebACLId: !Ref CloudFrontWebAclArn
        Logging:
          Bucket: !Sub >-
            \${AppName}-cloudfront-access-logs-\${AWS::AccountId}-\${AWS::Region}.s3.amazonaws.com
          IncludeCookies: false
          Prefix: !Sub "\${Environment}/"
        Origins:
          - Id: ApiOrigin
            OriginCustomHeaders:
              - HeaderName: x-archon-origin-verify
                HeaderValue: !Sub >-
                  {{resolve:secretsmanager:\${AppName}/\${Environment}/origin-verification:SecretString:ORIGIN_VERIFY_TOKEN}}
            CustomOriginConfig:
              OriginProtocolPolicy: https-only
              OriginSSLProtocols:
                - TLSv1.2
        DefaultCacheBehavior:
          ViewerProtocolPolicy: redirect-to-https
        CacheBehaviors:
          - PathPattern: /api/*
            ViewerProtocolPolicy: https-only
        ViewerCertificate:
          CloudFrontDefaultCertificate: true

  OtherResource:
    Type: AWS::S3::Bucket
`;
}

function fixtureReport() {
  return {
    SchemaVersion: 2,
    Results: [
      {
        Target: EXPECTED_TARGET,
        Class: "config",
        Type: "cloudformation",
        Misconfigurations: [
          {
            Type: "AWS",
            ID: EXPECTED_RULE_ID,
            Title:
              "CloudFront distribution uses outdated SSL/TLS protocols.",
            Namespace: EXPECTED_NAMESPACE,
            Severity: EXPECTED_SEVERITY,
            PrimaryURL: EXPECTED_PRIMARY_URL,
            Status: "FAIL",
            CauseMetadata: {
              Resource: `${EXPECTED_TARGET}:6-32`,
              StartLine: 6,
              EndLine: 32,
            },
          },
        ],
      },
    ],
  };
}

function fixtureSarif() {
  return {
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: EXPECTED_SCANNER,
            version: EXPECTED_SCANNER_VERSION,
            rules: [{ id: EXPECTED_RULE_ID }],
          },
        },
        results: [
          {
            ruleId: EXPECTED_RULE_ID,
            level: "error",
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: EXPECTED_TARGET },
                  region: {
                    startLine: 6,
                    startColumn: 1,
                    endLine: 32,
                    endColumn: 1,
                  },
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

function fixtureToolLock() {
  return {
    schemaVersion: 1,
    tools: {
      trivy: {
        version: EXPECTED_SCANNER_VERSION,
        sha256: "a".repeat(64),
      },
    },
  };
}

function runSelfTest() {
  const base = {
    report: fixtureReport(),
    sarif: fixtureSarif(),
    templateSource: fixtureTemplate(),
    toolLock: fixtureToolLock(),
    versionOutput: `Version: ${EXPECTED_SCANNER_VERSION}\n`,
  };
  const result = evaluate(base);
  assert.equal(result.status.rawFindings, 1);
  assert.equal(result.status.compatibilityFindings, 1);
  assert.equal(result.status.blockingFindings, 0);

  const reportWithLegacyAlias = fixtureReport();
  reportWithLegacyAlias.Results[0].Misconfigurations[0].AVDID =
    "AVD-AWS-0013";
  const sarifWithDriftedRange = fixtureSarif();
  sarifWithDriftedRange.runs[0].results[0].locations[0]
    .physicalLocation.region.endLine = 31;

  const failures = [
    {
      ...base,
      report: {
        ...fixtureReport(),
        Results: [
          ...fixtureReport().Results,
          {
            Target: "aws/edge-waf.yaml",
            Class: "config",
            Type: "cloudformation",
            Misconfigurations: [
              {
                Type: "AWS",
                ID: "AWS-9999",
                Severity: "HIGH",
                Status: "FAIL",
              },
            ],
          },
        ],
      },
    },
    {
      ...base,
      templateSource: fixtureTemplate().replace(
        "        WebACLId: !Ref CloudFrontWebAclArn\n",
        ""
      ),
    },
    {
      ...base,
      templateSource: fixtureTemplate().replace(
        "        Logging:\n",
        "        # trivy:ignore:AWS-0013\n        Logging:\n"
      ),
    },
    {
      ...base,
      templateSource: fixtureTemplate().replace(
        "            ViewerProtocolPolicy: https-only",
        "            ViewerProtocolPolicy: allow-all"
      ),
    },
    {
      ...base,
      toolLock: {
        ...fixtureToolLock(),
        tools: {
          trivy: {
            version: "0.72.1",
            sha256: "a".repeat(64),
          },
        },
      },
    },
    {
      ...base,
      versionOutput: "Version: 0.72.1\n",
    },
    {
      ...base,
      report: reportWithLegacyAlias,
    },
    {
      ...base,
      sarif: sarifWithDriftedRange,
    },
    {
      ...base,
      templateSource: fixtureTemplate().replace(
        "          CloudFrontDefaultCertificate: true",
        "          AcmCertificateArn: arn:aws:acm:us-east-1:123456789012:certificate/example"
      ),
    },
  ];
  for (const candidate of failures) {
    assert.throws(() => evaluate(candidate));
  }
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      cases: 1 + failures.length,
      policy: "fail-closed",
    })}\n`
  );
}

function parseArguments(argv) {
  const allowed = new Set([
    "--report",
    "--sarif",
    "--template",
    "--tool-lock",
    "--version-file",
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

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function main() {
  if (process.argv.length === 3 && process.argv[2] === "--self-test") {
    runSelfTest();
    return;
  }
  const args = parseArguments(process.argv.slice(2));
  const result = evaluate({
    report: parseJson(
      "Trivy JSON report",
      readFileSync(args.get("--report"), "utf8")
    ),
    sarif: parseJson(
      "Trivy SARIF report",
      readFileSync(args.get("--sarif"), "utf8")
    ),
    templateSource: readFileSync(args.get("--template"), "utf8"),
    toolLock: parseJson(
      "toolchain lock",
      readFileSync(args.get("--tool-lock"), "utf8")
    ),
    versionOutput: readFileSync(args.get("--version-file"), "utf8"),
  });
  writeJson(args.get("--compatibility-output"), result.compatibilityFindings);
  writeJson(args.get("--blocking-output"), result.blockingFindings);
  writeJson(args.get("--status-output"), result.status);
}

try {
  main();
} catch (error) {
  const message =
    error instanceof Error ? error.message : "unknown validation failure";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
