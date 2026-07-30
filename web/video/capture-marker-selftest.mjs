import { chromium } from "@playwright/test";
import {
  activateScene,
  installCaptureOverlay,
  resolveCanonicalAuditLocators,
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

    await page.setContent(`
      <!doctype html>
      <html>
        <body>
          <h2>Off-bank employment cost at INV-2043</h2>
          <section aria-labelledby="audit-title">
            <h2 id="audit-title">The memory audits itself.</h2>
            <article>
              <h3>INV-2043<span>/</span><span>total</span></h3>
              <p>18,400</p>
              <p>18,900</p>
              <p>18,400</p>
            </article>
            <article>
              <h3>PAY-118</h3>
              <p>No automatic mutation</p>
            </article>
          </section>
        </body>
      </html>
    `);
    const formerlyAmbiguousHeadings = page.getByRole("heading", {
      name: /INV-2043/u,
    });
    if ((await formerlyAmbiguousHeadings.count()) !== 2) {
      throw new Error(
        "The strict audit-locator fixture did not reproduce the ambiguous heading"
      );
    }
    const auditLocators = await resolveCanonicalAuditLocators(page);
    await auditLocators.conflictHeading.waitFor({ state: "visible" });
    await auditLocators.primaryValue.waitFor({ state: "visible" });
    await auditLocators.competingValue.waitFor({ state: "visible" });
    await auditLocators.absenceHeading.waitFor({ state: "visible" });
    await auditLocators.noAutomaticMutation.waitFor({ state: "visible" });
  } finally {
    await context.close();
  }
} finally {
  await browser.close();
}

process.stdout.write(
  "Capture Chromium self-test passed computed RGBA, geometry, DOM reinjection, and strict audit locators.\n"
);
