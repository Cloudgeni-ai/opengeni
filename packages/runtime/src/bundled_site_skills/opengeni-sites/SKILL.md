---
name: opengeni-sites
description: Build, edit, and publish Opengeni Sites. Use when the user asks for a site, dashboard, explorable report, landing page, demo, tracker, portal, directory, calculator, form, or custom agent interface, or when a saved interactive page clearly serves a deliverable they asked for. When working on an existing application, follow its established architecture and workflow; consider Sites only when relevant to the requested outcome, not as an automatic conversion. Respect explicit format and platform choices.
---

# Opengeni Sites

An Opengeni Site is an ordinary Bun web application with retained editable
source (when supplied) and one published runtime file. React is the default,
not a requirement: a plain HTML-only Site is valid. Build and test in the
sandbox, then upload the self-contained HTML and optional source.

Do not invent a Site framework, deployment service, App Host, custom domain
setup, provider-specific API wrapper, or Opengeni-only build CLI. Putting a
Site on the web is built in (see "Publish to the web").

## Sites have no server; AI comes from the host

A Site never needs its own server, API key, or hosting provider to reach
Opengeni. Model access, agent conversations, and workspace tools all come from
the host bridge: `createOpenGeniSiteClient` from `@opengeni/sdk/site` plus the
`@opengeni/react/session-ui` conversation surface. The parent page owns the
credentials and workspace identity; Site code receives neither, so "keep
credentials server-side" is already satisfied by that bridge.

When the user asks for AI, chat, an assistant, "Ask the data", or a "backend"
inside a Site, that bridge is the design. Do not propose Vercel, another
server, a tunnel, or a Connected Machine for Opengeni access, do not spawn a
child to build a separate backend, and do not post a Connect card for a
hosting provider the user did not name. Saved data needs no server either:
Site Data (below) gives every published Site persistent collections and files,
and scheduled tasks feed them through agent tools. A separate server is only
relevant for a genuinely non-Opengeni need: a third-party API that requires a
secret the viewer's browser must not hold, relational queries or volumes Site
Data cannot serve, or live server-side compute. If the request seems to need
one of those, or you cannot tell where the user wants the AI to run,
say which designs are possible and ask before building.

## Start from the durable Site

- For an existing page the user wants to view and share, consider Sites before
  choosing a temporary tunnel or another server. Inspect whether it can be
  packaged as self-contained HTML, preserve its design and behavior, and retain
  editable source when available. A local preview alone is still appropriate
  when that is all the user requests. The Site link opens only for workspace
  members; to share it wider, publish it to the web. Opengeni AI and tool access are
  never such a backend (see above). If the app genuinely requires server-side
  compute that Sites cannot host, explain that constraint and ask how the user
  wants to proceed instead of dropping functionality or choosing a host.
- For a new Site, create a normal project directory with `package.json`,
  `index.html`, TypeScript/React source, styles, tests, and any ordinary build
  configuration the app needs.
- For an edit, call `opengeni__artifacts_get_source` first and restore the
  download URL in `downloads.source.url` using curl or Bun, then restore the
  source bundle (`{entrypoint, files: [{path, content}]}`). If source is null,
  download `downloads.html.url` and edit that HTML instead. URLs expire; call
  the tool again to refresh them. The returned current version id is the
  optimistic-concurrency fence for the next publish.
- Treat retained source as the editable truth and the compiled HTML as the
  runtime projection. Never edit only the generated HTML when source exists.
- Keep secrets, Opengeni access keys, OAuth tokens, workspace ids, API base
  URLs, and signed URLs out of the source and generated HTML.

## Use normal Bun + React

Use the repository's pinned Bun version and ordinary package scripts. A minimal
workflow is:

```bash
bun install
bun ./index.html
bun test
bun build --compile --target=browser ./index.html --outdir=dist
```

Install Opengeni packages from the npm registry using the exact versions in
this Skill's `package-versions.json`. With `skill_read`, request
`{"skill":"opengeni-sites","paths":["package-versions.json"]}` and use the
returned package/version pairs in `bun add --exact package@version ...`.
Reading a Skill does not create local files: do not assume a `/workspace/.agents`
path exists. If this Skill is already checked out, read the file at its actual
location instead. Do not use `latest`, `canary`, or version ranges. First check
for the local-development exception below. Keep these exact dependencies
in saved source. Missing expected exports indicate a package mismatch, not a
reason to replace the standard conversation component with custom wiring.
The pins include `@opengeni/ogtool`. Run `bun run ogtool ...` from this
project for discovery and calls; a sandbox-global CLI can predate the deployment.

