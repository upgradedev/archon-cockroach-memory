// Source-readiness + submission-eligibility report for the CockroachDB AI
// challenge. These are deliberately separate:
//
// - CI blocks on engineering evidence that can be verified from the repository.
// - The report never calls the submission eligible until the unrestricted hosted
//   app, public <3-minute video, final description, and Devpost form exist.
//
// By default this command prints only. CI opts into an artifact with:
//   READINESS_OUTPUT=readiness.json npm run readiness
// Final submission validation additionally sets REQUIRE_SUBMISSION_READY=1 and
// supplies the SUBMISSION_* environment variables below.

import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SOURCE_FLOOR = Number(process.env.SOURCE_READINESS_FLOOR ?? 100);

export const OFFICIAL_CRITERIA = [
  "Agentic Memory Design",
  "Technological Implementation",
  "Real-World Impact",
  "Product Readiness",
  "Creativity & Originality",
] as const;

export type OfficialCriterion = (typeof OFFICIAL_CRITERIA)[number];
export type CheckStatus = "pass" | "fail";

export interface SourceCheck {
  id: string;
  criterion: OfficialCriterion;
  status: CheckStatus;
  detail: string;
}

export interface EligibilityRequirement {
  id: string;
  status: "complete" | "pending";
  detail: string;
}

export interface ReadinessReport {
  generatedAt: string;
  checks: SourceCheck[];
  judging: Record<
    OfficialCriterion,
    { passed: number; total: number; pct: number }
  >;
  sourceGate: {
    threshold: number;
    passed: number;
    total: number;
    pct: number;
    pass: boolean;
  };
  eligibility: {
    requirements: EligibilityRequirement[];
    complete: number;
    total: number;
    pass: boolean;
  };
  submissionEligible: boolean;
}

function path(rel: string): string {
  return join(ROOT, rel);
}

function has(rel: string): boolean {
  return existsSync(path(rel));
}

function read(rel: string): string {
  return has(rel) ? readFileSync(path(rel), "utf8") : "";
}

function generatedArtifactPaths(): string[] {
  const blockedDirectories = new Set([
    ".aws-sam",
    "__pycache__",
    "coverage",
    "playwright-report",
    "test-results",
  ]);
  const blockedDemoDirectories = new Set(["audio", "clips", "frames"]);
  const found: string[] = [];
  const visit = (absolute: string, relative: string): void => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const childRelative = relative
        ? `${relative}/${entry.name}`
        : entry.name;
      if (entry.isDirectory()) {
        // Dependency trees are required to execute this gate and are already
        // protected by .gitignore/secret scanning. Do not recurse through them.
        if (entry.name === "node_modules") continue;
        if (
          blockedDirectories.has(entry.name) ||
          (relative === "demo/assets" &&
            blockedDemoDirectories.has(entry.name))
        ) {
          found.push(childRelative);
          continue;
        }
        visit(join(absolute, entry.name), childRelative);
      } else if (
        /\.(?:mp4|pyc)$/iu.test(entry.name) ||
        /^(?:readiness|database-release-receipt|managed-mcp(?:-[a-z0-9-]+)?-receipt|deployment-receipt[a-z0-9-]*|[a-z0-9-]+-deployment-receipt)\.json$/iu.test(
          entry.name
        )
      ) {
        found.push(childRelative);
      }
    }
  };
  visit(ROOT, "");
  return found;
}

function contains(rel: string, pattern: RegExp): boolean {
  return pattern.test(read(rel));
}

function sourceCheck(
  id: string,
  criterion: OfficialCriterion,
  condition: boolean,
  passed: string,
  failed: string
): SourceCheck {
  return {
    id,
    criterion,
    status: condition ? "pass" : "fail",
    detail: condition ? passed : failed,
  };
}

