# Site Data

Audience: engineers changing Sites, their storage, or the Site bridge.

Site Data gives every published Site persistent collections of JSON records
and files. Site HTML reads and writes them through `site.data` and
`site.files` on the existing `@opengeni/sdk/site` client; agents and scheduled
tasks use first-party tools; the Site page's Data tab shows them to the Site's
managers. There is no Site server, no live push, and no per-Site SQL.

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
contract. Migration `0773_site_data.sql` adds a self-contained table set, all
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
| `site_data_validation_windows` | fixed one-minute window of schema-validation time per workspace |

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
  Indirect paths that run with the viewer's general API authority (for
  example a schedule or automation the page creates, whose agents are not
  Site-started) are not clamped yet; they are tracked in
  [OPE-801](https://linear.app/cloudgeni/issue/OPE-801). So is one direct
  path: a page on Site B can message an existing session that was started
  from Site A. Site turns record only `surface = 'site'`, not which Site sent
  them, so that agent keeps viewer reach on Site A (never management, and
  nothing on Site B). Recording the sending Site on each Site turn needs
  changes on every turn-insert path and is part of OPE-801.
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
schemas and validating, checked before each record after the first, with a
yield to the event loop between records. Past the budget the next record
fails with `validation` (reason `validation_budget`) before it runs, so a
request costs at most the budget plus one record and its schema compile; a
request with one record always completes. Validation happens before the
Site's lock: inserts and puts as sent, patches and increments merged from the
record read just before. The write reuses the request's compiled validators
and skips records already checked against the same schema; a record that
changed in between is checked again inside the transaction, on the same
budget.

Validation time is charged after every write, define and import, whatever
its outcome. Each started 5 ms (from 1 ms; quicker checks, which are
the normal case, are free) counts one more operation on the caller's write
windows, for viewers and managers alike. The time also counts on a
per-workspace window of validation time per minute across all its Sites
(20 s by default); once it is spent, every further Site Data write in the
workspace gets `rate_limited` (quota `workspace_validation_time`) until the
minute ends. So one request costs at most about 0.25 s plus one record
(about 0.2 s), and a workspace's Sites spend at most about 20 s of validation
per minute plus what requests already in flight finish.
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
| `OPENGENI_SITE_DATA_WORKSPACE_VALIDATION_MS_PER_MINUTE` | 20,000 ms of schema validation per workspace across its Sites |
| `OPENGENI_SITE_DATA_MAX_RECORDS_PER_COLLECTION` | 100,000 |

Record storage is charged as each record's JSON plus 512 bytes, so tiny records
still count. Filter strings are at most 1,024 characters and `in` lists at most
100 values. Write windows count every attempt, including refused ones:
viewers and Site frames per person and per Site, and managers' API and agent
calls (records, imports, uploads, collection changes) in one window per Site.
CSV imports count one operation per line before parsing. Validation time adds
operations afterwards and has its own workspace window (see Access rules).
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
  schema cost model, validation-time charging and the workspace window, the
  budget order, CSV import counting, and the lineage under the production
  session RLS context. Budgets and charges use an injected validation clock,
  never wall-clock timing.
- `packages/db/test/migration-0773-site-data-postgres.test.ts`: FORCE RLS,
  the application role without context, a mismatched tenant context with no
  tenant filter, the record-to-collection Site key, and workspace cascade.
- `packages/contracts/test/site-session-http.test.ts`: only `current` Site
  Data paths pass the Site HTTP channel.
- `packages/sdk/test/site-data.test.ts`,
  `packages/react/test/published-html-artifact-frame.test.ts`: the bridge
  routing, capability negotiation and binary uploads.
- `apps/web/src/components/artifacts/site-data.test.tsx`: the Data tab.

## Follow-ups

- Sweep Site Data file objects on workspace deletion together with Site HTML.
- Forward Site Data through `createOpenGeniSessionProxy` for embedded hosts
  that render Sites behind the session proxy (it is GET-only for Sites today).
- `shadow`/`paid` billing with a reviewed rate; public, guest and anonymous
  principals; live updates.
- Clamp indirect paths from Site HTML (schedules, automations and other
  agents created with the viewer's authority), and record which Site sent
  each Site turn: [OPE-801](https://linear.app/cloudgeni/issue/OPE-801).
- Stamp the Site origin onto child sessions at creation so the lineage check
  is one lookup instead of a bounded walk.