Local development only: if `/opt/opengeni/site-packages/sdk.tgz` exists, these
are unreleased checkout packages. Skip the registry command above for Opengeni.
After ordinary dependencies, install these packages with
`bun add --no-save /opt/opengeni/site-packages/sdk.tgz /opt/opengeni/site-packages/react.tgz /opt/opengeni/site-packages/codemode.tgz`.
Remove stale Opengeni overrides; repeat this step after `bun install`. Do not
save sandbox archive paths in published source. In this local-development
exception, use the image's `ogtool` directly: it is built from the same checkout.

For a tool-using local preview, add a small Bun host which serves the HTML and
mounts `createCodemodeSiteRequestHandler()` at
`/__opengeni/site-tools/*`. Authentication is automatic: the Bun handler reads
the existing Codemode environment. Do not copy credentials into Site code.
Site code continues to call only
`createOpenGeniSiteClient()`; it automatically uses this same-origin endpoint
in a top-level preview and the parent `MessagePort` when published.

```ts
import index from "./index.html";
import { createCodemodeSiteRequestHandler } from "@opengeni/codemode";

const siteTools = createCodemodeSiteRequestHandler();
Bun.serve({
  routes: {
    "/__opengeni/site-tools/*": siteTools,
    "/*": index,
  },
  development: true,
});
```

The HTML entrypoint may import `.tsx`, CSS, and ordinary browser assets. The
standalone browser build must produce one self-contained HTML document; inspect
the output directory and fail if runtime JS, CSS, or local asset files are still
required beside it.

For the final browser test, serve that compiled HTML through the same host
instead of rebundling the source with a different development configuration:

```ts
const siteTools = createCodemodeSiteRequestHandler();
Bun.serve({
  fetch(request) {
    if (new URL(request.url).pathname.startsWith("/__opengeni/site-tools/"))
      return siteTools(request);
    return new Response(Bun.file("./dist/index.html"));
  },
});
```

This exercises the exact bytes you will upload, with live tools and SDK calls.
On Docker/local, the server handle is turn-scoped: test it before finishing the
turn; start it again after a recovery or a new turn.

During development, open the sandbox-local URL with the available Browser tools.
Exercise the real interactions at desktop and mobile widths, inspect console
errors, and take a screenshot when visual quality matters. Do not declare the
Site complete from compilation alone.

## Plain HTML without a browser build

For a small HTML-only Site, use ordinary HTML, CSS, and JavaScript. If it calls
Opengeni tools or SDK methods, place this exact optional tag before your own
scripts (without async, defer, or type="module"):

```html
<script src="/__opengeni/site-tools/client.js"></script>
<script>
  const site = createOpenGeniSiteClient();
  // Use the actual tool paths discovered with ogtool on site.tools.
  // site.client is the same ordinary SDK client as in a React Site.
</script>
```

The existing preview handler above serves this script. Serve the raw HTML with
`new Response(Bun.file("./index.html"))` alongside its tool route; no browser
build is needed. In the published viewer, the host resolves the tag to its
browser client. Both use the same SDK implementation and existing tool bridge.
Opening the file directly supplies no tool host. There are no credentials in
the tag or HTML. Declare requested tools and handle errors as for any Site.

Use the exact package pins above for the preview host. The preview runtime comes
from that installed SDK; the published runtime comes from the viewer's deployed
SDK. The tag does not install dependencies, replace React imports, or change Bun.
For TypeScript checking, React components, or imported browser dependencies,
use the normal typed SDK and build workflow above. Do not use both client-loading
paths in one document.

Publish the original HTML containing the tag, not the served client script or
transformed viewer document. For this path, upload `index.html` wherever the
publishing instructions below use `dist/index.html`. Inline ordinary styles,
scripts, and assets as usual; the Opengeni client tag is resolved by the host.
An HTML-only Site can be a small widget; it does not require a full-page layout.

## Prefer Opengeni's UI and typed client

- Prefer `@opengeni/react` components and compiled CSS for Opengeni-native
  session, timeline, composer, queue, approval, and human-input experiences.
