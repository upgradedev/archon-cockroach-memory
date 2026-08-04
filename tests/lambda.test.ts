import assert from "node:assert/strict";
import { after, test } from "node:test";
import { handler } from "../src/lambda.js";
import {
  HEALTH_PROBE_CACHE_MS,
  handleHealth,
  resetHealthProbeCache,
  type HealthProbeDependencies,
} from "../src/http/handler.js";
import { closePool } from "../src/db/client.js";

const FIXED_NOW = 1_700_000_000_000;

// The health route now performs a real dependency read, so a suite that touches
// it can open the runtime pool. Close it or the process lingers on the pg
// keep-alive socket.
after(async () => {
  resetHealthProbeCache();
  await closePool();
});

function healthProbe(
  overrides: Partial<HealthProbeDependencies> = {}
): HealthProbeDependencies {
  return {
    configured: () => true,
    probe: async () => [{ health_probe: 1 }],
    now: () => FIXED_NOW,
    ...overrides,
  };
}

function healthBody(body: Record<string, unknown>): {
  ok: unknown;
  status: unknown;
  dependencies: unknown;
  database: Record<string, unknown>;
  inference: Record<string, unknown>;
} {
  const checks = body.checks as Record<string, unknown>;
  return {
    ok: body.ok,
    status: body.status,
    dependencies: body.dependencies,
    database: checks.database as Record<string, unknown>,
    inference: checks.inference as Record<string, unknown>,
  };
}

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

test("health reports a healthy database as ready", async () => {
  resetHealthProbeCache();
  const result = await handleHealth(healthProbe());
  assert.equal(result.status, 200);
  const health = healthBody(result.body);
  assert.equal(health.ok, true);
  assert.equal(health.status, "reachable");
  assert.equal(health.dependencies, "ready");
  assert.equal(health.database.state, "reachable");
  assert.equal(health.database.engine, "CockroachDB");
  assert.equal(health.database.checkedAt, new Date(FIXED_NOW).toISOString());
  // Configuration state only — a public health endpoint must never be a free
  // trigger for a billable Bedrock call.
  assert.equal(
    health.inference.state,
    process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE
      ? "configured"
      : "not-configured"
  );
});

// The regression this endpoint exists to prevent: a two-day CockroachDB outage
// in which /api/proof, /api/audit, and POST /api/recall all returned 500 while
// health still answered ok:true.
test("health degrades — and stays HTTP 200 — when CockroachDB is unreachable", async () => {
  resetHealthProbeCache();
  const result = await handleHealth(
    healthProbe({
      probe: async () => {
        throw new Error(
          "connect ECONNREFUSED archon-secret-host.cockroachlabs.cloud:26257"
        );
      },
    })
  );
  assert.equal(result.status, 200);
  const health = healthBody(result.body);
  assert.equal(health.ok, false);
  assert.equal(health.dependencies, "degraded");
  assert.equal(health.database.state, "unreachable");
  // Driver errors carry hostnames and principals; none of it may reach a
  // public unauthenticated response.
  const serialized = JSON.stringify(result.body);
  assert.equal(serialized.includes("ECONNREFUSED"), false);
  assert.equal(serialized.includes("cockroachlabs.cloud"), false);
});

test("health never hangs on a database that never answers", async () => {
  resetHealthProbeCache();
  const started = Date.now();
  const result = await handleHealth(
    healthProbe({ probe: () => new Promise<never>(() => undefined) })
  );
  const elapsed = Date.now() - started;
  assert.equal(result.status, 200);
  assert.equal(healthBody(result.body).dependencies, "degraded");
  assert.ok(
    elapsed < 15_000,
    `health must return within its own probe budget, took ${elapsed}ms`
  );
});

test("health reports an unconfigured database as unchecked without probing", async () => {
  resetHealthProbeCache();
  let probes = 0;
  const result = await handleHealth(
    healthProbe({
      configured: () => false,
      probe: async () => {
        probes += 1;
        return [];
      },
    })
  );
  assert.equal(probes, 0);
  const health = healthBody(result.body);
  assert.equal(health.ok, true);
  assert.equal(health.dependencies, "unchecked");
  assert.equal(health.database.state, "not-configured");
});

test("health caches the probe so a masthead burst costs one round trip", async () => {
  resetHealthProbeCache();
  let probes = 0;
  const counting = healthProbe({
    probe: async () => {
      probes += 1;
      return [];
    },
  });
  await Promise.all([
    handleHealth(counting),
    handleHealth(counting),
    handleHealth(counting),
  ]);
  assert.equal(probes, 1);
  await handleHealth(counting);
  assert.equal(probes, 1);
  await handleHealth({
    ...counting,
    now: () => FIXED_NOW + HEALTH_PROBE_CACHE_MS + 1,
  });
  assert.equal(probes, 2);
});

test("Lambda liveness answers 200 and publishes its dependency verdict", async () => {
  resetHealthProbeCache();
  const result = await handler(event("GET", "/api/health"));
  assert.equal(result.statusCode, 200);
  const body = JSON.parse(result.body) as Record<string, unknown>;
  const health = healthBody(body);
  assert.equal(health.status, "reachable");
  assert.ok(
    ["ready", "degraded", "unchecked"].includes(String(health.dependencies)),
    `unexpected dependency verdict: ${String(health.dependencies)}`
  );
  assert.equal(health.ok, health.dependencies !== "degraded");
  assert.ok(
    ["reachable", "unreachable", "not-configured"].includes(
      String(health.database.state)
    ),
    `unexpected database state: ${String(health.database.state)}`
  );
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

test("deployed environments reject missing, blank, or malformed origin capability", async () => {
  const previousToken = process.env.ORIGIN_VERIFY_TOKEN;
  const previousEnvironment = process.env.APP_ENV;
  try {
    for (const environment of ["staging", "production"] as const) {
      process.env.APP_ENV = environment;
      delete process.env.ORIGIN_VERIFY_TOKEN;
      assert.equal((await handler(event("GET", "/api/health"))).statusCode, 403);

      process.env.ORIGIN_VERIFY_TOKEN = "   ";
      assert.equal((await handler(event("GET", "/api/health"))).statusCode, 403);

      process.env.ORIGIN_VERIFY_TOKEN = "too-short";
      const malformed = {
        ...event("GET", "/api/health"),
        headers: {
          "content-type": "application/json",
          "x-archon-origin-verify": "too-short",
        },
      };
      assert.equal((await handler(malformed)).statusCode, 403);
    }

    process.env.APP_ENV = "local";
    delete process.env.ORIGIN_VERIFY_TOKEN;
    assert.equal((await handler(event("GET", "/api/health"))).statusCode, 200);
  } finally {
    if (previousToken === undefined) {
      delete process.env.ORIGIN_VERIFY_TOKEN;
    } else {
      process.env.ORIGIN_VERIFY_TOKEN = previousToken;
    }
    if (previousEnvironment === undefined) {
      delete process.env.APP_ENV;
    } else {
      process.env.APP_ENV = previousEnvironment;
    }
  }
});
