import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  recoverFailedRotation,
  redactedDigest,
  rotationConfirmation,
  type RotationRecoveryActions,
  type RotationRecoveryState,
} from "../scripts/rotate-runtime-secret.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");
const workflow = read(".github/workflows/database-credential-rotation.yml");
const script = read("scripts/rotate-runtime-secret.ts");
const provision = read("scripts/provision-runtime-secret.ts");
const clusterGrantProof = read("src/db/cluster-grant-proof.ts");
const systemGrantContract = read("src/db/system-grants.ts");
const foundation = read("aws/bootstrap-oidc.yaml");
const runbook = read("docs/runbooks/credential-compromise.md");
const wellArchitectedAudit = read(
  ".github/scripts/well-architected-contract-audit.mjs"
);

test("rotation confirmation and receipt identifiers are deterministic", () => {
  assert.equal(
    rotationConfirmation("staging"),
    "ROTATE-STAGING-RUNTIME-CREDENTIAL"
  );
  assert.equal(
    rotationConfirmation("production"),
    "ROTATE-PRODUCTION-RUNTIME-CREDENTIAL"
  );
  assert.throws(() => rotationConfirmation("preview"), /staging or production/u);
  assert.match(redactedDigest("opaque-identifier"), /^[a-f0-9]{64}$/u);
  assert.notEqual(redactedDigest("one"), redactedDigest("two"));
});

test("rotation workflow is manual, protected, bounded, and exact-release bound", () => {
  const trigger = workflow.slice(
    workflow.indexOf("on:"),
    workflow.indexOf("concurrency:")
  );
  assert.match(trigger, /^\s+workflow_dispatch:/mu);
  assert.doesNotMatch(
    trigger,
    /^\s+(?:push|pull_request|schedule|workflow_call):/mu
  );
  assert.match(workflow, /environment:\s+production-db/u);
  assert.match(workflow, /group:\s+cockroach-production-database/u);
  assert.match(workflow, /ROTATE-STAGING-RUNTIME-CREDENTIAL/u);
  assert.match(workflow, /ROTATE-PRODUCTION-RUNTIME-CREDENTIAL/u);
  assert.match(workflow, /test "\$PROPAGATION_TIMEOUT_SECONDS" -ge 90/u);
  assert.match(workflow, /test "\$PROPAGATION_TIMEOUT_SECONDS" -le 600/u);
  assert.match(workflow, /test "\$DRAIN_GRACE_SECONDS" -ge 30/u);
  assert.match(workflow, /test "\$DRAIN_GRACE_SECONDS" -le 180/u);
  assert.match(workflow, /timeout-minutes:\s+40/u);
  assert.match(workflow, /role-duration-seconds:\s+2400/u);
  assert.match(workflow, /test "\$GITHUB_SHA" = "\$TARGET_SHA"/u);
  assert.match(
    workflow,
    /test "\$\(git rev-parse origin\/main\)" = "\$TARGET_SHA"/u
  );
  assert.match(workflow, /prove_workflow ci\.yml CI/u);
  assert.match(workflow, /prove_workflow codeql\.yml CodeQL/u);
  assert.match(workflow, /supply-chain\.yml "Supply Chain \(enforced\)"/u);
  assert.match(workflow, /deploy-aws\.yml "Deploy AWS"/u);
  const endpointStep = workflow.match(
    /- name: Prove account and Cockroach Cloud endpoint binding[\s\S]*?(?=\n      - name:)/u
  )?.[0];
  assert.ok(endpointStep);
  assert.match(endpointStep, /CCLOUD_API_KEY:\s*\$\{\{ secrets\.CCLOUD_API_KEY \}\}/u);
  assert.match(endpointStep, /length <= 253/u);
  assert.match(endpointStep, /\[a-z\]\{2,63\}/u);
  assert.doesNotMatch(
    workflow.match(/jobs:[\s\S]*?steps:/u)?.[0] ?? "",
    /CCLOUD_API_KEY/u
  );
});