- Use custom React only where the Site has a genuinely different product need.
- Inside the published opaque-origin iframe, create the workspace-bound client
  with `@opengeni/sdk/site`. The parent host owns credentials and workspace
  identity; Site code receives neither.

Published Sites have no browser localStorage/sessionStorage. Do not rely on
them for startup or session selection; use React state, Site Data for anything
that must persist, and the SDK's durable session/draft APIs. A sandbox-local
page having storage does not prove the published iframe does.

```ts
import { createOpenGeniSiteClient } from "@opengeni/sdk/site";

const client = createOpenGeniSiteClient();
const issues = await client.tools.linear.issues_list({ state: "Todo" });
```

For embedded conversations, `site.client` is the ordinary Opengeni SDK client;
`site.workspaceId` is a host-resolved routing alias. Use the normal React
complete conversation surface—do not implement session REST or SSE yourself:

```tsx
import { SessionConversation } from "@opengeni/react/session-ui";
import "@opengeni/react/compiled.css";

const site = createOpenGeniSiteClient();
// Match the theme to your chat panel; omit this wrapper for the dark default.
<div data-og-theme="light" style={{ height: "100%", minHeight: 0 }}>
<SessionConversation
  client={site.client}
  workspaceId={site.workspaceId}
  sessionId={sessionId}
/>
</div>
```

`sessionId` is the existing session or the id returned by `site.client.createSession`.
For a normal chat app, offer a conversation selector and “New conversation”.
Create on first Send rather than mounting the page; keep the selected id in React
state and reopen existing conversations through the SDK.
Keep first-send creation single-flight; reuse its `idempotencyKey` when retrying,
then mount `SessionConversation` with the returned id. Do not send that first
message a second time after creation. A useful default list is
`site.client.listSessionPage(site.workspaceId, { originSiteId: "current" })`;
render returned `pinned` and `sessions` (deduplicated by id) and use `nextCursor`
for older results. Published calls automatically record their Site origin—do not
write origin metadata yourself. The local preview has no published identity, so
this filter returns no Site history there; test newly created/current conversations
locally and the selector after publication.

This is a default, not a restriction. For a project-focused app, use `channelId`
on SDK creation/listing instead; its list may include conversations created
elsewhere. Project management tools use `projectId` (see `opengeni-projects`
when available). Do not automatically create a project just to group Site chats.
Unfiled Site conversations group under their Site in the main sidebar; explicit
projects and pins take precedence. Origin remains visible regardless of placement.
The host Site page always provides its own Conversations panel independently of
the navigation you build. Opening existing sessions never changes their origin.

`SessionConversation` connects timeline/history, durable composer drafts,
queue display/edit/delete/steer, pause/resume, and human-input forms. Prefer it
for a normal embedded chat. `ChatComposer` alone is only the input surface;
pairing it with a timeline does not create the queue UI.
Use the lower-level hooks/components only for intentionally custom behavior.

The host owns the chat's available space; `SessionConversation` fills it.
The SDK defaults to dark colors. On a light panel, set `data-og-theme="light"`
on its wrapper; changing the Site's body background does not select the SDK
theme, and the outer Opengeni app's theme does not cross the iframe. Keep
foreground and background on the same SDK tokens rather than overriding
message/button colors individually. Check a real assistant reply, expanded
steps, composer and menus for readable contrast in the chosen theme.
For a full-height page, use a `height: 100dvh` flex-column layout with the
chat panel `flex: 1; min-height: 0` below its header. Keep intervening
flex/grid children shrinkable (`min-height: 0; min-width: 0`). The SDK owns
timeline scrolling and the bottom composer—do not add fixed/sticky positioning
or another timeline scroller. Expand steps, stream messages, and resize the
preview: history should scroll without pushing the composer down the page.

Use the narrow `@opengeni/react/session-ui` entry for chat, not the broad root
entry that pulls unrelated editor/terminal peers. Import compiled CSS once.
Session creation, history, live events,
composer drafts, Send/Steer and queue/control use this client. The same local
Bun handler above forwards them using the agent's current Codemode token;
published Sites use the viewing user's host auth. Agent authority remains
agent authority: testing cannot approve on a human's behalf. Where preview access
permits, test a real Send
and streamed reply, not just a successful page load. Also pause, queue two
messages, edit/delete a queued message, and resume; verify pending messages
remain visible and are not duplicated in the timeline.

