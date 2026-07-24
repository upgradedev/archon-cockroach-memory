import { render, screen } from "@testing-library/react";
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
});
