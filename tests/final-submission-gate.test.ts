import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import {
  exactPublicScope,
  exactSequentialCitationMarkers,
  extractSingleJsonArtifact,
  expectedPreSubmitDisplayTitle,
  type GitHubWorkflowRun,
  parseWorkflowJobs,
  parseWorkflowRuns,
  parseWorkflowArtifacts,
  readBoundedResponseBody,
  requireArtifactArchiveDigest,
  requireExactHostedDastReceipt,
  requireFreshGeneratedAt,
  requirePostDeployAuditTiming,
  requireExactDemoVideoPublication,
  requireSuccessfulDemoVideoJobs,
  requireSuccessfulDeployJobs,
  requireSuccessfulHostedDastJobs,
  requireSuccessfulRecoveryAuditJobs,
  selectExactHostedDastArtifact,
  selectBoundSuccessfulDemoVideoRun,
  selectExactDemoVideoArtifacts,
  selectSuccessfulRun,
  validSubmissionCopyMetadata,
  validDevpostPageContract,
  validLiveResponseMetadata,
  validOembedContract,
} from "../scripts/final-submission-gate.js";
import { parseCanonicalSubmissionVideoUrl } from "../scripts/readiness.js";

const SHA = "a".repeat(40);
const WORKFLOW_PATH = ".github/workflows/ci.yml";
const NOW = Date.parse("2026-07-29T12:30:00.000Z");

function workflowRun(
  overrides: Partial<GitHubWorkflowRun> = {}
): GitHubWorkflowRun {
  const id = overrides.id ?? 101;
  return {
    id,
    name: "CI",
    display_title: "CI",
    path: WORKFLOW_PATH,
    event: "push",
    head_branch: "main",
    head_sha: SHA,
    status: "completed",
    conclusion: "success",
    run_attempt: 1,
    html_url:
      `https://github.com/upgradedev/archon-cockroach-memory/actions/runs/${id}`,
    run_started_at: "2026-07-29T12:00:00.000Z",
    updated_at: "2026-07-29T12:05:00.000Z",
    ...overrides,
  };
}

function recoveryJobs(runId = 303, sha = SHA): Record<string, unknown> {
  const job = (
    id: number,
    name: string,
    audit: string,
    upload: string
  ) => ({
    id,
    run_id: runId,
    run_attempt: 1,
    head_sha: sha,
    name,
    status: "completed",
    conclusion: "success",
    steps: [
      {
        name: audit,
        status: "completed",
        conclusion: "success",
      },
      {
        name: upload,
        status: "completed",
        conclusion: "success",
      },
    ],
  });
  return {
    total_count: 2,
    jobs: [
      job(
        401,
        "Recover unresolved staging delivery",
        "Run the daily staging protection and drift audit",
        "Upload staging daily protection and drift audit"
      ),
      job(
        402,
        "Recover unresolved production delivery",
        "Run the daily production protection and drift audit",
        "Upload production daily protection and drift audit"
      ),
    ],
  };
}

function hostedDastJobs(
  runId = 301,
  sha = SHA,
  runAttempt = 1
): Record<string, unknown> {
  const prefix =
    "Run hosted DAST against exact production release / ";
  const job = (id: number, name: string, steps: string[]) => ({
    id,
    run_id: runId,
    run_attempt: runAttempt,
    head_sha: sha,
    name: `${prefix}${name}`,
    status: "completed",
    conclusion: "success",
    steps: steps.map((step) => ({
      name: step,
      status: "completed",
      conclusion: "success",
    })),
  });
  return {
    total_count: 3,
    jobs: [
      job(500, "Validate Hosted DAST source deployment", [
        "Require successful operation-bound Deploy AWS source",
      ]),
      job(501, "Bounded active API and browser-boundary probes", [
        "Run fail-closed hosted adversarial probes",
        "Upload sanitized hosted DAST receipt",
      ]),
      job(502, "OWASP ZAP passive and AJAX-spider baseline", [
        "Scan the owned public production release",
      ]),
    ],
  };
}

function deployJobs(
  runId = 301,
  sha = SHA,
  runAttempt = 1
): Record<string, unknown> {
  const job = (id: number, name: string, steps: string[]) => ({
    id,
    run_id: runId,
    run_attempt: runAttempt,
    head_sha: sha,
    name,
    status: "completed",
    conclusion: "success",
    steps: steps.map((step) => ({
      name: step,
      status: "completed",
      conclusion: "success",
    })),
  });
  return {
    total_count: 9,
    jobs: [
      job(600, "Validate Deploy AWS source CI", [
        "Require successful exact-main push CI source",
      ]),
      job(601, "Verify CI SHA and build once", [
        "Prove the CI SHA is still the main branch head",
        "Prove CodeQL succeeded for the exact release SHA",
        "Test and build the frontend",
        "Validate and build the SAM application",
        "Create sanitized build receipt",
        "Upload immutable candidate",
      ]),
      job(602, "Deploy and smoke staging", [
        "Deploy staging with recovery-safe SAM canary",
        "Smoke the same-origin application and real recall path",
        "Hosted Chromium judge journey on staging",
        "Build and validate sanitized staging deployment receipt",
        "Upload staging receipt",
      ]),
      job(603, "Promote identical candidate to production", [
        "Deploy production with recovery-safe SAM canary",
        "Smoke production through CloudFront",
        "Hosted Chromium judge journey on production",
        "Build and validate sanitized production deployment receipt",
        "Commit the receipt-bound production recovery intent",
        "Upload production receipt",
      ]),
      job(
        604,
        "Prove production memory through CockroachDB Managed MCP",
        [
          "Run bounded read-only Managed MCP proof",
          "Upload sanitized Managed MCP receipt",
        ]
      ),
      job(
        605,
        "Reconcile CockroachDB memory release / " +
          "Schema, runtime RLS, C-SPANN, and resolution-loop execution proof",
        [
          "Prove target is still current main",
          "Prove CockroachDB Cloud provider, plan, state, and region",
          "Gate real Titan and Claude quality on the golden judge question",
          "Reconcile schema, canonical memory, and runtime credentials",
          "Upload sanitized database release receipt",
        ]
      ),
      ...(hostedDastJobs(runId, sha, runAttempt).jobs as Array<
        Record<string, unknown>
      >),
    ],
  };
}

