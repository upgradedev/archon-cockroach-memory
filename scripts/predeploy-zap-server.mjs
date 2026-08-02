import { createServer } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_PORT = 4173;
const MIN_PORT = 1024;
const MAX_PORT = 65_535;

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "connect-src 'self'",
  "font-src 'self' data:",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
].join("; ");

const SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy":
    "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-Robots-Tag": "noindex, nofollow",
  "X-XSS-Protection": "1; mode=block",
});

const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".ttf", "font/ttf"],
  [".txt", "text/plain; charset=utf-8"],
  [".webmanifest", "application/manifest+json"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function responseHeaders(overrides = {}) {
  return { ...SECURITY_HEADERS, ...overrides };
}

function sendJson(response, method, statusCode, payload, extraHeaders = {}) {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
  response.writeHead(
    statusCode,
    responseHeaders({
      "Cache-Control": "no-store",
      "Content-Length": String(body.byteLength),
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    })
  );
  response.end(method === "HEAD" ? undefined : body);
}

function decodeRequestPath(requestTarget) {
  if (
    typeof requestTarget !== "string" ||
    !requestTarget.startsWith("/") ||
    requestTarget.startsWith("//")
  ) {
    return undefined;
  }

  const rawPath = requestTarget.split("?", 1)[0];
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    return undefined;
  }

  if (
    !decodedPath.startsWith("/") ||
    decodedPath.startsWith("//") ||
    decodedPath.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(decodedPath)
  ) {
    return undefined;
  }

  const segments = decodedPath.slice(1).split("/");
  if (
    segments.some(
      (segment, index) =>
        (segment.length === 0 && index !== segments.length - 1) ||
        segment === "." ||
        segment === ".." ||
        /[<>:"|?*]/u.test(segment)
    )
  ) {
    return undefined;
  }

  return decodedPath;
}

function isWithinRoot(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) &&
      pathFromRoot !== ".." &&
      !isAbsolute(pathFromRoot))
  );
}

function isApiPath(pathname) {
  return pathname === "/api" || pathname.startsWith("/api/");
}

function isVersionedAsset(pathname) {
  return /(?:^|\/)[^/]+(?:-|\.)[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9]+$/u.test(
    pathname
  );
}

async function resolveStaticFile(canonicalRoot, pathname) {
  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  if (relativePath.length === 0 || relativePath.endsWith("/")) {
    return undefined;
  }

  const lexicalPath = resolve(canonicalRoot, relativePath);
  if (!isWithinRoot(canonicalRoot, lexicalPath)) {
    return undefined;
  }

  let canonicalPath;
  try {
    canonicalPath = await realpath(lexicalPath);
  } catch {
    return undefined;
  }
  if (!isWithinRoot(canonicalRoot, canonicalPath)) {
    return undefined;
  }
  const canonicalRelativePath = relative(canonicalRoot, canonicalPath)
    .split(sep)
    .join("/");
  if (canonicalRelativePath !== relativePath) {
    return undefined;
  }

  try {
    const metadata = await stat(canonicalPath);
    return metadata.isFile() ? canonicalPath : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Create a zero-dependency static server for the pipeline-owned pre-deploy DAST.
 * The caller controls lifecycle; production startup below always binds it to IPv4
 * loopback so the candidate build is never exposed outside the CI runner. The
 * server mirrors transport-safe production headers. HSTS and CSP transport
 * upgrades are intentionally proven only by the exact-release HTTPS DAST:
 * HSTS on HTTP is invalid, while upgrading loopback subresources would point
 * the browser at an HTTPS endpoint that intentionally does not exist.
 */
export async function createPredeployZapServer({ webRoot } = {}) {
  if (typeof webRoot !== "string" || webRoot.trim().length === 0) {
    throw new Error("webRoot is required");
  }

  let canonicalRoot;
  try {
    canonicalRoot = await realpath(resolve(webRoot));
  } catch {
    throw new Error("webRoot must resolve to an existing directory");
  }
  const rootMetadata = await stat(canonicalRoot);
  if (!rootMetadata.isDirectory()) {
    throw new Error("webRoot must resolve to an existing directory");
  }

  return createServer((request, response) => {
    void (async () => {
      const method = request.method?.toUpperCase() ?? "";
      if (method !== "GET" && method !== "HEAD") {
        sendJson(response, method, 405, { error: "method_not_allowed" }, {
          Allow: "GET, HEAD",
        });
        return;
      }

      const pathname = decodeRequestPath(request.url);
      if (pathname === undefined || isApiPath(pathname)) {
        sendJson(response, method, 404, { error: "not_found" });
        return;
      }

      const extension = extname(pathname === "/" ? "index.html" : pathname)
        .toLowerCase();
      const contentType = MIME_TYPES.get(extension);
      if (contentType === undefined) {
        sendJson(response, method, 404, { error: "not_found" });
        return;
      }

      const filePath = await resolveStaticFile(canonicalRoot, pathname);
      if (filePath === undefined) {
        sendJson(response, method, 404, { error: "not_found" });
        return;
      }

      let body;
      try {
        body = await readFile(filePath);
      } catch {
        sendJson(response, method, 404, { error: "not_found" });
        return;
      }

      const cacheControl =
        extension === ".html"
          ? "no-cache,no-store,must-revalidate"
          : isVersionedAsset(pathname)
            ? "public,max-age=31536000,immutable"
            : "no-cache";
      response.writeHead(
        200,
        responseHeaders({
          "Cache-Control": cacheControl,
          "Content-Length": String(body.byteLength),
          "Content-Type": contentType,
        })
      );
      response.end(method === "HEAD" ? undefined : body);
    })().catch(() => {
      if (!response.headersSent) {
        sendJson(response, request.method ?? "", 500, {
          error: "internal_server_error",
        });
      } else {
        response.destroy();
      }
    });
  });
}

export function parsePredeployZapPort(value) {
  if (value === undefined || value === "") {
    return DEFAULT_PORT;
  }
  if (!/^\d+$/u.test(value)) {
    throw new Error(
      `PREDEPLOY_ZAP_PORT must be an integer from ${MIN_PORT} to ${MAX_PORT}`
    );
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new Error(
      `PREDEPLOY_ZAP_PORT must be an integer from ${MIN_PORT} to ${MAX_PORT}`
    );
  }
  return port;
}

async function main() {
  const webRoot = process.env.PREDEPLOY_WEB_ROOT;
  if (webRoot === undefined || webRoot.trim().length === 0) {
    throw new Error("PREDEPLOY_WEB_ROOT is required");
  }
  const port = parsePredeployZapPort(process.env.PREDEPLOY_ZAP_PORT);
  const server = await createPredeployZapServer({ webRoot });

  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, LOOPBACK_HOST, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });

  process.stdout.write(
    `Pre-deploy ZAP candidate listening on http://${LOOPBACK_HOST}:${port}\n`
  );

  let closing = false;
  process.once("SIGTERM", () => {
    if (closing) return;
    closing = true;
    server.close((error) => {
      if (error) process.exitCode = 1;
    });
    const forceClose = setTimeout(() => server.closeAllConnections(), 5_000);
    forceClose.unref();
  });
}

const entryPoint = process.argv[1];
if (
  typeof entryPoint === "string" &&
  import.meta.url === pathToFileURL(resolve(entryPoint)).href
) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Pre-deploy server failed"}\n`
    );
    process.exitCode = 1;
  });
}
