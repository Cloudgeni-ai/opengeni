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

Migration 0916 adds a concurrent partial index on workspace, session, turn and
position for rows with a turn. The existing indexes, including the turn-only
ordered index from 0899, remain unchanged. With many small turns
and a few large sessions, the actual parameterized receipt-identity query could
choose an intersection that scanned the whole session index before sorting the
current turn. The scope-aligned index supplies one ordered access path for all
three equality predicates, without changing the query or RLS policies.

The regression captures the production helper's generated SQL, including its
parameterized limit, under the restricted application role. It checks custom
and generic plans with many background sessions, small and large target turns,
fractional positions, inactive rows, cursor pages, and foreign-scope denial.
First pages visit only their requested rows in this fixture. Later pages can
still filter a numeric cursor above the RLS barrier; no deep-cursor scan bound
or universal planner guarantee is claimed. The optional benchmark reports
index storage and insertion cost as well as read plans.