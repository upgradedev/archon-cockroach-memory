import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDatabaseSecret } from "../src/db/secret.js";

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
