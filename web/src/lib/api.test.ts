import { afterEach, describe, expect, it, vi } from "vitest";
import {
  auditSandboxFacts,
  createResolutionSession,
  decideResolution,
  getAudit,
  getHealth,
  getProof,
  PublicApiError,
  recallMemory,
  ingestSandboxFact,
  recallSandboxFact,
} from "./api";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("judge sandbox API", () => {
  const sandboxToken = "s".repeat(43);

  it("stores structured evidence and preserves the opaque capability", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          ok: true,
          sandbox_token: sandboxToken,
          memory_id: "11111111-1111-4111-8111-111111111111",
          reused: false,
          ttl_seconds: 3600,
          expires_at: "2026-08-06T12:00:00.000Z",
        },
        201,
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await ingestSandboxFact({
      company: "Judge Corp",
      fact: "Invoice INV-9901 is recorded at EUR 45000.",
      sourceRef: "DOC-9901-A",
      subject: "INV-9901",
      attribute: "total",
      numericValue: 45000,
    });

    expect(result.sandboxToken).toBe(sandboxToken);
    expect(result.ttlSeconds).toBe(3600);
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/sandbox/ingest");
    const request = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(request.sandbox_token).toBeUndefined();
    expect(request.numericValue).toBe(45000);
  });

  it("rejects stringly typed sandbox storage receipts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          ok: true,
          sandbox_token: sandboxToken,
          memory_id: "11111111-1111-4111-8111-111111111111",
          reused: "false",
          ttl_seconds: "3600",
          expires_at: "2026-08-06T12:00:00.000Z",
        }),
      ),
    );

    await expect(
      ingestSandboxFact({
        company: "Judge Corp",
        fact: "Invoice INV-9901 is recorded at EUR 45000.",
        sourceRef: "DOC-9901-A",
        subject: "INV-9901",
        attribute: "total",
        numericValue: 45000,
      }),
    ).rejects.toBeInstanceOf(PublicApiError);
  });

  it("accepts a transparently withheld recall hit and parses contradictions", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          answer: "The sandbox contains 45000 [1].",
          recalled: 2,
          grounding: {
            status: "verified",
            checks: { citations: true, numerics: true, claims: true },
            reason: "instruction-like recalled evidence was withheld before narration",
          },
          citations: [
            {
              marker: "[1]",
              memoryId: "11111111-1111-4111-8111-111111111111",
              company: "Judge Corp",
              content: "Invoice value 45000.",
              sourceRef: "DOC-A",
              score: 1,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          contradictions: [
            {
              subject: "INV-9901",
              attribute: "total",
              values: [
                {
                  value: 45000,
                  sourceRef: "DOC-A",
                  memoryId: "11111111-1111-4111-8111-111111111111",
                },
                {
                  value: 47000,
                  sourceRef: "DOC-B",
                  memoryId: "22222222-2222-4222-8222-222222222222",
                },
              ],
            },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const recall = await recallSandboxFact(sandboxToken, "What values exist?");
    expect(recall.citations[0]?.company).toBe("Judge Corp");
    const contradictions = await auditSandboxFacts(sandboxToken);
    expect(contradictions[0]?.values.map((item) => item.value)).toEqual([
      45000,
      47000,
    ]);
  });

  it("fails closed on a malformed sandbox audit receipt", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          ok: true,
          contradictions: [
            {
              subject: "INV-9901",
              attribute: "total",
              values: [{ value: 45000, sourceRef: "DOC-A" }],
            },
          ],
        }),
      ),
    );

    await expect(auditSandboxFacts(sandboxToken)).rejects.toBeInstanceOf(
      PublicApiError,
    );
  });

  it("rejects a recall receipt without an exact grounding contract", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          ok: true,
          answer: "Invoice value 45000 [1].",
          recalled: 1,
          citations: [
            {
              marker: "[1]",
              memoryId: "11111111-1111-4111-8111-111111111111",
              company: "Judge Corp",
              content: "Invoice value 45000.",
              sourceRef: "DOC-A",
              score: "1",
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
      recallSandboxFact(sandboxToken, "What value exists?"),
    ).rejects.toBeInstanceOf(PublicApiError);
  });

  it("fails closed when one sandbox audit value is malformed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          ok: true,
          contradictions: [
            {
              subject: "INV-9901",
              attribute: "total",
              values: [
                {
                  value: 45000,
                  sourceRef: "DOC-A",
                  memoryId: "11111111-1111-4111-8111-111111111111",
                },
                {
                  value: "46000",
                  sourceRef: "DOC-B",
                  memoryId: "22222222-2222-4222-8222-222222222222",
                },
                {
                  value: 47000,
                  sourceRef: "DOC-C",
                  memoryId: "33333333-3333-4333-8333-333333333333",
                },
              ],
            },
          ],
        }),
      ),
    );

    await expect(auditSandboxFacts(sandboxToken)).rejects.toBeInstanceOf(
      PublicApiError,
    );
  });
});

