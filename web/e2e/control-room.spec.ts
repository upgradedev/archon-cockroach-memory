import { expect, test, type Page } from "@playwright/test";

const live = process.env.PLAYWRIGHT_LIVE === "1";
const question =
  "What was Helios SA’s true employer cost and how much was invisible on the bank statement?";
const releaseCommitSha = "0123456789abcdef0123456789abcdef01234567";

const scope = {
  tenantId: "public-demo",
  company: "Helios SA",
  mode: "fixed-synthetic-demo",
  access: "read-only",
  dataClassification: "synthetic-public-demo",
  source: "server-configured",
};

function resolutionSnapshot(state: "pending" | "approved") {
  const priorId = "11111111-1111-4111-8111-111111111111";
  const correctedId = "22222222-2222-4222-8222-222222222222";
  return {
    sessionId: "33333333-3333-4333-8333-333333333333",
    scenarioId: "helios-payroll-2026-06-correction-v1",
    company: "Helios SA",
    period: "2026-06",
    state,
    expiresAt: "2026-08-01T12:00:00.000Z",
    observations: [
      {
        id: priorId,
        label: "prior",
        sourceRef: "payroll-register-2026-06-v1",
        sourceClass: "payroll-register",
        observedAt: "2026-07-01T08:00:00.000Z",
        authorityRank: 60,
        employerCostCents: 12_440_000,
        employerCostDisplay: "€124,400.00",
        status: state === "approved" ? "superseded" : "current",
      },
      {
        id: correctedId,
        label: "corrected",
        sourceRef: "signed-payroll-register-2026-06-v2",
        sourceClass: "signed-payroll-register",
        observedAt: "2026-07-08T10:30:00.000Z",
        authorityRank: 100,
        employerCostCents: 12_890_000,
        employerCostDisplay: "€128,900.00",
        status: state === "approved" ? "current" : "candidate",
      },
    ],
    proposal: {
      id: "44444444-4444-4444-8444-444444444444",
      action: "resolve-conflicting-memory",
      status: state,
      proposedObservationId: correctedId,
      supersedesObservationId: priorId,
      rationale:
        "Prefer the newer signed payroll register, but preserve both sources and require a financial controller decision.",
      requiresHumanRole: "financial-controller",
    },
    receipt:
      state === "approved"
        ? {
            algorithm: "sha256",
            digest: "a".repeat(64),
            decisionId: "55555555-5555-4555-8555-555555555555",
            decidedAt: "2026-07-31T09:00:00.000Z",
            actorRole: "financial-controller",
            policyVersion: "resolution-policy-v1",
          }
        : null,
    lifecycle: {
      learning:
        state === "approved"
          ? "human-approved-correction"
          : "two-source-conflict-observed",
      consolidation:
        state === "approved"
          ? "approved-observation-is-current"
          : "awaiting-human-decision",
      forgetting:
        state === "approved"
          ? "session-scoped-ttl-after-decision"
          : "session-scoped-ttl-pending",
      externalSideEffects: "none",
    },
    policy: {
      version: "resolution-policy-v1",
      conflictRule: "newer-higher-authority-evidence-is-proposed",
      authorityBoundary: "human-approval-required",
      mutationScope: "ephemeral-synthetic-session-only",
      retention: "row-level-ttl",
      canonicalMemoryMutable: false,
    },
  };
}

