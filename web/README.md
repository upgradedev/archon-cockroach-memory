# Archon Memory Control Room

Judge-facing React SPA for the fixed synthetic **Helios SA** public demo. It is intentionally
read-only: there is no account, company, or tenant selector and the browser sends no company
identifier in recall requests.

## Run

```bash
npm install
npm run dev
```

For local same-origin proxying, set `VITE_API_PROXY_TARGET` before starting Vite. Production
assets are generated with:

```bash
npm test
npm run build
```

## Same-origin API contract

- `GET /api/health` → `{ ok, status, service, version?, scope? }`
- `POST /api/recall` with `{ question, kind?, limit? }`
- `GET /api/audit` → `{ report: { conflicts, absences, recommendations?, summary? }, memories?, generatedAt? }`
- `GET /api/proof` → CockroachDB, C-SPANN, Bedrock, fixed-demo scope, and feature proof

The client accepts a small set of documented aliases for compatibility with the existing recall
and consistency response types. Endpoint failure never produces synthetic answers, “all clear”
audits, or fabricated infrastructure metrics; the affected panel renders an explicit unavailable
or last-known-snapshot state.
