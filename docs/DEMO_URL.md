# Public demo — AWS Lambda Function URL

The recall path (`MemoryAgent.recallAnswer` → ANN vector search over the CockroachDB
distributed vector index → Bedrock narration) is deployed as a **public AWS Lambda
Function URL**. It runs **real** AWS Bedrock Titan embeddings + Claude Sonnet narration
(the Lambda execution role injects credentials) over **CockroachDB Cloud** (`DATABASE_URL`).

## Live URL

**`https://g5ocwu4w33tkcnmfmbh3nstbxy0hqdxa.lambda-url.us-west-2.on.aws/`**

- **Region:** us-west-2 · **Runtime:** nodejs20.x (zip) · **Auth:** `AWS_IAM` (SigV4-signed).
- **Why IAM, not anonymous:** this AWS account blocks anonymous (`AuthType NONE`) Function
  URLs with an account/org guardrail — an unauthenticated request returns `403 Forbidden`
  even with a correct config + public resource policy. IAM auth is explicitly allowed by the
  challenge rules, so the URL is deployed with `AWS_IAM` and invoked with a signed request.
  (To deploy anonymously on an account without that guardrail: `FURL_AUTH_TYPE=NONE bash
  aws/deploy-lambda.sh`.)

Deploy / redeploy: `DATABASE_URL='postgresql://…' bash aws/deploy-lambda.sh` (idempotent).

## Usage (SigV4-signed)

```bash
URL="https://g5ocwu4w33tkcnmfmbh3nstbxy0hqdxa.lambda-url.us-west-2.on.aws/"
AKID="$(aws configure get aws_access_key_id)"; SECRET="$(aws configure get aws_secret_access_key)"

# ask the agent's memory a question
curl --aws-sigv4 "aws:amz:us-west-2:lambda" --user "$AKID:$SECRET" \
  -X POST "$URL" -H 'content-type: application/json' \
  -d '{"question":"What was the true employer cost and the off-bank wedge?","limit":5}'
```

The response carries the grounded `answer`, the Bedrock `modelId`, the number of memories
`recalled`, the `citations` (the exact memories the answer is grounded in), and
`consistencyOk` (the self-audit over the recalled top-k).

## Verified live response (2026-07-13)

A signed request returned **HTTP 200** with a real **Claude Sonnet** answer
(`modelId: us.anthropic.claude-sonnet-4-6`) grounded in real **CockroachDB Cloud** memories
recalled via real **Titan** embeddings — the model even flagged a stored contradiction:

> "…a discrepancy worth flagging: the two invoice totals conflict, with one record showing
> €18,900 and a 'confirmed' record showing €18,400, which warrants reconciliation…"

```json
{ "modelId": "us.anthropic.claude-sonnet-4-6", "recalled": 3,
  "citations": [ { "marker": "[1]", "kind": "document",
                   "content": "Invoice INV-2043 for Northwind Traders totalled €18,900 (later note)." }, … ],
  "consistencyOk": false }
```

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
