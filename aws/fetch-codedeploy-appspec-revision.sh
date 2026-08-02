#!/usr/bin/env bash
# Fetch the exact AppSpecContent revision named by one GetDeployment response.
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "Usage: $0 <deployment-detail.json> <application-name> <output.json>" >&2
  exit 1
fi
if [ -z "${AWS_REGION:-}" ]; then
  echo "AWS_REGION is required." >&2
  exit 1
fi

readonly deployment_detail="$1"
readonly application_name="$2"
readonly output_file="$3"
test -f "$deployment_detail"
[[ "$application_name" =~ ^[A-Za-z0-9._+=,@-]{1,100}$ ]]
[[ "$AWS_REGION" =~ ^[a-z]{2}(-gov)?-[a-z]+-[1-9][0-9]*$ ]]

jq -e \
  --arg application "$application_name" '
    .deploymentInfo.applicationName == $application
    and .deploymentInfo.revision.revisionType == "AppSpecContent"
    and .deploymentInfo.revision.appSpecContent.content == null
    and (
      .deploymentInfo.revision.appSpecContent.sha256
      | type == "string" and test("^[0-9a-f]{64}$")
    )
  ' "$deployment_detail" >/dev/null
requested_sha="$(
  jq -er '.deploymentInfo.revision.appSpecContent.sha256' \
    "$deployment_detail"
)"

work_dir="$(mktemp -d)"
cleanup_revision_fetch() {
  rm -rf -- "$work_dir"
}
trap cleanup_revision_fetch EXIT

request_file="$work_dir/revision-request.json"
response_file="$work_dir/revision-response.json"
jq -n --arg sha "$requested_sha" '
  {
    revisionType: "AppSpecContent",
    appSpecContent: {sha256: $sha}
  }
' >"$request_file"

aws deploy get-application-revision \
  --application-name "$application_name" \
  --revision "file://$request_file" \
  --region "$AWS_REGION" \
  --output json >"$response_file"

jq -e \
  --arg application "$application_name" \
  --arg sha "$requested_sha" '
    .applicationName == $application
    and .revision.revisionType == "AppSpecContent"
    and .revision.appSpecContent.sha256 == $sha
    and (
      .revision.appSpecContent.content
      | type == "string" and length > 0 and length <= 1048576
    )
  ' "$response_file" >/dev/null

cp -- "$response_file" "$output_file"
