# Site Data

## Save data with Site Data

Every published Site can keep persistent JSON records and files in the workspace.
Data belongs to the Site, not a version: it survives new versions and
rollbacks. An archived Site keeps its data but its page cannot reach it. Read
on load, and use `site.data.onChange` (or `collection.onChange`) to read again
when another viewer, agent or schedule changes data: it hints which
collections changed (null means "anything"), never the records. Hints are
best effort, so keep a refresh button or a slow timer where missing one would
matter.

Define collections with agent tools, never from Site HTML. Use
`opengeni__site_data_define_collection` after the first publish (it needs the
Site id), choosing an access mode for viewers (people who can open the Site):

| Access mode | Viewers can | Use for |
| --- | --- | --- |
| `shared` | read and write every record | a team CRM, a shared board |
| `shared_read` | read; only managers and agents write | dashboards fed by a schedule |
| `per_viewer` | read and write only their own records | personal trackers, settings |
| `append_only` | add records, read only their own | forms, feedback, sign-ups |

Managers (the Site's owner, workspace admins, and agents acting for them) read,
change and delete every record through the Data tab and agent tools; set
`privateRecords: true` on a `per_viewer` collection to keep records private
even from managers. The Site page itself always acts as a viewer, even for its
owner: it sees only that person's `per_viewer` records and cannot write
`shared_read` collections, so feed those with agent tools. Add `uniqueFields`
(for example `[["email"]]`) to reject duplicates, `jsonSchema` to validate
writes, and `indexedFields` for numeric range filters you use often. Schemas
use only `type`, `properties`, `required`, `additionalProperties`, `items` (one
schema), `enum` (up to 100 scalars), `const`, numeric and length bounds
(`minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`,
`minLength`, `maxLength`, `minItems`, `maxItems`, `minProperties`,
`maxProperties`), `format`, `title`, `description`, `allOf`/`anyOf`/`oneOf`,
and `uniqueItems` when `items` has a scalar `type`; no `$ref`, `$defs`,
`pattern`, `default` or conditionals; at most 1,000 properties per object, 16
levels, 16 branches per `anyOf`/`oneOf`/`allOf` and 500 `enum` values in
total. Wide objects are fine; keep schemas under `items` and
`additionalProperties` simple (few branches and enum values), since they run
on every element: a schema too costly per element is refused at definition.
Expect `rate_limited` if writes spend too long validating (each Site has 5 s
of schema checking a minute); removing the schema always works. Field
paths cannot use `__proto__`, `prototype` or `constructor`. An Only me Site's data is reachable only by its owner.

On a Site published to the public, anonymous guests reach a collection only
through its `guestAccess` rule, set with `site_data_define_collection`:
`none` (default), `read`, `append` (add and read their own) or `own` (add,
read, change and delete their own). Grant guests the least the page needs.

In the Site, use the same client:

```ts
import { createOpenGeniSiteClient, OpenGeniSiteDataError } from "@opengeni/sdk/site";

const site = createOpenGeniSiteClient();
const contacts = site.data.collection<{ name: string; email: string }>("contacts");
const page = await contacts.list({
  where: [{ field: "name", op: "contains", value: "acme" }],
  sort: [{ field: "$updatedAt", direction: "desc" }],
  limit: 50,
});
const created = await contacts.insert({ name: "Ada", email: "ada@example.com" });
try {
  await contacts.patch({ id: created.id }, { name: "Ada L." }, { expectedVersion: created.version });
} catch (error) {
  if (error instanceof OpenGeniSiteDataError && error.code === "conflict") {
    // Someone else changed it: reload and let the viewer retry.
  }
}
await site.data.batch([...]); // up to 100 operations, all or nothing
const file = await site.files.upload(input.files[0], { scope: "private" });
const { url } = await site.files.url(file.id); // short-lived; fetch a new one when needed
```

Pass `{ idempotencyKey }` to `insert` when a retry must not add a second
record (a flaky network, a resubmitted form): the same key from the same
viewer returns the original record for a day.

To claim work (a ticket, a job) across viewers and schedules, write a lease
with the server's clock: list with `{ field: "leaseUntil", op: "lt", value:
"$now" }`, then `patch` with `{ expectedVersion }` and a new `leaseUntil`
(an ISO time from the page's own clock, so keep leases minutes long;
`"$now+5m"` style values work in filters, with `s`, `m`, `h` or `d`). The record's `version` is the fencing token: a holder whose lease
lapsed fails its next `expectedVersion` write with `conflict` and must stop.

Also available: `get` (by id or key; resolves null when missing), `put` (create
or replace by key), `delete`, `increment` (atomic numeric add), `count`, and
`list({ cursor })` with `nextCursor` for paging (up to 200 a page). Filters:
`eq`, `ne`, `in`, `gt`, `gte`, `lt`, `lte`, `contains`, `exists` on dotted
data paths or `$id`, `$key`, `$owner` (`"me"`), `$createdAt`, `$updatedAt`,
`$version`. An owner is an opaque id: for a person, `user:` followed by their
subject id, such as `user:user:4f0c2a9e-7b1d-4c3a-9e5f-2a6b8c1d0e3f`. Compare
it whole and use `"me"` instead of building one. Files accept images, PDF,
text, CSV, JSON, audio, video, Office and zip files up to 10 MB;
`private` files are visible only to the uploader and managers.

Collections that grow over time (daily measurements, logs, history) have no
fixed size. Load only what a view shows: filter, sort newest first and page with
`limit` and `nextCursor`, and use `count` for totals. Never fail the whole page
once a collection passes a fixed number of records; show what loaded and say
that older records are not shown.

Media for the page itself can live in files instead of the HTML. Every viewer
can open `shared` files, including anonymous guests of a public Site; guests
cannot upload or delete files or see `private` ones. Upload each file (at most 10 MB) from a
sandbox Codemode script that reads it and calls `site_files_upload` with its
base64, then set the element's `src` to `(await site.files.url(id)).url` when
the page loads. The URL lasts 5 minutes: fetch a fresh one before reusing it.

Stored records and file names are untrusted input written by any viewer.
Render them with `textContent` or React text, never `innerHTML`,
`dangerouslySetInnerHTML`, or string-built HTML, and never `eval` them.

Handle `OpenGeniSiteDataError` codes in the UI: `validation` (bad input or
schema), `conflict` (stale `expectedVersion`, a duplicate unique value, or a
schema changed or record grew mid-request: send it again),
`not_found`, `forbidden` (the access mode does not allow it),
`not_available_for_viewer` (this viewer of a published Site may not do it:
show a friendly state, such as a sign-in button for guests),
`quota_exceeded` (records 256 KB each, charged plus 512 bytes, 100 MB per Site
and 100,000 per collection; at most 4 MB of records per request; files 10 MB
each and 1 GB per Site, by default), `rate_limited` (retry later), and
`site_data_unsupported` (a host or local preview without Site Data). Local
sandbox previews have no Site Data; test the published Site.

**Data sync: refresh data without a model run.** When the App only needs data
copied in from a connected tool (orders, tickets, calendar events, rows of a
sheet), save a sync instead of a scheduled agent task: `app_sync_save` calls
one tool with fixed arguments on a schedule or event, keeps the fields you
name and upserts each record by its key into one collection. Nothing reasons,
so it is cheaper, faster and gives the same result every run. Steps:

1. Call the tool once yourself and look at its result to pick `recordsPath`
   (dot path to the list, e.g. `data.items`; omit when the result is the list),
   `key` (e.g. `id`) and `fields` (omit to keep whole records).
2. Define the collection: `shared_read` for a shared sync, `per_viewer` with
   `privateRecords: true` for a personal one.
3. `app_sync_save` with `siteId`, `name`, `collection`, `tool`
   (`{serverId, toolName}`), `arguments`, `key` and `schedule` (interval of at
   least 300 seconds, a calendar time, or `{"type":"manual"}` with `events`).
4. `app_sync_run` to try it; fix settings from its error. `app_sync_list`,
   `app_sync_delete` manage them.

`mode: "shared"` (default) runs on the saving person's connection and fills
data everyone shares. `mode: "personal"` fills only each opted-in person's own
records from their own account; people opt in with `app_sync_opt_in` (only
when they ask). Changing a personal sync's tool, arguments, collection or mode
clears the opt-ins, so people opt in again. Tools that ask for approval first can't run unattended, so
their runs fail with a readable error. In the page, `await site.data.syncs()`
returns each sync's `lastRun` (`at`, `status`, `error`) and, for personal
syncs, whether the viewer `optedIn`: show "Updated 5 minutes ago" or the error
near the data. Use a scheduled agent task only when a run needs judgment
(summaries, classification, several tools combined).

Agents and scheduled tasks use the tools: `opengeni__site_data_describe`,
`site_data_query`, `site_data_write` (batches of up to 100), `site_data_import`
and `site_data_export` (JSON or CSV), `site_data_reset` (needs
`confirm: true`), and `site_files_list` / `site_files_upload` /
`site_files_delete`. For a dashboard fed on a schedule, define a `shared_read`
collection, then have the scheduled task upsert records with `put` keyed by a
stable id, so reruns replace instead of duplicating. A person-less scheduled
task owns `per_viewer` records as the schedule, so each run sees the last
run's. An agent session started from a Site uses the person's ordinary chat
permissions, just like a console turn. Only outside-workspace visitor agents
use the Site's viewer-bound service identity. The Site page's Data tab
lets the Site's managers browse, export and delete records.

