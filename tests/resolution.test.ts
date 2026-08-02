import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  isExpectedResolutionRoutineCreateStatement,
  resolutionRoutineRuntimeEvidence,
  resolutionRoutineSourceEvidence,
} from "../src/db/routine-proof.js";
import { closePool, query } from "../src/db/client.js";
import {
  handleCreateResolutionSession,
  handleGetResolutionSession,
  handleResolutionDecision,
} from "../src/http/resolution-handler.js";
import { createHandler } from "../src/lambda.js";
import { CockroachResolutionStore } from "../src/memory/resolution-store.js";
import {
  buildResolutionReceipt,
  extractResolutionToken,
  issueResolutionToken,
  lifecycleFor,
  parseResolutionDecision,
  RESOLUTION_COMPANY,
  RESOLUTION_POLICY,
  RESOLUTION_SCENARIO_ID,
  ResolutionError,
  resolutionTokenHash,
  safeDigestEqual,
  type ResolutionDecisionRequest,
  type ResolutionSnapshot,
  type ResolutionStore,
} from "../src/memory/resolution.js";

function pendingSnapshot(sessionId = randomUUID()): ResolutionSnapshot {
  const priorId = randomUUID();
  const correctedId = randomUUID();
  return {
    sessionId,
    scenarioId: RESOLUTION_SCENARIO_ID,
    company: RESOLUTION_COMPANY,
    period: "2026-06",
    state: "pending",
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
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
        status: "current",
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
        status: "candidate",
      },
    ],
    proposal: {
      id: randomUUID(),
      action: "resolve-conflicting-memory",
      status: "pending",
      proposedObservationId: correctedId,
      supersedesObservationId: priorId,
      rationale:
        "Prefer newer signed evidence while preserving both source records.",
      requiresHumanRole: "financial-controller",
    },
    receipt: null,
    lifecycle: lifecycleFor("pending"),
    policy: RESOLUTION_POLICY,
  };
}

class RecordingResolutionStore implements ResolutionStore {
  readonly tokenHashes: string[] = [];
  readonly decisions: ResolutionDecisionRequest[] = [];
  snapshot = pendingSnapshot();

  async createSession(tokenHash: string): Promise<ResolutionSnapshot> {
    this.tokenHashes.push(tokenHash);
    return this.snapshot;
  }

  async getSession(tokenHash: string): Promise<ResolutionSnapshot> {
    this.tokenHashes.push(tokenHash);
    return this.snapshot;
  }

  async decide(
    tokenHash: string,
    request: ResolutionDecisionRequest
  ): Promise<ResolutionSnapshot> {
    this.tokenHashes.push(tokenHash);
    this.decisions.push(request);
    return this.snapshot;
  }
}

test("resolution routine catalog gate trusts only descriptor-backed definer metadata", () => {
  const routineName = "archon_resolution_create_session";
  const valid = `CREATE FUNCTION archon_memory.public.${routineName}(
      p_token_hash STRING
    )
    RETURNS STRING
    VOLATILE
    NOT LEAKPROOF
    CALLED ON NULL INPUT
    SECURITY DEFINER
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RETURN 'created';
    END;
    $$`;
  assert.equal(
    isExpectedResolutionRoutineCreateStatement(valid, routineName),
    true
  );
  assert.equal(
    isExpectedResolutionRoutineCreateStatement(
      valid.replace("archon_memory.", ""),
      routineName
    ),
    true
  );

  for (const drifted of [
    "",
    " AS $$ SECURITY DEFINER LANGUAGE plpgsql VOLATILE",
    valid.replace("SECURITY DEFINER", ""),
    valid.replace("SECURITY DEFINER", "SECURITY INVOKER"),
    valid.replace(
      "SECURITY DEFINER",
      "SECURITY DEFINER SECURITY DEFINER"
    ),
    valid.replace("LANGUAGE plpgsql", "LANGUAGE SQL"),
    valid.replace("VOLATILE", "STABLE"),
    valid.replace(routineName, "archon_resolution_decide"),
    valid
      .replace("SECURITY DEFINER", "SECURITY INVOKER")
      .replace(
        "RETURN 'created';",
        "RETURN 'body text SECURITY DEFINER must not spoof metadata';"
      ),
    valid
      .replace(
        "p_token_hash STRING",
        "p_token_hash STRING DEFAULT 'SECURITY DEFINER LANGUAGE plpgsql VOLATILE AS $$'"
      )
      .replace(
        "\n    SECURITY DEFINER\n    LANGUAGE plpgsql",
        "\n    SECURITY INVOKER\n    LANGUAGE plpgsql"
      )
      .replace("AS $$\n    BEGIN", "AS $body$\n    BEGIN")
      .replace("\n    $$", "\n    $body$"),
  ]) {
    assert.equal(
      isExpectedResolutionRoutineCreateStatement(drifted, routineName),
      false
    );
  }
});

