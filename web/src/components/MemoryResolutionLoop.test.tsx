import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolutionSnapshot } from "../lib/api";
import { MemoryResolutionLoop } from "./MemoryResolutionLoop";

const apiMocks = vi.hoisted(() => ({
  createResolutionSession: vi.fn(),
  decideResolution: vi.fn(),
}));

vi.mock("../lib/api", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, ...apiMocks };
});

function snapshot(
  state: "pending" | "approved" | "rejected" = "pending"
): ResolutionSnapshot {
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
        status:
          state === "approved"
            ? "current"
            : state === "rejected"
              ? "rejected"
              : "candidate",
      },
    ],
    proposal: {
      id: "44444444-4444-4444-8444-444444444444",
      action: "resolve-conflicting-memory",
      status: state,
      proposedObservationId: correctedId,
      supersedesObservationId: priorId,
      rationale:
        "Prefer the newer signed payroll register, but require human approval.",
      requiresHumanRole: "financial-controller",
    },
    receipt:
      state !== "pending"
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
          : state === "rejected"
            ? "human-rejected-correction"
            : "two-source-conflict-observed",
      consolidation:
        state === "approved"
          ? "approved-observation-is-current"
          : state === "rejected"
            ? "prior-observation-remains-current"
            : "awaiting-human-decision",
      forgetting:
        state === "pending"
          ? "session-scoped-ttl-pending"
          : "session-scoped-ttl-after-decision",
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

function renderLoop() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryResolutionLoop />
    </QueryClientProvider>
  );
}

describe("MemoryResolutionLoop", () => {
  beforeEach(() => {
    apiMocks.createResolutionSession.mockReset().mockResolvedValue({
      token: "A".repeat(43),
      snapshot: snapshot(),
    });
    apiMocks.decideResolution
      .mockReset()
      .mockResolvedValue(snapshot("approved"));
  });

  it("keeps the agent advisory until a human commits the correction", async () => {
    const user = userEvent.setup();
    renderLoop();

    await user.click(
      screen.getByRole("button", { name: "Start resolution session" })
    );
    expect(
      await screen.findByRole("status", {
        name: "Human decision pending",
      })
    ).toBeInTheDocument();
    expect(screen.getByText("€124,400.00")).toBeInTheDocument();
    expect(screen.getByText("€128,900.00")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Approve correction" })
    );
    expect(
      await screen.findByRole("status", { name: "Correction approved" })
    ).toBeInTheDocument();
    expect(apiMocks.decideResolution).toHaveBeenCalledOnce();
    expect(apiMocks.decideResolution.mock.calls[0]?.[0]).toBe("A".repeat(43));
    expect(apiMocks.decideResolution.mock.calls[0]?.[1]).toBe("approve");
    expect(apiMocks.decideResolution.mock.calls[0]?.[2]).toMatch(
      /^[0-9a-f-]{36}$/iu
    );
    expect(screen.getByText(/receipt \//iu)).toHaveTextContent("a".repeat(64));
  });

  it("reuses the same idempotency key after an ambiguous network failure", async () => {
    const user = userEvent.setup();
    apiMocks.decideResolution.mockRejectedValue(
      new Error("The decision response was lost.")
    );
    renderLoop();
    await user.click(
      screen.getByRole("button", { name: "Start resolution session" })
    );
    await screen.findByRole("status", { name: "Human decision pending" });

    await user.click(
      screen.getByRole("button", { name: "Approve correction" })
    );
    expect(
      await screen.findByText("The decision response was lost.")
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Retry same approval" })
    );
    await waitFor(() =>
      expect(apiMocks.decideResolution).toHaveBeenCalledTimes(2)
    );
    expect(apiMocks.decideResolution.mock.calls[1]?.[2]).toBe(
      apiMocks.decideResolution.mock.calls[0]?.[2]
    );
  });

  it("preserves the prior memory after a human rejection and can start fresh", async () => {
    const user = userEvent.setup();
    apiMocks.decideResolution.mockResolvedValue(snapshot("rejected"));
    renderLoop();

    await user.click(
      screen.getByRole("button", { name: "Start resolution session" })
    );
    await screen.findByRole("status", { name: "Human decision pending" });
    await user.click(
      screen.getByRole("button", { name: "Reject correction" })
    );

    expect(
      await screen.findByRole("status", { name: "Correction rejected" })
    ).toBeInTheDocument();
    expect(apiMocks.decideResolution.mock.calls[0]?.[1]).toBe("reject");
    expect(
      screen.getByText("Session C / consolidated current memory")
        .nextElementSibling
    ).toHaveTextContent("€124,400.00");

    await user.click(
      screen.getByRole("button", {
        name: "Start a fresh disposable session",
      })
    );
    await waitFor(() =>
      expect(apiMocks.createResolutionSession).toHaveBeenCalledTimes(2)
    );
  });

  it("surfaces a failed session create without retaining a capability", async () => {
    const user = userEvent.setup();
    apiMocks.createResolutionSession.mockRejectedValue(
      new Error("The sandbox is temporarily unavailable.")
    );
    renderLoop();

    await user.click(
      screen.getByRole("button", { name: "Start resolution session" })
    );
    expect(
      await screen.findByRole("alert")
    ).toHaveTextContent("The sandbox is temporarily unavailable.");
    expect(apiMocks.decideResolution).not.toHaveBeenCalled();
  });
});
