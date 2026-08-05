// A semantic oracle for the CloudFormation templates under aws/.
//
// Every other infrastructure test in this repository is derived from the
// templates themselves: it asserts what the YAML says. That is why three
// defects reached main, passed cfn-lint 1.53.1 and `sam validate --lint`, and
// were rejected only by the AWS service API at CREATE time — each costing a
// stack rollback and a fix PR:
//
//   #82  one AWS::SNS::TopicPolicy listing both alarm topics
//        "Invalid parameter: Policy statement must apply to a single resource!"
//   #84  Action: sns:* inside a topic policy
//        "Invalid parameter: Policy statement action out of service scope!"
//   #83  an S3 bucket policy comparing
//        s3:x-amz-server-side-encryption-aws-kms-key-id against a KMS ALIAS ARN,
//        which S3 resolves to the key ARN before evaluating the condition, so
//        the comparison can never be true and the bucket becomes unwritable by
//        every principal — including the release pipeline.
//
// The expectations below come from the AWS service rules those errors state,
// never from a repository file. Templates are discovered, not listed, so a new
// template is covered the day it is added. Each failure names the offending
// logical resource and states the rule, so the reader learns the constraint
// rather than reading a diff.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDocument, type CollectionTag, type ScalarTag } from "yaml";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE_ROOT = join(ROOT, "aws");

// The actions a topic resource policy accepts, taken verbatim from the "Valid
// Amazon SNS policy actions" table in the Amazon SNS Developer Guide:
// https://docs.aws.amazon.com/sns/latest/dg/sns-access-policy-language-api-permissions-reference.html
//
// This is a topic-scoped set, which is why it excludes account-level actions
// such as sns:CreateTopic and sns:ListTopics: those name no topic, so they can
// only be granted in an identity policy. Wildcards are rejected outright, which
// is what "Action: sns:*" learned the expensive way in PR #84.
//
// The templates under aws/ deliberately enumerate a narrower least-privilege
// subset of this list. That is not drift, and the two must not be "corrected"
// into each other: this constant is the ceiling AWS enforces, not the floor the
// templates are obliged to reach.
const SNS_TOPIC_POLICY_ACTIONS = [
  "sns:AddPermission",
  "sns:DeleteTopic",
  "sns:GetDataProtectionPolicy",
  "sns:GetTopicAttributes",
  "sns:ListSubscriptionsByTopic",
  "sns:ListTagsForResource",
  "sns:Publish",
  "sns:PutDataProtectionPolicy",
  "sns:RemovePermission",
  "sns:SetTopicAttributes",
  "sns:Subscribe",
];

const SSE_KMS_KEY_ID_CONDITION_KEY =
  "s3:x-amz-server-side-encryption-aws-kms-key-id";

const KMS_ALIAS_ARN = /^arn:[^:]*:kms:[^:]*:[^:]*:alias\//u;
const KMS_ALIAS_NAME = /^alias\//u;
const RESOURCE_TYPE = /^[A-Za-z0-9]+::[A-Za-z0-9]+::[A-Za-z0-9]+$/u;

// The short-form intrinsics CloudFormation allows in a template. Registering
// them keeps `!Ref Topic` distinguishable from the plain string "Topic": an
// unregistered tag does not throw, it silently degrades to its scalar value.
const INTRINSIC_TAGS = [
  "And",
  "Base64",
  "Cidr",
  "Condition",
  "Equals",
  "FindInMap",
  "GetAZs",
  "GetAtt",
  "If",
  "ImportValue",
  "Join",
  "Not",
  "Or",
  "Ref",
  "Select",
  "Split",
  "Sub",
  "Transform",
];

