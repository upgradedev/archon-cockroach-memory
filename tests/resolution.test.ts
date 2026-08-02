import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  isExpectedResolutionRoutineCreateStatement,
  resolutionRoutineRuntimeEvidence,
  resolutionRoutineSourceEvidence,
} from "../src/db/routine-proof.js";
import {
  RESOLUTION_ROUTINE_SIGNATURES,
  expectedRuntimeDatabaseGrants,
  validateClusterWideResolutionGrants,
  type ClusterGrantRow,
} from "../src/db/cluster-grant-proof.js";
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

test("cluster-wide grant proof requires exact routine identities and can close a database matrix", () => {
  const applicationDatabase = "archon";
  const principal = "archon_staging_abc123";
  const routineRows: ClusterGrantRow[] = RESOLUTION_ROUTINE_SIGNATURES.map(
    (signature) => ({
      database_name: applicationDatabase,
      schema_name: "public",
      object_name: signature,
      object_type: "routine",
      grantee: "archon_resolution_writer",
      privilege_type: "EXECUTE",
      is_grantable: false,
    })
  );
  const expectedDatabaseGrants = expectedRuntimeDatabaseGrants(
    applicationDatabase,
    principal
  );
  assert.deepEqual(expectedDatabaseGrants, [
    {
      databaseName: "defaultdb",
      grantee: "public",
      privilegeType: "CONNECT",
      isGrantable: false,
    },
    {
      databaseName: "defaultdb",
      grantee: "public",
      privilegeType: "TEMPORARY",
      isGrantable: false,
    },
    {
      databaseName: "postgres",
      grantee: "public",
      privilegeType: "CONNECT",
      isGrantable: false,
    },
    {
      databaseName: "postgres",
      grantee: "public",
      privilegeType: "TEMPORARY",
      isGrantable: false,
    },
    {
      databaseName: applicationDatabase,
      grantee: principal,
      privilegeType: "CONNECT",
      isGrantable: false,
    },
  ]);
  const databaseRows: ClusterGrantRow[] = expectedDatabaseGrants.map(
    (grant) => ({
      database_name: grant.databaseName,
      schema_name: null,
      object_name: null,
      object_type: "database",
      grantee: grant.grantee,
      privilege_type: grant.privilegeType,
      is_grantable: grant.isGrantable,
    })
  );
  const unexpectedDatabaseGrant: ClusterGrantRow = {
    ...databaseRows[0]!,
    database_name: "unrelated",
  };
  const databaseInventory = [
    applicationDatabase,
    "defaultdb",
    "postgres",
    "system",
  ];

  const exactProof = validateClusterWideResolutionGrants(
    [...routineRows, ...databaseRows],
    applicationDatabase,
    expectedDatabaseGrants,
    databaseInventory
  );
  assert.equal(exactProof.routineGrantCount, 2);
  assert.equal(exactProof.databaseGrantCount, 5);
  assert.deepEqual(exactProof.databaseInventory, databaseInventory);
  assert.deepEqual(exactProof.databaseGrantMatrix, [
    expectedDatabaseGrants[4],
    ...expectedDatabaseGrants.slice(0, 4),
  ]);
  assert.match(exactProof.databaseMatrixSha256, /^[a-f0-9]{64}$/u);
  assert.equal(
    validateClusterWideResolutionGrants(
      [...routineRows, ...databaseRows].reverse(),
      applicationDatabase,
      expectedDatabaseGrants,
      databaseInventory
    ).databaseMatrixSha256,
    exactProof.databaseMatrixSha256
  );
  const routineOnlyProof = validateClusterWideResolutionGrants(
    [...routineRows, ...databaseRows],
    applicationDatabase
  );
  assert.equal(routineOnlyProof.routineGrantCount, 2);
  assert.equal(routineOnlyProof.databaseGrantCount, 5);
  assert.deepEqual(routineOnlyProof.databaseInventory, []);
  assert.deepEqual(routineOnlyProof.databaseGrantMatrix, [
    expectedDatabaseGrants[4],
    ...expectedDatabaseGrants.slice(0, 4),
  ]);

  for (const driftedRows of [
    [
      { ...routineRows[0]!, database_name: "other_database" },
      routineRows[1]!,
    ],
    [
      {
        ...routineRows[0]!,
        object_name: "archon_resolution_create_session(text)",
      },
      routineRows[1]!,
    ],
    [
      { ...routineRows[0]!, grantee: "public" },
      routineRows[1]!,
    ],
    [
      { ...routineRows[0]!, is_grantable: true },
      routineRows[1]!,
    ],
    [...routineRows, { ...routineRows[0]!, database_name: "other_database" }],
  ]) {
    assert.throws(
      () =>
        validateClusterWideResolutionGrants(
          driftedRows,
          applicationDatabase
        ),
      /Cluster-wide routine privileges exceed/u
    );
  }
  for (const driftedDatabaseRows of [
    databaseRows.slice(1),
    databaseRows.map((row, index) =>
      index === 0 ? { ...row, privilege_type: "TEMPORARY" } : row
    ),
    databaseRows.map((row, index) =>
      index === 1 ? { ...row, is_grantable: true } : row
    ),
    databaseRows.map((row, index) =>
      index === databaseRows.length - 1
        ? { ...row, grantee: "archon_public_reader" }
        : row
    ),
    databaseRows.map((row, index) =>
      index === databaseRows.length - 1
        ? { ...row, privilege_type: "TEMPORARY" }
        : row
    ),
    [
      ...databaseRows,
      {
        ...databaseRows[databaseRows.length - 1]!,
        privilege_type: "TEMPORARY",
      },
    ],
    [...databaseRows, databaseRows[0]!],
  ]) {
    assert.throws(
      () =>
        validateClusterWideResolutionGrants(
          [...routineRows, ...driftedDatabaseRows],
          applicationDatabase,
          expectedDatabaseGrants,
          databaseInventory
        ),
      /Cluster-wide database privileges do not match/u
    );
  }
  assert.throws(
    () =>
      validateClusterWideResolutionGrants(
        [...routineRows, ...databaseRows, unexpectedDatabaseGrant],
        applicationDatabase,
        expectedDatabaseGrants,
        [...databaseInventory, "unrelated"]
      ),
    /exact database inventory/u
  );
  assert.throws(
    () =>
      validateClusterWideResolutionGrants(
        [
          ...routineRows,
          { ...databaseRows[0]!, schema_name: "public" },
        ],
        applicationDatabase
      ),
    /Cluster-wide database privilege rows are malformed/u
  );
  for (const driftedInventory of [
    databaseInventory.filter((name) => name !== "system"),
    [...databaseInventory, "system"],
    [...databaseInventory, ""],
    [...databaseInventory, "unrelated_without_grants"],
  ]) {
    assert.throws(
      () =>
        validateClusterWideResolutionGrants(
          [...routineRows, ...databaseRows],
          applicationDatabase,
          expectedDatabaseGrants,
          driftedInventory
        ),
      /exact database inventory/u
    );
  }
  assert.throws(
    () =>
      validateClusterWideResolutionGrants(
        [...routineRows, ...databaseRows],
        applicationDatabase,
        [...expectedDatabaseGrants, expectedDatabaseGrants[0]!],
        databaseInventory
      ),
    /Expected cluster-wide database privilege matrix is not canonical/u
  );
  assert.throws(
    () => expectedRuntimeDatabaseGrants("system", principal),
    /requires non-empty, distinct application and principal identities/u
  );
  assert.throws(
    () => expectedRuntimeDatabaseGrants(applicationDatabase, "public"),
    /requires non-empty, distinct application and principal identities/u
  );
});

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
    let body = sourceBody(routineName)
      .replace(
        /\bpublic\.(memory_demo_sessions|memory_resolution_(?:observations|proposals|decisions|consolidations))\b/gu,
        `${databaseName}.public.$1`
      )
      .replace(
        /\bpg_catalog\.(count|now|sha256|timezone|to_char)\b/gu,
        "$1"
      );
    const runtimeCastInsertions =
      routineName === "archon_resolution_create_session"
        ? ([
            [
              "(p_expires_at <= now():::TIMESTAMPTZ)",
              "(p_expires_at <= now():::TIMESTAMPTZ:::TIMESTAMPTZ)",
            ],
            [
              "WHERE expires_at > now():::TIMESTAMPTZ",
              "WHERE expires_at > now():::TIMESTAMPTZ:::TIMESTAMPTZ",
            ],
          ] as const)
        : ([
            [
              "AND (expires_at > now():::TIMESTAMPTZ)",
              "AND (expires_at > now():::TIMESTAMPTZ:::TIMESTAMPTZ)",
            ],
          ] as const);
    for (const [sourceCast, runtimeCast] of runtimeCastInsertions) {
      const canonicalized = body.replace(sourceCast, runtimeCast);
      assert.notEqual(canonicalized, body);
      body = canonicalized;
    }
    return body;
  }

  const canonicalTokenCounts = {
    archon_resolution_create_session: 328,
    archon_resolution_decide: 750,
  } as const;
  const canonicalDuplicateCastCounts = {
    archon_resolution_create_session: 2,
    archon_resolution_decide: 1,
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
      "cockroach-v26.2.3-fmt-parsable-exact-v2"
    );
    assert.equal(
      runtime.diagnostics.sourceNormalizedTokenCount,
      canonicalTokenCounts[routineName]
    );
    assert.equal(
      runtime.diagnostics.runtimeNormalizedTokenCount,
      canonicalTokenCounts[routineName]
    );
    assert.equal(
      runtime.diagnostics.expectedRuntimeDuplicateNowTimestamptzCastCount,
      canonicalDuplicateCastCounts[routineName]
    );
    assert.equal(
      runtime.diagnostics.observedRuntimeDuplicateNowTimestamptzCastCount,
      canonicalDuplicateCastCounts[routineName]
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
    canonicalCreate.replace(
      "now():::TIMESTAMPTZ:::TIMESTAMPTZ",
      "now()"
    ),
    canonicalCreate.replace(
      "now():::TIMESTAMPTZ + '01:01:00'",
      "now() + '01:01:00'"
    ),
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
  for (const runtimeCastDrift of [
    canonicalCreate.replace(
      "now():::TIMESTAMPTZ:::TIMESTAMPTZ",
      "now():::TIMESTAMPTZ:::TIMESTAMPTZ:::TIMESTAMPTZ"
    ),
    canonicalCreate.replace(
      "now():::TIMESTAMPTZ + '01:01:00'",
      "now():::TIMESTAMPTZ:::TIMESTAMPTZ + '01:01:00'"
    ),
    canonicalCreate.replace(
      "now():::TIMESTAMPTZ:::TIMESTAMPTZ",
      "pg_catalog.now():::TIMESTAMPTZ:::TIMESTAMPTZ"
    ),
    canonicalCreate.replace(
      "now():::TIMESTAMPTZ:::TIMESTAMPTZ",
      "now():::TIMESTAMPTZ:::STRING"
    ),
    canonicalCreate.replace(
      "now():::TIMESTAMPTZ:::TIMESTAMPTZ",
      "now():::TIMESTAMPTZ::TIMESTAMPTZ"
    ),
  ]) {
    assert.equal(
      resolutionRoutineRuntimeEvidence(
        runtimeCastDrift,
        source,
        "archon_resolution_create_session",
        databaseName
      ).missingRuleIds.includes("runtime.reviewed-source-token-binding"),
      true
    );
  }
  const qualifiedNowCast = canonicalCreate.replace(
    "now():::TIMESTAMPTZ:::TIMESTAMPTZ",
    "attacker.now():::TIMESTAMPTZ:::TIMESTAMPTZ"
  );
  const qualifiedNowEvidence = resolutionRoutineRuntimeEvidence(
    qualifiedNowCast,
    source,
    "archon_resolution_create_session",
    databaseName
  );
  assert.equal(
    qualifiedNowEvidence.missingRuleIds.includes("runtime.calls.closed-exact"),
    true
  );
  assert.equal(
    qualifiedNowEvidence.missingRuleIds.includes(
      "runtime.reviewed-source-token-binding"
    ),
    true
  );
  const sourceDuplicateNowCast = source.replace(
    "pg_catalog.now():::TIMESTAMPTZ",
    "pg_catalog.now():::TIMESTAMPTZ:::TIMESTAMPTZ"
  );
  assert.equal(
    resolutionRoutineRuntimeEvidence(
      canonicalCreate,
      sourceDuplicateNowCast,
      "archon_resolution_create_session",
      databaseName
    ).missingRuleIds.includes("runtime.reviewed-source-token-binding"),
    true
  );
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
  const runtimeSingleDirectCast = canonicalCreate.replace(
    "now():::TIMESTAMPTZ:::TIMESTAMPTZ",
    "now():::TIMESTAMPTZ"
  );
  const runtimeSingleDirectCastEvidence = resolutionRoutineRuntimeEvidence(
    runtimeSingleDirectCast,
    source,
    "archon_resolution_create_session",
    databaseName
  );
  assert.equal(runtimeSingleDirectCastEvidence.matches, false);
  assert.equal(
    runtimeSingleDirectCastEvidence.missingRuleIds.includes(
      "runtime.cockroach-v26.2.3-fmt-parsable-duplicate-casts-exact"
    ),
    true
  );
  const runtimeSingleDecideDirectCast = canonicalDecide.replace(
    "now():::TIMESTAMPTZ:::TIMESTAMPTZ",
    "now():::TIMESTAMPTZ"
  );
  assert.equal(
    resolutionRoutineRuntimeEvidence(
      runtimeSingleDecideDirectCast,
      source,
      "archon_resolution_decide",
      databaseName
    ).missingRuleIds.includes(
      "runtime.cockroach-v26.2.3-fmt-parsable-duplicate-casts-exact"
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