test("rotation authority is short-lived and scoped to exact runtime secrets", () => {
  assert.match(workflow, /id-token:\s+write/u);
  assert.match(workflow, /allowed-account-ids:/u);
  assert.match(workflow, /inline-session-policy:\s*>-/u);
  assert.match(workflow, /ReadExactAdminCredential/u);
  assert.match(workflow, /RotateOnlySelectedRuntimeCredential/u);
  assert.match(
    workflow,
    /\$\{\{ env\.APP_NAME \}\}\/\$\{\{ env\.TARGET_ENVIRONMENT \}\}\/database-/u
  );
  const sessionPolicy = workflow.match(
    /inline-session-policy:\s*>-\s*\r?\n\s+(\{[^\r\n]+\})/u
  )?.[1];
  assert.ok(sessionPolicy, "rotation session policy is missing");
  assert.doesNotMatch(
    sessionPolicy,
    /bedrock:|secretsmanager:(?:CreateSecret|DeleteSecret|TagResource)/u
  );
  assert.match(sessionPolicy, /cockroach-admin-\?{6}/u);
  assert.match(sessionPolicy, /database-\?{6}/u);
  assert.doesNotMatch(sessionPolicy, /(?:cockroach-admin|database)-\*/u);
  assert.match(
    workflow,
    /role\/\$\{APP_NAME\}-github-database-operator/u
  );
  assert.doesNotMatch(
    workflow,
    /aws-access-key-id:|aws-secret-access-key:|secrets\.AWS_/u
  );
  const policy = foundation.match(
    /DatabaseOperatorRole:[\s\S]*?(?=\n  [A-Za-z][A-Za-z0-9]+:\n)/u
  )?.[0];
  assert.ok(policy, "database operator role is missing");
  assert.match(
    policy,
    /token\.actions\.githubusercontent\.com:sub: !Sub >-\s+repo:\$\{GitHubOrganization\}\/\$\{GitHubRepository\}:environment:production-db/u
  );
  assert.match(
    policy,
    /token\.actions\.githubusercontent\.com:repository: !Sub >-\s+\$\{GitHubOrganization\}\/\$\{GitHubRepository\}/u
  );
  assert.match(
    policy,
    /token\.actions\.githubusercontent\.com:repository_id: !Ref GitHubRepositoryId/u
  );
  assert.match(
    policy,
    /token\.actions\.githubusercontent\.com:repository_owner_id: !Ref GitHubRepositoryOwnerId/u
  );
  assert.match(
    policy,
    /token\.actions\.githubusercontent\.com:ref: refs\/heads\/main/u
  );
  assert.match(
    policy,
    /token\.actions\.githubusercontent\.com:environment: production-db/u
  );
  assert.match(
    policy,
    /token\.actions\.githubusercontent\.com:workflow:\s+- Deploy AWS\s+- Database release\s+- CockroachDB managed-backup restore drill\s+- Rotate CockroachDB Runtime Credential/u
  );
  for (const action of [
    "secretsmanager:DescribeSecret",
    "secretsmanager:GetSecretValue",
    "secretsmanager:ListSecretVersionIds",
    "secretsmanager:PutSecretValue",
    "secretsmanager:UpdateSecretVersionStage",
  ]) {
    assert.match(policy, new RegExp(action, "u"));
  }
  assert.match(policy, /\$\{AppName\}\/staging\/database-\?{6}/u);
  assert.match(policy, /\$\{AppName\}\/production\/database-\?{6}/u);
  assert.doesNotMatch(
    policy,
    /secretsmanager:(?:DeleteSecret|PutResourcePolicy|RestoreSecret|ReplicateSecretToRegions)/u
  );
  assert.match(
    wellArchitectedAudit,
    /wa05-database-credential-rotation-source/u
  );
  assert.match(
    wellArchitectedAudit,
    /databaseCredentialRotationSemanticsValid/u
  );
  assert.match(wellArchitectedAudit, /ROTATION_INTERRUPTED_STATE_UNKNOWN/u);
  assert.match(wellArchitectedAudit, /concurrent fake-pg refresh coalesces/u);
});