function cfnCustomTags(): (ScalarTag | CollectionTag)[] {
  const tags: (ScalarTag | CollectionTag)[] = [];
  for (const name of INTRINSIC_TAGS) {
    const key = name === "Ref" || name === "Condition" ? name : `Fn::${name}`;
    tags.push({
      tag: `!${name}`,
      resolve: (value: string): unknown => ({ [key]: value }),
    });
    for (const collection of ["seq", "map"] as const) {
      tags.push({
        tag: `!${name}`,
        collection,
        resolve: (value: { toJSON: () => unknown }): unknown => ({
          [key]: value.toJSON(),
        }),
      });
    }
  }
  return tags;
}

// Pseudo-parameter values only have to be shaped like the real thing: the
// oracle compares structure, never a deployed value.
const PSEUDO_PARAMETERS: Record<string, string> = {
  "AWS::AccountId": "123456789012",
  "AWS::Partition": "aws",
  "AWS::Region": "eu-west-1",
  "AWS::StackId": "stack-id",
  "AWS::StackName": "stack-name",
  "AWS::URLSuffix": "amazonaws.com",
};

// Substitutes every ${...} reference so an ARN template can be matched against
// an ARN shape. Non-pseudo references collapse to a colon-free placeholder,
// which keeps ARN field boundaries intact.
function resolvePlaceholders(text: string): string {
  return text.replace(/\$\{([^}]*)\}/gu, (_match, reference: string) => {
    if (reference.startsWith("!")) return `\${${reference.slice(1)}}`;
    const pseudo = PSEUDO_PARAMETERS[reference];
    if (pseudo !== undefined) return pseudo;
    return reference.replace(/[^A-Za-z0-9]/gu, "_").toUpperCase();
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function intrinsic(value: unknown, name: string): unknown {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== name) return undefined;
  return value[name];
}

function isNoValue(value: unknown): boolean {
  return intrinsic(value, "Ref") === "AWS::NoValue";
}

// Fn::If resolves to one branch at deploy time; a service rule has to hold for
// both, so the oracle inspects both. AWS::NoValue branches remove the value.
function expand(value: unknown): unknown[] {
  const branches = intrinsic(value, "Fn::If");
  if (Array.isArray(branches) && branches.length === 3) {
    return branches
      .slice(1)
      .filter((branch) => !isNoValue(branch))
      .flatMap((branch) => expand(branch));
  }
  return [value];
}

// IAM accepts a scalar or a list anywhere a list is allowed; both normalise to
// the same flat list of concrete values.
function asList(value: unknown): unknown[] {
  if (value === undefined) return [];
  return expand(value)
    .flatMap((entry) => (Array.isArray(entry) ? entry : [entry]))
    .flatMap((entry) => expand(entry))
    .filter((entry) => entry !== undefined && !isNoValue(entry));
}

function getAttParts(
  value: unknown
): { logicalId: string; attribute: string } | undefined {
  const attribute = intrinsic(value, "Fn::GetAtt");
  const parts =
    typeof attribute === "string"
      ? attribute.split(".")
      : Array.isArray(attribute) &&
          attribute.every((part) => typeof part === "string")
        ? (attribute as string[])
        : undefined;
  if (!parts || parts.length === 0) return undefined;
  const [logicalId, ...rest] = parts;
  return { logicalId, attribute: rest.join(".") };
}

// The literal text a value contributes, if it has one: a plain string or the
// body of an Fn::Sub.
function literalText(value: unknown): string | undefined {
  if (typeof value === "string") return resolvePlaceholders(value);
  const sub = intrinsic(value, "Fn::Sub");
  if (typeof sub === "string") return resolvePlaceholders(sub);
  if (Array.isArray(sub) && typeof sub[0] === "string") {
    return resolvePlaceholders(sub[0]);
  }
  return undefined;
}

function resourceType(
  resources: Record<string, unknown>,
  logicalId: string
): string | undefined {
  const resource = resources[logicalId];
  return isRecord(resource) && typeof resource.Type === "string"
    ? resource.Type
    : undefined;
}

// Ref on an AWS::SNS::Topic and Fn::GetAtt <topic>.TopicArn both yield the
// topic ARN, so both have to compare equal to the same topic.
function topicIdentity(
  value: unknown,
  resources: Record<string, unknown>
): string {
  const reference = intrinsic(value, "Ref");
  if (typeof reference === "string") {
    return resourceType(resources, reference) === "AWS::SNS::Topic"
      ? `topic:${reference}`
      : `ref:${reference}`;
  }
  const getAtt = getAttParts(value);
  if (getAtt) {
    return getAtt.attribute === "TopicArn" &&
      resourceType(resources, getAtt.logicalId) === "AWS::SNS::Topic"
      ? `topic:${getAtt.logicalId}`
      : `getatt:${getAtt.logicalId}.${getAtt.attribute}`;
  }
  const text = literalText(value);
  if (text !== undefined) return `literal:${text}`;
  return `value:${JSON.stringify(value)}`;
}

// Renders a value the way the template author wrote it, so a failure reads
// like the source it points at.
function describe(value: unknown): string {
  const reference = intrinsic(value, "Ref");
  if (typeof reference === "string") return `!Ref ${reference}`;
  const getAtt = getAttParts(value);
  if (getAtt) return `!GetAtt ${getAtt.logicalId}.${getAtt.attribute}`;
  const sub = intrinsic(value, "Fn::Sub");
  if (typeof sub === "string") return `!Sub ${sub}`;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

interface PolicyResource {
  path: string;
  logicalId: string;
  properties: Record<string, unknown>;
  resources: Record<string, unknown>;
}

interface Template {
  path: string;
  resources: Record<string, unknown>;
  errors: string[];
  warnings: string[];
}

export function parseTemplate(path: string, source: string): Template {
  const document = parseDocument(source, { customTags: cfnCustomTags() });
  const value: unknown = document.errors.length === 0 ? document.toJS() : undefined;
  const resources =
    isRecord(value) && isRecord(value.Resources) ? value.Resources : {};
  return {
    path,
    resources,
    errors: document.errors.map((error) => error.message),
    warnings: document.warnings.map((warning) => warning.message),
  };
}

function yamlFilesUnder(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory).sort()) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...yamlFilesUnder(path));
    else if (/\.ya?ml$/iu.test(entry)) files.push(path);
  }
  return files;
}

