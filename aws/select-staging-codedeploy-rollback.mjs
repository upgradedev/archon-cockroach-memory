#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function requiredEnvironment(name, pattern) {
  const value = process.env[name];
  invariant(
    typeof value === "string" && pattern.test(value),
    `Required ${name} contract is invalid.`
  );
  return value;
}

function exactCaseInsensitiveValue(object, expectedKey, label) {
  invariant(
    object !== null && typeof object === "object" && !Array.isArray(object),
    `${label} must be an object.`
  );
  const matchingKeys = Object.keys(object).filter(
    (key) => key.toLowerCase() === expectedKey.toLowerCase()
  );
  invariant(
    matchingKeys.length === 1,
    `${label} must contain exactly one ${expectedKey} field.`
  );
  return object[matchingKeys[0]];
}

function exactCaseInsensitiveKeys(object, expectedKeys, label) {
  invariant(
    object !== null && typeof object === "object" && !Array.isArray(object),
    `${label} must be an object.`
  );
  const actual = Object.keys(object).map((key) => key.toLowerCase()).sort();
  const expected = expectedKeys.map((key) => key.toLowerCase()).sort();
  invariant(
    new Set(actual).size === actual.length &&
      JSON.stringify(actual) === JSON.stringify(expected),
    `${label} fields are invalid.`
  );
}

function versionString(value, label) {
  const normalized = typeof value === "number" ? String(value) : value;
  invariant(
    typeof normalized === "string" && /^[1-9][0-9]*$/u.test(normalized),
    `${label} must be a positive Lambda version.`
  );
  return normalized;
}

function scalarString(value, label) {
  invariant(
    typeof value === "string" && value.length > 0 && value.length <= 256,
    `${label} must be a bounded non-empty string.`
  );
  return value;
}

function parseJsonAppSpec(content) {
  const parsed = JSON.parse(content);
  invariant(
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed),
    "The JSON AppSpec root must be an object."
  );
  const allowedRootKeys = ["version", "resources"];
  const rootKeys = Object.keys(parsed).map((key) => key.toLowerCase());
  invariant(
    rootKeys.every((key) => [...allowedRootKeys, "hooks"].includes(key)) &&
      new Set(rootKeys).size === rootKeys.length &&
      allowedRootKeys.every((key) => rootKeys.includes(key)),
    "The JSON AppSpec root fields are invalid."
  );
  const version = exactCaseInsensitiveValue(parsed, "version", "AppSpec");
  invariant(
    version === "0.0" || version === 0,
    "The AppSpec version must be 0.0."
  );
  const resources = exactCaseInsensitiveValue(
    parsed,
    "resources",
    "AppSpec"
  );
  invariant(
    Array.isArray(resources) && resources.length === 1,
    "The Lambda AppSpec must contain exactly one resource."
  );
  const resource = resources[0];
  invariant(
    resource !== null &&
      typeof resource === "object" &&
      !Array.isArray(resource) &&
      Object.keys(resource).length === 1,
    "The Lambda AppSpec resource envelope is invalid."
  );
  const specification = resource[Object.keys(resource)[0]];
  exactCaseInsensitiveKeys(
    specification,
    ["type", "properties"],
    "Lambda AppSpec resource"
  );
  invariant(
    exactCaseInsensitiveValue(
      specification,
      "type",
      "Lambda AppSpec resource"
    ) === "AWS::Lambda::Function",
    "The AppSpec resource type is not AWS::Lambda::Function."
  );
  const properties = exactCaseInsensitiveValue(
    specification,
    "properties",
    "Lambda AppSpec resource"
  );
  exactCaseInsensitiveKeys(
    properties,
    ["name", "alias", "currentversion", "targetversion"],
    "Lambda AppSpec properties"
  );
  return {
    functionAlias: scalarString(
      exactCaseInsensitiveValue(properties, "alias", "Lambda AppSpec"),
      "Lambda AppSpec alias"
    ),
    functionName: scalarString(
      exactCaseInsensitiveValue(properties, "name", "Lambda AppSpec"),
      "Lambda AppSpec function name"
    ),
    currentVersion: versionString(
      exactCaseInsensitiveValue(
        properties,
        "currentversion",
        "Lambda AppSpec"
      ),
      "Lambda AppSpec current version"
    ),
    targetVersion: versionString(
      exactCaseInsensitiveValue(
        properties,
        "targetversion",
        "Lambda AppSpec"
      ),
      "Lambda AppSpec target version"
    ),
  };
}

