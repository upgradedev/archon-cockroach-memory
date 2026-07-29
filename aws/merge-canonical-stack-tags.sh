#!/usr/bin/env bash
# Build the exact tag set for the next SAM deployment without modifying the
# immutable pre-release snapshot used by recovery.
set -euo pipefail

if [ "$#" -ne 1 ] || [ ! -s "$1" ]; then
  echo "Usage: $0 <prior-stack-tags.json>" >&2
  exit 1
fi

for name in APP_NAME ENVIRONMENT; do
  if [ -z "${!name:-}" ]; then
    echo "$name is required for canonical stack tags." >&2
    exit 1
  fi
done

if ! [[ "$APP_NAME" =~ ^[a-z][a-z0-9-]{2,24}$ ]]; then
  echo "APP_NAME is invalid for canonical stack tags." >&2
  exit 1
fi
case "$ENVIRONMENT" in
  staging|production) ;;
  *)
    echo "Canonical stack tags are limited to staging or production." >&2
    exit 1
    ;;
esac
if [ -n "${GREENFIELD_OWNER:-}" ] &&
   ! [[ "$GREENFIELD_OWNER" =~ ^[0-9a-f]{64}$ ]]; then
  echo "GREENFIELD_OWNER is invalid for canonical stack tags." >&2
  exit 1
fi

jq -eS \
  --arg app "$APP_NAME" \
  --arg environment "$ENVIRONMENT" \
  --arg owner "${GREENFIELD_OWNER:-}" \
  '
    if (
      type == "array"
      and all(.[];
        ((keys | sort) == ["Key", "Value"])
        and (.Key | type == "string" and length > 0 and length <= 128)
        and (.Value | type == "string" and length <= 256)
        and (.Key | startswith("aws:") | not))
      and ([.[].Key] | unique | length) == length
    )
    then (
      map(
        select(
          .Key != "Application"
          and .Key != "Environment"
          and (
            $owner == ""
            or .Key != "ArchonGreenfieldOwner"
          )
        )
      )
      + [
          {Key: "Application", Value: $app},
          {Key: "Environment", Value: $environment}
        ]
      + (
          if $owner == ""
          then []
          else [{Key: "ArchonGreenfieldOwner", Value: $owner}]
          end
        )
      | sort_by(.Key)
      | if (
          length <= 50
          and ([.[].Key] | unique | length) == length
          and [.[] | select(.Key == "Application") | .Value] == [$app]
          and [.[] | select(.Key == "Environment") | .Value] ==
            [$environment]
          and (
            if $owner == ""
            then true
            else [.[] | select(.Key == "ArchonGreenfieldOwner") | .Value] ==
              [$owner]
            end
          )
        )
        then .
        else error("invalid canonical stack tags")
        end
    )
    else error("invalid prior stack tags")
    end
  ' "$1"
