import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PublicApiError, type RecallResult } from "../lib/api";
import { AnswerBrief } from "./AnswerBrief";

function recallResult(overrides: Partial<RecallResult> = {}): RecallResult {
  return {
    question: "What changed in April?",
    answer: "Payroll cost was €15,375 [1].",
    modelId: "eu.anthropic.claude-sonnet-4-6",
    recalled: 1,
    citations: [
      {
        marker: "[1]",
        memoryId: "mem-1",
        kind: "payroll_event",
        company: "Helios SA",
        period: "2026-04",
        score: 0.943,
        content: "Payroll cost was €15,375.",
        sourceRef: "EVT-HELIOS-2604",
      },
    ],
    consistencyOk: true,
    trace: {
      retrieval: "native C-SPANN · cosine",
      grounding: "verified",
      durationMs: 42.6,
    },
    degraded: false,
    warning: null,
    noEvidence: false,
    ...overrides,
  };
}

describe("AnswerBrief", () => {
  it("renders the idle, loading, and fail-closed error states", () => {
    const { rerender } = render(
      <AnswerBrief
        result={undefined}
        activeQuestion={null}
        isPending={false}
        error={null}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Every answer should leave a trail." }),
    ).toBeInTheDocument();

    rerender(
      <AnswerBrief
        result={undefined}
        activeQuestion={null}
        isPending={true}
        error={null}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Retrieving and grounding the answer.",
    );
    expect(
      screen.getByRole("heading", { name: "Reading distributed memory…" }),
    ).toBeInTheDocument();

    rerender(
      <AnswerBrief
        result={undefined}
        activeQuestion={null}
        isPending={false}
        error={
          new PublicApiError(
            "/api/recall",
            "The live recall service rejected the request.",
            503,
          )
        }
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The live recall service rejected the request.",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "No cached or fabricated answer is shown.",
    );
  });

  it("links a verified narration to its exact evidence and reports optional provenance", () => {
    render(
      <AnswerBrief
        result={recallResult()}
        activeQuestion="Operator-selected question"
        isPending={false}
        error={null}
      />,
    );

    expect(screen.getByText("Operator-selected question")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Jump to evidence [1]" }),
    ).toHaveAttribute("href", "#citation-1");
    expect(screen.getByTestId("grounding-status")).toHaveTextContent(
      "verified · 43 ms",
    );
    expect(screen.getByText("94% semantic match")).toBeInTheDocument();
    expect(screen.getByText("payroll event")).toBeInTheDocument();
    expect(screen.getByText("scope / Helios SA · 2026-04")).toBeInTheDocument();
    expect(
      screen.getByText("source / EVT-HELIOS-2604"),
    ).toBeInTheDocument();
  });

  it("withholds unsafe narration and exposes every degraded signal", () => {
    render(
      <AnswerBrief
        result={recallResult({
          answer: "This text must not be displayed.",
          modelId: "offline-fake-model",
          citations: [
            {
              marker: "[1]",
              memoryId: "mem-1",
              kind: "financial_fact",
              company: "Helios SA",
              period: null,
              score: null,
              content: "Exact first fact.",
              sourceRef: null,
            },
            {
              marker: "[2]",
              memoryId: "mem-2",
              kind: "document_reference",
              company: "Helios SA",
              period: null,
              score: -1,
              content: "Exact second fact.",
              sourceRef: null,
            },
          ],
          recalled: 2,
          consistencyOk: false,
          warning: "Grounding was downgraded by policy.",
          trace: {
            retrieval: null,
            grounding: "fallback",
            durationMs: null,
          },
        })}
        activeQuestion={null}
        isPending={false}
        error={null}
      />,
    );

    expect(screen.queryByText("This text must not be displayed.")).not.toBeInTheDocument();
    expect(
      screen.getByText(/Model narration was withheld because it did not pass/),
    ).toBeInTheDocument();
    expect(screen.getByText("Degraded narration:", { exact: false })).toBeInTheDocument();
    expect(screen.getByText(/contains a consistency finding/)).toBeInTheDocument();
    expect(screen.getByText("Grounding was downgraded by policy.")).toBeInTheDocument();
    expect(screen.getByText("vector-ranked")).toBeInTheDocument();
    expect(screen.getByTestId("grounding-status")).toHaveTextContent("fallback");
    expect(screen.getAllByText("Ranked evidence")).toHaveLength(2);
    expect(screen.getByText("What changed in April?")).toBeInTheDocument();
  });

  it("renders the canonical no-evidence state without inventing citations", () => {
    render(
      <AnswerBrief
        result={recallResult({
          answer: "No relevant memories found in the agent's CockroachDB memory.",
          recalled: 0,
          citations: [],
          trace: {
            retrieval: null,
            grounding: null,
            durationMs: null,
          },
          noEvidence: true,
        })}
        activeQuestion={null}
        isPending={false}
        error={null}
      />,
    );

    expect(
      screen.getByText(/No relevant evidence exists in the fixed CockroachDB memory scope/),
    ).toBeInTheDocument();
    expect(screen.getByTestId("grounding-status")).toHaveTextContent("not reported");
  });

  it("labels an impossible empty evidence set as unverified", () => {
    render(
      <AnswerBrief
        result={recallResult({
          citations: [],
          recalled: 0,
          noEvidence: false,
        })}
        activeQuestion={null}
        isPending={false}
        error={null}
      />,
    );

    expect(
      screen.getByText("The answer returned no citation records. Treat it as unverified."),
    ).toBeInTheDocument();
  });
});
