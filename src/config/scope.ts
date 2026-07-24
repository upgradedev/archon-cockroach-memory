// Public demo scope.
//
// These values are process configuration, never request input. CockroachDB RLS
// independently binds the public runtime role to this exact synthetic scope.

function configured(name: string, fallback: string): string {
  const value = process.env[name]?.trim() || fallback;
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${name} contains control characters.`);
  }
  return value;
}

export const PUBLIC_DEMO_TENANT_ID = configured(
  "PUBLIC_DEMO_TENANT_ID",
  "public-demo"
);

// A dot would change the RLS `application_name` field split. Keep this value
// deliberately boring and fail closed on a malformed deployment configuration.
if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/u.test(PUBLIC_DEMO_TENANT_ID)) {
  throw new Error(
    "PUBLIC_DEMO_TENANT_ID must be 1-63 letters, digits, underscores, or hyphens."
  );
}

export const PUBLIC_DEMO_COMPANY = configured(
  "PUBLIC_DEMO_COMPANY",
  "Helios SA"
);

if (PUBLIC_DEMO_COMPANY.length > 120) {
  throw new Error("PUBLIC_DEMO_COMPANY must be at most 120 characters.");
}

// This is the only application_name the app's pool may use. It is operational
// telemetry, not an authorization boundary, and is never accepted from callers.
export const DATABASE_APPLICATION_NAME = `archon.${PUBLIC_DEMO_TENANT_ID}`;

export function publicDemoScope(): {
  tenantId: string;
  company: string;
  mode: "fixed-synthetic-demo";
  access: "read-only";
  dataClassification: "synthetic-public-demo";
  source: "server-configured";
} {
  return {
    tenantId: PUBLIC_DEMO_TENANT_ID,
    company: PUBLIC_DEMO_COMPANY,
    mode: "fixed-synthetic-demo",
    access: "read-only",
    dataClassification: "synthetic-public-demo",
    source: "server-configured",
  };
}
