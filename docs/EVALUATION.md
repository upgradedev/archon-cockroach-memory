# Memory architecture evaluation

Archon Memory has a pipeline-owned evaluation path for the questions a strict
judge should ask: does memory survive sessions, respect time and scope, preserve
conflicts, abstain when it should, consolidate only after the right human
decision, and execute an approved action exactly once?

The workflow is `.github/workflows/memory-evaluation.yml`. It checks out the exact
source SHA, runs entirely on a GitHub-hosted runner, and uploads a SHA-bound receipt.
Do **not** run this harness on a developer workstation. The harness refuses to run
without `CI=true` and refuses to write outside `RUNNER_TEMP`.

## Evidence tiers and claim boundaries

| Tier | What runs | What it supports | What it does not support |
|---|---|---|---|
| deterministic longitudinal | 15 independently authored synthetic finance cases | B0–B4 comparison, multi-session correction, valid-time behavior, conflicts, source authority, abstention, forgetting eligibility, consolidation, human gate, exact action parameters | embedding quality, customer behavior, production latency |
| representative scale | 100,000 generated lifecycle events, streamed back through an independent state transition evaluator | bounded-memory policy rehearsal, 20,000 entities, decision retry/idempotency, action count, `unauthorizedActions=0` | a real production corpus, hosted load, an SLA |
| vector retrieval | real CockroachDB v26.2.3 in an ephemeral CI database | C-SPANN recall@k and latency against brute-force exact cosine ground truth | exact-scan latency, another product's performance |
| human evaluation | protocol in `evals/human-evaluation-protocol.json` | a ready, blinded collection plan | **no result yet**; it requires real qualified reviewers |
| business impact | not yet collected | nothing until a real user trial is completed | no ROI, time-saved, or error-reduction claim |

Synthetic and representative are intentional labels. The pipeline must never rename
either corpus to “real,” “customer,” or “production.” A real production-scale corpus
requires permission, documented provenance, privacy review, and an independently
reproducible receipt.

## Fair B0–B4 comparison

Every policy baseline receives the same case, observed evidence, query cutoff,
semantic-score fixture, and threshold. All timestamps and expected outcomes are
declared before execution in `evals/longitudinal-cases.json`.

| ID | Architecture under test |
|---|---|
| `B0_SESSION_ONLY` | current-session context only |
| `B1_LEXICAL` | persistent lexical overlap |
| `B2_VECTOR_ONLY` | vector-score-only selection without lifecycle policy |
| `B3_VECTOR_SCOPE_TIME` | vector selection plus tenant/company and valid-time filters |
| `B4_FULL_LIFECYCLE` | scope + time + contradiction + authority + abstention + human-gated consolidation/action |

`B1` and `B2` are research comparators, not deployable configurations. They
deliberately omit safety controls so their failure modes are measurable. B4 is the
only production-eligible policy in this evaluation.

The semantic scores in the JSON fixture are fixed inputs. They isolate lifecycle
policy differences and must not be described as measured embedding or C-SPANN
scores. The workflow separately runs the real C-SPANN benchmark so retrieval
evidence and policy evidence cannot be conflated.

This harness evaluates the declared architecture policy; it is not a substitute for
the runtime resolution API/store tests. A release claim requires both this required
check and the exact-SHA integration/hosted checks that exercise the implemented
CockroachDB transaction, role boundary, TTL filter, and HTTP action path.

## Ablation study

Each ablation starts from B4 and removes exactly one control:

- `A_NO_SCOPE`
- `A_NO_TEMPORAL`
- `A_NO_CONTRADICTION`
- `A_NO_AUTHORITY`
- `A_NO_ABSTENTION`
- `A_NO_CONSOLIDATION`
- `A_NO_FORGETTING`
- `A_NO_HUMAN_GATE`

The pipeline fails unless every removal has its expected directional consequence.
In particular, removing the human gate must produce at least one unauthorized
synthetic action, while B4 must remain at exactly zero. This is a negative-control
experiment, not a deployable mode.

## Metrics

The policy report contains per-case predictions as well as aggregate values:

- answer accuracy, including correct abstention;
- evidence precision and recall;
- contradiction precision, recall, and F1;
- abstention precision, recall, and F1;
- temporal-update and longitudinal subsets;
- action decision accuracy and exact parameter match;
- action execution count;
- unauthorized action count;
- duplicate decision suppressions.

Evidence metrics use exact fixture identifiers. An answer is correct only when both
the evidence identifier and abstention state match. Action equality is canonical
JSON equality over type, target, parameters, and idempotency key. Accuracy and
evidence precision/recall are macro-averaged per case; contradiction and abstention
precision/recall are calculated from aggregate classification counts.

