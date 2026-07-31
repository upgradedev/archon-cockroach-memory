import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string): string =>
  readFileSync(join(root, path), "utf8");

test("CloudFront WAF IaC is explicit, bounded, and us-east-1 control-plane only", () => {
  const template = read("aws/edge-waf.yaml");
  assert.match(
    template,
    /CloudFrontWafControlPlaneRegion:[\s\S]*?Assert:\s*!Equals\s*\[!Ref "AWS::Region", us-east-1\]/u
  );
  assert.match(template, /Scope:\s*CLOUDFRONT/u);
  for (const group of [
    "AWSManagedRulesAmazonIpReputationList",
    "AWSManagedRulesKnownBadInputsRuleSet",
    "AWSManagedRulesCommonRuleSet",
  ]) {
    assert.match(template, new RegExp(`Name:\\s*${group}`, "u"));
  }
  assert.match(
    template,
    /Name:\s*ApiAggregateRate[\s\S]*?RateBasedStatement:[\s\S]*?EvaluationWindowSec:\s*300[\s\S]*?Limit:\s*!Ref ApiAggregateRateLimit[\s\S]*?SearchString:\s*\/api\//u
  );
  assert.match(
    template,
    /Name:\s*ResolutionCreateRate[\s\S]*?RateBasedStatement:[\s\S]*?Limit:\s*!Ref ResolutionCreateRateLimit[\s\S]*?SearchString:\s*\/api\/resolution\/session[\s\S]*?SearchString:\s*POST/u
  );
  assert.doesNotMatch(template, /us-west-2/iu);
  assert.match(
    template,
    /ApprovalBoundary[\s\S]*?explicit-live-activation-required/u
  );
});

test("regional stack keeps WAF and direct-origin restriction dormant by default", () => {
  const template = read("aws/template.yaml");
  assert.match(
    template,
    /CloudFrontWebAclArn:[\s\S]*?Default:\s*""[\s\S]*?wafv2:us-east-1/u
  );
  assert.match(
    template,
    /OriginVerifyToken:[\s\S]*?NoEcho:\s*true[\s\S]*?Default:\s*""/u
  );
  assert.match(
    template,
    /EdgeProtectionActivationIsCoupled:[\s\S]*?CloudFrontWebAclArn[\s\S]*?OriginVerifyToken[\s\S]*?both remain empty or[\s\S]*?both be activated/u
  );
  assert.match(
    template,
    /WebACLId:\s*!If[\s\S]*?HasCloudFrontWebAcl[\s\S]*?!Ref CloudFrontWebAclArn[\s\S]*?!Ref "AWS::NoValue"/u
  );
  assert.match(
    template,
    /OriginCustomHeaders:\s*!If[\s\S]*?HasOriginVerifyToken[\s\S]*?HeaderName:\s*x-archon-origin-verify[\s\S]*?HeaderValue:\s*!Ref OriginVerifyToken[\s\S]*?!Ref "AWS::NoValue"/u
  );
  assert.match(template, /ORIGIN_VERIFY_TOKEN:\s*!Ref OriginVerifyToken/u);

  const deploy = read(".github/workflows/deploy-aws.yml");
  assert.doesNotMatch(deploy, /edge-waf\.yaml/u);
});

test("Lambda enforces the optional origin capability before route handling", () => {
  const lambda = read("src/lambda.ts");
  assert.match(lambda, /timingSafeEqual/u);
  assert.match(
    lambda,
    /originCapabilityMatches\(header\("x-archon-origin-verify"\)\)[\s\S]*?return json\(403, \{ error: "forbidden" \}\)/u
  );
  const tests = read("tests/lambda.test.ts");
  assert.match(
    tests,
    /fail closed against direct origin bypass[\s\S]*?statusCode, 403[\s\S]*?statusCode, 200/u
  );
});
