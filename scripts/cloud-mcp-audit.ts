// Read-only production proof through CockroachDB Cloud's hosted Managed MCP Server.
//
// This is intentionally an audit client, not another memory implementation. It lets
// an agent inspect the live cluster, schema, native vector index, and bounded memory
// counts through CockroachDB's managed control plane without exposing SQL credentials.
//
// Required:
//   CCLOUD_API_KEY=<CockroachDB Cloud service-account API key>
// Optional:
//   COCKROACH_CLUSTER_ID=<cluster UUID>       (auto-discovered by name otherwise)
//   COCKROACH_CLUSTER_NAME=archon-memory
//   COCKROACH_DATABASE=archon
//
// The emitted JSON is deliberately sanitized: no API key, connection URL, row
// content, or embeddings are printed.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const CLOUD_API = "https://cockroachlabs.cloud/api/v1/clusters";
const MANAGED_MCP_URL = "https://cockroachlabs.cloud/mcp";

type JsonObject = Record<string, unknown>;

interface ClusterSummary {
  id: string;
  name: string;
}

interface ToolProof {
  name: string;
  ok: boolean;
  detail: string;
}

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
    stringValue(process.env.COCKROACH_CLUSTER_NAME) ?? "archon-cockroachdb-cluster";
  const response = await fetch(CLOUD_API, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`Cockroach Cloud cluster discovery failed (HTTP ${response.status})`);
  }

  const clusters = parseClusters(await response.json());
  const exact = clusters.find((cluster) => cluster.name === clusterName);
  if (exact) return exact.id;
  if (clusters.length === 1) return clusters[0].id;

  throw new Error(
    `Cluster "${clusterName}" was not found; set COCKROACH_CLUSTER_ID explicitly.`
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
    Object.entries(candidates).filter(([key]) => available.size === 0 || available.has(key))
  );
}

async function main(): Promise<void> {
  const apiKey = stringValue(process.env.CCLOUD_API_KEY);
  if (!apiKey) throw new Error("CCLOUD_API_KEY is required.");

  const clusterId = await resolveClusterId(apiKey);
  const database =
    stringValue(process.env.COCKROACH_DATABASE) ??
    stringValue(process.env.PGDATABASE) ??
    "archon";

  const client = new Client(
    { name: "archon-managed-mcp-audit", version: "1.0.0" },
    { capabilities: {} }
  );
  const transport = new StreamableHTTPClientTransport(new URL(MANAGED_MCP_URL), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "mcp-cluster-id": clusterId,
      },
    },
  });

  const proofs: ToolProof[] = [];
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const tools = new Map(listed.tools.map((tool) => [tool.name, tool]));
    const required = ["get_cluster", "list_tables", "get_table_schema", "select_query"];

    for (const name of required) {
      if (!tools.has(name)) {
        throw new Error(`Managed MCP tool "${name}" is unavailable.`);
      }
    }

    const call = async (
      name: string,
      candidates: Record<string, unknown>
    ): Promise<string> => {
      const tool = tools.get(name);
      const result = await client.callTool({
        name,
        arguments: compatibleArgs(tool?.inputSchema, candidates),
      });
      const text = toolText(result);
      if (object(result)?.isError === true) {
        throw new Error(`Managed MCP tool "${name}" returned an error.`);
      }
      return text;
    };

    const cluster = await call("get_cluster", {});
    proofs.push({
      name: "get_cluster",
      ok: hasAny(cluster, [/AWS/i, /CockroachDB/i, /version/i, /region/i]),
      detail: "Live cluster metadata returned through CockroachDB Cloud Managed MCP.",
    });

    const tables = await call("list_tables", {
      database,
      database_name: database,
    });
    proofs.push({
      name: "list_tables",
      ok: /agent_memory/i.test(tables),
      detail: "`agent_memory` is present in the live application database.",
    });

    const schema = await call("get_table_schema", {
      database,
      database_name: database,
      table: "agent_memory",
      table_name: "agent_memory",
    });
    proofs.push({
      name: "get_table_schema",
      ok:
        /VECTOR\s*\(\s*1024\s*\)/i.test(schema) &&
        hasAny(schema, [/VECTOR INDEX/i, /vector_cosine_ops/i, /embedding.*idx/i]),
      detail: "Live schema exposes VECTOR(1024) and a native vector index.",
    });

    const counts = await call("select_query", {
      database,
      database_name: database,
      query:
        "SELECT count(*)::INT AS memory_count, count(DISTINCT company)::INT AS company_count FROM agent_memory",
      sql:
        "SELECT count(*)::INT AS memory_count, count(DISTINCT company)::INT AS company_count FROM agent_memory",
    });
    proofs.push({
      name: "select_query",
      ok: /memory_count/i.test(counts),
      detail: "A bounded aggregate query succeeded; row content and embeddings were not read.",
    });

    const failed = proofs.filter((proof) => !proof.ok);
    const receipt = {
      ok: failed.length === 0,
      checkedAt: new Date().toISOString(),
      endpoint: MANAGED_MCP_URL,
      clusterId: `${clusterId.slice(0, 8)}…${clusterId.slice(-4)}`,
      database,
      mode: "read-only",
      toolsAdvertised: listed.tools.length,
      proofs,
      redactions: ["API key", "SQL credentials", "memory content", "embeddings"],
    };
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    if (failed.length > 0) process.exitCode = 1;
  } finally {
    await client.close().catch(() => undefined);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Managed MCP audit failed: ${message}\n`);
  process.exitCode = 1;
});
