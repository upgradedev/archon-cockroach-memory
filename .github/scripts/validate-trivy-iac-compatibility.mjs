#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

const EXPECTED_SCANNER = "Trivy";
const EXPECTED_SCANNER_VERSION = "0.72.0";
const EXPECTED_TARGET = "aws/template.yaml";
const EXPECTED_BOOTSTRAP_TARGET = "aws/bootstrap-oidc.yaml";
const EXPECTED_SEVERITY = "HIGH";
const EXPECTED_FINDING_TYPE = "CloudFormation Security Check";
const EXPECTED_RULES = Object.freeze([
  Object.freeze({
    ruleId: "AWS-0011",
    legacyAlias: null,
    logicalResource: "Distribution",
    namespace: "builtin.aws.cloudfront.aws0011",
    title: "CloudFront distribution does not have a WAF in front.",
    primaryUrl: "https://avd.aquasec.com/misconfig/aws-0011",
    sourceProperty: "WebACLId: !Ref CloudFrontWebAclArn",
    reason:
      "CloudFrontWebAclArn is mandatory and Distribution.WebACLId directly references it; Trivy cannot resolve the CloudFormation parameter value.",
    controls: Object.freeze({
      mandatoryWebAclParameter: true,
      directWebAclBinding: true,
      globalUsEast1ArnConstraint: true,
      accessLogging: true,
    }),
  }),
  Object.freeze({
    ruleId: "AWS-0013",
    legacyAlias: null,
    logicalResource: "Distribution",
    namespace: "builtin.aws.cloudfront.aws0013",
    title: "CloudFront distribution uses outdated SSL/TLS protocols.",
    primaryUrl: "https://avd.aquasec.com/misconfig/aws-0013",
    sourceProperty: "CloudFrontDefaultCertificate: true",
    reason:
      "CloudFrontDefaultCertificate cannot declare MinimumProtocolVersion; the generated cloudfront.net demo hostname is retained while every viewer, API, and custom-origin path enforces HTTPS.",
    controls: Object.freeze({
      defaultViewerHttpsRedirect: true,
      apiViewerHttpsOnly: true,
      customOriginHttpsOnly: true,
      mandatoryWebAcl: true,
      dynamicOriginSecret: true,
      accessLogging: true,
      customDomainAliases: false,
    }),
  }),
  Object.freeze({
    ruleId: "AWS-0132",
    legacyAlias: null,
    logicalResource: "SpaBucket",
    namespace: "builtin.aws.s3.aws0132",
    title: "S3 encryption should use Customer Managed Keys",
    primaryUrl: "https://avd.aquasec.com/misconfig/aws-0132",
    sourceProperty:
      'KMSMasterKeyID: Fn::ImportValue "${AppName}-storage-kms-key-arn"',
    reason:
      "SpaBucket uses SSE-KMS with the foundation-exported rotating customer-managed ApplicationStorageKey; Trivy cannot resolve the Fn::ImportValue expression.",
    controls: Object.freeze({
      sseKms: true,
      bucketKeyEnabled: true,
      foundationCustomerManagedKey: true,
      keyRotation: true,
      importExportBound: true,
      denyUnencryptedWrites: true,
      denyUnexpectedKeyWrites: true,
    }),
  }),
]);

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

function extractSinglePolicyStatement(source, sid) {
  const lines = normalizeSource(source).split("\n");
  const marker = `          - Sid: ${sid}`;
  const starts = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] === marker) starts.push(index);
  }
  invariant(starts.length === 1, `${sid} must occur exactly once`);
  const start = starts[0];
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^          - Sid: /u.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trimEnd();
}

