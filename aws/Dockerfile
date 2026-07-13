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

FROM public.ecr.aws/lambda/nodejs:20

WORKDIR /var/task
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

# Bundle the Function URL handler to ${LAMBDA_TASK_ROOT}/lambda.js (exports `handler`).
RUN npx esbuild src/lambda.ts \
      --bundle --platform=node --target=node20 --format=cjs \
      --external:pg-native --external:@aws-sdk/signature-v4-crt \
      --outfile=${LAMBDA_TASK_ROOT}/lambda.js

# Lambda invokes the exported `handler` from lambda.js.
CMD ["lambda.handler"]
