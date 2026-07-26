// Read-only production proof through CockroachDB Cloud's hosted Managed MCP Server.
//
// This is intentionally an audit client, not another memory implementation. It
// inspects the live cluster through four allowlisted read-only tools and emits a
// sanitized v2 receipt. The SQL proof is fixed in source, index-forced, and
// bounded before aggregation; no row content, embedding, credential, or cluster
// identifier is copied into the receipt.
//
// Required:
//   CCLOUD_API_KEY=<CockroachDB Cloud service-account API key>
// Optional:
//   COCKROACH_CLUSTER_ID=<cluster UUID>       (auto-discovered by name otherwise)
//   COCKROACH_CLUSTER_NAME=archon-cockroachdb-cluster
//   COCKROACH_DATABASE=archon

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const CLOUD_API = "https://cockroachlabs.cloud/api/v1/clusters";
const MANAGED_MCP_URL = "https://cockroachlabs.cloud/mcp";

export const MANAGED_MCP_RECEIPT_SCHEMA_VERSION = 2 as const;
export const FIXED_MANAGED_MCP_SCOPE = Object.freeze({
  tenantId: "public-demo",
  company: "Helios SA",
  status: "active",
  embedModel: "amazon.titan-embed-text-v2:0",
});
export const MANAGED_MCP_QUERY_BOUND = Object.freeze({
  index: "idx_agent_memory_active_scope",
  innerLimit: 10,
  outerLimit: 1,
});
export const EXPECTED_MANAGED_MCP_AGGREGATE = Object.freeze({
  persisted: 9,
  idempotencyKeys: 9,
  contentDigests: 9,
});
export const MANAGED_MCP_CALLED_TOOLS = [
  "get_cluster",
  "list_tables",
  "get_table_schema",
  "select_query",
] as const;
export const MANAGED_MCP_REDACTIONS = [
  "API key",
  "cluster identifier",
  "SQL credentials",
  "memory content",
  "embeddings",
] as const;

// The ten-row inner sentinel makes a tenth matching row observable as
// persisted=10, while still bounding the rows read. The outer LIMIT guarantees
// that Managed MCP can return at most one aggregate row.
export const MANAGED_MCP_AGGREGATE_QUERY = `
SELECT
  count(*)::INT4 AS persisted,
  (
    count(DISTINCT idempotency_key) FILTER (
      WHERE length(idempotency_key) BETWEEN 1 AND 256
    )
  )::INT4 AS idempotency_keys,
  (
    count(DISTINCT content_hash) FILTER (
      WHERE content_hash ~ '^[a-f0-9]{64}$'
    )
  )::INT4 AS content_digests
FROM (
  SELECT idempotency_key, content_hash
  FROM agent_memory@{FORCE_INDEX=idx_agent_memory_active_scope}
  WHERE tenant_id = 'public-demo'
    AND embed_model = 'amazon.titan-embed-text-v2:0'
    AND status = 'active'
    AND company = 'Helios SA'
  ORDER BY created_at DESC
  LIMIT 10
) AS bounded_active_scope
LIMIT 1
`.trim();

type JsonObject = Record<string, unknown>;
export type ManagedMcpToolName = (typeof MANAGED_MCP_CALLED_TOOLS)[number];

interface ClusterSummary {
  id: string;
  name: string;
}

export interface ManagedMcpAggregate {
  persisted: number;
  idempotencyKeys: number;
  contentDigests: number;
}

export interface ManagedMcpToolProof {
  name: ManagedMcpToolName;
  ok: boolean;
  detail: string;
}

export interface ManagedMcpReceiptV2 {
  schemaVersion: typeof MANAGED_MCP_RECEIPT_SCHEMA_VERSION;
  ok: boolean;
  checkedAt: string;
  endpoint: typeof MANAGED_MCP_URL;
  database: string;
  mode: "read-only";
  scope: typeof FIXED_MANAGED_MCP_SCOPE;
  bound: typeof MANAGED_MCP_QUERY_BOUND;
  aggregate: ManagedMcpAggregate;
  calledTools: ManagedMcpToolName[];
  toolsAdvertised: number;
  proofs: ManagedMcpToolProof[];
  redactions: string[];
}

interface ProofResult {
  name: ManagedMcpToolName;
  ok: boolean;
}

