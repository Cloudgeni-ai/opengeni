# Site Data

Audience: engineers changing Sites, their storage, or the Site bridge.

Site Data gives every published Site persistent collections of JSON records
and files. Site HTML reads and writes them through `site.data` and
`site.files` on the existing `@opengeni/sdk/site` client; agents and scheduled
tasks use first-party tools; the Site page's Data tab shows them to the Site's
managers. There is no Site server and no live push. Sites that need tables
and SQL can turn on the optional per-Site database described in
[Site SQL](#site-sql-optional-cloudflare-storage).

## Ownership and lifecycle

- Data belongs to the published Site (the `workspace_artifacts` row), not a
  version, so it survives new versions and rollbacks.
- An archived Site keeps its data. Viewers and Site frames get `forbidden`
  (the same as tools: archived Sites receive no bridge); managers can still
  read, export and delete it through the API, tools and the Data tab.
- Sites are never hard-deleted. Every `site_data_*` row cascades from its
  workspace and Site, so data is removed when the workspace is deleted. File
  bytes live under `workspaces/<workspace>/site-data/<site>/files/<file>` in
  object storage and follow the same retention as Site HTML objects (they are
  not swept on workspace deletion today; see Follow-ups).

## Storage

Postgres implements the backend-neutral `SiteDataStore` interface
(`packages/db/src/site-data.ts`); another backend can implement the same
contract. Migration `0776_site_data.sql` adds a self-contained table set, all
workspace-owned with FORCE RLS through `opengeni_private.workspace_rls_visible`
and DML granted to the runtime role, so it could move to its own database:

| Table | Holds |
| --- | --- |
| `site_data_collections` | name, access mode, `private_records`, optional JSON Schema, indexed fields, unique field sets, and maintained `record_count`/`record_bytes` counters |
| `site_data_records` | uuid id, optional caller key (unique per collection and key scope), `jsonb` data, owner principal, created/updated by, version, size; its `(workspace_id, site_id, collection_id)` foreign key ties it to its collection's Site |
| `site_data_record_values` | hashes of declared unique field sets (partial unique index) and extracted numeric values of indexed fields |
| `site_data_files` | file metadata, scope (`shared` or `private`), owner, object key |
| `site_data_usage` | per-Site counters; its row is also the per-Site write lock |
| `site_data_rate_windows` | fixed one-minute windows: writes per principal and per Site, Site-frame reads per principal |
| `site_data_validation_windows` | fixed one-minute window of schema-validation time per Site |
| `site_data_workspace_validation_windows` | fixed one-minute window of schema-validation time per workspace, a ceiling across its Sites |

Principals are abstract strings: `user:<subjectId>` for people and
`service:<subjectId>` for personless keys. Agents are recorded as
`agent:session:<sessionId>` (their own session) in `createdBy`/`updatedBy`;
records they write belong to the person they act for (a chat's person or a
schedule's owner). An agent without a person owns its records as
`schedule:<taskId>` when a scheduled task's run created its session (found from
the server-written run row, so it is stable across runs and cannot be claimed
through session metadata), and as `agent:session:<sessionId>` otherwise, so
personless agents never share one key space. Workers a scheduled session spawns
keep their own session principal. `guest:`/`anon:` can be added later without
schema changes.

A write first counts its attempt against the caller's one-minute window in its
own short transaction (so refused and failed attempts count), refuses more
than 4 MB of record JSON in one request, compiles the touched collections' JSON
Schemas and validates every inserted or put record and every patch or
increment result (merged from the stored record) against them, and only then
takes the Site's usage row
`FOR UPDATE`. Inside that transaction it checks the Site is still active,
applies the operations, maintains unique and indexed values with set-based
statements, updates the collection counters, and checks quotas, so batches (up
to 100 operations) are atomic and unique constraints are race-free. Reads and
counts use the maintained counters; nothing counts a collection. Records carry a
`version`; `expectedVersion` turns a stale patch, put or delete into
`conflict` (`0` means "must not exist").

## Access rules

All rules are enforced in the API (`apps/api/src/site-data/service.ts`); the
store applies the per-collection matrix (`packages/db/src/site-data-policy.ts`).

- A caller must be able to see the Site under its audience. An Only me Site
  is `not_found` to everyone but its owner and agents acting for them.
- **Managers** hold `artifacts:publish` and are the Site's owner (or its
  creator when it has no owner), a workspace admin, an agent acting for one of
  those people, or a personless workspace credential (`api_key`,
  `configured_key` or `service`) used directly. An agent without a person
  (for example a person-less scheduled task) is a viewer, whatever credential
  started it. Managers define collections and read everything except
  `privateRecords`. Everyone else who can view the Site is a **viewer**.