test("resolution routine proof is source-bound and closed under Cockroach canonicalization", () => {
  const source = readFileSync(
    new URL("../src/db/schema.sql", import.meta.url),
    "utf8"
  );
  const databaseName = "archon_memory";
  const routineNames = [
    "archon_resolution_create_session",
    "archon_resolution_decide",
  ] as const;

  function sourceStatement(routineName: (typeof routineNames)[number]): string {
    const start = source.indexOf(
      `CREATE OR REPLACE FUNCTION public.${routineName}(`
    );
    const bodyStart = source.indexOf("AS $$", start);
    const end = source.indexOf("$$;", bodyStart);
    assert.ok(start >= 0 && bodyStart > start && end > bodyStart);
    return source.slice(start, end + 3);
  }

  function sourceBody(routineName: (typeof routineNames)[number]): string {
    const statement = sourceStatement(routineName);
    const start = statement.indexOf("AS $$") + "AS $$".length;
    return statement.slice(start, statement.lastIndexOf("$$;"));
  }

  function canonicalBody(
    routineName: (typeof routineNames)[number]
  ): string {
    return sourceBody(routineName)
      .replace(
        /\bpublic\.(memory_demo_sessions|memory_resolution_(?:observations|proposals|decisions|consolidations))\b/gu,
        `${databaseName}.public.$1`
      )
      .replace(
        /\bpg_catalog\.(count|now|sha256|timezone|to_char)\b/gu,
        "$1"
      );
  }

  const canonicalTokenCounts = {
    archon_resolution_create_session: 328,
    archon_resolution_decide: 750,
  } as const;

  for (const routineName of routineNames) {
    assert.deepEqual(
      resolutionRoutineSourceEvidence(source, routineName),
      { matches: true, missingRuleIds: [] }
    );
    const runtime = resolutionRoutineRuntimeEvidence(
      canonicalBody(routineName),
      source,
      routineName,
      databaseName
    );
    assert.equal(runtime.matches, true);
    assert.deepEqual(runtime.missingRuleIds, []);
    assert.equal(
      runtime.diagnostics.normalizationVersion,
      "cockroach-v26.2.3-fmt-parsable-exact-v1"
    );
    assert.equal(
      runtime.diagnostics.sourceNormalizedTokenCount,
      canonicalTokenCounts[routineName]
    );
    assert.equal(
      runtime.diagnostics.runtimeNormalizedTokenCount,
      canonicalTokenCounts[routineName]
    );
    assert.equal(runtime.diagnostics.firstMismatchIndex, null);
  }

  const fakeDefinition = sourceStatement("archon_resolution_decide");
  const spoofPrefix = `
    -- CREATE OR REPLACE FUNCTION public.archon_resolution_decide(
    /* outer /* nested */ ${fakeDefinition} */
    SELECT 'CREATE OR REPLACE FUNCTION public.archon_resolution_decide(';
    SELECT E'prefix \\' ; CREATE OR REPLACE FUNCTION public.archon_resolution_decide(';
    DO $outer$ ${fakeDefinition} $outer$;
  `;
  assert.equal(
    resolutionRoutineSourceEvidence(
      `${spoofPrefix}\n${source}`,
      "archon_resolution_decide"
    ).matches,
    true
  );
  assert.equal(
    resolutionRoutineSourceEvidence(
      `${source}\n${fakeDefinition}`,
      "archon_resolution_decide"
    ).missingRuleIds.includes("source.definition.exactly-one"),
    true
  );
  assert.equal(
    resolutionRoutineSourceEvidence(
      `/* ${fakeDefinition} */`,
      "archon_resolution_decide"
    ).matches,
    false
  );
  assert.equal(
    resolutionRoutineSourceEvidence(
      `${source}\n/* unterminated`,
      "archon_resolution_decide"
    ).missingRuleIds.includes("source.sql.top-level-parseable"),
    true
  );

  const unqualifiedSource = source.replace(
    "pg_catalog.sha256(v_receipt_canonical)",
    "sha256(v_receipt_canonical)"
  );
  assert.equal(
    resolutionRoutineSourceEvidence(
      unqualifiedSource,
      "archon_resolution_decide"
    ).missingRuleIds.includes("source.calls.closed-exact"),
    true
  );
  const unqualifiedAggregateSource = source.replace(
    "pg_catalog.count(*)",
    "count(*)"
  );
  assert.equal(
    resolutionRoutineSourceEvidence(
      unqualifiedAggregateSource,
      "archon_resolution_create_session"
    ).missingRuleIds.includes("source.calls.closed-exact"),
    true
  );
  const nonCanonicalSelectIntoSource = source.replace(
    /    SELECT pg_catalog\.count\(\*\)\r?\n      FROM public\.memory_demo_sessions\r?\n     WHERE expires_at > pg_catalog\.now\(\):::TIMESTAMPTZ\r?\n      INTO v_active_sessions;/u,
    "    SELECT pg_catalog.count(*)\n      INTO v_active_sessions\n      FROM public.memory_demo_sessions\n     WHERE expires_at > pg_catalog.now();"
  );
  assert.equal(
    resolutionRoutineSourceEvidence(
      nonCanonicalSelectIntoSource,
      "archon_resolution_create_session"
    ).missingRuleIds.includes(
      "source.cockroach-v26.2.3-fmt-parsable.canonical"
    ),
    true
  );
  const nonCanonicalIntervalSource = source.replace(
    "'01:01:00':::INTERVAL",
    "INTERVAL '61 minutes'"
  );
  assert.equal(
    resolutionRoutineSourceEvidence(
      nonCanonicalIntervalSource,
      "archon_resolution_create_session"
    ).missingRuleIds.includes(
      "source.cockroach-v26.2.3-fmt-parsable.canonical"
    ),
    true
  );
  const nonCanonicalComparisonSource = source.replace(
    "v_session_state != 'pending'",
    "v_session_state <> 'pending'"
  );
  assert.equal(
    resolutionRoutineSourceEvidence(
      nonCanonicalComparisonSource,
      "archon_resolution_decide"
    ).missingRuleIds.includes(
      "source.cockroach-v26.2.3-fmt-parsable.canonical"
    ),
    true
  );
  const extraSourceStatement = source.replace(
    /    RETURN 'created';\r?\nEND;/u,
    "    SELECT 1;\n    RETURN 'created';\nEND;"
  );
  assert.equal(
    resolutionRoutineSourceEvidence(
      extraSourceStatement,
      "archon_resolution_create_session"
    ).missingRuleIds.includes("source.statement-counts.closed-exact"),
    true
  );

  const canonicalCreate = canonicalBody(
    "archon_resolution_create_session"
  );
  const canonicalDecide = canonicalBody("archon_resolution_decide");
  for (const formatterDrift of [
    canonicalCreate.replace(
      "(p_session_id IS NULL)",
      "p_session_id IS NULL"
    ),
    canonicalCreate.replace("now():::TIMESTAMPTZ", "now()"),
    canonicalCreate.replace("'01:01:00':::INTERVAL", "'01:00:59':::INTERVAL"),
    canonicalCreate.replace("p_expires_at <=", "p_expires_at <"),
  ]) {
    assert.equal(
      resolutionRoutineRuntimeEvidence(
        formatterDrift,
        source,
        "archon_resolution_create_session",
        databaseName
      ).missingRuleIds.includes("runtime.reviewed-source-token-binding"),
      true
    );
  }
  const qualifiedGrammarCall = canonicalCreate.replace(
    "IF (",
    "attacker.if("
  );
  assert.equal(
    resolutionRoutineRuntimeEvidence(
      qualifiedGrammarCall,
      source,
      "archon_resolution_create_session",
      databaseName
    ).missingRuleIds.includes("runtime.calls.closed-exact"),
    true
  );
  const actorDrift = canonicalDecide.replace(
    '{"actorRole":"financial-controller","currentObservationId":"',
    '{"actorRole":"administrator","currentObservationId":"'
  );
  assert.equal(
    resolutionRoutineRuntimeEvidence(
      actorDrift,
      source,
      "archon_resolution_decide",
      databaseName
    ).missingRuleIds.includes(
      "runtime.receipt.actor-role-canonical-assignment"
    ),
    true
  );
  for (const invalidReceiptAssignment of [
    canonicalDecide.replace(
      "    v_receipt_hash :=",
      "    v_receipt_canonical := " +
        "'{\"actorRole\":\"financial-controller\",\"currentObservationId\":\"';\n" +
        "    v_receipt_hash :="
    ),
    canonicalDecide.replace(") || '}';", " || '}';"),
  ]) {
    assert.equal(
      resolutionRoutineRuntimeEvidence(
        invalidReceiptAssignment,
        source,
        "archon_resolution_decide",
        databaseName
      ).missingRuleIds.includes(
        "runtime.receipt.actor-role-canonical-assignment"
      ),
      true
    );
  }
  for (const castDrift of [
    canonicalDecide.replace("'approve':::STRING", "'approve'::STRING"),
    canonicalDecide.replace(
      "sha256(v_receipt_canonical)",
      "sha256(v_receipt_canonical:::STRING)"
    ),
  ]) {
    assert.equal(
      resolutionRoutineRuntimeEvidence(
        castDrift,
        source,
        "archon_resolution_decide",
        databaseName
      ).missingRuleIds.includes("runtime.reviewed-source-token-binding"),
      true
    );
  }
  const extraAssignment = canonicalCreate.replace(
    "    RETURN 'created';",
    "    v_active_sessions := v_active_sessions;\n    RETURN 'created';"
  );
  assert.equal(
    resolutionRoutineRuntimeEvidence(
      extraAssignment,
      source,
      "archon_resolution_create_session",
      databaseName
    ).missingRuleIds.includes("runtime.reviewed-source-token-binding"),
    true
  );
  const extraRelation = canonicalDecide.replace(
    "    RETURN 'applied';",
    "    UPDATE archon_memory.public.unrelated SET value = value;\n    RETURN 'applied';"
  );
  assert.equal(
    resolutionRoutineRuntimeEvidence(
      extraRelation,
      source,
      "archon_resolution_decide",
      databaseName
    ).missingRuleIds.includes("runtime.relations.closed-exact"),
    true
  );
  const wrongDatabase = canonicalDecide.replace(
    "archon_memory.public.memory_demo_sessions",
    "attacker.public.memory_demo_sessions"
  );
  assert.equal(
    resolutionRoutineRuntimeEvidence(
      wrongDatabase,
      source,
      "archon_resolution_decide",
      databaseName
    ).missingRuleIds.includes("runtime.relations.closed-exact"),
    true
  );
  const quotedSchemaSpoof = canonicalDecide.replace(
    "archon_memory.public.memory_demo_sessions",
    'archon_memory."PUBLIC".memory_demo_sessions'
  );
  assert.equal(
    resolutionRoutineRuntimeEvidence(
      quotedSchemaSpoof,
      source,
      "archon_resolution_decide",
      databaseName
    ).missingRuleIds.includes("runtime.identifiers.unquoted-only"),
    true
  );
  const quotedBuiltinSpoof = canonicalDecide.replace(
    "now()",
    '"PG_CATALOG"."NOW"()'
  );
  assert.equal(
    resolutionRoutineRuntimeEvidence(
      quotedBuiltinSpoof,
      source,
      "archon_resolution_decide",
      databaseName
    ).missingRuleIds.includes("runtime.identifiers.unquoted-only"),
    true
  );
  const unexpectedCall = canonicalDecide.replace(
    "    RETURN 'applied';",
    "    v_receipt_hash := pg_sleep();\n    RETURN 'applied';"
  );
  assert.equal(
    resolutionRoutineRuntimeEvidence(
      unexpectedCall,
      source,
      "archon_resolution_decide",
      databaseName
    ).missingRuleIds.includes("runtime.calls.closed-exact"),
    true
  );
  const wrongTimezoneOwner = canonicalDecide.replace(
    "timezone('UTC', p_decided_at)",
    "attacker.timezone('UTC', p_decided_at)"
  );
  assert.equal(
    resolutionRoutineRuntimeEvidence(
      wrongTimezoneOwner,
      source,
      "archon_resolution_decide",
      databaseName
    ).missingRuleIds.includes("runtime.calls.closed-exact"),
    true
  );
  const expressionHash = canonicalDecide.replace(
    "sha256(v_receipt_canonical)",
    "sha256(v_receipt_canonical || 'suffix')"
  );
  assert.equal(
    resolutionRoutineRuntimeEvidence(
      expressionHash,
      source,
      "archon_resolution_decide",
      databaseName
    ).missingRuleIds.includes(
      "runtime.receipt.sha256.exact-canonical-input"
    ),
    true
  );
  const inertMarkerSpoof = canonicalDecide.replace(
    "    RETURN 'applied';",
    "    v_existing_decision := 'RETURN ''applied''; pg_sleep();';\n    RETURN 'wrong';"
  );
  assert.equal(
    resolutionRoutineRuntimeEvidence(
      inertMarkerSpoof,
      source,
      "archon_resolution_decide",
      databaseName
    ).missingRuleIds.includes("runtime.returns.closed-exact"),
    true
  );
  assert.equal(
    resolutionRoutineRuntimeEvidence(
      `${canonicalDecide}\n-- RETURN 'wrong'; pg_sleep(); unrelated`,
      source,
      "archon_resolution_decide",
      databaseName
    ).matches,
    true
  );
});