const PROOF_DETAILS: Readonly<Record<ManagedMcpToolName, string>> =
  Object.freeze({
    get_cluster:
      "Live cluster metadata returned through CockroachDB Cloud Managed MCP.",
    list_tables:
      "`agent_memory` is present in the configured application database.",
    get_table_schema:
      "Live schema exposes VECTOR(1024) and a native vector index.",
    select_query:
      "The fixed-scope, index-forced, ten-row-sentinel aggregate is exactly 9/9/9.",
  });

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function hasOwn(value: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function assertExactKeys(
  value: JsonObject,
  expected: readonly string[],
  label: string
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error(`${label} must contain exactly the documented keys.`);
  }
}

function safeCount(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function assertExpectedAggregate(aggregate: ManagedMcpAggregate): void {
  const row = object(aggregate);
  if (!row) {
    throw new Error("Managed MCP receipt aggregate must be an object.");
  }
  assertExactKeys(
    row,
    ["persisted", "idempotencyKeys", "contentDigests"],
    "Managed MCP receipt aggregate"
  );
  const persisted = safeCount(row.persisted, "persisted");
  const idempotencyKeys = safeCount(
    row.idempotencyKeys,
    "idempotencyKeys"
  );
  const contentDigests = safeCount(row.contentDigests, "contentDigests");
  if (
    persisted !== EXPECTED_MANAGED_MCP_AGGREGATE.persisted ||
    idempotencyKeys !==
      EXPECTED_MANAGED_MCP_AGGREGATE.idempotencyKeys ||
    contentDigests !==
      EXPECTED_MANAGED_MCP_AGGREGATE.contentDigests
  ) {
    throw new Error("Managed MCP fixed-scope aggregate must be exactly 9/9/9.");
  }
}

function parseTextPayload(root: JsonObject): unknown {
  const content = root.content;
  if (!Array.isArray(content) || content.length !== 1) {
    throw new Error(
      "Managed MCP aggregate text must contain exactly one content block."
    );
  }
  const block = object(content[0]);
  if (block?.type !== "text" || typeof block.text !== "string") {
    throw new Error("Managed MCP aggregate content must be one JSON text block.");
  }
  try {
    return JSON.parse(block.text) as unknown;
  } catch {
    throw new Error("Managed MCP aggregate text must be valid JSON.");
  }
}

/**
 * Parse the only two accepted Managed MCP aggregate result shapes:
 * structuredContent={rows:[one exact row]}, or one text block containing that
 * exact JSON object. Structured content takes precedence and never falls back to
 * text, so an ambiguous or malformed response fails closed.
 */
export function parseManagedMcpAggregateResult(
  result: unknown
): ManagedMcpAggregate {
  const root = object(result);
  if (!root) {
    throw new Error("Managed MCP aggregate result must be an object.");
  }

  const payload = hasOwn(root, "structuredContent")
    ? root.structuredContent
    : parseTextPayload(root);
  const envelope = object(payload);
  if (!envelope) {
    throw new Error("Managed MCP aggregate payload must be an object.");
  }
  assertExactKeys(envelope, ["rows"], "Managed MCP aggregate payload");
  if (!Array.isArray(envelope.rows) || envelope.rows.length !== 1) {
    throw new Error("Managed MCP aggregate payload must contain exactly one row.");
  }

  const row = object(envelope.rows[0]);
  if (!row) {
    throw new Error("Managed MCP aggregate row must be an object.");
  }
  assertExactKeys(
    row,
    ["persisted", "idempotency_keys", "content_digests"],
    "Managed MCP aggregate row"
  );

  const aggregate = {
    persisted: safeCount(row.persisted, "persisted"),
    idempotencyKeys: safeCount(
      row.idempotency_keys,
      "idempotency_keys"
    ),
    contentDigests: safeCount(row.content_digests, "content_digests"),
  };
  assertExpectedAggregate(aggregate);
  return aggregate;
}

function assertExactToolSequence(
  actual: readonly string[],
  label: string
): void {
  if (
    actual.length !== MANAGED_MCP_CALLED_TOOLS.length ||
    actual.some((name, index) => name !== MANAGED_MCP_CALLED_TOOLS[index])
  ) {
    throw new Error(`${label} must be the exact four-tool read-only sequence.`);
  }
}

function safeDatabaseName(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(value)) {
    throw new Error("COCKROACH_DATABASE must be a simple lowercase identifier.");
  }
  return value;
}

function validIsoTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    return false;
  }
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

/**
 * Build the sanitized receipt from typed proof outcomes. Human-readable proof
 * text is fixed in source rather than copied from MCP responses.
 */
export function buildManagedMcpReceiptV2(input: {
  checkedAt: string;
  database: string;
  toolsAdvertised: number;
  calledTools: readonly string[];
  proofResults: readonly ProofResult[];
  aggregate: ManagedMcpAggregate;
}): ManagedMcpReceiptV2 {
  if (!validIsoTimestamp(input.checkedAt)) {
    throw new Error("checkedAt must be a canonical UTC ISO timestamp.");
  }
  const database = safeDatabaseName(input.database);
  if (
    !Number.isSafeInteger(input.toolsAdvertised) ||
    input.toolsAdvertised < MANAGED_MCP_CALLED_TOOLS.length
  ) {
    throw new Error("toolsAdvertised must be a safe integer covering all tools.");
  }
  assertExactToolSequence(input.calledTools, "calledTools");
  assertExactToolSequence(
    input.proofResults.map((proof) => proof.name),
    "proofResults"
  );
  if (input.proofResults.some((proof) => typeof proof.ok !== "boolean")) {
    throw new Error("Every Managed MCP proof result must be boolean.");
  }
  assertExpectedAggregate(input.aggregate);

  const proofs = input.proofResults.map((proof) => ({
    name: proof.name,
    ok: proof.ok,
    detail: PROOF_DETAILS[proof.name],
  }));

  return {
    schemaVersion: MANAGED_MCP_RECEIPT_SCHEMA_VERSION,
    ok: proofs.every((proof) => proof.ok),
    checkedAt: input.checkedAt,
    endpoint: MANAGED_MCP_URL,
    database,
    mode: "read-only",
    scope: FIXED_MANAGED_MCP_SCOPE,
    bound: MANAGED_MCP_QUERY_BOUND,
    aggregate: { ...input.aggregate },
    calledTools: [...MANAGED_MCP_CALLED_TOOLS],
    toolsAdvertised: input.toolsAdvertised,
    proofs,
    redactions: [...MANAGED_MCP_REDACTIONS],
  };
}

function parseClusters(payload: unknown): ClusterSummary[] {
  const root = object(payload);
  const candidates = Array.isArray(root?.clusters)
    ? root.clusters
    : Array.isArray(payload)
      ? payload
      : [];

  return candidates.flatMap((candidate) => {
    const row = object(candidate);
    const id = stringValue(row?.id);
    const name = stringValue(row?.name);
    return id && name ? [{ id, name }] : [];
  });
}

async function resolveClusterId(apiKey: string): Promise<string> {
  const explicit = stringValue(process.env.COCKROACH_CLUSTER_ID);
  if (explicit) return explicit;

  const clusterName =
    stringValue(process.env.COCKROACH_CLUSTER_NAME) ??
    "archon-cockroachdb-cluster";
  const response = await fetch(CLOUD_API, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(
      `Cockroach Cloud cluster discovery failed (HTTP ${response.status})`
    );
  }

  const clusters = parseClusters(await response.json());
  const exact = clusters.find((cluster) => cluster.name === clusterName);
  if (exact) return exact.id;
  if (clusters.length === 1) return clusters[0].id;

  throw new Error(
    "The configured cluster was not found; set COCKROACH_CLUSTER_ID explicitly."
  );
}

function toolText(result: unknown): string {
  const root = object(result);
  const structured = root?.structuredContent;
  if (structured !== undefined) return JSON.stringify(structured);

  const content = Array.isArray(root?.content) ? root.content : [];
  return content
    .map((item) => {
      const block = object(item);
      return stringValue(block?.text) ?? "";
    })
    .filter(Boolean)
    .join("\n");
}

function hasAny(haystack: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(haystack));
}

function availablePropertyNames(inputSchema: unknown): Set<string> {
  const schema = object(inputSchema);
  const properties = object(schema?.properties);
  return new Set(properties ? Object.keys(properties) : []);
}