async function installDeterministicApi(page: Page): Promise<void> {
  let resolutionState: "pending" | "approved" = "pending";
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
          runtimePrincipal: "archon_production_a1b2c3d4e5",
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
        resolutionLoop: {
          enabled: true,
          schemaTables: 5,
          activeSandboxSessions: 0,
          transactionIsolation: "SERIALIZABLE",
          authorityBoundary: "financial-controller-human-gate",
          identityAssurance: "fixed-demo-role-assertion-not-authenticated",
          idempotency: "decision-key+database-unique-constraint",
          receipt: "SHA-256 immutable decision record",
          learning: "conflict-observation+human-decision",
          consolidation: "versioned current/superseded state",
          forgetting: "CockroachDB row-level TTL",
          canonicalMemoryMutable: false,
          externalSideEffects: "none",
          evidence: "live fixed-scope sandbox schema query",
        },
        embeddingModel: "amazon.titan-embed-text-v2:0",
        narrationModel: "eu.anthropic.claude-sonnet-4-6",
        memory: {
          persisted: 9,
          idempotencyKeys: 9,
          contentDigests: 9,
          storeVerified: true,
          evidence: "live bounded fixed-scope payload-digest verification",
        },
        release: {
          commitSha: releaseCommitSha,
          evidence: "server-configured Lambda environment",
        },
        scope,
        features: [
          "role-bound fixed synthetic scope",
          "contradiction and absence audit",
        ],
        generatedAt: new Date().toISOString(),
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
  await page.route("**/api/resolution/session", (route) =>
    route.fulfill({
      status: route.request().method() === "POST" ? 201 : 200,
      json:
        route.request().method() === "POST"
          ? {
              sessionToken: "A".repeat(43),
              tokenType: "Bearer",
              snapshot: resolutionSnapshot(resolutionState),
            }
          : { snapshot: resolutionSnapshot(resolutionState) },
    })
  );
  await page.route("**/api/resolution/decision", async (route) => {
    const body = route.request().postDataJSON() as {
      decision?: unknown;
      idempotencyKey?: unknown;
    };
    if (
      body.decision !== "approve" ||
      typeof body.idempotencyKey !== "string"
    ) {
      await route.fulfill({
        status: 400,
        json: { error: "invalid deterministic resolution request" },
      });
      return;
    }
    resolutionState = "approved";
    await route.fulfill({
      json: {
        snapshot: resolutionSnapshot("approved"),
        idempotent: true,
      },
    });
  });
}

test.beforeEach(async ({ page }) => {
  if (!live) await installDeterministicApi(page);
});

