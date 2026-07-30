import { chromium } from "@playwright/test";
import {
  activateScene,
  installCaptureOverlay,
} from "./capture-production.mjs";

const VIEWPORT = Object.freeze({ width: 1920, height: 1080 });
const CARD = Object.freeze({
  layout: "center",
  kicker: "Hosted marker self-test",
  title: "Computed-RGBA contract",
  detail: "No network, production data, or output file is involved.",
  points: Object.freeze(["RGBA-normalized", "DOM-recoverable"]),
  columns: 2,
  footerLeft: "CI-only fixture",
  footerRight: "runner memory only",
});
const SCENES = Object.freeze([
  Object.freeze({ id: "hook", color: "#34d399" }),
  Object.freeze({ id: "scope-architecture", color: "#38bdf8" }),
]);

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: VIEWPORT });
  try {
    const page = await context.newPage();
    await page.setContent(
      '<!doctype html><html><head></head><body style="margin:0"></body></html>'
    );
    await installCaptureOverlay(page);
    await activateScene(page, SCENES[0], CARD);

    await page.evaluate(() => {
      for (const id of [
        "archon-capture-style",
        "archon-production-overlay",
        "archon-scene-marker",
        "archon-scene-label",
      ]) {
        document.getElementById(id)?.remove();
      }
    });

    await activateScene(page, SCENES[1], CARD);
    const finalScene = await page
      .locator("#archon-scene-marker")
      .getAttribute("data-scene-id");
    if (finalScene !== SCENES[1].id) {
      throw new Error("Capture marker self-test did not restore the expected scene");
    }
  } finally {
    await context.close();
  }
} finally {
  await browser.close();
}

process.stdout.write(
  "Capture marker Chromium self-test passed computed RGBA, geometry, and DOM reinjection.\n"
);