function yamlScalar(rawValue, label) {
  const value = rawValue.trim();
  invariant(value.length > 0, `${label} must not be empty.`);
  if (value.startsWith('"')) {
    invariant(value.endsWith('"'), `${label} has invalid quoting.`);
    const parsed = JSON.parse(value);
    return scalarString(String(parsed), label);
  }
  if (value.startsWith("'")) {
    invariant(value.endsWith("'"), `${label} has invalid quoting.`);
    return scalarString(value.slice(1, -1).replaceAll("''", "'"), label);
  }
  invariant(
    !/[\[\]{}&*!|>#]/u.test(value),
    `${label} uses unsupported YAML syntax.`
  );
  return scalarString(value, label);
}

function parseYamlAppSpec(content) {
  invariant(!content.includes("\t"), "The YAML AppSpec must not contain tabs.");
  const lines = content.split(/\r?\n/u).map((raw, index) => {
    const withoutComment = raw.replace(/\s+#.*$/u, "");
    const text = withoutComment.trimEnd();
    return {
      indent: text.length - text.trimStart().length,
      line: index + 1,
      text,
      trimmed: text.trim(),
    };
  });
  const meaningful = lines.filter(
    (line) => line.trimmed.length > 0 && line.trimmed !== "---"
  );
  const topVersion = meaningful.filter(
    (line) => line.indent === 0 && /^version\s*:/iu.test(line.trimmed)
  );
  const topResources = meaningful.filter(
    (line) => line.indent === 0 && /^resources\s*:\s*$/iu.test(line.trimmed)
  );
  invariant(
    topVersion.length === 1 && topResources.length === 1,
    "The YAML AppSpec must contain one version and one resources block."
  );
  const version = yamlScalar(
    topVersion[0].trimmed.replace(/^version\s*:/iu, ""),
    "AppSpec version"
  );
  invariant(version === "0.0", "The AppSpec version must be 0.0.");

  const resourcesIndex = meaningful.indexOf(topResources[0]);
  const resourcesBlock = meaningful.slice(resourcesIndex + 1).filter((line) => {
    if (line.indent === 0) return false;
    return true;
  });
  const nextTopLevelIndex = meaningful.findIndex(
    (line, index) => index > resourcesIndex && line.indent === 0
  );
  const boundedResources = meaningful.slice(
    resourcesIndex + 1,
    nextTopLevelIndex === -1 ? meaningful.length : nextTopLevelIndex
  );
  const entries = boundedResources.filter((line) => /^-\s+[^:]+:\s*$/u.test(line.trimmed));
  invariant(
    resourcesBlock.length > 0 && entries.length === 1,
    "The YAML Lambda AppSpec must contain exactly one resource."
  );
  const resourceEntry = entries[0];
  const typeLines = boundedResources.filter(
    (line) =>
      line.indent > resourceEntry.indent && /^type\s*:/iu.test(line.trimmed)
  );
  const propertyHeaders = boundedResources.filter(
    (line) =>
      line.indent > resourceEntry.indent && /^properties\s*:\s*$/iu.test(line.trimmed)
  );
  invariant(
    typeLines.length === 1 && propertyHeaders.length === 1,
    "The YAML Lambda resource type or properties block is ambiguous."
  );
  invariant(
    yamlScalar(
      typeLines[0].trimmed.replace(/^type\s*:/iu, ""),
      "Lambda AppSpec type"
    ) === "AWS::Lambda::Function",
    "The AppSpec resource type is not AWS::Lambda::Function."
  );
  const propertyHeader = propertyHeaders[0];
  const propertyIndex = boundedResources.indexOf(propertyHeader);
  const propertyLines = boundedResources
    .slice(propertyIndex + 1)
    .filter((line) => line.indent > propertyHeader.indent);
  const values = new Map();
  for (const line of propertyLines) {
    const match = /^(name|alias|currentversion|targetversion)\s*:\s*(.+)$/iu.exec(
      line.trimmed
    );
    invariant(match !== null, `Unsupported YAML AppSpec property at line ${line.line}.`);
    const key = match[1].toLowerCase();
    invariant(!values.has(key), `Duplicate YAML AppSpec ${key} property.`);
    values.set(key, yamlScalar(match[2], `Lambda AppSpec ${key}`));
  }
  invariant(
    propertyLines.length === 4 &&
      ["name", "alias", "currentversion", "targetversion"].every((key) =>
        values.has(key)
      ),
    "The YAML Lambda AppSpec properties are incomplete."
  );
  return {
    functionAlias: values.get("alias"),
    functionName: values.get("name"),
    currentVersion: versionString(
      values.get("currentversion"),
      "Lambda AppSpec current version"
    ),
    targetVersion: versionString(
      values.get("targetversion"),
      "Lambda AppSpec target version"
    ),
  };
}

function parseLambdaAppSpec(content) {
  try {
    return parseJsonAppSpec(content);
  } catch (jsonError) {
    try {
      return parseYamlAppSpec(content);
    } catch (yamlError) {
      throw new Error(
        `The Lambda AppSpec is neither strict JSON nor supported strict YAML: ${jsonError.message}; ${yamlError.message}`
      );
    }
  }
}

function epochSeconds(value, label) {
  if (typeof value === "number") {
    invariant(Number.isFinite(value) && value > 0, `${label} is invalid.`);
    return value;
  }
  invariant(typeof value === "string", `${label} is invalid.`);
  const milliseconds = Date.parse(value);
  invariant(Number.isFinite(milliseconds), `${label} is invalid.`);
  return milliseconds / 1000;
}

function lambdaRevision(record, expectedApplication) {
  const deployment = record.deploymentInfo;
  const response = record.applicationRevision;
  invariant(
    deployment?.revision?.revisionType === "AppSpecContent",
    "The deployment does not expose an AppSpecContent revision."
  );
  const requestedSha = deployment.revision.appSpecContent?.sha256;
  invariant(
    typeof requestedSha === "string" && /^[0-9a-f]{64}$/u.test(requestedSha),
    "The deployment AppSpec digest is invalid."
  );
  invariant(
    response?.applicationName === expectedApplication &&
      response?.revision?.revisionType === "AppSpecContent",
    "The application revision identity is invalid."
  );
  const returnedRevision = response.revision.appSpecContent;
  invariant(
    returnedRevision?.sha256 === requestedSha &&
      typeof returnedRevision?.content === "string" &&
      returnedRevision.content.length > 0 &&
      returnedRevision.content.length <= 65536,
    "The returned AppSpec revision is incomplete or digest-mismatched."
  );
  const calculatedSha = createHash("sha256")
    .update(returnedRevision.content, "utf8")
    .digest("hex");
  invariant(
    calculatedSha === requestedSha,
    "The returned AppSpec content does not match its CodeDeploy digest."
  );
  return {
    ...parseLambdaAppSpec(returnedRevision.content),
    sha256: requestedSha,
  };
}

function exactRollbackRelation(source, rollback) {
  const forward = source.rollbackInfo?.rollbackDeploymentId;
  const backward = rollback.rollbackInfo?.rollbackTriggeringDeploymentId;
  invariant(
    forward !== undefined || backward !== undefined,
    "The rollback relation is absent."
  );
  return (
    (forward === undefined || forward === rollback.deploymentId) &&
    (backward === undefined || backward === source.deploymentId)
  );
}

function main() {
  invariant(
    process.argv.length === 3,
    "Usage: select-staging-codedeploy-rollback.mjs <deployment-details.json>"
  );
  const application = requiredEnvironment(
    "EXPECTED_CODEDEPLOY_APPLICATION",
    /^[A-Za-z0-9._+=,@-]{1,100}$/u
  );
  const group = requiredEnvironment(
    "EXPECTED_CODEDEPLOY_GROUP",
    /^[A-Za-z0-9._+=,@-]{1,100}$/u
  );
  const functionName = requiredEnvironment(
    "EXPECTED_LAMBDA_FUNCTION_NAME",
    /^[A-Za-z0-9-_]{1,64}$/u
  );
  const alias = requiredEnvironment(
    "EXPECTED_LAMBDA_ALIAS",
    /^[A-Za-z0-9-_]{1,128}$/u
  );
  const previousVersion = requiredEnvironment(
    "EXPECTED_PREVIOUS_VERSION",
    /^[1-9][0-9]*$/u
  );
  const candidateVersion = requiredEnvironment(
    "EXPECTED_CANDIDATE_VERSION",
    /^[1-9][0-9]*$/u
  );
  const stackId = requiredEnvironment(
    "EXPECTED_CLOUDFORMATION_STACK_ID",
    /^arn:aws:cloudformation:eu-west-1:[0-9]{12}:stack\/[A-Za-z][A-Za-z0-9-]{0,127}\/[0-9a-f-]+$/u
  );
  const started = Number(
    requiredEnvironment("EXPECTED_DRILL_STARTED_EPOCH", /^[1-9][0-9]{8,}$/u)
  );
  const observed = epochSeconds(
    requiredEnvironment(
      "EXPECTED_CANDIDATE_OBSERVED_AT",
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u
    ),
    "Candidate observation time"
  );
  const ended = Number(
    requiredEnvironment("EXPECTED_DRILL_ENDED_EPOCH", /^[1-9][0-9]{8,}$/u)
  );
  invariant(
    previousVersion !== candidateVersion &&
      Number.isSafeInteger(started) &&
      Number.isSafeInteger(ended) &&
      observed >= started &&
      ended >= observed,
    "The expected drill identity or time window is invalid."
  );

  const records = JSON.parse(readFileSync(process.argv[2], "utf8"));
  invariant(
    Array.isArray(records) && records.length > 0 && records.length <= 20,
    "The deployment detail inventory is empty or unbounded."
  );
  const deploymentIds = records.map((record) => record?.deploymentInfo?.deploymentId);
  invariant(
    deploymentIds.every(
      (deploymentId) =>
        typeof deploymentId === "string" && /^d-[A-Z0-9]+$/u.test(deploymentId)
    ) && new Set(deploymentIds).size === deploymentIds.length,
    "The deployment detail inventory has invalid or duplicate IDs."
  );

  const sourceMatches = [];
  for (const record of records) {
    const source = record.deploymentInfo;
    const created = epochSeconds(source.createTime, "Source deployment creation time");
    if (
      source.applicationName !== application ||
      source.deploymentGroupName !== group ||
      source.computePlatform !== "Lambda" ||
      source.creator !== "CloudFormation" ||
      source.externalId !== stackId ||
      source.deploymentConfigName !==
        "CodeDeployDefault.LambdaCanary10Percent5Minutes" ||
      source.status !== "Stopped" ||
      source.errorInformation?.code !== "ALARM_ACTIVE" ||
      source.autoRollbackConfiguration?.enabled !== true ||
      !source.autoRollbackConfiguration?.events?.includes(
        "DEPLOYMENT_STOP_ON_ALARM"
      ) ||
      created < started - 60 ||
      created > observed + 60
    ) {
      continue;
    }
    const revision = lambdaRevision(record, application);
    if (
      revision.functionName === functionName &&
      revision.functionAlias === alias &&
      revision.currentVersion === previousVersion &&
      revision.targetVersion === candidateVersion
    ) {
      sourceMatches.push({ record, revision });
    }
  }
  invariant(
    sourceMatches.length === 1,
    "Exactly one stack-, window-, and AppSpec-bound alarm-stopped source deployment is required."
  );
  const sourceRecord = sourceMatches[0];
  const source = sourceRecord.record.deploymentInfo;
  const sourceCreated = epochSeconds(
    source.createTime,
    "Source deployment creation time"
  );

  const rollbackMatches = records.filter((record) => {
    const rollback = record.deploymentInfo;
    const created = epochSeconds(
      rollback.createTime,
      "Rollback deployment creation time"
    );
    return (
      rollback.applicationName === application &&
      rollback.deploymentGroupName === group &&
      rollback.computePlatform === "Lambda" &&
      rollback.status === "Succeeded" &&
      ["CloudFormationRollback", "codeDeployRollback"].includes(
        rollback.creator
      ) &&
      created >= sourceCreated &&
      created <= ended + 60 &&
      exactRollbackRelation(source, rollback)
    );
  });
  invariant(
    rollbackMatches.length === 1,
    "Exactly one successful related automatic rollback deployment is required."
  );

  process.stdout.write(
    `${JSON.stringify({
      relationProved: true,
      rollback: rollbackMatches[0].deploymentInfo,
      source,
      sourceBinding: {
        appSpecSha256: sourceRecord.revision.sha256,
        candidateVersionMatched: true,
        createTimeWithinDrillWindow: true,
        externalStackIdMatched: true,
        functionAliasMatched: true,
        functionNameMatched: true,
        previousVersionMatched: true,
      },
    })}\n`
  );
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown selector failure.";
  process.stderr.write(`CodeDeploy recovery evidence rejected: ${message}\n`);
  process.exitCode = 1;
}
