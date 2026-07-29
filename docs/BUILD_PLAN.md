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

The durable-delivery implementation's initial activation was hosted-proven at
historical exact commit `8c09b7ee07f1a3a0cd8ea19bf1db900c992e3edf`. The separately
authorized foundation IAM promotion completed safely and drift-free;
Deploy AWS run 30331875727 passed the full staging/production release and
committed both recovery intents, while Recover AWS run 30333619982 proved the
automatic trusted-source/OIDC classifier and safe no-op path. A deliberately
failed live release and `RECOVERING → RECOVERED` finalizer receipt remain
unexercised live drills. A fresh manual protection/drift audit is required by
the final submission gate. See
[../README.md](../README.md) and [TOOLS.md](./TOOLS.md) for canonical status.

Historical smoke and benchmark captures remain in their dated evidence files.
