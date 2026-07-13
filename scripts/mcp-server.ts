// Stdio entrypoint for the Archon Memory MCP server.
//
// Run this to expose the CockroachDB-backed agent memory as MCP tools to any
// MCP client (Claude Code, Cursor, VS Code, a custom agent). It speaks MCP over
// stdio, so a client launches it as a subprocess.
//
//   DATABASE_URL=postgresql://root@localhost:26257/archon_memory?sslmode=disable \
//     npm run mcp:server
//
// Without AWS creds it embeds with the deterministic FakeEmbedder (offline); set
// AWS creds to switch to real Bedrock Titan — same tools, same store. Example
// client config (Claude Code / Cursor):
//
//   { "mcpServers": { "archon-memory": {
//       "command": "npm", "args": ["run", "mcp:server"],
//       "env": { "DATABASE_URL": "postgresql://…" } } } }

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMemoryMcpServer } from "../src/mcp/server.js";
import { closePool } from "../src/db/client.js";

async function main(): Promise<void> {
  const server = createMemoryMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr, so it never corrupts the stdio JSON-RPC stream on stdout.
  process.stderr.write("archon-cockroach-memory MCP server ready on stdio\n");

  const shutdown = async () => {
    try {
      await server.close();
    } finally {
      await closePool();
      process.exit(0);
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  process.stderr.write(`MCP server failed to start: ${String(err)}\n`);
  process.exit(1);
});