- Requests from Site HTML always get **viewer** reach, whoever is viewing:
  Site HTML is untrusted (any member with `artifacts:publish` can publish a
  new version of a Site), so the owner's own Site page reads only their own
  `per_viewer` records, cannot write `shared_read`, and cannot see other
  viewers' private files. Managers keep full reach only through the Data tab,
  the API and agent tools. The host marks every bridged request with
  `x-opengeni-site-frame` and its pinned `x-opengeni-site-id` (both stripped
  from Site-supplied headers); either header makes a request framed, and a
  framed request must name its own Site and can never manage collections.
- Agents started from a Site page get the same clamp. Site HTML can start
  or message agent sessions through the bridge with the viewer's authority,
  so an agent whose session carries a Site origin (or whose spawning lineage
  does, through parent sessions and parent turns) is framed to that Site:
  viewer reach, only that Site, and no describe, define, delete, reset,
  import or export. A turn the page sent into a session without a Site
  origin (`surface = 'site'`) reaches no Site Data at all. The same check runs
  for MCP tools, Codemode and HTTP calls with an agent's delegated
  credential, since all of them resolve access in the service. The lineage
  walk reads up to 32 spawning ancestors, and the session's root session
  (`sessions.root_session_id`) is read directly. When the walk cannot read
  the whole lineage (a deeper chain, a missing session, or an ancestor the
  agent's person cannot see under session RLS) it fails closed: viewer reach
  and no management on the one Site a known origin names, and no Site Data at
  all when no origin is known. A session started from a Site stays clamped for its
  whole life, including turns its owner later sends from the console; start a
  new chat to manage data.
- So "Site HTML cannot define collections or change access rules" holds for
  the page's own requests and for agents it starts or messages directly.
  Indirect paths are closed too (OPE-801): Site code reaches only the
  `SITE_OPERATIONS` allowlist, a page reaches only sessions its own Site
  started (a page on Site B gets a 404 for a Site A session), each Site turn
  records which Site sent it, a schedule created from a Site records the Site
  and its runs inherit the clamp, and an agent started from a Site cannot
  create or change schedules or automations.
- The Site HTTP channel reaches only the current Site's data:
  `siteSessionPath` refuses `/published-artifacts/<id>/data|files` for every
  explicit id on every host, and hosts not bound to a published Site (inline
  chat HTML, previews) fail `current` with `site_data_unsupported`.

| Mode | Viewer reads | Viewer writes | Managers |
| --- | --- | --- | --- |
| `shared` | all | create, update, delete any | all |
| `shared_read` | all | none | write |
| `per_viewer` | own | own | read, update and delete all unless `privateRecords` (then own only) |
| `append_only` | own | create only | read all, update, delete |

On a Site [published](published-sites.md) to the public, anonymous guests
(`guest:<visitorId>`) reach a collection only through its `guestAccess`
rule: `none` (the default), `read` (what viewers read), `append` (create,
and read their own) or `own` (create, read, update and delete their own).
Members, invited people and signed-in users are viewers as above. Guest
writes have their own rate limit.

Collection JSON Schemas use a strict keyword allowlist, walked over the whole
schema when a collection is defined: `type`, `properties`, `required`,
`additionalProperties` (boolean or schema), `items` (one schema), `enum` (up
to 100 scalar values), `const` (scalar), `minimum`, `maximum`,
`exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`, `minLength`,
`maxLength`, `minItems`, `maxItems`, `minProperties`, `maxProperties`,
`format` (annotation only; format validation is off), `title`, `description`,
`allOf`, `anyOf`, `oneOf`, and `uniqueItems` only when `items` has a scalar
`type` (so the check is linear). Everything else is refused, including
`$ref`, `$defs`, `definitions`, `$id`, `$schema`, `default`, `examples`,
`pattern`, `patternProperties`, `propertyNames`, `if`/`then`/`else`, `not`,
`dependent*`, `contains`, `prefixItems` and `unevaluated*`. A schema has at
most 2,000 schema nodes, 1,000 properties per object (as many as a CSV import
has columns), 16 levels of nesting, 16 schemas in each `allOf`, `anyOf` or
`oneOf`, 500 `enum` values in total and 64 KB of JSON. Each schema is compiled
by its own Ajv instance (cached by content digest in a bounded LRU) with no
coercion or defaults, so nothing registers across tenants.

Wide schemas are cheap: each property applies to its own value once. What
costs is checking many schemas against each of the up to about 128K values a
record can repeat (array elements and additional properties), so a schema's
**repeated cost** is capped at 600 (`siteDataSchemaRepeatedCost`): the most
checks it runs on one repeated value, counting 1 per schema object, enum
value, property and required name, and 6 per `allOf`/`anyOf`/`oneOf` branch
(a failing branch is the costliest check, measured). Branches on the same
value add up; children on different values do not. A validator whose
generated code is larger than 200,000 characters runs unoptimized, about four
times slower (measured), so its repeated cost counts four times. On a
development machine the costliest allowed schemas check a 256 KB record in
about 0.2 s (96 failing branches per element, or a large validator at the
reduced cap); the previous flat 100-node cap allowed schemas that took about
0.33 s, and those are refused now.

Each write, batch or import request carries at most 4 MB of record JSON
(`quota_exceeded`, quota `request_bytes`) and spends at most 250 ms compiling
schemas and validating. Once anything was compiled or checked, the budget is
checked before every later operation, including ones that only compile a
schema and then skip their record (a patch of a missing record, an oversized
insert), and the event loop gets a turn after every compile or check. Past
the budget the next operation fails with `validation` (reason
`validation_budget`) before it runs, so a request costs at most the budget
plus one record and its schema compile; a request with one record always
completes. A schema that fails to compile is remembered for the request and,
as a negative entry, in the shared cache, so it is compiled once; the shared
cache is looked up by content digest before the allowlist walk and cost
model, so a cache hit does no work. Validation happens before the
Site's lock: inserts and puts as sent, patches and increments merged from the
record read just before. The write reuses the request's compiled validators
and skips records already checked against the same schema; a record that
changed in between is checked again inside the transaction, on the same
budget. Nothing is compiled under the lock: if a collection's schema changed
between the check and the lock, the write fails with a retryable `conflict`
(409, reason `schema_changed`, `retryable: true`) and the caller sends it
again. Likewise, every patch or increment result a request checks counts
against its reservation (below) at 1 µs per byte of JSON; one that would take
the request more than 25 ms past its reservation is refused before it is
checked, with a retryable `conflict` (409, reason `record_grew`). This
happens when a large write lands between a patch's admission and its write:
the retry reserves for the record's real size. A re-check inside the write
(another write changed the record meanwhile) first uses what the check before
the lock counted, so only real growth counts and concurrent increments on a
large record are not refused. Inserts, puts and imports carry their records
at admission and stay on the time budget, and a request whose reservation is
already the whole 250 ms budget is held to the time budget too, since a retry
could not reserve more. Imports commit in batches of 100, so an import error reports
`details.imported`; once that is above zero the error is never retryable
(sending the same import again would duplicate the committed batches) and its
message says how many records were imported.

Validation time has two windows per minute: one per Site (5 s by default)
and one per workspace (20 s by default) as a ceiling across its Sites, so one
busy Site cannot use up the whole workspace. A request that would validate
(it writes records to a collection with a schema, defines a collection with a
schema, or imports into one) reserves validation time on both windows in
the same transaction that counts its rate windows, before any work. The
reservation is sized to the request: 25 ms plus 1 µs per byte of record JSON
it carries (for a define, the schema's JSON; for an import, the records' JSON,
or for a CSV its text plus the header length per line, since every parsed row
repeats the column names) and per stored byte of the records its patches and
increments merge into, since those validate the whole merged record (read in
the same admission transaction; a record that does not exist adds nothing),
capped at the 250 ms request budget. 1 µs per byte is
about what the costliest allowed schema needs, so a request rarely spends
more than it reserved. If either window cannot take the reservation, the
request gets `rate_limited` (quota `site_validation_time` or
`workspace_validation_time`) until the minute ends. Afterwards, whatever the
outcome, the request settles to the time it actually spent in its own short
transaction after the write: the unused part is refunded, or the overrun is
charged. A refund applies only while the minute it was reserved in lasts;
once the window rolled over, only time spent beyond the reservation is
charged, to the new minute, so a late refund never frees time in a window it
did not use.
Each started 5 ms spent (from 1 ms; quicker checks, which are the normal case,
are free) also counts one more operation on the caller's write windows, for
viewers and managers alike. Schema compile time is part of the time spent and
is charged to the request that compiled it, even when a later request reuses
the cached validator.

Everything that would not validate goes through when a validation window is
spent: uploads, file deletes, deleting or resetting a collection, writes to
collections without a schema, and defining a collection without one, so a
manager can always remove a schema that causes trouble. Requests without a
schema never touch the validation windows, neither at admission nor
afterwards. Because requests reserve before they start, concurrent bursts
are bounded by the windows: with the defaults up to 200 small validating
requests (25 ms each) can be in flight on one Site, and up to 20 of the
largest (250 ms each), so a page that inserts or patches many small items at
once with `Promise.all` is not refused, while tiny patches into large records
reserve the whole budget and stop at 20 in flight. Patches admitted while a
record is small do not validate it at full size if a large write lands first:
by the byte estimate the merged records a request checks fit its reservation
plus 25 ms (a re-check of a record that changed without growing is not
counted again, so at most about twice that), and anything more is refused as
`record_grew` without being checked. A request
can otherwise spend more than it reserved only when it reserved the whole
budget, or when the byte estimate undercounts (a cold compile of a large
schema, or inserts, puts and imports, which are sized from what they carry
and stay on the time budget). Even then it stops at the request budget plus one record and its
compile (about 0.45 s at worst), the overrun is charged when it settles, and
further requests are refused until the window has room again. So a Site's
validation per minute stays within about 5 s plus up to about 75 ms for each
request in flight (its 25 ms slack, counted at most twice when a changed
record is re-checked, plus the reservation it already holds), plus the
overrun of in-flight requests that reserved the whole budget. With the
defaults that is at most about 20 s by the byte estimate (about 14 s measured
on the costliest allowed schema) in the adversarial case where a large write
lands between every patch's admission and its check, and about 9 s in
practice.
Data paths (filters, sorts, keys, increments, indexes, CSV headers) refuse
`__proto__`, `prototype` and `constructor`.

## Surfaces

HTTP (`apps/api/src/routes/site-data.ts`), under
`/v1/workspaces/:workspaceId/published-artifacts/:siteId`:

| Route | Purpose | Who |
| --- | --- | --- |
| `GET /data` | collections, usage, limits | managers |
| `PUT /data/collections/:name` | create or change a definition | managers |
| `DELETE /data/collections/:name?confirm=true` | delete with records | managers |
| `POST /data/collections/:name/reset` (`{confirm: true}`) | clear records | managers |
| `POST /data/collections/:name/import` | JSON or CSV, up to 1,000 records and (CSV) 1,000 columns, both checked while parsing; each CSV row is built in one pass; batches of 100 | managers |
| `GET /data/collections/:name/export?format=json\|csv` | up to 10,000 records and 16 MB; CSV names at most 200 data columns, then puts each record's data in one JSON `$data` column | managers |
| `POST /data/query`, `/data/get`, `/data/write` | records | access mode |
| `GET /files`, `POST /files?name=&scope=` (raw body, read only after access, the rate window and the quota for a declared Content-Length pass, with the per-file cap enforced while streaming; the route skips the generic request-size middleware, which would buffer a body without Content-Length first) | list, upload | access to the Site |
| `GET /files/:id` (signed URL, 5 minutes), `DELETE /files/:id` | download, delete | uploader or managers for private files and deletes |

Errors use the public envelope; `error.details.code` is one of `validation`
(422), `conflict` (409), `not_found` (404), `forbidden` (403),
`quota_exceeded` (413) or `rate_limited` (429).

The SDK client has matching management methods (`getSiteData`,
`querySiteData`, `writeSiteData`, `exportSiteData`, …) and exports the contract
types.

**Site bridge.** `site.data` and `site.files` send ordinary Site HTTP requests
to `/v1/workspaces/site-host/published-artifacts/current/...`. A host bound to
a published Site (`createSiteToolBridge` with `artifactId` and `fetchResponse`)
rewrites `current` to its pinned Site, adds the viewer's credentials and the
Site headers, and advertises `siteData: 1` in its READY message. Site clients
check that flag and fail with `site_data_unsupported` against older hosts,
inline HTML previews, tools-only hosts and local sandbox previews, without
sending anything. Uploads cross the MessagePort as an `ArrayBuffer`. The API's
CORS policy allows `X-OpenGeni-Site-Frame`, `X-OpenGeni-Site-Id` and
`X-OpenGeni-Site-Version`, so cross-origin hosts can send bridged requests.
Stored records are untrusted; the Sites skill requires rendering them as text.

**Agent tools** (MCP and Codemode, family `artifacts`; `site_data_describe`,
`site_data_query`, `site_data_export` and `site_files_list` need
`artifacts:read`, the rest `artifacts:publish`): `site_data_describe`,
`site_data_define_collection` (create, change or delete), `site_data_query`,
`site_data_write`, `site_data_import`, `site_data_export`, `site_data_reset`
(needs `confirm: true`), `site_files_list`, `site_files_upload` and
`site_files_delete`. They run with the attempt's authority, so scheduled tasks
use the schedule's; agents started from a Site page are clamped to that page's
viewer reach (see Access rules).

**Web.** The Site page's Data tab (`apps/web/src/components/artifacts/site-data.tsx`)
is shown to likely managers and trusts the API's answer: collections with
access, records and size against the quota, a paged record table, a record's
JSON as text, confirmed deletes with `expectedVersion`, and JSON/CSV export.

## Quotas, rate limits and metering

| Setting | Default |
| --- | --- |
| `OPENGENI_SITE_DATA_RECORD_BYTES_PER_SITE` | 100 MB |
| `OPENGENI_SITE_DATA_MAX_RECORD_BYTES` | 256 KB |
| `OPENGENI_SITE_DATA_MAX_COLLECTIONS_PER_SITE` | 50 |
| `OPENGENI_SITE_DATA_FILE_BYTES_PER_SITE` | 1 GB |
| `OPENGENI_SITE_DATA_MAX_FILE_BYTES` | 10 MB |
| `OPENGENI_SITE_DATA_WORKSPACE_BYTES` | 1 GB of records and files across the workspace's Sites |
| `OPENGENI_SITE_DATA_VIEWER_WRITES_PER_MINUTE` | 120 operations per viewer per Site |
| `OPENGENI_SITE_DATA_SITE_WRITES_PER_MINUTE` | 600 operations per Site |
| `OPENGENI_SITE_DATA_VIEWER_READS_PER_MINUTE` | 600 Site-frame reads per viewer per Site |
| `OPENGENI_SITE_DATA_MANAGER_WRITES_PER_MINUTE` | 6,000 operations per Site by all its managers (API and agent tools) |
| `OPENGENI_SITE_DATA_SITE_VALIDATION_MS_PER_MINUTE` | 5,000 ms of schema validation per Site |
| `OPENGENI_SITE_DATA_WORKSPACE_VALIDATION_MS_PER_MINUTE` | 20,000 ms of schema validation per workspace across its Sites |
| `OPENGENI_SITE_DATA_MAX_RECORDS_PER_COLLECTION` | 100,000 |

Record storage is charged as each record's JSON plus 512 bytes, so tiny records
still count. Filter strings are at most 1,024 characters and `in` lists at most
100 values. Write windows count every attempt, including refused ones:
viewers and Site frames per person and per Site, and managers' API and agent
calls (records, imports, uploads, collection changes) in one window per Site.
CSV imports count one operation per line before parsing. Validation time is
reserved at admission on its per-Site and workspace windows and adds
operations afterwards (see Access rules).
The read window applies to Site frames only. Billing is always
`usage_only` for now; a mode setting will arrive with `shadow`/`paid`. The workspace total is checked inside the Site's lock,
not a workspace-wide one, so concurrent writes to different Sites can overshoot
it slightly.

The workspace pays for usage that viewers trigger. Every write and upload
records usage events in the same transaction (`site_data.write` operations,
`site_data.write_bytes`, `site_data.file_upload_bytes`; source resource
`site`), following [the credit rollout](credit-boundaries-rollout.md) in
`usage_only`: nothing is debited until a reviewed rate and a `shadow`/`paid`
mode are added.

## Site SQL (optional Cloudflare storage)

Site SQL gives one published Site its own SQLite database: one
SQLite-backed Durable Object (`SiteDatabase`, `SITE_DB.idFromName(siteId)`)
in the Sites gateway Worker. It sits next to Site Data; the owner turns it on
per Site. Postgres stays the source of truth for the definitions, so the
database can always be rebuilt; the Durable Object holds only the rows.

### Availability

The deployment enables it with `OPENGENI_SITES_CLOUDFLARE_STORAGE_ENABLED=true`
plus `OPENGENI_SITES_GATEWAY_INTERNAL_ORIGIN` (the gateway origin the API
calls: `https://...`, or `http://` on loopback for local development) and
`OPENGENI_SITES_GATEWAY_SECRET`. Without the origin and secret, every Site
SQL call returns `unavailable` (503), the agent tools are not offered, and
nothing else changes. The flag only controls offering and running Site SQL
(turning it on, migrations, keep-resets, imports, named queries and ad hoc
statements): with the flag off but the origin and secret still set, export,
inspect and `reset` with `schema: "drop"` keep working, so existing data can
always leave Cloudflare or be deleted. Export also works while a Site's
database is turned off; turning a Site's database off keeps its data.

### Definitions in Postgres

Migration `0779_site_sql.sql` adds five workspace-owned FORCE-RLS tables,
keyed and cascading like Site Data:

- `site_sql_databases`: one row per Site that ever turned Site SQL on:
  `enabled`, the migration counter and when it was last rebuilt.
- `site_sql_usage`: the Site's usage counters, in their own row so Site page
  calls never wait on a migration holding the database row: the month's
  rows read and written by Site pages, the last reported database size and
  its high-water mark (storage growth is metered past the mark, so calls
  finishing out of order never count the same bytes twice).
- `site_sql_migrations`: the ordered, append-only schema migrations (name,
  SQL, checksum). The Durable Object records which ones it applied, so
  `migrate` and `reset` can replay the missing ones on an empty database.
  A Site's migrations hold at most 6 MiB of SQL together (2M characters
  each); past that `migrate` returns `quota_exceeded`
  (`migration_bytes_per_site`). Load data with imports, not migrations.