function demoVideoJobs(
  runId = 701,
  sha = SHA,
  attempts = {
    sourceGate: 1,
    narrate: 1,
    capture: 1,
    buildVerify: 1,
  }
): Record<string, unknown> {
  const job = (
    id: number,
    name: string,
    runAttempt: number,
    steps: string[]
  ) => ({
    id,
    run_id: runId,
    run_attempt: runAttempt,
    head_sha: sha,
    name,
    status: "completed",
    conclusion: "success",
    steps: steps.map((step) => ({
      name: step,
      status: "completed",
      conclusion: "success",
    })),
  });
  return {
    total_count: 4,
    jobs: [
      job(
        710,
        "Bind video to the exact protected release",
        attempts.sourceGate,
        [
          "Require main-ref exact-SHA dispatch before any paid call",
          "Validate exact hosted release evidence and live proof",
          "Upload sanitized release binding",
          "Expose release-binding artifact attempt",
        ]
      ),
      job(
        711,
        "Generate timestamped ElevenLabs narration",
        attempts.narrate,
        [
          "Generate narration and alignment-derived English captions",
          "Validate the sanitized narration package",
          "Upload sanitized one-day narration handoff",
          "Expose narration artifact attempt",
        ]
      ),
      job(
        712,
        "Record the real production browser journey",
        attempts.capture,
        [
          "Capture the exact live application",
          "Validate the sanitized capture package",
          "Upload sanitized one-day live-capture handoff",
          "Expose live-capture artifact attempt",
        ]
      ),
      job(
        713,
        "Compose and independently verify the final review package",
        attempts.buildVerify,
        [
          "Validate producer artifact attempt bindings",
          "Compose the release-bound video and captions",
          "Measure and verify the final media contract",
          "Fail closed on receipt or artifact disagreement",
          "Prove all eight hash-bound screenshots are package inputs",
          "Terminally revalidate main, live proof, and hosted evidence",
          "Upload verified review package",
          "Create canonical publication provenance",
          "Upload canonical publication provenance",
          "Revalidate exact main after artifact publication",
        ]
      ),
    ],
  };
}

function workflowArtifact(
  id: number,
  name: string,
  run: GitHubWorkflowRun,
  sizeInBytes: number,
  digestCharacter: string,
  expired = false
): Record<string, unknown> {
  return {
    id,
    name,
    size_in_bytes: sizeInBytes,
    archive_download_url:
      `https://api.github.com/repos/upgradedev/archon-cockroach-memory/` +
      `actions/artifacts/${id}/zip`,
    digest: `sha256:${digestCharacter.repeat(64)}`,
    expired,
    created_at: "2026-07-29T12:04:00.000Z",
    updated_at: "2026-07-29T12:04:30.000Z",
    workflow_run: {
      id: run.id,
      head_sha: run.head_sha,
    },
  };
}