The synthetic deterministic gate currently requires perfect B4 results. This is
appropriate for authored policy invariants; it is **not** a claim of perfect
performance on natural language or real customer data.

The forgetting case proves that retracted or retention-expired evidence is
ineligible for recall even before asynchronous physical deletion completes. It does
not measure the CockroachDB row-level TTL scheduler; schema and integration tests
must prove that storage-level control separately.

## 100k-event lifecycle rehearsal

The workflow generates five events for each of 20,000 synthetic entities:

1. an original observation in session A;
2. a conflicting proposal in session B;
3. an approved, rejected, or pending decision;
4. an idempotent retry;
5. a session C query.

The JSONL corpus exists only in the runner's temporary directory. A separate
streaming pass validates ordering and lifecycle transitions, calculates the corpus
SHA-256, and then deletes the raw file. The uploaded scale manifest includes the
generator version, checksum, byte count, metrics, and exact source SHA. Anyone can
regenerate the same corpus from that source revision without storing a large
generated artifact in Git.

Runner throughput is recorded as an observation and is not a release threshold;
GitHub runner contention makes it unsuitable as an SLA. Hosted load and latency
remain the responsibility of the load-test pipeline.

## Exact scan versus C-SPANN

The existing `scripts/benchmark.ts` generates deterministic clustered vectors and
queries. For every query it calculates brute-force cosine top-k in JavaScript, then
measures the CockroachDB C-SPANN result:

`recall@k = |C-SPANN top-k ∩ exact top-k| / k`

The memory-evaluation workflow uses a real ephemeral CockroachDB instance, at least
2,000 vectors, at least 75 queries, and two beam sizes. It fails below the declared
recall floor and records p50/p95/p99 C-SPANN latency. It does not currently time a
database exact-scan plan, so the receipt explicitly excludes an exact-latency claim.

This is the useful comparison for the current entry: exact ground truth quantifies
the accuracy traded for approximate distributed retrieval. A broader benchmark
against unrelated memory products is not required by the challenge and would only
be credible with identical data, model, query budget, hardware, warm-up, top-k,
seeds, and cost accounting.

## Existing public benchmarks

Existing implementations can extend coverage, but they are not on the critical path
and are not downloaded by the current workflow:

- [LongMemEval](https://github.com/xiaowu0162/LongMemEval) is a candidate for
  long-conversation recall.
- [LoCoMo](https://github.com/snap-research/locomo) is a candidate for
  long-term conversational-memory questions.
- [Mem2ActBench](https://aclanthology.org/2026.acl-long.370.pdf) is a candidate
  for memory-to-action evaluation.

Before enabling an adapter, a pull request must record the upstream repository,
license, immutable commit, file checksums, allowed redistribution, selected split,
and normalization mapping. CI must download to `RUNNER_TEMP`, verify every checksum,
and upload only redistribution-safe results. We must not copy competitor headline
numbers, tune on their held-out answers, or call an adapter “production data.”

LongMemEval-V2-scale haystacks are intentionally not a release prerequisite. A very
large context benchmark can consume substantial time and tokens without testing the
entry's core lifecycle and action-authority properties.

## Human evaluation

`evals/human-evaluation-protocol.json` defines a blinded B2-versus-B4 study with
answer correctness, grounding, calibration, and action-safety rubrics. It contains
no ratings. Human evidence becomes valid only after:

1. at least three qualified finance reviewers participate voluntarily;
2. raw pseudonymous ratings and exclusions are preserved;
3. paired results, confidence intervals, and inter-rater agreement are calculated;
4. the dataset, analysis, and exact application SHA are bound into a CI receipt.

Until then, submission wording must say “human evaluation protocol prepared,” not
“human evaluated.”

## Quantified business outcome

Benchmark accuracy is not business impact. A defensible outcome study needs a
pre-registered task, baseline workflow, real consenting participants, and measures
such as:

- time to locate and validate the current fact;
- correction or contradiction miss rate;
- unauthorized action attempts;
- reviewer effort per resolved conflict;
- accepted versus rejected proposals.

Report distributions and confidence intervals, not a single best run. Any
time-saved, cost-saved, or risk-reduction claim remains pending until that study is
actually performed.

## Uploaded evidence

Every successful run uploads:

- `policy-results.json`;
- `scale-manifest.json`;
- `vector-benchmark.log`;
- `vector-results.json`;
- `memory-evaluation-receipt.json`.

The receipt records the repository, exact SHA, workflow/run identifiers, SHA-256 of
every artifact, gate outcomes, supported claims, and explicitly unsupported claims.
Deployment/readiness should consume the successful required check for that exact SHA
rather than trusting copied numbers in documentation.
