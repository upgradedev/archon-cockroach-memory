import { createHash } from "node:crypto";
import pg from "pg";

const { Client } = pg;

export const RESOLUTION_WRITER_ROLE = "archon_resolution_writer";

export const RESOLUTION_ROUTINE_SIGNATURES = [
  "archon_resolution_create_session(text, uuid, uuid, uuid, uuid, timestamptz, int8)",
  "archon_resolution_decide(text, text, uuid, uuid, uuid, timestamptz)",
] as const;

export interface ClusterGrantRow {
  database_name: string | null;
  schema_name: string | null;
  object_name: string | null;
  object_type: string;
  grantee: string;
  privilege_type: string;
  is_grantable: boolean;
}

export interface ExactDatabaseGrant {
  databaseName: string;
  grantee: string;
  privilegeType: string;
  isGrantable: boolean;
}

export interface ClusterGrantProof {
  routineGrantCount: 2;
  databaseGrantCount: number;
  databaseInventory: readonly string[];
  databaseGrantMatrix: readonly ExactDatabaseGrant[];
  databaseMatrixSha256: string;
}

const COCKROACH_BUILTIN_PUBLIC_DATABASE_GRANTS = [
  {
    databaseName: "defaultdb",
    grantee: "public",
    privilegeType: "CONNECT",
    isGrantable: false,
  },
  {
    databaseName: "defaultdb",
    grantee: "public",
    privilegeType: "TEMPORARY",
    isGrantable: false,
  },
  {
    databaseName: "postgres",
    grantee: "public",
    privilegeType: "CONNECT",
    isGrantable: false,
  },
  {
    databaseName: "postgres",
    grantee: "public",
    privilegeType: "TEMPORARY",
    isGrantable: false,
  },
] as const satisfies readonly ExactDatabaseGrant[];

export function expectedRuntimeDatabaseGrants(
  applicationDatabase: string,
  principal: string
): readonly ExactDatabaseGrant[] {
  if (
    applicationDatabase.length === 0 ||
    principal.length === 0 ||
    applicationDatabase === "system" ||
    principal.toLowerCase() === "public" ||
    COCKROACH_BUILTIN_PUBLIC_DATABASE_GRANTS.some(
      (grant) => grant.databaseName === applicationDatabase
    )
  ) {
    throw new Error(
      "The runtime database matrix requires non-empty, distinct application and principal identities."
    );
  }
  return [
    ...COCKROACH_BUILTIN_PUBLIC_DATABASE_GRANTS,
    {
      databaseName: applicationDatabase,
      grantee: principal,
      privilegeType: "CONNECT",
      isGrantable: false,
    },
  ];
}

function exactDatabaseGrantKey(grant: ExactDatabaseGrant): string {
  return JSON.stringify([
    grant.databaseName,
    grant.grantee,
    grant.privilegeType,
    grant.isGrantable,
  ]);
}

function quoteIdentifier(value: string, label: string): string {
  if (value.length === 0 || value.includes("\0")) {
    throw new Error(`${label} is not a valid SQL identifier.`);
  }
  return `"${value.replaceAll('"', '""')}"`;
}

function routineGrantKey(row: ClusterGrantRow): string {
  return JSON.stringify([
    row.database_name,
    row.schema_name,
    row.object_name,
    row.object_type,
    row.grantee,
    row.privilege_type,
    row.is_grantable,
  ]);
}

function databaseGrantKey(row: ClusterGrantRow): string {
  return JSON.stringify([
    row.database_name,
    row.schema_name,
    row.object_name,
    row.object_type,
    row.grantee,
    row.privilege_type,
    row.is_grantable,
  ]);
}

