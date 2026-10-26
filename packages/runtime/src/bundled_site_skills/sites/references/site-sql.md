# Site SQL

## Tables and SQL with Site SQL (optional)

Where the deployment offers Cloudflare storage, a Site can also have its own
SQLite database. Prefer Site Data for records with ready-made access modes;
use Site SQL when the Site needs tables, joins, aggregates, unique keys or
counts across viewers (polls, leaderboards, bookings). If
`opengeni__site_sql_inspect` reports `unavailable`, use Site Data instead.

Set it up with agent tools after the first publish (they need the Site id);
Site HTML never sends SQL:

1. `opengeni__site_sql_enable` with `enabled: true`.
2. `site_sql_migrate` with a unique `name` and the schema SQL (CREATE TABLE,
   CREATE INDEX, ALTER TABLE). Migrations are append-only and replayed when the
   database is rebuilt; schema changes only go through migrations.
3. `site_sql_define_query` for every query the page runs: exactly one
   SELECT, INSERT, UPDATE, DELETE or REPLACE (WITH allowed but not recursive:
   a WITH table may not name itself or use UNION/INTERSECT/EXCEPT; put a
   UNION in the main query instead), `:name` parameters only, and an
   `audience`: `everyone` (guests of public Sites too), `signed_in` (default;
   viewers signed in as a person) or `managers` (never from the page).

`:viewer` (the viewer's stable, opaque id: for a person, `user:` followed by
their subject id, such as `user:user:4f0c2a9e-7b1d-4c3a-9e5f-2a6b8c1d0e3f`, or
`guest:<visitor>` for a guest), `:viewer_kind` and `:viewer_signed_in` are
bound by the host from the signed-in viewer. Use `:viewer` for ownership and
per-person rows instead of building an id; never take a person's identity
from a page parameter, and never pass `viewer*` params from the page (they are
refused):

```sql
-- cast_vote, audience signed_in
INSERT INTO votes (poll, voter, choice) VALUES (:poll, :viewer, :choice)
ON CONFLICT (poll, voter) DO UPDATE SET choice = excluded.choice
```

```ts
import { createOpenGeniSiteClient, OpenGeniSiteSqlError } from "@opengeni/sdk/site";

const site = createOpenGeniSiteClient();
await site.sql.run("cast_vote", { poll: "lunch", choice: "tacos" });
const { rows, truncated } = await site.sql.run<{ choice: string; votes: number }>(
  "poll_results",
  { poll: "lunch" },
);
```

Rows are untrusted input: render them as text. Handle `OpenGeniSiteSqlError`
codes: `forbidden` (audience), `not_available_for_viewer` (on a published
host, the query's audience excludes this viewer; `details.reason:
"sign_in_required"` for guests),
`not_found` (no such query), `validation` (missing or unknown params),
`conflict` (a unique or primary key already taken), `sql_error` (also NOT
NULL, CHECK and foreign-key failures),
`rate_limited`, `quota_exceeded`,
`disabled` (the owner turned the database off), `unavailable` and
`site_sql_unsupported` (a host or local preview without Site SQL; test the
published Site). Results stop at the query's row cap (1,000 rows and 1 MB by
default) with `truncated: true`; page with `LIMIT :limit OFFSET :offset` or a
keyset.

Owner tools: `site_sql_inspect` (tables, migrations, pending migrations,
queries, usage, limits), `site_sql_query` (one read-only statement),
`site_sql_run` (one named query with params, exactly as the page runs it),
`site_sql_execute` (one write), `site_sql_export` (`sql`, `csv` for one table,
or `json`; works while the database is off; returns at most `maxBytes`,
512 KB by default: while `nextCursor` is set, call again with it as `cursor`
and keep the pieces in order), `site_sql_import` (`sql`, `csv` or `json` rows
into an existing table, at most 2 MB per call; import the pieces of a large
SQL export in order; triggers are added after the rows), and `site_sql_reset`
(`confirm: true`;
`schema: "keep"` empties and rebuilds from the migrations, `"drop"` forgets
everything; a failed keep-reset reports `partialRebuild: true`: run it again).
Export before a reset when the data matters; SQL is the lossless format (CSV
turns values into text). An export is read piece by piece, not as one
snapshot: turn Site SQL off first for a consistent copy. To restore a SQL
export, reset with `schema: "drop"`, then import its pieces in order. Keep migrations to schema: a Site's
migrations hold at most 6 MB of SQL, so load data with `site_sql_import`.
Statements may not
use ATTACH, VACUUM, load_extension, transactions or PRAGMA writes, or name
tables starting with `_cf_` or `_og_` (even as a string such as `'_og_x'`;
bind such values as parameters). Quote columns named `begin`, `end` or
`recursive` (`"begin"`); the checker refuses them unquoted.

