# Archon Memory — final demo video plan

Target runtime: **2:50 (170 seconds)**  
Hard limit: **strictly under 3:00**  
Delivery: public, embeddable YouTube or Vimeo link  
Language: English narration with accurate English captions

The recording is intentionally the final production step. It must use the
public production URL and the exact release that has passed CI, CodeQL,
production deployment, recovery audit, and the standalone Managed MCP audit.
No generated video, frames, audio, or editing output belongs in this repository.

## Storyboard and narration

### 0:00–0:12 — hook

**Screen**

- Product title.
- Open the live Control Room.
- Briefly frame the contradiction indicator.

**Narration**

> An AI agent can remember a plausible financial fact and still be wrong.
> Archon Memory makes persistent memory disagree out loud before a CFO acts.

### 0:12–0:27 — scope and architecture

**Screen**

- Show the fixed `public-demo / Helios SA / read-only` scope.
- Briefly show the owned architecture slide.

**Narration**

> This is a public, synthetic, read-only AWS serverless application. CockroachDB
> holds the relational truth, lifecycle, provenance, audit state, and native
> vector memory in one serializable system.

### 0:27–1:15 — live C-SPANN recall and grounding

**Screen**

- Ask: “What was the true employer cost and the off-bank wedge?”
- First highlight Store integrity, provenance, and idempotency on the proof strip.
- Show the answer.
- Expand citations and the retrieval/grounding trace.
- Highlight `€15,375`, `€6,775`, the exact evidence rows, native C-SPANN,
  Titan embeddings, and the citation/numeric/claim checks.

**Narration**

> The agent idempotently stores embedded facts with provenance, lifecycle, and
> payload-bound digests. This question is embedded by Titan and recalled through CockroachDB's native
> C-SPANN index under the exact tenant, model, lifecycle, and company prefixes.
> The answer reports a true employer cost of fifteen thousand three hundred
> seventy-five euros and an off-bank wedge of six thousand seven hundred
> seventy-five euros. Every claim links to an exact stored memory. If the model
> wording fails citation, numeric, or claim checks, the app replaces it with a
> deterministic rendering of the cited evidence.

### 1:15–1:55 — contradiction and missing evidence

**Screen**

- Open the audit ledger.
- Highlight the two `INV-2043` totals.
- Highlight missing `PAY-118` referenced by `RECON-2043`.
- Show “No automatic mutation.”

**Narration**

> Semantic recall is not a complete memory audit. This bounded exhaustive pass
> finds a deliberate invoice conflict: eighteen thousand four hundred versus
> eighteen thousand nine hundred euros. It recommends the higher-importance
> evidence without rewriting either record. It also finds a reconciliation that
> references payment PAY-118, which was never stored. Unknown stays unknown.

### 1:55–2:20 — live proof ledger

**Screen**

- Open proof.
- Highlight CockroachDB Cloud on AWS, `eu-west-1`, production runtime
  principal, exact release SHA, native C-SPANN, 1024 dimensions, and `9 / 9 / 9`.
- Briefly show the owned scale-evidence card: 5k–10k eval corpora, RF=3, and
  single-node-loss recall.

**Narration**

> The live proof ledger identifies the exact release, database, role, region,
> models, and catalog-backed vector index. It deterministically verifies nine persisted
> memories, nine unique idempotency keys, and nine payload-bound content
> digests. Separate reproducible evaluations cover larger corpora, RF-three
> placement, and recall after one node is stopped.

### 2:20–2:40 — independent Managed MCP release proof

**Screen**

- Show an owned, neutral evidence card for the successful standalone
  `Cockroach Cloud Managed MCP Audit` at the exact release SHA.
- Show only the sanitized receipt summary; do not show GitHub chrome or logos.
- Display the four call labels: cluster identity, table list, schema, bounded
  aggregate.

**Narration**

> The financial agent uses distributed vector indexing.
> A separate deterministic release controller uses CockroachDB Cloud Managed MCP
> for exactly four hosted read-only calls and accepts only the same fixed-scope nine-nine-nine result.
> The receipt exposes no credentials, connection material, memory text, or
> embeddings.

### 2:40–2:50 — impact and close

**Screen**

- Return to the Control Room.
- Show repository and demo URLs.
- End on the tagline.

**Narration**

> Archon Memory turns agent memory from a hidden cache into inspectable,
> contradiction-aware financial evidence. The live demo and full source are
> public.

## Recording checklist

- Use a clean browser profile with no personal tabs, bookmarks, notifications,
  tokens, account IDs, or cloud-console secrets visible.
- Record the real public production URL; do not use local or staging footage.
- Preload the app once, then record one continuous judge journey where practical.
- Keep browser zoom and pointer movement readable at 1080p or better.
- Capture actual response states; do not replace live results with mockups.
- Render release evidence as an owned neutral card with only public run metadata;
  do not record GitHub UI chrome, trademarks, or logos.
- Use no copyrighted music, stock footage, borrowed logo files, or third-party
  visual assets.
- Use the checked-in owned thumbnail for the video cover where supported.
- Set the public YouTube or Vimeo title to include the exact product name
  `Archon Memory`; the hosted gate verifies that provider metadata.
- Verify captions against the final spoken track.
- Export below 180 seconds, then verify duration in the hosting UI.
- Set visibility to public and embedding to allowed.
- Open the final URL in a signed-out/private browser before dispatching the
  hosted pre-submit gate.

## Final evidence sequence

1. Merge the final source release to `main`.
2. Confirm the public repository Website field is the exact production URL:
   `https://d2s5v0o0eg2aaw.cloudfront.net`.
3. Wait for successful CI, CodeQL, Deploy AWS, hosted E2E, and automatic
   recovery classification.
4. Dispatch `Recover AWS` with `operation=audit` and require both staging and
   production protection/drift audit uploads to pass.
5. Dispatch and complete the standalone Managed MCP audit for that exact SHA.
6. Record and upload the video with `Archon Memory` in the provider title.
7. Dispatch `Submission readiness` in `pre-submit` mode with the public video
   URL, verified integer duration, and both visibility/embed and accurate
   English-caption attestations.
8. Complete the Devpost form only after that gate passes.
9. Dispatch the same workflow in `post-submit` mode with the public Devpost URL,
   explicit final-submission attestation, and the successful pre-submit run ID.
