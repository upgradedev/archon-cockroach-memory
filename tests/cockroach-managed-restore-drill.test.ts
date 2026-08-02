import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(
  new URL(
    "../.github/workflows/cockroach-restore-drill.yml",
    import.meta.url
  ),
  "utf8"
);
const implementation = readFileSync(
  new URL(
    "../scripts/cockroach-managed-restore-drill.ts",
    import.meta.url
  ),
  "utf8"
);
const runbook = readFileSync(
  new URL("../docs/runbooks/database-restore.md", import.meta.url),
  "utf8"
);

test("managed restore drill is manual, exact-main, and protected", () => {
  assert.match(workflow, /workflow_dispatch:/u);
  assert.doesNotMatch(workflow, /\b(?:push|schedule|pull_request):/u);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/u);
  assert.match(workflow, /test "\$GITHUB_SHA" = "\$TARGET_SHA"/u);
  assert.match(workflow, /environment:\s*\n\s*name: operations-drill/u);
  assert.match(workflow, /environment:\s*\n\s*name: production-db/u);
  assert.match(
    workflow,
    /OPERATIONS_AUTHORIZATION_SHA256: \$\{\{ needs\.authorize\.outputs\.authorization_sha256 \}\}/u
  );
  assert.match(
    implementation,
    /protectedEnvironments: \["operations-drill", "production-db"\]/u
  );
  assert.match(
    implementation,
    /operationsAuthorizationSha256:\s*state\.operationsAuthorizationSha256/u
  );
  assert.match(
    implementation,
    /schema: "archon\.cockroach\.managed-backup-restore-drill",\s*\n\s*version: 2/u
  );
  assert.equal(
    (
      workflow.match(
        /schema: "archon\.operations-drill\.authorization"/gu
      ) ?? []
    ).length,
    2
  );
  assert.match(
    workflow,
    /test "\$OPERATIONS_AUTHORIZATION_SHA256" = \\\s*\n\s*"\$expected_authorization_sha256"/u
  );
  assert.match(workflow, /persist-credentials: false/u);
  assert.match(
    workflow,
    /RESTORE \$DESTINATION_CLUSTER_ID FROM \$BACKUP_ID/u
  );
  assert.match(workflow, /cancel-in-progress: false/u);
});

