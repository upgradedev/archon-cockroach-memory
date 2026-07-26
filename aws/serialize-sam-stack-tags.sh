#!/usr/bin/env bash
# Serialize an exact CloudFormation stack-tag snapshot into the argv shape
# consumed by SAM CLI's CfnTags parser: one quoted Key=Value token per line.
set -euo pipefail

if [ "$#" -ne 1 ] || [ ! -s "$1" ]; then
  echo "Usage: $0 <stack-tags.json>" >&2
  exit 1
fi

tags_file="$1"
jq -e \
  '
    type == "array"
    and all(.[];
      ((keys | sort) == ["Key", "Value"])
      and (.Key | type == "string" and length > 0)
      and (.Value | type == "string")
      and (.Key | contains("\\") | not)
      and (.Value | contains("\\") | not)
      and (.Key | explode | all(. >= 32 and . != 127))
      and (.Value | explode | all(. >= 32 and . != 127)))
    and ([.[].Key] | unique | length) == length
  ' "$tags_file" >/dev/null

# JSON string quoting is also valid for SAM's quoted-tag grammar. It preserves
# spaces, equals signs, and double quotes without asking a shell to re-parse
# any data originating in the stack.
jq -r '.[] | "\(.Key | @json)=\(.Value | @json)"' "$tags_file"
