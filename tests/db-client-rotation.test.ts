import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createCredentialPoolController,
  databaseSecretRefreshMs,
  resolveDatabaseCredential,
  type DatabaseCredential,
} from "../src/db/client.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const clientSource = readFileSync(join(root, "src", "db", "client.ts"), "utf8");
const applicationTemplate = readFileSync(
  join(root, "aws", "template.yaml"),
  "utf8"
);
const foundationTemplate = readFileSync(
  join(root, "aws", "bootstrap-oidc.yaml"),
  "utf8"
);

test("database secret refresh cadence is bounded and fail-closed", () => {
  assert.equal(databaseSecretRefreshMs(undefined), 30_000);
  assert.equal(databaseSecretRefreshMs("15"), 15_000);
  assert.equal(databaseSecretRefreshMs("300"), 300_000);
  for (const invalid of ["", "14", "301", "30.5", "NaN", "1e2"]) {
    if (invalid === "") {
      assert.equal(databaseSecretRefreshMs(invalid), 30_000);
    } else {
      assert.throws(
        () => databaseSecretRefreshMs(invalid),
        /integer from 15 through 300/u
      );
    }
  }
});

test("runtime fetches only AWSCURRENT and validates version metadata", () => {
  assert.match(
    clientSource,
    /new GetSecretValueCommand\(\{[\s\S]*?SecretId: secretId,[\s\S]*?VersionStage: "AWSCURRENT"/u
  );
  assert.match(
    clientSource,
    /secret\.VersionStages\?\.includes\("AWSCURRENT"\)/u
  );
  assert.match(clientSource, /\^\[A-Za-z0-9_-\]\{32,64\}\$/u);
  assert.doesNotMatch(clientSource, /console\.(?:log|info|debug).*credential/iu);
  assert.match(clientSource, /assertCockroachEndpointBinding/u);
  assert.match(clientSource, /COCKROACH_SQL_DNS/u);
  assert.match(clientSource, /\^archon_\$\{environment\}_\[a-z0-9\]\{6,40\}\$/u);
});

test("changed credentials are probed before the atomic pool swap", () => {
  const probe = clientSource.indexOf("await dependencies.proveCandidate");
  const swap = clientSource.indexOf("currentPool = candidate;");
  const retire = clientSource.indexOf("void previous.end()");
  assert.ok(probe > 0, "candidate credential probe is missing");
  assert.ok(swap > probe, "pool swaps before candidate authentication");
  assert.ok(retire > swap, "old pool retires before the atomic swap");
  assert.match(
    clientSource,
    /credential\.version === credentialVersion/u
  );
  assert.match(
    clientSource,
    /refreshPromise = refresh\(\)[\s\S]*?\.finally/u
  );
  assert.match(clientSource, /current_database\(\)/u);
  assert.match(clientSource, /archon_public_memory_recall/u);
  assert.match(clientSource, /visible_memories[\s\S]*?!== 9/u);
});

test("a failed refresh preserves only the last proven pool and retries quickly", () => {
  assert.match(clientSource, /const provenFallback = currentPool/u);
  assert.match(
    clientSource,
    /refresh\(\)[\s\S]*?provenFallback && currentPool === provenFallback[\s\S]*?nextCredentialCheckAt = dependencies\.now\(\) \+ 15_000[\s\S]*?return provenFallback/u
  );
  assert.match(
    clientSource,
    /Keep the last authenticated pool[\s\S]*?retry on the shortest allowed cadence/u
  );
});

test("fake Secrets Manager response is endpoint-, stage-, and identity-bound", async () => {
  const calls: Array<{ region: string | undefined; secretId: string }> = [];
  const environment = {
    APP_ENV: "staging",
    AWS_REGION: "eu-west-1",
    COCKROACH_SQL_DNS: "cluster.example.com",
    DATABASE_SECRET_ID: "archon-memory/staging/database",
  };
  const credential = await resolveDatabaseCredential({
    environment,
    readSecret: async (secretId, region) => {
      calls.push({ region, secretId });
      return {
        SecretString: JSON.stringify({
          DATABASE_URL:
            "postgresql://archon_staging_abcdef:opaque@cluster.example.com:26257/archon?sslmode=verify-full",
        }),
        VersionId: "a".repeat(32),
        VersionStages: ["AWSCURRENT"],
      };
    },
  });
  assert.deepEqual(calls, [
    {
      region: "eu-west-1",
      secretId: "archon-memory/staging/database",
    },
  ]);
  assert.equal(credential.expectedPrincipal, "archon_staging_abcdef");
  assert.equal(credential.source, "secrets-manager");
  assert.equal(credential.version, "a".repeat(32));

  await assert.rejects(
    resolveDatabaseCredential({
      environment,
      readSecret: async () => ({
        SecretString:
          "postgresql://archon_staging_abcdef:opaque@cluster.example.com:26257/archon?sslmode=verify-full",
        VersionId: "b".repeat(32),
        VersionStages: ["AWSPENDING"],
      }),
    }),
    /canonical AWSCURRENT/u
  );
});

test("concurrent fake-pg refresh coalesces, swaps atomically, and retires once", async () => {
  class FakePool {
    ended = 0;
    constructor(readonly connectionString: string) {}
    async end(): Promise<void> {
      this.ended += 1;
    }
  }

  let now = 0;
  let resolutionCount = 0;
  let releaseFirst!: () => void;
  const firstResolution = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let credential: DatabaseCredential = {
    connectionString: "pool-v1",
    expectedPrincipal: "archon_staging_first1",
    source: "secrets-manager",
    version: "1".repeat(32),
  };
  const pools: FakePool[] = [];
  const controller = createCredentialPoolController<FakePool>({
    createPool: (connectionString) => {
      const value = new FakePool(connectionString);
      pools.push(value);
      return value;
    },
    now: () => now,
    proveCandidate: async () => undefined,
    refreshMs: () => 30_000,
    resolveCredential: async () => {
      resolutionCount += 1;
      if (resolutionCount === 1) await firstResolution;
      return credential;
    },
  });

  const first = controller.get();
  const concurrent = controller.get();
  releaseFirst();
  const [firstPool, concurrentPool] = await Promise.all([first, concurrent]);
  assert.equal(firstPool, concurrentPool);
  assert.equal(resolutionCount, 1);
  assert.equal(pools.length, 1);

  now = 30_001;
  credential = {
    ...credential,
    connectionString: "pool-v2",
    version: "2".repeat(32),
  };
  const secondPool = await controller.get();
  assert.notEqual(secondPool, firstPool);
  assert.equal(controller.current(), secondPool);
  assert.equal(firstPool.ended, 1);
  assert.equal(secondPool.ended, 0);
  await controller.close();
  assert.equal(secondPool.ended, 1);
});

test("failed fake-pg candidate never replaces the last proven pool", async () => {
  class FakePool {
    ended = 0;
    constructor(readonly connectionString: string) {}
    async end(): Promise<void> {
      this.ended += 1;
    }
  }

  let now = 0;
  let failProbe = false;
  let resolutions = 0;
  let credential: DatabaseCredential = {
    connectionString: "proven",
    source: "secrets-manager",
    version: "a".repeat(32),
  };
  const pools: FakePool[] = [];
  const controller = createCredentialPoolController<FakePool>({
    createPool: (connectionString) => {
      const value = new FakePool(connectionString);
      pools.push(value);
      return value;
    },
    now: () => now,
    proveCandidate: async () => {
      if (failProbe) throw new Error("injected candidate failure");
    },
    refreshMs: () => 30_000,
    resolveCredential: async () => {
      resolutions += 1;
      return credential;
    },
  });

  const proven = await controller.get();
  now = 30_001;
  failProbe = true;
  credential = {
    ...credential,
    connectionString: "rejected",
    version: "b".repeat(32),
  };
  assert.equal(await controller.get(), proven);
  assert.equal(controller.current(), proven);
  assert.equal(proven.ended, 0);
  assert.equal(pools.at(-1)?.ended, 1);
  assert.equal(resolutions, 2);

  now += 14_999;
  assert.equal(await controller.get(), proven);
  assert.equal(resolutions, 2);
  now += 1;
  failProbe = false;
  const recovered = await controller.get();
  assert.notEqual(recovered, proven);
  assert.equal(resolutions, 3);
  assert.equal(proven.ended, 1);
  await controller.close();
});

test("Lambda and both runtime roles carry the rotation-read contract", () => {
  assert.match(
    applicationTemplate,
    /DATABASE_SECRET_REFRESH_SECONDS: "30"/u
  );
  assert.match(applicationTemplate, /APP_ENV: !Ref Environment/u);
  assert.match(applicationTemplate, /COCKROACH_SQL_DNS: !Ref CockroachSqlDns/u);
  assert.match(applicationTemplate, /CockroachSqlDns:[\s\S]*?AllowedPattern:/u);
  assert.match(applicationTemplate, /PGPOOL_MAX_LIFETIME_SECONDS: "300"/u);
  assert.equal(
    (
      foundationTemplate.match(
        /ReadOnly(?:Staging|Production)DatabaseSecret[\s\S]*?secretsmanager:DescribeSecret[\s\S]*?secretsmanager:GetSecretValue/gu
      ) ?? []
    ).length,
    2
  );
});