function testCrc32(value: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZip(path: string, value: unknown): Uint8Array {
  const name = Buffer.from(path, "utf8");
  const content = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  const crc = testCrc32(content);
  const flags = 0x0800;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(flags, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(name.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(flags, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(content.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(name.length, 28);

  const localEntry = Buffer.concat([local, name, content]);
  const centralEntry = Buffer.concat([central, name]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralEntry.length, 12);
  eocd.writeUInt32LE(localEntry.length, 16);
  return Buffer.concat([localEntry, centralEntry, eocd]);
}

function descriptorZip(path: string, value: unknown): Uint8Array {
  const name = Buffer.from(path, "utf8");
  const content = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  const compressed = deflateRawSync(content);
  const crc = testCrc32(content);
  const flags = 0x0008;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(flags, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(name.length, 26);

  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08074b50, 0);
  descriptor.writeUInt32LE(crc, 4);
  descriptor.writeUInt32LE(compressed.length, 8);
  descriptor.writeUInt32LE(content.length, 12);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(flags, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(name.length, 28);

  const localEntry = Buffer.concat([
    local,
    name,
    compressed,
    descriptor,
  ]);
  const centralEntry = Buffer.concat([central, name]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralEntry.length, 12);
  eocd.writeUInt32LE(localEntry.length, 16);
  return Buffer.concat([localEntry, centralEntry, eocd]);
}

function hostedDastReceipt(
  deployRun: GitHubWorkflowRun
): Record<string, unknown> {
  const ids = [
    "root-security-headers",
    "health-boundary",
    "release-proof-boundary",
    "audit-boundary",
    "method-boundary-get",
    "method-boundary-delete",
    "content-type-boundary",
    "malformed-json-boundary",
    "body-size-boundary",
    "question-size-boundary",
    "fixed-scope-sql-injection",
    "kind-enumeration-boundary",
    "limit-boundary",
    "write-route-absent",
    "audit-scope-injection",
    "resolution-session-method-boundary",
    "resolution-session-fixed-scope-boundary",
    "resolution-session-auth-boundary",
    "resolution-capability-shape-boundary",
    "resolution-decision-auth-boundary",
    "unknown-route-boundary",
  ];
  const statuses = [
    200, 200, 200, 200, 405, 405, 415, 400, 413, 400, 400, 400, 400,
    404, 400, 405, 400, 401, 401, 401, 404,
  ];
  return {
    schema: "archon.hosted-dast",
    version: 4,
    generatedAt: "2026-07-29T12:03:00.000Z",
    profile: "exact-release",
    targetOrigin: "https://d2s5v0o0eg2aaw.cloudfront.net",
    releaseSha: SHA,
    scannerSha: SHA,
    scannerRunId: deployRun.id,
    scannerRunAttempt: deployRun.run_attempt,
    sourceDeployRunId: deployRun.id,
    sourceDeployRunAttempt: deployRun.run_attempt,
    passed: true,
    checks: ids.map((id, index) => ({
      id,
      status: "pass",
      observedStatus: statuses[index],
    })),
  };
}

test("final gate: workflow run parser and selector fail closed on exact identity", () => {
  const baseline = workflowRun();
  const parsed = parseWorkflowRuns({ workflow_runs: [baseline] });
  assert.deepEqual(parsed, [baseline]);
  assert.equal(
    selectSuccessfulRun(
      parsed,
      "CI",
      "push",
      SHA,
      WORKFLOW_PATH
    ).id,
    baseline.id
  );

  for (const mutation of [
    workflowRun({ name: "Not CI" }),
    workflowRun({ event: "pull_request" }),
    workflowRun({ head_branch: "release" }),
    workflowRun({ head_sha: "b".repeat(40) }),
    workflowRun({ path: ".github/workflows/not-ci.yml" }),
    workflowRun({ status: "in_progress", conclusion: null }),
    workflowRun({ conclusion: "failure" }),
  ]) {
    assert.throws(() =>
      selectSuccessfulRun(
        [mutation],
        "CI",
        "push",
        SHA,
        WORKFLOW_PATH
      )
    );
  }

  for (const invalid of [
    workflowRun({ run_attempt: 0 }),
    workflowRun({ id: 0 }),
    workflowRun({ html_url: "https://example.com/run/101" }),
    workflowRun({ run_started_at: "not-a-date" }),
  ]) {
    assert.deepEqual(
      parseWorkflowRuns({ workflow_runs: [invalid] }),
      []
    );
  }
});

test("final gate: a newer failed or queued run blocks an older success", () => {
  const olderSuccess = workflowRun({
    id: 101,
    run_started_at: "2026-07-29T11:00:00.000Z",
    updated_at: "2026-07-29T11:05:00.000Z",
  });
  for (const newer of [
    workflowRun({
      id: 102,
      status: "completed",
      conclusion: "failure",
      run_started_at: "2026-07-29T12:00:00.000Z",
    }),
    workflowRun({
      id: 103,
      status: "queued",
      conclusion: null,
      run_started_at: "2026-07-29T12:01:00.000Z",
    }),
  ]) {
    assert.throws(() =>
      selectSuccessfulRun(
        [olderSuccess, newer],
        "CI",
        "push",
        SHA,
        WORKFLOW_PATH
      )
    );
  }
});

test("final gate: exact-release Hosted DAST belongs to the exact Deploy push run", () => {
  const deploy = workflowRun({
    id: 150,
    name: "Deploy AWS",
    display_title: "Deploy AWS",
    path: ".github/workflows/deploy-aws.yml",
    event: "push",
  });
  assert.equal(
    selectSuccessfulRun(
      [deploy],
      "Deploy AWS",
      "push",
      SHA,
      ".github/workflows/deploy-aws.yml"
    ).id,
    deploy.id
  );
  for (const mutation of [
    { ...deploy, event: "workflow_run" },
    { ...deploy, path: ".github/workflows/security-dast.yml" },
    { ...deploy, head_sha: "b".repeat(40) },
    { ...deploy, name: "Hosted DAST" },
  ]) {
    assert.throws(() =>
      selectSuccessfulRun(
        [mutation],
        "Deploy AWS",
        "push",
        SHA,
        ".github/workflows/deploy-aws.yml"
      )
    );
  }
});

test("final gate: Hosted DAST artifact is unique, unexpired, and Deploy-run bound", () => {
  const deploy = workflowRun({
    id: 201,
    name: "Deploy AWS",
    display_title: "Deploy AWS",
    path: ".github/workflows/deploy-aws.yml",
    run_started_at: "2026-07-29T11:45:00.000Z",
    updated_at: "2026-07-29T12:05:00.000Z",
  });
  const expectedName =
    `hosted-dast-${SHA}-${deploy.id}-${deploy.run_attempt}`;
  const artifact = {
    id: 700,
    name: expectedName,
    size_in_bytes: 512,
    archive_download_url:
      "https://api.github.com/repos/upgradedev/archon-cockroach-memory/actions/artifacts/700/zip",
    digest: `sha256:${"0".repeat(64)}`,
    expired: false,
    created_at: "2026-07-29T12:04:00.000Z",
    updated_at: "2026-07-29T12:04:30.000Z",
    workflow_run: {
      id: deploy.id,
      head_sha: SHA,
    },
  };
  const zapArtifact = {
    ...artifact,
    id: 702,
    name: `zap-baseline-${SHA}-${deploy.run_attempt}`,
    size_in_bytes: 2_000_000,
    archive_download_url:
      "https://api.github.com/repos/upgradedev/archon-cockroach-memory/actions/artifacts/702/zip",
    digest: `sha256:${"1".repeat(64)}`,
  };
  const response = {
    total_count: 2,
    artifacts: [artifact, zapArtifact],
  };
  const parsed = parseWorkflowArtifacts(response, 100_000_000);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]?.id, artifact.id);
  assert.equal(
    selectExactHostedDastArtifact(
      response,
      expectedName,
      deploy
    ).name,
    expectedName
  );
  assert.equal(
    selectExactHostedDastArtifact(
      response,
      zapArtifact.name,
      deploy,
      100_000_000
    ).id,
    zapArtifact.id
  );
  assert.throws(() =>
    selectExactHostedDastArtifact(
      response,
      zapArtifact.name,
      deploy
    )
  );
  assert.throws(() =>
    selectExactHostedDastArtifact(
      response,
      expectedName,
      workflowRun({
        id: deploy.id,
        name: "Hosted DAST",
        path: ".github/workflows/security-dast.yml",
        event: "workflow_run",
      })
    )
  );

  const mutation = (
    changes: Record<string, unknown>
  ): Record<string, unknown> => ({
    total_count: 1,
    artifacts: [{ ...artifact, ...changes }],
  });
  for (const invalid of [
    mutation({ name: `hosted-dast-${SHA}-999-1` }),
    mutation({ expired: true }),
    mutation({
      workflow_run: { id: 999, head_sha: SHA },
    }),
    mutation({
      workflow_run: {
        id: deploy.id,
        head_sha: "b".repeat(40),
      },
    }),
    mutation({ digest: "sha256:not-a-digest" }),
    {
      total_count: 2,
      artifacts: [artifact],
    },
    {
      total_count: 2,
      artifacts: [
        artifact,
        {
          ...artifact,
          id: 701,
          archive_download_url:
            "https://api.github.com/repos/upgradedev/archon-cockroach-memory/actions/artifacts/701/zip",
        },
      ],
    },
  ]) {
    assert.throws(() =>
      selectExactHostedDastArtifact(
        invalid,
        expectedName,
        deploy
      )
    );
  }
});

test("final gate: Hosted DAST ZIP accepts one integrity-checked JSON receipt", () => {
  const deploy = workflowRun({
    id: 201,
    name: "Deploy AWS",
    path: ".github/workflows/deploy-aws.yml",
    updated_at: "2026-07-29T12:05:00.000Z",
  });
  const receipt = hostedDastReceipt(deploy);
  const archive = storedZip("hosted-dast.json", receipt);
  const compressedArchive = Buffer.from(
    descriptorZip("hosted-dast.json", receipt)
  );
  assert.deepEqual(
    extractSingleJsonArtifact(archive, "hosted-dast.json"),
    receipt
  );
  assert.deepEqual(
    extractSingleJsonArtifact(
      compressedArchive,
      "hosted-dast.json"
    ),
    receipt
  );
  const digest = `sha256:${createHash("sha256")
    .update(archive)
    .digest("hex")}`;
  assert.doesNotThrow(() =>
    requireArtifactArchiveDigest(archive, digest)
  );
  assert.throws(() =>
    requireArtifactArchiveDigest(
      archive,
      `sha256:${"0".repeat(64)}`
    )
  );

  const corrupted = Buffer.from(archive);
  const corruptionOffset =
    30 + Buffer.byteLength("hosted-dast.json", "utf8") + 1;
  corrupted[corruptionOffset] =
    (corrupted[corruptionOffset] ?? 0) ^ 0xff;
  const inconsistentLocalHeader = Buffer.from(archive);
  inconsistentLocalHeader.writeUInt32LE(0, 14);
  const corruptDescriptor = Buffer.from(compressedArchive);
  const compressedEocd = corruptDescriptor.length - 22;
  const compressedCentral = corruptDescriptor.readUInt32LE(
    compressedEocd + 16
  );
  corruptDescriptor.writeUInt32LE(0, compressedCentral - 16);
  const prefixed = Buffer.concat([Buffer.from([0]), archive]);
  const prefixedEocd = prefixed.length - 22;
  const prefixedCentral =
    prefixed.readUInt32LE(prefixedEocd + 16) + 1;
  prefixed.writeUInt32LE(prefixedCentral, prefixedEocd + 16);
  prefixed.writeUInt32LE(1, prefixedCentral + 42);
  for (const invalid of [
    corrupted,
    inconsistentLocalHeader,
    corruptDescriptor,
    prefixed,
    storedZip("other.json", receipt),
    Buffer.concat([archive, Buffer.from([0])]),
  ]) {
    assert.throws(() =>
      extractSingleJsonArtifact(invalid, "hosted-dast.json")
    );
  }
});

test("final gate: Hosted DAST receipt proves one exact Deploy run, checks, and time", () => {
  const deploy = workflowRun({
    id: 201,
    name: "Deploy AWS",
    display_title: "Deploy AWS",
    path: ".github/workflows/deploy-aws.yml",
    run_started_at: "2026-07-29T11:45:00.000Z",
    updated_at: "2026-07-29T12:05:00.000Z",
  });
  const receipt = hostedDastReceipt(deploy);
  assert.doesNotThrow(() =>
    requireExactHostedDastReceipt(
      receipt,
      deploy,
      deploy,
      SHA,
      NOW
    )
  );

  const change = (
    mutate: (copy: Record<string, unknown>) => void
  ): Record<string, unknown> => {
    const copy = structuredClone(receipt);
    mutate(copy);
    return copy;
  };
  const changedStatus = change((copy) => {
    const checks = copy.checks as Array<Record<string, unknown>>;
    checks[0] = { ...checks[0], status: "fail" };
  });
  const changedObservedStatus = change((copy) => {
    const checks = copy.checks as Array<Record<string, unknown>>;
    checks[4] = { ...checks[4], observedStatus: 404 };
  });
  const malformedChecks = change((copy) => {
    const checks = copy.checks as unknown[];
    checks[0] = null;
  });
  const extraCheck = change((copy) => {
    const checks = copy.checks as unknown[];
    checks.push({
      id: "unexpected",
      status: "pass",
      observedStatus: 200,
    });
  });
  for (const invalid of [
    change((copy) => {
      copy.sourceDeployRunId = 999;
    }),
    change((copy) => {
      copy.sourceDeployRunAttempt = 2;
    }),
    change((copy) => {
      copy.scannerRunId = 999;
    }),
    change((copy) => {
      copy.scannerRunAttempt = 2;
    }),
    change((copy) => {
      copy.scannerSha = "b".repeat(40);
    }),
    change((copy) => {
      copy.profile = "production-audit";
    }),
    change((copy) => {
      copy.releaseSha = "b".repeat(40);
    }),
    change((copy) => {
      copy.generatedAt = "2026-07-29T11:44:59.999Z";
    }),
    change((copy) => {
      copy.generatedAt = "2026-07-29T12:07:00.001Z";
    }),
    change((copy) => {
      copy.passed = false;
    }),
    change((copy) => {
      copy.unexpected = true;
    }),
    changedStatus,
    changedObservedStatus,
    malformedChecks,
    extraCheck,
  ]) {
    assert.throws(() =>
      requireExactHostedDastReceipt(
        invalid,
        deploy,
        deploy,
        SHA,
        NOW
      )
    );
  }
  assert.throws(() =>
    requireExactHostedDastReceipt(
      receipt,
      deploy,
      workflowRun({
        id: 302,
        name: "Hosted DAST",
        path: ".github/workflows/security-dast.yml",
        event: "workflow_run",
      }),
      SHA,
      NOW
    )
  );
});

test("final gate: recovery audit proves both exact jobs and executed evidence steps", () => {
  const baseline = recoveryJobs();
  const parsed = parseWorkflowJobs(baseline);
  assert.equal(parsed.totalCount, 2);
  assert.equal(parsed.rawCount, 2);
  assert.equal(parsed.jobs.length, 2);
  assert.doesNotThrow(() =>
    requireSuccessfulRecoveryAuditJobs(baseline, 303, SHA)
  );

  const skippedAudit = structuredClone(baseline);
  const skippedJobs = skippedAudit.jobs as Array<Record<string, unknown>>;
  const skippedSteps = skippedJobs[0]?.steps as Array<
    Record<string, unknown>
  >;
  skippedSteps[0] = {
    ...skippedSteps[0],
    status: "completed",
    conclusion: "skipped",
  };
  assert.throws(() =>
    requireSuccessfulRecoveryAuditJobs(skippedAudit, 303, SHA)
  );

  for (const mutation of [
    { ...structuredClone(baseline), total_count: 3 },
    recoveryJobs(304, SHA),
    recoveryJobs(303, "b".repeat(40)),
  ]) {
    assert.throws(() =>
      requireSuccessfulRecoveryAuditJobs(mutation, 303, SHA)
    );
  }
});

test("final gate: Deploy AWS contains the exact reusable Hosted DAST jobs", () => {
  const baseline = deployJobs();
  assert.doesNotThrow(() =>
    requireSuccessfulHostedDastJobs(baseline, 301, SHA, 1)
  );

  const skippedStep = structuredClone(baseline);
  const skippedJobs = skippedStep.jobs as Array<Record<string, unknown>>;
  const skippedSteps = skippedJobs[6]?.steps as Array<
    Record<string, unknown>
  >;
  skippedSteps[0] = {
    ...skippedSteps[0],
    conclusion: "skipped",
  };

  const failedJob = structuredClone(baseline);
  const failedJobs = failedJob.jobs as Array<Record<string, unknown>>;
  failedJobs[7] = {
    ...failedJobs[7],
    conclusion: "failure",
  };

  const missingJob = structuredClone(baseline);
  missingJob.total_count = 8;
  (missingJob.jobs as unknown[]).pop();

  const unprefixedJob = structuredClone(baseline);
  const unprefixedJobs = unprefixedJob.jobs as Array<
    Record<string, unknown>
  >;
  unprefixedJobs[6] = {
    ...unprefixedJobs[6],
    name: "Validate Hosted DAST source deployment",
  };

  const duplicateDastJob = structuredClone(baseline);
  const duplicateDastJobs = duplicateDastJob.jobs as Array<
    Record<string, unknown>
  >;
  duplicateDastJobs.push({
    ...structuredClone(duplicateDastJobs[6]!),
    id: 999,
  });
  duplicateDastJob.total_count = 10;

  const malformedJobInventory = structuredClone(baseline);
  (malformedJobInventory.jobs as unknown[]).push("malformed job");
  malformedJobInventory.total_count = 10;

  for (const mutation of [
    skippedStep,
    failedJob,
    missingJob,
    unprefixedJob,
    duplicateDastJob,
    malformedJobInventory,
    { ...structuredClone(baseline), total_count: 10 },
    hostedDastJobs(999, SHA),
    hostedDastJobs(301, "b".repeat(40)),
    hostedDastJobs(301, SHA, 2),
  ]) {
    assert.throws(() =>
      requireSuccessfulHostedDastJobs(mutation, 301, SHA, 1)
    );
  }
});

test("final gate: Deploy AWS proves a real build, promotion, smoke, and receipt operation", () => {
  const baseline = deployJobs();
  assert.doesNotThrow(() =>
    requireSuccessfulDeployJobs(baseline, 301, SHA, 1)
  );

  const skippedSource = structuredClone(baseline);
  const skippedSourceJobs = skippedSource.jobs as Array<
    Record<string, unknown>
  >;
  const skippedSourceSteps = skippedSourceJobs[0]?.steps as Array<
    Record<string, unknown>
  >;
  skippedSourceSteps[0] = {
    ...skippedSourceSteps[0],
    conclusion: "skipped",
  };

  const failedProduction = structuredClone(baseline);
  const failedProductionJobs = failedProduction.jobs as Array<
    Record<string, unknown>
  >;
  failedProductionJobs[3] = {
    ...failedProductionJobs[3],
    conclusion: "failure",
  };

  const missingProductionSmoke = structuredClone(baseline);
  const missingProductionJobs = missingProductionSmoke.jobs as Array<
    Record<string, unknown>
  >;
  const productionSteps = missingProductionJobs[3]?.steps as Array<
    Record<string, unknown>
  >;
  productionSteps.splice(1, 1);

  const missingRequiredJob = structuredClone(baseline);
  const requiredJobs = missingRequiredJob.jobs as Array<
    Record<string, unknown>
  >;
  requiredJobs.splice(3, 1);
  missingRequiredJob.total_count = 8;

  const duplicateRequiredJob = structuredClone(baseline);
  const duplicateJobs = duplicateRequiredJob.jobs as Array<
    Record<string, unknown>
  >;
  duplicateJobs.push({
    ...structuredClone(duplicateJobs[0]),
    id: 606,
  });
  duplicateRequiredJob.total_count = 10;

  const duplicateRequiredStep = structuredClone(baseline);
  const duplicateStepJobs = duplicateRequiredStep.jobs as Array<
    Record<string, unknown>
  >;
  const duplicateProductionSteps = duplicateStepJobs[3]?.steps as Array<
    Record<string, unknown>
  >;
  duplicateProductionSteps.push(
    structuredClone(duplicateProductionSteps[1]!)
  );

  const incompleteJob = structuredClone(baseline);
  const incompleteJobs = incompleteJob.jobs as Array<
    Record<string, unknown>
  >;
  incompleteJobs[1] = {
    ...incompleteJobs[1],
    status: "in_progress",
    conclusion: null,
  };

  const oversizedInventory = structuredClone(baseline);
  const oversizedJobs = oversizedInventory.jobs as Array<
    Record<string, unknown>
  >;
  for (let index = oversizedJobs.length; index < 101; index += 1) {
    oversizedJobs.push({
      id: 700 + index,
      run_id: 301,
      run_attempt: 1,
      head_sha: SHA,
      name: `Unrelated deploy evidence ${index}`,
      status: "completed",
      conclusion: "success",
      steps: [],
    });
  }
  oversizedInventory.total_count = 101;

  const unexpectedJob = structuredClone(baseline);
  const unexpectedJobs = unexpectedJob.jobs as Array<
    Record<string, unknown>
  >;
  unexpectedJobs.push({
    id: 899,
    run_id: 301,
    run_attempt: 1,
    head_sha: SHA,
    name: "Unbound release evidence",
    status: "completed",
    conclusion: "success",
    steps: [],
  });
  unexpectedJob.total_count = 10;

  for (const mutation of [
    skippedSource,
    failedProduction,
    missingProductionSmoke,
    missingRequiredJob,
    duplicateRequiredJob,
    duplicateRequiredStep,
    incompleteJob,
    oversizedInventory,
    unexpectedJob,
    { ...structuredClone(baseline), total_count: 10 },
    deployJobs(999, SHA),
    deployJobs(301, "b".repeat(40)),
    deployJobs(301, SHA, 2),
  ]) {
    assert.throws(() =>
      requireSuccessfulDeployJobs(mutation, 301, SHA, 1)
    );
  }
});

test("final gate: independent post-deploy audits are ordered, completed, and fresh", () => {
  const deploy = workflowRun({
    id: 201,
    name: "Deploy AWS",
    path: ".github/workflows/deploy-aws.yml",
    run_started_at: "2026-07-29T11:45:00.000Z",
    updated_at: "2026-07-29T12:00:00.000Z",
  });
  const mcp = workflowRun({
    id: 202,
    name: "Cockroach Cloud Managed MCP Audit",
    run_started_at: "2026-07-29T12:01:00.000Z",
    updated_at: "2026-07-29T12:05:00.000Z",
  });
  const recovery = workflowRun({
    id: 203,
    name: "Recover AWS",
    run_started_at: "2026-07-29T12:06:00.000Z",
    updated_at: "2026-07-29T12:10:00.000Z",
  });
  assert.doesNotThrow(() =>
    requirePostDeployAuditTiming(deploy, deploy, mcp, recovery, NOW)
  );
  assert.throws(() =>
    requirePostDeployAuditTiming(
      deploy,
      deploy,
      { ...mcp, run_started_at: deploy.updated_at },
      recovery,
      NOW
    )
  );
  assert.throws(() =>
    requirePostDeployAuditTiming(
      deploy,
      deploy,
      {
        ...mcp,
        updated_at: new Date(
          NOW - 24 * 60 * 60 * 1_000 - 1
        ).toISOString(),
      },
      recovery,
      NOW
    )
  );
  assert.throws(() =>
    requirePostDeployAuditTiming(
      deploy,
      deploy,
      mcp,
      {
        ...recovery,
        updated_at: new Date(
          NOW + 5 * 60 * 1_000 + 1
        ).toISOString(),
      },
      NOW
    )
  );
  assert.throws(() =>
    requirePostDeployAuditTiming(
      { ...deploy, updated_at: "not-a-date" },
      { ...deploy, updated_at: "not-a-date" },
      mcp,
      recovery,
      NOW
    )
  );
  assert.throws(() =>
    requirePostDeployAuditTiming(
      deploy,
      workflowRun({
        id: 204,
        name: "Hosted DAST",
        path: ".github/workflows/security-dast.yml",
        event: "workflow_run",
      }),
      mcp,
      recovery,
      NOW
    )
  );
  assert.throws(() =>
    requirePostDeployAuditTiming(
      deploy,
      deploy,
      { ...mcp, run_attempt: 2 },
      {
        ...recovery,
        updated_at: new Date(
          NOW - 24 * 60 * 60 * 1_000 - 1
        ).toISOString(),
      },
      NOW
    )
  );
});

test("final gate: public scope and generatedAt are exact and fail closed", () => {
  const scope = {
    tenantId: "public-demo",
    company: "Helios SA",
    mode: "fixed-synthetic-demo",
    access: "read-only",
    dataClassification: "synthetic-public-demo",
    source: "server-configured",
  };
  assert.equal(exactPublicScope(scope), true);
  assert.equal(exactPublicScope({ ...scope, bypass: true }), false);
  assert.equal(exactPublicScope({ ...scope, company: "Other" }), false);

  assert.doesNotThrow(() =>
    requireFreshGeneratedAt(
      { generatedAt: new Date(NOW - 60_000).toISOString() },
      "Proof",
      NOW
    )
  );
  for (const generatedAt of [
    "not-a-date",
    new Date(NOW - 5 * 60 * 1_000 - 1).toISOString(),
    new Date(NOW + 2 * 60 * 1_000 + 1).toISOString(),
  ]) {
    assert.throws(() =>
      requireFreshGeneratedAt({ generatedAt }, "Proof", NOW)
    );
  }
});

test("final gate: citation markers are unique, ordered, and bounded", () => {
  assert.equal(
    exactSequentialCitationMarkers(["[1]", "[2]", "[3]"]),
    true
  );
  for (const markers of [
    [],
    ["[1]", "[1]"],
    ["[2]", "[1]"],
    ["[1]", "[3]"],
    ["[1]", "[2]", "[3]", "[4]", "[5]", "[6]"],
    ["[1]", 2],
  ]) {
    assert.equal(exactSequentialCitationMarkers(markers), false);
  }
});

test("final gate: live response metadata rejects redirects, non-JSON, and cached proof", () => {
  const url = "https://d2s5v0o0eg2aaw.cloudfront.net/api/proof";
  assert.equal(
    validLiveResponseMetadata(
      url,
      url,
      "application/json; charset=utf-8",
      "private, no-store"
    ),
    true
  );
  assert.equal(
    validLiveResponseMetadata(
      `${url}/`,
      url,
      "application/json",
      "no-store"
    ),
    false
  );
  assert.equal(
    validLiveResponseMetadata(url, url, "text/json", "no-store"),
    false
  );
  assert.equal(
    validLiveResponseMetadata(url, url, "application/json", "no-cache"),
    false
  );
});

test("final gate: video oEmbed identity is exact for YouTube and Vimeo", () => {
  const youtube = parseCanonicalSubmissionVideoUrl(
    "https://youtu.be/abcdefghijk"
  );
  const vimeo = parseCanonicalSubmissionVideoUrl(
    "https://vimeo.com/123456789"
  );
  assert.ok(youtube);
  assert.ok(vimeo);
  const youtubeOembed = {
    title: "Archon Memory — verifiable agent recall",
    type: "video",
    provider_name: "YouTube",
    html:
      '<iframe src="https://www.youtube.com/embed/abcdefghijk?feature=oembed"></iframe>',
  };
  const vimeoOembed = {
    title: "Archon Memory — verifiable agent recall",
    type: "video",
    provider_name: "Vimeo",
    html:
      '<iframe src="https://player.vimeo.com/video/123456789?app_id=122963"></iframe>',
  };
  assert.equal(validOembedContract(youtubeOembed, youtube), true);
  assert.equal(validOembedContract(vimeoOembed, vimeo), true);
  for (const mutation of [
    { ...youtubeOembed, title: "Unrelated demo" },
    { ...youtubeOembed, type: "photo" },
    { ...youtubeOembed, provider_name: "Vimeo" },
    {
      ...youtubeOembed,
      html: '<iframe src="https://www.youtube.com/embed/wrongvideo1"></iframe>',
    },
    {
      ...youtubeOembed,
      html: '<iframe src="https://example.com/abcdefghijk"></iframe>',
    },
    {
      ...youtubeOembed,
      html:
        '<iframe src="https://www.youtube.com.evil.test/embed/abcdefghijk"></iframe>',
    },
    {
      ...youtubeOembed,
      html:
        '<iframe src="https://www.youtube.com@evil.test/embed/abcdefghijk"></iframe>',
    },
    {
      ...youtubeOembed,
      html:
        '<p>https://www.youtube.com/embed/abcdefghijk</p>',
    },
    {
      ...youtubeOembed,
      html:
        '<!-- <iframe src="https://www.youtube.com/embed/abcdefghijk"></iframe> -->',
    },
    {
      ...youtubeOembed,
      html:
        '<script>const markup = \'<iframe src="https://www.youtube.com/embed/abcdefghijk"></iframe>\';</script>',
    },
    {
      ...youtubeOembed,
      html:
        '<iframe src=https://evil.test src="https://www.youtube.com/embed/abcdefghijk"></iframe>',
    },
  ]) {
    assert.equal(validOembedContract(mutation, youtube), false);
  }
  assert.equal(
    validOembedContract(
      {
        ...vimeoOembed,
        html:
          '<iframe src="https://player.vimeo.com.evil.test/video/123456789"></iframe>',
      },
      vimeo
    ),
    false
  );
});

test("final gate: public Devpost HTML binds challenge, repo, demo, and video", () => {
  const identity = parseCanonicalSubmissionVideoUrl(
    "https://youtu.be/abcdefghijk"
  );
  assert.ok(identity);
  const url =
    "https://devpost.com/software/archon-memory";
  const html = `
    <html><head><title>Archon Memory</title></head><body>
      <h1>Archon Memory</h1>
      <p>CockroachDB &times; AWS Hackathon - Build with Agentic Memory</p>
      <a href="https://cockroachdb-ai.devpost.com/">Challenge</a>
      <a href="https://github.com/upgradedev/archon-cockroach-memory">Source</a>
      <a href="https://d2s5v0o0eg2aaw.cloudfront.net">Demo</a>
      <iframe src="https://www.youtube.com/embed/abcdefghijk"></iframe>
    </body></html>`;
  assert.equal(
    validDevpostPageContract(
      html,
      url,
      url,
      "text/html; charset=utf-8",
      identity
    ),
    true
  );
  for (const mutation of [
    html.replace(/Archon Memory/gu, "Other Project"),
    html.replace(
      "https://cockroachdb-ai.devpost.com/",
      "https://example.com/challenge"
    ),
    html.replace(
      "https://cockroachdb-ai.devpost.com/",
      "https://cockroachdb-ai.devpost.com.evil.test/"
    ),
    html.replace(
      "CockroachDB &times; AWS Hackathon - Build with Agentic Memory",
      "Other Hackathon"
    ),
    html.replace(
      "https://github.com/upgradedev/archon-cockroach-memory",
      "https://github.com/example/project"
    ),
    html.replace(
      "https://github.com/upgradedev/archon-cockroach-memory",
      "https://github.com.evil.test/upgradedev/archon-cockroach-memory"
    ),
    html.replace(
      "https://d2s5v0o0eg2aaw.cloudfront.net",
      "https://example.com/demo"
    ),
    html.replace(
      "https://d2s5v0o0eg2aaw.cloudfront.net",
      "https://d2s5v0o0eg2aaw.cloudfront.net.evil.test"
    ),
    html.replace(/abcdefghijk/gu, "wrongvideo1"),
    html.replace(
      "https://www.youtube.com/embed/abcdefghijk",
      "https://www.youtube.com.evil.test/embed/abcdefghijk"
    ),
    html.replace("&times;", "&amp;times;"),
  ]) {
    assert.equal(
      validDevpostPageContract(
        mutation,
        url,
        url,
        "text/html",
        identity
      ),
      false
    );
  }
  assert.equal(
    validDevpostPageContract(
      html,
      `${url}/`,
      url,
      "text/html",
      identity
    ),
    false
  );
  assert.equal(
    validDevpostPageContract(
      html,
      url,
      url,
      "application/xhtml+xml",
      identity
    ),
    false
  );
  const requiredMarkup = `
    <a href="https://cockroachdb-ai.devpost.com/">Challenge</a>
    <a href="https://github.com/upgradedev/archon-cockroach-memory">Source</a>
    <a href="https://d2s5v0o0eg2aaw.cloudfront.net">Demo</a>
    <iframe src="https://www.youtube.com/embed/abcdefghijk"></iframe>`;
  for (const deadMarkup of [
    `<!-- ${requiredMarkup} -->`,
    `<script>const dead = ${JSON.stringify(requiredMarkup)};</script>`,
    `<template>${requiredMarkup}</template>`,
    `<template><template></template>${requiredMarkup}</template>`,
    `<template><script>const close = "</template>";</script>${requiredMarkup}</template>`,
    `<script></script_>${requiredMarkup}</script>`,
    `<script><!--<script></script>${requiredMarkup}`,
    `<plaintext>${requiredMarkup}`,
  ]) {
    assert.equal(
      validDevpostPageContract(
        `<html><body>
          <h1>Archon Memory</h1>
          <p>CockroachDB × AWS Hackathon - Build with Agentic Memory</p>
          ${deadMarkup}
        </body></html>`,
        url,
        url,
        "text/html",
        identity
      ),
      false
    );
  }
  assert.equal(
    validDevpostPageContract(
      html
        .replace(
          "<h1>Archon Memory</h1>",
          "<h1>Other project</h1><!-- Archon Memory -->"
        )
        .replace(
          "<p>CockroachDB &times; AWS Hackathon - Build with Agentic Memory</p>",
          "<p>Other challenge</p><script>CockroachDB × AWS Hackathon - Build with Agentic Memory</script>"
        ),
      url,
      url,
      "text/html",
      identity
    ),
    false
  );
  assert.equal(
    validDevpostPageContract(
      html.replace(
        '<a href="https://cockroachdb-ai.devpost.com/">',
        '<a href=https://evil.test href="https://cockroachdb-ai.devpost.com/">'
      ),
      url,
      url,
      "text/html",
      identity
    ),
    false
  );
  assert.equal(
    validDevpostPageContract(
      html.replace(
        '<iframe src="https://www.youtube.com/embed/abcdefghijk">',
        '<iframe src=https://evil.test src="https://www.youtube.com/embed/abcdefghijk">'
      ),
      url,
      url,
      "text/html",
      identity
    ),
    false
  );
  assert.equal(
    validDevpostPageContract(
      `<html><body>
        <h1>Archon Memory</h1>
        <p>CockroachDB × AWS Hackathon - Build with Agentic Memory</p>
        <a data-href="https://cockroachdb-ai.devpost.com/">Challenge</a>
        <a data-href="https://github.com/upgradedev/archon-cockroach-memory">Source</a>
        <a data-href="https://d2s5v0o0eg2aaw.cloudfront.net">Demo</a>
        <iframe data-src="https://www.youtube.com/embed/abcdefghijk"></iframe>
      </body></html>`,
      url,
      url,
      "text/html",
      identity
    ),
    false
  );
  assert.equal(
    validDevpostPageContract(
      `<html><body>
        <h1>Archon Memory</h1>
        <p>CockroachDB × AWS Hackathon - Build with Agentic Memory</p>
        <!-- ${requiredMarkup}
      </body></html>`,
      url,
      url,
      "text/html",
      identity
    ),
    false
  );
});

test("final gate: submission metadata requires one exact value per key", () => {
  const exact = `status: submission-copy-complete
repository: https://github.com/upgradedev/archon-cockroach-memory
demo: https://d2s5v0o0eg2aaw.cloudfront.net`;
  assert.equal(validSubmissionCopyMetadata(exact), true);
  for (const invalid of [
    `${exact}
repository: https://github.com/example/project`,
    `${exact}
demo: https://example.com`,
    exact.replace(
      "repository: https://github.com/upgradedev/archon-cockroach-memory",
      "repository: https://github.com/upgradedev/archon-cockroach-memory.evil.test"
    ),
    exact.replace(
      "demo: https://d2s5v0o0eg2aaw.cloudfront.net",
      "demo: https://d2s5v0o0eg2aaw.cloudfront.net.evil.test"
    ),
  ]) {
    assert.equal(validSubmissionCopyMetadata(invalid), false);
  }
});

test("final gate: receipt downloads stop at the configured byte bound", async () => {
  const exact = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4]));
        controller.close();
      },
    })
  );
  assert.deepEqual(
    [...(await readBoundedResponseBody(exact, "fixture", 4))],
    [1, 2, 3, 4]
  );

  const oversized = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5]));
        controller.close();
      },
    })
  );
  await assert.rejects(
    readBoundedResponseBody(oversized, "fixture", 4),
    /exceeds its byte bound/u
  );
});

