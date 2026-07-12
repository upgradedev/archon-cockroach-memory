# Demo video — Archon Memory (CockroachDB × AWS Bedrock)

**Produced video:** [`archon-cockroach-memory-demo.mp4`](./archon-cockroach-memory-demo.mp4)
— 1280×720, ~2:28 (under the 3-min submission limit), h264 + AAC narration.

Fully **automatable, headless, one command** — no browser, no live infra at render time:

```bash
npm run video:build        # or: make video   /   python scripts/build_video.py
npm run video:frames       # render just the terminal frames (fast layout check)
```

Pipeline (`scripts/build_video.py`): `demo/narration.json` → terminal frames (Pillow) →
per-beat narration (free Microsoft `edge-tts` neural voice) → per-beat mp4 (ffmpeg,
still image + audio) → concat → `archon-cockroach-memory-demo.mp4`.

Requirements: Python 3.11+, `pillow`, `edge-tts`, and `ffmpeg`/`ffprobe` on PATH.
`edge-tts` needs network (Microsoft's free online voice); everything else is offline.

## Every frame is REAL output (not mocked-up)

| Beat | Content | Source (verbatim) |
|---|---|---|
| 1–2 | What it is + architecture | README |
| 3 | `npm run memory:demo` — ingest → recall → cited answer | **live CockroachDB run**, captured in [`assets/fixtures/memory-demo.txt`](./assets/fixtures/memory-demo.txt) |
| 4 | Self-audit — contradiction + dangling ref, read-only | same live run |
| 5 | Real AWS Bedrock RAG answer (Titan + Claude Sonnet) | [`../docs/BEDROCK_SMOKE.md`](../docs/BEDROCK_SMOKE.md) |
| 6 | Multi-range fan-out — 14 ranges → top-k from 4, `vector search` | [`../docs/BENCHMARK.md`](../docs/BENCHMARK.md) Result 3b |
| 7 | RF=3 + node-kill + live CockroachDB Cloud EXPLAIN | [`../docs/BENCHMARK.md`](../docs/BENCHMARK.md) Result 3 + [`../docs/CLOUD_SMOKE.md`](../docs/CLOUD_SMOKE.md) |
| 8 | "Self-auditing tests caught a real bug" story | README (Quality & testing) |

The `memory:demo` fixture was captured against the **live CockroachDB Cloud cluster**
(a throwaway scratch database, so the production `archon` DB was untouched) with the
deterministic offline `FakeEmbedder`/`FakeNarrator`, so it is reproducible without AWS
credentials.

## What is NOT in this render (user-only remainder)

- **A screen-recorded walkthrough of a deployed web UI / public demo URL.** The agent
  API is not yet deployed (AWS Lambda/ECS — roadmap), so there is no browser surface to
  record. Add this beat once the demo URL is live (see the repo README roadmap).
- **A live real-Bedrock terminal capture on camera.** Beat 5 uses the committed verbatim
  `BEDROCK_SMOKE.md` capture (the real run needs AWS creds); it can be re-shot live with
  `RUN_BEDROCK_IT=1 npm run test:bedrock` when creds are present.

## Regenerating a beat's fixture

- `memory:demo`: point `DATABASE_URL` at any CockroachDB (local `docker compose up` or a
  scratch Cloud DB), `npm run db:schema`, then
  `DATABASE_URL=… npm run memory:demo | tee demo/assets/fixtures/memory-demo.txt`.
- Edit narration / frame text in `demo/narration.json`, then `npm run video:build`.
