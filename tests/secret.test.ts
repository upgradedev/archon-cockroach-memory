import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDatabaseSecret } from "../src/db/secret.js";
import { affirmativeSystemGrants } from "../src/db/system-grants.js";

const TLS_URL =
  "postgresql://archon_runtime:example@cluster.example:26257/archon?sslmode=verify-full";

test("database secret accepts only the canonical DATABASE_URL JSON key", () => {
  assert.equal(
    parseDatabaseSecret(JSON.stringify({ DATABASE_URL: TLS_URL }), {
      requireTls: true,
    }),
    TLS_URL
  );
  assert.throws(
    () =>
      parseDatabaseSecret(JSON.stringify({ databaseUrl: TLS_URL }), {
        requireTls: true,
      }),
    /DATABASE_URL/u
  );
});

test("managed database secret requires full TLS hostname verification", () => {
  assert.throws(
    () =>
      parseDatabaseSecret(
        TLS_URL.replace("sslmode=verify-full", "sslmode=disable"),
        { requireTls: true }
      ),
    /sslmode=verify-full/u
  );
});

test("database secret requires a host, principal, and database", () => {
  assert.throws(
    () =>
      parseDatabaseSecret(
        "postgresql://cluster.example:26257/?sslmode=verify-full",
        { requireTls: true }
      ),
    /host, user, and database/u
  );
});

test("runtime privilege proof ignores only deny-only CockroachDB role options", () => {
  assert.deepEqual(
    affirmativeSystemGrants([
      { privilege_type: "NOSQLLOGIN", is_grantable: false },
      { privilege_type: "NOBYPASSRLS", is_grantable: false },
      { privilege_type: "NOVIEWACTIVITY", is_grantable: false },
    ]),
    []
  );
});

test("runtime privilege proof fails closed on positive, unknown, or grantable entries", () => {
  const unsafe = [
    { privilege_type: "VIEWACTIVITYREDACTED", is_grantable: false },
    { privilege_type: "BACKUP", is_grantable: false },
    { privilege_type: "FUTURE_CLUSTER_PRIVILEGE", is_grantable: false },
    { privilege_type: "NOSQLLOGIN", is_grantable: true },
  ];

  assert.deepEqual(affirmativeSystemGrants(unsafe), unsafe);
});
