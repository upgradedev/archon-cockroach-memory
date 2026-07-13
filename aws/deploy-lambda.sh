#!/usr/bin/env bash
# Deploy the public Archon Memory recall demo as an AWS Lambda + Function URL.
#
# The Lambda wraps `new MemoryAgent(defaultEmbedder(), defaultNarrator()).recallAnswer(q)`
# (src/lambda.ts → src/http/handler.ts): real Bedrock Titan embeddings + Claude
# narration (the execution role injects AWS creds) over CockroachDB Cloud (DATABASE_URL).
#
# Packaging is automatic:
#   • docker present  → build the container image (aws/Dockerfile), push to ECR,
#                       deploy a container-image Lambda.
#   • docker absent   → esbuild-bundle the handler into a zip and deploy a
#                       zip Lambda (identical handler bundle, no docker needed).
#
# Money-safety: reserved concurrency is capped (default 3), the timeout is short,
# and the handler bounds question length — a public URL cannot run away with cost.
#
# Prereqs: aws CLI (v2) authenticated, and:
#   DATABASE_URL   CockroachDB Cloud connection string (verify-full)
# Optional overrides: AWS_REGION (default us-west-2 — Bedrock region on this
#   account; us-east-1 is gated), FN_NAME, ECR_REPO, RESERVED_CONCURRENCY, MEMORY_MB.
#
#   DATABASE_URL='postgresql://…' bash aws/deploy-lambda.sh
set -euo pipefail

REGION="${AWS_REGION:-us-west-2}"
FN="${FN_NAME:-archon-cockroach-memory}"
ROLE="${FN}-role"
ECR_REPO="${ECR_REPO:-archon-cockroach-memory}"
RESERVED="${RESERVED_CONCURRENCY:-3}"
MEMORY_MB="${MEMORY_MB:-512}"
TIMEOUT="${TIMEOUT:-30}"
BEDROCK_REGION="${BEDROCK_REGION:-$REGION}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

: "${DATABASE_URL:?set DATABASE_URL to the CockroachDB Cloud connection string}"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
echo "▸ account=$ACCOUNT region=$REGION fn=$FN"

# ── 1. IAM execution role: logs + bedrock:InvokeModel ───────────────────────────
# bedrock:InvokeModel on Resource:* — the Claude model is a cross-region inference
# profile whose invocation touches multiple foundation-model ARNs; for a tiny,
# concurrency-capped demo a wildcard is the pragmatic, correct scope.
if ! aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  echo "▸ creating role $ROLE"
  aws iam create-role --role-name "$ROLE" \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  aws iam attach-role-policy --role-name "$ROLE" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole >/dev/null
  echo "▸ waiting for role to propagate…"; sleep 10
fi
aws iam put-role-policy --role-name "$ROLE" --policy-name bedrock-invoke \
  --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["bedrock:InvokeModel","bedrock:InvokeModelWithResponseStream"],"Resource":"*"}]}' >/dev/null
ROLE_ARN="$(aws iam get-role --role-name "$ROLE" --query Role.Arn --output text)"

# ── 2. Package: container image (docker) OR esbuild zip (no docker) ─────────────
PACKAGE_TYPE=""
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  echo "▸ docker present → building container image"
  aws ecr describe-repositories --repository-names "$ECR_REPO" --region "$REGION" >/dev/null 2>&1 \
    || aws ecr create-repository --repository-name "$ECR_REPO" --region "$REGION" >/dev/null
  REGISTRY="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"
  IMAGE="${REGISTRY}/${ECR_REPO}:latest"
  aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"
  docker build -f "$HERE/aws/Dockerfile" -t "$IMAGE" "$HERE"
  docker push "$IMAGE"
  PACKAGE_TYPE="Image"
else
  echo "▸ docker absent → esbuild zip package"
  rm -rf "$HERE/build"; mkdir -p "$HERE/build"
  npx --prefix "$HERE" esbuild "$HERE/src/lambda.ts" \
    --bundle --platform=node --target=node20 --format=cjs \
    --external:pg-native --external:@aws-sdk/signature-v4-crt \
    --outfile="$HERE/build/lambda.js"
  # Zip the bundle with lambda.js at the archive ROOT (handler = lambda.handler).
  # Prefer `zip`; fall back to python (portable on Windows git-bash, which has no zip).
  ( cd "$HERE/build"
    if command -v zip >/dev/null 2>&1; then
      zip -q function.zip lambda.js
    elif command -v python >/dev/null 2>&1 || command -v python3 >/dev/null 2>&1; then
      PY="$(command -v python3 || command -v python)"
      "$PY" -c "import zipfile; z=zipfile.ZipFile('function.zip','w',zipfile.ZIP_DEFLATED); z.write('lambda.js'); z.close()"
    else
      echo "need 'zip' or 'python' to package the zip" >&2; exit 1
    fi
  )
  PACKAGE_TYPE="Zip"
fi