// Discovery, never a hardcoded list: any YAML under aws/ carrying a Resources
// map of typed resources is a CloudFormation template and is inspected.
export function discoverTemplates(root = TEMPLATE_ROOT): Template[] {
  return yamlFilesUnder(root)
    .map((path) =>
      parseTemplate(
        relative(ROOT, path).split(sep).join("/"),
        readFileSync(path, "utf8")
      )
    )
    .filter(({ resources }) =>
      Object.values(resources).some(
        (resource) =>
          isRecord(resource) &&
          typeof resource.Type === "string" &&
          RESOURCE_TYPE.test(resource.Type)
      )
    );
}

function resourcesOfType(
  templates: Template[],
  type: string
): PolicyResource[] {
  return templates.flatMap(({ path, resources }) =>
    Object.entries(resources)
      .filter(
        ([, resource]) => isRecord(resource) && resource.Type === type
      )
      .map(([logicalId, resource]) => ({
        path,
        logicalId,
        properties:
          isRecord(resource) && isRecord(resource.Properties)
            ? resource.Properties
            : {},
        resources,
      }))
  );
}

// Statement-level, not resource-level: `Condition: EnableAlarmRouting` on the
// resource is a condition name, while `Condition:` inside a statement is the
// IAM condition block. Only the policy document is read here.
function statementsOf(policyDocument: unknown): Record<string, unknown>[] {
  return expand(policyDocument)
    .filter(isRecord)
    .flatMap((document) => asList(document.Statement))
    .filter(isRecord);
}

function statementLabel(
  statement: Record<string, unknown>,
  index: number
): string {
  return typeof statement.Sid === "string"
    ? `statement ${statement.Sid}`
    : `statement #${index + 1}`;
}