function sourceChecks(): SourceCheck[] {
  const schema = read("src/db/schema.sql");
  const ci = read(".github/workflows/ci.yml");
  const deploy = read(".github/workflows/deploy-aws.yml");
  const lambdaTemplate = read("aws/template.yaml");
  const dockerfile = read("aws/Dockerfile");
  const narrator = read("src/agents/narrator.ts");
  const handler = read("src/http/handler.ts");
  const localArtifacts = generatedArtifactPaths();
  const workflowSources = [
    ci,
    deploy,
    read(".github/workflows/database-release.yml"),
    read(".github/workflows/managed-mcp-audit.yml"),
    read(".github/workflows/benchmark.yml"),
    read(".github/workflows/codeql.yml"),
  ].join("\n");
  const unpinnedActions = [
    ...workflowSources.matchAll(/uses:\s+\S+@v\d+/gu),
  ];

  return [
    sourceCheck(
      "memory.native-vector-lifecycle",
      "Agentic Memory Design",
      /CREATE\s+VECTOR\s+INDEX/iu.test(schema) &&
        /embed_model/iu.test(schema) &&
        /idempotency_key/iu.test(schema) &&
        /superseded_by/iu.test(schema),
      "Native C-SPANN indexes and durable idempotency/model/lifecycle fields are explicit.",
      "Native vector or durable lifecycle evidence is incomplete."
    ),
    sourceCheck(
      "memory.role-bound-scope",
      "Agentic Memory Design",
      /archon_public_reader/iu.test(schema) &&
        /TO\s+archon_public_reader/iu.test(schema) &&
        /company\s*=\s*'Helios SA'/iu.test(schema) &&
        !/current_setting\('application_name'/iu.test(schema),
      "CockroachDB RLS binds the read-only runtime role to the fixed synthetic tenant and company.",
      "Role-bound fixed-scope RLS is missing or still depends on mutable application_name."
    ),
    sourceCheck(
      "memory.managed-mcp",
      "Agentic Memory Design",
      has("scripts/cloud-mcp-audit.ts") &&
        has(".github/workflows/managed-mcp-audit.yml") &&
        contains("docs/MANAGED_MCP_SMOKE.md", /live read-only proof/iu),
      "The live CockroachDB Cloud Managed MCP integration has a bounded read-only audit and receipt workflow.",
      "Managed MCP source, workflow, or live evidence document is missing."
    ),
    sourceCheck(
      "tech.ci-matrix",
      "Technological Implementation",
      /frontend-iac:/u.test(ci) &&
        /cluster-survival:/u.test(ci) &&
        /pen-test:/u.test(ci) &&
        /load:/u.test(ci) &&
        /test:e2e/iu.test(ci),
      "CI gates backend, real CockroachDB, node loss, security, load, frontend, SAM, and browser journeys.",
      "One or more release-critical CI jobs are missing."
    ),
    sourceCheck(
      "tech.immutable-supply-chain",
      "Technological Implementation",
      unpinnedActions.length === 0 &&
        /cockroachdb\/cockroach:v26\.2\.3@sha256:/u.test(ci) &&
        /node-version:\s*22/u.test(ci) &&
        /^FROM\s+\S+@sha256:[a-f0-9]{64}$/mu.test(dockerfile) &&
        has("package-lock.json") &&
        has("web/package-lock.json"),
      "Actions, CockroachDB image, runtime, and lockfiles are immutable/reproducible.",
      "A mutable Action/image/runtime reference remains."
    ),
    sourceCheck(
      "tech.bedrock-grounding",
      "Technological Implementation",
      /checks:\s*\{[\s\S]*claims:\s*boolean/iu.test(narrator) &&
        /RECALL_MIN_SCORE/iu.test(handler) &&
        /citation/iu.test(narrator),
      "Bedrock narration is guarded by relevance abstention, per-claim citations, numeric checks, and fallback.",
      "Grounding or relevance-abstention controls are incomplete."
    ),
    sourceCheck(
      "impact.working-slice",
      "Real-World Impact",
      contains("README.md", /Financial Memory Control Room/iu) &&
        contains("README.md", /fixed synthetic/iu) &&
        contains("README.md", /working challenge slice/iu),
      "README defines the concrete CFO investigation slice without presenting the broader vision as shipped.",
      "The current working product slice is not stated precisely."
    ),
    sourceCheck(
      "impact.audit-before-action",
      "Real-World Impact",
      has("src/memory/consistency.ts") &&
        has("web/src/components/AuditLedger.tsx") &&
        /contradiction/iu.test(read("src/memory/consistency.ts")) &&
        /No automatic mutation/iu.test(read("web/src/components/AuditLedger.tsx")),
      "Contradictions and missing evidence are exposed as read-only recommendations before action.",
      "The accountable contradiction/absence user journey is incomplete."
    ),
    sourceCheck(
      "impact.public-data-boundary",
      "Real-World Impact",
      /dataClassification:\s*"synthetic-public-demo"/u.test(
        read("src/config/scope.ts")
      ) &&
        /Public,?\s+read-only demonstration data/iu.test(
          read("web/src/components/Hero.tsx")
        ),
      "The judge app is explicitly fixed to synthetic public data with no tenant selector.",
      "The public data classification/boundary is unclear."
    ),
    sourceCheck(
      "product.aws-reference-architecture",
      "Product Readiness",
      /AWS::CloudFront::Distribution/u.test(lambdaTemplate) &&
        /AWS::Serverless::HttpApi/u.test(lambdaTemplate) &&
        /AWS::Serverless::Function/u.test(lambdaTemplate) &&
        /AWS::S3::Bucket/u.test(lambdaTemplate) &&
        /DATABASE_SECRET_ID/u.test(lambdaTemplate),
      "SAM defines private S3 + OAC/CloudFront, HTTP API, Lambda, Secrets Manager, alarms, and tracing.",
      "The deployable AWS reference architecture is incomplete."
    ),
    sourceCheck(
      "product.oidc-promotion-rollback",
      "Product Readiness",
      has("aws/bootstrap-oidc.yaml") &&
        /AssumeRoleWithWebIdentity/u.test(read("aws/bootstrap-oidc.yaml")) &&
        /Verify candidate tree hashes/iu.test(deploy) &&
        /Restore the previous production release/iu.test(deploy) &&
        /Hosted Chromium judge journey on staging/iu.test(deploy),
      "Environment-bound OIDC, build-once promotion, hash verification, hosted E2E, and rollback are source-controlled.",
      "OIDC/promotion/hosted verification/rollback evidence is incomplete."
    ),
    sourceCheck(
      "product.no-local-build-products",
      "Product Readiness",
      localArtifacts.length === 0 && !has("web/dist"),
      "No local build/video products are left in the repository workspace.",
      "Local build or generated video artifacts remain."
    ),
    sourceCheck(
      "creativity.memory-disagrees",
      "Creativity & Originality",
      /auditConsistency/iu.test(read("src/agents/memory-agent.ts")) &&
        /contradictions/iu.test(read("src/memory/consistency.ts")) &&
        /absences/iu.test(read("src/memory/consistency.ts")),
      "The memory does more than retrieve: it surfaces cross-session disagreement and missing counterparts.",
      "The contradiction/absence memory differentiator is incomplete."
    ),
    sourceCheck(
      "creativity.live-proof-ledger",
      "Creativity & Originality",
      /pg_catalog\.pg_indexes/iu.test(handler) &&
        /runtimePrincipal/iu.test(handler) &&
        has("web/src/components/ProofLedger.tsx"),
      "The UI exposes a live, catalog-backed infrastructure and model proof ledger.",
      "The proof ledger is static or lacks live catalog evidence."
    ),
    sourceCheck(
      "creativity.provenance-receipts",
      "Creativity & Originality",
      has("aws/create-deployment-receipt.mjs") &&
        /buildOncePromoteSameArtifact/iu.test(
          read("aws/create-deployment-receipt.mjs")
        ) &&
        /citation and numeric grounding guard/iu.test(handler),
      "Evidence citations and cryptographic deployment receipts make provenance visible at both product and delivery layers.",
      "Product/deployment provenance evidence is incomplete."
    ),
  ];
}

function validHostedUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !/lambda-url\.us-west-2\.on\.aws$/iu.test(url.hostname)
    );
  } catch {
    return false;
  }
}

