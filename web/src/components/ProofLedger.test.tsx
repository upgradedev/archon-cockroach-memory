import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PublicApiError, type ProofSnapshot } from "../lib/api";
import { ProofLedger } from "./ProofLedger";

function verifiedProof(): ProofSnapshot {
  return {
    database: {
      provider: "CockroachDB Cloud",
      version: "v25.2",
      region: "aws-eu-central-1",
      regionEvidence: "live node locality",
      runtimePrincipal: "archon_production_0123456789",
      topology: "3-region RF=3",
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
    narrationModel: "eu.anthropic.claude-sonnet-4-6:0",
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
    features: ["C-SPANN vector search", "RF=3 survivability"],
    memoryCount: 9,
    generatedAt: "2026-07-30T08:00:00.000Z",
    hasEvidence: true,
  };
}

function ledger(proof: ProofSnapshot | undefined, options: {
  auditMemoryCount?: number | null;
  isLoading?: boolean;
  isFetching?: boolean;
  error?: unknown;
} = {}) {
  return (
    <ProofLedger
      proof={proof}
      auditMemoryCount={options.auditMemoryCount ?? null}
      isLoading={options.isLoading ?? false}
      isFetching={options.isFetching ?? false}
      error={options.error ?? null}
    />
  );
}

describe("ProofLedger", () => {
  it("renders the loading and withheld-metrics states", () => {
    const { rerender } = render(
      ledger(undefined, { isLoading: true, auditMemoryCount: 7 }),
    );
    expect(
      screen.getByRole("status", { name: "Loading infrastructure proof" }),
    ).toBeInTheDocument();

    rerender(ledger(undefined, { auditMemoryCount: 7 }));
    expect(screen.getByTestId("store-proof")).toHaveTextContent("Not reported");
    expect(screen.getByText("7 persistent records")).toBeInTheDocument();
    expect(screen.getAllByText("Not reported").length).toBeGreaterThan(1);
    expect(screen.getByText("dimensions unavailable · metric unavailable")).toBeInTheDocument();
    expect(screen.getByText("version and region not reported")).toBeInTheDocument();
    expect(screen.getByText("Scope mode not reported")).toBeInTheDocument();
  });

  it("renders an independently verifiable store, C-SPANN index, release, and models", () => {
    render(ledger(verifiedProof()));

    expect(screen.getByTestId("store-proof")).toHaveTextContent("Store verified");
    expect(screen.getByTestId("resolution-proof")).toHaveTextContent(
      "Human gate verified",
    );
    expect(screen.getByText("Index verified")).toBeInTheDocument();
    expect(screen.getByText("1024 dimensions · cosine")).toBeInTheDocument();
    expect(screen.getByText("3-region RF=3")).toBeInTheDocument();
    expect(screen.getByText("role archon_production_0123456789")).toBeInTheDocument();
    expect(screen.getByText("region evidence · live node locality")).toBeInTheDocument();
    expect(screen.getByTestId("release-sha-short")).toHaveTextContent(
      "Commit 0123456789ab",
    );
    expect(screen.getByTestId("release-sha-full")).toHaveTextContent(
      "0123456789abcdef0123456789abcdef01234567",
    );
    expect(screen.getByTestId("release-sha-evidence")).toHaveTextContent(
      "server-configured Lambda environment",
    );
    expect(screen.getByText("amazon.titan-embed-text-v2")).toBeInTheDocument();
    expect(screen.getByText("anthropic.claude-sonnet-4-6")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Canonical dataset read-only · action sandbox isolated",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("C-SPANN vector search")).toBeInTheDocument();
    expect(screen.getByText("RF=3 survivability")).toBeInTheDocument();
  });

  it("fails visible proof closed for every independently required invariant", () => {
    const mutations: Array<{
      boundary: "store" | "index";
      mutate: (proof: ProofSnapshot) => void;
    }> = [
      {
        boundary: "store",
        mutate: (proof) => {
          proof.memory.storeVerified = false;
        },
      },
      {
        boundary: "store",
        mutate: (proof) => {
          proof.memory.persisted = 8;
        },
      },
      {
        boundary: "store",
        mutate: (proof) => {
          proof.memory.idempotencyKeys = 8;
        },
      },
      {
        boundary: "store",
        mutate: (proof) => {
          proof.memory.contentDigests = 8;
        },
      },
      {
        boundary: "store",
        mutate: (proof) => {
          proof.memory.evidence = "static claim";
        },
      },
      {
        boundary: "store",
        mutate: (proof) => {
          proof.database.activeMemories = 8;
        },
      },
      {
        boundary: "index",
        mutate: (proof) => {
          proof.vectorIndex.enabled = false;
        },
      },
      {
        boundary: "index",
        mutate: (proof) => {
          proof.vectorIndex.name = "wrong-index";
        },
      },
      {
        boundary: "index",
        mutate: (proof) => {
          proof.vectorIndex.engine = "unknown";
        },
      },
      {
        boundary: "index",
        mutate: (proof) => {
          proof.vectorIndex.dimensions = 768;
        },
      },
      {
        boundary: "index",
        mutate: (proof) => {
          proof.vectorIndex.metric = "l2";
        },
      },
      {
        boundary: "index",
        mutate: (proof) => {
          proof.vectorIndex.lifecycleState = "backfilling";
        },
      },
      {
        boundary: "index",
        mutate: (proof) => {
          proof.vectorIndex.evidence = "static claim";
        },
      },
      {
        boundary: "index",
        mutate: (proof) => {
          proof.vectorIndex.definitionFingerprint = "short";
        },
      },
    ];
    const initial = verifiedProof();
    initial.hasEvidence = false;
    const { rerender } = render(ledger(initial, { isFetching: true }));
    expect(screen.getByTestId("proof-unverifiable")).toBeInTheDocument();

    for (const { boundary, mutate } of mutations) {
      const proof = verifiedProof();
      proof.hasEvidence = false;
      mutate(proof);
      rerender(ledger(proof));
      expect(screen.getByTestId("proof-unverifiable")).toBeInTheDocument();
      if (boundary === "store") {
        expect(screen.getByTestId("store-proof")).toHaveTextContent(
          "Not verified",
        );
        expect(screen.getByText("Index verified")).toBeInTheDocument();
      } else {
        expect(screen.getByTestId("store-proof")).toHaveTextContent(
          "Store verified",
        );
        expect(screen.getByText("Not verified")).toBeInTheDocument();
      }
    }

    const invalid = verifiedProof();
    invalid.hasEvidence = false;
    invalid.memory.storeVerified = null;
    invalid.memory.persisted = null;
    invalid.memory.idempotencyKeys = null;
    invalid.memory.contentDigests = null;
    invalid.memory.evidence = null;
    invalid.vectorIndex.enabled = null;
    invalid.vectorIndex.name = null;
    invalid.vectorIndex.dimensions = null;
    invalid.vectorIndex.metric = null;
    invalid.vectorIndex.engine = null;
    invalid.vectorIndex.lifecycleState = null;
    invalid.vectorIndex.evidence = null;
    invalid.vectorIndex.definitionFingerprint = null;
    invalid.database.provider = "";
    invalid.database.version = null;
    invalid.database.region = null;
    invalid.database.regionEvidence = null;
    invalid.database.runtimePrincipal = null;
    invalid.database.topology = null;
    invalid.embeddingModel = null;
    invalid.narrationModel = null;
    invalid.release.commitSha = null;
    invalid.release.evidence = null;
    invalid.scope.mode = "restricted-preview";
    invalid.features = [];
    invalid.memoryCount = null;
    rerender(ledger(invalid, { auditMemoryCount: 6 }));

    expect(screen.getByTestId("store-proof")).toHaveTextContent("Not reported");
    expect(screen.getByText("6 persistent records")).toBeInTheDocument();
    expect(screen.getByTestId("release-sha-short")).toHaveTextContent("Not reported");
    expect(screen.getByText("restricted-preview")).toBeInTheDocument();
  });

  it("distinguishes a missing proof from a stale successful snapshot", () => {
    const error = new PublicApiError("/api/proof", "Proof unavailable.", 503);
    const { rerender } = render(ledger(undefined, { error }));

    expect(screen.getByRole("alert")).toHaveTextContent("Proof unavailable.");
    expect(screen.getByRole("alert")).toHaveTextContent("Metrics withheld");

    rerender(ledger(verifiedProof(), { error }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Showing the last successful snapshot",
    );
  });
});