export function snsTopicCardinalityViolations(templates: Template[]): string[] {
  const violations: string[] = [];
  for (const policy of resourcesOfType(templates, "AWS::SNS::TopicPolicy")) {
    const topics = asList(policy.properties.Topics);
    if (topics.length === 1) continue;
    violations.push(
      `${policy.path} → ${policy.logicalId}: Topics names ${topics.length} ` +
        `topics (${topics.map(describe).join(", ") || "none"}). AWS rule: SNS ` +
        `applies a topic policy document to each listed topic in turn and ` +
        `rejects any statement naming a topic other than the one being ` +
        `configured — "Invalid parameter: Policy statement must apply to a ` +
        `single resource!" — so one document can only ever be valid for exactly ` +
        `one topic. Give each topic its own AWS::SNS::TopicPolicy.`
    );
  }
  return violations;
}

export function snsTopicResourceViolations(templates: Template[]): string[] {
  const violations: string[] = [];
  for (const policy of resourcesOfType(templates, "AWS::SNS::TopicPolicy")) {
    const topics = asList(policy.properties.Topics);
    const configured =
      topics.length === 1
        ? expand(topics[0]).map((topic) =>
            topicIdentity(topic, policy.resources)
          )
        : undefined;
    const configuredLabel =
      topics.length === 1 ? describe(topics[0]) : "no single topic";
    statementsOf(policy.properties.PolicyDocument).forEach(
      (statement, index) => {
        const label = statementLabel(statement, index);
        const named = asList(statement.Resource);
        if (named.length !== 1) {
          violations.push(
            `${policy.path} → ${policy.logicalId} ${label}: Resource names ` +
              `${named.length} resources ` +
              `(${named.map(describe).join(", ") || "none"}). AWS rule: an SNS ` +
              `topic policy statement must apply to exactly one resource — the ` +
              `topic being configured — "Invalid parameter: Policy statement ` +
              `must apply to a single resource!"`
          );
          return;
        }
        if (!configured) return;
        const identity = topicIdentity(named[0], policy.resources);
        if (configured.includes(identity)) return;
        violations.push(
          `${policy.path} → ${policy.logicalId} ${label}: Resource is ` +
            `${describe(named[0])} but the policy configures ` +
            `${configuredLabel}. AWS rule: SNS rejects a policy statement that ` +
            `names any topic other than the one being configured — "Invalid ` +
            `parameter: Policy statement must apply to a single resource!"`
        );
      }
    );
  }
  return violations;
}

export function snsTopicActionViolations(templates: Template[]): string[] {
  const violations: string[] = [];
  const allowed = new Set(
    SNS_TOPIC_POLICY_ACTIONS.map((action) => action.toLowerCase())
  );
  for (const policy of resourcesOfType(templates, "AWS::SNS::TopicPolicy")) {
    statementsOf(policy.properties.PolicyDocument).forEach(
      (statement, index) => {
        const label = statementLabel(statement, index);
        for (const action of asList(statement.Action)) {
          const name = typeof action === "string" ? action : describe(action);
          if (allowed.has(name.toLowerCase())) continue;
          violations.push(
            `${policy.path} → ${policy.logicalId} ${label}: Action ${name} is ` +
              `not a topic-level SNS action. AWS rule: a topic resource policy ` +
              `accepts only the topic-scoped actions listed under "Valid ` +
              `Amazon SNS policy actions" — ` +
              `${SNS_TOPIC_POLICY_ACTIONS.join(", ")} — and rejects every ` +
              `wildcard form and every account-level action (sns:CreateTopic, ` +
              `sns:ListTopics) outright: "Invalid parameter: Policy statement ` +
              `action out of service scope!". See ` +
              `https://docs.aws.amazon.com/sns/latest/dg/sns-access-policy-language-api-permissions-reference.html`
          );
        }
      }
    );
  }
  return violations;
}

