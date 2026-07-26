// Safe, idempotent local bootstrap for the repository quickstart and CI.
//
// This script deliberately accepts no destination configuration. It can reach
// only the insecure loopback CockroachDB started by docker-compose.yml, never a
// cloud cluster. It creates the dedicated database, applies the schema, seeds
// deterministic FakeEmbedder fixtures, and verifies the exact 12-row contract.
// It never deletes, truncates, drops, or reconciles existing memory.

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";

export const LOCAL_ADMIN_URL =
  "postgresql://root@127.0.0.1:26257/defaultdb?sslmode=disable";
export const LOCAL_APPLICATION_URL =
  "postgresql://root@127.0.0.1:26257/archon_memory?sslmode=disable";
const LOCAL_DATABASE = "archon_memory";
export const LOCAL_MODEL = "fake-hash-embedder";

export interface LocalFixtureDescriptor {
  tenantId: string;
  kind: string;
  company: string;
  period: string;
  sourceRef: string;
  status: string;
  idempotencyKey: string;
}

export const EXPECTED_LOCAL_FIXTURES: readonly LocalFixtureDescriptor[] = [
  {
    tenantId: "public-demo",
    kind: "payroll_event",
    company: "Helios SA",
    period: "2026-04",
    sourceRef: "EVT-HELIOS-2604",
    status: "active",
    idempotencyKey: "archon-event/v1/EVT-HELIOS-2604/summary",
  },
  {
    tenantId: "public-demo",
    kind: "insight",
    company: "Helios SA",
    period: "2026-04",
    sourceRef: "EVT-HELIOS-2604",
    status: "active",
    idempotencyKey: "archon-event/v1/EVT-HELIOS-2604/off-bank-cost",
  },
  ...["E-01", "E-02", "E-03", "E-04"].map((employeeId) => ({
    tenantId: "public-demo",
    kind: "payroll_event",
    company: "Helios SA",
    period: "2026-04",
    sourceRef: `EVT-HELIOS-2604:${employeeId}`,
    status: "active",
    idempotencyKey:
      `archon-event/v1/EVT-HELIOS-2604/employee/${employeeId}`,
  })),
  {
    tenantId: "public-demo",
    kind: "document",
    company: "Helios SA",
    period: "2026-04",
    sourceRef: "INV-2043",
    status: "active",
    idempotencyKey: "archon-demo/v1/inv-2043-confirmed",
  },
  {
    tenantId: "public-demo",
    kind: "document",
    company: "Helios SA",
    period: "2026-04",
    sourceRef: "INV-2043",
    status: "active",
    idempotencyKey: "archon-demo/v1/inv-2043-later-note",
  },
  {
    tenantId: "public-demo",
    kind: "validation",
    company: "Helios SA",
    period: "2026-04",
    sourceRef: "RECON-2043",
    status: "active",
    idempotencyKey: "archon-demo/v1/recon-2043-missing-pay-118",
  },
  {
    tenantId: "public-demo",
    kind: "validation",
    company: "Isolation Canary Ltd",
    period: "2026-04",
    sourceRef: "RLS-CANARY-1",
    status: "active",
    idempotencyKey: "archon-demo/v1/rls-hidden-company-canary",
  },
  {
    tenantId: "isolation-canary",
    kind: "validation",
    company: "Helios SA",
    period: "2026-04",
    sourceRef: "RLS-CANARY-TENANT",
    status: "active",
    idempotencyKey: "archon-demo/v1/rls-wrong-tenant-canary",
  },
  {
    tenantId: "public-demo",
    kind: "validation",
    company: "Helios SA",
    period: "2026-04",
    sourceRef: "RLS-CANARY-STATUS",
    status: "retracted",
    idempotencyKey: "archon-demo/v1/rls-retracted-status-canary",
  },
] as const;

export interface LocalFixtureRow {
  tenant_id: string;
  kind: string;
  company: string;
  period: string | null;
  source_ref: string | null;
  embed_model: string;
  idempotency_key: string;
  status: string;
}

function descriptor(input: LocalFixtureDescriptor): string {
  return JSON.stringify([
    input.tenantId,
    input.kind,
    input.company,
    input.period,
    input.sourceRef,
    LOCAL_MODEL,
    input.idempotencyKey,
    input.status,
  ]);
}

