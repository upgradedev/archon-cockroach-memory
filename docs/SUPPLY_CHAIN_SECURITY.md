# Supply-chain security

Status: enforced, zero accepted waivers

This document defines the hosted pipeline boundary added for source classes
that CodeQL does not analyze and for release dependency evidence. It does not
claim independent penetration testing, legal review, or a vulnerability-free
release.

## Coverage

| Surface | Control | Enforced behavior |
| --- | --- | --- |
| TypeScript semantic SAST | CodeQL 3.37.3 `security-and-quality` | `security-severity >= 7.0` or SARIF `level=error` blocks; SARIF is uploaded first |
| Tracked `*.sh` files | ShellCheck 0.11.0 | Any warning-or-higher finding blocks |
| GitHub workflow semantics and inline shell | actionlint 1.7.12 + ShellCheck | Any finding blocks |
| GitHub workflow security | zizmor 1.28.0 regular persona | Any JSON-policy finding blocks; SARIF is retained |
| CloudFormation syntax | cfn-lint 1.53.1 | Findings block across application, bootstrap, edge WAF, and FinOps templates |
| SAM validity and packageability | SAM CLI 1.164.0 | `sam validate --lint` and the canonical build must pass |
| CloudFormation/SAM policy | CloudFormation Guard 3.2.0 | Rule fixtures and every current-template rule must pass |
| CloudFormation and Dockerfile misconfiguration | Trivy 0.72.0 | Medium, High, and Critical findings block |
| Dependency changes in pull requests | GitHub Dependency Review v5.0.0 | Blocks new Moderate+ vulnerabilities and invalid licenses |
| Backend/frontend dependency inventory | Syft 1.50.0 SPDX + CycloneDX | Generation and schema checks block |
| Canonical Lambda ZIP content | SAM build + Syft file/dependency inventory | Generation and manifest checks block |
| Backend, frontend, and Lambda-content SBOM vulnerabilities/licenses | Trivy 0.72.0 | Unknown, Medium, High, and Critical policy findings block |

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

- backend and frontend component SBOMs describe resolved package dependencies;
- the Lambda ZIP-content SBOM and content manifest describe what SAM packaged.

An esbuild bundle may not retain every package manifest. Therefore the
ZIP-content SBOM must be interpreted together with the backend component SBOM,
not as a substitute for it.

`aws/Dockerfile` and `aws/deploy-lambda.sh` are retired historical helpers. They
are not built, pushed, deployed, or described as a supported release path.
Trivy still statically scans the retained Dockerfile so that an unsafe residual
file cannot silently re-enter service. If a container deployment is restored,
an exact image-digest vulnerability/license scan and image SBOM must become a
blocking release requirement first.

## Enforcement semantics

The workflow fails when:

- a pinned binary fails its SHA-256 check or cannot execute;
- CodeQL reports an in-threshold security finding;
- ShellCheck, actionlint, or zizmor reports a finding;
- cfn-lint, SAM lint/build, Guard, or Trivy IaC rejects current source;
- Trivy reports an in-policy SBOM vulnerability or license finding;
- Guard's own positive/negative policy fixtures fail;
- Dependency Review rejects a newly introduced dependency;
- the canonical SAM content cannot be built;
- an SPDX/CycloneDX document or content manifest is missing or malformed.

Raw scanner reports and normalized exit receipts are both retained. In
particular, zizmor's JSON policy exit code is enforced separately from its
SARIF generation exit code. Trivy runs an evidence pass and a second
`--exit-code 1` policy pass over the same scope and cache.

CodeQL writes its exact-run SARIF to the ephemeral runner, uploads it to code
scanning, resolves each result to the corresponding rule metadata, and blocks
when numeric `security-severity` is at least `7.0` or SARIF level is `error`.
Lower-severity and quality-only results remain visible but are not
misrepresented as threshold failures. Deploy AWS accepts only a successful
CodeQL push run for the exact release SHA.

A green run means zero unwaived findings at the thresholds in this document
and zero accepted waivers. It does not mean the software is vulnerability-free
and does not replace penetration testing, legal review, or a production
incident history.

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

Pull requests use an allow-list of permissive SPDX identifiers. Copyleft,
source-available, non-commercial, unknown, or non-SPDX licenses require manual
review before introduction. The Dependency Review action does not fail on every
unknown license, so Trivy's installed-package license inventory is retained as
an independent report.

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
- ShellCheck, actionlint, and zizmor machine-readable reports;
- Guard JUnit/current-template reports;
- explicit cfn-lint and Guard coverage of `aws/template.yaml`,
  `aws/bootstrap-oidc.yaml`, and the approval-gated dormant
  `aws/edge-waf.yaml` and `aws/finops.yaml` control planes;
- Trivy IaC JSON/SARIF;
- backend, frontend, and Lambda-content SPDX/CycloneDX SBOMs;
- Trivy SBOM JSON/SARIF;
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
- [zizmor usage](https://docs.zizmor.sh/usage/)
- [AWS CloudFormation Guard](https://docs.aws.amazon.com/cfn-guard/latest/ug/what-is-guard.html)
- [Trivy configuration scanning](https://trivy.dev/docs/latest/references/configuration/cli/trivy_config/)
- [Trivy SBOM](https://trivy.dev/docs/dev/guide/supply-chain/sbom/)
- [Trivy license scanning](https://www.trivy.dev/docs/latest/scanner/license/)
- [Syft](https://github.com/anchore/syft)
- [GitHub Dependency Review](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/manage-your-dependency-security/configure-dependency-review-action)
- [GitHub SARIF](https://docs.github.com/en/code-security/concepts/code-scanning/sarif-files)
- [GitHub immutable Action pinning](https://docs.github.com/en/actions/reference/security/secure-use)