function kmsAliasComparison(
  value: unknown,
  resources: Record<string, unknown>
): string | undefined {
  const text = literalText(value);
  if (text !== undefined && KMS_ALIAS_ARN.test(text)) {
    return `the alias ARN ${describe(value)}`;
  }
  if (text !== undefined && KMS_ALIAS_NAME.test(text)) {
    return `the alias name ${describe(value)}`;
  }
  const reference = intrinsic(value, "Ref");
  if (
    typeof reference === "string" &&
    resourceType(resources, reference) === "AWS::KMS::Alias"
  ) {
    return `!Ref ${reference}, an AWS::KMS::Alias resource`;
  }
  const getAtt = getAttParts(value);
  if (
    getAtt &&
    resourceType(resources, getAtt.logicalId) === "AWS::KMS::Alias"
  ) {
    return (
      `!GetAtt ${getAtt.logicalId}.${getAtt.attribute}, ` +
      `an AWS::KMS::Alias resource`
    );
  }
  return undefined;
}

export function s3KmsAliasConditionViolations(
  templates: Template[]
): string[] {
  const violations: string[] = [];
  for (const policy of resourcesOfType(templates, "AWS::S3::BucketPolicy")) {
    statementsOf(policy.properties.PolicyDocument).forEach(
      (statement, index) => {
        const label = statementLabel(statement, index);
        for (const block of expand(statement.Condition).filter(isRecord)) {
          for (const [operator, comparisons] of Object.entries(block)) {
            for (const comparison of expand(comparisons).filter(isRecord)) {
              for (const [key, compared] of Object.entries(comparison)) {
                if (key.toLowerCase() !== SSE_KMS_KEY_ID_CONDITION_KEY) continue;
                for (const value of asList(compared)) {
                  const alias = kmsAliasComparison(value, policy.resources);
                  if (!alias) continue;
                  violations.push(
                    `${policy.path} → ${policy.logicalId} ${label}: ` +
                      `${operator} on ${SSE_KMS_KEY_ID_CONDITION_KEY} compares ` +
                      `against ${alias}. AWS rule: S3 resolves a KMS alias to ` +
                      `its key ARN before evaluating this condition key, so the ` +
                      `comparison can never be true — a Deny then locks the ` +
                      `bucket for every principal and an Allow never grants. ` +
                      `Compare the key ARN instead; callers may keep passing ` +
                      `the alias.`
                  );
                }
              }
            }
          }
        }
      }
    );
  }
  return violations;
}

function report(violations: string[]): string {
  return ["", ...violations].join("\n");
}

const TEMPLATES = discoverTemplates();

test("every CloudFormation template under aws/ is discovered and fully resolved", () => {
  const discovered = TEMPLATES.map(({ path }) => path);
  for (const expected of ["aws/template.yaml", "aws/bootstrap-oidc.yaml"]) {
    assert.ok(
      discovered.includes(expected),
      `${expected} was not discovered (found ${discovered.join(", ")}). The ` +
        `oracle is only as wide as its discovery: a template it cannot see is ` +
        `a template AWS gets to reject first.`
    );
  }
  const unresolved = TEMPLATES.filter(
    ({ errors, warnings }) => errors.length > 0 || warnings.length > 0
  ).map(
    ({ path, errors, warnings }) =>
      `${path}: ${[...errors, ...warnings]
        .map((message) => message.split("\n")[0])
        .join("; ")}`
  );
  assert.deepEqual(
    unresolved,
    [],
    report([
      ...unresolved,
      "An unregistered YAML tag does not throw — it silently degrades to its " +
        "scalar value, which would make the checks below inspect a string " +
        "where an intrinsic was written. Add the tag to INTRINSIC_TAGS.",
    ])
  );
});

test("the oracle inspects at least one SNS topic policy and one S3 bucket policy", () => {
  const topicPolicies = resourcesOfType(TEMPLATES, "AWS::SNS::TopicPolicy");
  const bucketPolicies = resourcesOfType(TEMPLATES, "AWS::S3::BucketPolicy");
  assert.ok(
    topicPolicies.length > 0,
    "No AWS::SNS::TopicPolicy was found under aws/. Either the templates " +
      "changed shape or discovery broke; an oracle that inspects nothing " +
      "passes everything."
  );
  assert.ok(
    bucketPolicies.length > 0,
    "No AWS::S3::BucketPolicy was found under aws/. Either the templates " +
      "changed shape or discovery broke; an oracle that inspects nothing " +
      "passes everything."
  );
});