- `site_sql_queries`: named queries (name, one statement, parameter names,
  `read` or `write`, audience, row cap, description).
- `site_sql_rate_windows`: per-minute call windows per viewer and per Site.

The store is `packages/db/src/site-sql.ts`; `withSiteSqlDatabaseLock`
serializes migrations and resets per Site. A migration first asks the
Durable Object which migrations it has and sends only the missing ones, in
calls of at most 4 MiB; a keep-reset sends every migration in calls of at
most 4 MiB, emptying the database only on the first.

The Postgres rows cascade with their workspace. The Durable Objects do not:
deleting a workspace notes its Site SQL databases first and then drops each
one through the gateway (`reset`), best effort. A failure is logged with the
Site id and the data stays in its Durable Object (see Follow-ups).

### Statements

`compileSiteSql` (`packages/contracts/src/site-sql.ts`) checks every
statement on the API and again inside the Durable Object. It tokenizes the
SQL (strings, quoted identifiers, comments, blobs), splits statements, and
refuses `ATTACH`/`DETACH`, `VACUUM` (including `VACUUM INTO`),
`load_extension`, transaction control (`BEGIN`, `COMMIT`, `SAVEPOINT` ...),
any PRAGMA write and every PRAGMA except the schema readers, `?`, `?NNN`,
`@name` and `$name` parameters (only `:name`), more than 100 parameters, and
names starting with `_cf_` or `_og_`. Three profiles decide the rest:

| Profile  | Used for                  | Rules                                                                 |
| -------- | ------------------------- | --------------------------------------------------------------------- |
| `named`  | named queries Sites call  | exactly one SELECT/INSERT/UPDATE/DELETE/REPLACE (WITH allowed, not recursive); no schema changes, PRAGMA or EXPLAIN; 16K characters |
| `agent`  | `site_sql_query`/`execute` | exactly one statement; read-only PRAGMA and EXPLAIN allowed; schema changes refused (use a migration); 64K characters |
| `script` | migrations and SQL imports | up to 2,000 statements, run in one transaction; 2M characters         |

Values are always bound as parameters, never spliced into SQL.

### Named queries and viewers

Sites never send SQL. Site code calls `site.sql.run(name, params)`
(`@opengeni/sdk/site`), which posts
`/published-artifacts/current/sql/queries/<name>` over the Site HTTP channel
like Site Data (the `sql.run` entry of `SITE_OPERATIONS`; on a published host
the gateway sends it to `/v1/site-runtime/...`). The API resolves the caller
exactly like Site Data (a Site frame is always a viewer), then applies the
query's audience:

| Audience    | Who may run it from a Site page                                  |
| ----------- | ---------------------------------------------------------------- |
| `everyone`  | every viewer, including anonymous guests of public Sites         |
| `signed_in` | (default) viewers signed in as a person; guests, and service keys, agents or schedules acting on their own, get `forbidden` (`sign_in_required`) |
| `managers`  | no Site page; only managers through tools and the API            |