test("judge journey exposes fixed scope, live proof, audit, and cited recall", async ({
  page,
}) => {
  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: /Financial Agent Memory/i })
  ).toBeVisible();
  await expect(
    page.getByText("Canonical Scope", { exact: true })
  ).toBeVisible();
  await expect(page.getByText("API reachable")).toBeVisible();

  await expect(page.getByText("CockroachDB", { exact: true }).first()).toBeVisible();
  await expect(
    page.getByText(
      "Canonical dataset read-only · action sandbox isolated"
    )
  ).toBeVisible();
  await expect(page.getByTestId("store-proof")).toHaveText("Store verified");
  await expect(page.getByTestId("resolution-proof")).toHaveText(
    "Human gate verified"
  );
  await expect(page.getByText("9 persistent records", { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      "9/9 unique idempotency keys · 9/9 payload-bound SHA-256 digests",
      { exact: true }
    )
  ).toBeVisible();
  await expect(
    page.getByText("canonical-memory mutation disabled", { exact: true })
  ).toBeVisible();
  await expect(
    page.getByText("live bounded fixed-scope payload-digest verification", { exact: true })
  ).toBeVisible();
  await expect(page.getByText("region evidence · cockroach-cloud-api-release-gate")).toBeVisible();
  if (live) {
    await expect(page.getByTestId("release-sha-short")).toHaveText(
      /^Commit [0-9a-f]{12}$/u
    );
    await expect(page.getByTestId("release-sha-full")).toHaveText(
      /^full SHA · [0-9a-f]{40}$/u
    );
  } else {
    await expect(page.getByTestId("release-sha-short")).toHaveText(
      `Commit ${releaseCommitSha.slice(0, 12)}`
    );
    await expect(page.getByTestId("release-sha-full")).toHaveText(
      `full SHA · ${releaseCommitSha}`
    );
  }
  await expect(page.getByTestId("release-sha-evidence")).toHaveText(
    "release evidence · server-configured Lambda environment"
  );
  if (live) {
    await expect(
      page.getByText(/role archon_(?:staging|production)_[0-9a-f]{10}/)
    ).toBeVisible();
  } else {
    await expect(
      page.getByText("role archon_production_a1b2c3d4e5")
    ).toBeVisible();
  }
  await expect(page.getByText("active · live pg_catalog.pg_indexes definition")).toBeVisible();
  await expect(page.getByTestId("proof-unverifiable")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "The memory audits itself." })).toBeVisible();

  await page.getByRole("button", { name: "Start resolution session" }).click();
  await expect(
    page.getByRole("status", { name: "Human decision pending" })
  ).toBeVisible();
  await expect(page.getByText("€124,400.00", { exact: true })).toBeVisible();
  await expect(page.getByText("€128,900.00", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Approve correction" }).click();
  await expect(
    page.getByRole("status", { name: "Correction approved" })
  ).toBeVisible();
  await expect(page.getByText(/receipt \/[a-f0-9 ]*/iu)).toBeVisible();

  if (live) {
    await page.getByLabel("Financial question for the Archon memory").fill(question);
    await page.getByRole("button", { name: /Execute Financial Recall|Ask Archon/ }).click();
  } else {
    await page.getByRole("button", { name: new RegExp(question.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).click();
  }

  await expect(page.getByText(/memories recalled/)).toBeVisible();
  await expect(page.getByText("Exact returned evidence")).toBeVisible();
  await expect(page.locator("[id^='citation-']")).not.toHaveCount(0);
  await expect(page.getByText(/native C-SPANN vector index/)).toBeVisible();
  const groundingStatus = page.getByTestId("grounding-status");
  if (live) {
    await expect(groundingStatus).toContainText(/verified|extractive|fallback/);
    const status = await groundingStatus.textContent();
    if (status?.includes("extractive")) {
      await expect(
        page.getByText(/exact revalidated CockroachDB evidence/i)
      ).toBeVisible();
    }
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
  await page.getByRole("button", { name: new RegExp(question.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).click();

  await expect(
    page.getByRole("heading", { name: "The question was not answered." })
  ).toBeVisible();
  await expect(page.getByText("No cached or fabricated answer is shown.")).toBeVisible();
  await expect(page.getByText(/€15,375/)).toHaveCount(0);
});

test("executive user journey verifies KPI badges and guided scenarios A, B, C, D", async ({ page }) => {
  await page.goto("/");

  // Verify Executive KPI Badges
  await expect(page.getByText("100% Cited")).toBeVisible();
  await expect(page.getByText("Compliant (Art 14/50)")).toBeVisible();
  await expect(page.getByText("< 1500 ms")).toBeVisible();
  await expect(page.getByText("SHA-256 Sealed")).toBeVisible();

  // Verify 3-Step User Journey Guide
  await expect(page.getByText("Operational User Journey")).toBeVisible();
  await expect(page.getByText("Recall or Ingest Facts")).toBeVisible();
  await expect(page.getByText("Inspect Discrepancy Radar")).toBeVisible();
  await expect(page.getByText("Human Gate & SHA-256 Receipt")).toBeVisible();

  // Verify Executive Guided Scenario Cards
  await expect(page.getByText("SCENARIO A — INVOICE DISCREPANCY")).toBeVisible();
  await expect(page.getByText("SCENARIO B — MISSING PAYMENT PROOF")).toBeVisible();
  await expect(page.getByText("SCENARIO C — CONFLICT AUDIT")).toBeVisible();
  await expect(page.getByText("SCENARIO D — CFO CLOSE GATE")).toBeVisible();

  // Click Scenario A and verify recall execution
  await page.getByRole("button", { name: new RegExp(question.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).click();
  await expect(page.getByText(/memories recalled/)).toBeVisible();
  await expect(page.getByText("Exact returned evidence")).toBeVisible();
});
