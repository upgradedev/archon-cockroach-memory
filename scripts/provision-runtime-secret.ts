// One-time/rotation operator task: create a least-privilege CockroachDB runtime
// principal and place only its connection URL in AWS Secrets Manager.
//
// Required:
//   DATABASE_URL=<admin/operator CockroachDB URL>
//   COCKROACH_SQL_DNS=<authenticated Cloud API primary eu-west-1 sql_dns>
// Optional:
//   APP_ENV=production
//   APP_DB_USER=archon_production_<rotation-id>
//   DATABASE_SECRET_NAME=archon-memory/production/database
//   AWS_REGION=eu-west-1
//
// The generated password and connection URL are never printed.

import { randomBytes } from "node:crypto";
import pg from "pg";
import {
  CreateSecretCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import {
  assertCockroachEndpointBinding,
  parseDatabaseSecret,
} from "../src/db/secret.js";
import {
  expectedRuntimeDatabaseGrants,
  verifyClusterWideResolutionGrants,
} from "../src/db/cluster-grant-proof.js";
import {
  affirmativeSystemGrants,
  privilegedRuntimeRoleOptions,
  runtimeLoginIsDisabled,
  runtimeRoleOptionsAreCanonical,
  type SystemGrant,
} from "../src/db/system-grants.js";

const { Client } = pg;

function identifier(value: string, label: string): string {
  if (!/^[a-z][a-z0-9_]{2,62}$/i.test(value)) {
    throw new Error(`${label} must match [A-Za-z][A-Za-z0-9_]{2,62}.`);
  }
  return `"${value.replaceAll('"', '""')}"`;
}

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function main(): Promise<void> {
  const adminUrl = parseDatabaseSecret(required("DATABASE_URL"), {
    requireTls: true,
  });
  const expectedSqlDns = required("COCKROACH_SQL_DNS");
  assertCockroachEndpointBinding(adminUrl, expectedSqlDns);
  const environment = process.env.APP_ENV?.trim() || "production";
  if (!/^(staging|production)$/u.test(environment)) {
    throw new Error("APP_ENV must be staging or production.");
  }
  const rotationId = randomBytes(5).toString("hex");
  const appName = process.env.APP_NAME?.trim() || "archon-memory";
  if (!/^[a-z][a-z0-9-]{2,16}$/u.test(appName)) {
    throw new Error("APP_NAME has an invalid format.");
  }
  const readerRole = identifier("archon_public_reader", "reader role");
  const resolutionRole = identifier(
    "archon_resolution_writer",
    "resolution writer role"
  );
  const secretName =
    process.env.DATABASE_SECRET_NAME?.trim() ||
    `${appName}/${environment}/database`;
  if (secretName !== `${appName}/${environment}/database`) {
    throw new Error(
      "DATABASE_SECRET_NAME must match the selected application environment."
    );
  }
  const region = process.env.AWS_REGION?.trim() || "eu-west-1";
  if (region !== "eu-west-1") {
    throw new Error("Runtime database secrets are restricted to eu-west-1.");
  }

  const parsed = new URL(adminUrl);
  const databaseRaw = decodeURIComponent(parsed.pathname.replace(/^\//, "")) || "defaultdb";
  const database = identifier(databaseRaw, "database name");
  const password = randomBytes(36).toString("base64url");
  const secrets = new SecretsManagerClient({ region });

  let existingDatabaseUrl: string | undefined;
  let arn: string | undefined;
  try {
    const described = await secrets.send(
      new DescribeSecretCommand({ SecretId: secretName })
    );
    arn = described.ARN;
    const existing = await secrets.send(
      new GetSecretValueCommand({ SecretId: secretName })
    );
    if (!existing.SecretString) {
      throw new Error("Existing runtime database secret must be textual.");
    }
    existingDatabaseUrl = parseDatabaseSecret(existing.SecretString, {
      requireTls: true,
    });
    assertCockroachEndpointBinding(existingDatabaseUrl, expectedSqlDns);
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "ResourceNotFoundException") {
      throw error;
    }
  }

  const secretPrincipal = existingDatabaseUrl
    ? decodeURIComponent(new URL(existingDatabaseUrl).username)
    : undefined;
  const requestedPrincipal = process.env.APP_DB_USER?.trim();
  if (
    requestedPrincipal &&
    secretPrincipal &&
    requestedPrincipal !== secretPrincipal
  ) {
    throw new Error(
      "APP_DB_USER does not match the principal in the existing runtime secret."
    );
  }
  const appUserRaw =
    secretPrincipal ||
    requestedPrincipal ||
    `archon_${environment}_${rotationId}`;
  if (
    !new RegExp(`^archon_${environment}_[a-z0-9]{6,40}$`, "u").test(
      appUserRaw
    )
  ) {
    throw new Error(
      `Runtime principal must be a dedicated archon_${environment}_<rotation-id> login.`
    );
  }
  if (existingDatabaseUrl) {
    const existing = new URL(existingDatabaseUrl);
    const existingDatabase = decodeURIComponent(
      existing.pathname.replace(/^\//, "")
    );
    if (existingDatabase !== databaseRaw) {
      throw new Error(
        "Existing runtime secret targets a different application database."
      );
    }
  }
  const appUser = identifier(appUserRaw, "runtime principal");

  const sql = new Client({ connectionString: adminUrl });
  let userCreated = false;
  try {
    await sql.connect();
    const existing = await sql.query<{
      username: string;
      options: string[] | string;
      member_of: string[] | string;
    }>(
      "SELECT username, options, member_of FROM [SHOW USERS] WHERE username = $1",
      [appUserRaw]
    );
    if (existingDatabaseUrl && existing.rowCount !== 1) {
      throw new Error(
        "Existing runtime secret references a missing database principal."
      );
    }
    if (!existingDatabaseUrl && existing.rowCount) {
      throw new Error("The requested runtime principal already exists.");
    }
    const existingMemberships = parseRoleArray(
      existing.rows[0]?.member_of ?? []
    );
    const existingOptions = parseRoleArray(existing.rows[0]?.options ?? []);
    const existingPrivilegedOptions =
      privilegedRuntimeRoleOptions(existingOptions);
    if (
      existingPrivilegedOptions.length > 0 ||
      runtimeLoginIsDisabled(existingOptions) ||
      !runtimeRoleOptionsAreCanonical(existingOptions) ||
      existingMemberships.some(
        (role) =>
          role !== "archon_public_reader" &&
          role !== "archon_resolution_writer"
      )
    ) {
      throw new Error(
        "Existing runtime principal has unsafe role options or membership."
      );
    }
    if (!existingDatabaseUrl) {
      await sql.query(`CREATE USER ${appUser}`);
      userCreated = true;
      // CockroachDB's ALTER USER password grammar requires a SQL string
      // literal. The generated value never enters source, argv, or output.
      await sql.query(
        `ALTER USER ${appUser} WITH PASSWORD ${literal(password)}`
      );
    }
    await sql.query(`ALTER ROLE ${appUser} WITH NOBYPASSRLS`);
    await sql.query(
      `REVOKE CONNECT, TEMPORARY ON DATABASE ${database} FROM ${appUser}`
    );
    await sql.query(
      `REVOKE USAGE, CREATE ON SCHEMA public FROM ${appUser}`
    );
    await sql.query(
      `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${appUser}`
    );
    await sql.query(
      `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM ${appUser}`
    );
    await sql.query(`GRANT CONNECT ON DATABASE ${database} TO ${appUser}`);
    await sql.query(`GRANT USAGE ON SCHEMA public TO ${appUser}`);
    await sql.query(`GRANT ${readerRole} TO ${appUser}`);
    await sql.query(`GRANT ${resolutionRole} TO ${appUser}`);
    const reconciled = await sql.query<{
      username: string;
      options: string[] | string;
      member_of: string[] | string;
    }>(
      "SELECT username, options, member_of FROM [SHOW USERS] WHERE username = $1",
      [appUserRaw]
    );
    const reconciledRoles = parseRoleArray(
      reconciled.rows[0]?.member_of ?? []
    ).sort();
    const reconciledOptions = parseRoleArray(
      reconciled.rows[0]?.options ?? []
    ).map((option) => option.toUpperCase());
    if (
      reconciled.rows.length !== 1 ||
      JSON.stringify(reconciledRoles) !==
        JSON.stringify(
          ["archon_public_reader", "archon_resolution_writer"].sort()
        ) ||
      privilegedRuntimeRoleOptions(reconciledOptions).length > 0 ||
      runtimeLoginIsDisabled(reconciledOptions) ||
      !runtimeRoleOptionsAreCanonical(reconciledOptions)
    ) {
      throw new Error(
        "Runtime principal role/options reconciliation did not converge."
      );
    }
    const memberships = await sql.query<{
      role_name: string;
      member: string;
      is_admin: boolean;
    }>(
      `SELECT role_name, member, is_admin
         FROM [SHOW GRANTS ON ROLE
               archon_public_reader, archon_resolution_writer]
        WHERE member = $1`,
      [appUserRaw]
    );
    if (
      memberships.rows.length !== 2 ||
      memberships.rows.some((membership) => membership.is_admin)
    ) {
      throw new Error(
        "Runtime principal role grants must be exact and non-admin."
      );
    }
    await verifyClusterWideResolutionGrants({
      adminConnectionString: adminUrl,
      principal: appUserRaw,
      applicationDatabase: databaseRaw,
      expectedDatabaseGrants: expectedRuntimeDatabaseGrants(
        databaseRaw,
        appUserRaw
      ),
    });
    const systemGrants = await sql.query<SystemGrant>(
      `SHOW SYSTEM GRANTS FOR ${appUser}`
    );
    if (affirmativeSystemGrants(systemGrants.rows).length !== 0) {
      throw new Error(
        "Runtime principal retains affirmative system privileges."
      );
    }
  } catch {
    if (userCreated) {
      try {
        await sql.query(`REVOKE ${resolutionRole} FROM ${appUser}`);
        await sql.query(`REVOKE ${readerRole} FROM ${appUser}`);
        await sql.query(
          `REVOKE CONNECT, TEMPORARY ON DATABASE ${database} FROM ${appUser}`
        );
        await sql.query(`REVOKE USAGE, CREATE ON SCHEMA public FROM ${appUser}`);
        await sql.query(`DROP USER ${appUser}`);
      } catch {
        throw new Error(
          "CockroachDB provisioning failed and runtime-principal cleanup requires operator review."
        );
      }
    }
    throw new Error("CockroachDB runtime-principal provisioning failed (details redacted).");
  } finally {
    await sql.end().catch(() => undefined);
  }

  if (!existingDatabaseUrl) {
    parsed.username = appUserRaw;
    parsed.password = password;
    const runtimeDatabaseUrl = parsed.toString();
    assertCockroachEndpointBinding(runtimeDatabaseUrl, expectedSqlDns);
    const secretValue = JSON.stringify({
      DATABASE_URL: runtimeDatabaseUrl,
    });

    try {
      const created = await secrets.send(
        new CreateSecretCommand({
          Name: secretName,
          Description:
            "Least-privilege CockroachDB URL for the Archon Memory public recall and isolated resolution API.",
          SecretString: secretValue,
          Tags: [
            { Key: "project", Value: "archon-memory" },
            { Key: "environment", Value: environment },
            { Key: "managed-by", Value: "operator-script" },
            { Key: "data-classification", Value: "credential" },
          ],
        })
      );
      arn = created.ARN;
    } catch (error) {
      if (userCreated) {
        const cleanup = new Client({ connectionString: adminUrl });
        try {
          await cleanup.connect();
          await cleanup.query(`REVOKE ${resolutionRole} FROM ${appUser}`);
          await cleanup.query(`REVOKE ${readerRole} FROM ${appUser}`);
          await cleanup.query(
            `REVOKE CONNECT, TEMPORARY ON DATABASE ${database} FROM ${appUser}`
          );
          await cleanup.query(
            `REVOKE USAGE, CREATE ON SCHEMA public FROM ${appUser}`
          );
          await cleanup.query(`DROP USER ${appUser}`);
        } catch {
          throw new Error(
            "AWS secret creation failed and runtime-principal cleanup requires operator review."
          );
        } finally {
          await cleanup.end().catch(() => undefined);
        }
      }
      throw new Error("AWS Secrets Manager create failed (details redacted).");
    }
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        database: databaseRaw,
        appUser: appUserRaw,
        environment,
        mode: existingDatabaseUrl
          ? "membership-reconciled"
          : "principal-and-secret-created",
        inheritedRoles: [
          "archon_public_reader",
          "archon_resolution_writer",
        ],
        permissions: [
          "CONNECT",
          "USAGE public",
          "RLS-scoped SELECT agent_memory",
          "SELECT fixed-scope C-SPANN recall views",
          "RLS-scoped SELECT on the five fixed synthetic resolution tables",
          "EXECUTE exact create-session and decide transition functions",
          "zero direct INSERT/UPDATE/DELETE",
          "no canonical-memory writes",
        ],
        secretArn: arn,
        region,
        secretMaterialPrinted: false,
        rotation: existingDatabaseUrl
          ? "existing credentials preserved; rotations require the explicit two-phase workflow"
          : "initial principal created; rotations require the explicit two-phase workflow",
      },
      null,
      2
    )}\n`
  );
}

function parseRoleArray(value: string[] | string): string[] {
  if (Array.isArray(value)) return value;
  return value
    .replace(/[{}"]/gu, "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