function eligibilityRequirements(): EligibilityRequirement[] {
  const demoUrl = process.env.SUBMISSION_DEMO_URL?.trim();
  const videoUrl = process.env.SUBMISSION_VIDEO_URL?.trim();
  const publicRepoUrl =
    process.env.SUBMISSION_PUBLIC_REPO_URL?.trim() ||
    "https://github.com/upgradedev/archon-cockroach-memory";

  const requirement = (
    id: string,
    complete: boolean,
    done: string,
    pending: string
  ): EligibilityRequirement => ({
    id,
    status: complete ? "complete" : "pending",
    detail: complete ? done : pending,
  });

  return [
    requirement(
      "public-repository-and-license",
      has("LICENSE") &&
        /github\.com\/upgradedev\/archon-cockroach-memory/iu.test(publicRepoUrl),
      "Public GitHub repository target and MIT license are identified.",
      "Confirm the public repository URL and OSI license."
    ),
    requirement(
      "unrestricted-functional-demo",
      validHostedUrl(demoUrl),
      `Unrestricted HTTPS demo supplied: ${demoUrl}`,
      "Set SUBMISSION_DEMO_URL after production CloudFront hosted smoke/E2E passes."
    ),
    requirement(
      "public-under-three-minute-video",
      Boolean(
        videoUrl &&
          /^https:\/\/(?:www\.)?(?:youtube\.com|youtu\.be|vimeo\.com)\//iu.test(
            videoUrl
          )
      ),
      `Public YouTube/Vimeo demo supplied: ${videoUrl}`,
      "Set SUBMISSION_VIDEO_URL only after the final public <3-minute browser/memory demo is uploaded."
    ),
    requirement(
      "english-description-and-tool-identification",
      has("docs/DEVPOST_SUBMISSION.md") &&
        contains("docs/DEVPOST_SUBMISSION.md", /Managed MCP/iu) &&
        contains("docs/DEVPOST_SUBMISSION.md", /Distributed Vector/iu) &&
        contains("docs/DEVPOST_SUBMISSION.md", /AWS/iu),
      "Final English Devpost description identifies the CockroachDB and AWS tools.",
      "Create docs/DEVPOST_SUBMISSION.md at the final submission phase."
    ),
    requirement(
      "prior-work-disclosure",
      contains("README.md", /Prior-work disclosure/iu) &&
        contains("README.md", /pre-existing/iu) &&
        contains("README.md", /challenge-period/iu),
      "README separates pre-existing Archon work from challenge-period implementation.",
      "Add an explicit prior-work disclosure."
    ),
    requirement(
      "devpost-submitted",
      process.env.DEVPOST_SUBMITTED === "1",
      "Operator confirmed the Devpost form is submitted.",
      "Set DEVPOST_SUBMITTED=1 only after the final form has been submitted."
    ),
  ];
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

