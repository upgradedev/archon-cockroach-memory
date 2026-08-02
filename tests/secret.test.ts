import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertCockroachEndpointBinding,
  parseDatabaseSecret,
} from "../src/db/secret.js";
import {
  affirmativeSystemGrants,
  privilegedRuntimeRoleOptions,
  runtimeLoginIsDisabled,
  runtimeRoleOptionsAreCanonical,
} from "../src/db/system-grants.js";

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
  assert.throws(
    () =>
      parseDatabaseSecret(`${TLS_URL}&sslmode=disable`, {
        requireTls: true,
      }),
    /sslmode=verify-full/u
  );
  assert.throws(
    () =>
      parseDatabaseSecret(
        TLS_URL.replace("sslmode=verify-full", "SSLMode=verify-full"),
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

test("Cockroach endpoint binding accepts only the authenticated Cloud sql_dns", () => {
  assert.deepEqual(
    assertCockroachEndpointBinding(TLS_URL, "CLUSTER.EXAMPLE."),
    {
      hostname: "cluster.example",
      port: 26257,
      database: "archon",
      tlsMode: "verify-full",
      routingOverrides: "none",
    }
  );
  for (const invalid of [
    TLS_URL.replace("cluster.example", "other.example"),
    TLS_URL.replace(":26257", ":5432"),
    TLS_URL.replace(":26257/archon?", ":26257/defaultdb?"),
    TLS_URL.replace("sslmode=verify-full", "sslmode=require"),
    `${TLS_URL}&sslmode=disable`,
  ]) {
    assert.throws(
      () => assertCockroachEndpointBinding(invalid, "cluster.example"),
      /bound to the authenticated Cockroach Cloud cluster endpoint/u
    );
  }
});

test("database secrets reject connection-routing query overrides", () => {
  for (const key of [
    "database",
    "dbname",
    "host",
    "hostaddr",
    "options",
    "port",
    "service",
    "user",
    "password",
    "application_name",
    "HOST",
  ]) {
    const overridden = `${TLS_URL}&${key}=attacker.example`;
    assert.throws(
      () => parseDatabaseSecret(overridden, { requireTls: true }),
      /alternate routing parameters/u
    );
    assert.throws(
      () =>
        assertCockroachEndpointBinding(overridden, "cluster.example"),
      /bound to the authenticated Cockroach Cloud cluster endpoint/u
    );
  }
});

test("runtime privilege proof ignores only deny-only CockroachDB role options", () => {
  assert.deepEqual(
    affirmativeSystemGrants([
      { privilege_type: "NOSQLLOGIN", is_grantable: false },
      { privilege_type: "NOBYPASSRLS", is_grantable: false },
      { privilege_type: "NOREPLICATION", is_grantable: false },
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

test("runtime role-option proof rejects every privileged or disabled-login option", () => {
  assert.deepEqual(
    privilegedRuntimeRoleOptions([
      "NOBYPASSRLS",
      "CREATEDB",
      "CREATELOGIN = true",
      "CONTROLCHANGEFEED",
      "REPLICATION",
      "SUBJECT=CN=unexpected",
      "PROVISIONSRC=oidc:https://unexpected.example",
      "VIEWACTIVITYREDACTED",
      "CREATEDB",
    ]),
    [
      "CONTROLCHANGEFEED",
      "CREATEDB",
      "CREATELOGIN",
      "PROVISIONSRC",
      "REPLICATION",
      "SUBJECT",
      "VIEWACTIVITYREDACTED",
    ]
  );
  assert.equal(runtimeLoginIsDisabled(["NOBYPASSRLS"]), false);
  assert.equal(runtimeLoginIsDisabled(["NOLOGIN"]), true);
  assert.equal(runtimeLoginIsDisabled(["NOSQLLOGIN = true"]), true);
  assert.equal(runtimeRoleOptionsAreCanonical([]), true);
  assert.equal(runtimeRoleOptionsAreCanonical(["VALID UNTIL=2099-01-01"]), false);
  assert.equal(runtimeRoleOptionsAreCanonical(["FUTURE_OPTION"]), false);
});
