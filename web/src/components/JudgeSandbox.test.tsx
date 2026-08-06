import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PublicApiError } from "../lib/api";
import { JudgeSandbox } from "./JudgeSandbox";

const apiMocks = vi.hoisted(() => ({
  auditSandboxFacts: vi.fn(),
  ingestSandboxFact: vi.fn(),
  recallSandboxFact: vi.fn(),
}));

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>(
    "../lib/api",
  );
  return { ...actual, ...apiMocks };
});

describe("JudgeSandbox", () => {
  const token = "z".repeat(43);

  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.ingestSandboxFact.mockResolvedValue({
      sandboxToken: token,
      memoryId: "11111111-1111-4111-8111-111111111111",
      reused: false,
      ttlSeconds: 3600,
      expiresAt: "2026-08-06T12:00:00.000Z",
    });
    apiMocks.auditSandboxFacts.mockResolvedValue([
      {
        subject: "INV-9901",
        attribute: "total",
        values: [
          {
            value: 45000,
            sourceRef: "DOC-9901-A",
            memoryId: "11111111-1111-4111-8111-111111111111",
          },
          {
            value: 47000,
            sourceRef: "DOC-9901-B",
            memoryId: "22222222-2222-4222-8222-222222222222",
          },
        ],
      },
    ]);
    apiMocks.recallSandboxFact.mockResolvedValue({
      answer:
        "No relevant memories found that are safe for narration from the agent's CockroachDB memory.",
      recalled: 1,
      citations: [],
      grounding: {
        status: "no-evidence",
        reason: "instruction-like recalled evidence was withheld before narration",
      },
    });
  });

  it("keeps the capability private and demonstrates a contradiction", async () => {
    const user = userEvent.setup();
    render(<JudgeSandbox />);

    await user.click(screen.getByRole("button", { name: "Start sandbox" }));
    expect(await screen.findByText("Session active")).toBeInTheDocument();
    expect(screen.queryByText(token)).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Load conflicting fact" }),
    );
    expect(screen.getByLabelText("Numeric value")).toHaveValue("47000");
    await user.click(
      screen.getByRole("button", { name: "Store another fact" }),
    );
    expect(apiMocks.ingestSandboxFact).toHaveBeenLastCalledWith(
      expect.objectContaining({ sandboxToken: token, numericValue: 47000 }),
    );

    await user.click(
      screen.getByRole("button", { name: "Detect contradictions" }),
    );
    expect(await screen.findByText("Contradiction detected")).toBeInTheDocument();
    expect(screen.getByText(/45000 \(DOC-9901-A\).*47000 \(DOC-9901-B\)/u)).toBeInTheDocument();
  });

  it("discloses when recalled evidence is unsafe for narration", async () => {
    const user = userEvent.setup();
    render(<JudgeSandbox />);

    await user.click(screen.getByRole("button", { name: "Start sandbox" }));
    await screen.findByText("Session active");
    await user.click(
      screen.getByRole("button", { name: "Recall with citations" }),
    );

    expect(await screen.findByText(/No safe evidence · 1 recalled/u)).toBeInTheDocument();
    expect(
      screen.getByText(/instruction-like recalled evidence was withheld/iu),
    ).toBeInTheDocument();
  });

  it("clears an expired capability so a new session can start", async () => {
    apiMocks.recallSandboxFact.mockRejectedValue(
      new PublicApiError(
        "/api/sandbox/recall",
        "sandbox session expired",
        410,
      ),
    );
    const user = userEvent.setup();
    render(<JudgeSandbox />);

    await user.click(screen.getByRole("button", { name: "Start sandbox" }));
    await screen.findByText("Session active");
    await user.click(
      screen.getByRole("button", { name: "Recall with citations" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "sandbox session expired",
    );
    expect(
      screen.getByRole("button", { name: "Start sandbox" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Session active")).not.toBeInTheDocument();
  });
});