test("resolution tokens are high-entropy bearer values and only hashes reach stores", async () => {
  const token = issueResolutionToken();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(extractResolutionToken(`Bearer ${token}`), token);
  assert.match(resolutionTokenHash(token), /^[a-f0-9]{64}$/u);
  assert.notEqual(resolutionTokenHash(token), token);
  assert.throws(
    () => extractResolutionToken(`bearer ${token}`),
    (error: unknown) =>
      error instanceof ResolutionError && error.status === 401
  );

  const store = new RecordingResolutionStore();
  const created = await handleCreateResolutionSession({}, store);
  assert.equal(created.status, 201);
  const issuedToken = created.body.sessionToken;
  assert.equal(typeof issuedToken, "string");
  assert.match(String(issuedToken), /^[A-Za-z0-9_-]{43}$/u);
  assert.deepEqual(store.tokenHashes, [
    resolutionTokenHash(String(issuedToken)),
  ]);
  assert.ok(!JSON.stringify(store.tokenHashes).includes(String(issuedToken)));
});

test("resolution decisions are closed-schema, human-gated commands", () => {
  const idempotencyKey = randomUUID();
  assert.deepEqual(
    parseResolutionDecision({
      decision: "approve",
      idempotencyKey: idempotencyKey.toUpperCase(),
    }),
    {
      decision: "approve",
      idempotencyKey,
    }
  );
  for (const invalid of [
    null,
    [],
    { decision: "approve" },
    { decision: "auto-approve", idempotencyKey },
    { decision: "reject", idempotencyKey: "not-a-uuid" },
    { decision: "reject", idempotencyKey, actorRole: "admin" },
  ]) {
    assert.throws(
      () => parseResolutionDecision(invalid),
      (error: unknown) =>
        error instanceof ResolutionError && error.status === 400
    );
  }
});