test("final gate: demo-video run, four jobs, and rerun-safe artifacts are exact", () => {
  const run = workflowRun({
    id: 701,
    name: "Generate exact-release demo video",
    display_title: "Demo video fixture",
    path: ".github/workflows/demo-video.yml",
    event: "workflow_dispatch",
    run_attempt: 2,
    run_started_at: "2026-07-29T12:00:00.000Z",
    updated_at: "2026-07-29T12:05:00.000Z",
  });
  assert.equal(
    selectBoundSuccessfulDemoVideoRun(
      [run],
      SHA,
      run.id,
      run.run_attempt,
      NOW
    ).id,
    run.id
  );
  const attempts = {
    sourceGate: 1,
    narrate: 1,
    capture: 1,
    buildVerify: 2,
  };
  const mixedAttemptJobs = demoVideoJobs(run.id, SHA, attempts);
  const jobHistory = mixedAttemptJobs.jobs as Array<
    Record<string, unknown>
  >;
  jobHistory.push({
    ...structuredClone(jobHistory[3]!),
    id: 714,
    run_attempt: 1,
    status: "completed",
    conclusion: "failure",
  });
  mixedAttemptJobs.total_count = 5;
  assert.deepEqual(
    requireSuccessfulDemoVideoJobs(
      mixedAttemptJobs,
      run.id,
      SHA,
      run.run_attempt
    ),
    attempts
  );

  const packageName =
    `archon-demo-video-${SHA}-${run.id}-${run.run_attempt}`;
  const provenanceName =
    `archon-demo-video-provenance-${SHA}-${run.id}-${run.run_attempt}`;
  const priorName = `archon-demo-video-${SHA}-${run.id}-1`;
  const releaseArtifact = {
    ...workflowArtifact(
      804,
      `demo-video-release-${SHA}-${run.id}-${attempts.sourceGate}`,
      run,
      8_192,
      "d"
    ),
    created_at: "2026-07-28T12:01:00.000Z",
    updated_at: "2026-07-28T12:02:00.000Z",
  };
  const narrationArtifact = workflowArtifact(
    805,
    `demo-video-narration-${SHA}-${run.id}-${attempts.narrate}`,
    run,
    2_000_000,
    "e"
  );
  const captureArtifact = workflowArtifact(
    806,
    `demo-video-capture-${SHA}-${run.id}-${attempts.capture}`,
    run,
    100_000_000,
    "f"
  );
  const packageArtifact = workflowArtifact(
    801,
    packageName,
    run,
    50_000_000,
    "a"
  );
  const provenanceArtifact = workflowArtifact(
    802,
    provenanceName,
    run,
    1_024,
    "b"
  );
  const priorArtifact = {
    ...workflowArtifact(
      803,
      priorName,
      run,
      45_000_000,
      "c",
      true
    ),
    created_at: "2026-07-28T12:04:00.000Z",
    updated_at: "2026-07-28T12:04:30.000Z",
  };
  const inventory = {
    total_count: 6,
    artifacts: [
      priorArtifact,
      releaseArtifact,
      narrationArtifact,
      captureArtifact,
      packageArtifact,
      provenanceArtifact,
    ],
  };
  const selected = selectExactDemoVideoArtifacts(
    inventory,
    run,
    SHA,
    attempts,
    NOW
  );
  assert.equal(selected.release.id, 804);
  assert.equal(selected.narration.id, 805);
  assert.equal(selected.capture.id, 806);
  assert.equal(selected.package.id, 801);
  assert.equal(selected.provenance.id, 802);

  assert.throws(() =>
    selectBoundSuccessfulDemoVideoRun(
      [run],
      SHA,
      run.id,
      1,
      NOW
    )
  );
  const missingTerminal = structuredClone(
    demoVideoJobs(run.id, SHA, attempts)
  );
  const build = (
    missingTerminal.jobs as Array<Record<string, unknown>>
  )[3]!;
  build.steps = (build.steps as Array<Record<string, unknown>>).filter(
    (step) =>
      step.name !== "Revalidate exact main after artifact publication"
  );
  assert.throws(
    () =>
      requireSuccessfulDemoVideoJobs(
        missingTerminal,
        run.id,
        SHA,
        run.run_attempt
      ),
    /Revalidate exact main/u
  );
  const duplicateJobAttempt = structuredClone(
    demoVideoJobs(run.id, SHA, attempts)
  );
  const duplicateJobs = duplicateJobAttempt.jobs as Array<
    Record<string, unknown>
  >;
  duplicateJobs.push({
    ...structuredClone(duplicateJobs[0]!),
    id: 715,
  });
  duplicateJobAttempt.total_count = 5;
  assert.throws(
    () =>
      requireSuccessfulDemoVideoJobs(
        duplicateJobAttempt,
        run.id,
        SHA,
        run.run_attempt
      ),
    /duplicated/u
  );
  const malformedJobHistory = structuredClone(
    demoVideoJobs(run.id, SHA, attempts)
  );
  (malformedJobHistory.jobs as Array<unknown>).push(
    "malformed extra job"
  );
  assert.throws(
    () =>
      requireSuccessfulDemoVideoJobs(
        malformedJobHistory,
        run.id,
        SHA,
        run.run_attempt
      ),
    /incomplete/u
  );
  assert.throws(
    () =>
      requireSuccessfulDemoVideoJobs(
        demoVideoJobs(run.id, SHA),
        run.id,
        SHA,
        run.run_attempt
      ),
    /current workflow attempt/u
  );
  assert.throws(
    () =>
      selectExactDemoVideoArtifacts(
        {
          total_count: 7,
          artifacts: [
            priorArtifact,
            releaseArtifact,
            narrationArtifact,
            captureArtifact,
            packageArtifact,
            provenanceArtifact,
            {
              ...packageArtifact,
              id: 807,
              archive_download_url:
                "https://api.github.com/repos/upgradedev/archon-cockroach-memory/actions/artifacts/807/zip",
            },
          ],
        },
        run,
        SHA,
        attempts,
        NOW
      ),
    /duplicate/u
  );
});

