# Final demo production

The obsolete generated terminal-only video and its rendered frames were removed.
They did not show the deployed browser application and therefore were not valid
final challenge evidence.

Video, public post, and Devpost submission are deliberately the final phase. The
review package is generated entirely in hosted CI from the exact live
release, with ElevenLabs timestamped narration and a pinned FFmpeg media gate.
The new public YouTube/Vimeo video will be under three minutes and will show:

1. the unrestricted CloudFront application on a real browser;
2. a question answered from persistent CockroachDB memory;
3. exact citations and relevance/grounding state;
4. contradiction and missing-evidence audit behavior;
5. the live proof ledger and Managed MCP/C-SPANN evidence;
6. the public repository and tool identification.

The obsolete script, narration, and fake terminal fixtures were removed as well,
so they cannot accidentally regenerate misleading evidence. The new pipeline
records only the real browser application, fails closed on release or media
drift, and writes every generated media or receipt byte beneath `$RUNNER_TEMP`;
package installs and caches remain on ephemeral hosted runners. Sanitized
narration and capture packages cross isolated jobs as short-lived one-day
artifacts; the verified review package is retained for fourteen days. Generated
audio, frames, clips, captions, receipts, and MP4 files must remain untracked
and must never be written to this workspace.

The narration job consumes `ELEVENLABS_API_KEY` only from the
`demo-video-production` GitHub Environment. Operators must keep that environment
restricted to the `main` branch and must not recreate the key as a
repository-level secret.
