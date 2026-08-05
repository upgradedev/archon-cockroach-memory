#!/usr/bin/env bash
# Fail-closed assertions over the exact-run supply-chain evidence that the
# release receipt is built from.
#
# This contract used to live inline in the "Create fail-closed exact-SHA
# release receipt" step of .github/workflows/supply-chain.yml. That step is
# gated on a push to refs/heads/main, so it never ran on a pull request, and
# nothing else evaluated its jq: shellcheck lints shell and actionlint lints
# workflow syntax, and neither one evaluates a filter. The assertions were
# therefore exercised for the first time on the merge commit, after review.
#
# The contract lives here so that a pull-request check can run the real
# assertions against synthesised evidence before a change reaches main. The
# receipt step and .github/scripts/release-evidence-selftest.mjs call this same
# file. There is deliberately no second copy of the contract, and no test-only
# relaxation of any assertion.
#
# Inputs (environment):
#   EVIDENCE_ROOT        directory holding static/, iac/ and sbom/ evidence
#   RECEIPT_INPUTS_DIR   directory this script writes its derived values to.
#                        Must be outside EVIDENCE_ROOT: the receipt hashes
#                        every file under EVIDENCE_ROOT into
#                        evidence-manifest.sha256, which deploy-aws.yml
#                        recomputes and compares.
#   GITHUB_EVENT_NAME    must be push
#   GITHUB_REF           must be refs/heads/main
#   GITHUB_RUN_ID        run id bound into the provenance assertion
#   GITHUB_RUN_ATTEMPT   run attempt bound into the provenance assertion
#   SOURCE_SHA           exact release commit bound into the provenance
#
# Outputs (written into RECEIPT_INPUTS_DIR):
#   trivy-scanner-resources.json   exact scanner-resource records the receipt
#                                  embeds
#   waiver-ledger-sha256.txt       waiver ledger digest the receipt binds
#
# Exit status is the assertion result: zero means every assertion held.
set -euo pipefail
umask 077

# Every assertion below redirects jq to /dev/null, so a bare failure would be
# silent. This reports the failing line and command, plus the loop variable in
# scope, so a failure names itself in the job log instead of only setting an
# exit status.
archon_report_failure() {
  local status=$?
  printf 'assert-release-evidence.sh: FAILED (exit %s) at line %s: %s\n' \
    "$status" "${BASH_LINENO[0]}" "$BASH_COMMAND" >&2
  if [ -n "${required:-}" ]; then
    printf 'assert-release-evidence.sh: required evidence path in scope: %s\n' \
      "$required" >&2
  fi
  if [ -n "${status_file:-}" ]; then
    printf 'assert-release-evidence.sh: status file in scope: %s\n' \
      "$status_file" >&2
  fi
  exit "$status"
}
trap archon_report_failure ERR

for archon_required_var in \
  EVIDENCE_ROOT \
  GITHUB_EVENT_NAME \
  GITHUB_REF \
  GITHUB_RUN_ATTEMPT \
  GITHUB_RUN_ID \
  RECEIPT_INPUTS_DIR \
  SOURCE_SHA; do
  if [ -z "${!archon_required_var:-}" ]; then
    printf 'assert-release-evidence.sh: %s is required.\n' \
      "$archon_required_var" >&2
    exit 2
  fi
done