function rowDescriptor(row: LocalFixtureRow): string {
  return JSON.stringify([
    row.tenant_id,
    row.kind,
    row.company,
    row.period,
    row.source_ref,
    row.embed_model,
    row.idempotency_key,
    row.status,
  ]);
}

export function verifyLocalFixtures(rows: readonly LocalFixtureRow[]): {
  persisted: number;
  idempotencyKeys: number;
  exactFixtures: number;
} {
  const expected = new Set(EXPECTED_LOCAL_FIXTURES.map(descriptor));
  const actual = new Set(rows.map(rowDescriptor));
  const uniqueKeys = new Set(rows.map((row) => row.idempotency_key));
  const exactFixtures = [...actual].filter((item) =>
    expected.has(item)
  ).length;
  if (
    expected.size !== 12 ||
    rows.length !== 12 ||
    actual.size !== 12 ||
    uniqueKeys.size !== 12 ||
    exactFixtures !== 12
  ) {
    throw new Error(
      "Local bootstrap fixture proof must be exactly 12 persisted, unique, exact FakeEmbedder records."
    );
  }
  return {
    persisted: rows.length,
    idempotencyKeys: uniqueKeys.size,
    exactFixtures,
  };
}

export async function runLocalBootstrap(): Promise<void> {
  // Override every application-scope value before dynamically importing any
  // application module; external shell/AWS configuration cannot redirect this.
  process.env.DATABASE_URL = LOCAL_APPLICATION_URL;
  process.env.DATABASE_SECRET_ID = "";
  process.env.PUBLIC_DEMO_TENANT_ID = "public-demo";
  process.env.PUBLIC_DEMO_COMPANY = "Helios SA";
  process.env.EMBED_DIM = "1024";

  const admin = new Pool({
    connectionString: LOCAL_ADMIN_URL,
    max: 1,
    application_name: "archon.local-bootstrap.admin",
  });
  try {
    await admin.query(`CREATE DATABASE IF NOT EXISTS ${LOCAL_DATABASE}`);
  } finally {
    await admin.end();
  }

  const [{ applySchema }, { FakeEmbedder }, { seedDemo }, database] =
    await Promise.all([
      import("./apply-schema.js"),
      import("../src/memory/embeddings.js"),
      import("./seed-demo.js"),
      import("../src/db/client.js"),
    ]);

  try {
    await applySchema();
    await seedDemo(new FakeEmbedder());

    const publicKeys = EXPECTED_LOCAL_FIXTURES.filter(
      (fixture) => fixture.tenantId === "public-demo"
    ).map((fixture) => fixture.idempotencyKey);
    const isolationKeys = EXPECTED_LOCAL_FIXTURES.filter(
      (fixture) => fixture.tenantId === "isolation-canary"
    ).map((fixture) => fixture.idempotencyKey);
    const rows = await database.query<LocalFixtureRow>(
      `SELECT tenant_id, kind, company, period, source_ref, embed_model,
              idempotency_key, status
         FROM agent_memory
        WHERE embed_model = $1
          AND (
            (tenant_id = 'public-demo'
              AND idempotency_key = ANY($2::STRING[]))
            OR
            (tenant_id = 'isolation-canary'
              AND idempotency_key = ANY($3::STRING[]))
          )
        ORDER BY tenant_id, company, status, idempotency_key`,
      [LOCAL_MODEL, publicKeys, isolationKeys]
    );
    const receipt = verifyLocalFixtures(rows);

    process.stdout.write(
      `local-bootstrap receipt=12/12/12 expected=12 persisted=${receipt.persisted} ` +
        `unique=${receipt.idempotencyKeys} exact=${receipt.exactFixtures} ` +
        `model=${LOCAL_MODEL}\n`
    );
  } finally {
    await database.closePool();
  }
}

const invokedDirectly =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(resolve(process.argv[1]!)).href;

if (invokedDirectly) {
  runLocalBootstrap().catch(() => {
    process.stderr.write("Local bootstrap failed closed.\n");
    process.exitCode = 1;
  });
}