test("final gate: small publication provenance binds the large CI video without downloading it", () => {
  const run = workflowRun({
    id: 901,
    name: "Generate exact-release demo video",
    path: ".github/workflows/demo-video.yml",
    event: "workflow_dispatch",
    run_attempt: 3,
  });
  const packageName =
    `archon-demo-video-${SHA}-${run.id}-${run.run_attempt}`;
  const artifactRecord = workflowArtifact(
    902,
    packageName,
    run,
    60_000_000,
    "d"
  );
  const parsed = parseWorkflowArtifacts(
    { total_count: 1, artifacts: [artifactRecord] },
    2_000_000_000
  )[0]!;
  const sourceSha = "e".repeat(64);
  const receipt = {
    schema: "archon.demo-video-publication",
    version: 1,
    releaseSha: SHA,
    workflowRunId: run.id,
    workflowRunAttempt: run.run_attempt,
    voiceRightsAttested: true,
    packageArtifact: {
      id: parsed.id,
      name: parsed.name,
      digest: parsed.digest,
    },
    media: {
      mp4Sha256: sourceSha,
      mp4Bytes: 55_000_000,
      measuredDurationSeconds: 170.004,
      captionsSha256: "f".repeat(64),
      verificationReceiptSha256: "1".repeat(64),
    },
  };
  assert.deepEqual(
    requireExactDemoVideoPublication(receipt, {
      run,
      packageArtifact: parsed,
      sha: SHA,
      sourceSha256: sourceSha,
      durationSeconds: 170,
    }),
    receipt
  );
  for (const invalid of [
    { ...receipt, voiceRightsAttested: false },
    {
      ...receipt,
      packageArtifact: {
        ...receipt.packageArtifact,
        digest: `sha256:${"2".repeat(64)}`,
      },
    },
    {
      ...receipt,
      media: {
        ...receipt.media,
        mp4Sha256: "3".repeat(64),
      },
    },
  ]) {
    assert.throws(() =>
      requireExactDemoVideoPublication(invalid, {
        run,
        packageArtifact: parsed,
        sha: SHA,
        sourceSha256: sourceSha,
        durationSeconds: 170,
      })
    );
  }
});

test("final gate: pre-submit display title binds public and CI video identity", () => {
  const url = "https://youtu.be/abcdefghijk";
  const runId = "12345";
  const attempt = "2";
  const sourceSha = "f".repeat(64);
  const expected =
    `Submission readiness / pre-submit / ${SHA} / ${url} / 178s / ` +
    `CI ${runId}.${attempt} / ${sourceSha}`;
  assert.equal(
    expectedPreSubmitDisplayTitle(
      SHA,
      url,
      "178",
      runId,
      attempt,
      sourceSha
    ),
    expected
  );
  assert.notEqual(
    expectedPreSubmitDisplayTitle(
      SHA,
      url,
      "177",
      runId,
      attempt,
      sourceSha
    ),
    expected
  );
  assert.notEqual(
    expectedPreSubmitDisplayTitle(
      "b".repeat(40),
      url,
      "178",
      runId,
      attempt,
      sourceSha
    ),
    expected
  );
  assert.notEqual(
    expectedPreSubmitDisplayTitle(
      SHA,
      url,
      "178",
      runId,
      "3",
      sourceSha
    ),
    expected
  );
});
