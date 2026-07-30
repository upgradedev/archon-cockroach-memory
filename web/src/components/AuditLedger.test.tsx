import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PublicApiError, type AuditReport } from "../lib/api";
import { AuditLedger } from "./AuditLedger";

function auditReport(overrides: Partial<AuditReport> = {}): AuditReport {
  return {
    audited: 9,
    subjects: 7,
    conflicts: [],
    absences: [],
    recommendations: [],
    ok: true,
    summary: "The fixed public scope was audited.",
    memoryCount: 9,
    generatedAt: "2026-07-30T08:00:00.000Z",
    coverage: {
      total: 9,
      scanned: 9,
      limit: 100,
      complete: true,
    },
    ...overrides,
  };
}

describe("AuditLedger", () => {
  it("renders loading and unavailable states without inferring an all-clear", () => {
    const onRefresh = vi.fn();
    const { rerender } = render(
      <AuditLedger
        report={undefined}
        isLoading={true}
        isFetching={false}
        error={null}
        onRefresh={onRefresh}
      />,
    );

    expect(
      screen.getByRole("status", { name: "Loading memory audit" }),
    ).toBeInTheDocument();

    rerender(
      <AuditLedger
        report={undefined}
        isLoading={false}
        isFetching={false}
        error={new PublicApiError("/api/audit", "Audit timed out.", 504)}
        onRefresh={onRefresh}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Audit timed out.");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "No “all clear” result is inferred",
    );
  });

  it("shows a complete empty audit and routes an explicit refresh", () => {
    const onRefresh = vi.fn();
    render(
      <AuditLedger
        report={auditReport()}
        isLoading={false}
        isFetching={false}
        error={null}
        onRefresh={onRefresh}
      />,
    );

    expect(screen.getByText("No findings in this scope")).toBeInTheDocument();
    expect(screen.getByText("The fixed public scope was audited.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Run audit again" }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("withholds all-clear for partial coverage and disables concurrent refresh", () => {
    const onRefresh = vi.fn();
    render(
      <AuditLedger
        report={auditReport({
          audited: null,
          memoryCount: null,
          summary: null,
          ok: false,
          coverage: {
            total: null,
            scanned: null,
            limit: null,
            complete: false,
          },
        })}
        isLoading={false}
        isFetching={true}
        error={null}
        onRefresh={onRefresh}
      />,
    );

    expect(screen.getByText("Coverage limited")).toBeInTheDocument();
    expect(screen.getByText(/an unreported number of/)).toBeInTheDocument();
    expect(screen.getByText(/an unreported total of/)).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
    const refresh = screen.getByRole("button", { name: "Auditing…" });
    expect(refresh).toBeDisabled();
    fireEvent.click(refresh);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("renders conflicts, absences, recommendations, and a stale-snapshot warning", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    render(
      <AuditLedger
        report={auditReport({
          audited: null,
          memoryCount: 8,
          ok: false,
          conflicts: [
            {
              subject: "INV-2043",
              attribute: "total",
              values: [
                {
                  memoryId: "mem-number",
                  sourceRef: "invoice-a",
                  value: 18_400.5,
                  createdAt: "2026-04-01T12:00:00.000Z",
                },
                {
                  memoryId: "mem-string",
                  sourceRef: null,
                  value: "€18,900",
                  createdAt: "not-a-date",
                },
              ],
              resolution: {
                recommendedMemoryId: "mem-string",
                recommendedValue: 18_900,
                rule: "recency",
                confidence: 0.68,
                rationale: "The later signed source is preferred.",
              },
            },
            {
              subject: "VAT-APR",
              attribute: "filed",
              values: [
                {
                  memoryId: "mem-boolean",
                  sourceRef: null,
                  value: true,
                  createdAt: null,
                },
                {
                  memoryId: "mem-null",
                  sourceRef: null,
                  value: null,
                  createdAt: null,
                },
              ],
              resolution: null,
            },
            {
              subject: "PAY-118",
              attribute: "metadata",
              values: [
                {
                  memoryId: "mem-object",
                  sourceRef: null,
                  value: { state: "pending" },
                  createdAt: null,
                },
                {
                  memoryId: "mem-circular",
                  sourceRef: null,
                  value: circular,
                  createdAt: null,
                },
              ],
              resolution: {
                recommendedMemoryId: null,
                recommendedValue: false,
                rule: "manual",
                confidence: 150,
                rationale: "A human must reconcile the source.",
              },
            },
            {
              subject: "BANK-APR",
              attribute: "balance",
              values: [
                {
                  memoryId: "mem-low-confidence",
                  sourceRef: null,
                  value: false,
                  createdAt: null,
                },
              ],
              resolution: {
                recommendedMemoryId: null,
                recommendedValue: null,
                rule: "manual",
                confidence: null,
                rationale: "No deterministic preference exists.",
              },
            },
          ],
          absences: [
            {
              subject: "DOC-404",
              referencedBy: [
                { memoryId: "mem-1", sourceRef: null },
                { memoryId: "mem-2", sourceRef: "ledger" },
              ],
              recommendation: "Locate the signed invoice.",
            },
            {
              subject: "DOC-UNATTRIBUTED",
              referencedBy: [],
              recommendation: null,
            },
          ],
          recommendations: [
            "Verify the invoice total with the controller.",
            "Attach the missing document.",
          ],
        })}
        isLoading={false}
        isFetching={false}
        error={new Error("refresh failed")}
        onRefresh={vi.fn()}
      />,
    );

    expect(screen.getByText(/last successful snapshot/)).toBeInTheDocument();
    expect(screen.getByText("INV-2043")).toBeInTheDocument();
    expect(
      screen.getByText(
        new Intl.NumberFormat("en-IE", {
          maximumFractionDigits: 2,
        }).format(18_400.5),
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("€18,900")).toBeInTheDocument();
    for (const expected of [
      "68 / 100 heuristic signal",
      "100 / 100 heuristic signal",
      "signal not reported",
    ]) {
      expect(
        screen.getByText(
          (_, element) =>
            element?.tagName === "P" &&
            element.textContent?.includes(expected) === true,
        ),
      ).toBeInTheDocument();
    }
    expect(screen.getByText("Human review required")).toBeInTheDocument();
    expect(screen.getAllByText("not reported").length).toBeGreaterThan(0);
    expect(screen.getByText('{"state":"pending"}')).toBeInTheDocument();
    expect(screen.getByText("unreadable value")).toBeInTheDocument();
    expect(screen.getByText("not-a-date")).toBeInTheDocument();
    expect(screen.getAllByText("time not reported").length).toBeGreaterThan(0);
    expect(screen.getByText("Referenced by mem-1, mem-2")).toBeInTheDocument();
    expect(screen.getByText(/Referenced by an unreported memory/)).toBeInTheDocument();
    expect(screen.getByText("Locate the signed invoice.")).toBeInTheDocument();
    expect(
      screen.getByText(/Locate the source record, then ingest the missing evidence/),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Verify the invoice total with the controller."),
    ).toBeInTheDocument();
  });
});