test("every AWS::SNS::TopicPolicy configures exactly one topic", () => {
  const violations = snsTopicCardinalityViolations(TEMPLATES);
  assert.deepEqual(violations, [], report(violations));
});

test("every AWS::SNS::TopicPolicy statement names only the topic it configures", () => {
  const violations = snsTopicResourceViolations(TEMPLATES);
  assert.deepEqual(violations, [], report(violations));
});

test("every AWS::SNS::TopicPolicy action is a topic-scoped SNS action", () => {
  const violations = snsTopicActionViolations(TEMPLATES);
  assert.deepEqual(violations, [], report(violations));
});

test("no AWS::S3::BucketPolicy compares the SSE-KMS key id against a KMS alias", () => {
  const violations = s3KmsAliasConditionViolations(TEMPLATES);
  assert.deepEqual(violations, [], report(violations));
});

// Negative fixtures — the shapes AWS actually rejected, kept here so a future
// change cannot quietly blunt the oracle. Each fixture is the pre-fix template
// text from the PR named beside it, keeping the shape features that make the
// real templates harder to read than a minimal example: a resource-level
// Condition next to statement-level ones, interleaved statements, and folded
// block scalars.
const FIXTURE_TOPICS = `
AWSTemplateFormatVersion: "2010-09-09"
Resources:
  StagingAlarmTopic:
    Type: AWS::SNS::Topic
  ProductionAlarmTopic:
    Type: AWS::SNS::Topic
  AlarmTopicPolicy:
    Type: AWS::SNS::TopicPolicy
    Condition: EnableAlarmRouting
    DeletionPolicy: RetainExceptOnCreate
    Properties:
      Topics:
        - !Ref StagingAlarmTopic
        - !Ref ProductionAlarmTopic
      PolicyDocument:
        Version: "2012-10-17"
        Statement:
          - Sid: AllowAccountTopicAdministration
            Effect: Allow
            Principal:
              AWS: !Sub "arn:\${AWS::Partition}:iam::\${AWS::AccountId}:root"
            Action: sns:Publish
            Resource:
              - !Ref StagingAlarmTopic
              - !Ref ProductionAlarmTopic
          - Sid: AllowStagingCloudWatchAlarmPublish
            Effect: Allow
            Principal:
              Service: cloudwatch.amazonaws.com
            Action: sns:Publish
            Resource: !Ref StagingAlarmTopic
            Condition:
              ArnLike:
                aws:SourceArn: !Sub >-
                  arn:\${AWS::Partition}:cloudwatch:\${AWS::Region}:\${AWS::AccountId}:alarm:\${AppName}-staging-*
`;

const FIXTURE_WILDCARD_ACTION = `
AWSTemplateFormatVersion: "2010-09-09"
Resources:
  StagingAlarmTopic:
    Type: AWS::SNS::Topic
  StagingAlarmTopicPolicy:
    Type: AWS::SNS::TopicPolicy
    Condition: EnableAlarmRouting
    DeletionPolicy: RetainExceptOnCreate
    Properties:
      Topics:
        - !Ref StagingAlarmTopic
      PolicyDocument:
        Version: "2012-10-17"
        Statement:
          - Sid: DenyInsecureTransport
            Effect: Deny
            Principal: "*"
            Action: sns:*
            Resource: !Ref StagingAlarmTopic
            Condition:
              Bool:
                aws:SecureTransport: "false"
`;

