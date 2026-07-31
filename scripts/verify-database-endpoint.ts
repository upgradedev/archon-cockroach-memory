import { createHash } from "node:crypto";
import {
  assertCockroachEndpointBinding,
  parseDatabaseSecret,
} from "../src/db/secret.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function main(): void {
  const databaseUrl = parseDatabaseSecret(required("DATABASE_URL"), {
    requireTls: true,
  });
  const binding = assertCockroachEndpointBinding(
    databaseUrl,
    required("COCKROACH_SQL_DNS")
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        ok: true,
        clusterIdBoundBy:
          "authenticated Cockroach Cloud API primary eu-west-1 sql_dns",
        endpointHostnameSha256: createHash("sha256")
          .update(binding.hostname, "utf8")
          .digest("hex"),
        port: binding.port,
        database: binding.database,
        tlsMode: binding.tlsMode,
        routingOverrides: binding.routingOverrides,
        secretMaterialPrinted: false,
      },
      null,
      2
    )}\n`
  );
}

try {
  main();
} catch (error) {
  const message =
    error instanceof Error ? error.message : "endpoint binding failed";
  process.stderr.write(`CockroachDB endpoint binding failed: ${message}\n`);
  process.exitCode = 1;
}
