import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { chromium } from "@playwright/test";

const CANONICAL_ORIGIN = "https://d2s5v0o0eg2aaw.cloudfront.net";
const PUBLIC_REPOSITORY = "github.com/upgradedev/archon-cockroach-memory";
const QUESTION = "What was the true employer cost and the off-bank wedge?";
const RECEIPT_SCHEMA = "archon.demo-video-capture";
const PLAN_SCHEMA = "archon.demo-video-plan";
const PLAN_VERSION = 1;
const RECEIPT_VERSION = 1;
const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 30;
const DURATION_SECONDS = 170;
const RECORDING_TAIL_SECONDS = 2;
const MARKER_SIZE = 40;
const MARKER_RIGHT = 24;
const MARKER_BOTTOM = 24;
const MARKER_SAMPLE_X = WIDTH - MARKER_RIGHT - MARKER_SIZE / 2;
const MARKER_SAMPLE_Y = HEIGHT - MARKER_BOTTOM - MARKER_SIZE / 2;
const EXACT_SHA = /^[0-9a-f]{40}$/u;
const EXACT_RUN_ID = /^[1-9][0-9]*$/u;
const EXACT_RUNTIME_PRINCIPAL = /^archon_production_[0-9a-f]{10}$/u;
const EXACT_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const EXACT_FINGERPRINT = /^[0-9a-f]{64}$/u;
const SCENE_PLAN_URL = new URL("../../demo/video/scene-plan.json", import.meta.url);