test("resolution receipts are deterministic, tamper-evident, and policy-bound", () => {
  const input = {
    decisionId: randomUUID(),
    sessionId: randomUUID(),
    proposalId: randomUUID(),
    decision: "approve" as const,
    idempotencyKey: randomUUID(),
    decidedAt: "2026-07-31T12:00:00.000Z",
    currentObservationId: randomUUID(),
    supersededObservationId: randomUUID(),
  };
  const receipt = buildResolutionReceipt(input);
  assert.match(receipt.digest, /^[a-f0-9]{64}$/u);
  assert.deepEqual(buildResolutionReceipt(input), receipt);
  assert.equal(safeDigestEqual(receipt.digest, receipt.digest), true);
  const tampered = `${receipt.digest.slice(0, -1)}${
    receipt.digest.endsWith("0") ? "1" : "0"
  }`;
  assert.equal(safeDigestEqual(receipt.digest, tampered), false);
  assert.equal(safeDigestEqual(receipt.digest, "not-a-digest"), false);
  assert.equal(receipt.actorRole, "financial-controller");
  assert.equal(receipt.policyVersion, "resolution-policy-v1");
});

test("resolution HTTP handlers preserve auth, validation, and store errors", async () => {
  const token = issueResolutionToken();
  const store = new RecordingResolutionStore();
  const idempotencyKey = randomUUID();

  assert.equal(
    (await handleCreateResolutionSession({ scenario: "mutable" }, store))
      .status,
    400
  );
  assert.equal(
    (await handleGetResolutionSession(undefined, store)).status,
    401
  );
  assert.equal(
    (
      await handleResolutionDecision(
        `Bearer ${token}`,
        { decision: "approve", idempotencyKey, unexpected: true },
        store
      )
    ).status,
    400
  );

  const result = await handleResolutionDecision(
    `Bearer ${token}`,
    { decision: "reject", idempotencyKey },
    store
  );
  assert.equal(result.status, 200);
  assert.deepEqual(store.decisions, [
    { decision: "reject", idempotencyKey },
  ]);
  assert.equal(store.tokenHashes.at(-1), resolutionTokenHash(token));

  const conflictStore: ResolutionStore = {
    createSession: store.createSession.bind(store),
    getSession: store.getSession.bind(store),
    decide: async () => {
      throw new ResolutionError(
        409,
        "This resolution proposal already has a final human decision."
      );
    },
  };
  const conflict = await handleResolutionDecision(
    `Bearer ${token}`,
    { decision: "approve", idempotencyKey },
    conflictStore
  );
  assert.deepEqual(conflict, {
    status: 409,
    body: {
      error:
        "This resolution proposal already has a final human decision.",
    },
  });
});

