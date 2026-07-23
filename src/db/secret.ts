export interface DatabaseSecretOptions {
  requireTls?: boolean;
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
    url.searchParams.get("sslmode") !== "verify-full"
  ) {
    throw new Error(
      "Managed CockroachDB database secrets must use sslmode=verify-full."
    );
  }
  return databaseUrl;
}
