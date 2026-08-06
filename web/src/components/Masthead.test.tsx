import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ServiceHealth } from "../lib/api";
import { Hero } from "./Hero";
import { Masthead } from "./Masthead";

const reachableHealth: ServiceHealth = {
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

describe("Masthead and Hero", () => {
  it("maps every service state to an honest public status", () => {
    const onRefresh = vi.fn();
    const { rerender } = render(
      <Masthead
        health={undefined}
        isLoading={true}
        hasError={false}
        isRefreshing={false}
        onRefresh={onRefresh}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Checking");

    rerender(
      <Masthead
        health={undefined}
        isLoading={false}
        hasError={true}
        isRefreshing={false}
        onRefresh={onRefresh}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Proof unavailable");

    rerender(
      <Masthead
        health={{ ...reachableHealth, ok: false, status: "degraded" }}
        isLoading={false}
        hasError={false}
        isRefreshing={false}
        onRefresh={onRefresh}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Degraded");

    rerender(
      <Masthead
        health={reachableHealth}
        isLoading={false}
        hasError={false}
        isRefreshing={false}
        onRefresh={onRefresh}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("API reachable");
    fireEvent.click(screen.getByRole("button", { name: "Refresh proof" }));
    expect(onRefresh).toHaveBeenCalledOnce();

    rerender(
      <Masthead
        health={reachableHealth}
        isLoading={false}
        hasError={false}
        isRefreshing={true}
        onRefresh={onRefresh}
      />,
    );
    expect(screen.getByRole("button", { name: "Refreshing…" })).toBeDisabled();
  });

  it("declares the fixed, synthetic, read-only demonstration scope", () => {
    render(<Hero />);

    expect(
      screen.getByRole("heading", { name: /Financial Agent Memory That Disagrees Out Loud/ }),
    ).toBeInTheDocument();
    expect(screen.getByText("Helios SA")).toBeInTheDocument();
    expect(
      screen.getByText(/Canonical demonstration data stays read-only/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/maximum one-hour storage TTL/i)).toBeInTheDocument();
  });
});
