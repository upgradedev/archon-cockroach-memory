import { afterEach, describe, expect, it, vi } from "vitest";
import { getAudit, getHealth, getProof, PublicApiError, recallMemory } from "./api";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("public API client", () => {
  it("keeps recall in the server-fixed company scope", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        question: "What is the real labour cost?",
        answer: "True employer cost was €15,375 [1].",
        modelId: "eu.anthropic.claude-sonnet-4-6",
        recalled: 1,
        citations: [
          {
            marker: "[1]",
            memoryId: "m-1",
            kind: "payroll_event",
            company: "Helios SA",
            period: "2026-04",
            score: 0.94,
            content: "Helios SA true employer cost was €15,375.",
            sourceRef: "EVT-HELIOS-2604",
          },
        ],
        grounding: {
          status: "verified",
          checks: { citations: true, numerics: true, claims: true },
        },
        trace: {
          retrieval: {
            index: "native C-SPANN vector index",
            metric: "cosine",
          },
          narration: {
            grounding: {
              status: "verified",
              checks: { citations: true, numerics: true, claims: true },
            },
            durationMs: 84,
          },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await recallMemory("What is the real labour cost?");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/recall");
    expect(JSON.parse(String(init.body))).toEqual({
      question: "What is the real labour cost?",
      limit: 5,
    });
    expect(String(init.body)).not.toContain("company");
    expect(result.citations[0]?.sourceRef).toBe("EVT-HELIOS-2604");
    expect(result.trace).toEqual({
      retrieval: "native C-SPANN vector index · cosine",
      grounding: "verified",
      durationMs: 84,
    });
  });

  it("normalizes the nested fixed public health scope without claiming dependency readiness", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          ok: true,
          status: "reachable",
          service: "archon-cockroach-memory",
          dependencies: "unchecked",
          scope: {
            tenantId: "public-demo",
            company: "Helios SA",
            mode: "fixed-synthetic-demo",
            access: "read-only",
          },
        }),
      ),
    );

    const health = await getHealth();
    expect(health.status).toBe("reachable");
    expect(health.dependencies).toBe("unchecked");
    expect(health.scope?.mode).toBe("fixed-synthetic-demo");
  });

  it("never upgrades an unknown health status to reachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ ok: true, status: "unknown", service: "archon-cockroach-memory" }),
      ),
    );

    expect((await getHealth()).status).toBe("degraded");
  });

  it("normalizes nested audit conflicts and absences", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          generatedAt: "2026-07-23T10:00:00.000Z",
          memories: [{ id: "m-1" }],
          coverage: { total: 9, scanned: 1, limit: 1, complete: false },
          report: {
            conflicts: [
              {
                subject: "INV-2043",
                attribute: "total",
                values: [
                  { memoryId: "m-1", value: 18400, createdAt: "2026-04-01T00:00:00.000Z" },
                  { memoryId: "m-2", value: 18900, createdAt: "2026-04-02T00:00:00.000Z" },
                ],
                recommendation: {
                  recommendedMemoryId: "m-2",
                  recommendedValue: 18900,
                  rule: "recency",
                  confidence: 0.68,
                  rationale: "The later structured write wins.",
                },
              },
            ],
            absences: [{ subject: "PAY-118", referencedBy: [{ memoryId: "m-3" }] }],
            summary: "Two findings require review.",
          },
        }),
      ),
    );

    const report = await getAudit();

    expect(report.ok).toBe(false);
    expect(report.memoryCount).toBe(9);
    expect(report.coverage.complete).toBe(false);
    expect(report.conflicts[0]?.resolution?.recommendedValue).toBe(18900);
    expect(report.absences[0]?.subject).toBe("PAY-118");
  });

  it("treats missing audit coverage as incomplete and withholds all-clear", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ report: { ok: true, conflicts: [], absences: [] } }),
      ),
    );

    const report = await getAudit();
    expect(report.coverage.complete).toBe(false);
    expect(report.ok).toBe(false);
  });

  it("never trusts an explicit audit all-clear over returned findings", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          coverage: { total: 1, scanned: 1, limit: 100, complete: true },
          report: {
            ok: true,
            contradictions: [
              {
                subject: "INV-2043",
                attribute: "total",
                values: [{ memoryId: "m-1", value: 18_400 }],
              },
            ],
            absences: [],
          },
        }),
      ),
    );

    const report = await getAudit();
    expect(report.coverage.complete).toBe(true);
    expect(report.conflicts).toHaveLength(1);
    expect(report.ok).toBe(false);
  });

  it("rejects contradictory audit coverage counts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          coverage: { total: 9, scanned: 1, limit: 100, complete: true },
          report: { ok: true, contradictions: [], absences: [] },
        }),
      ),
    );

    const report = await getAudit();
    expect(report.coverage.complete).toBe(false);
    expect(report.ok).toBe(false);
  });

  it("normalizes the finalized infrastructure proof contract", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          database: {
            engine: "CockroachDB",
            deployment: "CockroachDB Cloud on AWS",
            version: "25.4.10",
            region: "eu-west-1",
            regionEvidence: "cockroach-cloud-api-release-gate",
            runtimePrincipal: "archon_production_example",
            activeMemories: 6,
          },
          vectorIndex: {
            enabled: true,
            name: "idx_agent_memory_company_scope_embedding",
            engine: "native CockroachDB C-SPANN",
            dimensions: 1024,
            metric: "cosine",
            lifecycleState: "active",
            evidence: "live pg_catalog.pg_indexes definition",
            definitionFingerprint:
              "b7cc3c41bf7ba74c53ce75f7a8937132ef5facb5f4c78b5bfd52ad8667244d70",
          },
          embeddingModel: "amazon.titan-embed-text-v2:0",
          narrationModel: "eu.anthropic.claude-sonnet-4-6",
          scope: {
            tenantId: "public-demo",
            company: "Helios SA",
            mode: "fixed-synthetic-demo",
          },
          features: ["C-SPANN vector search", { name: "RF=3 survivability" }],
          generatedAt: "2026-07-23T10:00:00.000Z",
        }),
      ),
    );

    const proof = await getProof();

    expect(proof.hasEvidence).toBe(true);
    expect(proof.vectorIndex.dimensions).toBe(1024);
    expect(proof.scope).toEqual({ company: "Helios SA", mode: "fixed-synthetic-demo" });
    expect(proof.features).toEqual(["C-SPANN vector search", "RF=3 survivability"]);
  });

  it("accepts only the canonical zero-claim no-evidence response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          question: "Is there evidence for a merger?",
          answer: "No relevant memories found in the agent's CockroachDB memory.",
          modelId: "eu.anthropic.claude-sonnet-4-6",
          recalled: 0,
          citations: [],
          consistencyOk: true,
          grounding: {
            status: "no-evidence",
            checks: { citations: false, numerics: false, claims: false },
          },
          trace: {
            retrieval: {
              index: "native C-SPANN vector index",
              metric: "cosine",
            },
            narration: {
              grounding: {
                status: "no-evidence",
                checks: { citations: false, numerics: false, claims: false },
              },
            },
          },
        }),
      ),
    );

    const result = await recallMemory("Is there evidence for a merger?");
    expect(result.noEvidence).toBe(true);
    expect(result.recalled).toBe(0);
    expect(result.citations).toEqual([]);
    expect(result.degraded).toBe(false);
  });

  it("does not turn a failed proof request into fake metrics", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "proof unavailable" }, 503)));

    await expect(getProof()).rejects.toEqual(
      expect.objectContaining<Partial<PublicApiError>>({
        status: 503,
        message: "proof unavailable",
      }),
    );
  });

  it("refuses to display an uncited recall answer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          answer: "An answer without evidence.",
          modelId: "eu.anthropic.claude-sonnet-4-6",
          citations: [],
          grounding: {
            status: "verified",
            checks: { citations: true, numerics: true, claims: true },
          },
        }),
      ),
    );

    await expect(recallMemory("What happened?")).rejects.toEqual(
      expect.objectContaining<Partial<PublicApiError>>({
        message: "Recall returned missing or malformed CockroachDB citations, so no answer is displayed.",
      }),
    );
  });

  it("rejects non-canonical citation marker numbering", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          question: "What is the real labour cost?",
          answer: "True employer cost was €15,375 [01].",
          modelId: "eu.anthropic.claude-sonnet-4-6",
          recalled: 1,
          citations: [
            {
              marker: "[01]",
              memoryId: "m-1",
              kind: "payroll_event",
              company: "Helios SA",
              period: "2026-04",
              score: 0.94,
              content: "Helios SA true employer cost was €15,375.",
              sourceRef: "EVT-HELIOS-2604",
            },
          ],
          grounding: {
            status: "verified",
            checks: { citations: true, numerics: true, claims: true },
          },
        }),
      ),
    );

    await expect(
      recallMemory("What is the real labour cost?"),
    ).rejects.toEqual(
      expect.objectContaining<Partial<PublicApiError>>({
        message:
          "Recall returned missing or malformed CockroachDB citations, so no answer is displayed.",
      }),
    );
  });

  it("accepts only the exact evidence rendering for extractive grounding", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          question: "What is the real labour cost?",
          answer: "Helios SA true employer cost was €15,375 [1].",
          modelId: "eu.anthropic.claude-sonnet-4-6",
          recalled: 1,
          citations: [
            {
              marker: "[1]",
              memoryId: "m-1",
              kind: "payroll_event",
              company: "Helios SA",
              period: "2026-04",
              score: 0.94,
              content: "Helios SA true employer cost was €15,375.",
              sourceRef: "EVT-HELIOS-2604",
            },
          ],
          grounding: {
            status: "extractive",
            checks: { citations: true, numerics: true, claims: true },
          },
          warning: "The model answer was accepted without modification.",
        }),
      ),
    );

    const result = await recallMemory("What is the real labour cost?");
    expect(result.trace.grounding).toBe("extractive");
    expect(result.degraded).toBe(false);
    expect(result.warning).toMatch(/exact revalidated CockroachDB evidence/iu);
    expect(result.warning).not.toMatch(/accepted without modification/iu);
  });

  it("rejects a forged extractive paraphrase even when checks claim success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          question: "What is the real labour cost?",
          answer: "The labour cost was €15,375 [1].",
          modelId: "eu.anthropic.claude-sonnet-4-6",
          recalled: 1,
          citations: [
            {
              marker: "[1]",
              memoryId: "m-1",
              kind: "payroll_event",
              company: "Helios SA",
              period: "2026-04",
              score: 0.94,
              content: "Helios SA true employer cost was €15,375.",
              sourceRef: "EVT-HELIOS-2604",
            },
          ],
          grounding: {
            status: "extractive",
            checks: { citations: true, numerics: true, claims: true },
          },
        }),
      ),
    );

    await expect(
      recallMemory("What is the real labour cost?"),
    ).rejects.toEqual(
      expect.objectContaining<Partial<PublicApiError>>({
        message:
          "Recall extractive answer did not match the exact cited evidence rendering.",
      }),
    );
  });
});
