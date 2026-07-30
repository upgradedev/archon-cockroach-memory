import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AuditReport,
  ProofSnapshot,
  RecallResult,
  ServiceHealth,
} from "./lib/api";
import { App } from "./App";

const apiMocks = vi.hoisted(() => ({
  getHealth: vi.fn(),
  getAudit: vi.fn(),
  getProof: vi.fn(),
  recallMemory: vi.fn(),
}));

vi.mock("./lib/api", async () => {
  const actual = await vi.importActual<typeof import("./lib/api")>("./lib/api");
  return {
    ...actual,
    ...apiMocks,
  };
});

const health: ServiceHealth = {
  ok: true,
  status: "reachable",
  service: "archon-memory",
  version: "1.0.0",
  dependencies: "ready",
  scope: {
    tenantId: "public-demo",
    company: "Helios SA",
    mode: "fixed-synthetic-demo",
    access: "read-only",
  },
};

const audit: AuditReport = {
  audited: 9,
  subjects: 7,
  conflicts: [],
  absences: [],
  recommendations: [],
  ok: true,
  summary: "No deterministic conflicts were found.",
  memoryCount: 9,
  generatedAt: "2026-07-30T08:00:00.000Z",
  coverage: {
    total: 9,
    scanned: 9,
    limit: 100,
    complete: true,
  },
};

const proof: ProofSnapshot = {
  database: {
    provider: "CockroachDB Cloud",
    version: "v25.2",
    region: "aws-eu-central-1",
    regionEvidence: "live node locality",
    runtimePrincipal: "archon_production_0123456789",
    topology: "RF=3",
    activeMemories: 9,
  },
  vectorIndex: {
    enabled: true,
    name: "idx_agent_memory_company_scope_embedding",
    dimensions: 1024,
    metric: "cosine",
    engine: "native CockroachDB C-SPANN",
    lifecycleState: "active",
    evidence: "live pg_catalog.pg_indexes definition",
    definitionFingerprint: "a".repeat(64),
    plan: "vector search",
    recallAt10Percent: 0.99,
    p95Ms: 21,
  },
  embeddingModel: "amazon.titan-embed-text-v2:0",
  narrationModel: "eu.anthropic.claude-sonnet-4-6",
  scope: {
    company: "Helios SA",
    mode: "fixed-synthetic-demo",
  },
  memory: {
    persisted: 9,
    idempotencyKeys: 9,
    contentDigests: 9,
    storeVerified: true,
    evidence: "live bounded fixed-scope payload-digest verification",
  },
  release: {
    commitSha: "0123456789abcdef0123456789abcdef01234567",
    evidence: "server-configured Lambda environment",
  },
  features: ["C-SPANN vector search"],
  memoryCount: 9,
  generatedAt: "2026-07-30T08:00:00.000Z",
  hasEvidence: true,
};

const recall: RecallResult = {
  question:
    "What was Helios SA’s true employer cost and how much was invisible on the bank statement?",
  answer: "True employer cost was €15,375 [1].",
  modelId: "eu.anthropic.claude-sonnet-4-6",
  recalled: 1,
  citations: [
    {
      marker: "[1]",
      memoryId: "mem-payroll",
      kind: "payroll_event",
      company: "Helios SA",
      period: "2026-04",
      score: 0.97,
      content: "True employer cost was €15,375.",
      sourceRef: "EVT-HELIOS-2604",
    },
  ],
  consistencyOk: true,
  trace: {
    retrieval: "native C-SPANN · cosine",
    grounding: "verified",
    durationMs: 32,
  },
  degraded: false,
  warning: null,
  noEvidence: false,
};

function renderApp() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );
}

describe("App", () => {
  beforeEach(() => {
    apiMocks.getHealth.mockReset().mockResolvedValue(health);
    apiMocks.getAudit.mockReset().mockResolvedValue(audit);
    apiMocks.getProof.mockReset().mockResolvedValue(proof);
    apiMocks.recallMemory.mockReset().mockResolvedValue(recall);
  });

  it("connects recall, proof refresh, and audit refresh through React Query", async () => {
    const user = userEvent.setup();
    renderApp();

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("API reachable"),
    );
    await waitFor(() =>
      expect(screen.getByTestId("store-proof")).toHaveTextContent(
        "Store verified",
      ),
    );
    expect(
      await screen.findByText("No findings in this scope"),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /true employer cost/i }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("link", { name: "Jump to evidence [1]" }),
      ).toBeInTheDocument(),
    );
    expect(apiMocks.recallMemory).toHaveBeenCalledWith(recall.question);

    await user.click(screen.getByRole("button", { name: "Refresh proof" }));
    await waitFor(() => {
      expect(apiMocks.getHealth).toHaveBeenCalledTimes(2);
      expect(apiMocks.getAudit).toHaveBeenCalledTimes(2);
      expect(apiMocks.getProof).toHaveBeenCalledTimes(2);
      expect(
        screen.getByRole("button", { name: "Run audit again" }),
      ).toBeEnabled();
    });

    await user.click(
      screen.getByRole("button", { name: "Run audit again" }),
    );
    await waitFor(() => expect(apiMocks.getAudit).toHaveBeenCalledTimes(3));
  });

  it("renders every failed boundary without substituting stale data", async () => {
    const user = userEvent.setup();
    apiMocks.getHealth.mockRejectedValue(new Error("Health unavailable."));
    apiMocks.getAudit.mockRejectedValue(new Error("Audit unavailable."));
    apiMocks.getProof.mockRejectedValue(new Error("Proof unavailable."));
    apiMocks.recallMemory.mockRejectedValue(new Error("Recall unavailable."));
    renderApp();

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Proof unavailable"),
    );
    expect(await screen.findByText("Audit unavailable.")).toBeInTheDocument();
    expect(await screen.findByText("Proof unavailable.")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /true employer cost/i }),
    );
    await waitFor(() =>
      expect(screen.getByText("Recall unavailable.")).toBeInTheDocument(),
    );
  });
});