test -d "$RECEIPT_INPUTS_DIR"
# Writing derived values under EVIDENCE_ROOT would change the evidence manifest
# and therefore the receipt digest that deploy-aws.yml re-derives.
case "$RECEIPT_INPUTS_DIR/" in
  "$EVIDENCE_ROOT"/*)
    printf '%s\n' \
      'assert-release-evidence.sh: RECEIPT_INPUTS_DIR must be outside EVIDENCE_ROOT.' >&2
    exit 2
    ;;
esac

test "$GITHUB_EVENT_NAME" = "push"
test "$GITHUB_REF" = "refs/heads/main"
[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]]
[[ "$GITHUB_RUN_ID" =~ ^[1-9][0-9]*$ ]]
[[ "$GITHUB_RUN_ATTEMPT" =~ ^[1-9][0-9]*$ ]]
test -d "$EVIDENCE_ROOT/static"
test -d "$EVIDENCE_ROOT/iac"
test -d "$EVIDENCE_ROOT/sbom"
test -z "$(find "$EVIDENCE_ROOT" -type l -print -quit)"

for required in \
  static/shellcheck-status.json \
  static/actionlint.raw.json \
  static/actionlint-all.json \
  static/actionlint-blocking-findings.json \
  static/actionlint-queue-compatibility.json \
  static/actionlint-status.json \
  static/zizmor-status.json \
  static/waiver-ledger.sha256 \
  iac/cfn-lint-status.json \
  iac/cfn-lint-finops.json \
  iac/guard-current-status.json \
  iac/guard-edge-waf.txt \
  iac/guard-finops.txt \
  iac/trivy-iac-status.json \
  iac/trivy-iac.json \
  iac/trivy-iac.sarif \
  iac/trivy-iac-compatibility-findings.json \
  iac/trivy-iac-blocking-findings.json \
  iac/trivy-version.txt \
  sbom/provenance.json \
  sbom/trivy-sbom-status.json \
  sbom/trivy-backend-policy.json \
  sbom/trivy-frontend-policy.json \
  sbom/trivy-lambda-content-policy.json \
  sbom/trivy-sbom-compatibility-findings.json \
  sbom/trivy-sbom-blocking-findings.json \
  sbom/trivy-version.txt \
  sbom/waiver-ledger.sha256 \
  sbom/lambda-zip-content.sha256 \
  sbom/sbom-inputs-and-documents.sha256 \
  sbom/backend.spdx.json \
  sbom/backend.syft.json \
  sbom/frontend.spdx.json \
  sbom/frontend.syft.json \
  sbom/lambda-content.spdx.json; do
  test -s "$EVIDENCE_ROOT/$required"
done

jq -e \
  --arg sourceSha "$SOURCE_SHA" \
  --arg runId "$GITHUB_RUN_ID" \
  --arg runAttempt "$GITHUB_RUN_ATTEMPT" '
    .schemaVersion == 1 and
    .sourceSha == $sourceSha and
    .runId == $runId and
    .runAttempt == $runAttempt and
    .enforcement == "blocking" and
    .canonicalArtifact ==
      "SAM ArchonFunction Lambda ZIP content" and
    .containerPath == "retired-non-release"
  ' "$EVIDENCE_ROOT/sbom/provenance.json" >/dev/null
jq -e \
  '.mode == "blocking" and .exitCode == 0' \
  "$EVIDENCE_ROOT/static/shellcheck-status.json" >/dev/null
jq -e \
  '.mode == "blocking-exact-parser-compatibility" and
   .effectiveExitCode == 0 and
   .rawExitCode == 1 and
   .rawFindings == 14 and
   .blockingFindings == 0 and
   .compatibility.analyzer == "actionlint" and
   .compatibility.version == "1.7.12" and
   .compatibility.feature == "concurrency.queue" and
   .compatibility.diagnostic ==
     "unexpected key \"queue\" for \"concurrency\" section. expected one of \"cancel-in-progress\", \"group\"" and
   .compatibility.acceptedDiagnostics == 14 and
   .compatibility.expectedPaths == [
     ".github/workflows/bootstrap-aws.yml",
     ".github/workflows/deploy-aws.yml",
     ".github/workflows/edge-controls.yml",
     ".github/workflows/foundation-migration.yml",
     ".github/workflows/recover-aws.yml"
   ] and
   (.compatibility.expectedDiagnostics | length) == 14 and
   ([.compatibility.expectedDiagnostics[].filepath] | unique) ==
     .compatibility.expectedPaths and
   (.compatibility.sourceAnchors | length) == 10 and
   ([.compatibility.sourceAnchors[].count] | add) == 14' \
  "$EVIDENCE_ROOT/static/actionlint-status.json" >/dev/null
jq --slurp -e \
  --slurpfile status \
    "$EVIDENCE_ROOT/static/actionlint-status.json" '
  length == 1 and
  (.[0] | type) == "array" and
  (.[0] | length) == 14 and
  (.[0] as $findings |
    all($status[0].compatibility.expectedDiagnostics[];
      . as $site |
      any($findings[];
        .kind == "syntax-check" and
        .message == $status[0].compatibility.diagnostic and
        .filepath == $site.filepath and
        .line == $site.line and
        .column == $site.column and
        .end_column == $site.endColumn and
        .snippet == $site.snippet
      )
    )
  )
' "$EVIDENCE_ROOT/static/actionlint.raw.json" >/dev/null
jq -e \
  --slurpfile status \
    "$EVIDENCE_ROOT/static/actionlint-status.json" '
  . as $findings |
  length == 14 and
  all($status[0].compatibility.expectedDiagnostics[];
    . as $site |
    any($findings[];
      .kind == "syntax-check" and
      .message == $status[0].compatibility.diagnostic and
      .filepath == $site.filepath and
      .line == $site.line and
      .column == $site.column and
      .end_column == $site.endColumn and
      .snippet == $site.snippet
    )
  )
' \
  "$EVIDENCE_ROOT/static/actionlint-queue-compatibility.json" \
  >/dev/null
jq -e 'length == 14' \
  "$EVIDENCE_ROOT/static/actionlint-all.json" >/dev/null
jq -e 'length == 0' \
  "$EVIDENCE_ROOT/static/actionlint-blocking-findings.json" \
  >/dev/null
jq -e \
  '.mode == "blocking" and
   .jsonExitCode == 0 and
   .sarifExitCode == 0' \
  "$EVIDENCE_ROOT/static/zizmor-status.json" >/dev/null
expected_templates='[
  "aws/template.yaml",
  "aws/bootstrap-oidc.yaml",
  "aws/edge-waf.yaml",
  "aws/finops.yaml"
]'
for status_file in \
  "$EVIDENCE_ROOT/iac/cfn-lint-status.json" \
  "$EVIDENCE_ROOT/iac/guard-current-status.json"; do
  jq -e \
    --argjson templates "$expected_templates" '
      .mode == "blocking" and
      .applicationExitCode == 0 and
      .foundationExitCode == 0 and
      .edgeWafControlPlaneExitCode == 0 and
      .finopsControlPlaneExitCode == 0 and
      .templates == $templates
    ' "$status_file" >/dev/null
done
jq -e \
  '.schema == "archon.trivy-iac.compatibility" and
   .version == 2 and
   .mode ==
     "blocking-exact-source-validated-parser-compatibilities" and
   .scanner == "Trivy" and
   .scannerVersion == "0.72.0" and
   .versionEvidence == {
     "toolLock":"0.72.0",
     "capturedCli":"0.72.0",
     "sarifDriver":"0.72.0"
   } and
   .thresholdSeverities == ["MEDIUM","HIGH","CRITICAL"] and
   .rawFindings == 4 and
   .compatibilityFindings == 4 and
   .blockingFindings == 0 and
   .acceptedWaivers == 0 and
   .effectiveExitCode == 0 and
   .sourceEvidence == {
     "applicationTemplate":"aws/template.yaml",
     "foundationTemplate":"aws/bootstrap-oidc.yaml"
   } and
   [.compatibilities[].ruleId] ==
     ["AWS-0011","AWS-0013","AWS-0132","AWS-0132"] and
   [.compatibilities[].logicalResource] ==
     ["Distribution","Distribution","SpaBucket",
      "CloudFrontAccessLogBucket"] and
   [.compatibilities[].target] == [
     "aws/template.yaml",
     "aws/template.yaml",
     "aws/template.yaml",
     "aws/bootstrap-oidc.yaml"
   ] and
   all(.compatibilities[];
     .findingType == "CloudFormation Security Check" and
     .severity == "HIGH" and
     (.scannerResource |
       test("^aws/(template|bootstrap-oidc)\\.yaml:[1-9][0-9]*-[1-9][0-9]*$")) and
     .scannerResource ==
       (.target + ":" +
        (.sourceRange.startLine | tostring) + "-" +
        (.sourceRange.endLine | tostring)))' \
  "$EVIDENCE_ROOT/iac/trivy-iac-status.json" >/dev/null
# Trivy names CauseMetadata.Resource two ways. A finding raised
# against a complete resource block carries the
# "target:startLine-endLine" source range; a finding it pins to one
# resolved property line carries the logical resource id instead.
# AWS-0011 moved to the second shape when Distribution.WebACLId
# became an Fn::If. Both shapes are pinned exactly, per
# (target, ruleId), and every raw location is bound to the
# source-validated compatibility record it is published as.
jq -e \
  --slurpfile status \
    "$EVIDENCE_ROOT/iac/trivy-iac-status.json" '
  {
    "aws/template.yaml|AWS-0011": "logical-resource"
  } as $pinnedResourceShapes
  | [
    .Results[]? as $result
    | $result.Misconfigurations[]?
    | select(.Status == "FAIL")
    | {target:$result.Target, finding:.}
  ] as $findings
  | ($findings | length) == 4 and
    ([$findings[] | (.target + "|" + .finding.ID)] | sort) == [
      "aws/bootstrap-oidc.yaml|AWS-0132",
      "aws/template.yaml|AWS-0011",
      "aws/template.yaml|AWS-0013",
      "aws/template.yaml|AWS-0132"
    ] and
    all($findings[];
      . as $entry |
      .finding.Type == "CloudFormation Security Check" and
      (.finding.AVDID == null) and
      .finding.Severity == "HIGH" and
      (($status[0].compatibilities |
        map(select(
          .ruleId == $entry.finding.ID and
          .target == $entry.target
        ))) as $contracts |
        ($contracts | length) == 1 and
        ($contracts[0] as $contract |
        $contract.scannerResource ==
          ($contract.target + ":" +
           ($contract.sourceRange.startLine | tostring) + "-" +
           ($contract.sourceRange.endLine | tostring)) and
        $entry.finding.CauseMetadata.StartLine ==
          $contract.sourceRange.startLine and
        $entry.finding.CauseMetadata.EndLine ==
          $contract.sourceRange.endLine and
        $entry.finding.CauseMetadata.Resource ==
          (if $pinnedResourceShapes[
                $entry.target + "|" + $entry.finding.ID
              ] == "logical-resource"
           then $contract.logicalResource
           else $contract.scannerResource
           end))))
' "$EVIDENCE_ROOT/iac/trivy-iac.json" >/dev/null
jq -e '
  length == 4 and
  map(.ruleId) ==
    ["AWS-0011","AWS-0013","AWS-0132","AWS-0132"] and
  map(.namespace) == [
    "builtin.aws.cloudfront.aws0011",
    "builtin.aws.cloudfront.aws0013",
    "builtin.aws.s3.aws0132",
    "builtin.aws.s3.aws0132"
  ] and
  map(.target) == [
    "aws/template.yaml",
    "aws/template.yaml",
    "aws/template.yaml",
    "aws/bootstrap-oidc.yaml"
  ] and
  map(.logicalResource) == [
    "Distribution",
    "Distribution",
    "SpaBucket",
    "CloudFrontAccessLogBucket"
  ] and
  all(.[];
    .findingType == "CloudFormation Security Check" and
    .legacyAlias == null and
    .severity == "HIGH" and
    .status == "FAIL" and
    (.scannerResource |
      test("^aws/(template|bootstrap-oidc)\\.yaml:[1-9][0-9]*-[1-9][0-9]*$")) and
    .scannerResource ==
      (.target + ":" +
       (.startLine | tostring) + "-" +
       (.endLine | tostring)))
' \
  "$EVIDENCE_ROOT/iac/trivy-iac-compatibility-findings.json" \
  >/dev/null
jq -e \
  --slurpfile status \
    "$EVIDENCE_ROOT/iac/trivy-iac-status.json" '
    .version == "2.1.0" and
    (.runs | length) == 1 and
    (.runs[0] as $run |
      $run.tool.driver.name == "Trivy" and
      $run.tool.driver.version == "0.72.0" and
      ($run.tool.driver.rules | length) == 3 and
      ([$run.tool.driver.rules[].id |
        select(. == "AWS-0011" or
               . == "AWS-0013" or
               . == "AWS-0132")] | sort) ==
        ["AWS-0011","AWS-0013","AWS-0132"] and
      ($run.results | length) == 4 and
      ([$run.results[].ruleId] | sort) ==
        ["AWS-0011","AWS-0013","AWS-0132","AWS-0132"] and
      all($run.results[];
        . as $result |
        $result.level == "error" and
        ($result.locations | length) == 1 and
        ($result.locations[0].physicalLocation as $location |
          ($status[0].compatibilities |
            map(select(
              .ruleId == $result.ruleId and
              .target == $location.artifactLocation.uri
            ))) as $contracts |
          ($contracts | length) == 1 and
          ($contracts[0] as $contract |
          $location.artifactLocation.uri ==
            $contract.target and
          $location.region.startLine ==
            $contract.sourceRange.startLine and
          $location.region.endLine ==
            $contract.sourceRange.endLine and
          $location.region.startColumn == 1 and
          $location.region.endColumn == 1))))
  ' "$EVIDENCE_ROOT/iac/trivy-iac.sarif" >/dev/null
test "$(
  sed -n '1p' "$EVIDENCE_ROOT/iac/trivy-version.txt"
)" = "Version: 0.72.0"
jq -e 'length == 0' \
  "$EVIDENCE_ROOT/iac/trivy-iac-blocking-findings.json" \
  >/dev/null
jq -e '
  .schema == "archon.trivy-sbom.compatibility" and
  .version == 1 and
  .mode == "blocking-exact-build-license-compatibility" and
  .scanner == "Trivy" and
  .scannerVersion == "0.72.0" and
  .inventoryScanner == "Syft" and
  .inventoryScannerVersion == "1.50.0" and
  .versionEvidence == {
    "trivyToolLock":"0.72.0",
    "trivyCapturedCli":"0.72.0",
    "syftToolLock":"1.50.0"
  } and
  .scanners == ["vuln","license"] and
  .severities == ["UNKNOWN","MEDIUM","HIGH","CRITICAL"] and
  .rawExitCodes == {
    "backend":0,
    "frontend":1,
    "lambdaContent":0
  } and
  .reportResultsEncoding == {
    "backend":"array",
    "frontend":"array",
    "lambdaContent":"omitted-root-only"
  } and
  .lambdaInventory == {
    "contract":"exact-root-only",
    "spdxVersion":"SPDX-2.3",
    "sourceName":"archon-memory-lambda-zip-content",
    "rootPackageId":"SPDXRef-DocumentRoot-Directory-archon-memory-lambda-zip-content",
    "totalPackages":1,
    "catalogedDependencyPackages":0,
    "relationships":1
  } and
  .rawFindings == 4 and
  .vulnerabilityFindings == 0 and
  .licenseFindings == 4 and
  .approvedBuildLicenseFindings == 4 and
  .blockingFindings == 0 and
  .acceptedWaivers == 0 and
  .effectiveExitCode == 0 and
  .sourceExclusions == [
    "./node_modules/resolve/test/resolver/baz/**",
    "./node_modules/resolve/test/resolver/browser_field/**",
    "./node_modules/resolve/test/resolver/false_main/**",
    "./node_modules/resolve/test/resolver/invalid_main/**"
  ] and
  [.approvedBuildLicenses[].package] == [
    "@csstools/color-helpers",
    "lightningcss",
    "lightningcss-linux-x64-gnu",
    "lightningcss-linux-x64-musl"
  ] and
  [.approvedBuildLicenses[].version] ==
    ["5.1.0","1.33.0","1.33.0","1.33.0"] and
  [.approvedBuildLicenses[].license] ==
    ["MIT-0","MPL-2.0","MPL-2.0","MPL-2.0"] and
  [.approvedBuildLicenses[].resolved] == [
    "https://registry.npmjs.org/@csstools/color-helpers/-/color-helpers-5.1.0.tgz",
    "https://registry.npmjs.org/lightningcss/-/lightningcss-1.33.0.tgz",
    "https://registry.npmjs.org/lightningcss-linux-x64-gnu/-/lightningcss-linux-x64-gnu-1.33.0.tgz",
    "https://registry.npmjs.org/lightningcss-linux-x64-musl/-/lightningcss-linux-x64-musl-1.33.0.tgz"
  ] and
  [.approvedBuildLicenses[].integrity] == [
    "sha512-S11EXWJyy0Mz5SYvRmY8nJYTFFd1LCNV+7cXyAgQtOOuzb4EsgfqDufL+9esx72/eLhsRdGZwaldu/h+E4t4BA==",
    "sha512-WkUDrojuJs0xkgGf2udWxa3yGBRxPtxUkB79i6aCZLRgc7PM8fZe9TosfPDcvEpQZbuFASnHYmRLBLUbmLOIIA==",
    "sha512-ar+Ju7LmcN0Jo4FpL4hpFybwNG9/3A/Br5KW2n2jyODg3MEZXaDYADdemoNS+BDNfMgKvylJLj4S5tyRActuAg==",
    "sha512-RYiYbkokw0trfKqqzfF55lginwEPrD3OJDfTuJzFs1MK6iFnDenaz1fqLLtX4ITG3OktJQXOeTaw1awrBAlZPw=="
  ] and
  [.approvedBuildLicenses[].dev] == [true,true,true,true]
' "$EVIDENCE_ROOT/sbom/trivy-sbom-status.json" >/dev/null
for scope in backend frontend; do
  jq -e --arg artifact \
    "supply-chain-reports/sbom/${scope}.spdx.json" '
      .SchemaVersion == 2 and
      .Trivy == {"Version":"0.72.0"} and
      .ArtifactName == $artifact and
      .ArtifactType == "spdx" and
      (.Results | type) == "array"
    ' \
    "$EVIDENCE_ROOT/sbom/trivy-${scope}-policy.json" \
    >/dev/null
done
jq -e '
  .SchemaVersion == 2 and
  .Trivy == {"Version":"0.72.0"} and
  .ArtifactName ==
    "supply-chain-reports/sbom/lambda-content.spdx.json" and
  .ArtifactType == "spdx" and
  keys == [
    "ArtifactName",
    "ArtifactType",
    "CreatedAt",
    "ReportID",
    "SchemaVersion",
    "Trivy"
  ] and
  (.ReportID |
    test("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")) and
  (.CreatedAt |
    test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?Z$")) and
  (has("Results") | not)
' \
  "$EVIDENCE_ROOT/sbom/trivy-lambda-content-policy.json" \
  >/dev/null
jq -e '
  (keys | sort) == ([
    "SPDXID",
    "creationInfo",
    "dataLicense",
    "documentNamespace",
    "name",
    "packages",
    "relationships",
    "spdxVersion"
  ] | sort) and
  .spdxVersion == "SPDX-2.3" and
  .dataLicense == "CC0-1.0" and
  .SPDXID == "SPDXRef-DOCUMENT" and
  .name == "archon-memory-lambda-zip-content" and
  (.documentNamespace |
    test("^https://anchore[.]com/syft/dir/archon-memory-lambda-zip-content-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")) and
  (.creationInfo | keys | sort) ==
    (["created","creators","licenseListVersion"] | sort) and
  .creationInfo.licenseListVersion == "3.28" and
  .creationInfo.creators == [
    "Organization: Anchore, Inc",
    "Tool: syft-1.50.0"
  ] and
  (.creationInfo.created |
    test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?Z$")) and
  .packages == [{
    "name":"archon-memory-lambda-zip-content",
    "SPDXID":"SPDXRef-DocumentRoot-Directory-archon-memory-lambda-zip-content",
    "supplier":"NOASSERTION",
    "downloadLocation":"NOASSERTION",
    "filesAnalyzed":false,
    "licenseConcluded":"NOASSERTION",
    "licenseDeclared":"NOASSERTION",
    "copyrightText":"NOASSERTION",
    "primaryPackagePurpose":"FILE"
  }] and
  .relationships == [{
    "spdxElementId":"SPDXRef-DOCUMENT",
    "relatedSpdxElement":"SPDXRef-DocumentRoot-Directory-archon-memory-lambda-zip-content",
    "relationshipType":"DESCRIBES"
  }]
' "$EVIDENCE_ROOT/sbom/lambda-content.spdx.json" >/dev/null
jq -e '
  length == 4 and
  map(.package) == [
    "@csstools/color-helpers",
    "lightningcss",
    "lightningcss-linux-x64-gnu",
    "lightningcss-linux-x64-musl"
  ] and
  map(.version) == ["5.1.0","1.33.0","1.33.0","1.33.0"] and
  map(.license) ==
    ["MIT-0","MPL-2.0","MPL-2.0","MPL-2.0"] and
  map(.resolved) == [
    "https://registry.npmjs.org/@csstools/color-helpers/-/color-helpers-5.1.0.tgz",
    "https://registry.npmjs.org/lightningcss/-/lightningcss-1.33.0.tgz",
    "https://registry.npmjs.org/lightningcss-linux-x64-gnu/-/lightningcss-linux-x64-gnu-1.33.0.tgz",
    "https://registry.npmjs.org/lightningcss-linux-x64-musl/-/lightningcss-linux-x64-musl-1.33.0.tgz"
  ] and
  map(.integrity) == [
    "sha512-S11EXWJyy0Mz5SYvRmY8nJYTFFd1LCNV+7cXyAgQtOOuzb4EsgfqDufL+9esx72/eLhsRdGZwaldu/h+E4t4BA==",
    "sha512-WkUDrojuJs0xkgGf2udWxa3yGBRxPtxUkB79i6aCZLRgc7PM8fZe9TosfPDcvEpQZbuFASnHYmRLBLUbmLOIIA==",
    "sha512-ar+Ju7LmcN0Jo4FpL4hpFybwNG9/3A/Br5KW2n2jyODg3MEZXaDYADdemoNS+BDNfMgKvylJLj4S5tyRActuAg==",
    "sha512-RYiYbkokw0trfKqqzfF55lginwEPrD3OJDfTuJzFs1MK6iFnDenaz1fqLLtX4ITG3OktJQXOeTaw1awrBAlZPw=="
  ] and
  all(.[];
    .scope == "frontend" and
    .kind == "build-license" and
    .cataloger == "javascript-package-cataloger" and
    .dev == true)
' "$EVIDENCE_ROOT/sbom/trivy-sbom-compatibility-findings.json" \
  >/dev/null
jq -e 'length == 0' \
  "$EVIDENCE_ROOT/sbom/trivy-sbom-blocking-findings.json" \
  >/dev/null
test "$(
  sed -n '1p' "$EVIDENCE_ROOT/sbom/trivy-version.txt"
)" = "Version: 0.72.0"
cmp \
  "$EVIDENCE_ROOT/static/waiver-ledger.sha256" \
  "$EVIDENCE_ROOT/sbom/waiver-ledger.sha256"
waiver_ledger_sha256="$(
  awk '{print $1}' \
    "$EVIDENCE_ROOT/static/waiver-ledger.sha256"
)"
[[ "$waiver_ledger_sha256" =~ ^[0-9a-f]{64}$ ]]

trivy_scanner_resources="$(
  jq -ec '[.compatibilities[] | {
    ruleId,
    target,
    logicalResource,
    scannerResource
  }]' \
    "$EVIDENCE_ROOT/iac/trivy-iac-status.json"
)"
jq -e '
  length == 4 and
  map(.ruleId) ==
    ["AWS-0011","AWS-0013","AWS-0132","AWS-0132"] and
  map(.target) == [
    "aws/template.yaml",
    "aws/template.yaml",
    "aws/template.yaml",
    "aws/bootstrap-oidc.yaml"
  ] and
  map(.logicalResource) ==
    ["Distribution","Distribution","SpaBucket",
     "CloudFrontAccessLogBucket"] and
  all(.[];
    .scannerResource |
      test("^aws/(template|bootstrap-oidc)\\.yaml:[1-9][0-9]*-[1-9][0-9]*$"))
' <<<"$trivy_scanner_resources" >/dev/null

printf '%s\n' "$trivy_scanner_resources" \
  >"$RECEIPT_INPUTS_DIR/trivy-scanner-resources.json"
printf '%s\n' "$waiver_ledger_sha256" \
  >"$RECEIPT_INPUTS_DIR/waiver-ledger-sha256.txt"
test -s "$RECEIPT_INPUTS_DIR/trivy-scanner-resources.json"
test -s "$RECEIPT_INPUTS_DIR/waiver-ledger-sha256.txt"