export function evaluate(): ReadinessReport {
  const checks = sourceChecks();
  const judging = Object.fromEntries(
    OFFICIAL_CRITERIA.map((criterion) => {
      const group = checks.filter((check) => check.criterion === criterion);
      const passed = group.filter((check) => check.status === "pass").length;
      return [
        criterion,
        {
          passed,
          total: group.length,
          pct: group.length ? round((passed / group.length) * 100) : 0,
        },
      ];
    })
  ) as ReadinessReport["judging"];

  const passed = checks.filter((check) => check.status === "pass").length;
  const pct = checks.length ? round((passed / checks.length) * 100) : 0;
  const requirements = eligibilityRequirements();
  const eligibilityComplete = requirements.filter(
    (requirement) => requirement.status === "complete"
  ).length;
  const eligibilityPass = eligibilityComplete === requirements.length;

  return {
    generatedAt: new Date().toISOString(),
    checks,
    judging,
    sourceGate: {
      threshold: SOURCE_FLOOR,
      passed,
      total: checks.length,
      pct,
      pass: pct >= SOURCE_FLOOR,
    },
    eligibility: {
      requirements,
      complete: eligibilityComplete,
      total: requirements.length,
      pass: eligibilityPass,
    },
    submissionEligible: eligibilityPass,
  };
}

function printReport(report: ReadinessReport): void {
  console.log("\nARCHON MEMORY — SOURCE READINESS / SUBMISSION ELIGIBILITY");
  for (const criterion of OFFICIAL_CRITERIA) {
    const score = report.judging[criterion];
    console.log(`\n${criterion}: ${score.pct}% (${score.passed}/${score.total})`);
    for (const check of report.checks.filter(
      (item) => item.criterion === criterion
    )) {
      console.log(`  ${check.status === "pass" ? "PASS" : "FAIL"} ${check.id} — ${check.detail}`);
    }
  }
  console.log(
    `\nSOURCE GATE: ${report.sourceGate.pass ? "PASS" : "FAIL"} ` +
      `${report.sourceGate.pct}% (floor ${report.sourceGate.threshold}%)`
  );
  console.log(
    `SUBMISSION ELIGIBLE: ${report.submissionEligible ? "YES" : "NO"} ` +
      `(${report.eligibility.complete}/${report.eligibility.total})`
  );
  for (const item of report.eligibility.requirements) {
    console.log(`  ${item.status.toUpperCase()} ${item.id} — ${item.detail}`);
  }
  console.log();
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
const isMain = invokedPath === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const report = evaluate();
  const output = process.env.READINESS_OUTPUT?.trim();
  if (output) {
    writeFileSync(resolve(ROOT, output), `${JSON.stringify(report, null, 2)}\n`);
  }
  printReport(report);
  if (!report.sourceGate.pass) process.exitCode = 1;
  if (
    process.env.REQUIRE_SUBMISSION_READY === "1" &&
    !report.submissionEligible
  ) {
    process.exitCode = 1;
  }
}