The optional `@pierre/diffs` peer brings a large syntax-language bundle. For
a small self-contained Site that does not need highlighted diffs, exclude
`@pierre/diffs` and `@pierre/diffs/react` with Bun's `--external` build flags;
the React renderer already provides a plain-diff fallback. Do not externalize
the Opengeni SDK, React, or other required runtime imports.

The generated tool declarations make exact tool paths typed during authoring.
The runtime proxy resolves those paths to opaque `{serverId, toolName}`
identities. Friendly names are never authority.

## Save data with Site Data

Every published Site can keep persistent JSON records and files in Opengeni.
Data belongs to the Site, not a version: it survives new versions and
rollbacks. An archived Site keeps its data but its page cannot reach it. There
is no live push; read on load or when the viewer refreshes.

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

Also available: `get` (by id or key; resolves null when missing), `put` (create
or replace by key), `delete`, `increment` (atomic numeric add), `count`, and
`list({ cursor })` with `nextCursor` for paging (up to 200 a page). Filters:
`eq`, `ne`, `in`, `gt`, `gte`, `lt`, `lte`, `contains`, `exists` on dotted
data paths or `$id`, `$key`, `$owner` (`"me"`), `$createdAt`, `$updatedAt`,
`$version`. Files accept images, PDF, text, CSV, JSON, audio, video, Office
and zip files up to 10 MB;
`private` files are visible only to the uploader and managers.

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

Agents and scheduled tasks use the tools: `opengeni__site_data_describe`,
`site_data_query`, `site_data_write` (batches of up to 100), `site_data_import`
and `site_data_export` (JSON or CSV), `site_data_reset` (needs
`confirm: true`), and `site_files_list` / `site_files_upload` /
`site_files_delete`. For a dashboard fed on a schedule, define a `shared_read`
collection, then have the scheduled task upsert records with `put` keyed by a
stable id, so reruns replace instead of duplicating. A person-less scheduled
task owns `per_viewer` records as the schedule, so each run sees the last
run's. An agent session started from the Site page acts like the page: only
that Site's data with viewer rights, and no managing collections, for the
session's whole life (even when its owner later chats in it from the
console), so do management from your authoring session or a schedule. The Site page's Data tab
lets the Site's managers browse, export and delete records.

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