// An account-level action names no topic, so it is only ever valid in an
// identity policy. It is the shape a reader is most likely to reach for when
// widening a topic policy, and the allowlist has to keep rejecting it.
const FIXTURE_ACCOUNT_LEVEL_ACTION = `
AWSTemplateFormatVersion: "2010-09-09"
Resources:
  StagingAlarmTopic:
    Type: AWS::SNS::Topic
  StagingAlarmTopicPolicy:
    Type: AWS::SNS::TopicPolicy
    Properties:
      Topics:
        - !Ref StagingAlarmTopic
      PolicyDocument:
        Version: "2012-10-17"
        Statement:
          - Sid: AllowAccountTopicAdministration
            Effect: Allow
            Principal: "*"
            Action:
              - sns:CreateTopic
              - sns:ListTopics
            Resource: !Ref StagingAlarmTopic
`;

// Fn::If resolves to one branch at deploy time, so a rule that only holds on
// the branch that happens to be taken is not a rule the template satisfies.
const FIXTURE_CONDITIONAL_BRANCH = `
AWSTemplateFormatVersion: "2010-09-09"
Resources:
  StagingAlarmTopic:
    Type: AWS::SNS::Topic
  StagingAlarmTopicPolicy:
    Type: AWS::SNS::TopicPolicy
    Properties:
      Topics:
        - !Ref StagingAlarmTopic
      PolicyDocument:
        Version: "2012-10-17"
        Statement:
          - Sid: DenyInsecureTransport
            Effect: Deny
            Principal: "*"
            Action: !If
              - BroadDenyEnabled
              - sns:*
              - sns:Publish
            Resource: !Ref StagingAlarmTopic
`;

const FIXTURE_ALIAS_ARN = `
AWSTemplateFormatVersion: "2010-09-09"
Resources:
  ArtifactBucket:
    Type: AWS::S3::Bucket
  ArtifactBucketPolicy:
    Type: AWS::S3::BucketPolicy
    Properties:
      Bucket: !Ref ArtifactBucket
      PolicyDocument:
        Version: "2012-10-17"
        Statement:
          - Sid: DenyArtifactWritesWithUnexpectedKmsKey
            Effect: Deny
            Principal: "*"
            Action: s3:PutObject
            Resource: !Sub "\${ArtifactBucket.Arn}/*"
            Condition:
              StringNotEquals:
                s3:x-amz-server-side-encryption-aws-kms-key-id: !Sub >-
                  arn:\${AWS::Partition}:kms:\${AWS::Region}:\${AWS::AccountId}:alias/\${AppName}-storage
`;

const FIXTURE_ALIAS_REFERENCE = `
AWSTemplateFormatVersion: "2010-09-09"
Resources:
  ApplicationStorageKeyAlias:
    Type: AWS::KMS::Alias
  ArtifactBucket:
    Type: AWS::S3::Bucket
  ArtifactBucketPolicy:
    Type: AWS::S3::BucketPolicy
    Properties:
      Bucket: !Ref ArtifactBucket
      PolicyDocument:
        Version: "2012-10-17"
        Statement:
          - Sid: DenyArtifactWritesWithUnexpectedKmsKey
            Effect: Deny
            Principal: "*"
            Action: s3:PutObject
            Resource: !Sub "\${ArtifactBucket.Arn}/*"
            Condition:
              StringNotEquals:
                s3:x-amz-server-side-encryption-aws-kms-key-id: !Ref ApplicationStorageKeyAlias
`;

