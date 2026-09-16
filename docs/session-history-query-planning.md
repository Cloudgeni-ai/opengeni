# Session history query planning

Session history pages retain their existing row, byte and cursor contracts.
Migrations 0475–0476 improve PostgreSQL's estimates for the existing indexed
queries; they do not change application queries, retained payloads, page sizes,
grants, role membership or planner settings.

Account, workspace and session identifiers are correlated. Multivariate
dependencies and most-common-value statistics describe that relationship so a
large session is not estimated as a handful of rows. The statistics object has
a target of 1000 and is populated by a targeted `ANALYZE` during 0475. Normal
autovacuum analysis maintains it afterward; include these statistics when
diagnosing restored or substantially changed databases.

Migration 0476 expresses the existing owner-only title-quarantine permission as
one conditional branch. It still requires both the current table owner and the
transaction-local quarantine capability. Ownership is looked up dynamically;
the policy is not attached to a captured owner role. Ordinary application roles
cannot acquire this permission by setting the capability flag. Restrictive
session-visibility policies remain in force.

Both migrations are rolling. Statistics collection runs in a separate
transaction before policy DDL, avoiding retention of the policy DDL lock during
the sampling scan. Each migration bounds lock acquisition to five seconds.
Neither migration rewrites event rows or builds an index.

The regression uses the application role and a named workspace subject, with
multiple sessions and tenants. It checks bounded index work rather than elapsed
time, plus exact payloads, forward/backward cursors and cross-workspace denial.
PostgreSQL remains free to choose plans for other data distributions; the
statistics are not an index hint or an unconditional latency guarantee.