# Archon Memory — final demo video plan

Target runtime: **2:50 (170 seconds)**
Hard limit: **strictly under 3:00**
Delivery: public, embeddable YouTube or Vimeo link
Language: English narration with accurate English captions

The recording is intentionally the final production step. It must use the
public production URL and the exact release that has passed CI, CodeQL,
production deployment, recovery audit, and the standalone Managed MCP audit.
No generated video, frames, audio, or editing output belongs in this repository.

## CI-only production contract

The final review package is generated only by the manual
`Generate exact-release demo video` GitHub Actions workflow. The workflow:

- binds the dispatch to the exact current `main` SHA and revalidates the
  successful CI, CodeQL, Deploy AWS, exact-release Hosted DAST, standalone
  Managed MCP, and manual dual-environment recovery audit;
- records the real public CloudFront application at 1920×1080 with Playwright;
- proves the application and APIs before and after recording with the deployed
  CSP enforced; only the separate recording context bypasses CSP so the owned
  explanatory overlay and deterministic verification marker can be injected;
- synthesizes the seven canonical narration beats with ElevenLabs
  `/with-timestamps`, without a silent or alternate-provider fallback;
- derives the English captions from the returned character alignment;
- composes with a byte- and SHA-256-pinned FFmpeg toolchain;
- measures the final MP4 rather than trusting its manifest: complete decode,
  duration, stream count, codec/profile, resolution, frame rate, pixel format,
  loudness, caption reconstruction, scene order, A/V agreement, and receipt
  hashes must all pass; and
- writes raw capture, audio, frames, captions, intermediate media, and receipts
  only beneath the hosted runner's `$RUNNER_TEMP`. Sanitized narration and
  capture handoffs use short-lived one-day GitHub artifacts between isolated
  jobs. The verified review package, including all eight ordered, hash-bound
  production screenshots, and its separate small
  `archon.demo-video-publication` provenance artifact are retained for fourteen
  days. The provenance binds the exact workflow run/attempt, release SHA,
  package artifact ID/digest, measured MP4 SHA/bytes/duration, captions SHA,
  verification-receipt SHA, and the explicit voice-rights attestation.

The ElevenLabs secret is scoped only to the narration job. Capture, composition,
verification, and artifact upload are credential-free. Public YouTube/Vimeo
upload remains a separate human-reviewed side effect because no provider
publication credential is stored in this repository.

The canonical still set is `01-hook.png`, `02-scope-architecture.png`,
`03-recall-grounding.png`, `04-audit-conflict.png`, `05-audit-absence.png`,
`06-proof-ledger.png`, `07-managed-mcp.png`, and `08-close.png`. CI rejects
missing, reordered, extra, non-PNG, non-1920×1080, byte-drifted, or
SHA-256-drifted stills before the one-day capture handoff. The same eight files
and their hash-binding capture receipt are retained in the fourteen-day final
review package. These are the only stills eligible for human selection for a
Devpost gallery; no local recapture or replacement is permitted.

## Storyboard and narration

### 0:00–0:12 — hook

**Screen**

- Product title.
- Open the live Control Room.
- Briefly frame the contradiction indicator.

**Narration**

> Agent memory can hold plausible but wrong financial facts. Archon Memory
> exposes persistent disagreement before financial decisions.

### 0:12–0:27 — scope and architecture

**Screen**

- Show the fixed `public-demo / Helios SA / read-only` scope.
- Briefly show the owned architecture slide.

**Narration**

> On AWS serverless, this public synthetic demo keeps relational truth,
> provenance, audit, and native vector memory in one serializable CockroachDB
> system.

### 0:27–1:15 — live C-SPANN recall and grounding

**Screen**

- Ask: “What was the true employer cost and the off-bank wedge?”
- First highlight Store integrity, provenance, and idempotency on the proof strip.
- Show the answer.
- Expand citations and the retrieval/grounding trace.
- Highlight `€15,375`, `€6,775`, the exact evidence rows, native C-SPANN,
  Titan embeddings, and the citation/numeric/claim checks.

**Narration**

> Facts are stored idempotently with provenance, lifecycle, and payload-bound
> digests. Titan embeds the question; CockroachDB recalls through native C-SPANN
> under exact tenant, model, lifecycle, and company scopes. The result reports
> employer cost of fifteen thousand three hundred seventy-five euros and an
> off-bank wedge of six thousand seven hundred seventy-five euros. Every claim
> links to stored memory. Failed citation, numeric, or claim checks trigger
> deterministic evidence.

### 1:15–1:55 — contradiction and missing evidence

**Screen**

- Open the audit ledger.
- Highlight the two `INV-2043` totals.
- Highlight missing `PAY-118` referenced by `RECON-2043`.
- Show “No automatic mutation.”

**Narration**

> Semantic recall is not a complete audit. This bounded pass finds an invoice
> conflict: eighteen thousand four hundred versus eighteen thousand nine hundred
> euros. It recommends higher-importance evidence without rewriting either
> record. It also finds payment PAY-118 referenced but never stored. Unknown
> stays unknown.

### 1:55–2:20 — live proof ledger

**Screen**

- Open proof.
- Highlight CockroachDB Cloud on AWS, `eu-west-1`, production runtime
  principal, exact release SHA, native C-SPANN, 1024 dimensions, and `9 / 9 / 9`.
- Briefly show the owned scale-evidence card: 5k–10k eval corpora, RF=3, and
  single-node-loss recall.

**Narration**

> The proof ledger binds the release, database, role, region, and vector index.
> It verifies nine memories, nine idempotency keys, and nine content
> digests. Evaluations cover larger corpora, RF-three placement, and recall after
> one node stops.

### 2:20–2:40 — independent Managed MCP release proof

**Screen**

- Show an owned, neutral evidence card for the successful standalone
  `Cockroach Cloud Managed MCP Audit` at the exact release SHA.
- Show only the sanitized receipt summary; do not show GitHub chrome or logos.
- Display the four call labels: cluster identity, table list, schema, bounded
  aggregate.

**Narration**

> Separately, CockroachDB Cloud Managed MCP makes four hosted read-only calls and
> accepts the fixed-scope nine-nine-nine result. Its receipt exposes no
> credentials, connection material, memory text, or embeddings.

### 2:40–2:50 — impact and close

**Screen**

- Return to the Control Room.
- Show repository and demo URLs.
- End on the tagline.

**Narration**

> Archon Memory makes hidden memory inspectable and contradiction-aware. The demo
> and source are public.

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
6. Dispatch `Generate exact-release demo video` for that exact SHA only after
   explicitly attesting the selected ElevenLabs voice rights. Require all four
   jobs, the verified review package, the separate publication-provenance
   artifact, and the post-artifact terminal revalidation to pass.
7. Review the CI-produced MP4, upload that exact source file with `Archon
   Memory` in the public provider title, and retain the provenance-reported
   workflow run ID, run attempt, and MP4 SHA-256. Do not edit or re-export the
   source between CI and upload.
8. Dispatch `Submission readiness` in `pre-submit` mode with the public video
   URL, verified integer duration, CI video run ID/attempt, provenance-reported
   MP4 SHA-256, explicit uploaded-from-CI-artifact attestation, and both
   visibility/embed and accurate English-caption attestations.
9. Complete the Devpost form only after that gate passes.
10. Dispatch the same workflow in `post-submit` mode with the identical video
    and CI-source bindings, public Devpost URL, explicit final-submission
    attestation, and the successful pre-submit run ID.