export function validateClusterWideResolutionGrants(
  rows: readonly ClusterGrantRow[],
  applicationDatabase: string,
  expectedDatabaseGrants?: readonly ExactDatabaseGrant[],
  databaseInventory: readonly string[] = []
): ClusterGrantProof {
  const routineRows = rows.filter((row) => row.object_type === "routine");
  const expectedRoutineKeys = new Set(
    RESOLUTION_ROUTINE_SIGNATURES.map((signature) =>
      routineGrantKey({
        database_name: applicationDatabase,
        schema_name: "public",
        object_name: signature,
        object_type: "routine",
        grantee: RESOLUTION_WRITER_ROLE,
        privilege_type: "EXECUTE",
        is_grantable: false,
      })
    )
  );
  const actualRoutineKeys = new Set(routineRows.map(routineGrantKey));
  if (
    routineRows.length !== expectedRoutineKeys.size ||
    actualRoutineKeys.size !== expectedRoutineKeys.size ||
    [...expectedRoutineKeys].some((key) => !actualRoutineKeys.has(key))
  ) {
    throw new Error(
      "Cluster-wide routine privileges exceed the exact two-routine transition API."
    );
  }

  const databaseRows = rows.filter((row) => row.object_type === "database");
  if (
    databaseRows.some(
      (row) =>
        row.database_name === null ||
        row.schema_name !== null ||
        row.object_name !== null
    )
  ) {
    throw new Error("Cluster-wide database privilege rows are malformed.");
  }
  if (expectedDatabaseGrants !== undefined) {
    const requiredDatabaseInventory = [
      "defaultdb",
      "postgres",
      "system",
      applicationDatabase,
    ].sort();
    const actualDatabaseInventory = [...databaseInventory].sort();
    if (
      databaseInventory.length === 0 ||
      new Set(databaseInventory).size !== databaseInventory.length ||
      databaseInventory.some((name) => name.length === 0) ||
      JSON.stringify(actualDatabaseInventory) !==
        JSON.stringify(requiredDatabaseInventory) ||
      databaseRows.some(
        (row) =>
          row.database_name === null ||
          !databaseInventory.includes(row.database_name)
      )
    ) {
      throw new Error(
        "Cluster-wide grant proof could not bind the exact database inventory."
      );
    }
    const expectedDatabaseKeys = new Set(
      expectedDatabaseGrants.map((grant) =>
        databaseGrantKey({
          database_name: grant.databaseName,
          schema_name: null,
          object_name: null,
          object_type: "database",
          grantee: grant.grantee,
          privilege_type: grant.privilegeType,
          is_grantable: grant.isGrantable,
        })
      )
    );
    if (
      expectedDatabaseGrants.length === 0 ||
      expectedDatabaseKeys.size !== expectedDatabaseGrants.length
    ) {
      throw new Error(
        "Expected cluster-wide database privilege matrix is not canonical."
      );
    }
    const actualDatabaseKeys = new Set(databaseRows.map(databaseGrantKey));
    if (
      databaseRows.length !== expectedDatabaseKeys.size ||
      actualDatabaseKeys.size !== expectedDatabaseKeys.size ||
      [...expectedDatabaseKeys].some((key) => !actualDatabaseKeys.has(key))
    ) {
      throw new Error(
        "Cluster-wide database privileges do not match the exact principal matrix."
      );
    }
  }

  const databaseGrantMatrix = databaseRows
    .map((row) => ({
      databaseName: row.database_name!,
      grantee: row.grantee,
      privilegeType: row.privilege_type,
      isGrantable: row.is_grantable,
    }))
    .sort((left, right) => {
      const leftKey = exactDatabaseGrantKey(left);
      const rightKey = exactDatabaseGrantKey(right);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
  return {
    routineGrantCount: 2,
    databaseGrantCount: databaseRows.length,
    databaseInventory: [...databaseInventory],
    databaseGrantMatrix,
    databaseMatrixSha256: createHash("sha256")
      .update(
        JSON.stringify(databaseGrantMatrix),
        "utf8"
      )
      .digest("hex"),
  };
}

async function enumerateDatabases(
  proofClient: InstanceType<typeof Client>
): Promise<string[]> {
  const databases = await proofClient.query<{
    database_name: string;
  }>(
    `SELECT database_name
       FROM [SHOW DATABASES]
      ORDER BY database_name`
  );
  const databaseNames = databases.rows.map((row) => row.database_name);
  if (
    databaseNames.length === 0 ||
    new Set(databaseNames).size !== databaseNames.length ||
    databaseNames.some(
      (name) => typeof name !== "string" || name.length === 0
    )
  ) {
    throw new Error(
      "Cluster-wide grant proof could not enumerate exact database identities."
    );
  }
  return databaseNames;
}

export async function verifyClusterWideResolutionGrants(input: {
  adminConnectionString: string;
  principal: string;
  applicationDatabase: string;
  expectedDatabaseGrants?: readonly ExactDatabaseGrant[];
}): Promise<ClusterGrantProof> {
  const principalSql = quoteIdentifier(input.principal, "grant principal");
  if (input.expectedDatabaseGrants !== undefined) {
    const canonicalDatabaseGrants = expectedRuntimeDatabaseGrants(
      input.applicationDatabase,
      input.principal
    );
    const canonicalKeys = canonicalDatabaseGrants
      .map(exactDatabaseGrantKey)
      .sort();
    const suppliedKeys = input.expectedDatabaseGrants
      .map(exactDatabaseGrantKey)
      .sort();
    if (
      JSON.stringify(suppliedKeys) !== JSON.stringify(canonicalKeys)
    ) {
      throw new Error(
        "Supplied runtime database privilege matrix is not canonical."
      );
    }
  }
  // This connection is deliberately not borrowed from a pool. CockroachDB's
  // anonymous-database mode makes targetless SHOW GRANTS cluster-wide, so the
  // session must be destroyed rather than returned with mutated state.
  const proofClient = new Client({
    connectionString: input.adminConnectionString,
    application_name: "archon.cluster-wide-grant-proof",
    connectionTimeoutMillis: 10_000,
    query_timeout: 30_000,
  });
  try {
    await proofClient.connect();
    await proofClient.query("SET database = ''");
    const database = await proofClient.query<{
      database_name: string | null;
    }>("SELECT current_database() AS database_name");
    // CockroachDB v26.2 returns SQL NULL when SessionData.Database is empty;
    // node-postgres preserves that value as JavaScript null.
    if (
      database.rows.length !== 1 ||
      database.rows[0]?.database_name !== null
    ) {
      throw new Error(
        "Cluster-wide grant proof did not enter the anonymous database."
      );
    }
    const routineGrants = await proofClient.query<ClusterGrantRow>(
      `SELECT database_name, schema_name, object_name, object_type, grantee,
              privilege_type, is_grantable
         FROM [SHOW GRANTS FOR ${principalSql}]
        WHERE object_type = 'routine'
        ORDER BY database_name, schema_name, object_name, object_type,
                 grantee, privilege_type, is_grantable`
    );

    const databaseGrants: ClusterGrantRow[] = [];
    let databaseInventory: readonly string[] = [];
    if (input.expectedDatabaseGrants !== undefined) {
      const databaseNames = await enumerateDatabases(proofClient);
      databaseInventory = databaseNames;
      for (const databaseName of databaseNames) {
        const databaseSql = quoteIdentifier(
          databaseName,
          "enumerated database"
        );
        const grants = await proofClient.query<{
          database_name: string;
          grantee: string;
          privilege_type: string;
          is_grantable: boolean;
        }>(`SHOW GRANTS ON DATABASE ${databaseSql} FOR ${principalSql}`);
        if (
          grants.rows.some(
            (grant) => grant.database_name !== databaseName
          )
        ) {
          throw new Error(
            "Targeted database grant proof returned a mismatched database identity."
          );
        }
        databaseGrants.push(
          ...grants.rows.map((grant) => ({
            database_name: grant.database_name,
            schema_name: null,
            object_name: null,
            object_type: "database",
            grantee: grant.grantee,
            privilege_type: grant.privilege_type,
            is_grantable: grant.is_grantable,
          }))
        );
      }
      const finalDatabaseInventory = await enumerateDatabases(proofClient);
      if (
        JSON.stringify(finalDatabaseInventory) !==
        JSON.stringify(databaseNames)
      ) {
        throw new Error(
          "Database inventory changed during the cluster-wide grant proof."
        );
      }
    }
    return validateClusterWideResolutionGrants(
      [...routineGrants.rows, ...databaseGrants],
      input.applicationDatabase,
      input.expectedDatabaseGrants,
      databaseInventory
    );
  } finally {
    await proofClient.end().catch(() => undefined);
  }
}
