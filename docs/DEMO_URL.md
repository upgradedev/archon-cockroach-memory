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

## Seeding the demo data

The Cloud store is seeded with a representative fused payroll event (real Titan embeddings)
so the headline question answers substantively:

```bash
AWS_PROFILE=default DATABASE_URL='postgresql://…' DEMO_RESET=1 npm run demo:seed
```

## Verified live response (2026-07-13)

A signed request to the live URL with the headline question returned **HTTP 200** with a real
**Claude Sonnet** answer (`modelId: us.anthropic.claude-sonnet-4-6`) grounded in real
**CockroachDB Cloud** memories recalled via real **Titan** embeddings:

> "In April 2026, Helios SA had **4 employees** with a true employer cost of **€15,375** [2].
> The bank salary transfer was only **€8,600**, creating an off-bank employer-cost wedge of
> **€6,775** — driven primarily by employer social-security contributions of **€3,075**
> (approximately 35.8% of the bank transfer alone) [1][2]."

```json
{ "modelId": "us.anthropic.claude-sonnet-4-6", "recalled": 5,
  "citations": [
    { "marker": "[1]", "kind": "insight",
      "content": "Off-bank employment cost at Helios SA for 2026-04: the bank salary transfer of €8,600 understates the true cost of employing the team by €6,775 …" },
    { "marker": "[2]", "kind": "payroll_event",
      "content": "Payroll for Helios SA in 2026-04: 4 employees, gross €12,300, true employer cost €15,375, net paid from bank €8,600." } ],
  "consistencyOk": true }
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
