import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EXPECTED_MANAGED_MCP_AGGREGATE,
  FIXED_MANAGED_MCP_SCOPE,
  MANAGED_MCP_AGGREGATE_QUERY,
  MANAGED_MCP_CALLED_TOOLS,
  MANAGED_MCP_QUERY_BOUND,
  MANAGED_MCP_REQUEST_TIMEOUT_MS,
  MANAGED_MCP_RECEIPT_SCHEMA_VERSION,
  buildManagedMcpReceiptV2,
  compatibleArgs,
  parseManagedMcpAggregateResult,
} from "../scripts/cloud-mcp-audit.js";

const exactRow = Object.freeze({
  persisted: 9,
  idempotency_keys: 9,
  content_digests: 9,
});

function structured(row: unknown = exactRow): unknown {
  return { structuredContent: { rows: [row] } };
}

function textResult(payload: unknown = { rows: [exactRow] }): unknown {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

function validReceiptInput() {
  return {
    checkedAt: "2026-07-25T12:34:56.789Z",
    database: "archon",
    toolsAdvertised: 12,
    calledTools: [...MANAGED_MCP_CALLED_TOOLS],
    proofResults: MANAGED_MCP_CALLED_TOOLS.map((name) => ({
      name,
      ok: true,
    })),
    aggregate: { ...EXPECTED_MANAGED_MCP_AGGREGATE },
  };
}

test("managed MCP aggregate SQL is immutable, fixed-scope, index-forced, and bounded", () => {
  assert.match(
    MANAGED_MCP_AGGREGATE_QUERY,
    /FROM agent_memory@\{FORCE_INDEX=idx_agent_memory_active_scope\}/u
  );
  assert.match(
    MANAGED_MCP_AGGREGATE_QUERY,
    /tenant_id = 'public-demo'/u
  );
  assert.match(MANAGED_MCP_AGGREGATE_QUERY, /company = 'Helios SA'/u);
  assert.match(MANAGED_MCP_AGGREGATE_QUERY, /status = 'active'/u);
  assert.match(
    MANAGED_MCP_AGGREGATE_QUERY,
    /embed_model = 'amazon\.titan-embed-text-v2:0'/u
  );
  assert.equal(
    MANAGED_MCP_AGGREGATE_QUERY.match(/\bLIMIT 10\b/gu)?.length,
    1
  );
  assert.equal(
    MANAGED_MCP_AGGREGATE_QUERY.match(/\bLIMIT 1\b/gu)?.length,
    1
  );
  assert.equal(
    MANAGED_MCP_AGGREGATE_QUERY.match(/::INT4\b/gu)?.length,
    3
  );
  assert.doesNotMatch(
    MANAGED_MCP_AGGREGATE_QUERY,
    /\b(?:INSERT|UPSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/iu
  );
  assert.doesNotMatch(
    MANAGED_MCP_AGGREGATE_QUERY,
    /\b(?:content|embedding|metadata|source_ref)\b/iu
  );
});

test("managed MCP parser accepts only exact 9/9/9 structured or JSON-text rows", () => {
  assert.deepEqual(
    parseManagedMcpAggregateResult(structured()),
    EXPECTED_MANAGED_MCP_AGGREGATE
  );
  assert.deepEqual(
    parseManagedMcpAggregateResult(textResult()),
    EXPECTED_MANAGED_MCP_AGGREGATE
  );
});

test("managed MCP audit bounds every protocol request", () => {
  assert.equal(MANAGED_MCP_REQUEST_TIMEOUT_MS, 45_000);
});

test("managed MCP tool arguments require explicit supported scope aliases", () => {
  const schema = {
    type: "object",
    properties: {
      database_name: { type: "string" },
      table_name: { type: "string" },
    },
  };
  assert.deepEqual(
    compatibleArgs(
      schema,
      {
        database: "archon",
        database_name: "archon",
        table: "agent_memory",
        table_name: "agent_memory",
      },
      [
        ["database", "database_name"],
        ["table", "table_name"],
      ]
    ),
    {
      database_name: "archon",
      table_name: "agent_memory",
    }
  );

  for (const invalidSchema of [
    undefined,
    {},
    { type: "object" },
    { type: "object", properties: {} },
  ]) {
    assert.throws(
      () =>
        compatibleArgs(
          invalidSchema,
          { database: "archon", database_name: "archon" },
          [["database", "database_name"]]
        ),
      /must declare supported properties/u
    );
  }

  assert.throws(
    () =>
      compatibleArgs(
        { type: "object", properties: { unrelated: { type: "string" } } },
        { database: "archon", database_name: "archon" },
        [["database", "database_name"]]
      ),
    /required aliases: database, database_name/u
  );
  assert.deepEqual(compatibleArgs({}, {}), {});
});

test("managed MCP structured aggregate takes precedence over conflicting text", () => {
  assert.deepEqual(
    parseManagedMcpAggregateResult({
      structuredContent: { rows: [exactRow] },
      content: [
        {
          type: "text",
          text: JSON.stringify({
            rows: [{ ...exactRow, persisted: 10 }],
          }),
        },
      ],
    }),
    EXPECTED_MANAGED_MCP_AGGREGATE
  );
});

test("managed MCP parser rejects malformed and ambiguous envelopes", () => {
  const validText = textResult();
  const invalid: unknown[] = [
    null,
    [],
    {},
    { content: [] },
    { content: [{ type: "text", text: "" }] },
    {
      content: [
        { type: "text", text: JSON.stringify({ rows: [exactRow] }) },
        { type: "text", text: JSON.stringify({ rows: [exactRow] }) },
      ],
    },
    { content: [{ type: "image", text: JSON.stringify({ rows: [exactRow] }) }] },
    { content: [{ type: "text", text: "not-json" }] },
    { content: [{ type: "text", text: "[]" }] },
    { structuredContent: null },
    { structuredContent: [] },
    { structuredContent: { rows: [exactRow], metadata: {} } },
    { structuredContent: { row: [exactRow] } },
    { structuredContent: { rows: "not-an-array" } },
    { structuredContent: { rows: [] } },
    { structuredContent: { rows: [exactRow, exactRow] } },
    { structuredContent: { rows: [null] } },
    {
      structuredContent: { rows: [] },
      ...(validText as Record<string, unknown>),
    },
  ];

  for (const candidate of invalid) {
    assert.throws(
      () => parseManagedMcpAggregateResult(candidate),
      /Managed MCP aggregate/u
    );
  }
});

test("managed MCP parser rejects missing or additional aggregate keys", () => {
  for (const row of [
    { persisted: 9, idempotency_keys: 9 },
    { persisted: 9, content_digests: 9 },
    { idempotency_keys: 9, content_digests: 9 },
    { ...exactRow, company: "Helios SA" },
  ]) {
    assert.throws(
      () => parseManagedMcpAggregateResult(structured(row)),
      /exactly the documented keys/u
    );
  }
});

test("managed MCP parser rejects non-safe count types and values", () => {
  const invalidValues: unknown[] = [
    "9",
    null,
    true,
    9.5,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ];
  for (const key of [
    "persisted",
    "idempotency_keys",
    "content_digests",
  ] as const) {
    for (const value of invalidValues) {
      assert.throws(
        () =>
          parseManagedMcpAggregateResult(
            structured({ ...exactRow, [key]: value })
          ),
        /non-negative safe integer/u
      );
    }
  }
});

test("managed MCP parser treats missing, extra, or tenth rows as proof failure", () => {
  for (const row of [
    { ...exactRow, persisted: 8 },
    { ...exactRow, persisted: 10 },
    { ...exactRow, idempotency_keys: 8 },
    { ...exactRow, content_digests: 8 },
  ]) {
    assert.throws(
      () => parseManagedMcpAggregateResult(structured(row)),
      /exactly 9\/9\/9/u
    );
  }
});

test("managed MCP receipt v2 has exact public scope, bounds, aggregate, and proofs", () => {
  const receipt = buildManagedMcpReceiptV2(validReceiptInput());
  assert.deepEqual(Object.keys(receipt).sort(), [
    "aggregate",
    "bound",
    "calledTools",
    "checkedAt",
    "database",
    "endpoint",
    "mode",
    "ok",
    "proofs",
    "redactions",
    "schemaVersion",
    "scope",
    "toolsAdvertised",
  ]);
  assert.equal(receipt.schemaVersion, MANAGED_MCP_RECEIPT_SCHEMA_VERSION);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.mode, "read-only");
  assert.deepEqual(receipt.scope, FIXED_MANAGED_MCP_SCOPE);
  assert.deepEqual(receipt.bound, MANAGED_MCP_QUERY_BOUND);
  assert.deepEqual(receipt.aggregate, EXPECTED_MANAGED_MCP_AGGREGATE);
  assert.deepEqual(receipt.calledTools, MANAGED_MCP_CALLED_TOOLS);
  assert.equal(receipt.proofs.length, 4);
  assert.deepEqual(
    receipt.proofs.map(({ name, ok }) => ({ name, ok })),
    MANAGED_MCP_CALLED_TOOLS.map((name) => ({ name, ok: true }))
  );
  for (const proof of receipt.proofs) {
    assert.deepEqual(Object.keys(proof).sort(), ["detail", "name", "ok"]);
    assert.equal(typeof proof.detail, "string");
    assert.ok(proof.detail.length > 0);
  }

  const serialized = JSON.stringify(receipt);
  for (const sensitive of [
    "cc-api-secret-value",
    "cluster-uuid-secret-value",
    "postgresql://",
    "Maria Papadopoulou",
    "[0.123",
  ]) {
    assert.doesNotMatch(serialized, new RegExp(sensitive.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
  assert.equal(Object.hasOwn(receipt, "clusterId"), false);
  assert.equal(Object.hasOwn(receipt, "apiKey"), false);
  assert.equal(Object.hasOwn(receipt, "query"), false);
});

test("managed MCP receipt builder fails closed on non-exact metadata and sequences", () => {
  const base = validReceiptInput();
  const invalid = [
    { ...base, checkedAt: "2026-07-25" },
    { ...base, checkedAt: "2026-99-99T12:34:56.789Z" },
    { ...base, database: "postgresql://user:password@host/archon" },
    { ...base, toolsAdvertised: 3 },
    { ...base, toolsAdvertised: Number.MAX_SAFE_INTEGER + 1 },
    { ...base, calledTools: base.calledTools.slice(0, 3) },
    {
      ...base,
      calledTools: [
        "get_cluster",
        "get_table_schema",
        "list_tables",
        "select_query",
      ],
    },
    { ...base, proofResults: base.proofResults.slice(0, 3) },
    {
      ...base,
      proofResults: [
        ...base.proofResults.slice(0, 3),
        { name: "insert_rows", ok: true },
      ],
    },
    { ...base, aggregate: { ...base.aggregate, persisted: 10 } },
    {
      ...base,
      aggregate: { ...base.aggregate, persisted: "9" },
    },
    {
      ...base,
      aggregate: { ...base.aggregate, rawResponse: "must-not-be-copied" },
    },
  ];

  for (const candidate of invalid) {
    assert.throws(() =>
      buildManagedMcpReceiptV2(
        candidate as Parameters<typeof buildManagedMcpReceiptV2>[0]
      )
    );
  }
});

test("managed MCP receipt remains failed when any exact proof is false", () => {
  const input = validReceiptInput();
  input.proofResults[2] = {
    name: "get_table_schema",
    ok: false,
  };
  const receipt = buildManagedMcpReceiptV2(input);
  assert.equal(receipt.ok, false);
  assert.equal(receipt.proofs[2]?.ok, false);
});
