import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EXPECTED_LOCAL_FIXTURES,
  LOCAL_ADMIN_URL,
  LOCAL_APPLICATION_URL,
  LOCAL_MODEL,
  type LocalFixtureRow,
  verifyLocalFixtures,
} from "../scripts/local-bootstrap.js";

function row(
  fixture: (typeof EXPECTED_LOCAL_FIXTURES)[number]
): LocalFixtureRow {
  return {
    tenant_id: fixture.tenantId,
    kind: fixture.kind,
    company: fixture.company,
    period: fixture.period,
    source_ref: fixture.sourceRef,
    embed_model: LOCAL_MODEL,
    idempotency_key: fixture.idempotencyKey,
    status: fixture.status,
  };
}

test("local bootstrap destinations are exact passwordless loopback URLs", () => {
  for (const [raw, pathname] of [
    [LOCAL_ADMIN_URL, "/defaultdb"],
    [LOCAL_APPLICATION_URL, "/archon_memory"],
  ] as const) {
    const url = new URL(raw);
    assert.equal(url.protocol, "postgresql:");
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(url.port, "26257");
    assert.equal(url.username, "root");
    assert.equal(url.password, "");
    assert.equal(url.pathname, pathname);
    assert.equal(url.searchParams.get("sslmode"), "disable");
  }
});

test("local bootstrap verifies the exact nine public fixtures and three canaries", () => {
  assert.equal(EXPECTED_LOCAL_FIXTURES.length, 12);
  assert.equal(
    EXPECTED_LOCAL_FIXTURES.filter(
      (fixture) =>
        fixture.tenantId === "public-demo" &&
        fixture.company === "Helios SA" &&
        fixture.status === "active"
    ).length,
    9
  );
  const rows = EXPECTED_LOCAL_FIXTURES.map(row);
  assert.deepEqual(verifyLocalFixtures(rows), {
    persisted: 12,
    idempotencyKeys: 12,
    exactFixtures: 12,
  });
});

test("local bootstrap proof rejects missing, duplicate, or drifted fixtures", () => {
  const rows = EXPECTED_LOCAL_FIXTURES.map(row);
  for (const invalid of [
    rows.slice(1),
    [...rows.slice(0, -1), rows[0]!],
    rows.map((item, index) =>
      index === 0 ? { ...item, source_ref: "drifted" } : item
    ),
  ]) {
    assert.throws(
      () => verifyLocalFixtures(invalid),
      /exactly 12 persisted, unique, exact/u
    );
  }
});

test("local bootstrap source contains no destructive data operation", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(
    join(here, "..", "scripts", "local-bootstrap.ts"),
    "utf8"
  );
  assert.doesNotMatch(source, /\b(?:DELETE|DROP|TRUNCATE|UPDATE)\b/iu);
});
