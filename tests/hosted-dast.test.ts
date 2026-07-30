import assert from "node:assert/strict";
import test from "node:test";
import { runHostedDast } from "../scripts/hosted-dast.mjs";

const securityHeaders = {
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'self'; frame-ancestors 'none'; object-src 'none'",
  "content-type": "application/json",
  "referrer-policy": "strict-origin-when-cross-origin",
  "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

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

    let status = 404;
    if (url.pathname === "/api/recall") {
      if (method !== "POST") status = 405;
      else if (
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
    assert.equal(receipt.checks.length, 14);
    assert.ok(receipt.checks.every((check) => check.status === "pass"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
