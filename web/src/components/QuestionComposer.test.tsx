import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { QuestionComposer } from "./QuestionComposer";

describe("QuestionComposer", () => {
  it("submits a suggested investigation without exposing a company selector", async () => {
    const user = userEvent.setup();
    const onAsk = vi.fn();
    render(<QuestionComposer isPending={false} onAsk={onAsk} />);

    await user.click(screen.getByRole("button", { name: /true employer cost/i }));

    expect(onAsk).toHaveBeenCalledWith(
      "What was Helios SA’s true employer cost and how much was invisible on the bank statement?",
    );
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("prevents an empty custom question", async () => {
    render(<QuestionComposer isPending={false} onAsk={vi.fn()} />);

    expect(screen.getByRole("button", { name: /ask archon/i })).toBeDisabled();
  });

  it("trims and submits a bounded custom question", async () => {
    const user = userEvent.setup();
    const onAsk = vi.fn();
    render(<QuestionComposer isPending={false} onAsk={onAsk} />);
    const question = screen.getByLabelText(
      "Financial question for the Archon memory",
    );

    await user.type(question, "   Which invoice is missing?   ");
    await user.click(screen.getByRole("button", { name: /ask archon/i }));

    expect(onAsk).toHaveBeenCalledWith("Which invoice is missing?");

    fireEvent.change(question, { target: { value: "x".repeat(510) } });
    expect(question).toHaveValue("x".repeat(500));
    expect(screen.getByLabelText("500 of 500 characters")).toBeInTheDocument();
  });

  it("locks every input while a recall is pending", () => {
    const onAsk = vi.fn();
    render(<QuestionComposer isPending={true} onAsk={onAsk} />);

    expect(
      screen.getByLabelText("Financial question for the Archon memory"),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /retrieving evidence/i }),
    ).toBeDisabled();
    const suggestions = screen
      .getAllByRole("button")
      .filter((button) => button.getAttribute("type") === "button");
    expect(suggestions).toHaveLength(4);
    for (const suggestion of suggestions) {
      expect(suggestion).toBeDisabled();
      fireEvent.click(suggestion);
    }
    expect(onAsk).not.toHaveBeenCalled();
  });
});
