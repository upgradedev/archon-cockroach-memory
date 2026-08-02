import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  createPredeployZapServer,
  parsePredeployZapPort,
} from "../scripts/predeploy-zap-server.mjs";

const expectedSecurityHeaders = {
  "content-security-policy":
    "default-src 'self'; base-uri 'self'; connect-src 'self'; font-src 'self' data:; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
  "cross-origin-embedder-policy": "require-corp",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy":
    "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "x-robots-tag": "noindex, nofollow",
  "x-xss-protection": "1; mode=block",
};

async function startFixture(t: TestContext) {
  const fixture = await mkdtemp(join(tmpdir(), "archon-predeploy-zap-"));
  let server: Server | undefined;
  t.after(async () => {
    try {
      const activeServer = server;
      if (activeServer?.listening) {
        await new Promise<void>((resolveClose, rejectClose) => {
          activeServer.close((error) =>
            error ? rejectClose(error) : resolveClose()
          );
        });
      }
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  const webRoot = join(fixture, "web");
  await mkdir(join(webRoot, "assets"), { recursive: true });
  await writeFile(
    join(webRoot, "index.html"),
    "<main>candidate</main>",
    "utf8"
  );
  await writeFile(
    join(webRoot, "assets", "app-abcdef12.js"),
    "globalThis.__candidate = true;",
    "utf8"
  );
  await writeFile(join(webRoot, "favicon.ico"), "icon", "utf8");
  await writeFile(join(webRoot, "unsafe.bin"), "not served", "utf8");
  await mkdir(join(webRoot, "api"));
  await writeFile(join(webRoot, "api", "health.json"), '{"ok":true}', "utf8");

  server = await createPredeployZapServer({ webRoot });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  assert(address !== null && typeof address === "object");
  assert.equal(address.address, "127.0.0.1");

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    fixture,
    port: address.port,
    webRoot,
  };
}

function rawRequest(
  port: number,
  path: string,
  method = "GET"
): Promise<{
  body: string;
  headers: Record<string, string | string[] | undefined>;
  status: number;
}> {
  return new Promise((resolveRequest, rejectRequest) => {
    const outgoing = request(
      { host: "127.0.0.1", method, path, port },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        incoming.once("end", () => {
          resolveRequest({
            body: Buffer.concat(chunks).toString("utf8"),
            headers: incoming.headers,
            status: incoming.statusCode ?? 0,
          });
        });
      }
    );
    outgoing.once("error", rejectRequest);
    outgoing.end();
  });
}

function assertSecurityHeaders(headers: Headers) {
  for (const [name, expected] of Object.entries(expectedSecurityHeaders)) {
    assert.equal(headers.get(name), expected, name);
  }
  assert.equal(headers.get("access-control-allow-origin"), null);
  assert.equal(headers.get("access-control-allow-credentials"), null);
  assert.equal(headers.get("strict-transport-security"), null);
}

test("serves root, HEAD, and exact versioned assets with production cache contracts", async (t) => {
  const { baseUrl } = await startFixture(t);

  const root = await fetch(`${baseUrl}/`);
  assert.equal(root.status, 200);
  assert.equal(root.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(
    root.headers.get("cache-control"),
    "no-cache,no-store,must-revalidate"
  );
  assert.equal(await root.text(), "<main>candidate</main>");
  assertSecurityHeaders(root.headers);

  const head = await fetch(`${baseUrl}/`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), "22");
  assert.equal(await head.text(), "");
  assertSecurityHeaders(head.headers);

  const asset = await fetch(`${baseUrl}/assets/app-abcdef12.js?cache=bust`);
  assert.equal(asset.status, 200);
  assert.equal(
    asset.headers.get("content-type"),
    "text/javascript; charset=utf-8"
  );
  assert.equal(
    asset.headers.get("cache-control"),
    "public,max-age=31536000,immutable"
  );
  assert.equal(await asset.text(), "globalThis.__candidate = true;");

  const unversioned = await fetch(`${baseUrl}/favicon.ico`);
  assert.equal(unversioned.status, 200);
  assert.equal(unversioned.headers.get("cache-control"), "no-cache");
});

test(
  "returns hardened JSON errors for API, missing, disallowed MIME, and methods",
  async (t) => {
    const { baseUrl } = await startFixture(t);

    for (const path of [
      "/api",
      "/api/health.json",
      "/missing.js",
      "/unsafe.bin",
    ]) {
      const response = await fetch(`${baseUrl}${path}`);
      assert.equal(response.status, 404, path);
      assert.equal(
        response.headers.get("content-type"),
        "application/json; charset=utf-8"
      );
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await response.json(), { error: "not_found" });
      assertSecurityHeaders(response.headers);
    }

    const method = await fetch(`${baseUrl}/`, { method: "POST" });
    assert.equal(method.status, 405);
    assert.equal(method.headers.get("allow"), "GET, HEAD");
    assert.deepEqual(await method.json(), { error: "method_not_allowed" });
    assertSecurityHeaders(method.headers);
  }
);

test(
  "rejects traversal, encoded separators, malformed escapes, and symlink escape",
  async (t) => {
    const { fixture, port, webRoot } = await startFixture(t);
    const outside = join(fixture, "outside.js");
    await writeFile(outside, "outside", "utf8");
    await symlink(
      outside,
      join(webRoot, "assets", "linked-abcdef12.js"),
      "file"
    );

    for (const path of [
      "/../outside.js",
      "/%2e%2e/outside.js",
      "/assets%2f..%2foutside.js",
      "/assets%5c..%5coutside.js",
      "/%zz",
      "/assets/linked-abcdef12.js",
    ]) {
      const response = await rawRequest(port, path);
      assert.equal(response.status, 404, path);
      assert.deepEqual(JSON.parse(response.body), { error: "not_found" });
      assert.equal(response.headers["cache-control"], "no-store");
      assert.equal(response.headers["x-content-type-options"], "nosniff");
      assert.equal(response.headers["access-control-allow-origin"], undefined);
    }
  }
);

test("serves only the immutable startup snapshot after an asset swap", async (t) => {
  const { baseUrl, fixture, webRoot } = await startFixture(t);
  const indexedAsset = join(webRoot, "assets", "app-abcdef12.js");
  const outside = join(fixture, "replacement.js");
  await writeFile(outside, "globalThis.__replacement = true;", "utf8");
  await rm(indexedAsset);
  await symlink(outside, indexedAsset, "file");

  const response = await fetch(`${baseUrl}/assets/app-abcdef12.js`);
  assert.equal(response.status, 200);
  assert.equal(
    await response.text(),
    "globalThis.__candidate = true;"
  );
});

test("requires an existing root and parses only bounded non-privileged ports", async () => {
  const source = await readFile(
    new URL("../scripts/predeploy-zap-server.mjs", import.meta.url),
    "utf8"
  );
  assert.match(source, /const LOOPBACK_HOST = "127\.0\.0\.1"/u);
  assert.match(source, /server\.listen\(port, LOOPBACK_HOST/u);
  await assert.rejects(createPredeployZapServer(), /webRoot is required/u);
  await assert.rejects(
    createPredeployZapServer({ webRoot: join(tmpdir(), "does-not-exist") }),
    /existing directory/u
  );
  assert.equal(parsePredeployZapPort(undefined), 4173);
  assert.equal(parsePredeployZapPort("4174"), 4174);
  for (const value of ["0", "1023", "65536", "4.5", "-1", "NaN"]) {
    assert.throws(() => parsePredeployZapPort(value), /integer from 1024 to 65535/u);
  }
});