const EXPECTED_SCENES = Object.freeze([
  Object.freeze({
    id: "hook",
    startSeconds: 0,
    endSeconds: 12,
    color: "#34d399",
  }),
  Object.freeze({
    id: "scope-architecture",
    startSeconds: 12,
    endSeconds: 27,
    color: "#38bdf8",
  }),
  Object.freeze({
    id: "recall-grounding",
    startSeconds: 27,
    endSeconds: 75,
    color: "#fbbf24",
  }),
  Object.freeze({
    id: "audit",
    startSeconds: 75,
    endSeconds: 115,
    color: "#fb7185",
  }),
  Object.freeze({
    id: "proof",
    startSeconds: 115,
    endSeconds: 140,
    color: "#a78bfa",
  }),
  Object.freeze({
    id: "managed-mcp",
    startSeconds: 140,
    endSeconds: 160,
    color: "#22d3ee",
  }),
  Object.freeze({
    id: "close",
    startSeconds: 160,
    endSeconds: 170,
    color: "#f8fafc",
  }),
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function requireEnvironment(name, pattern = null) {
  const value = process.env[name];
  invariant(typeof value === "string" && value.length > 0, `${name} is required.`);
  if (pattern) invariant(pattern.test(value), `${name} has an invalid public identifier.`);
  return value;
}

function requireRunId(name) {
  const value = requireEnvironment(name, EXACT_RUN_ID);
  const parsed = Number(value);
  invariant(
    Number.isSafeInteger(parsed) && parsed > 0,
    `${name} is outside the safe positive integer range.`
  );
  return parsed;
}

function asRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function exactObjectKeys(value, expected) {
  const record = asRecord(value);
  return (
    record !== null &&
    Object.keys(record).sort().join("\n") === [...expected].sort().join("\n")
  );
}

function exactScope(value) {
  const scope = asRecord(value);
  return (
    exactObjectKeys(scope, [
      "access",
      "company",
      "dataClassification",
      "mode",
      "source",
      "tenantId",
    ]) &&
    scope.tenantId === "public-demo" &&
    scope.company === "Helios SA" &&
    scope.mode === "fixed-synthetic-demo" &&
    scope.access === "read-only" &&
    scope.dataClassification === "synthetic-public-demo" &&
    scope.source === "server-configured"
  );
}

function isFreshIsoTimestamp(value) {
  if (typeof value !== "string" || !value.endsWith("Z")) return false;
  const timestamp = Date.parse(value);
  const now = Date.now();
  return (
    Number.isFinite(timestamp) &&
    timestamp <= now + 2 * 60 * 1_000 &&
    now - timestamp <= 5 * 60 * 1_000
  );
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(path) {
  const digest = createHash("sha256");
  const stream = createReadStream(path);
  for await (const chunk of stream) digest.update(chunk);
  return digest.digest("hex");
}

async function describeFile(path, publicPath) {
  const metadata = await stat(path);
  invariant(metadata.isFile() && metadata.size > 0, "A capture output is empty.");
  return {
    path: publicPath,
    bytes: metadata.size,
    sha256: await sha256File(path),
  };
}

function strictDescendant(parent, child) {
  const pathFromParent = relative(parent, child);
  return (
    pathFromParent.length > 0 &&
    pathFromParent !== ".." &&
    !pathFromParent.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !isAbsolute(pathFromParent)
  );
}

async function prepareOutput() {
  const runnerTempInput = requireEnvironment("RUNNER_TEMP");
  const videoRootInput = requireEnvironment("DEMO_VIDEO_ROOT");
  invariant(
    isAbsolute(runnerTempInput) && isAbsolute(videoRootInput),
    "Video output paths must be absolute."
  );

  const runnerTemp = await realpath(resolve(runnerTempInput));
  const requestedVideoRoot = resolve(videoRootInput);
  invariant(
    strictDescendant(runnerTemp, requestedVideoRoot),
    "DEMO_VIDEO_ROOT must be a strict RUNNER_TEMP descendant."
  );

  await mkdir(requestedVideoRoot, { recursive: true });
  const videoRoot = await realpath(requestedVideoRoot);
  invariant(
    strictDescendant(runnerTemp, videoRoot),
    "Resolved DEMO_VIDEO_ROOT escaped RUNNER_TEMP."
  );

  const requestedCaptureDirectory = join(videoRoot, "capture");
  await mkdir(requestedCaptureDirectory, { recursive: true });
  const captureDirectory = await realpath(requestedCaptureDirectory);
  invariant(
    strictDescendant(videoRoot, captureDirectory),
    "Resolved capture directory escaped DEMO_VIDEO_ROOT."
  );
  const existing = await readdir(captureDirectory);
  invariant(existing.length === 0, "The capture directory must start empty.");

  return {
    captureDirectory,
    receiptPath: join(captureDirectory, "capture-receipt.json"),
    videoPath: join(captureDirectory, "production-capture.webm"),
  };
}

function planDimension(plan, name) {
  const video = asRecord(plan.video);
  return plan[name] ?? video?.[name] ?? null;
}

async function loadScenePlan() {
  const source = await readFile(SCENE_PLAN_URL, "utf8");
  let rawPlan;
  try {
    rawPlan = JSON.parse(source);
  } catch {
    throw new Error("The canonical scene plan is not valid JSON.");
  }
  const plan = asRecord(rawPlan);
  invariant(plan !== null, "The canonical scene plan must be an object.");
  invariant(plan.schema === PLAN_SCHEMA, "Unexpected scene plan schema.");
  invariant(plan.version === PLAN_VERSION, "Unexpected scene plan version.");
  invariant(
    plan.targetDurationSeconds === DURATION_SECONDS,
    "The scene plan must be exactly 170 seconds."
  );
  invariant(planDimension(plan, "width") === WIDTH, "The scene plan width must be 1920.");
  invariant(planDimension(plan, "height") === HEIGHT, "The scene plan height must be 1080.");
  invariant(planDimension(plan, "fps") === FPS, "The scene plan frame rate must be 30.");
  invariant(
    Array.isArray(plan.scenes) && plan.scenes.length === EXPECTED_SCENES.length,
    "The scene plan must contain the seven canonical scenes."
  );

  const scenes = plan.scenes.map((rawScene, index) => {
    const scene = asRecord(rawScene);
    const expected = EXPECTED_SCENES[index];
    invariant(scene !== null, "Every canonical scene must be an object.");
    const color = scene.color ?? scene.markerColor;
    invariant(scene.id === expected.id, "The canonical scene order changed.");
    invariant(
      scene.startSeconds === expected.startSeconds &&
        scene.endSeconds === expected.endSeconds,
      "A canonical scene boundary changed."
    );
    invariant(color === expected.color, "A canonical scene marker color changed.");
    invariant(
      typeof scene.narration === "string" && scene.narration.trim().length > 0,
      "Every canonical scene requires narration."
    );
    return {
      ...expected,
      narration: scene.narration,
    };
  });

  invariant(
    scenes.every(
      (scene, index) =>
        scene.startSeconds === (index === 0 ? 0 : scenes[index - 1].endSeconds)
    ) && scenes.at(-1)?.endSeconds === DURATION_SECONDS,
    "Canonical scenes must be contiguous."
  );

  return {
    scenes,
    sha256: sha256Text(source),
  };
}

function createBrowserMonitor() {
  return {
    consoleErrors: 0,
    consoleWarnings: 0,
    pageErrors: 0,
    networkFailures: 0,
    httpErrors: 0,
    crossOriginRequests: 0,
    websocketViolations: 0,
    crashes: 0,
    dialogs: 0,
    downloads: 0,
    attachedPages: new WeakSet(),
  };
}

function attachPageMonitor(page, monitor) {
  if (monitor.attachedPages.has(page)) return;
  monitor.attachedPages.add(page);

  page.on("console", (message) => {
    if (message.type() === "error") monitor.consoleErrors += 1;
    if (message.type() === "warning") monitor.consoleWarnings += 1;
  });
  page.on("pageerror", () => {
    monitor.pageErrors += 1;
  });
  page.on("requestfailed", () => {
    monitor.networkFailures += 1;
  });
  page.on("response", (response) => {
    if (response.status() >= 400) monitor.httpErrors += 1;
  });
  page.on("crash", () => {
    monitor.crashes += 1;
  });
  page.on("dialog", (dialog) => {
    monitor.dialogs += 1;
    void dialog.dismiss().catch(() => {});
  });
  page.on("download", (download) => {
    monitor.downloads += 1;
    void download.cancel().catch(() => {});
  });
  page.on("websocket", (socket) => {
    try {
      const url = new URL(socket.url());
      if (
        (url.protocol === "ws:" || url.protocol === "wss:") &&
        url.host !== new URL(CANONICAL_ORIGIN).host
      ) {
        monitor.websocketViolations += 1;
      }
    } catch {
      monitor.websocketViolations += 1;
    }
  });
}

async function installBrowserGuard(context, monitor) {
  context.on("page", (page) => attachPageMonitor(page, monitor));
  await context.route("**/*", async (route) => {
    let requestUrl;
    try {
      requestUrl = new URL(route.request().url());
    } catch {
      monitor.crossOriginRequests += 1;
      await route.abort("blockedbyclient");
      return;
    }

    if (
      (requestUrl.protocol === "http:" || requestUrl.protocol === "https:") &&
      requestUrl.origin !== CANONICAL_ORIGIN
    ) {
      monitor.crossOriginRequests += 1;
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
}

function assertCleanBrowser(monitor) {
  const clean =
    monitor.consoleErrors === 0 &&
    monitor.consoleWarnings === 0 &&
    monitor.pageErrors === 0 &&
    monitor.networkFailures === 0 &&
    monitor.httpErrors === 0 &&
    monitor.crossOriginRequests === 0 &&
    monitor.websocketViolations === 0 &&
    monitor.crashes === 0 &&
    monitor.dialogs === 0 &&
    monitor.downloads === 0;
  invariant(clean, "The browser emitted a console, page, network, or origin violation.");
}

async function createMonitoredContext(browser, monitor, recordDirectory = null) {
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    screen: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
    colorScheme: "dark",
    reducedMotion: "reduce",
    locale: "en-IE",
    timezoneId: "UTC",
    serviceWorkers: "block",
    acceptDownloads: false,
    bypassCSP: recordDirectory !== null,
    ...(recordDirectory
      ? {
          recordVideo: {
            dir: recordDirectory,
            size: { width: WIDTH, height: HEIGHT },
          },
        }
      : {}),
  });
  await installBrowserGuard(context, monitor);
  return context;
}

async function openCanonicalApplication(page) {
  const response = await page.goto(CANONICAL_ORIGIN, {
    waitUntil: "networkidle",
    timeout: 60_000,
  });
  invariant(response !== null && response.ok(), "The canonical production root was unavailable.");
  const contentSecurityPolicy =
    response.headers()["content-security-policy"] ?? "";
  invariant(
    contentSecurityPolicy.includes("default-src 'self'") &&
      contentSecurityPolicy.includes("frame-ancestors 'none'") &&
      contentSecurityPolicy.includes("object-src 'none'"),
    "The canonical production root did not enforce the deployed CSP boundary."
  );
  const pageUrl = new URL(page.url());
  invariant(
    pageUrl.origin === CANONICAL_ORIGIN &&
      (pageUrl.pathname === "/" || pageUrl.pathname === ""),
    "The production page left the canonical CloudFront root."
  );
  await page
    .getByRole("heading", { name: "Memory that disagrees out loud." })
    .waitFor({ state: "visible", timeout: 30_000 });
  await page
    .getByText("API reachable", { exact: true })
    .waitFor({ state: "visible", timeout: 30_000 });
  await page
    .getByTestId("store-proof")
    .filter({ hasText: "Store verified" })
    .waitFor({ state: "visible", timeout: 30_000 });
}

async function pageJson(page, path, init = {}) {
  let result;
  try {
    result = await page.evaluate(
      async ({ requestPath, requestInit }) => {
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), 45_000);
        try {
          const response = await fetch(requestPath, {
            ...requestInit,
            cache: "no-store",
            credentials: "omit",
            redirect: "error",
            signal: controller.signal,
            headers: {
              accept: "application/json",
              ...(requestInit.headers ?? {}),
            },
          });
          let body = null;
          try {
            body = await response.json();
          } catch {
            body = null;
          }
          return {
            ok: response.ok,
            status: response.status,
            body,
          };
        } finally {
          window.clearTimeout(timer);
        }
      },
      { requestPath: path, requestInit: init }
    );
  } catch {
    throw new Error("A live production API request failed.");
  }
  invariant(
    result?.ok === true && result.status === 200 && asRecord(result.body) !== null,
    "A live production API response failed closed."
  );
  return result.body;
}

function validateHealth(health) {
  invariant(
    health.ok === true &&
      health.status === "reachable" &&
      health.service === "archon-cockroach-memory" &&
      health.dependencies === "unchecked" &&
      exactScope(health.scope),
    "Health did not prove the fixed public production scope."
  );
}

function validateProof(proof, releaseSha) {
  const database = asRecord(proof.database);
  const memory = asRecord(proof.memory);
  const vector = asRecord(proof.vectorIndex);
  const release = asRecord(proof.release);
  invariant(
    database?.engine === "CockroachDB" &&
      database.deployment === "CockroachDB Cloud on AWS" &&
      database.role === "persistent agent memory" &&
      database.transactionIsolation === "SERIALIZABLE" &&
      database.database === "archon" &&
      typeof database.version === "string" &&
      /CockroachDB/iu.test(database.version) &&
      database.region === "eu-west-1" &&
      database.regionEvidence === "cockroach-cloud-api-release-gate" &&
      EXACT_RUNTIME_PRINCIPAL.test(database.runtimePrincipal) &&
      database.activeMemories === 9,
    "Live database proof did not match the exact production contract."
  );
  invariant(
    memory?.persisted === 9 &&
      memory.idempotencyKeys === 9 &&
      memory.contentDigests === 9 &&
      memory.storeVerified === true &&
      memory.evidence === "live bounded fixed-scope payload-digest verification",
    "Live memory proof was not exactly 9/9/9."
  );
  invariant(
    vector?.engine === "native CockroachDB C-SPANN" &&
      vector.enabled === true &&
      vector.name === "idx_agent_memory_company_scope_embedding" &&
      vector.metric === "cosine" &&
      vector.dimensions === 1024 &&
      Array.isArray(vector.prefixes) &&
      vector.prefixes.join("\n") ===
        ["tenant_id", "embed_model", "status", "company"].join("\n") &&
      vector.lifecycleState === "active" &&
      vector.evidence === "live pg_catalog.pg_indexes definition" &&
      EXACT_FINGERPRINT.test(vector.definitionFingerprint),
    "Live C-SPANN proof did not match the catalog-backed production index."
  );
  invariant(
    proof.embeddingModel === "amazon.titan-embed-text-v2:0" &&
      proof.narrationModel === "eu.anthropic.claude-sonnet-4-6" &&
      release?.commitSha === releaseSha &&
      release.evidence === "server-configured Lambda environment" &&
      exactScope(proof.scope) &&
      isFreshIsoTimestamp(proof.generatedAt),
    "Live release proof did not match the exact SHA and model contract."
  );
}

function validateAudit(audit) {
  const report = asRecord(audit.report);
  const coverage = asRecord(audit.coverage);
  const contradictions = Array.isArray(report?.contradictions)
    ? report.contradictions
    : [];
  const absences = Array.isArray(report?.absences) ? report.absences : [];
  const contradiction = asRecord(contradictions[0]);
  const resolution = asRecord(contradiction?.resolution);
  const values = Array.isArray(contradiction?.values)
    ? contradiction.values
        .map((value) => asRecord(value)?.value)
        .filter((value) => typeof value === "number")
        .sort((left, right) => left - right)
    : [];
  const absence = asRecord(absences[0]);
  const referencedBy = Array.isArray(absence?.referencedBy)
    ? absence.referencedBy
    : [];
  const reference = asRecord(referencedBy[0]);

  invariant(
    report?.audited === 9 &&
      report.ok === false &&
      coverage?.total === 9 &&
      coverage.scanned === 9 &&
      coverage.complete === true &&
      exactScope(audit.scope) &&
      contradictions.length === 1 &&
      contradiction?.subject === "INV-2043" &&
      contradiction.type === "contradiction" &&
      contradiction.attribute === "total" &&
      values.join(",") === "18400,18900" &&
      resolution?.recommendedValue === 18400 &&
      resolution.rule === "importance" &&
      EXACT_UUID.test(resolution.recommendedMemoryId) &&
      typeof resolution.confidence === "number" &&
      resolution.confidence >= 0 &&
      resolution.confidence <= 1 &&
      typeof resolution.rationale === "string" &&
      resolution.rationale.length >= 20 &&
      absences.length === 1 &&
      absence?.type === "absence" &&
      absence.subject === "PAY-118" &&
      referencedBy.length === 1 &&
      reference?.sourceRef === "RECON-2043" &&
      isFreshIsoTimestamp(audit.generatedAt),
    "The live audit did not prove the exact contradiction and PAY-118 absence."
  );
}

function validateRecall(recall) {
  const citations = Array.isArray(recall.citations) ? recall.citations : [];
  const grounding = asRecord(recall.grounding);
  const checks = asRecord(grounding?.checks);
  const trace = asRecord(recall.trace);
  const retrieval = asRecord(trace?.retrieval);
  const narration = asRecord(trace?.narration);
  const citedContent = citations
    .map((citation) => asRecord(citation)?.content)
    .filter((content) => typeof content === "string");

  invariant(
    recall.question === QUESTION &&
      typeof recall.answer === "string" &&
      recall.answer.includes("€15,375") &&
      recall.answer.includes("€6,775") &&
      recall.modelId === "eu.anthropic.claude-sonnet-4-6" &&
      citations.length >= 2 &&
      citations.length <= 5 &&
      recall.recalled === citations.length &&
      (grounding?.status === "verified" || grounding?.status === "extractive") &&
      checks?.citations === true &&
      checks.numerics === true &&
      checks.claims === true &&
      retrieval?.database === "CockroachDB" &&
      retrieval.index === "native C-SPANN vector index" &&
      retrieval.metric === "cosine" &&
      retrieval.embeddingModel === "amazon.titan-embed-text-v2:0" &&
      retrieval.requestedTopK === 5 &&
      retrieval.recalled === recall.recalled &&
      narration?.model === "eu.anthropic.claude-sonnet-4-6" &&
      exactScope(trace?.scope) &&
      citedContent.some((content) => content.includes("€15,375")) &&
      citedContent.some((content) => content.includes("€6,775")) &&
      recall.consistencyOk === true,
    "Live recall did not return the exact grounded financial evidence."
  );

  const markers = citations.map((citation, index) => {
    const item = asRecord(citation);
    invariant(
      item?.marker === `[${index + 1}]` &&
        EXACT_UUID.test(item.memoryId) &&
        typeof item.sourceRef === "string" &&
        item.sourceRef.length > 0 &&
        item.company === "Helios SA" &&
        ["document", "payroll_event", "validation", "insight"].includes(item.kind) &&
        item.period === "2026-04" &&
        typeof item.score === "number" &&
        item.score >= 0.15 &&
        item.score <= 1,
      "A live recall citation failed the exact evidence contract."
    );
    return item.marker;
  });
  invariant(
    new Set(citations.map((citation) => asRecord(citation)?.memoryId)).size ===
      citations.length,
    "Live recall returned duplicate evidence identifiers."
  );
  invariant(
    markers.every((marker) => recall.answer.includes(marker)),
    "Live recall did not link every citation from its answer."
  );
}

async function collectLiveProof(browser, releaseSha) {
  const monitor = createBrowserMonitor();
  const context = await createMonitoredContext(browser, monitor);
  try {
    const page = await context.newPage();
    attachPageMonitor(page, monitor);
    await openCanonicalApplication(page);
    const [health, proof, audit] = await Promise.all([
      pageJson(page, "/api/health"),
      pageJson(page, "/api/proof"),
      pageJson(page, "/api/audit"),
    ]);
    validateHealth(health);
    validateProof(proof, releaseSha);
    validateAudit(audit);
    assertCleanBrowser(monitor);
    return {
      releaseSha,
      cspEnforced: true,
      region: "eu-west-1",
      database: "CockroachDB Cloud on AWS",
      vectorIndex: "native CockroachDB C-SPANN",
      vectorDimensions: 1024,
      persisted: 9,
      idempotencyKeys: 9,
      contentDigests: 9,
      audit: {
        contradiction: "INV-2043",
        absentEvidence: "PAY-118",
        referencedBy: "RECON-2043",
      },
      observedAt: new Date().toISOString(),
    };
  } finally {
    await context.close().catch(() => {});
  }
}

async function installCaptureOverlay(page) {
  await page.evaluate(
    ({ markerSize, markerRight, markerBottom }) => {
      document.documentElement.style.scrollBehavior = "auto";
      const style = document.createElement("style");
      style.id = "archon-capture-style";
      style.textContent = `
        html { scroll-behavior: auto !important; }
        *, *::before, *::after {
          animation-duration: 0.01ms !important;
          animation-iteration-count: 1 !important;
          transition-duration: 0.01ms !important;
          scroll-behavior: auto !important;
        }
        body { cursor: none !important; }
        [data-archon-highlight="true"] {
          outline: 3px solid #9ce6c8 !important;
          outline-offset: 5px !important;
          box-shadow: 0 0 0 10px rgba(156, 230, 200, 0.08) !important;
        }
        #archon-production-overlay {
          position: fixed;
          z-index: 2147483000;
          pointer-events: none;
          color: #f8fafc;
          font-family: Inter, ui-sans-serif, system-ui, sans-serif;
          letter-spacing: normal;
        }
        #archon-production-overlay[data-layout="caption"] {
          top: 84px;
          right: 48px;
          width: 520px;
        }
        #archon-production-overlay[data-layout="caption-left"] {
          top: 84px;
          left: 48px;
          width: 500px;
        }
        #archon-production-overlay[data-layout="wide"] {
          left: 64px;
          right: 64px;
          bottom: 72px;
        }
        #archon-production-overlay[data-layout="center"] {
          inset: 94px 180px 94px;
          display: grid;
          place-items: center;
        }
        .archon-overlay-card {
          overflow: hidden;
          border: 1px solid rgba(248, 250, 252, 0.22);
          background:
            linear-gradient(145deg, rgba(12, 17, 20, 0.98), rgba(9, 11, 12, 0.94));
          box-shadow: 0 26px 80px rgba(0, 0, 0, 0.52);
          padding: 26px 30px;
        }
        #archon-production-overlay[data-layout="center"] .archon-overlay-card {
          width: min(1040px, 100%);
          padding: 46px 54px;
        }
        .archon-overlay-kicker {
          color: #9ce6c8;
          font-size: 13px;
          font-weight: 800;
          letter-spacing: 0.2em;
          text-transform: uppercase;
        }
        .archon-overlay-title {
          margin: 12px 0 0;
          color: #f8fafc;
          font-family: Georgia, "Times New Roman", serif;
          font-size: 48px;
          font-weight: 500;
          line-height: 1.04;
        }
        [data-layout="caption"] .archon-overlay-title { font-size: 31px; }
        [data-layout="caption-left"] .archon-overlay-title { font-size: 31px; }
        [data-layout="wide"] .archon-overlay-title { font-size: 39px; }
        .archon-overlay-detail {
          max-width: 980px;
          margin: 15px 0 0;
          color: rgba(248, 250, 252, 0.74);
          font-size: 17px;
          line-height: 1.5;
        }
        [data-layout="caption"] .archon-overlay-detail {
          font-size: 14px;
          line-height: 1.45;
        }
        [data-layout="caption-left"] .archon-overlay-detail {
          font-size: 14px;
          line-height: 1.45;
        }
        .archon-overlay-points {
          display: grid;
          grid-template-columns: repeat(var(--archon-columns, 2), minmax(0, 1fr));
          gap: 10px;
          margin: 22px 0 0;
          padding: 0;
          list-style: none;
        }
        .archon-overlay-point {
          border: 1px solid rgba(248, 250, 252, 0.13);
          background: rgba(248, 250, 252, 0.035);
          padding: 13px 15px;
          color: rgba(248, 250, 252, 0.85);
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 13px;
          line-height: 1.45;
        }
        .archon-overlay-footer {
          display: flex;
          justify-content: space-between;
          gap: 18px;
          margin-top: 20px;
          padding-top: 14px;
          border-top: 1px solid rgba(248, 250, 252, 0.13);
          color: rgba(248, 250, 252, 0.55);
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 11px;
          text-transform: uppercase;
        }
        #archon-scene-marker {
          position: fixed;
          z-index: 2147483646;
          right: ${markerRight}px;
          bottom: ${markerBottom}px;
          width: ${markerSize}px;
          height: ${markerSize}px;
          pointer-events: none;
          forced-color-adjust: none;
          image-rendering: pixelated;
        }
        #archon-scene-label {
          position: fixed;
          z-index: 2147483645;
          right: ${markerRight + markerSize + 12}px;
          bottom: ${markerBottom + 8}px;
          color: rgba(248, 250, 252, 0.68);
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 11px;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          pointer-events: none;
        }
      `;
      document.head.append(style);

      const overlay = document.createElement("section");
      overlay.id = "archon-production-overlay";
      overlay.setAttribute("aria-label", "Owned Archon Memory demo overlay");
      document.body.append(overlay);

      const marker = document.createElement("div");
      marker.id = "archon-scene-marker";
      marker.setAttribute("aria-hidden", "true");
      document.body.append(marker);

      const markerLabel = document.createElement("div");
      markerLabel.id = "archon-scene-label";
      markerLabel.setAttribute("aria-hidden", "true");
      document.body.append(markerLabel);
    },
    {
      markerSize: MARKER_SIZE,
      markerRight: MARKER_RIGHT,
      markerBottom: MARKER_BOTTOM,
    }
  );
}

function markerRgb(color) {
  const red = Number.parseInt(color.slice(1, 3), 16);
  const green = Number.parseInt(color.slice(3, 5), 16);
  const blue = Number.parseInt(color.slice(5, 7), 16);
  return `rgb(${red}, ${green}, ${blue})`;
}

async function activateScene(page, scene, card) {
  const observation = await page.evaluate(
    ({ activeScene, content }) => {
      const overlay = document.getElementById("archon-production-overlay");
      const marker = document.getElementById("archon-scene-marker");
      const markerLabel = document.getElementById("archon-scene-label");
      if (!overlay || !marker || !markerLabel) return null;

      overlay.replaceChildren();
      overlay.dataset.layout = content.layout;
      overlay.dataset.sceneId = activeScene.id;
      marker.dataset.sceneId = activeScene.id;
      marker.style.backgroundColor = activeScene.color;
      markerLabel.textContent = activeScene.id.replaceAll("-", " ");

      const cardNode = document.createElement("div");
      cardNode.className = "archon-overlay-card";

      const kicker = document.createElement("p");
      kicker.className = "archon-overlay-kicker";
      kicker.textContent = content.kicker;
      cardNode.append(kicker);

      const title = document.createElement("h2");
      title.className = "archon-overlay-title";
      title.textContent = content.title;
      cardNode.append(title);

      if (content.detail) {
        const detail = document.createElement("p");
        detail.className = "archon-overlay-detail";
        detail.textContent = content.detail;
        cardNode.append(detail);
      }

      if (content.points.length > 0) {
        const points = document.createElement("ul");
        points.className = "archon-overlay-points";
        points.style.setProperty(
          "--archon-columns",
          String(content.columns)
        );
        for (const point of content.points) {
          const item = document.createElement("li");
          item.className = "archon-overlay-point";
          item.textContent = point;
          points.append(item);
        }
        cardNode.append(points);
      }

      const footer = document.createElement("div");
      footer.className = "archon-overlay-footer";
      const left = document.createElement("span");
      left.textContent = content.footerLeft;
      const right = document.createElement("span");
      right.textContent = content.footerRight;
      footer.append(left, right);
      cardNode.append(footer);

      overlay.append(cardNode);
      return {
        sceneId: marker.dataset.sceneId,
        color: getComputedStyle(marker).backgroundColor,
      };
    },
    {
      activeScene: scene,
      content: {
        layout: card.layout,
        kicker: card.kicker,
        title: card.title,
        detail: card.detail ?? "",
        points: card.points ?? [],
        columns: card.columns ?? 2,
        footerLeft: card.footerLeft ?? "Live public production",
        footerRight: card.footerRight ?? CANONICAL_ORIGIN,
      },
    }
  );
  invariant(
    observation?.sceneId === scene.id &&
      observation.color === markerRgb(scene.color),
    "A deterministic scene marker was not observed."
  );
}

async function clearHighlights(page) {
  await page.evaluate(() => {
    for (const element of document.querySelectorAll('[data-archon-highlight="true"]')) {
      element.removeAttribute("data-archon-highlight");
    }
  });
}

async function highlight(locator) {
  await locator.first().evaluate((element) => {
    element.setAttribute("data-archon-highlight", "true");
  });
}

async function waitUntilTimeline(startedAt, targetSeconds) {
  const remaining = startedAt + targetSeconds * 1_000 - performance.now();
  if (remaining > 0) {
    await new Promise((resolveWait) => setTimeout(resolveWait, remaining));
  }
}

async function keyScreenshot(page, captureDirectory, name, screenshots) {
  const path = join(captureDirectory, name);
  await page.screenshot({
    path,
    type: "png",
    fullPage: false,
    animations: "disabled",
    caret: "hide",
    scale: "css",
  });
  screenshots.push({ path, name });
}

async function recordProductionJourney({
  browser,
  captureDirectory,
  outputVideoPath,
  releaseSha,
  runIds,
  scenes,
}) {
  const monitor = createBrowserMonitor();
  const context = await createMonitoredContext(browser, monitor, captureDirectory);
  const screenshots = [];
  const markerObservations = [];
  let recordingEpoch;
  let video;
  let rawVideoTrimLeadSeconds;
  let rawVideoRecordedSeconds;

  try {
    const page = await context.newPage();
    attachPageMonitor(page, monitor);
    video = page.video();
    invariant(video !== null, "Playwright did not create the production video stream.");
    recordingEpoch = performance.now();

    await page.setContent(
      '<!doctype html><html><body style="margin:0;background:#090b0c;color:#f8fafc"></body></html>'
    );
    await openCanonicalApplication(page);
    await installCaptureOverlay(page);

    await page
      .getByTestId("release-sha-full")
      .filter({ hasText: releaseSha })
      .waitFor({ state: "visible", timeout: 20_000 });
    await page.getByText("eu-west-1", { exact: false }).first().waitFor({
      state: "visible",
      timeout: 20_000,
    });
    await page.getByTestId("proof-unverifiable").waitFor({
      state: "detached",
      timeout: 20_000,
    });
    assertCleanBrowser(monitor);

    const timelineStartedAt = performance.now();
    rawVideoTrimLeadSeconds = Number(
      ((timelineStartedAt - recordingEpoch) / 1_000).toFixed(3)
    );

    async function beginScene(id, card) {
      const scene = scenes.find((candidate) => candidate.id === id);
      invariant(scene, "A canonical scene is missing.");
      await waitUntilTimeline(timelineStartedAt, scene.startSeconds);
      const actualOffsetMilliseconds = Math.round(
        performance.now() - timelineStartedAt
      );
      invariant(
        actualOffsetMilliseconds - scene.startSeconds * 1_000 <= 1_500,
        "A live scene missed its canonical transition window."
      );
      await activateScene(page, scene, card);
      markerObservations.push({
        id: scene.id,
        startSeconds: scene.startSeconds,
        endSeconds: scene.endSeconds,
        color: scene.color,
        markerColor: scene.color,
        markerObserved: true,
        actualOffsetMilliseconds,
      });
      assertCleanBrowser(monitor);
      return scene;
    }

    await beginScene("hook", {
      layout: "center",
      kicker: "Archon Memory · Live production",
      title: "Memory that disagrees out loud.",
      detail:
        "Persistent financial-agent memory should expose contradictory and missing evidence before a CFO acts.",
      points: [
        "Exact release · live CloudFront origin",
        "Synthetic · public · read-only",
      ],
      columns: 2,
      footerLeft: `release ${releaseSha.slice(0, 12)}`,
    });
    await page.locator("#top").scrollIntoViewIfNeeded();
    await waitUntilTimeline(timelineStartedAt, 2);
    await keyScreenshot(page, captureDirectory, "01-hook.png", screenshots);

    await beginScene("scope-architecture", {
      layout: "wide",
      kicker: "Owned architecture · Fixed public scope",
      title: "One serializable evidence system.",
      detail:
        "The application owns the request boundary and keeps relational truth, provenance, lifecycle, audit state, and native vector memory together.",
      points: [
        "Judge browser → Amazon CloudFront",
        "Private S3 React + Tailwind",
        "Same-origin API Gateway → Lambda",
        "CockroachDB Cloud · AWS eu-west-1",
        "Bedrock Titan embeddings",
        "public-demo / Helios SA / read-only",
      ],
      columns: 3,
      footerLeft: "Owned diagram · no third-party assets",
    });
    await page.getByText("Fixed synthetic scope", { exact: true }).scrollIntoViewIfNeeded();
    await waitUntilTimeline(timelineStartedAt, 15);
    await keyScreenshot(
      page,
      captureDirectory,
      "02-scope-architecture.png",
      screenshots
    );

    await beginScene("recall-grounding", {
      layout: "caption",
      kicker: "Live C-SPANN recall",
      title: "Answer → exact evidence",
      detail:
        "Titan query embedding · tenant/model/lifecycle/company prefixes · citation, numeric, and claim guards.",
      points: [],
      footerLeft: "No mocks · no cached answer",
    });
    await clearHighlights(page);
    const composer = page.getByLabel("Financial question for the Archon memory");
    await composer.scrollIntoViewIfNeeded();
    await composer.fill("");
    await composer.pressSequentially(QUESTION, { delay: 28 });
    await waitUntilTimeline(timelineStartedAt, 30);
    const responsePromise = page.waitForResponse(
      (response) => {
        const url = new URL(response.url());
        return (
          url.origin === CANONICAL_ORIGIN &&
          url.pathname === "/api/recall" &&
          response.request().method() === "POST"
        );
      },
      { timeout: 42_000 }
    );
    await page.getByRole("button", { name: /Ask Archon/u }).click();
    const recallResponse = await responsePromise;
    invariant(recallResponse.ok(), "The live recall request did not succeed.");
    const recallRequest = recallResponse.request();
    let requestBody = null;
    try {
      requestBody = recallRequest.postDataJSON();
    } catch {
      requestBody = null;
    }
    invariant(
      asRecord(requestBody)?.question === QUESTION &&
        asRecord(requestBody)?.limit === 5,
      "The recorded UI did not send the canonical recall request."
    );
    let recallBody;
    try {
      recallBody = await recallResponse.json();
    } catch {
      throw new Error("The live recall response was not JSON.");
    }
    validateRecall(recallBody);
    await page
      .getByRole("heading", { name: /€15,375/u })
      .waitFor({ state: "visible", timeout: 15_000 });
    await page.getByText(/€6,775/u).first().waitFor({
      state: "visible",
      timeout: 15_000,
    });
    await page
      .getByText("Exact returned evidence", { exact: true })
      .waitFor({ state: "visible", timeout: 15_000 });
    const citations = page.locator("[id^='citation-']");
    invariant(
      (await citations.count()) === recallBody.citations.length,
      "The UI did not render every live citation."
    );
    const groundingStatus = page.getByTestId("grounding-status");
    await groundingStatus.waitFor({ state: "visible", timeout: 15_000 });
    invariant(
      /verified|extractive/u.test((await groundingStatus.textContent()) ?? ""),
      "The UI did not render a verified or extractive grounding state."
    );
    await page.locator("#answer-title").scrollIntoViewIfNeeded();
    await highlight(page.locator("#answer-title"));
    await waitUntilTimeline(timelineStartedAt, 51);
    await keyScreenshot(
      page,
      captureDirectory,
      "03-recall-grounding.png",
      screenshots
    );
    await citations.nth(0).scrollIntoViewIfNeeded();
    await highlight(citations.nth(0));
    await waitUntilTimeline(timelineStartedAt, 60);
    if ((await citations.count()) > 1) {
      await citations.nth(1).scrollIntoViewIfNeeded();
      await highlight(citations.nth(1));
    }
    await waitUntilTimeline(timelineStartedAt, 68);
    const retrievalProof = page.getByText(/native C-SPANN vector index/u).first();
    await retrievalProof.scrollIntoViewIfNeeded();
    await highlight(retrievalProof);

    await beginScene("audit", {
      layout: "caption-left",
      kicker: "Bounded exhaustive audit",
      title: "Unknown stays unknown.",
      detail:
        "The system preserves both conflicting records, recommends review, and never invents a missing payment.",
      points: [],
      footerLeft: "Read-only · no automatic mutation",
    });
    await clearHighlights(page);
    await page.locator("#audit-title").scrollIntoViewIfNeeded();
    const conflict = page.getByRole("heading", { name: /INV-2043/u });
    await conflict.waitFor({ state: "visible", timeout: 15_000 });
    await conflict.scrollIntoViewIfNeeded();
    await highlight(conflict);
    await page.getByText("18,400", { exact: true }).waitFor({
      state: "visible",
      timeout: 15_000,
    });
    await page.getByText("18,900", { exact: true }).waitFor({
      state: "visible",
      timeout: 15_000,
    });
    await waitUntilTimeline(timelineStartedAt, 84);
    await keyScreenshot(
      page,
      captureDirectory,
      "04-audit-conflict.png",
      screenshots
    );
    const absence = page.getByText("PAY-118", { exact: true });
    await absence.scrollIntoViewIfNeeded();
    await highlight(absence);
    await page.getByText("No automatic mutation", { exact: true }).waitFor({
      state: "visible",
      timeout: 15_000,
    });
    await waitUntilTimeline(timelineStartedAt, 99);
    await keyScreenshot(
      page,
      captureDirectory,
      "05-audit-absence.png",
      screenshots
    );
    await page
      .getByText("No automatic mutation", { exact: true })
      .scrollIntoViewIfNeeded();
    await waitUntilTimeline(timelineStartedAt, 108);

    await beginScene("proof", {
      layout: "caption-left",
      kicker: "Live proof ledger",
      title: "Exact release. Exact index.",
      detail:
        "CockroachDB Cloud on AWS · eu-west-1 · production runtime principal · native C-SPANN · 1024 dimensions · 9/9/9.",
      points: [
        "5k–10k evaluation corpora",
        "RF=3 placement",
        "single-node-loss recall",
      ],
      columns: 1,
      footerLeft: `release ${releaseSha.slice(0, 12)}`,
    });
    await clearHighlights(page);
    const proofLedger = page.locator("aside[aria-labelledby='proof-title']");
    await proofLedger.scrollIntoViewIfNeeded();
    await highlight(proofLedger);
    await page.getByText("Index verified", { exact: true }).waitFor({
      state: "visible",
      timeout: 15_000,
    });
    await page.getByTestId("release-sha-full").filter({ hasText: releaseSha }).waitFor({
      state: "visible",
      timeout: 15_000,
    });
    await waitUntilTimeline(timelineStartedAt, 120);
    await keyScreenshot(page, captureDirectory, "06-proof-ledger.png", screenshots);
    const releaseProof = page.getByTestId("release-sha-full");
    await releaseProof.scrollIntoViewIfNeeded();
    await highlight(releaseProof);
    await waitUntilTimeline(timelineStartedAt, 132);

    await beginScene("managed-mcp", {
      layout: "center",
      kicker: "Owned release evidence · Sanitized",
      title: "Cockroach Cloud Managed MCP Audit",
      detail:
        "A separate deterministic controller accepted exactly four hosted read-only calls at this release. No credentials, connection material, memory text, or embeddings appear here.",
      points: [
        "01 · get_cluster · cluster identity",
        "02 · list_tables · agent_memory present",
        "03 · get_table_schema · VECTOR(1024) + native index",
        "04 · select_query · bounded aggregate = 9 / 9 / 9",
        `Managed MCP run · ${runIds.mcp}`,
        `Deploy ${runIds.deploy} · DAST ${runIds.dast} · Recovery ${runIds.recovery}`,
      ],
      columns: 2,
      footerLeft: `exact release ${releaseSha}`,
      footerRight: "Four calls · fixed scope · read only",
    });
    await clearHighlights(page);
    await waitUntilTimeline(timelineStartedAt, 143);
    await keyScreenshot(
      page,
      captureDirectory,
      "07-managed-mcp.png",
      screenshots
    );

    await beginScene("close", {
      layout: "center",
      kicker: "Archon Memory",
      title: "Inspectable, contradiction-aware financial evidence.",
      detail:
        "The live demo and full source are public. Persistent agent memory can now show what it knows, what conflicts, and what is still missing.",
      points: [CANONICAL_ORIGIN, PUBLIC_REPOSITORY],
      columns: 1,
      footerLeft: "Live public demo",
      footerRight: "Full source · reproducible evidence",
    });
    await page.locator("#top").scrollIntoViewIfNeeded();
    await waitUntilTimeline(timelineStartedAt, 162);
    await keyScreenshot(page, captureDirectory, "08-close.png", screenshots);
    await waitUntilTimeline(timelineStartedAt, DURATION_SECONDS);
    await waitUntilTimeline(
      timelineStartedAt,
      DURATION_SECONDS + RECORDING_TAIL_SECONDS
    );
    rawVideoRecordedSeconds = Number(
      ((performance.now() - recordingEpoch) / 1_000).toFixed(3)
    );
    invariant(
      rawVideoRecordedSeconds + 0.05 >=
        DURATION_SECONDS +
          RECORDING_TAIL_SECONDS +
          rawVideoTrimLeadSeconds,
      "The raw recording did not contain the complete timeline and safety tail."
    );
    assertCleanBrowser(monitor);

    await page.close();
    await context.close();
    assertCleanBrowser(monitor);
    const temporaryVideoPath = await video.path();
    invariant(
      strictDescendant(resolve(captureDirectory), resolve(temporaryVideoPath)),
      "Playwright video escaped the capture directory."
    );
    await rename(temporaryVideoPath, outputVideoPath);
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }

  return {
    markerObservations,
    rawVideoRecordedSeconds,
    rawVideoTrimLeadSeconds,
    screenshots,
  };
}

async function main() {
  const releaseSha = requireEnvironment("EXPECTED_RELEASE_SHA", EXACT_SHA);
  const runIds = {
    deploy: requireRunId("DEMO_DEPLOY_RUN_ID"),
    dast: requireRunId("DEMO_DAST_RUN_ID"),
    mcp: requireRunId("DEMO_MCP_RUN_ID"),
    recovery: requireRunId("DEMO_RECOVERY_RUN_ID"),
  };
  const output = await prepareOutput();

  try {
    const plan = await loadScenePlan();
    const browser = await chromium.launch({
      headless: true,
      args: [
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--force-color-profile=srgb",
        "--hide-scrollbars",
      ],
    });

    let preflight;
    let capture;
    let postflight;
    try {
      preflight = await collectLiveProof(browser, releaseSha);
      capture = await recordProductionJourney({
        browser,
        captureDirectory: output.captureDirectory,
        outputVideoPath: output.videoPath,
        releaseSha,
        runIds,
        scenes: plan.scenes,
      });
      postflight = await collectLiveProof(browser, releaseSha);
    } finally {
      await browser.close().catch(() => {});
    }

    const captureFile = await describeFile(
      output.videoPath,
      "capture/production-capture.webm"
    );
    const screenshotFiles = [];
    for (const screenshot of capture.screenshots) {
      screenshotFiles.push(
        await describeFile(screenshot.path, `capture/${screenshot.name}`)
      );
    }

    const receipt = {
      schema: RECEIPT_SCHEMA,
      version: RECEIPT_VERSION,
      passed: true,
      canonicalOrigin: CANONICAL_ORIGIN,
      releaseSha,
      width: WIDTH,
      height: HEIGHT,
      compositionTargetFps: FPS,
      durationSeconds: DURATION_SECONDS,
      rawVideoTrimLeadSeconds: capture.rawVideoTrimLeadSeconds,
      rawVideoRecordedSeconds: capture.rawVideoRecordedSeconds,
      rawVideoTailSeconds: RECORDING_TAIL_SECONDS,
      sceneCount: EXPECTED_SCENES.length,
      liveProofBefore: true,
      liveProofAfter: true,
      cspEnforcedBefore: preflight.cspEnforced === true,
      cspEnforcedAfter: postflight.cspEnforced === true,
      recordingCspBypassedForOwnedOverlay: true,
      crossOriginRequests: 0,
      consoleErrors: 0,
      consoleWarnings: 0,
      pageErrors: 0,
      networkFailures: 0,
      httpErrors: 0,
      scenePlanSha256: plan.sha256,
      captureSha256: captureFile.sha256,
      capture: captureFile,
      video: captureFile,
      screenshots: screenshotFiles,
      markerSample: {
        x: MARKER_SAMPLE_X,
        y: MARKER_SAMPLE_Y,
        width: MARKER_SIZE,
        height: MARKER_SIZE,
      },
      scenes: capture.markerObservations.map((scene) => ({
        id: scene.id,
        startSeconds: scene.startSeconds,
        endSeconds: scene.endSeconds,
        markerObserved: scene.markerObserved,
      })),
      sceneMarkers: capture.markerObservations.map((scene) => ({
        id: scene.id,
        startSeconds: scene.startSeconds,
        endSeconds: scene.endSeconds,
        color: scene.color,
        markerObserved: scene.markerObserved,
      })),
      markerTelemetry: capture.markerObservations.map((scene) => ({
        id: scene.id,
        actualOffsetMilliseconds: scene.actualOffsetMilliseconds,
      })),
      liveProof: {
        pre: preflight,
        post: postflight,
      },
      evidenceRuns: {
        deploy: runIds.deploy,
        dast: runIds.dast,
        managedMcp: runIds.mcp,
        recovery: runIds.recovery,
      },
      redactions: [
        "credentials",
        "connection material",
        "memory text",
        "embeddings",
        "raw console messages",
        "raw network errors",
      ],
      browserChecks: {
        consoleErrors: 0,
        consoleWarnings: 0,
        pageErrors: 0,
        networkFailures: 0,
        httpErrors: 0,
        crossOriginRequests: 0,
        websocketViolations: 0,
      },
      completedAt: new Date().toISOString(),
    };

    await writeFile(output.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    console.log("Production capture completed with sanitized, hash-bound evidence.");
  } catch (error) {
    await rm(output.captureDirectory, { recursive: true, force: true });
    throw error;
  }
}

function sanitizedFailureMessage(error) {
  const raw =
    error instanceof Error && typeof error.message === "string"
      ? error.message
      : "unknown capture failure";
  return raw
    .normalize("NFKC")
    .replace(/[\r\n\t]+/gu, " ")
    .replace(
      /(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]+|Bearer\s+\S+|postgres(?:ql)?:\/\/\S+)/giu,
      "[redacted]"
    )
    .replace(
      /(api[_-]?key|token|password|authorization)\s*[:=]\s*\S+/giu,
      "$1=[redacted]"
    )
    .replace(/[^\x20-\x7e]/gu, "?")
    .slice(0, 500);
}

main().catch((error) => {
  console.error(
    `Production capture failed closed in the hosted CI runner: ${sanitizedFailureMessage(
      error
    )}`
  );
  process.exitCode = 1;
});
