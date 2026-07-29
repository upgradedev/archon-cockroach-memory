# Dependency release policy

Status: active release freeze
Started: 2026-07-29
Normal thaw: after the CockroachDB × AWS judging period ends

Archon Memory is freezing routine version-update pull requests while the
judge-facing release is stabilized. This is a change-control boundary, not a
security-update freeze.

## Enforced contract

- Every configured Dependabot ecosystem uses the numeric
  `open-pull-requests-limit: 0`.
- Root and web npm, GitHub Actions, the AWS Dockerfile, and root Docker Compose
  manifests are all represented using GitHub's
  [supported package ecosystems](https://docs.github.com/en/code-security/reference/supply-chain-security/supported-ecosystems-and-repositories).
- Dependabot security updates remain enabled and are not subject to the
  version-update limit, as specified by GitHub's
  [`open-pull-requests-limit` reference](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference#open-pull-requests-limit).
- No dependency ignore rules are used.
- CodeQL `init`, `autobuild`, and `analyze` use the same immutable commit:
  `4187e74d05793876e9989daffde9c3e66b4acd07`. The commit is the signed target
  of the official annotated `v3.37.3` tag.
- Repository readiness parses both YAML files semantically and fails on a
  mutable or divergent CodeQL reference, a missing or extra CodeQL action,
  malformed YAML, duplicate/missing ecosystem coverage, a string rather than
  numeric zero, any nonzero limit, or an ignore rule.

## Open update disposition

- Dependabot PR #56 is superseded because it updates only CodeQL `init`; the
  release branch updates all three CodeQL phases atomically.
- PR #57 combines React, Tailwind, TypeScript, jsdom, and other major frontend
  migrations and fails the current frontend/IaC gate. It is deferred to a
  dedicated post-submission migration.
- PR #58 combines runtime libraries with TypeScript 7, Node 26 types, and
  esbuild 0.28. Although its isolated checks passed, that breadth is outside
  the release closeout and is deferred.

Closing those version-update pull requests does not suppress a future security
advisory or security update.

## Security exception

A security update may cross the freeze in a dedicated pull request. It must
identify the advisory and affected runtime surface, minimize unrelated lockfile
churn, pass the full hosted CI and CodeQL gates, and complete the ordinary
staging/production promotion and receipts when deployable code changes.

## Thaw

After judging, restore normal version-update limits deliberately:

- root npm: 5
- web npm: 5
- GitHub Actions: 5
- root Docker Compose: 5
- AWS Dockerfile: 3

Major migrations remain separate even after thaw so their compatibility and
visual effects can be reviewed independently.