The Site's managers (outside a Site frame) may run every query.

`:viewer` (the viewer's stable principal, such as `user:<id>` or
`guest:<visitor>`), `:viewer_kind` and `:viewer_signed_in` (1 or 0) are bound
by the API from the verified caller. A request that supplies one is refused
with `validation`, so a Site cannot impersonate another viewer:

```sql
-- define with site_sql_define_query, audience signed_in
INSERT INTO votes (poll, voter, choice) VALUES (:poll, :viewer, :choice)
ON CONFLICT (poll, voter) DO UPDATE SET choice = excluded.choice
```

Rows come back as objects keyed by column name; blobs as
`{ "$base64": "..." }`. Errors are `OpenGeniSiteSqlError` with the codes in
`SITE_SQL_ERROR_STATUS` (`validation`, `not_found`, `forbidden`, `conflict`,
`quota_exceeded`, `rate_limited`, `sql_error`, `unavailable`, `disabled`).

### API to Durable Object

The API reaches the database through the gateway's internal route
`POST <OPENGENI_SITES_GATEWAY_INTERNAL_ORIGIN>/_og/internal/site-db/<siteId>/<operation>`
(`run`, `script`, `migrate`, `insert`, `export`, `inspect`, `reset`). It
signs the request like gateway-to-API requests:
`siteGatewayCanonicalString` over the method, the gateway host, the path,
the body hash and the timestamp, with empty session, visitor, client IP and
human fields, HMAC-SHA256 with `OPENGENI_SITES_GATEWAY_SECRET`. The gateway
accepts the current or previous secret (`GATEWAY_SECRET_PREVIOUS`) within
30 seconds, forwards to the Durable Object and adds nothing else. Every
request carries a fresh id the Durable Object refuses to replay. Site pages
never call this route; it has no cookies and returns 404 when `SITE_DB` is
not bound.