test("managed restore drill has one bounded mutation and no lifecycle mutation", () => {
  assert.match(
    implementation,
    /"GET" \| "POST"/u
  );
  assert.match(
    implementation,
    /source_cluster_id: state\.sourceClusterId,[\s\S]*?backup_id: state\.backupId,[\s\S]*?type: "CLUSTER"/u
  );
  assert.match(
    implementation,
    /\/api\/v1\/clusters\/\$\{encodeURIComponent\([\s\S]*?\)\}\/restores/u
  );
  assert.match(implementation, /BOUNDED_POLL_TIMEOUT/u);
  assert.match(implementation, /\[30, 60, 90\]/u);
  assert.match(
    implementation,
    /const maxAttempts = method === "GET" \? API_MAX_ATTEMPTS : 1/u
  );
  assert.match(implementation, /RESTORE_POST_OUTCOME_UNKNOWN/u);
  assert.match(implementation, /backup_end_time\?: string/u);
  assert.match(
    implementation,
    /record\.backup_end_time === undefined \|\|/u
  );
  assert.match(
    implementation,
    /record\.source_cluster_name === undefined \|\|/u
  );
  assert.doesNotMatch(implementation, /SUCCESS_WITHOUT_COMPLETION_TIME/u);
  assert.doesNotMatch(
    implementation,
    /cloudApiJson\([\s\S]{0,220}?"(?:DELETE|PATCH)"/u
  );
  assert.doesNotMatch(workflow, /\b(?:delete-cluster|create-cluster)\b/iu);
  assert.doesNotMatch(
    implementation,
    /cloudApiJson\([\s\S]{0,220}?"(?:DELETE|PATCH|PUT)"/u
  );
});

test("preflight fails closed on placement, identity, history, and empty target", () => {
  for (const fragment of [
    'const EXPECTED_PROVIDER = "AWS"',
    'const EXPECTED_PLAN = "BASIC"',
    'const EXPECTED_REGION = "eu-west-1"',
    "SOURCE_EQUALS_DESTINATION",
    "ORGANIZATION_BOUNDARY_UNPROVED",
    "DESTINATION_HAS_RESTORE_HISTORY",
    "USER_DATABASE_EXISTS",
    "USER_SCHEMA_OR_RELATION_EXISTS",
    "SOURCE_AND_DESTINATION_SQL_CLUSTER_COLLISION",
  ]) {
    assert.ok(implementation.includes(fragment), fragment);
  }
  assert.match(
    implementation,
    /`INVALID_\$\{label\.toUpperCase\(\)\}_ENDPOINT`/u
  );
  assert.match(
    implementation,
    /const emptyEndpoint = assertSqlEndpoint\([\s\S]*?new Set\(\["defaultdb", "postgres"\]\),\s+"DESTINATION_EMPTY"\s+\);/u
  );
  assert.match(implementation, /cluster\.regions\[0\]\?\.sql_dns/u);
  assert.match(
    implementation,
    /regions\[0\]\?\.primary !== true/u
  );
  assert.match(
    implementation,
    /canonicalJson\(queryKeys\) !== canonicalJson\(expectedQueryKeys\)/u
  );
  assert.match(implementation, /const expectedQueryKeys = \["sslmode"\]/u);
  assert.ok(implementation.includes('.replace(/\\.$/u, "")'));
  assert.match(implementation, /!url\.password/u);
  assert.match(implementation, /crdb_internal\.cluster_id/u);
  assert.match(implementation, /Cc-Version/u);
  assert.match(workflow, /COCKROACH_API_VERSION: "2024-09-16"/u);
});

test("post-restore proof covers schema, grants, roles, RLS, C-SPANN, and canonical memory", () => {
  for (const fragment of [
    "SHOW CREATE TABLE",
    "SHOW GRANTS ON TABLE *",
    "SHOW GRANTS ON SCHEMA public",
    "SHOW GRANTS ON DATABASE",
    "SHOW SYSTEM GRANTS FOR",
    "pg_catalog.pg_auth_members",
    "pg_catalog.pg_policies",
    "relforcerowsecurity",
    "isExpectedVectorIndexDefinition",
    "isExpectedKindVectorIndexDefinition",
    "PUBLIC_DEMO_CANONICAL_KEYS",
    "canonicalSha256",
    "RESTORED_EVIDENCE_MISMATCH",
    "DESTINATION_SQL_IDENTITY_CHANGED",
  ]) {
    assert.ok(implementation.includes(fragment), fragment);
  }
});

test("receipt and documentation are honest about RTO, RPO, PITR, and side effects", () => {
  for (const fragment of [
    'pointInTimeRestore: false',
    'cutoverPerformed: false',
    'deletionPerformed: false',
    'provisioningPerformed: false',
    "defaultWorstCaseRpoMinutes",
    "RTO is unknown until this protected live drill completes successfully.",
  ]) {
    assert.ok(implementation.includes(fragment), fragment);
  }
  assert.match(workflow, /actions\/attest-build-provenance@0f67c3f/u);
  assert.match(
    workflow,
    /tsx scripts\/cockroach-managed-restore-drill\.ts \\\s*\n\s*>"\$RECEIPT_PATH"/u
  );
  assert.doesNotMatch(implementation, /writeFileSync|RECEIPT_PATH/u);
  assert.match(implementation, /process\.stdout\.write/u);
  assert.match(workflow, /actions\/upload-artifact@043fb46/u);
  assert.match(workflow, /if-no-files-found: error/u);
  assert.match(runbook, /not PITR/iu);
  assert.match(runbook, /24 hours/iu);
  assert.match(runbook, /30 days/iu);
  assert.match(runbook, /no cutover/iu);
});
