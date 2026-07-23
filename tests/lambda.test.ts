import assert from "node:assert/strict";
import { test } from "node:test";
import { handler } from "../src/lambda.js";

function event(
  method: string,
  path: string,
  body?: string,
  contentType = "application/json"
) {
  return {
    requestContext: { http: { method } },
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
