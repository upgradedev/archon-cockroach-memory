import assert from "node:assert/strict";
import { test } from "node:test";
import { handler } from "../src/lambda.js";

function event(
  method: string,
  path: string,
  body?: string,
  contentType = "application/json",
  stage?: string
) {
  return {
    requestContext: { stage, http: { method } },
    rawPath: path,
    headers: { "content-type": contentType },
    body,
  };
}

test("Lambda adapter safely rejects JSON null before any dependency call", async () => {
  const result = await handler(event("POST", "/api/recall", "null"));
  assert.equal(result.statusCode, 400);
  assert.deepEqual(JSON.parse(result.body), {
    error: "`question` (non-empty string) is required.",
  });
});

test("Lambda adapter enforces POST JSON and bounded bodies", async () => {
  assert.equal(
    (await handler(event("GET", "/api/recall"))).statusCode,
    405
  );
  assert.equal(
    (
      await handler(
        event("POST", "/api/recall", "question=x", "application/x-www-form-urlencoded")
      )
    ).statusCode,
    415
  );
  assert.equal(
    (
      await handler(
        event(
          "POST",
          "/api/recall",
          JSON.stringify({ question: "x".repeat(5_000) })
        )
      )
    ).statusCode,
    413
  );
});

test("Lambda liveness is explicit that dependencies were not checked", async () => {
  const result = await handler(event("GET", "/api/health"));
  assert.equal(result.statusCode, 200);
  const body = JSON.parse(result.body) as Record<string, unknown>;
  assert.equal(body.status, "reachable");
  assert.equal(body.dependencies, "unchecked");
});

test("Lambda adapter strips only the exact trusted named-stage prefix", async () => {
  const namedStageHealth = await handler(
    event(
      "GET",
      "/live/api/health",
      undefined,
      "application/json",
      "live"
    )
  );
  assert.equal(namedStageHealth.statusCode, 200);

  const alreadyRelativeHealth = await handler(
    event(
      "GET",
      "/api/health",
      undefined,
      "application/json",
      "live"
    )
  );
  assert.equal(alreadyRelativeHealth.statusCode, 200);

  const stagedRecall = await handler(
    event(
      "POST",
      "/live/api/recall",
      "null",
      "application/json",
      "live"
    )
  );
  assert.equal(stagedRecall.statusCode, 400);

  const untrustedPrefix = await handler(
    event(
      "GET",
      "/other/api/health",
      undefined,
      "application/json",
      "live"
    )
  );
  assert.equal(untrustedPrefix.statusCode, 404);

  const defaultStageDoesNotStrip = await handler(
    event(
      "GET",
      "/live/api/health",
      undefined,
      "application/json",
      "$default"
    )
  );
  assert.equal(defaultStageDoesNotStrip.statusCode, 404);
});

test("Lambda can fail closed against direct origin bypass without exposing the capability", async () => {
  const previous = process.env.ORIGIN_VERIFY_TOKEN;
  const capability = "A".repeat(43);
  process.env.ORIGIN_VERIFY_TOKEN = capability;
  try {
    const missing = await handler(event("GET", "/api/health"));
    assert.equal(missing.statusCode, 403);
    assert.deepEqual(JSON.parse(missing.body), { error: "forbidden" });
    assert.doesNotMatch(missing.body, new RegExp(capability, "u"));

    const wrong = {
      ...event("GET", "/api/health"),
      headers: {
        "content-type": "application/json",
        "x-archon-origin-verify": "B".repeat(43),
      },
    };
    assert.equal((await handler(wrong)).statusCode, 403);

    const throughCloudFront = {
      ...event("GET", "/api/health"),
      headers: {
        "content-type": "application/json",
        "x-archon-origin-verify": capability,
      },
    };
    assert.equal((await handler(throughCloudFront)).statusCode, 200);
  } finally {
    if (previous === undefined) {
      delete process.env.ORIGIN_VERIFY_TOKEN;
    } else {
      process.env.ORIGIN_VERIFY_TOKEN = previous;
    }
  }
});
