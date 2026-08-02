# Memory Resolution Loop

Archon does more than answer from retrieved text. It can observe a memory
conflict across sessions, propose a bounded correction, wait for the correct
human authority, and apply that decision in CockroachDB without making the
canonical public corpus writable.

## The longitudinal slice

1. **Session A — prior memory:** the June 2026 payroll register reports employer
   cost of EUR 124,400.
2. **Session B — corrected evidence:** a newer signed register reports
   EUR 128,900 with a higher source-authority rank.
3. The policy proposes the newer evidence but leaves the state `pending`.
4. A demo visitor explicitly acts as `financial-controller` and approves or
   rejects the correction.
5. One CockroachDB `SERIALIZABLE` transaction records the decision, updates the
   disposable current/superseded state, writes a consolidation record, and
   seals an immutable SHA-256 receipt.
6. **Session C — consolidated recall:** the isolated session shows the resulting
   current value and complete lineage.

The action has no payment, messaging, payroll, or other external side effect.
It proves the authority and state-transition loop without pretending that a
public hackathon demo should operate a real financial system.

## Safety boundary

The canonical `agent_memory` table remains `SELECT`-only for the public runtime
role. The separate `archon_resolution_writer` role is restricted to five
fixed-scope synthetic sandbox tables:

- `memory_demo_sessions`
- `memory_resolution_observations`
- `memory_resolution_proposals`
- `memory_resolution_decisions`
- `memory_resolution_consolidations`

Database checks fix the tenant, company, scenario, two allowed evidence
records, authority role, actions, policy version, and receipt shape. Composite
foreign keys bind every observation, proposal, decision, and consolidation to
the same session. The service additionally requires a 256-bit bearer
capability whose SHA-256 digest—not the token—is stored.

The runtime principal is a trusted service boundary. Bearer isolation is
enforced by parameterized service queries; database RLS separately restricts
the role to unexpired, fixed-scope synthetic rows. Compromise of the database
principal would expose disposable public fixtures, not customer or canonical
memory, but remains an incident requiring credential rotation.

Schema, migration, database-release, and credential-rotation pipelines also
open a standalone, short-lived admin connection, set CockroachDB's current
database to the anonymous database, assert the pinned-v26.2 SQL `NULL` session
state, and run
principal-focused `SHOW GRANTS`. The gate compares database, schema, canonical
identity signature, granting role, `EXECUTE`, and grant-option fields and
accepts exactly the two transition routines anywhere in the cluster. The
proof deliberately executes direct `SHOW GRANTS` and `SHOW DATABASES`
statements, then filters and sorts their typed rows in-process; CockroachDB
v26.2.3 does not allow virtual-table wrappers in anonymous-database mode. The
connection is always destroyed so anonymous-database state cannot return to a
pool. In the shared build-test cluster, migration and reconciliation databases
are created sequentially and dropped after their rehearsal, and the migration
login is dropped with its role memberships; the next proof therefore cannot
inherit duplicate fixture routines or a rehearsal principal from an earlier
database.

Provisioning, release, and rotation close the cluster-wide database matrix for
each runtime principal. They accept exactly CockroachDB v26.2.3's non-grantable
`public CONNECT` and `TEMPORARY` rows on both `defaultdb` and `postgres`, plus
one direct, non-grantable `CONNECT` row for that principal on `archon`; the
targeted `system` query must return zero rows. Any additional grantee,
privilege, grant option, missing row, duplicate, or database outside the exact
`archon|defaultdb|postgres|system` inventory fails closed. The
object-focused release/rotation check independently proves the `archon` row is
direct, and no grant is changed by either production proof path. The four
allowed public rows are CockroachDB defaults, not project-created exceptions
([CockroachDB v26.2 `GRANT` example](https://www.cockroachlabs.com/docs/v26.2/grant#grant-privileges-on-databases),
[pinned v26.2.3 database-grant logic test](https://github.com/cockroachdb/cockroach/blob/v26.2.3/pkg/sql/logictest/testdata/logic_test/grant_database)). The pinned v26.2.3 CI rehearsal also
injects an app-database `TEMPORARY` grant, a `CONNECT WITH GRANT OPTION`
elevation, and an extra database whose default `PUBLIC` grants are explicitly
revoked, proves all three are rejected (including inventory-only drift),
restores each state in `finally` paths, reruns the positive proof, and emits the
five-row count, queried inventory, and canonical matrix digest. The same three
production gates require an exact-empty generated runtime role-option array,
including rejection of legacy replication and alternate identity provisioning,
and reject all affirmative or unknown effective system privileges.

## Lifecycle policies

| Policy | Enforced behavior |
|---|---|
| Learning | Both observations remain evidence; conflict is explicit. |
| Authority | The agent cannot finalize. An explicit human click recorded as the fixed demo role `financial-controller` is required. |
| Consolidation | Approval selects corrected evidence and supersedes the prior value; rejection retains the prior value. |
| Idempotency | A version-4 decision key and unique database constraint make a retry replay-safe. |
| Concurrency | CockroachDB serialization failures retry the entire transaction. |
| Forgetting | CockroachDB row-level TTL expires the complete disposable session graph. |
| Canonical safety | No sandbox role has `INSERT`, `UPDATE`, or `DELETE` on `agent_memory`. |
| Side effects | Exactly `none`; the demo action is an auditable memory-state transition. |

The operator schema enables `sql.ttl.job.enabled`; release verification checks
the cluster setting, table expiration expression, and four-hour schedule (the
CockroachDB-recommended cadence matching the default GC interval). Expired rows
are never treated as visible while awaiting physical deletion: every service
lookup also requires a future `expires_at`.

## Public API

All routes are same-origin through CloudFront and return `Cache-Control:
no-store`.

```text
POST /api/resolution/session   {}
GET  /api/resolution/session   Authorization: Bearer <session token>
POST /api/resolution/decision  Authorization: Bearer <session token>
                               {"decision":"approve|reject",
                                "idempotencyKey":"<uuid-v4>"}
```

The scenario is not caller-selectable. Arbitrary text, company, tenant,
amounts, sources, roles, or actions are rejected. The browser keeps the bearer
capability only in component memory; a page refresh discards it.

## Evidence and claim boundary

The public sandbox proves human-in-the-loop mechanics, not enterprise identity:
the role is a fixed demo assertion and the visitor is not authenticated as an
employee of Helios SA. A production adaptation would bind this step to the
customer's identity provider and authorization policy.

The live `/api/proof` response verifies that all five sandbox tables are
queryable by the deployed runtime and reports the transaction, authority,
idempotency, receipt, consolidation, forgetting, canonical-mutation, and
external-side-effect contracts. Database-release CI separately verifies the
exact role grants, RLS, TTL, constraints, cross-session link rejection, approve
and reject paths, idempotent replay, and receipt integrity.

Until those exact-SHA pipelines and the hosted journey pass, this document
describes implemented behavior, not production evidence. The demo corpus is
synthetic and representative; it is not a customer production corpus or a
claim of measured business ROI.
