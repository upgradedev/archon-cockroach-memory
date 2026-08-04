# Supply-chain security

Status: enforced, zero accepted waivers

**Latest hosted evidence:** [Supply Chain (enforced) run
30911931358](https://github.com/upgradedev/archon-cockroach-memory/actions/runs/30911931358),
successful on `main` at commit `93dfa73`, 2026-08-04. That run is where the
"zero accepted waivers" claim is checkable: it evaluates the `waivers.yml`
ledger against its `waiver-ledger.sha256` digest as part of the gate.

This document defines the hosted pipeline boundary added for source classes
that CodeQL does not analyze and for release dependency evidence. It does not
claim independent penetration testing, legal review, or a vulnerability-free
release.

## Coverage

| Surface | Control | Enforced behavior |
| --- | --- | --- |
| TypeScript semantic SAST | CodeQL 3.37.3 `security-and-quality` | `security-severity >= 7.0` or SARIF `level=error` blocks; SARIF is uploaded first |
| Tracked `*.sh` files | ShellCheck 0.11.0 | Any warning-or-higher finding blocks |
| GitHub workflow semantics and inline shell | actionlint 1.7.12 + ShellCheck | Any effective finding blocks; the exact, source-validated `concurrency.queue` parser compatibility boundary below is retained as raw evidence |
| GitHub workflow security | zizmor 1.28.0 regular persona | Any JSON-policy finding blocks; SARIF is retained |
| CloudFormation syntax | cfn-lint 1.53.1 | Findings block across application, bootstrap, edge WAF, and FinOps templates |
| SAM validity and packageability | SAM CLI 1.164.0 | `sam validate --lint` and the canonical build must pass |
| CloudFormation/SAM policy | CloudFormation Guard 3.2.0 | Rule fixtures and every current-template rule must pass |
| CloudFormation and any reintroduced Dockerfile | Trivy 0.72.0 | Medium, High, and Critical findings block except the three exact, source-validated CloudFormation-expression/platform compatibility boundaries below; raw JSON/SARIF is retained |
| Dependency changes in pull requests | GitHub Dependency Review v5.0.0 | Blocks new Moderate+ vulnerabilities and invalid licenses |
| Backend/frontend JavaScript dependency inventory | Syft 1.50.0 SPDX + CycloneDX + native Syft JSON | The lockfile and package catalogers, document schemas, and exact cataloger set are blocking |
| Canonical Lambda ZIP content | SAM build + Syft file/dependency inventory | Generation and manifest checks block |
| Backend, frontend, and Lambda-content SBOM vulnerabilities/licenses | Trivy 0.72.0 + deterministic Syft/lockfile validator | Unknown, Medium, High, and Critical findings block except the four exact build-only license classifications below; raw findings are retained |

The standalone ShellCheck, actionlint, zizmor, Guard, Trivy, and Syft binaries,
their release URLs and SHA-256 digests, plus every GitHub Action commit, are
recorded in `.github/toolchain-lock.json`. Those installations accept only
immutable release assets and verify their digest before execution. cfn-lint is
pinned to version `1.53.1`, matching the existing CI and deploy validation
paths, but its pip transitive environment is not claimed to be byte-for-byte
reproducible. No `latest` reference or `curl | sh` installer is accepted.

## Canonical release artifact

The canonical AWS path is the SAM build used by `deploy-aws.yml`: an esbuild
Lambda ZIP-content directory plus the static web build. The supply-chain
workflow runs the same pinned Node and SAM CLI versions, builds the
`ArchonFunction` content in an ephemeral runner directory, produces SPDX and
CycloneDX documents for that content, and records a sorted SHA-256 content
manifest.

The SBOM is intentionally split:

- backend and frontend component SBOMs describe the resolved JavaScript package
  dependency graphs, including development dependencies. Their cataloger set is
  fail-closed to Syft's `javascript-lock-cataloger` and
  explicitly added `javascript-package-cataloger`, plus the four mandatory
  `file-content-cataloger`, `file-digest-cataloger`,
  `file-executable-cataloger`, and `file-metadata-cataloger` helpers recorded by
  Syft for directory sources. The workflow requires this exact six-cataloger
  allow-list;
- the Lambda ZIP-content SBOM and content manifest describe what SAM packaged.

The frontend source scope excludes only four package manifests below
`node_modules/resolve/test/resolver/`: `baz`, `browser_field`, `false_main`, and
`invalid_main`. They are upstream resolver test fixtures that deliberately look
like packages, not installed dependency nodes. Each exact subtree exclusion is
source-validated by the hosted policy script; a broad `node_modules` exclusion,
an extra exclusion, or a fixture artifact that survives into native Syft output
fails closed. The `resolve` package itself remains inventoried and lockfile
governed.

An esbuild bundle may not retain every package manifest. Therefore the
ZIP-content SBOM must be interpreted together with the backend component SBOM,
not as a substitute for it.

The dependency SBOMs deliberately do not run Syft's Go-binary cataloger over
the downloaded `esbuild` development executable. Embedded Go build metadata
describes the compiler binary, not the JavaScript dependency graph or the
Lambda ZIP runtime. The compiler remains governed by the immutable npm
lockfile, `npm audit`, Dependency Review, and the exact SAM build; the
unfiltered, default cataloger set is still used for the canonical Lambda
content. This separation prevents build-tool internals from being
misrepresented as deployed Lambda packages without hiding a shipped component.

The retired `aws/Dockerfile` and `aws/deploy-lambda.sh` paths were removed
instead of retaining a second, untested deployment mechanism. The only
supported release artifact is the SAM Lambda ZIP. If a container deployment is
introduced, its Dockerfile, exact image digest, image SBOM, and
vulnerability/license scan must become blocking release inputs in the same
change; the current pipeline makes no container-image claim because no
container image exists.

## Enforcement semantics

The workflow fails when:

- a pinned binary fails its SHA-256 check or cannot execute;
- CodeQL reports an in-threshold security finding;
- ShellCheck or zizmor reports a finding;
- actionlint reports any diagnostic outside the exact parser compatibility
  boundary below, or that boundary does not match its pinned version, message,
  count, paths, positions, and source anchors;
- cfn-lint, SAM lint/build, or Guard rejects current source;
- Trivy IaC reports anything except the exact HIGH `AWS-0011`, `AWS-0013`, and
  `AWS-0132` compatibility results below, or their JSON, SARIF, scanner version,
  source target, resource, location, or compensating-control contracts drift;
- Trivy reports any SBOM vulnerability, any backend/Lambda-content license
  finding, or any frontend license finding outside the exact build-only policy
  below;
- Guard's own positive/negative policy fixtures fail;
- Dependency Review rejects a newly introduced dependency;
- the canonical SAM content cannot be built;
- an SPDX/CycloneDX document or content manifest is missing or malformed.

Raw scanner reports and normalized exit receipts are both retained. In
particular, zizmor's JSON policy exit code is enforced separately from its
SARIF generation exit code. Trivy SBOM scanning runs an evidence pass and a
second `--exit-code 1` policy pass over the same scope and cache. Trivy IaC
uses raw `--exit-code 0` JSON/SARIF followed by the deterministic compatibility
validator below.

### Exact actionlint compatibility boundary

GitHub Actions officially supports `concurrency.queue: max`, which preserves
up to 100 pending runs in a concurrency group. Pinned actionlint 1.7.12
predates that schema field and emits a `syntax-check` diagnostic even though
GitHub accepts the workflow.

The pipeline does not remove `queue: max`, apply a regular-expression ignore,
or treat arbitrary syntax diagnostics as acceptable. It permits exactly
fourteen known source locations represented by ten anchor contracts in these files and
nowhere else:

- `.github/workflows/bootstrap-aws.yml` (delivery and shared-mutation anchors);
- `.github/workflows/deploy-aws.yml` (delivery and two shared-mutation anchors);
- `.github/workflows/edge-controls.yml` (edge and shared-mutation anchors);
- `.github/workflows/foundation-migration.yml` (foundation and three
  shared-mutation anchors);
- `.github/workflows/recover-aws.yml` (one recovery-watchdog anchor and two
  shared-mutation anchors).

The analyzer must still be version 1.7.12; its raw exit code must be 1; all
fourteen diagnostics must have the exact message, kind, indentation-derived
column/indicator, and file-specific line. Bootstrap and Deploy retain the
original delivery anchor:

```yaml
concurrency:
  group: aws-production-delivery
  cancel-in-progress: false
  queue: max
```

Every AWS mutation job also joins the shared control-plane group. `Recover AWS`
keeps a top-level watchdog-only anchor so GitHub-only preflight cannot block
delivery; its two mutation jobs join the same shared group only after a
recovery candidate has been proved:

```yaml
concurrency:
  group: aws-recovery-watchdog
  cancel-in-progress: false
  queue: max

jobs:
  recover-staging:
    concurrency:
      group: aws-shared-control-plane-mutation
      cancel-in-progress: false
      queue: max
```

The raw JSON and normalized compatibility records are retained. After removing
only those fourteen source-validated parser diagnostics, the effective actionlint
finding count must be zero. An additional diagnostic, changed path, duplicate
or missing diagnostic, source drift, analyzer upgrade, malformed JSON, or
unexpected exit code fails closed. This is a versioned tool/schema
compatibility boundary, not an entry in the vulnerability waiver ledger. The
exact-main receipt records both the fourteen raw diagnostics and zero effective
findings.

### Exact Trivy IaC parser compatibility boundaries

The application template contains three secure CloudFormation expressions that
Trivy 0.72.0 cannot resolve statically:

- `AWS-0011`: `CloudFrontWebAclArn` is a mandatory, no-default parameter
  constrained to a global `us-east-1` WebACL ARN, and `Distribution.WebACLId`
  directly references it. The deploy workflow obtains that ARN from the
  approval-gated edge stack; there is no unprotected application-stack mode.
- `AWS-0013`: the public demo intentionally uses only its generated
  `cloudfront.net` hostname. AWS does not permit a selectable
  `MinimumProtocolVersion` with `CloudFrontDefaultCertificate: true`; Aqua's
  own rule documents this platform limitation. Adding a custom certificate and
  domain solely to silence the scanner would expand the approved DNS and
  certificate lifecycle.
- `AWS-0132`: `SpaBucket` already uses SSE-KMS, `BucketKeyEnabled: true`, and
  the `Fn::ImportValue` of `${AppName}-storage-kms-key-arn`. The validator
  follows that exact export into `aws/bootstrap-oidc.yaml`, where
  `ApplicationStorageKey` is a rotating regional customer-managed KMS key and
  its alias/export are source-validated. The validator also requires two exact,
  separately bounded bucket-policy statements with `Effect: Deny`, wildcard
  principal, `s3:PutObject`, `${SpaBucket.Arn}/*`, and the corresponding
  encryption/key conditions. They reject non-KMS writes and writes using an
  unexpected key. Trivy reports the finding because its CloudFormation model
  treats the unresolved import as empty, not because the deployed bucket lacks
  a CMK.
- The second `AWS-0132` is the separate `CloudFrontAccessLogBucket` in
  `aws/bootstrap-oidc.yaml`. CloudFront standard logging (legacy) requires its
  ACL-enabled destination bucket to use S3-managed `AES256` encryption. The
  validator binds that finding to the complete bucket source range and requires
  the exact SSE-S3-only encryption block, `BucketOwnerPreferred`, all four
  public-access blocks, versioning, server-access logging, bounded lifecycle
  retention, and the exact insecure-transport deny. It also rejects any KMS
  property in that legacy-log bucket boundary.

Trivy 0.72.0 therefore runs its CloudFormation/Dockerfile evidence passes with
`--exit-code 0`, preserving the complete raw JSON and SARIF before a
repository-owned deterministic validator applies policy. The validator permits
exactly four raw findings only when all of the following remain exact:

- scanner and version: Trivy 0.72.0;
- rules, raw type, severity, and status: `AWS-0011`, `AWS-0013`, and
  `AWS-0132`, each `CloudFormation Security Check`, HIGH, and FAIL;
- raw schema: Trivy 0.72.0's `AVDID` field must remain absent/null; any
  unexpected legacy alias fails closed;
- raw rule references: the canonical Aqua `aws-0011`, `aws-0013`, and
  `aws-0132` records;
- targets and normalized logical resources: `aws/template.yaml`, with
  `Distribution` for `AWS-0011`/`AWS-0013` and `SpaBucket` for `AWS-0132`, plus
  `aws/bootstrap-oidc.yaml` with `CloudFrontAccessLogBucket` for the second
  `AWS-0132`;
- raw Trivy resources: the exact complete `Distribution`, `SpaBucket`, and
  `CloudFrontAccessLogBucket` source ranges, cross-checked against
  `CauseMetadata`, SARIF, and the current template blocks;
- WAF parameter ARN constraint and direct `WebACLId` binding;
- source property: exactly one `CloudFrontDefaultCertificate: true`, with no
  `MinimumProtocolVersion` or custom-domain `Aliases`;
- the default viewer behavior redirects to HTTPS;
- `/api/*` viewers and the API custom origin are HTTPS-only, with origin TLS
  1.2;
- `WebACLId` directly references a mandatory, no-default
  `CloudFrontWebAclArn`;
- the API origin retains the dynamic Secrets Manager verification header;
- CloudFront access logging remains enabled with its deterministic archive
  destination;
- SpaBucket retains SSE-KMS, its bucket key, and the exact foundation CMK
  import; the foundation retains key rotation, the matching alias and export;
- SpaBucketPolicy rejects writes without KMS or with an unexpected key.
- the legacy CloudFront standard-log bucket retains its exact required
  SSE-S3/`AES256` boundary and the compensating storage controls above.

The validator also requires the corresponding four SARIF errors and exact
source locations, runs positive and adversarial self-tests in the hosted
pipeline, and emits separate compatibility and blocking-finding documents.
Any extra, missing, duplicated, renamed, relocated, or malformed finding—or
any source-control drift—fails closed. The status and exact-main receipt
disclose `rawFindings=4`, `compatibilityFindings=4`, and
`blockingFindings=0`.

No inline Trivy ignore is present, the raw HIGH results remain visible in the
immutable infrastructure artifact and exact-main release evidence, and the
empty security waiver ledger is unchanged. After that raw SARIF, its exact
source locations, the compatibility record, and the zero-item blocking record
are revalidated, GitHub code scanning receives a policy-effective SARIF with
zero results. Its run metadata discloses `rawFindings=4`,
`compatibilityFindings=4`, `blockingFindings=0`, `acceptedWaivers=0`, and names
the retained raw SARIF. This keeps the GitHub check aligned with the enforced
blocking policy without hiding or mutating the canonical scanner evidence. The
hosted job also fails if any repository Trivy ignore or configuration override
file appears. This is a narrow scanner/platform compatibility disposition, not
a claim that the scanner resolved those dynamic values and not a
security-finding waiver.

CodeQL writes its exact-run SARIF to the ephemeral runner, uploads it to code
scanning, resolves each result to the corresponding rule metadata, and blocks
when numeric `security-severity` is at least `7.0` or SARIF level is `error`.
Lower-severity and quality-only results remain visible but are not
misrepresented as threshold failures. Deploy AWS accepts only a successful
CodeQL push run for the exact release SHA.

A green run means zero blocking/unwaived findings at the thresholds in this
document, all exact tool/schema and build-license compatibility boundaries matched, and zero
accepted waivers. It does not mean the software is vulnerability-free and does
not replace penetration testing, legal review, or a production incident
history.

The exact-main release path now waits for the successful exact-SHA workflow,
downloads its immutable receipt by run ID and attempt, verifies the GitHub
provenance attestation, and promotes the same receipt with the build-once
candidate. The candidate tree receipt is independently attested and verified
again in staging and production. The release receipt binds the empty waiver
ledger, exact current CloudFormation template inventory, SBOM documents, and
Lambda-content manifests. Staging and production accept only the enforced
receipt mode and reverify both provenance attestations.

The push receipt lists only controls that execute in that exact push run.
Dependency Review remains an additional pull-request-only control and is not
misrepresented as push evidence. The push path independently rescans the full
installed backend, frontend, and Lambda inventories for vulnerabilities and
licenses before it can issue a release receipt.

## License policy

Pull requests use an allow-list of permissive SPDX identifiers, including
`MIT-0`. Copyleft, source-available, non-commercial, unknown, or non-SPDX
licenses require manual review before introduction. `MPL-2.0` is deliberately
not added to the global Dependency Review allow-list.

The installed frontend inventory currently produces four raw Trivy license
policy findings and zero vulnerability findings:

| Package | Version | License/classification | Enforced boundary |
| --- | --- | --- | --- |
| `@csstools/color-helpers` | 5.1.0 | MIT-0, UNKNOWN/unknown | development-only Vite CSS build dependency |
| `lightningcss` | 1.33.0 | MPL-2.0, MEDIUM/reciprocal | development-only Vite CSS build dependency |
| `lightningcss-linux-x64-gnu` | 1.33.0 | MPL-2.0, MEDIUM/reciprocal | optional, development-only Linux x64 build binary |
| `lightningcss-linux-x64-musl` | 1.33.0 | MPL-2.0, MEDIUM/reciprocal | optional, development-only Linux x64 musl build binary |

The deterministic hosted validator requires those four package names,
licenses, Trivy classifications, empty Trivy file paths, and confidence values.
Because Trivy's license result omits package version and source location, the
same disposition is independently bound to native Syft evidence from
`javascript-package-cataloger`: the exact declared license/SPDX expression,
evidence type, purl, and `/node_modules/.../package.json` path. The matching
`web/package-lock.json` entries must retain their exact versions,
development/optional flags, platforms, npm resolved URLs, and SHA-512 integrity
values. A missing finding, extra license, any vulnerability, runtime promotion,
version/location/purl/license/digest drift, malformed evidence, or
scanner-version drift fails closed. Raw JSON/SARIF remains uploaded, the
blocking-finding file must be empty, and the waiver ledger remains empty.

The Dependency Review action does not fail on every unknown license, so Trivy's
installed-package license inventory and the repository-owned disposition are
retained as independent evidence. Approval here is narrowly about the current
build inputs and does not weaken the shipped Lambda-content or backend policy.

A scanner classification is not legal advice.

## Waivers

The canonical waiver ledger is `security/waivers.yml`. It is valid
JSON-compatible YAML and intentionally empty. Every enforcement job verifies
that exact state and the release receipt records its SHA-256 digest.

Every future waiver must contain:

- scanner and rule/advisory identifier;
- exact file/resource or package URL and version;
- evidence-based rationale and compensating control;
- owner and approval reference;
- creation and expiry dates;
- pipeline run that reproduced the finding.

Global rule disabling, wildcard ignores, and waivers without expiry are
prohibited. A matching tool-native ignore may be added only after the ledger
entry exists and must be no broader than that entry.

The current workflow deliberately rejects any non-empty ledger. Accepting a
future waiver therefore requires a reviewed scanner-specific exact matcher,
the narrow tool-native suppression where required, and tests proving that
expired, wildcard, wrong-target, and wrong-version entries fail closed. Merely
adding an entry cannot turn a red pipeline green.

## Evidence and retention

Each run uploads:

- scanner versions and tracked-input manifests;
- ShellCheck, actionlint raw/effective/compatibility, and zizmor
  machine-readable reports;
- Guard JUnit/current-template reports;
- explicit cfn-lint and Guard coverage of `aws/template.yaml`,
  `aws/bootstrap-oidc.yaml`, and the approval-gated dormant
  `aws/edge-waf.yaml` and `aws/finops.yaml` control planes;
- Trivy IaC raw JSON/SARIF, normalized compatibility record, empty effective
  blocking findings, and exact scanner/version status;
- backend and frontend SPDX/CycloneDX/native-Syft JavaScript dependency SBOMs,
  plus Lambda-content SPDX/CycloneDX SBOMs;
- Trivy SBOM JSON/SARIF, exact build-license compatibility and empty blocking
  findings, native Syft/lockfile binding, and scanner status;
- lockfile hashes, the empty waiver-ledger hash, and the Lambda content
  manifest;
- an exact-SHA release receipt, evidence manifest, and GitHub provenance
  attestation used by deployment.

Artifacts are retained for 90 days so an exact judging-period run remains
reviewable. SARIF upload is restricted to trusted pushes, schedules, manual
runs, and same-repository pull requests; fork pull requests receive no
`security-events: write` capability.

## Maintenance

- Review pinned scanner releases monthly and immediately after a relevant
  advisory. Binary pins are not updated by Dependabot.
- Keep vulnerability databases fresh and record the scanner/database metadata
  in the report; do not freeze vulnerability intelligence for reproducibility.
- After the judging freeze, restore routine dependency updates according to
  `docs/DEPENDENCY_RELEASE_POLICY.md`.
- Avoid adding overlapping scanners unless a documented uncovered threat or
  file type justifies their operational cost.

Primary references:

- [ShellCheck](https://github.com/koalaman/shellcheck)
- [actionlint](https://github.com/rhysd/actionlint)
- [actionlint queue-schema support tracking](https://github.com/rhysd/actionlint/pull/654)
- [GitHub Actions concurrency queue](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency#queueing-multiple-pending-runs)
- [zizmor usage](https://docs.zizmor.sh/usage/)
- [AWS CloudFormation Guard](https://docs.aws.amazon.com/cfn-guard/latest/ug/what-is-guard.html)
- [Trivy configuration scanning](https://trivy.dev/docs/latest/references/configuration/cli/trivy_config/)
- [Aqua AWS-0011 CloudFront WAF constraint](https://avd.aquasec.com/misconfig/aws/cloudfront/aws-0011/)
- [Aqua AWS-0013 default-certificate constraint](https://avd.aquasec.com/misconfig/aws/cloudfront/aws-0013/)
- [Aqua AWS-0132 S3 customer-managed-key constraint](https://avd.aquasec.com/misconfig/aws/s3/aws-0132/)
- [Trivy SBOM](https://trivy.dev/docs/dev/guide/supply-chain/sbom/)
- [Trivy license scanning](https://www.trivy.dev/docs/latest/scanner/license/)
- [Syft](https://github.com/anchore/syft)
- [GitHub Dependency Review](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/manage-your-dependency-security/configure-dependency-review-action)
- [GitHub SARIF](https://docs.github.com/en/code-security/concepts/code-scanning/sarif-files)
- [GitHub immutable Action pinning](https://docs.github.com/en/actions/reference/security/secure-use)
