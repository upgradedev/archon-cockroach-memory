export interface DatabaseSecretOptions {
  requireTls?: boolean;
}

const ROUTING_OVERRIDE_PARAMETERS = new Set([
  "database",
  "dbname",
  "host",
  "hostaddr",
  "options",
  "port",
  "service",
]);
const ALLOWED_CONNECTION_PARAMETERS = new Set(["sslmode"]);
const COCKROACH_CLOUD_DNS =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;

function normalizedDnsName(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/u, "");
}

function connectionOverrideParameters(url: URL): string[] {
  return [...url.searchParams.keys()]
    .map((key) => key.toLowerCase())
    .filter(
      (key) =>
        ROUTING_OVERRIDE_PARAMETERS.has(key) ||
        !ALLOWED_CONNECTION_PARAMETERS.has(key)
    );
}

function hasExactVerifyFullTls(url: URL): boolean {
  const tlsParameters = [...url.searchParams.entries()].filter(
    ([key]) => key.toLowerCase() === "sslmode"
  );
  return (
    tlsParameters.length === 1 &&
    tlsParameters[0]?.[0] === "sslmode" &&
    tlsParameters[0][1] === "verify-full"
  );
}

export function parseDatabaseSecret(
  secretValue: string,
  options: DatabaseSecretOptions = {}
): string {
  const trimmed = secretValue.trim();
  let databaseUrl: unknown;
  if (/^postgres(?:ql)?:\/\//iu.test(trimmed)) {
    databaseUrl = trimmed;
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error(
        "Database secret must be a PostgreSQL URI or canonical JSON."
      );
    }
    databaseUrl =
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>).DATABASE_URL
        : undefined;
  }
  if (
    typeof databaseUrl !== "string" ||
    !/^postgres(?:ql)?:\/\//iu.test(databaseUrl)
  ) {
    throw new Error(
      "Database secret JSON must contain a DATABASE_URL PostgreSQL URI."
    );
  }

  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error("Database secret contains an invalid PostgreSQL URI.");
  }
  if (
    !url.hostname ||
    !url.username ||
    !url.pathname ||
    url.pathname === "/"
  ) {
    throw new Error(
      "Database URI must identify a host, user, and database."
    );
  }
  if (
    options.requireTls &&
    !hasExactVerifyFullTls(url)
  ) {
    throw new Error(
      "Managed CockroachDB database secrets must use sslmode=verify-full."
    );
  }
  if (connectionOverrideParameters(url).length !== 0) {
    throw new Error(
      "Database URI must not contain alternate routing parameters."
    );
  }
  return databaseUrl;
}

export interface CockroachEndpointBindingProof {
  hostname: string;
  port: 26257;
  database: "archon";
  tlsMode: "verify-full";
  routingOverrides: "none";
}

export function assertCockroachEndpointBinding(
  databaseUrl: string,
  expectedSqlDns: string
): CockroachEndpointBindingProof {
  const expectedHostname = normalizedDnsName(expectedSqlDns);
  if (!COCKROACH_CLOUD_DNS.test(expectedHostname)) {
    throw new Error(
      "Cockroach Cloud API sql_dns is not a valid managed DNS hostname."
    );
  }

  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error("CockroachDB endpoint binding received an invalid URI.");
  }
  const hostname = normalizedDnsName(url.hostname);
  let database: string;
  try {
    database = decodeURIComponent(url.pathname.replace(/^\/+/u, ""));
  } catch {
    throw new Error(
      "CockroachDB endpoint binding received an invalid database path."
    );
  }
  if (
    (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
    hostname !== expectedHostname ||
    url.port !== "26257" ||
    database !== "archon" ||
    !url.username ||
    !url.password ||
    url.hash !== "" ||
    !hasExactVerifyFullTls(url) ||
    connectionOverrideParameters(url).length !== 0
  ) {
    throw new Error(
      "Database URI is not bound to the authenticated Cockroach Cloud cluster endpoint."
    );
  }
  return {
    hostname,
    port: 26257,
    database: "archon",
    tlsMode: "verify-full",
    routingOverrides: "none",
  };
}
