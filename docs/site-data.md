# Site Data

Audience: engineers changing Sites, their storage, or the Site bridge.
Linear: OPE-800.

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
| `site_data_collections` | name, access mode, `private_records`, optional JSON Schema, indexed fields, unique field sets |
| `site_data_records` | uuid id, optional caller key (unique per collection and key scope), `jsonb` data, owner principal, created/updated by, version, size |
| `site_data_record_values` | hashes of declared unique field sets (partial unique index) and extracted numeric values of indexed fields |
| `site_data_files` | file metadata, scope (`shared` or `private`), owner, object key |
| `site_data_usage` | per-Site counters; its row is also the per-Site write lock |
| `site_data_rate_windows` | fixed one-minute write windows per principal and per Site |

Principals are abstract strings: `user:<subjectId>` for people and
`service:<subjectId>` for personless keys; agents write as `agent:<subjectId>`
on behalf of the person they act for. `guest:`/`anon:` can be added later
without schema changes.

Every write takes the Site's usage row `FOR UPDATE`, then checks quotas, unique
values and the write window inside the same transaction, so batches (up to 100
operations) are atomic and unique constraints are race-free. Records carry a
`version`; `expectedVersion` turns a stale patch, put or delete into
`conflict` (`0` means "must not exist").

## Access rules

All rules are enforced in the API (`apps/api/src/site-data/service.ts`); the
store applies the per-collection matrix (`packages/db/src/site-data-policy.ts`).

- A caller must be able to see the Site under its audience. An Only me Site
  is `not_found` to everyone but its owner and agents acting for them.
- **Managers** hold `artifacts:publish` and are the Site's owner (or its
  creator when it has no owner), a workspace admin, or a personless key.
  Managers define collections and read everything except `privateRecords`.
  Everyone else who can view the Site is a **viewer**.
- Requests from Site HTML are marked by the host's `x-opengeni-site-id`
  header (stripped from Site-supplied headers). They must target that same
  Site, never manage collections, and default `per_viewer`/`append_only`
  reads to the viewer's own records, even for managers.

| Mode | Viewer reads | Viewer writes | Managers |
| --- | --- | --- | --- |
| `shared` | all | create, update, delete any | all |
| `shared_read` | all | none | write |
| `per_viewer` | own | own | read all unless `privateRecords` |
| `append_only` | own | create only | read all, update, delete |

## Surfaces

HTTP (`apps/api/src/routes/site-data.ts`), under
`/v1/workspaces/:workspaceId/published-artifacts/:siteId`:

| Route | Purpose | Who |
| --- | --- | --- |
| `GET /data` | collections, usage, limits | managers |
| `PUT /data/collections/:name` | create or change a definition | managers |
| `DELETE /data/collections/:name?confirm=true` | delete with records | managers |
| `POST /data/collections/:name/reset` (`{confirm: true}`) | clear records | managers |
| `POST /data/collections/:name/import` | JSON or CSV, up to 1,000 records, batches of 100 | managers |
| `GET /data/collections/:name/export?format=json\|csv` | up to 10,000 records | managers |
| `POST /data/query`, `/data/get`, `/data/write` | records | access mode |
| `GET /files`, `POST /files?name=&scope=` (raw body) | list, upload | access to the Site |
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
sending anything. Uploads cross the MessagePort as an `ArrayBuffer`. Stored
records are untrusted; the Sites skill requires rendering them as text.

**Agent tools** (MCP and Codemode, family `artifacts`; `site_data_describe`,
`site_data_query`, `site_data_export` and `site_files_list` need
`artifacts:read`, the rest `artifacts:publish`): `site_data_describe`,
`site_data_define_collection` (create, change or delete), `site_data_query`,
`site_data_write`, `site_data_import`, `site_data_export`, `site_data_reset`
(needs `confirm: true`), `site_files_list`, `site_files_upload` and
`site_files_delete`. They run with the attempt's authority, so scheduled tasks
use the schedule's.

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
| `OPENGENI_SITE_DATA_BILLING_MODE` | `usage_only` (the only mode for now) |

Write windows apply to viewers and Site frames; managers' API and agent calls
are bounded by quotas. The workspace total is checked inside the Site's lock,
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
  quotas, rate limits, files and the agent tools as a schedule would use them.
- `packages/db/test/migration-0773-site-data-postgres.test.ts`: FORCE RLS,
  the application role without context, and workspace cascade.
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