The Durable Object runs each call in one transaction, rolls back a read that
wrote and any write that would grow the database past the Site's storage cap,
cuts results at the row and response-size limits (`truncated: true`), and
reports rows read, rows written and the database size, which the API meters.

### Owner tools and routes

Managers (the Site's owner, workspace admins and agents acting for them) use
`/v1/workspaces/:ws/published-artifacts/:artifactId/sql` (GET describe,
PUT `/settings`, POST|PUT|DELETE `/queries/:name`, POST `/migrations`, `/query`,
`/execute`, `/import`, `/reset`, GET `/inspect`,
`/export?format=&table=&cursor=&maxBytes=`) and the matching agent tools:

| Tool                    | Does                                                                  |
| ----------------------- | --------------------------------------------------------------------- |
| `site_sql_inspect`      | settings, limits, usage, tables, migrations, pending migrations, queries |
| `site_sql_enable`       | turn the Site's database on or off                                     |
| `site_sql_migrate`      | append a named schema migration and apply every missing one            |
| `site_sql_define_query` | create, replace or delete a named query                                |
| `site_sql_query`        | one read-only statement (also read-only PRAGMA and EXPLAIN)            |
| `site_sql_execute`      | one write statement (schema changes go through migrations)             |
| `site_sql_export`       | the database as SQL (schema, multi-row INSERTs, then triggers), one table as CSV, or JSON, in pieces |
| `site_sql_import`       | SQL (schema statements become an `import_<time>` migration, then the data runs, then triggers become `import_<time>_triggers`), CSV or JSON rows into a table |
| `site_sql_reset`        | `keep`: empty and rebuild from the migrations; `drop`: delete everything and forget the definitions |

Every route and tool needs the manager role on the Site; read tools also
need `artifacts:read` and the rest `artifacts:publish`. The tools are only
registered when the gateway origin and secret are configured.

Exports come in pieces: one response holds at most `maxBytes` (16 MiB at
most; the agent tool defaults to 512 KB and allows 2 MB). When there is more,
the HTTP route sets `X-OpenGeni-Export-Next-Cursor` (and
`X-OpenGeni-Export-Truncated: true`), JSON exports also carry `nextCursor`,
and the tool returns `nextCursor`: pass it back as `cursor` and append the
pieces in order. Only the first piece holds the header (the SQL schema, the
CSV header row, the JSON schema) and only the last SQL piece holds the
triggers, so the pieces of a SQL export re-import one after another
(`site_sql_import` takes at most 2 MB per call). SQL and JSON exports keep
every value (JSON writes blobs as `{ "$base64": "..." }`, which JSON imports
cannot load back yet, so SQL is the lossless round trip); CSV turns every
value into text (an empty cell imports as NULL) and blobs into base64. SQL
dumps write up to 500 rows per INSERT and
keep each statement under the Durable Object's 100 KB statement limit; a
single row larger than that needs a JSON export and import.

SQL imports record their schema statements as a migration before the data
(so a rebuild keeps them), run the data statements in batches, and record
triggers as a second migration after the data, so triggers do not fire on
imported rows. CSV and JSON imports insert in chunks. Batches that ran stay
when a later one fails; the error reports `details.imported` and the
migrations recorded (`details.migrations`).

### Limits and metering

`siteSqlLimits` derives the effective limits from the Site's limit profile:

| Setting (`OPENGENI_SITES_SQL_*`)    | Free default | Meaning                              |
| ----------------------------------- | ------------ | ------------------------------------ |
| `FREE_STORAGE_BYTES`                | 50 MiB       | database size per Site               |
| `FREE_ROWS_READ_PER_MONTH`          | 5,000,000    | rows read per Site per month         |
| `FREE_ROWS_WRITTEN_PER_MONTH`       | 100,000      | rows written per Site per month      |
| `FREE_CALLS_PER_MINUTE_PER_VIEWER`  | 60           | Site page calls per viewer           |
| `FREE_CALLS_PER_MINUTE_PER_SITE`    | 600          | Site page calls per Site             |
| `MAX_ROWS_PER_CALL`                 | 1,000        | rows one call returns (hard cap 5,000) |
| `MAX_RESPONSE_BYTES`                | 1 MiB        | response size per call (hard cap 4 MiB) |
| `TIMEOUT_MS`                        | 15,000       | API to gateway request timeout       |

`credits` multiplies the free numbers by
`OPENGENI_SITES_CREDITS_LIMIT_MULTIPLIER` (default 10),
`unlimited` lifts the monthly caps (5 GB storage, 600 calls per viewer and
6,000 per Site per minute still apply), and `custom` profiles use the free
Site SQL numbers. Managers share one window of 600 calls per minute per Site.
On published hosts, guests' write queries also count against the Site's
guest write limit shared with Site Data
(`OPENGENI_SITES_FREE_GUEST_WRITES_PER_MINUTE`).
Monthly caps count only Site page calls (named queries) and are checked
before each call, so the last call of a month can overshoot by its own rows.
Management (export, inspect, migrations, resets, imports and ad hoc
statements) is metered but neither counts toward nor stops at the monthly
caps; the managers' call window and the storage cap bound it. Every call
records `site_sql.rows_read`, `site_sql.rows_written` and
`site_sql.storage_growth_bytes` usage events (source resource `site`) in
`usage_only` mode like Site Data. Metering runs after the Durable Object
answered; a metering failure is logged and does not fail the call.

## Tests

- `apps/api/test/site-data-postgres.test.ts`: real routes on Postgres as the
  application role. Each access mode for viewers and managers, private
  records, Site frames, cross-Site, cross-tenant and RLS isolation, Only me
  Sites, archived Sites, batch atomicity, schema validation, unique
  constraints, optimistic concurrency, filters, sorting, cursors, increments,
  quotas, rate limits, files and the agent tools as a schedule would use them;
  plus regression tests for prototype paths, schema isolation, the framed
  clamp, counters and the per-record charge, tampered cursors, the workspace
  total, attempt counting, upload ordering and streaming caps, CSV import and
  export, Site-started agents and their fail-closed lineage, the schedule
  principal, the manager write window, worst-case validation cost under the
  schema cost model, validation-time charging, the per-Site and workspace
  validation windows (only validating requests are refused; schema-less writes
  touch no window row), reservation under concurrent admission,
  request-sized reservations (25 concurrent small writes succeed),
  reservations for the stored records patches and increments merge into
  (refused once the window is reserved; small patches unaffected), patches
  admitted before a large write lands refused as `record_grew` (deterministic
  and concurrent, keeping the windows within their bound), no `record_grew`
  for concurrent increments on a 120 KB record or for CSV imports into a
  collection with a schema (1,000 rows × 8 columns and 200 columns), refunds
  only within the reserved minute, non-retryable partial imports, compile-only
  operations on the budget, the retryable schema-changed conflict, the budget
  order, CSV import counting, and the lineage under the production session
  RLS context. Budgets and charges use an injected validation clock, never
  wall-clock timing.
- `packages/db/test/migration-0776-site-data-postgres.test.ts`: FORCE RLS,
  the application role without context, a mismatched tenant context with no
  tenant filter, the record-to-collection Site key, and workspace cascade.
- `packages/contracts/test/site-session-http.test.ts`: only `current` Site
  Data paths pass the Site HTTP channel.
- `packages/sdk/test/site-data.test.ts`,
  `packages/react/test/published-html-artifact-frame.test.ts`: the bridge
  routing, capability negotiation and binary uploads.
- `apps/web/src/components/artifacts/site-data.test.tsx`: the Data tab.
- Site SQL: `packages/contracts/test/site-sql.test.ts` (the statement
  checker and its refusals), `apps/site-gateway/test/site-db.miniflare.test.ts`
  (the `SiteDatabase` Durable Object in workerd: signatures, previous secret,
  skew, replay, refusals, limits, migrations, rebuild, export and import),
  `packages/sdk/test/site-sql.test.ts` (`site.sql.run` over the bridge),
  `packages/db/test/migration-0779-site-sql-postgres.test.ts` (FORCE RLS and
  cascades) and `apps/api/test/site-sql-postgres.test.ts` (routes and tools on
  Postgres against the real gateway Worker in Miniflare: audiences, guests,
  principal parameters, limits and metering, export and import round trips).

## Follow-ups

- Sweep Site Data file objects on workspace deletion together with Site HTML.
- Forward Site Data through `createOpenGeniSessionProxy` for embedded hosts
  that render Sites behind the session proxy (it is GET-only for Sites today).
- `shadow`/`paid` billing with a reviewed rate; public, guest and anonymous
  principals; live updates.
- Clamp indirect paths from Site HTML (schedules, automations and other
  agents created with the viewer's authority), and record which Site sent
  each Site turn.
- Stamp the Site origin onto child sessions at creation so the lineage check
  is one lookup instead of a bounded walk.
- Site SQL: per-call CPU time is bounded only by the Durable Object's own
  limits (rows and bytes are bounded, recursive CTEs are refused in named
  queries); custom limit profiles have no Site SQL fields; a Postgres commit
  failure after a migration applied leaves the database one migration ahead
  until the next reset; blobs cannot be imported from JSON; a console view
  of the database; retry or sweep Durable Objects whose drop after
  workspace deletion failed (today they are only logged).
