# Historical build plan

This document previously described the first prototype and is intentionally
archived to avoid presenting stale architecture as current.

Canonical current sources:

- Product and implementation status: [../README.md](../README.md)
- Required tool proof: [TOOLS.md](./TOOLS.md)
- Architecture and portfolio decisions: [PRODUCT_STRATEGY.md](./PRODUCT_STRATEGY.md)
- AWS application: `../aws/template.yaml`
- OIDC delivery bootstrap: `../aws/bootstrap-oidc.yaml`
- CI/CD: `../.github/workflows/ci.yml` and
  `../.github/workflows/deploy-aws.yml`
- Checked-in durable recovery/watchdog: `../.github/workflows/recover-aws.yml`

The schema-v2 recovery receipt, immutable post-recovery control proof and
finalizer, two-hour lease, 15-minute watchdog, CloudFormation
protection/fresh-drift gates, and daily audit are current source design, not
live evidence. The IAM additions in the bootstrap template still require a
separately authorized foundation promotion; the current promotion workflow is
intentionally logging-only. Hosted CI and live staging/production recovery
proof for this revision remain pending. See
[../README.md](../README.md) and [TOOLS.md](./TOOLS.md) for the current
readiness boundary.

Historical smoke and benchmark captures remain in their dated evidence files.