test("Lambda routes the isolated resolution loop without logging bearer tokens", async () => {
  const store = new RecordingResolutionStore();
  const handler = createHandler({ resolutionStore: store });
  const created = await handler({
    requestContext: { http: { method: "POST" } },
    rawPath: "/api/resolution/session",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(created.statusCode, 201);
  assert.equal(created.headers["cache-control"], "no-store");
  const createdBody = JSON.parse(created.body) as {
    sessionToken: string;
  };
  const token = createdBody.sessionToken;
  assert.match(token, /^[A-Za-z0-9_-]{43}$/u);

  const fetched = await handler({
    requestContext: { http: { method: "GET" } },
    rawPath: "/api/resolution/session",
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(fetched.statusCode, 200);
  assert.ok(!fetched.body.includes(token));

  const idempotencyKey = randomUUID();
  const decided = await handler({
    requestContext: { http: { method: "POST" } },
    rawPath: "/api/resolution/decision",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ decision: "approve", idempotencyKey }),
  });
  assert.equal(decided.statusCode, 200);
  assert.deepEqual(store.decisions.at(-1), {
    decision: "approve",
    idempotencyKey,
  });
  assert.ok(!decided.body.includes(token));
});

function isEphemeralCiDatabase(raw: string | undefined): boolean {
  if (process.env.CI !== "true" || !raw) return false;
  try {
    const url = new URL(raw);
    return (
      ["localhost", "127.0.0.1"].includes(url.hostname) &&
      url.pathname === "/archon_memory" &&
      url.searchParams.get("sslmode") === "disable"
    );
  } catch {
    return false;
  }
}

const hasRealDatabase = isEphemeralCiDatabase(process.env.DATABASE_URL);
const canForceExpiryAsOperator = (() => {
  try {
    return new URL(process.env.DATABASE_URL ?? "").username === "root";
  } catch {
    return false;
  }
})();

test(
  "real CockroachDB executes approve, reject, replay, and receipt lifecycle",
  { skip: !hasRealDatabase },
  async () => {
    const store = new CockroachResolutionStore();
    try {
      const canonicalBefore = await query<{
        id: string;
        content_hash: string | null;
        status: string;
      }>(
        `SELECT id, content_hash, status
           FROM agent_memory
          ORDER BY id`
      );
      const approvedSession = await handleCreateResolutionSession({}, store);
      assert.equal(approvedSession.status, 201);
      const approvedToken = String(approvedSession.body.sessionToken);
      const pending = approvedSession.body.snapshot as ResolutionSnapshot;
      assert.equal(pending.state, "pending");
      assert.equal(pending.receipt, null);
      assert.deepEqual(
        pending.observations.map((observation) => [
          observation.label,
          observation.status,
        ]),
        [
          ["prior", "current"],
          ["corrected", "candidate"],
        ]
      );

      const approvalKey = randomUUID();
      const approved = await handleResolutionDecision(
        `Bearer ${approvedToken}`,
        { decision: "approve", idempotencyKey: approvalKey },
        store
      );
      assert.equal(approved.status, 200);
      const approvedSnapshot = approved.body
        .snapshot as ResolutionSnapshot;
      assert.equal(approvedSnapshot.state, "approved");
      assert.equal(
        approvedSnapshot.lifecycle.consolidation,
        "approved-observation-is-current"
      );
      assert.deepEqual(
        approvedSnapshot.observations.map((observation) => [
          observation.label,
          observation.status,
        ]),
        [
          ["prior", "superseded"],
          ["corrected", "current"],
        ]
      );
      assert.match(
        approvedSnapshot.receipt?.digest ?? "",
        /^[a-f0-9]{64}$/u
      );

      const replay = await handleResolutionDecision(
        `Bearer ${approvedToken}`,
        { decision: "approve", idempotencyKey: approvalKey },
        store
      );
      assert.equal(replay.status, 200);
      assert.deepEqual(
        (replay.body.snapshot as ResolutionSnapshot).receipt,
        approvedSnapshot.receipt
      );
      assert.equal(
        (
          await handleResolutionDecision(
            `Bearer ${approvedToken}`,
            { decision: "reject", idempotencyKey: randomUUID() },
            store
          )
        ).status,
        409
      );

      const rejectedSession = await handleCreateResolutionSession({}, store);
      const rejectedToken = String(rejectedSession.body.sessionToken);
      const rejected = await handleResolutionDecision(
        `Bearer ${rejectedToken}`,
        { decision: "reject", idempotencyKey: randomUUID() },
        store
      );
      assert.equal(rejected.status, 200);
      const rejectedSnapshot = rejected.body
        .snapshot as ResolutionSnapshot;
      assert.equal(rejectedSnapshot.state, "rejected");
      assert.equal(
        rejectedSnapshot.lifecycle.consolidation,
        "prior-observation-remains-current"
      );
      assert.deepEqual(
        rejectedSnapshot.observations.map((observation) => [
          observation.label,
          observation.status,
        ]),
        [
          ["prior", "current"],
          ["corrected", "rejected"],
        ]
      );
      assert.match(
        rejectedSnapshot.receipt?.digest ?? "",
        /^[a-f0-9]{64}$/u
      );

      if (canForceExpiryAsOperator) {
        const expiredSession = await handleCreateResolutionSession({}, store);
        const expiredToken = String(expiredSession.body.sessionToken);
        await query(
          `UPDATE memory_demo_sessions
              SET expires_at = now() - INTERVAL '1 second'
            WHERE token_hash = $1`,
          [resolutionTokenHash(expiredToken)]
        );
        const expired = await handleGetResolutionSession(
          `Bearer ${expiredToken}`,
          store
        );
        assert.equal(expired.status, 410);
        assert.match(String(expired.body.error), /expired/iu);
      }

      const canonicalAfter = await query<{
        id: string;
        content_hash: string | null;
        status: string;
      }>(
        `SELECT id, content_hash, status
           FROM agent_memory
          ORDER BY id`
      );
      assert.deepEqual(canonicalAfter, canonicalBefore);
    } finally {
      await closePool();
    }
  }
);
