import { test } from "node:test";
import assert from "node:assert/strict";
import {
  exactPublicScope,
  exactSequentialCitationMarkers,
  expectedPreSubmitDisplayTitle,
  type GitHubWorkflowRun,
  parseWorkflowJobs,
  parseWorkflowRuns,
  requireFreshGeneratedAt,
  requirePostDeployAuditTiming,
  requireSuccessfulRecoveryAuditJobs,
  selectSuccessfulRun,
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

test("final gate: recovery audit proves both exact jobs and executed evidence steps", () => {
  const baseline = recoveryJobs();
  const parsed = parseWorkflowJobs(baseline);
  assert.equal(parsed.totalCount, 2);
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

test("final gate: post-deploy audits must be ordered, completed, and fresh", () => {
  const deploy = workflowRun({
    id: 201,
    name: "Deploy AWS",
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
    requirePostDeployAuditTiming(deploy, mcp, recovery, NOW)
  );
  assert.throws(() =>
    requirePostDeployAuditTiming(
      deploy,
      { ...mcp, run_started_at: deploy.updated_at },
      recovery,
      NOW
    )
  );
  assert.throws(() =>
    requirePostDeployAuditTiming(
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
      mcp,
      recovery,
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
      '<iframe src="https://www.youtube.com/embed/abcdefghijk"></iframe>',
  };
  const vimeoOembed = {
    title: "Archon Memory — verifiable agent recall",
    type: "video",
    provider_name: "Vimeo",
    html:
      '<iframe src="https://player.vimeo.com/video/123456789"></iframe>',
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
  ]) {
    assert.equal(validOembedContract(mutation, youtube), false);
  }
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
      "CockroachDB &times; AWS Hackathon - Build with Agentic Memory",
      "Other Hackathon"
    ),
    html.replace(
      "https://github.com/upgradedev/archon-cockroach-memory",
      "https://github.com/example/project"
    ),
    html.replace(
      "https://d2s5v0o0eg2aaw.cloudfront.net",
      "https://example.com/demo"
    ),
    html.replace(/abcdefghijk/gu, "wrongvideo1"),
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
});

test("final gate: pre-submit display title binds SHA, video, and duration", () => {
  const url = "https://youtu.be/abcdefghijk";
  const expected =
    `Submission readiness / pre-submit / ${SHA} / ${url} / 178s`;
  assert.equal(
    expectedPreSubmitDisplayTitle(SHA, url, "178"),
    expected
  );
  assert.notEqual(
    expectedPreSubmitDisplayTitle(SHA, url, "177"),
    expected
  );
  assert.notEqual(
    expectedPreSubmitDisplayTitle("b".repeat(40), url, "178"),
    expected
  );
});