# aws CLI needs a native path for `fileb://`; on Windows git-bash convert the MSYS
# path (/c/…) to a mixed Windows path (C:/…) so aws.exe can read the zip.
ZIP_FILE="$HERE/build/function.zip"
if command -v cygpath >/dev/null 2>&1; then ZIP_FILE="$(cygpath -m "$ZIP_FILE")"; fi

# ── 3. Create or update the function ────────────────────────────────────────────
ENV_VARS="Variables={DATABASE_URL=${DATABASE_URL},BEDROCK_REGION=${BEDROCK_REGION},RECALL_MAX_QUESTION_CHARS=500,NODE_OPTIONS=--enable-source-maps}"
exists() { aws lambda get-function --function-name "$FN" --region "$REGION" >/dev/null 2>&1; }

if [ "$PACKAGE_TYPE" = "Image" ]; then
  if exists; then
    aws lambda update-function-code --function-name "$FN" --image-uri "$IMAGE" --region "$REGION" >/dev/null
  else
    aws lambda create-function --function-name "$FN" --package-type Image \
      --code ImageUri="$IMAGE" --role "$ROLE_ARN" \
      --timeout "$TIMEOUT" --memory-size "$MEMORY_MB" --region "$REGION" >/dev/null
  fi
else
  if exists; then
    aws lambda update-function-code --function-name "$FN" \
      --zip-file "fileb://$ZIP_FILE" --region "$REGION" >/dev/null
  else
    aws lambda create-function --function-name "$FN" --runtime nodejs20.x \
      --handler lambda.handler --zip-file "fileb://$ZIP_FILE" \
      --role "$ROLE_ARN" --timeout "$TIMEOUT" --memory-size "$MEMORY_MB" --region "$REGION" >/dev/null
  fi
fi

echo "▸ waiting for code update…"
aws lambda wait function-updated --function-name "$FN" --region "$REGION"
aws lambda update-function-configuration --function-name "$FN" \
  --timeout "$TIMEOUT" --memory-size "$MEMORY_MB" --environment "$ENV_VARS" --region "$REGION" >/dev/null
aws lambda wait function-updated --function-name "$FN" --region "$REGION"

# Cost circuit-breaker: cap reserved concurrency.
aws lambda put-function-concurrency --function-name "$FN" \
  --reserved-concurrent-executions "$RESERVED" --region "$REGION" >/dev/null

# ── 4. Function URL ──────────────────────────────────────────────────────────────
# FURL_AUTH_TYPE: AWS_IAM (default — SigV4-signed requests) or NONE (anonymous public).
# NOTE: some accounts/orgs block anonymous (NONE) Function URLs with an SCP/guardrail —
# an anonymous request then returns 403 even though the config + resource policy are
# correct. On such accounts use AWS_IAM (the default here) and invoke with a signed
# request (see docs/DEMO_URL.md). Both are allowed by the challenge rules.
FURL_AUTH_TYPE="${FURL_AUTH_TYPE:-AWS_IAM}"
if aws lambda get-function-url-config --function-name "$FN" --region "$REGION" >/dev/null 2>&1; then
  aws lambda update-function-url-config --function-name "$FN" --auth-type "$FURL_AUTH_TYPE" --region "$REGION" >/dev/null
else
  aws lambda create-function-url-config --function-name "$FN" --auth-type "$FURL_AUTH_TYPE" --region "$REGION" >/dev/null
fi
if [ "$FURL_AUTH_TYPE" = "NONE" ]; then
  aws lambda add-permission --function-name "$FN" --statement-id FunctionURLPublic \
    --action lambda:InvokeFunctionUrl --principal '*' --function-url-auth-type NONE --region "$REGION" >/dev/null 2>&1 || true
else
  aws lambda add-permission --function-name "$FN" --statement-id AccountIamInvoke \
    --action lambda:InvokeFunctionUrl --principal "$ACCOUNT" --function-url-auth-type AWS_IAM --region "$REGION" >/dev/null 2>&1 || true
fi
URL="$(aws lambda get-function-url-config --function-name "$FN" --query FunctionUrl --output text --region "$REGION")"

# ── 5. Verify ───────────────────────────────────────────────────────────────────
echo "▸ Function URL ($FURL_AUTH_TYPE): $URL"
echo "▸ verifying recall (real Bedrock + CockroachDB)…"
sleep 5
Q='{"question":"What was the true employer cost and the off-bank wedge?","limit":5}'
if [ "$FURL_AUTH_TYPE" = "NONE" ]; then
  curl -fsS -X POST "$URL" -H 'content-type: application/json' -d "$Q" | head -c 1200
else
  AKID="$(aws configure get aws_access_key_id)"; SECRET="$(aws configure get aws_secret_access_key)"
  TOK_ARG=(); ST="$(aws configure get aws_session_token || true)"; [ -n "$ST" ] && TOK_ARG=(-H "x-amz-security-token: $ST")
  curl -fsS --aws-sigv4 "aws:amz:${REGION}:lambda" --user "${AKID}:${SECRET}" "${TOK_ARG[@]}" \
    -X POST "$URL" -H 'content-type: application/json' -d "$Q" | head -c 1200
fi
echo
echo "▸ done. Demo URL: $URL"
