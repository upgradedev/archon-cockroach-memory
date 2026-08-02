import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  isExpectedResolutionRoutineBody,
  isExpectedResolutionRoutineCreateStatement,
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
  ]) {
    assert.equal(
      isExpectedResolutionRoutineCreateStatement(drifted, routineName),
      false
    );
  }
});

test("resolution routine body proof tolerates only Cockroach canonicalization of built-ins", () => {
  const createBody = `BEGIN
    IF p_max_active_sessions > 500 THEN RETURN 'invalid'; END IF;
    SELECT count(*) FROM archon.public.memory_demo_sessions WHERE expires_at > pg_catalog . NOW ( );
    INSERT INTO archon.public.memory_resolution_observations DEFAULT VALUES;
    INSERT INTO archon.public.memory_resolution_proposals DEFAULT VALUES;
    RETURN 'created';
  END;`;
  const decideBody = `BEGIN
    SELECT id FROM archon.public.memory_demo_sessions WHERE expires_at > pg_catalog.now();
    UPDATE archon.public.memory_resolution_observations SET status = status;
    UPDATE archon.public.memory_resolution_proposals SET status = status;
    INSERT INTO archon.public.memory_resolution_decisions DEFAULT VALUES;
    INSERT INTO archon.public.memory_resolution_consolidations DEFAULT VALUES;
    v_receipt_canonical := '{"actorRole":"financial-controller"}';
    v_receipt_hash := pg_catalog . SHA256 (v_receipt_canonical:::STRING);
    IF false THEN RETURN 'replayed'; END IF;
    IF false THEN RETURN 'conflict'; END IF;
    RETURN 'applied';
  END;`;

  assert.equal(
    isExpectedResolutionRoutineBody(
      createBody,
      "archon_resolution_create_session"
    ),
    true
  );
  assert.equal(
    isExpectedResolutionRoutineBody(decideBody, "archon_resolution_decide"),
    true
  );
  assert.equal(
    isExpectedResolutionRoutineBody(
      decideBody.replace(
        "archon.public.memory_resolution_decisions",
        "memory_resolution_decisions"
      ),
      "archon_resolution_decide"
    ),
    false
  );
  assert.equal(
    isExpectedResolutionRoutineBody(
      decideBody.replace(
        "archon.public.memory_resolution_decisions DEFAULT VALUES",
        "archon.public.unrelated DEFAULT VALUES; -- memory_resolution_decisions\n"
      ),
      "archon_resolution_decide"
    ),
    false
  );
  assert.equal(
    isExpectedResolutionRoutineBody(
      decideBody.replace(
        "SHA256 (v_receipt_canonical:::STRING)",
        "SHA256 ('v_receipt_canonical')"
      ),
      "archon_resolution_decide"
    ),
    false
  );
  assert.equal(
    isExpectedResolutionRoutineBody(
      decideBody.replace(
        "RETURN 'applied';",
        "EXECUTE 'SELECT 1'; RETURN 'applied';"
      ),
      "archon_resolution_decide"
    ),
    false
  );
  assert.equal(
    isExpectedResolutionRoutineBody(
      `${decideBody}\n-- EXECUTE and memory_resolution_decisions in comments are inert`,
      "archon_resolution_decide"
    ),
    true
  );

  const source = readFileSync(
    new URL("../src/db/schema.sql", import.meta.url),
    "utf8"
  );
  assert.match(source, /pg_catalog\.sha256\(v_receipt_canonical\)/u);
  assert.match(source, /expires_at\s*>\s*pg_catalog\.now\(\)/u);
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
