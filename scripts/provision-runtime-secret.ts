// One-time/rotation operator task: create a least-privilege CockroachDB runtime
// principal and place only its connection URL in AWS Secrets Manager.
//
// Required:
//   DATABASE_URL=<admin/operator CockroachDB URL>
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
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

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
  const adminUrl = required("DATABASE_URL");
  const environment = process.env.APP_ENV?.trim() || "production";
  if (!/^(staging|production)$/u.test(environment)) {
    throw new Error("APP_ENV must be staging or production.");
  }
  const rotationId = randomBytes(5).toString("hex");
  const appName = process.env.APP_NAME?.trim() || "archon-memory";
  if (!/^[a-z][a-z0-9-]{2,24}$/u.test(appName)) {
    throw new Error("APP_NAME has an invalid format.");
  }
  const appUserRaw =
    process.env.APP_DB_USER?.trim() || `archon_${environment}_${rotationId}`;
  if (
    !new RegExp(`^archon_${environment}_[a-z0-9]{6,40}$`, "u").test(
      appUserRaw
    )
  ) {
    throw new Error(
      `APP_DB_USER must be a dedicated archon_${environment}_<rotation-id> login.`
    );
  }
  const appUser = identifier(appUserRaw, "APP_DB_USER");
  const readerRole = identifier("archon_public_reader", "reader role");
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

  try {
    await secrets.send(new DescribeSecretCommand({ SecretId: secretName }));
    throw new Error(
      "Runtime secret already exists; use an explicit two-phase rotation workflow."
    );
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "ResourceNotFoundException") {
      throw error;
    }
  }

  const sql = new Client({ connectionString: adminUrl });
  let userCreated = false;
  try {
    await sql.connect();
    const existing = await sql.query<{ username: string }>(
      "SELECT username FROM [SHOW USERS] WHERE username = $1",
      [appUserRaw]
    );
    if (existing.rowCount) {
      throw new Error("The requested runtime principal already exists.");
    }
    await sql.query(`CREATE USER ${appUser}`);
    userCreated = true;
    // CockroachDB's ALTER USER password grammar requires a SQL string literal.
    // The value is generated in memory and never enters source, argv, or output.
    await sql.query(`ALTER USER ${appUser} WITH PASSWORD ${literal(password)}`);
    await sql.query(`ALTER ROLE ${appUser} WITH NOBYPASSRLS`);
    await sql.query(`GRANT CONNECT ON DATABASE ${database} TO ${appUser}`);
    await sql.query(`GRANT USAGE ON SCHEMA public TO ${appUser}`);
    await sql.query(`GRANT ${readerRole} TO ${appUser}`);
  } catch {
    if (userCreated) {
      try {
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

  parsed.username = appUserRaw;
  parsed.password = password;
  const secretValue = JSON.stringify({ DATABASE_URL: parsed.toString() });

  let arn: string | undefined;
  try {
    const created = await secrets.send(
      new CreateSecretCommand({
        Name: secretName,
        Description:
          "Least-privilege CockroachDB URL for the Archon Memory read-only public API.",
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

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        database: databaseRaw,
        appUser: appUserRaw,
        environment,
        inheritedRole: "archon_public_reader",
        permissions: [
          "CONNECT",
          "USAGE public",
          "RLS-scoped SELECT agent_memory",
        ],
        secretArn: arn,
        region,
        secretMaterialPrinted: false,
        rotation:
          "initial principal created; rotations require the explicit two-phase workflow",
      },
      null,
      2
    )}\n`
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
