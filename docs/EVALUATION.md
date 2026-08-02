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
| runtime partial parity | fresh production `MemoryAgent`, connection-pool, and `CockroachResolutionStore` instances against ephemeral CockroachDB | durable write/recall/audit across fresh instances, exact-key idempotency, conflict detection, fixed-sandbox approve/reject/replay/receipts, and sandbox/canonical isolation | full B4 runtime parity, canonical session/valid-time/retention/authority semantics, authenticated controller identity, canonical consolidation, external effects |
| representative scale | 100,000 generated lifecycle events, streamed back through an independent state transition evaluator | bounded-memory policy rehearsal, 20,000 entities, decision retry/idempotency, action count, `unauthorizedActions=0` | a real production corpus, hosted load, an SLA |
| vector retrieval | real CockroachDB v26.2.3 in an ephemeral CI database | C-SPANN recall@k and latency against brute-force exact cosine ground truth | exact-scan latency, another product's performance |
| human/impact synthetic pilot | pipeline-owned authored fixture with synthetic raters and paired trials | schema, signature, statistics, claim-boundary, negative-control, and receipt path | human evaluation, real user behavior, customer or production impact |
| qualified human/business study | protected workflow and protocol are ready; no qualified dataset has passed yet | after collection: signed independent B2/B4 ratings and paired consenting-participant outcomes | production-scale corpus, customer deployment, ROI, savings, or extrapolation beyond the study |

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
only production-eligible policy in this authored policy evaluation. That flag does
not assert that every B4 field exists in the canonical runtime schema.

The semantic scores in the JSON fixture are fixed inputs. They isolate lifecycle
policy differences and must not be described as measured embedding or C-SPANN
scores. The workflow separately runs the real C-SPANN benchmark so retrieval
evidence and policy evidence cannot be conflated.

The pure evaluator lives in `src/evaluation/memory-policy.ts` and is imported by
both the CLI adapter and its mutation/meta tests. A separate exact-SHA runtime
harness exercises the supported production paths. It deliberately reports partial
parity: canonical memory proves durable write/recall/audit behavior, while the fixed
resolution sandbox proves transactional approve/reject/replay behavior without
mutating canonical memory.

The public sandbox's `financial-controller` role is a fixed demo assertion, not an
authenticated identity. Its receipts and human click prove an explicit approval
boundary, but the submission must not describe them as enterprise role assurance.

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
- proposal decision accuracy over proposal cases only;
- safe no-action rate over rejected, pending, or wrong-role proposal cases;
- exact action match over proposal cases with a non-null expected action;
- action execution count;
- unauthorized action count;
- duplicate decision suppressions.

Evidence metrics use exact fixture identifiers. An answer is correct only when both
the evidence identifier and abstention state match. The report publishes numerator
and denominator counts for all three action metrics. Proposal-decision accuracy has
five eligible cases, safe no-action has three, and exact action match has two in the
current fixture; unrelated null/null cases cannot inflate any of them. Exact action
equality is canonical JSON equality over type, target, parameters, and idempotency
identifier. Answer and evidence precision/recall are macro-averaged per case;
contradiction and abstention precision/recall use aggregate classification counts.

The workflow runs malformed-fixture, label-corruption, one-control mutation,
denominator, deterministic-comparison, and vector-provenance negative tests before
generating evidence. Required evaluation cohorts must be non-empty, so an absent
test cohort cannot receive a vacuous perfect score.

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

The workflow records a separate provenance object only after the benchmark
completes. It queries the running database version, binds the raw log and exact
`scripts/benchmark.ts` source digest, and checks that the exact-top-k truth-set and
C-SPANN distance-query source contracts are present. The finalizer derives
`realCockroachDbRun` and `exactGroundTruthPresent` from that evidence and count
agreement with the parsed benchmark summary; neither gate is a literal boolean.
Source-contract attestation is reviewable integrity evidence, not formal
verification.

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
no ratings. The protected implementation is documented in
[`HUMAN_IMPACT_EVIDENCE.md`](./HUMAN_IMPACT_EVIDENCE.md). Human evidence becomes
valid only after:

1. at least three qualified finance reviewers participate voluntarily;
2. raw pseudonymous ratings and exclusions are preserved by the independent
   collection custodian and bound by a custody-receipt digest;
3. every rating is bound to a distinct reviewer identity-attestation digest and
   verified Ed25519 signing key;
4. paired results, confidence intervals, and inter-rater agreement are calculated;
5. the raw dataset digest, sanitized analysis, exact application SHA, protected
   approval, and output artifact digests are bound into a canonical CI receipt.

The ordinary pull-request workflow evaluates only
`evals/human-impact-synthetic-pilot.json`. It proves the analysis and claim
boundary, not human participation. Until a protected qualified-study receipt
passes, submission wording must say “human evaluation protocol and synthetic
pilot prepared,” not “human evaluated.”

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
actually performed. Even a successful qualified-study receipt supports only a
bounded sampled outcome; the gate keeps production, customer, ROI, and savings
claims false.

## Uploaded evidence

Every successful run uploads:

- `policy-results.json`;
- `runtime-longitudinal-results.json`;
- `scale-manifest.json`;
- `vector-benchmark.log`;
- `vector-provenance.json`;
- `vector-results.json`;
- `memory-evaluation-receipt.json`.

For compatibility with the existing protected deployment contract, the receipt's
four primary evidence entries remain policy, scale, vector result, and raw vector
log. The runtime artifact and vector provenance are still exact-SHA-bound:
`policy-results.json` embeds the full runtime result plus its SHA-256, and
`vector-results.json` embeds the provenance plus its SHA-256. The receipt seals
those two containing artifacts, and the workflow independently rechecks both
transitive bindings before upload.

The receipt records the repository, exact SHA, workflow/run identifiers, primary
artifact hashes, gate outcomes, supported claims, and explicitly unsupported
claims. Deployment/readiness should consume the successful required check for that
exact SHA rather than trusting copied numbers in documentation.

The separate human-impact workflow uploads only aggregated
`human-impact-results.json`, disclosure-safe `human-impact-input-manifest.json`,
and sealed `human-impact-receipt.json`. Raw reviewer identities, participant IDs,
ratings, signatures, and trials are deleted from `RUNNER_TEMP` before upload.
Protected-main synthetic and protected qualified-study receipts receive GitHub
build-provenance attestations in isolated no-checkout jobs; a copied receipt alone
is not accepted as evidence.
