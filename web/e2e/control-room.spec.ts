import { expect, test, type Page } from "@playwright/test";

const live = process.env.PLAYWRIGHT_LIVE === "1";
const question =
  "What was Helios SA’s true employer cost and how much was invisible on the bank statement?";

const scope = {
  tenantId: "public-demo",
  company: "Helios SA",
  mode: "fixed-synthetic-demo",
  access: "read-only",
  dataClassification: "synthetic-public-demo",
  source: "server-configured",
};

async function installDeterministicApi(page: Page): Promise<void> {
  await page.route("**/api/health", (route) =>
    route.fulfill({
      json: {
        ok: true,
        status: "reachable",
        service: "archon-cockroach-memory",
        dependencies: "unchecked",
        scope,
      },
    })
  );
  await page.route("**/api/proof", (route) =>
    route.fulfill({
      json: {
        database: {
          engine: "CockroachDB",
          deployment: "CockroachDB Cloud on AWS",
          version: "CockroachDB CCL v26.2.3",
          region: "eu-west-1",
          regionEvidence: "cockroach-cloud-api-release-gate",
          runtimePrincipal: "archon_production_example",
          activeMemories: 9,
        },
        vectorIndex: {
          engine: "native CockroachDB C-SPANN",
          enabled: true,
          name: "idx_agent_memory_company_scope_embedding",
          metric: "cosine",
          dimensions: 1024,
          lifecycleState: "active",
          evidence: "live pg_catalog.pg_indexes definition",
          definitionFingerprint:
            "b7cc3c41bf7ba74c53ce75f7a8937132ef5facb5f4c78b5bfd52ad8667244d70",
        },
        embeddingModel: "amazon.titan-embed-text-v2:0",
        narrationModel: "eu.anthropic.claude-sonnet-4-6",
        scope,
        features: [
          "role-bound fixed synthetic scope",
          "contradiction and absence audit",
        ],
        generatedAt: "2026-07-23T10:00:00.000Z",
      },
    })
  );
  await page.route("**/api/audit", (route) =>
    route.fulfill({
      json: {
        report: {
          audited: 9,
          ok: false,
          contradictions: [
            {
              subject: "INV-2043",
              attribute: "total",
              values: [
                {
                  memoryId: "m-1",
                  value: 18400,
                  createdAt: "2026-04-01T00:00:00.000Z",
                },
                {
                  memoryId: "m-2",
                  value: 18900,
                  createdAt: "2026-04-02T00:00:00.000Z",
                },
              ],
              resolution: {
                recommendedMemoryId: "m-2",
                recommendedValue: 18900,
                rule: "recency",
                confidence: 0.68,
                rationale: "The later structured write wins.",
              },
            },
          ],
          absences: [
            {
              subject: "PAY-118",
              referencedBy: [{ memoryId: "m-3" }],
              recommendation: "Locate the missing bank confirmation.",
            },
          ],
        },
        memories: [{ id: "m-1" }],
        coverage: { total: 9, scanned: 9, limit: 100, complete: true },
        generatedAt: "2026-07-23T10:00:00.000Z",
        scope,
      },
    })
  );
  await page.route("**/api/recall", (route) =>
    route.fulfill({
      json: {
        question,
        answer:
          "Helios SA’s true employer cost was €15,375 [1]. The bank transfer omitted a €6,775 off-bank employment-cost wedge [2].",
        modelId: "eu.anthropic.claude-sonnet-4-6",
        grounding: {
          status: "verified",
          checks: { citations: true, numerics: true, claims: true },
        },
        recalled: 2,
        citations: [
          {
            marker: "[1]",
            memoryId: "m-4",
            kind: "payroll_event",
            company: "Helios SA",
            period: "2026-04",
            sourceRef: "EVT-HELIOS-2604",
            score: 0.94,
            content: "Helios SA’s true employer cost was €15,375.",
          },
          {
            marker: "[2]",
            memoryId: "m-5",
            kind: "insight",
            company: "Helios SA",
            period: "2026-04",
            sourceRef: "EVT-HELIOS-2604",
            score: 0.91,
            content:
              "The bank transfer omitted a €6,775 off-bank employment-cost wedge.",
          },
        ],
        consistencyOk: true,
        trace: {
          scope,
          retrieval: {
            index: "native C-SPANN vector index",
            metric: "cosine",
            embeddingModel: "amazon.titan-embed-text-v2:0",
            recalled: 2,
            minScore: 0.15,
          },
          narration: {
            model: "eu.anthropic.claude-sonnet-4-6",
            grounding: {
              status: "verified",
              checks: { citations: true, numerics: true, claims: true },
            },
          },
        },
      },
    })
  );
}

test.beforeEach(async ({ page }) => {
  if (!live) await installDeterministicApi(page);
});

test("judge journey exposes fixed scope, live proof, audit, and cited recall", async ({
  page,
}) => {
  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: "Memory that disagrees out loud." })
  ).toBeVisible();
  await expect(
    page.getByText("Fixed synthetic scope", { exact: true })
  ).toBeVisible();
  await expect(page.getByText("API reachable")).toBeVisible();

  await expect(page.getByText("CockroachDB", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Fixed synthetic public dataset · read-only")).toBeVisible();
  await expect(page.getByText("region evidence · cockroach-cloud-api-release-gate")).toBeVisible();
  if (live) {
    await expect(
      page.getByText(/role archon_(?:staging|production)_[a-z0-9]{6,40}/)
    ).toBeVisible();
  } else {
    await expect(page.getByText("role archon_production_example")).toBeVisible();
  }
  await expect(page.getByText("active · live pg_catalog.pg_indexes definition")).toBeVisible();
  await expect(page.getByTestId("proof-unverifiable")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "The memory audits itself." })).toBeVisible();

  if (live) {
    await page.getByLabel("Financial question for the Archon memory").fill(question);
    await page.getByRole("button", { name: /Ask Archon/ }).click();
  } else {
    await page.getByRole("button", { name: question }).click();
  }

  await expect(page.getByText(/memories recalled/)).toBeVisible();
  await expect(page.getByText("Exact returned evidence")).toBeVisible();
  await expect(page.locator("[id^='citation-']")).not.toHaveCount(0);
  await expect(page.getByText(/native C-SPANN vector index/)).toBeVisible();
  const groundingStatus = page.getByTestId("grounding-status");
  if (live) {
    await expect(groundingStatus).toContainText(/verified|fallback/);
    const status = await groundingStatus.textContent();
    if (status?.includes("fallback")) {
      await expect(
        page.getByText(/deterministic cited fallback/i)
      ).toBeVisible();
    }
    await expect(page.getByText(/fake-narrator|offline/i)).toHaveCount(0);
  } else {
    await expect(groundingStatus).toContainText("verified");
  }
});

test("service failure never becomes a fabricated answer", async ({ page }) => {
  test.skip(live, "failure injection is deterministic-CI only");
  await page.route("**/api/recall", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "grounded recall is temporarily unavailable" }),
    })
  );

  await page.goto("/");
  await page.getByRole("button", { name: question }).click();

  await expect(
    page.getByRole("heading", { name: "The question was not answered." })
  ).toBeVisible();
  await expect(page.getByText("No cached or fabricated answer is shown.")).toBeVisible();
  await expect(page.getByText(/€15,375/)).toHaveCount(0);
});