function validateTemplateContract(templateSource, bootstrapSource) {
  const normalized = normalizeSource(templateSource);
  const normalizedBootstrap = normalizeSource(bootstrapSource);
  invariant(
    !/trivy(?:-|\s*:)ignore/iu.test(`${normalized}\n${normalizedBootstrap}`),
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

  const distribution = extractSingleTwoSpaceBlock(normalized, "Distribution");
  const distributionSource = distribution.source;
  invariant(
    count(
      distributionSource,
      /^\s{4}Type: AWS::CloudFront::Distribution$/gmu
    ) === 1,
    "Distribution must remain an AWS::CloudFront::Distribution"
  );
  invariant(
    count(
      distributionSource,
      /^\s{8}WebACLId: !Ref CloudFrontWebAclArn$/gmu
    ) === 1,
    "Distribution must bind the mandatory WebACL directly"
  );
  invariant(
    count(distributionSource, /^\s{8}Logging:$/gmu) === 1 &&
      /\n        Logging:\n          Bucket: !Sub >-\n            \$\{AppName\}-cloudfront-access-logs-\$\{AWS::AccountId\}-\$\{AWS::Region\}\.s3\.amazonaws\.com\n          IncludeCookies: false\n          Prefix: !Sub "\$\{Environment\}\/"/u.test(
        distributionSource
      ),
    "Distribution access logging must remain enabled with the deterministic archive destination"
  );
  invariant(
    count(distributionSource, /^\s{12}OriginCustomHeaders:$/gmu) === 1 &&
      count(
        distributionSource,
        /^\s{14}- HeaderName: x-archon-origin-verify$/gmu
      ) === 1 &&
      count(
        distributionSource,
        /\{\{resolve:secretsmanager:\$\{AppName\}\/\$\{Environment\}\/origin-verification:SecretString:ORIGIN_VERIFY_TOKEN\}\}/gu
      ) === 1,
    "the API origin must retain its dynamic Secrets Manager verification header"
  );
  invariant(
    count(
      distributionSource,
      /^\s{14}OriginProtocolPolicy: https-only$/gmu
    ) === 1 &&
      /\n              OriginSSLProtocols:\n                - TLSv1\.2/u.test(
        distributionSource
      ),
    "the API custom origin must remain HTTPS-only with TLS 1.2"
  );
  invariant(
    count(
      distributionSource,
      /^\s{10}ViewerProtocolPolicy: redirect-to-https$/gmu
    ) === 1,
    "the default viewer behavior must continue redirecting HTTP to HTTPS"
  );
  invariant(
    count(
      distributionSource,
      /^\s{12}ViewerProtocolPolicy: https-only$/gmu
    ) === 1 &&
      count(distributionSource, /^\s{10}- PathPattern: \/api\/\*$/gmu) === 1,
    "the API viewer behavior must remain HTTPS-only"
  );
  invariant(
    count(
      distributionSource,
      /^\s{10}CloudFrontDefaultCertificate: true$/gmu
    ) === 1,
    "the certificate boundary requires exactly one CloudFront default certificate"
  );
  invariant(
    !/MinimumProtocolVersion:/u.test(distributionSource),
    "MinimumProtocolVersion cannot accompany CloudFrontDefaultCertificate"
  );
  invariant(
    !/^\s+Aliases:/mu.test(distributionSource),
    "the default-certificate boundary cannot include a custom domain"
  );

  const spaBucket = extractSingleTwoSpaceBlock(normalized, "SpaBucket");
  const spaBucketSource = spaBucket.source;
  invariant(
    count(spaBucketSource, /^\s{4}Type: AWS::S3::Bucket$/gmu) === 1,
    "SpaBucket must remain an AWS::S3::Bucket"
  );
  invariant(
    /\n      BucketEncryption:\n        ServerSideEncryptionConfiguration:\n          - BucketKeyEnabled: true\n            ServerSideEncryptionByDefault:\n              KMSMasterKeyID:\n                Fn::ImportValue: !Sub "\$\{AppName\}-storage-kms-key-arn"\n              SSEAlgorithm: aws:kms/u.test(
      spaBucketSource
    ),
    "SpaBucket must use SSE-KMS, an S3 bucket key, and the exact foundation CMK export"
  );

  const spaBucketPolicy = extractSingleTwoSpaceBlock(
    normalized,
    "SpaBucketPolicy"
  ).source;
  const denyWithoutKms = extractSinglePolicyStatement(
    spaBucketPolicy,
    "DenySpaWritesWithoutKms"
  );
  const denyUnexpectedKms = extractSinglePolicyStatement(
    spaBucketPolicy,
    "DenySpaWritesWithUnexpectedKmsKey"
  );
  invariant(
    denyWithoutKms ===
      [
        "          - Sid: DenySpaWritesWithoutKms",
        "            Effect: Deny",
        '            Principal: "*"',
        "            Action: s3:PutObject",
        '            Resource: !Sub "${SpaBucket.Arn}/*"',
        "            Condition:",
        "              StringNotEquals:",
        "                s3:x-amz-server-side-encryption: aws:kms",
      ].join("\n") &&
      denyUnexpectedKms ===
        [
          "          - Sid: DenySpaWritesWithUnexpectedKmsKey",
          "            Effect: Deny",
          '            Principal: "*"',
          "            Action: s3:PutObject",
          '            Resource: !Sub "${SpaBucket.Arn}/*"',
          "            Condition:",
          "              StringNotEquals:",
          "                s3:x-amz-server-side-encryption-aws-kms-key-id: !Sub >-",
          "                  arn:${AWS::Partition}:kms:${AWS::Region}:${AWS::AccountId}:alias/${AppName}-storage",
        ].join("\n"),
    "SpaBucketPolicy must reject unencrypted writes and writes using an unexpected KMS key"
  );

  const storageKey = extractSingleTwoSpaceBlock(
    normalizedBootstrap,
    "ApplicationStorageKey"
  ).source;
  invariant(
    count(storageKey, /^\s{4}Type: AWS::KMS::Key$/gmu) === 1 &&
      /^\s{6}EnableKeyRotation: true$/mu.test(storageKey) &&
      /^\s{6}KeySpec: SYMMETRIC_DEFAULT$/mu.test(storageKey) &&
      /^\s{6}KeyUsage: ENCRYPT_DECRYPT$/mu.test(storageKey) &&
      /^\s{6}MultiRegion: false$/mu.test(storageKey),
    "ApplicationStorageKey must remain a rotating regional customer-managed encryption key"
  );
  const storageKeyAlias = extractSingleTwoSpaceBlock(
    normalizedBootstrap,
    "ApplicationStorageKeyAlias"
  ).source;
  invariant(
    /^\s{6}AliasName: !Sub "alias\/\$\{AppName\}-storage"$/mu.test(
      storageKeyAlias
    ) &&
      /^\s{6}TargetKeyId: !Ref ApplicationStorageKey$/mu.test(storageKeyAlias),
    "ApplicationStorageKeyAlias must bind the expected alias to the customer-managed key"
  );
  const storageKeyOutput = extractSingleTwoSpaceBlock(
    normalizedBootstrap,
    "ApplicationStorageKeyArn"
  ).source;
  invariant(
    /^\s{4}Value: !GetAtt ApplicationStorageKey\.Arn$/mu.test(
      storageKeyOutput
    ) &&
      /^\s{6}Name: !Sub "\$\{AppName\}-storage-kms-key-arn"$/mu.test(
        storageKeyOutput
      ),
    "the foundation output must export the exact customer-managed key ARN consumed by SpaBucket"
  );

  return {
    Distribution: {
      startLine: distribution.startLine,
      endLine: distribution.endLine,
    },
    SpaBucket: {
      startLine: spaBucket.startLine,
      endLine: spaBucket.endLine,
    },
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
    invariant(result && typeof result === "object", "each Trivy result must be an object");
    if (result.Misconfigurations === undefined) {
      continue;
    }
    invariant(Array.isArray(result.Misconfigurations), "Misconfigurations must be an array");
    for (const finding of result.Misconfigurations) {
      findings.push({ result, finding });
    }
  }
  return findings;
}

function expectedRange(rule, templateContract) {
  return templateContract[rule.logicalResource];
}

function validateJsonFindings(report, templateContract) {
  const findings = flattenMisconfigurations(report);
  invariant(
    findings.length === EXPECTED_RULES.length,
    `raw Trivy JSON must contain exactly ${EXPECTED_RULES.length} findings`
  );

  const byRuleId = new Map();
  for (const entry of findings) {
    const { result, finding } = entry;
    invariant(result.Target === EXPECTED_TARGET, "every finding target must be aws/template.yaml");
    invariant(result.Class === "config", "every finding class must be config");
    invariant(result.Type === "cloudformation", "every finding type must be cloudformation");
    invariant(finding && typeof finding === "object", "every finding must be an object");
    invariant(!byRuleId.has(finding.ID), `duplicate finding ${finding.ID}`);
    byRuleId.set(finding.ID, entry);
  }
  invariant(
    [...byRuleId.keys()].sort().join(",") ===
      EXPECTED_RULES.map((rule) => rule.ruleId).sort().join(","),
    "raw Trivy JSON rule set must match the exact compatibility rule set"
  );

  for (const rule of EXPECTED_RULES) {
    const { finding } = byRuleId.get(rule.ruleId);
    const range = expectedRange(rule, templateContract);
    invariant(
      finding.Type === EXPECTED_FINDING_TYPE,
      `${rule.ruleId} finding type must be ${EXPECTED_FINDING_TYPE}`
    );
    invariant(
      (finding.AVDID ?? null) === rule.legacyAlias,
      `${rule.ruleId} must not report a legacy AVDID alias`
    );
    invariant(finding.Severity === EXPECTED_SEVERITY, `${rule.ruleId} severity must be HIGH`);
    invariant(finding.Status === "FAIL", `${rule.ruleId} status must be FAIL`);
    invariant(finding.Namespace === rule.namespace, `${rule.ruleId} namespace drifted`);
    invariant(finding.Title === rule.title, `${rule.ruleId} title drifted`);
    invariant(finding.PrimaryURL === rule.primaryUrl, `${rule.ruleId} reference drifted`);
    invariant(
      finding.CauseMetadata?.StartLine === range.startLine &&
        finding.CauseMetadata?.EndLine === range.endLine,
      `${rule.ruleId} location must equal the complete ${rule.logicalResource} source block`
    );
    const scannerResource =
      `${EXPECTED_TARGET}:${range.startLine}-${range.endLine}`;
    invariant(
      finding.CauseMetadata?.Resource === scannerResource,
      `${rule.ruleId} scanner resource must match the exact source range`
    );
  }
  return byRuleId;
}

function validateSarif(sarif, templateContract) {
  invariant(sarif?.version === "2.1.0", "SARIF version must be 2.1.0");
  invariant(
    Array.isArray(sarif.runs) && sarif.runs.length === 1,
    "SARIF must contain one run"
  );
  const run = sarif.runs[0];
  invariant(run.tool?.driver?.name === EXPECTED_SCANNER, "SARIF driver must be Trivy");
  invariant(
    run.tool.driver.version === EXPECTED_SCANNER_VERSION,
    `SARIF driver version must be ${EXPECTED_SCANNER_VERSION}`
  );
  invariant(
    Array.isArray(run.results) && run.results.length === EXPECTED_RULES.length,
    `SARIF must retain exactly ${EXPECTED_RULES.length} raw results`
  );
  invariant(Array.isArray(run.tool.driver.rules), "SARIF driver rules must be an array");

  const descriptors = run.tool.driver.rules.filter((descriptor) =>
    EXPECTED_RULES.some((rule) => rule.ruleId === descriptor?.id)
  );
  invariant(
    run.tool.driver.rules.length === EXPECTED_RULES.length &&
      descriptors.length === EXPECTED_RULES.length &&
      [...new Set(descriptors.map((descriptor) => descriptor.id))].length ===
        EXPECTED_RULES.length,
    "SARIF must contain exactly one descriptor for every compatibility rule"
  );

  const resultsByRule = new Map();
  for (const result of run.results) {
    invariant(!resultsByRule.has(result.ruleId), `duplicate SARIF result ${result.ruleId}`);
    resultsByRule.set(result.ruleId, result);
  }
  invariant(
    [...resultsByRule.keys()].sort().join(",") ===
      EXPECTED_RULES.map((rule) => rule.ruleId).sort().join(","),
    "SARIF result rule set must match the exact compatibility rule set"
  );
  for (const rule of EXPECTED_RULES) {
    const result = resultsByRule.get(rule.ruleId);
    const range = expectedRange(rule, templateContract);
    invariant(result.level === "error", `HIGH ${rule.ruleId} must remain a SARIF error`);
    invariant(
      Array.isArray(result.locations) && result.locations.length === 1,
      `${rule.ruleId} SARIF result must have exactly one location`
    );
    const location = result.locations[0].physicalLocation;
    invariant(
      location?.artifactLocation?.uri === EXPECTED_TARGET,
      `${rule.ruleId} SARIF location must be aws/template.yaml`
    );
    invariant(
      location.region?.startLine === range.startLine &&
        location.region?.endLine === range.endLine,
      `${rule.ruleId} SARIF location must match the exact source block`
    );
    invariant(
      location.region.startColumn === 1 && location.region.endColumn === 1,
      `${rule.ruleId} SARIF location columns must retain complete-block coordinates`
    );
  }
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

function evaluate({ report, sarif, templateSource, bootstrapSource, toolLock, versionOutput }) {
  validateToolLock(toolLock);
  validateVersionOutput(versionOutput);
  const templateContract = validateTemplateContract(templateSource, bootstrapSource);
  const findingsByRule = validateJsonFindings(report, templateContract);
  validateSarif(sarif, templateContract);

  const compatibilityFindings = EXPECTED_RULES.map((rule) => {
    const finding = findingsByRule.get(rule.ruleId).finding;
    return {
      ruleId: rule.ruleId,
      findingType: EXPECTED_FINDING_TYPE,
      legacyAlias: rule.legacyAlias,
      severity: EXPECTED_SEVERITY,
      status: "FAIL",
      target: EXPECTED_TARGET,
      logicalResource: rule.logicalResource,
      scannerResource: finding.CauseMetadata.Resource,
      namespace: rule.namespace,
      startLine: finding.CauseMetadata.StartLine,
      endLine: finding.CauseMetadata.EndLine,
      sourceProperty: rule.sourceProperty,
      reason: rule.reason,
      controls: rule.controls,
    };
  });

  return {
    compatibilityFindings,
    blockingFindings: [],
    status: {
      schema: "archon.trivy-iac.compatibility",
      version: 2,
      mode: "blocking-exact-source-validated-parser-compatibilities",
      scanner: EXPECTED_SCANNER,
      scannerVersion: EXPECTED_SCANNER_VERSION,
      versionEvidence: {
        toolLock: EXPECTED_SCANNER_VERSION,
        capturedCli: EXPECTED_SCANNER_VERSION,
        sarifDriver: EXPECTED_SCANNER_VERSION,
      },
      thresholdSeverities: ["MEDIUM", "HIGH", "CRITICAL"],
      rawFindings: EXPECTED_RULES.length,
      compatibilityFindings: EXPECTED_RULES.length,
      blockingFindings: 0,
      acceptedWaivers: 0,
      effectiveExitCode: 0,
      compatibilities: compatibilityFindings.map((finding) => ({
        ruleId: finding.ruleId,
        findingType: finding.findingType,
        severity: finding.severity,
        target: finding.target,
        logicalResource: finding.logicalResource,
        scannerResource: finding.scannerResource,
        sourceRange: {
          startLine: finding.startLine,
          endLine: finding.endLine,
        },
        sourceProperty: finding.sourceProperty,
        reason: finding.reason,
        controls: finding.controls,
      })),
      sourceEvidence: {
        applicationTemplate: EXPECTED_TARGET,
        foundationTemplate: EXPECTED_BOOTSTRAP_TARGET,
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
  SpaBucket:
    Type: AWS::S3::Bucket
    Properties:
      BucketEncryption:
        ServerSideEncryptionConfiguration:
          - BucketKeyEnabled: true
            ServerSideEncryptionByDefault:
              KMSMasterKeyID:
                Fn::ImportValue: !Sub "\${AppName}-storage-kms-key-arn"
              SSEAlgorithm: aws:kms

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

  SpaBucketPolicy:
    Type: AWS::S3::BucketPolicy
    Properties:
      PolicyDocument:
        Statement:
          - Sid: DenySpaWritesWithoutKms
            Effect: Deny
            Principal: "*"
            Action: s3:PutObject
            Resource: !Sub "\${SpaBucket.Arn}/*"
            Condition:
              StringNotEquals:
                s3:x-amz-server-side-encryption: aws:kms
          - Sid: DenySpaWritesWithUnexpectedKmsKey
            Effect: Deny
            Principal: "*"
            Action: s3:PutObject
            Resource: !Sub "\${SpaBucket.Arn}/*"
            Condition:
              StringNotEquals:
                s3:x-amz-server-side-encryption-aws-kms-key-id: !Sub >-
                  arn:\${AWS::Partition}:kms:\${AWS::Region}:\${AWS::AccountId}:alias/\${AppName}-storage
`;
}

function fixtureBootstrap() {
  return `Resources:
  ApplicationStorageKey:
    Type: AWS::KMS::Key
    Properties:
      EnableKeyRotation: true
      KeySpec: SYMMETRIC_DEFAULT
      KeyUsage: ENCRYPT_DECRYPT
      MultiRegion: false

  ApplicationStorageKeyAlias:
    Type: AWS::KMS::Alias
    Properties:
      AliasName: !Sub "alias/\${AppName}-storage"
      TargetKeyId: !Ref ApplicationStorageKey
Outputs:
  ApplicationStorageKeyArn:
    Value: !GetAtt ApplicationStorageKey.Arn
    Export:
      Name: !Sub "\${AppName}-storage-kms-key-arn"
`;
}

function fixtureReport(templateSource = fixtureTemplate()) {
  const contract = validateTemplateContract(templateSource, fixtureBootstrap());
  return {
    SchemaVersion: 2,
    Results: [
      {
        Target: EXPECTED_TARGET,
        Class: "config",
        Type: "cloudformation",
        Misconfigurations: EXPECTED_RULES.map((rule) => {
          const range = contract[rule.logicalResource];
          return {
            Type: EXPECTED_FINDING_TYPE,
            ID: rule.ruleId,
            Title: rule.title,
            Namespace: rule.namespace,
            Severity: EXPECTED_SEVERITY,
            PrimaryURL: rule.primaryUrl,
            Status: "FAIL",
            CauseMetadata: {
              Resource: `${EXPECTED_TARGET}:${range.startLine}-${range.endLine}`,
              StartLine: range.startLine,
              EndLine: range.endLine,
            },
          };
        }),
      },
    ],
  };
}

function fixtureSarif(templateSource = fixtureTemplate()) {
  const contract = validateTemplateContract(templateSource, fixtureBootstrap());
  return {
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: EXPECTED_SCANNER,
            version: EXPECTED_SCANNER_VERSION,
            rules: EXPECTED_RULES.map((rule) => ({ id: rule.ruleId })),
          },
        },
        results: EXPECTED_RULES.map((rule) => {
          const range = contract[rule.logicalResource];
          return {
            ruleId: rule.ruleId,
            level: "error",
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: EXPECTED_TARGET },
                  region: {
                    startLine: range.startLine,
                    startColumn: 1,
                    endLine: range.endLine,
                    endColumn: 1,
                  },
                },
              },
            ],
          };
        }),
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
    bootstrapSource: fixtureBootstrap(),
    toolLock: fixtureToolLock(),
    versionOutput: `Version: ${EXPECTED_SCANNER_VERSION}\n`,
  };
  const result = evaluate(base);
  assert.equal(result.status.rawFindings, 3);
  assert.equal(result.status.compatibilityFindings, 3);
  assert.equal(result.status.blockingFindings, 0);
  assert.deepEqual(
    result.status.compatibilities.map((finding) => finding.ruleId),
    ["AWS-0011", "AWS-0013", "AWS-0132"]
  );

  const extraFindingReport = fixtureReport();
  extraFindingReport.Results[0].Misconfigurations.push({
    Type: "AWS",
    ID: "AWS-9999",
    Severity: "HIGH",
    Status: "FAIL",
  });
  const legacyAliasReport = fixtureReport();
  legacyAliasReport.Results[0].Misconfigurations[0].AVDID = "AVD-AWS-0011";
  const driftedSarif = fixtureSarif();
  driftedSarif.runs[0].results[2].locations[0].physicalLocation.region.endLine -= 1;

  const failures = [
    { ...base, report: extraFindingReport },
    { ...base, report: legacyAliasReport },
    { ...base, sarif: driftedSarif },
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
        '                Fn::ImportValue: !Sub "${AppName}-storage-kms-key-arn"',
        ""
      ),
    },
    {
      ...base,
      templateSource: fixtureTemplate().replace(
        "          - Sid: DenySpaWritesWithoutKms\n            Effect: Deny",
        "          - Sid: DenySpaWritesWithoutKms\n            Effect: Allow"
      ),
    },
    {
      ...base,
      templateSource: fixtureTemplate().replace(
        "          - Sid: DenySpaWritesWithUnexpectedKmsKey\n            Effect: Deny\n            Principal: \"*\"\n            Action: s3:PutObject",
        "          - Sid: DenySpaWritesWithUnexpectedKmsKey\n            Effect: Deny\n            Principal: \"*\"\n            Action: s3:GetObject"
      ),
    },
    {
      ...base,
      templateSource: fixtureTemplate().replace(
        '            Resource: !Sub "${SpaBucket.Arn}/*"\n            Condition:\n              StringNotEquals:\n                s3:x-amz-server-side-encryption-aws-kms-key-id:',
        '            Resource: "*"\n            Condition:\n              StringNotEquals:\n                s3:x-amz-server-side-encryption-aws-kms-key-id:'
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
      bootstrapSource: fixtureBootstrap().replace(
        "      EnableKeyRotation: true",
        "      EnableKeyRotation: false"
      ),
    },
    {
      ...base,
      toolLock: {
        ...fixtureToolLock(),
        tools: { trivy: { version: "0.72.1", sha256: "a".repeat(64) } },
      },
    },
    { ...base, versionOutput: "Version: 0.72.1\n" },
  ];
  for (const candidate of failures) {
    assert.throws(() => evaluate(candidate));
  }
  process.stdout.write(
    `${JSON.stringify({ ok: true, cases: 1 + failures.length, policy: "fail-closed" })}\n`
  );
}

function parseArguments(argv) {
  const allowed = new Set([
    "--report",
    "--sarif",
    "--template",
    "--bootstrap",
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
    report: parseJson("Trivy JSON report", read(args.get("--report"))),
    sarif: parseJson("Trivy SARIF report", read(args.get("--sarif"))),
    templateSource: read(args.get("--template")),
    bootstrapSource: read(args.get("--bootstrap")),
    toolLock: parseJson("tool lock", read(args.get("--tool-lock"))),
    versionOutput: read(args.get("--version-file")),
  });
  writeJson(args.get("--compatibility-output"), result.compatibilityFindings);
  writeJson(args.get("--blocking-output"), result.blockingFindings);
  writeJson(args.get("--status-output"), result.status);
}
