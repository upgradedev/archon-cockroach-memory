import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  runHostedDast,
  writeHostedDastReceipt,
} from "../scripts/hosted-dast.mjs";

const securityHeaders = {
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'self'; frame-ancestors 'none'; object-src 'none'",
  "content-type": "application/json",
  "cross-origin-embedder-policy": "require-corp",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "referrer-policy": "strict-origin-when-cross-origin",
  "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};
const gatewaySecurityHeaders = Object.fromEntries(
  Object.entries(securityHeaders).filter(
    ([name]) => name !== "cache-control"
  )
);

test("hosted DAST refuses non-owned or non-HTTPS targets before fetching", async () => {
  await assert.rejects(
    runHostedDast("http://d2s5v0o0eg2aaw.cloudfront.net"),
    /must use HTTPS/u
  );
  await assert.rejects(
    runHostedDast("https://untrusted.invalid"),
    /must be the owned production origin/u
  );
  await assert.rejects(
    runHostedDast("https://d2s5v0o0eg2aaw.cloudfront.net/unexpected"),
    /must not contain a path/u
  );
});

test("hosted DAST emits a passing receipt only after every boundary check", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = String(init?.method ?? "GET").toUpperCase();

    if (url.pathname === "/") {
      return new Response('<div id="root"></div>', {
        status: 200,
        headers: {
          ...securityHeaders,
          "content-type": "text/html; charset=utf-8",
        },
      });
    }

    if (url.pathname === "/api/health") {
      return Response.json(
        {
          ok: true,
          scope: {
            tenantId: "public-demo",
            company: "Helios SA",
            access: "read-only",
          },
        },
        { status: 200, headers: securityHeaders }
      );
    }

    if (url.pathname === "/api/proof") {
      return Response.json(
        {
          release: {
            commitSha: "315d8b20b7195b5fd55fe216a8a76835585aa49d",
          },
        },
        { status: 200, headers: securityHeaders }
      );
    }

    if (
      (url.pathname === "/api/recall" && method !== "POST") ||
      url.pathname === "/api/remember" ||
      url.pathname === "/api/not-a-route"
    ) {
      return Response.json(
        { message: "Not Found" },
        { status: 404, headers: gatewaySecurityHeaders }
      );
    }

    let status = 404;
    if (url.pathname === "/api/recall") {
      if (
        !String(
          new Headers(init?.headers).get("content-type") ?? ""
        ).startsWith("application/json")
      ) {
        status = 415;
      } else {
        const body = String(init?.body ?? "");
        if (Buffer.byteLength(body, "utf8") > 4_096) status = 413;
        else status = 400;
      }
    } else if (url.pathname === "/api/audit") {
      status = 400;
    }

    return Response.json(
      { error: `bounded test error ${status}` },
      { status, headers: securityHeaders }
    );
  };

  try {
    const receipt = await runHostedDast(
      "https://d2s5v0o0eg2aaw.cloudfront.net"
    );
    assert.equal(receipt.passed, true);
    assert.equal(receipt.version, 3);
    assert.equal(receipt.profile, "predeploy");
    assert.equal(
      receipt.releaseSha,
      "315d8b20b7195b5fd55fe216a8a76835585aa49d"
    );
    assert.equal(receipt.checks.length, 15);
    assert.ok(receipt.checks.every((check) => check.status === "pass"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("hosted DAST exact-release profile requires isolated browser headers", async () => {
  const previous = process.env.DAST_REQUIRE_HARDENED_HEADERS;
  const originalFetch = globalThis.fetch;
  process.env.DAST_REQUIRE_HARDENED_HEADERS = "1";
  globalThis.fetch = async () =>
    new Response('<div id="root"></div>', {
      status: 200,
      headers: {
        ...securityHeaders,
        "content-security-policy":
          "default-src 'self'; frame-ancestors 'none'; object-src 'none'; style-src 'self' 'unsafe-inline'",
        "content-type": "text/html; charset=utf-8",
      },
    });

  try {
    await assert.rejects(
      runHostedDast("https://d2s5v0o0eg2aaw.cloudfront.net"),
      /CSP permits unsafe inline styles/u
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (previous === undefined) {
      delete process.env.DAST_REQUIRE_HARDENED_HEADERS;
    } else {
      process.env.DAST_REQUIRE_HARDENED_HEADERS = previous;
    }
  }
});

test("hosted DAST exact-release refuses the legacy API Gateway fallback", async () => {
  const releaseSha = "a".repeat(40);
  const names = [
    "DAST_REQUIRE_HARDENED_HEADERS",
    "DAST_EXPECTED_RELEASE_SHA",
    "DAST_SCANNER_SHA",
    "DAST_SOURCE_DEPLOY_RUN_ID",
    "DAST_SOURCE_DEPLOY_RUN_ATTEMPT",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_ATTEMPT",
  ] as const;
  const previous = Object.fromEntries(
    names.map((name) => [name, process.env[name]])
  );
  const originalFetch = globalThis.fetch;
  Object.assign(process.env, {
    DAST_REQUIRE_HARDENED_HEADERS: "1",
    DAST_EXPECTED_RELEASE_SHA: releaseSha,
    DAST_SCANNER_SHA: releaseSha,
    DAST_SOURCE_DEPLOY_RUN_ID: "201",
    DAST_SOURCE_DEPLOY_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: "302",
    GITHUB_RUN_ATTEMPT: "1",
  });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/") {
      return new Response('<div id="root"></div>', {
        status: 200,
        headers: {
          ...securityHeaders,
          "content-type": "text/html; charset=utf-8",
        },
      });
    }
    if (url.pathname === "/api/health") {
      return Response.json(
        {
          scope: {
            tenantId: "public-demo",
            company: "Helios SA",
            access: "read-only",
          },
        },
        { status: 200, headers: securityHeaders }
      );
    }
    if (url.pathname === "/api/proof") {
      return Response.json(
        { release: { commitSha: releaseSha } },
        { status: 200, headers: securityHeaders }
      );
    }
    return Response.json(
      { message: "Not Found" },
      { status: 404, headers: gatewaySecurityHeaders }
    );
  };

  try {
    await assert.rejects(
      runHostedDast("https://d2s5v0o0eg2aaw.cloudfront.net"),
      /method-boundary-get: expected 405, received 404/u
    );
  } finally {
    globalThis.fetch = originalFetch;
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});

test("hosted DAST writes a sanitized fail-closed receipt before rethrowing", async () => {
  const originalFetch = globalThis.fetch;
  const directory = mkdtempSync(join(tmpdir(), "archon-hosted-dast-"));
  const receiptPath = join(directory, "receipt.json");
  globalThis.fetch = async () =>
    new Response("internal stack must not enter the receipt", {
      status: 500,
      headers: securityHeaders,
    });

  try {
    await assert.rejects(
      writeHostedDastReceipt(
        "https://d2s5v0o0eg2aaw.cloudfront.net",
        receiptPath
      ),
      /expected 200, received 500/u
    );
    const serialized = readFileSync(receiptPath, "utf8");
    const receipt = JSON.parse(serialized);
    assert.equal(receipt.schema, "archon.hosted-dast");
    assert.equal(receipt.version, 3);
    assert.equal(receipt.passed, false);
    assert.deepEqual(receipt.checks, [
      {
        id: "scan-completion",
        status: "fail",
        observedStatus: null,
      },
    ]);
    assert.doesNotMatch(serialized, /internal stack|expected 200/iu);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("hosted DAST fails closed when production is not the expected release", async () => {
  const previous = process.env.DAST_EXPECTED_RELEASE_SHA;
  const originalFetch = globalThis.fetch;
  process.env.DAST_EXPECTED_RELEASE_SHA =
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/") {
      return new Response('<div id="root"></div>', {
        status: 200,
        headers: {
          ...securityHeaders,
          "content-type": "text/html; charset=utf-8",
        },
      });
    }
    if (url.pathname === "/api/health") {
      return Response.json(
        {
          scope: {
            tenantId: "public-demo",
            company: "Helios SA",
            access: "read-only",
          },
        },
        { status: 200, headers: securityHeaders }
      );
    }
    return Response.json(
      {
        release: {
          commitSha: "315d8b20b7195b5fd55fe216a8a76835585aa49d",
        },
      },
      { status: 200, headers: securityHeaders }
    );
  };

  try {
    await assert.rejects(
      runHostedDast("https://d2s5v0o0eg2aaw.cloudfront.net"),
      /expected a{40}, observed 315d8b20/u
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (previous === undefined) {
      delete process.env.DAST_EXPECTED_RELEASE_SHA;
    } else {
      process.env.DAST_EXPECTED_RELEASE_SHA = previous;
    }
  }
});
