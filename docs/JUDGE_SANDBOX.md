# Judge-supplied memory sandbox

Status: **implemented and verified in source; not claimed as available on the
current hosted release until an exact-release deployment proves all three
routes**.

This is the bounded Real-World Impact slice: a visitor can add a small
financial fact, recall it with citations, add a conflicting value, and ask for
a deterministic contradiction audit. It never writes to canonical
`agent_memory`.

## Public contract

All requests are JSON `POST` requests. The first ingest returns a 43-character
opaque capability. Later calls must send it as `sandbox_token`. The browser
keeps it only in component state and does not render or persist it.

### Start a session and store a fact

```http
POST /api/sandbox/ingest
Content-Type: application/json

{
  "company": "Judge Corp",
  "fact": "Invoice INV-9901 is recorded at EUR 45000.",
  "sourceRef": "DOC-9901-A",
  "subject": "INV-9901",
  "attribute": "total",
  "numericValue": 45000
}
```

The `sandbox_token` in the `201` response is the only session capability. To
store another fact, repeat the request with that value in `sandbox_token`.
Identical requests reuse the existing memory and return `200`; a missing
`sourceRef` is derived deterministically from the fact so retries remain
idempotent.

### Recall only this session

```http
POST /api/sandbox/recall
Content-Type: application/json

{
  "sandbox_token": "<opaque capability>",
  "question": "What values are recorded for INV-9901?"
}
```

The answer includes citations whose memory IDs and source references come only
from that capability's session. The browser accepts only an exact grounding
receipt, distinguishes verified, extractive, fallback and no-evidence states,
and surfaces the reason when instruction-shaped recalled evidence was withheld.

### Audit structured contradictions

```http
POST /api/sandbox/audit
Content-Type: application/json

{ "sandbox_token": "<opaque capability>" }
```

Two distinct numeric values with the same `subject` and `attribute` produce a
deterministic contradiction. The audit does not ask a model to decide whether
values conflict.

## Bounds and isolation

- Maximum 20 distinct memories per session.
- Maximum 200 active public sessions across the service.
- Maximum one-hour lifetime; reads reject expired rows immediately and
  CockroachDB row-level TTL removes storage asynchronously.
- Raw capabilities are never stored; only SHA-256 digests reach CockroachDB.
- Instruction-shaped recalled evidence is excluded before model context is
  built. Safe peers in the same recall remain usable and are renumbered
  deterministically; the raw rejected row remains available to deterministic
  audit and is not rewritten.
- Both sandbox tables have forced RLS, exact grants, expiry constraints, and a
  session-prefix C-SPANN index.
- The release gate proves that index definition, not a runtime `vector search`
  plan through forced RLS. Capability isolation takes priority, and the
  20-memory session cap keeps a fallback scan bounded; acceleration is not
  claimed without an `EXPLAIN` receipt.
- The runtime has no `INSERT`, `UPDATE`, or `DELETE` privilege on canonical
  memory or the fixed resolution graph.
- This unauthenticated public demo is for synthetic, non-sensitive evidence.
  It is not a secure intake channel for personal, confidential, or regulated
  production data.

## Failure contract

| Status | Meaning |
|---|---|
| `400` | Invalid JSON, capability, text, or structured numeric fields |
| `410` | Capability is unknown or expired |
| `429` | Per-session memory cap or global active-session cap reached |
| `503` | Sanitized dependency failure; database internals are not returned |

Release evidence is produced by
[`scripts/verify-database-release.ts`](../scripts/verify-database-release.ts),
and hosted negative boundaries are exercised by
[`scripts/hosted-dast.mjs`](../scripts/hosted-dast.mjs). A successful source
gate alone does not make these routes live.
