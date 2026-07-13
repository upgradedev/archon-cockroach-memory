# Public demo — AWS Lambda Function URL

The recall path (`MemoryAgent.recallAnswer` → ANN vector search over the CockroachDB
distributed vector index → Bedrock narration) is deployed as a **public AWS Lambda
Function URL**. It runs **real** AWS Bedrock Titan embeddings + Claude Sonnet narration
(the Lambda execution role injects credentials) over **CockroachDB Cloud** (`DATABASE_URL`).

## Live URL

<!-- LIVE_URL -->
_Deploy with `DATABASE_URL='postgresql://…' bash aws/deploy-lambda.sh`; the script prints
and this doc records the Function URL._

## Usage

```bash
# health / usage
curl "$URL"

# ask the agent's memory a question (GET)
curl "$URL?q=What+was+the+true+employer+cost+and+the+off-bank+wedge%3F"

# or POST JSON
curl -X POST "$URL" -H 'content-type: application/json' \
  -d '{"question":"What was the true employer cost and the off-bank wedge?","limit":5}'
```

The response contains the grounded `answer`, the Bedrock `modelId`, the number of memories
`recalled`, and the `citations` (the exact memories the answer is grounded in).

## How it is deployed

`aws/deploy-lambda.sh` is idempotent (create-or-update) and packages the handler two ways:

- **docker present** → builds the container image ([`aws/Dockerfile`](../aws/Dockerfile)),
  pushes to ECR, deploys a container-image Lambda;
- **docker absent** → esbuild-bundles the handler into a zip and deploys a zip Lambda
  (identical handler bundle — `@aws-sdk` Titan+Claude and `pg` are inlined).

**Money-safety:** reserved concurrency is capped (default 3), the timeout is short, and the
handler bounds question length — a public URL cannot run away with cost. The IAM execution
role grants `bedrock:InvokeModel` (Titan embed + the Claude cross-region inference profile)
and CloudWatch Logs; a non-VPC Lambda reaches CockroachDB Cloud over its public
`verify-full` endpoint.