`:viewer` (the viewer's stable id, such as `user:<id>` or `guest:<visitor>`),
`:viewer_kind` and `:viewer_signed_in` are bound by Opengeni from the signed-in
viewer. Use `:viewer` for ownership and per-person rows; never take a person's
identity from a page parameter, and never pass `viewer*` params from the page
(they are refused):

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

## Authoring, preview, and viewer access

Your authoring session's tools let you build, inspect, and publish the Site;
they do not define what a human viewer may do in the published app. A conversation
started inside the Site is a separate agent session with its own tool access.
Its own data tools recheck current audience access on every call: removing an
invitation or narrowing the audience takes effect even if cancellation fails.
Non-member execution is funded in increments ($0.25 by default), with the
session ceiling equal to metered spend plus reserved funding. Further work
must fund its next increment; one provider call can overshoot before metering.

For documents, spreadsheets and presentations, a Site-started agent needs the
declared editing tools and may edit or export only artifacts created in its own
Site-clamped session tree. Parent and child sessions share those creations;
another conversation on the same Site does not. Reading or linking an existing
workspace artifact does not grant editing access. There is no existing-artifact
declaration field yet; use an ordinary authorized authoring session for those edits.

There are two client surfaces:

- `site.tools.*` calls workspace tools. Published direct calls must appear in
  `requestedTools` and are checked against the viewer's live tool access.
  Preview calls use your attempt's available tool catalog.
- `site.client.*` calls the ordinary Opengeni REST SDK, including the React
  conversation components. These calls are not entries in `requestedTools`.
  Published calls use the viewer's authorization; sandbox previews use your
  agent proxy's narrower permissions. The preview currently supports workspace
  read and session read/create/control only when your session's permissions and
  enabled tools admit them. Other SDK operations can be valid for a viewer even
  when you cannot execute them in the sandbox. Neither path grants an embedded
  agent the viewer's unrestricted authority.

When a requested feature cannot be live-tested because preview authority is
insufficient, keep the feature and test its build, UI, request construction,
and error handling where possible. Publish if you have publishing access;
state which live operation remains unverified and how the user can test it in
the published Site. Do not claim it works for the viewer until verified, remove
it merely to satisfy preview restrictions, or substitute mock success for a
live result. Distinguish permission failures from broken code, invalid requests,
and service errors; fix actual defects rather than treating every failure as an
access limitation. Missing publishing access itself still blocks publication.

## Request the smallest tool set

1. Find relevant tools with `bun run ogtool list --query <keyword> --limit 10`, then
   inspect selected tools with `bun run ogtool show <path>`. Do not dump the full
   catalog into model context. Generate local types with
   `bun run ogtool declarations <path>` and read only the relevant declarations.
2. Use the same catalog paths while authoring and record each exact canonical
   identity in the Site's `requestedTools` publish field.
3. Do not request tools the Site does not call. A Site using only `site.client`
   SDK operations, with no direct `site.tools` calls, should publish
   `requestedTools: []`.
4. The immutable requested set is only a maximum allowlist; publishing it grants
   no tool authority and requires no separate tool approval. Execution still follows
   normal tool approval rules; handle approval-required responses in the UI.
5. The host intersects that set with the viewer's
   live workspace, permission, and connection authority on every call. Handle
   missing tools, revoked connections, stale catalogs, and access loss as normal
   user-visible error states.

## Show a visualization or Site inside chat

For an inline visualization stored directly in a chat response, read
`opengeni-visualize`. That path does not require publishing a Site.

To embed a published Site, use a fenced `opengeni-site` block containing JSON:

```opengeni-site
{"siteId":"<artifact.id>","versionId":"<published version.id>"}
```

Use the actual returned ids. `versionId` is optional; omitting it loads the
current version when the embed opens. Including it preserves the intended
version. The viewer can choose another version within the embed without
publishing or rolling back the Site. The embed uses the same Site renderer,
reload/full-screen controls, tool declarations and viewer permissions as the
Site page. Embeds resolve in the chat's workspace. Keep a normal Site link when
it helps the user reopen or share it. Archived or inaccessible Sites display
an unavailable state.

Use inline HTML for a visualization that belongs in this response. Use a Site
for a reusable app or durable page, and embed it when useful. Both can be small;
neither requires a dashboard or full-page layout. React Sites still use the
normal build and publish workflow.

## Publish one immutable version

1. Call `opengeni__artifacts_prepare_upload` (no hashes or sizes required).
2. Upload `dist/index.html` to `html.putUrl` with HTTP PUT using curl or Bun.
   Send the returned `requiredHeaders` exactly.
3. If editable source exists, save JSON `{entrypoint, files: [{path, content}]}`
   locally and PUT it to `source.putUrl`. Paths must be relative and
   traversal-free. Exclude node_modules, caches, build output, and credentials.
   Source is optional: skip this upload for an HTML-only Site.
4. Call `opengeni__artifacts_create` with `uploadId`, title, description,
   idempotency key, and exact `requestedTools`. For an edit, call
   `opengeni__artifacts_publish` with the artifact id and
   `expectedCurrentVersionId` from `artifacts_get_source`.

Do not put generated HTML or source into model tool arguments. Upload file
bytes directly from the sandbox. No special SDK upload helper is required.
Finish both intended uploads before publishing. For changed content, prepare
a new upload; published versions do not change if an old PUT URL is reused.

If an idempotent create or publish reports an uncertain outcome, inspect the
artifact list/source and rerun that same persistent script with the exact same
idempotency key. Never mint a replacement key for the same intended version.

After a successful create or publish, use the returned `artifact.workspaceId`
and `artifact.id` to give the user a standard Markdown link to the durable Site:

```md
[Open <Site title>](/workspaces/<workspaceId>/artifacts/<artifactId>)
```

Include that link in the completion reply instead of making the user search for
the Site. Never present a sandbox URL, API content URL, or object-storage URL as
the finished destination.

Archive with `opengeni__artifacts_archive` and restore with
`opengeni__artifacts_restore`. Archiving unpublishes the Site but preserves its
immutable versions and retained source. There is no hard-delete workflow.

## Publish to the web

When the user wants a Site outside the console (a public page, a client
portal, a form for people outside the workspace), publish it to its own
address under the deployment's Sites domain, such as
`team-crm-4k9x.opengeni.site`. Ask before making a Site public; members-only
is the safe default. Use `opengeni__site_hostname_check` for the address,
then `opengeni__site_publication_update` (read with
`opengeni__site_publication_get`), or point the user to **Publish** on the
Site page. Publishing is off when the deployment has no Sites domain
(`sites_publishing_disabled`), and an Only me Site must be shared with the
workspace first.

- Access: `members`, `invited` (members plus listed emails, who sign in to
  Opengeni) or `public` (anyone; visitors who don't sign in are guests).
- Viewer: `const viewer = await site.viewer` gives `{ kind, id, name, email,
  signedIn }` (`kind`: `member`, `invited`, `user` or `guest`), or `null` on
  hosts that don't report viewers. Guests have no name or email. Offer a
  sign-in button that calls `site.auth.signIn()`; never build your own login.
- Embedded agent and limits: the publication turns the Site's agent on or
  off and picks its model. Workspace members are never limited by the Site.
  People outside the workspace share one Site limit ($10 a month by
  default) and an optional per-person limit, which workspace admins set;
  anonymous guests also meet bot guards. Non-member model calls use organization
  credits; members keep their normal billing, including subscriptions. Handle
  `rate_limited`, `site_budget_exhausted` and retryable `site_budget_busy` (429), and
  `site_platform_brake_engaged` (503) as normal UI states.
- The same Site HTML and Site Data work there; no rebuild is needed.
- Every published-host agent gets this Site's `site_data_query` and `site_data_write`,
  plus `site_sql_run` when SQL is enabled; members also get read-only `site_sql_query`.
  The server pins the Site and binds calls to the conversation's viewer, including
  collection ownership and query audiences. No management tools or sandbox are
  supplied; publication settings have no sandbox opt-in. Members get no Site
  budget or stamped session usage limit. Existing Sites pick up defaults without
  republishing. Platform allowances and the global brake never count model spend.

**Build for the audience.** A published page can do only what its viewer
may do. People outside the workspace (invited people and public visitors)
never get workspace tools, and the Site's agent gives them none either; a
subscription model (Codex, Claude or SuperGrok plan) is swapped for the
workspace's credit-billed default for them. So for an invited or public
Site:

- keep the data the page needs in Site Data or Site SQL, not behind
  workspace tools; call `site.tools` only in parts shown to members;
- give guests the least they need: a collection's `guestAccess`, and
  `everyone` only on queries guests must run;
- read `const caps = await site.capabilities` (`null` on hosts that don't
  report it) and hide what this viewer can't use: `caps.agent`,
  `caps.workspaceTools`, `caps.siteData` (`viewer` or `guest`) and
  `caps.sqlQueryAudiences`; `caps.viewAs` is set while a member previews the
  Site as a visitor;
- treat `not_available_for_viewer` (403) as a friendly state, never a crash.

After publishing or changing access, read the publication's `warnings`
(`opengeni__site_publication_get` or `_update`): each names what won't work
for whom and what to change. Fix them in the page, or apply a warning's
safe `fix` with `opengeni__site_publication_apply_fix` (a collection's
guest access or a query's audience) when the user wants that audience to
have it. Tell the user about warnings you leave, and suggest **View as
visitor** on the Publish page to check the Site as its audience sees it.

A published Site is a public web page. Never put secrets, tokens or private
data in its HTML, and render viewer names, emails, records and agent replies
with `textContent` or React text, never `innerHTML`.

## Completion gate

- Tests and the production browser build pass.
- The compiled runtime is one self-contained HTML document within the published
  size limit.
- Desktop and mobile interactions were exercised in the sandbox-local preview.
- Exercise live tools and SDK operations locally through `/__opengeni/site-tools/*`
  wherever the attempt's Codemode authority permits. Report remaining
  viewer-only checks explicitly; those do not by themselves block publication.
- The authenticated parent-frame wrapper exists only in the hosted product.
  Do not build a synthetic parent-frame harness in the sandbox. After local
  validation and publication, use the returned Site link for the hosted check.
- No credential or hidden runtime authority exists in source or HTML.
- The requested tool list is exact and minimal, and unavailable/access-loss
  states are understandable.
- Site Data collections exist with the intended access modes, the page renders
  stored values as text, and quota, conflict and access errors are handled.
- The durable Site contains final HTML and any editable source used to build it.
  Plain HTML-only Sites are valid; their HTML is the editable source.
- The completion reply contains the working Markdown link returned from the
  durable artifact identity.