function finalizedProofBody() {
  return {
    database: {
      engine: "CockroachDB",
      deployment: "CockroachDB Cloud on AWS",
      version: "25.4.10",
      region: "eu-west-1",
      regionEvidence: "cockroach-cloud-api-release-gate",
      runtimePrincipal: "archon_production_a1b2c3d4e5",
      activeMemories: 9,
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
    narrationModel: "eu.anthropic.claude-sonnet-4-6",
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
    scope: {
      tenantId: "public-demo",
      company: "Helios SA",
      mode: "fixed-synthetic-demo",
    },
    features: ["C-SPANN vector search", { name: "RF=3 survivability" }],
    generatedAt: new Date().toISOString(),
  };
}

function resolutionBody(
  state: "pending" | "approved" | "rejected" = "pending",
) {
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
        "Prefer the newer signed payroll register, but preserve both sources and require a financial controller decision.",
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
        jsonResponse(finalizedProofBody()),
      ),
    );

    const proof = await getProof();

    expect(proof.hasEvidence).toBe(true);
    expect(proof.database.activeMemories).toBe(9);
    expect(proof.memory).toEqual({
      persisted: 9,
      idempotencyKeys: 9,
      contentDigests: 9,
      storeVerified: true,
      evidence: "live bounded fixed-scope payload-digest verification",
    });
    expect(proof.vectorIndex.dimensions).toBe(1024);
    expect(proof.release).toEqual({
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      evidence: "server-configured Lambda environment",
    });
    expect(proof.scope).toEqual({ company: "Helios SA", mode: "fixed-synthetic-demo" });
    expect(proof.features).toEqual(["C-SPANN vector search", "RF=3 survivability"]);
  });

  it("fails the release proof closed unless the SHA and evidence pair are exact", async () => {
    const invalidReleases = [
      {
        commitSha: "0123456789abcdef0123456789abcdef0123456",
        evidence: "server-configured Lambda environment",
      },
      {
        commitSha: "0123456789ABCDEF0123456789ABCDEF01234567",
        evidence: "server-configured Lambda environment",
      },
      {
        commitSha: " 0123456789abcdef0123456789abcdef01234567",
        evidence: "server-configured Lambda environment",
      },
      {
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        evidence: "request-provided release claim",
      },
    ];

    for (const release of invalidReleases) {
      const body = finalizedProofBody();
      body.release = release;
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(jsonResponse(body)),
      );

      const proof = await getProof();

      expect(proof.release).toEqual({ commitSha: null, evidence: null });
      expect(proof.hasEvidence).toBe(false);
    }
  });

  it("fails the infrastructure proof closed when durable-store coverage disagrees", async () => {
    const body = finalizedProofBody();
    body.memory.contentDigests = 8;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(body)),
    );

    const proof = await getProof();

    expect(proof.memory.storeVerified).toBe(false);
    expect(proof.memory.persisted).toBe(9);
    expect(proof.memory.contentDigests).toBe(8);
    expect(proof.hasEvidence).toBe(false);
  });

  it("fails the store proof closed when the database total disagrees", async () => {
    const body = finalizedProofBody();
    body.database.activeMemories = 99;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(body)),
    );

    const proof = await getProof();

    expect(proof.memory.storeVerified).toBe(false);
    expect(proof.database.activeMemories).toBe(99);
    expect(proof.memoryCount).toBe(99);
    expect(proof.hasEvidence).toBe(false);
  });

  it("requires the exact fixed-demo models, principal, count, and fresh timestamp", async () => {
    const mutations = [
      (body: ReturnType<typeof finalizedProofBody>) => {
        body.embeddingModel = "amazon.titan-embed-text-v1";
      },
      (body: ReturnType<typeof finalizedProofBody>) => {
        body.narrationModel = "eu.anthropic.other-model";
      },
      (body: ReturnType<typeof finalizedProofBody>) => {
        body.database.runtimePrincipal = "archon_admin";
      },
      (body: ReturnType<typeof finalizedProofBody>) => {
        body.database.runtimePrincipal =
          "archon_production_A1B2C3D4E5";
      },
      (body: ReturnType<typeof finalizedProofBody>) => {
        body.database.activeMemories = 8;
        body.memory.persisted = 8;
        body.memory.idempotencyKeys = 8;
        body.memory.contentDigests = 8;
      },
      (body: ReturnType<typeof finalizedProofBody>) => {
        body.generatedAt = new Date(
          Date.now() - 5 * 60 * 1_000 - 1
        ).toISOString();
      },
      (body: ReturnType<typeof finalizedProofBody>) => {
        body.generatedAt = new Date(
          Date.now() + 3 * 60 * 1_000
        ).toISOString();
      },
    ];

    for (const mutate of mutations) {
      const body = finalizedProofBody();
      mutate(body);
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(jsonResponse(body)),
      );

      expect((await getProof()).hasEvidence).toBe(false);
    }
  });

  it("does not normalize an unrecognized store evidence marker as verified", async () => {
    const body = finalizedProofBody();
    body.memory.evidence = "static application claim";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(body)),
    );

    const proof = await getProof();

    expect(proof.memory.storeVerified).toBe(false);
    expect(proof.hasEvidence).toBe(false);
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

  it("opens a fixed isolated resolution session without caller-selected data", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        sessionToken: "A".repeat(43),
        tokenType: "Bearer",
        snapshot: resolutionBody(),
      }, 201),
    );
    vi.stubGlobal("fetch", fetchMock);

    const session = await createResolutionSession();

    expect(session.token).toBe("A".repeat(43));
    expect(session.snapshot.state).toBe("pending");
    expect(session.snapshot.policy.canonicalMemoryMutable).toBe(false);
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/resolution/session");
    expect(init.method).toBe("POST");
    expect(init.body).toBe("{}");
  });

  it("submits an exact idempotent human decision with the bearer capability", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ snapshot: resolutionBody("approved"), idempotent: true }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const token = "B".repeat(43);
    const idempotencyKey = "12345678-1234-4234-8234-123456789abc";

    const snapshot = await decideResolution(
      token,
      "approve",
      idempotencyKey,
    );

    expect(snapshot.state).toBe("approved");
    expect(snapshot.receipt?.digest).toHaveLength(64);
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/resolution/decision");
    expect(init.headers).toEqual(
      expect.objectContaining({ authorization: `Bearer ${token}` }),
    );
    expect(JSON.parse(String(init.body))).toEqual({
      decision: "approve",
      idempotencyKey,
    });
  });

  it("accepts only the exact rejected state graph and lifecycle", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({
            snapshot: resolutionBody("rejected"),
            idempotent: true,
          }),
        ),
    );

    const snapshot = await decideResolution(
      "R".repeat(43),
      "reject",
      "12345678-1234-4234-8234-123456789abc",
    );

    expect(snapshot.state).toBe("rejected");
    expect(
      snapshot.observations.map(({ label, status }) => [label, status]),
    ).toEqual([
      ["prior", "current"],
      ["corrected", "rejected"],
    ]);
    expect(snapshot.lifecycle).toEqual({
      learning: "human-rejected-correction",
      consolidation: "prior-observation-remains-current",
      forgetting: "session-scoped-ttl-after-decision",
      externalSideEffects: "none",
    });
  });

  it("fails closed on state graph, lifecycle, evidence, display, or rationale drift", async () => {
    const driftCases: Array<{
      mutate: (body: ReturnType<typeof resolutionBody>) => void;
    }> = [
      {
        mutate: (body) => {
          body.observations[1]!.status = "current";
        },
      },
      {
        mutate: (body) => {
          body.lifecycle.learning = "human-approved-correction";
        },
      },
      {
        mutate: (body) => {
          body.observations[0]!.observedAt =
            "2026-07-01T08:00:01.000Z";
        },
      },
      {
        mutate: (body) => {
          body.observations[1]!.employerCostDisplay = "€128,900";
        },
      },
      {
        mutate: (body) => {
          body.proposal.rationale = "Trust the corrected source.";
        },
      },
      {
        mutate: (body) => {
          body.observations.reverse();
        },
      },
    ];

    for (const drift of driftCases) {
      const forged = resolutionBody();
      drift.mutate(forged);
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          jsonResponse(
            {
              sessionToken: "D".repeat(43),
              tokenType: "Bearer",
              snapshot: forged,
            },
            201,
          ),
        ),
      );

      await expect(createResolutionSession()).rejects.toEqual(
        expect.objectContaining<Partial<PublicApiError>>({
          name: "PublicApiError",
          endpoint: "/api/resolution",
        }),
      );
    }
  });

  it("fails closed when the resolution graph or authority contract is forged", async () => {
    const forged = resolutionBody();
    forged.policy.canonicalMemoryMutable = true;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          sessionToken: "C".repeat(43),
          tokenType: "Bearer",
          snapshot: forged,
        }, 201),
      ),
    );

    await expect(createResolutionSession()).rejects.toEqual(
      expect.objectContaining<Partial<PublicApiError>>({
        message:
          "Resolution response violated the fixed evidence and authority contract.",
      }),
    );
  });
});