function compatibleArgs(
  inputSchema: unknown,
  candidates: Record<string, unknown>
): Record<string, unknown> {
  const available = availablePropertyNames(inputSchema);
  return Object.fromEntries(
    Object.entries(candidates).filter(
      ([key]) => available.size === 0 || available.has(key)
    )
  );
}

async function main(): Promise<void> {
  const apiKey = stringValue(process.env.CCLOUD_API_KEY);
  if (!apiKey) throw new Error("CCLOUD_API_KEY is required.");

  const clusterId = await resolveClusterId(apiKey);
  const database = safeDatabaseName(
    stringValue(process.env.COCKROACH_DATABASE) ??
      stringValue(process.env.PGDATABASE) ??
      "archon"
  );

  const client = new Client(
    { name: "archon-managed-mcp-audit", version: "2.0.0" },
    { capabilities: {} }
  );
  const transport = new StreamableHTTPClientTransport(
    new URL(MANAGED_MCP_URL),
    {
      requestInit: {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "mcp-cluster-id": clusterId,
        },
      },
    }
  );

  const proofResults: ProofResult[] = [];
  const calledTools: ManagedMcpToolName[] = [];
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const tools = new Map(listed.tools.map((tool) => [tool.name, tool]));

    for (const name of MANAGED_MCP_CALLED_TOOLS) {
      if (!tools.has(name)) {
        throw new Error(`Managed MCP tool "${name}" is unavailable.`);
      }
    }

    const call = async (
      name: ManagedMcpToolName,
      candidates: Record<string, unknown>
    ): Promise<unknown> => {
      const tool = tools.get(name);
      const result = await client.callTool({
        name,
        arguments: compatibleArgs(tool?.inputSchema, candidates),
      });
      if (object(result)?.isError === true) {
        throw new Error(`Managed MCP tool "${name}" returned an error.`);
      }
      calledTools.push(name);
      return result;
    };

    const clusterResult = await call("get_cluster", {});
    const cluster = toolText(clusterResult);
    proofResults.push({
      name: "get_cluster",
      ok: hasAny(cluster, [/AWS/i, /CockroachDB/i, /version/i, /region/i]),
    });

    const tablesResult = await call("list_tables", {
      database,
      database_name: database,
    });
    const tables = toolText(tablesResult);
    proofResults.push({
      name: "list_tables",
      ok: /agent_memory/i.test(tables),
    });

    const schemaResult = await call("get_table_schema", {
      database,
      database_name: database,
      table: "agent_memory",
      table_name: "agent_memory",
    });
    const schema = toolText(schemaResult);
    proofResults.push({
      name: "get_table_schema",
      ok:
        /VECTOR\s*\(\s*1024\s*\)/i.test(schema) &&
        hasAny(schema, [
          /VECTOR INDEX/i,
          /vector_cosine_ops/i,
          /embedding.*idx/i,
        ]),
    });

    const selectTool = tools.get("select_query");
    const selectArgs = compatibleArgs(selectTool?.inputSchema, {
      database,
      database_name: database,
      query: MANAGED_MCP_AGGREGATE_QUERY,
      sql: MANAGED_MCP_AGGREGATE_QUERY,
    });
    if (
      selectArgs.query !== MANAGED_MCP_AGGREGATE_QUERY &&
      selectArgs.sql !== MANAGED_MCP_AGGREGATE_QUERY
    ) {
      throw new Error(
        "Managed MCP select_query schema exposes no supported fixed-SQL argument."
      );
    }
    const aggregateResult = await call("select_query", selectArgs);
    const aggregate = parseManagedMcpAggregateResult(aggregateResult);
    proofResults.push({ name: "select_query", ok: true });

    const receipt = buildManagedMcpReceiptV2({
      checkedAt: new Date().toISOString(),
      database,
      toolsAdvertised: listed.tools.length,
      calledTools,
      proofResults,
      aggregate,
    });
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    if (!receipt.ok) process.exitCode = 1;
  } finally {
    await client.close().catch(() => undefined);
  }
}

const invokedDirectly =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(resolve(process.argv[1]!)).href;

if (invokedDirectly) {
  main().catch((error) => {
    const message =
      error instanceof Error ? error.message : "Unknown managed MCP audit error.";
    process.stderr.write(`Managed MCP audit failed: ${message}\n`);
    process.exitCode = 1;
  });
}
