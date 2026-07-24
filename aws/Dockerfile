# AWS Lambda container image for the public Archon Memory recall demo.
#
# Wraps src/lambda.ts (which calls MemoryAgent.recallAnswer over the CockroachDB
# distributed vector index + Bedrock). Built and pushed to ECR by aws/deploy-lambda.sh
# when docker is available; the same script falls back to an esbuild zip package when
# it is not (the handler bundle is identical either way).
#
#   docker build -f aws/Dockerfile -t archon-cockroach-memory .
#
# The image bundles the handler with esbuild into a single CJS file at the Lambda
# task root; @aws-sdk (Titan + Claude) and pg (CockroachDB) are inlined, only
# optional native deps (pg-native, signature-v4-crt) are left external and are
# gracefully skipped at runtime.

FROM amazon/aws-lambda-nodejs:22.2026.07.20.07-x86_64@sha256:848fd1a3f02f63bdbadb9b57107e33f1f01239cddbc0a8c6c13b70c8e87ddbd0

WORKDIR /var/task
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

# Bundle the Function URL handler to ${LAMBDA_TASK_ROOT}/lambda.js (exports `handler`).
RUN ./node_modules/.bin/esbuild src/lambda.ts \
      --bundle --platform=node --target=node22 --format=cjs \
      --external:pg-native --external:@aws-sdk/signature-v4-crt \
      --outfile=${LAMBDA_TASK_ROOT}/lambda.js

# Lambda invokes the exported `handler` from lambda.js.
CMD ["lambda.handler"]