test("script implements pending, tested cutover, hosted proof, and retirement", () => {
  assert.match(script, /\^\[A-Za-z0-9_-\]\{32,64\}\$/u);
  const create = script.indexOf("await createRuntimePrincipal");
  const pending = script.indexOf("new PutSecretValueCommand");
  const pendingProbe = script.indexOf("await testPendingCredential");
  const current = script.indexOf('VersionStage: "AWSCURRENT"', pending);
  const hosted = script.indexOf("await waitForHostedPrincipal", current);
  const disable = script.indexOf("await disableAndDrainPrincipal", hosted);
  const reject = script.indexOf("await proveCredentialRejected", disable);
  const drop = script.indexOf("await dropRuntimePrincipal", reject);
  assert.ok(create > 0);
  assert.ok(pending > create);
  assert.ok(pendingProbe > pending);
  assert.ok(current > pendingProbe);
  assert.ok(hosted > current);
  assert.ok(disable > hosted);
  assert.ok(reject > disable);
  assert.ok(drop > reject);
  assert.match(script, /VersionStages: \["AWSPENDING"\]/u);
  assert.match(script, /Array\.from\(\{ length: 5 \}/u);
  assert.match(script, /count !== 9/u);
  assert.match(script, /grounding\?\.status === "verified"/u);
  assert.match(script, /groundingChecks\?\.citations === true/u);
  assert.match(script, /recall\.consistencyOk === true/u);
  assert.match(script, /scope\.tenantId === "public-demo"/u);
  assert.match(script, /MoveToVersionId: newVersionId/u);
  assert.match(script, /RemoveFromVersionId: oldVersion\.versionId/u);
  assert.match(script, /ALTER USER \$\{user\} NOLOGIN/u);
  assert.match(script, /SHOW CLUSTER SESSIONS/u);
  assert.doesNotMatch(
    script.match(/async function oldRuntimeSessions[\s\S]*?^\}/mu)?.[0] ?? "",
    /application_name/u
  );
  assert.match(script, /disabledOptions\.includes\("NOLOGIN"\)/u);
  assert.match(script, /sqlState === "28000" \|\| sqlState === "28P01"/u);
  assert.match(script, /CANCEL SESSION \$\{literal\(sessionId\)\}/u);
  assert.match(script, /DROP USER \$\{user\}/u);
  const createPrincipal = script.match(
    /async function createRuntimePrincipal[\s\S]*?(?=\nasync function testPendingCredential)/u
  )?.[0] ?? "";
  const dropPrincipal = script.match(
    /async function dropRuntimePrincipal[\s\S]*?(?=\nasync function removeVersionLabel)/u
  )?.[0] ?? "";
  assert.doesNotMatch(createPrincipal, /query\("(?:BEGIN|COMMIT|ROLLBACK)"\)/u);
  assert.doesNotMatch(dropPrincipal, /query\("(?:BEGIN|COMMIT|ROLLBACK)"\)/u);
  assert.match(createPrincipal, /autocommitted schema change/u);
  assert.match(dropPrincipal, /safe to repeat/u);
  assert.match(script, /affirmativeSystemGrants\(systemGrants\.rows\)/u);
  for (const runtimeGate of [script, provision]) {
    assert.match(runtimeGate, /privilegedRuntimeRoleOptions/u);
    assert.match(runtimeGate, /runtimeLoginIsDisabled/u);
    assert.match(runtimeGate, /runtimeRoleOptionsAreCanonical/u);
    assert.match(runtimeGate, /affirmativeSystemGrants/u);
  }
  assert.match(provision, /SHOW SYSTEM GRANTS FOR \$\{appUser\}/u);
  assert.match(systemGrantContract, /"CREATEDB"/u);
  assert.match(systemGrantContract, /"CREATELOGIN"/u);
  assert.match(systemGrantContract, /"CONTROLCHANGEFEED"/u);
  assert.match(systemGrantContract, /"REPLICATION"/u);
  assert.match(systemGrantContract, /"SUBJECT"/u);
  assert.match(systemGrantContract, /"PROVISIONSRC"/u);
  assert.match(script, /SHOW GRANTS ON TABLE \* FOR \$\{principalSql\}/u);
  assert.match(script, /verifyClusterWideResolutionGrants\(\{/u);
  assert.match(provision, /verifyClusterWideResolutionGrants\(\{/u);
  for (const runtimePrincipalProof of [script, provision]) {
    assert.match(
      runtimePrincipalProof,
      /expectedDatabaseGrants: expectedRuntimeDatabaseGrants\(\s*database(?:Name|Raw),\s*(?:principal|appUserRaw)\s*\)/u
    );
  }
  assert.match(
    script,
    /SHOW GRANTS ON DATABASE \$\{databaseSql\} FOR \$\{principalSql\}[\s\S]*?databaseGrants\.rows\.length !== 1[\s\S]*?grant\.database_name !== databaseName[\s\S]*?grant\.grantee !== principal/u
  );
  assert.match(clusterGrantProof, /const proofClient = new Client\(\{/u);
  assert.match(clusterGrantProof, /SET database = ''/u);
  assert.match(
    clusterGrantProof,
    /COCKROACH_BUILTIN_PUBLIC_DATABASE_GRANTS[\s\S]*?databaseName: "defaultdb"[\s\S]*?privilegeType: "TEMPORARY"[\s\S]*?databaseName: "postgres"[\s\S]*?privilegeType: "TEMPORARY"/u
  );
  assert.match(clusterGrantProof, /SELECT current_database\(\) AS database_name/u);
  assert.match(
    clusterGrantProof,
    /SHOW GRANTS FOR \$\{principalSql\}[\s\S]*?object_type = 'routine'/u
  );
  assert.match(clusterGrantProof, /FROM \[SHOW DATABASES\]/u);
  assert.match(
    clusterGrantProof,
    /SHOW GRANTS ON DATABASE \$\{databaseSql\} FOR \$\{principalSql\}/u
  );
  assert.match(
    clusterGrantProof,
    /JSON\.stringify\(finalDatabaseInventory\)[\s\S]*?JSON\.stringify\(databaseNames\)/u
  );
  assert.match(clusterGrantProof, /databaseMatrixSha256: createHash\("sha256"\)/u);
  assert.match(
    clusterGrantProof,
    /archon_resolution_create_session\(text, uuid, uuid, uuid, uuid, timestamptz, int8\)/u
  );
  assert.match(
    clusterGrantProof,
    /archon_resolution_decide\(text, text, uuid, uuid, uuid, timestamptz\)/u
  );
  assert.match(
    clusterGrantProof,
    /finally \{[\s\S]*?proofClient\.end\(\)\.catch/u
  );
  assert.doesNotMatch(clusterGrantProof, /object_type = 'function'/u);
});

test("ambiguous cutover is reconciled and rollback precedes cleanup", () => {
  assert.match(
    script,
    /async function waitForSecretStageVersion\([\s\S]*?timeoutSeconds = 60[\s\S]*?observed\.versionId === expectedVersionId/u
  );
  assert.match(
    script,
    /cutoverAttempted = true;[\s\S]*?new UpdateSecretVersionStageCommand\([\s\S]*?cutoverAcknowledged = true[\s\S]*?cutoverProved = true/u
  );
  assert.match(
    script,
    /state\.cutoverAttempted && !cutoverProved[\s\S]*?actions\.observeCandidateAsCurrent\(\)[\s\S]*?cutoverProved = true/u
  );
  assert.match(
    script,
    /MoveToVersionId: oldVersion\.versionId,[\s\S]*?RemoveFromVersionId: newVersionId[\s\S]*?waitForSecretStageVersion\([\s\S]*?"AWSCURRENT",[\s\S]*?oldVersion\.versionId/u
  );
  assert.match(
    script,
    /ROTATION_CUTOVER_STATE_AMBIGUOUS/u
  );
  assert.match(script, /new ListSecretVersionIdsCommand/u);
  assert.match(script, /Secret version stage removal did not converge/u);
  assert.match(
    script,
    /Re-submit the exact idempotent Put after a lost response/u
  );
  assert.match(script, /rollbackAvailableBeforeRetirement: true/u);
});

function injectedRecovery(
  state: RotationRecoveryState,
  options: {
    cleanupFails?: boolean;
    observeFails?: boolean;
    preparedExists?: boolean;
    reconcileFails?: boolean;
    rollbackFails?: boolean;
  } = {}
): {
  actions: RotationRecoveryActions;
  calls: string[];
  state: RotationRecoveryState;
} {
  const calls: string[] = [];
  return {
    state,
    calls,
    actions: {
      async reconcilePreparedPrincipal(): Promise<boolean> {
        calls.push("pg:reconcile-partial-ddl");
        if (options.reconcileFails) throw new Error("injected pg read failure");
        return options.preparedExists ?? true;
      },
      async observeCandidateAsCurrent(): Promise<void> {
        calls.push("secrets:observe-exact-current");
        if (options.observeFails) throw new Error("injected stale read");
      },
      async rollbackToPrevious(): Promise<void> {
        calls.push("secrets:rollback-and-hosted-proof");
        if (options.rollbackFails) throw new Error("injected lost rollback");
      },
      async cleanupPreparedPrincipal(): Promise<void> {
        calls.push("secrets+pg:remove-labels-then-principal");
        if (options.cleanupFails) throw new Error("injected cleanup failure");
      },
    },
  };
}

test("lost Put response reconciles and cleans without inventing a cutover", async () => {
  const fixture = injectedRecovery({
    candidateNamed: true,
    cutoverAcknowledged: false,
    cutoverAttempted: false,
    cutoverProved: false,
    newPrincipalCreated: true,
    retirementStarted: false,
  });
  const outcome = await recoverFailedRotation(fixture.state, fixture.actions);
  assert.deepEqual(fixture.calls, [
    "secrets+pg:remove-labels-then-principal",
  ]);
  assert.deepEqual(outcome, {
    cleanup: "complete",
    errorCode: "ROTATION_RECOVERED",
    operatorReviewRequired: false,
    result: "cleaned-prepared-principal",
    rollback: "not-required",
  });
});

test("partial Cockroach DDL is reconciled before deterministic cleanup", async () => {
  const fixture = injectedRecovery(
    {
      candidateNamed: true,
      cutoverAcknowledged: false,
      cutoverAttempted: false,
      cutoverProved: false,
      newPrincipalCreated: false,
      retirementStarted: false,
    },
    { preparedExists: true }
  );
  const outcome = await recoverFailedRotation(fixture.state, fixture.actions);
  assert.deepEqual(fixture.calls, [
    "pg:reconcile-partial-ddl",
    "secrets+pg:remove-labels-then-principal",
  ]);
  assert.equal(outcome.cleanup, "complete");
  assert.equal(outcome.operatorReviewRequired, false);
});

test("lost Update response requires exact current observation before rollback", async () => {
  const fixture = injectedRecovery({
    candidateNamed: true,
    cutoverAcknowledged: false,
    cutoverAttempted: true,
    cutoverProved: false,
    newPrincipalCreated: true,
    retirementStarted: false,
  });
  const outcome = await recoverFailedRotation(fixture.state, fixture.actions);
  assert.deepEqual(fixture.calls, [
    "secrets:observe-exact-current",
    "secrets:rollback-and-hosted-proof",
    "secrets+pg:remove-labels-then-principal",
  ]);
  assert.equal(outcome.rollback, "complete");
  assert.equal(outcome.result, "rolled-back-and-cleaned");
});

test("stale cutover reads fail closed without rollback or cleanup", async () => {
  const fixture = injectedRecovery(
    {
      candidateNamed: true,
      cutoverAcknowledged: false,
      cutoverAttempted: true,
      cutoverProved: false,
      newPrincipalCreated: true,
      retirementStarted: false,
    },
    { observeFails: true }
  );
  const outcome = await recoverFailedRotation(fixture.state, fixture.actions);
  assert.deepEqual(fixture.calls, ["secrets:observe-exact-current"]);
  assert.deepEqual(outcome, {
    cleanup: "operator-review",
    errorCode: "ROTATION_CUTOVER_STATE_AMBIGUOUS",
    operatorReviewRequired: true,
    result: "operator-review-required",
    rollback: "operator-review",
  });
});

test("injected rollback and cleanup failures produce stable operator codes", async () => {
  const rollbackFixture = injectedRecovery(
    {
      candidateNamed: true,
      cutoverAcknowledged: true,
      cutoverAttempted: true,
      cutoverProved: true,
      newPrincipalCreated: true,
      retirementStarted: false,
    },
    { rollbackFails: true }
  );
  const rollback = await recoverFailedRotation(
    rollbackFixture.state,
    rollbackFixture.actions
  );
  assert.deepEqual(rollbackFixture.calls, [
    "secrets:rollback-and-hosted-proof",
  ]);
  assert.equal(rollback.errorCode, "ROTATION_ROLLBACK_REQUIRES_REVIEW");
  assert.equal(rollback.cleanup, "operator-review");

  const cleanupFixture = injectedRecovery(
    {
      candidateNamed: true,
      cutoverAcknowledged: false,
      cutoverAttempted: false,
      cutoverProved: false,
      newPrincipalCreated: true,
      retirementStarted: false,
    },
    { cleanupFails: true }
  );
  const cleanup = await recoverFailedRotation(
    cleanupFixture.state,
    cleanupFixture.actions
  );
  assert.deepEqual(cleanupFixture.calls, [
    "secrets+pg:remove-labels-then-principal",
  ]);
  assert.equal(cleanup.errorCode, "ROTATION_CLEANUP_REQUIRES_REVIEW");
  assert.equal(cleanup.operatorReviewRequired, true);
});

test("retirement-started failures never attempt unsafe automated rollback", async () => {
  const fixture = injectedRecovery({
    candidateNamed: true,
    cutoverAcknowledged: true,
    cutoverAttempted: true,
    cutoverProved: true,
    newPrincipalCreated: true,
    retirementStarted: true,
  });
  const outcome = await recoverFailedRotation(fixture.state, fixture.actions);
  assert.deepEqual(fixture.calls, []);
  assert.equal(outcome.errorCode, "ROTATION_RETIREMENT_REQUIRES_REVIEW");
  assert.equal(outcome.operatorReviewRequired, true);
});

test("receipt is sanitized, attested, and honest about the live boundary", () => {
  assert.match(
    script,
    /schema: "archon\.cockroach-runtime-credential-rotation"/u
  );
  assert.match(script, /oldPrincipalSha256: redactedDigest/u);
  assert.match(script, /currentVersionSha256: redactedDigest/u);
  assert.match(script, /materialPrinted: false/u);
  assert.match(script, /canonicalMemoryMutated: false/u);
  assert.match(script, /applicationDataMutated: false/u);
  assert.match(script, /crossRegionWorkloadCreated: false/u);
  assert.match(script, /RuntimeCredentialRotationFailure/u);
  assert.match(script, /providerDetailsRedacted: true/u);
  assert.match(script, /process\.stdout\.write\(`\$\{JSON\.stringify\(receipt/u);
  assert.match(script, /does not claim automatic scheduled rotation/u);
  assert.match(workflow, /actions\/attest-build-provenance@[a-f0-9]{40}/u);
  assert.match(
    workflow,
    /Preserve exact context for any interrupted failure[\s\S]*?ROTATION_WORKFLOW_PREFLIGHT_FAILED/u
  );
  assert.match(
    workflow,
    /script-execution-started[\s\S]*?ROTATION_INTERRUPTED_STATE_UNKNOWN[\s\S]*?operatorReviewRequired: true/u
  );
  assert.match(
    workflow,
    /Attest the sanitized exact-SHA rotation receipt\s+if: always\(\)/u
  );
  assert.match(workflow, /retention-days:\s+90/u);
  assert.match(runbook, /two-principal/u);
  assert.match(runbook, /live rotation has not yet been exercised/u);
});

test("all third-party actions are pinned and checkout credentials are disabled", () => {
  const uses = [...workflow.matchAll(/^\s+uses:\s+([^\s#]+)/gmu)].map(
    (match) => match[1]
  );
  assert.equal(uses.length, 6);
  for (const action of uses) {
    assert.match(action, /^[^@]+@[a-f0-9]{40}$/u);
  }
  assert.equal(
    (workflow.match(/persist-credentials:\s+false/gu) ?? []).length,
    2
  );
});