// The shipped shapes, proving the oracle accepts what AWS accepts.
const FIXTURE_ACCEPTED = `
AWSTemplateFormatVersion: "2010-09-09"
Resources:
  ApplicationStorageKey:
    Type: AWS::KMS::Key
  StagingAlarmTopic:
    Type: AWS::SNS::Topic
  StagingAlarmTopicPolicy:
    Type: AWS::SNS::TopicPolicy
    Properties:
      Topics:
        - !Ref StagingAlarmTopic
      PolicyDocument:
        Version: "2012-10-17"
        Statement:
          - Sid: DenyInsecureTransport
            Effect: Deny
            Principal: "*"
            Action:
              - sns:AddPermission
              - sns:DeleteTopic
              - sns:GetTopicAttributes
              - sns:ListSubscriptionsByTopic
              - sns:Publish
              - sns:RemovePermission
              - sns:SetTopicAttributes
              - sns:Subscribe
            Resource: !Ref StagingAlarmTopic
          - Sid: AllowCloudWatchAlarmPublish
            Effect: Allow
            Principal:
              Service: cloudwatch.amazonaws.com
            Action: sns:Publish
            Resource: !GetAtt StagingAlarmTopic.TopicArn
  ArtifactBucket:
    Type: AWS::S3::Bucket
  ArtifactBucketPolicy:
    Type: AWS::S3::BucketPolicy
    Properties:
      Bucket: !Ref ArtifactBucket
      PolicyDocument:
        Version: "2012-10-17"
        Statement:
          - Sid: DenyArtifactWritesWithUnexpectedKmsKey
            Effect: Deny
            Principal: "*"
            Action: s3:PutObject
            Resource: !Sub "\${ArtifactBucket.Arn}/*"
            Condition:
              StringNotEquals:
                s3:x-amz-server-side-encryption-aws-kms-key-id: !GetAtt ApplicationStorageKey.Arn
          - Sid: DenySpaWritesWithUnexpectedKmsKey
            Effect: Deny
            Principal: "*"
            Action: s3:PutObject
            Resource: !Sub "\${ArtifactBucket.Arn}/*"
            Condition:
              StringNotEquals:
                s3:x-amz-server-side-encryption-aws-kms-key-id:
                  Fn::ImportValue: !Sub "\${AppName}-storage-kms-key-arn"
`;

function fixture(source: string): Template[] {
  const template = parseTemplate("fixture.yaml", source);
  assert.deepEqual(template.errors, []);
  assert.deepEqual(template.warnings, []);
  return [template];
}

test("the oracle rejects the multi-topic policy SNS rejected (PR #82)", () => {
  const templates = fixture(FIXTURE_TOPICS);
  assert.equal(snsTopicCardinalityViolations(templates).length, 1);
  assert.equal(snsTopicResourceViolations(templates).length, 1);
});

test("the oracle rejects the sns:* wildcard SNS rejected (PR #84)", () => {
  const templates = fixture(FIXTURE_WILDCARD_ACTION);
  assert.equal(snsTopicActionViolations(templates).length, 1);
  assert.deepEqual(snsTopicCardinalityViolations(templates), []);
  assert.deepEqual(snsTopicResourceViolations(templates), []);
});

test("the oracle rejects account-level actions that name no topic", () => {
  const templates = fixture(FIXTURE_ACCOUNT_LEVEL_ACTION);
  const violations = snsTopicActionViolations(templates);
  assert.equal(violations.length, 2);
  assert.match(
    violations[0],
    /Action sns:CreateTopic is not a topic-level SNS action/u
  );
  assert.match(
    violations[1],
    /Action sns:ListTopics is not a topic-level SNS action/u
  );
});

test("the oracle reads both branches of an Fn::If, not the convenient one", () => {
  const templates = fixture(FIXTURE_CONDITIONAL_BRANCH);
  const violations = snsTopicActionViolations(templates);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /Action sns:\* is not a topic-level SNS action/u);
});

test("the oracle rejects the KMS alias comparison S3 could never satisfy (PR #83)", () => {
  for (const source of [FIXTURE_ALIAS_ARN, FIXTURE_ALIAS_REFERENCE]) {
    assert.equal(s3KmsAliasConditionViolations(fixture(source)).length, 1);
  }
});

test("the oracle accepts the shapes AWS accepts", () => {
  const templates = fixture(FIXTURE_ACCEPTED);
  assert.deepEqual(snsTopicCardinalityViolations(templates), []);
  assert.deepEqual(snsTopicResourceViolations(templates), []);
  assert.deepEqual(snsTopicActionViolations(templates), []);
  assert.deepEqual(s3KmsAliasConditionViolations(templates), []);
});
