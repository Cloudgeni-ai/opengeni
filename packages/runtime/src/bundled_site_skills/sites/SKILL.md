---
name: sites
description: Build, edit, and publish apps. Use when the user asks for a site, dashboard, explorable report, landing page, demo, tracker, portal, directory, calculator, form, or custom agent interface, or when a saved interactive page clearly serves a deliverable they asked for. When working on an existing application, follow its established architecture and workflow; consider apps only when relevant to the requested outcome, not as an automatic conversion. Respect explicit format and platform choices.
---

# Apps

An app is a saved page or web app in the workspace: one HTML file (a large
app adds build files) that the console shows, shares and can put on the web,
plus optional editable source. Apps have no server of their own; Opengeni AI,
tools and saved data come from the host.

Do not invent an app framework, deployment service, App Host, custom domain
setup, provider-specific API wrapper, or platform-only build CLI. Putting a
app on the web is built in (see "Publish to the web").

## Pick the path first

- **Single-file app**: one HTML page with inline CSS and plain script, no
  build. A page to read or look at (recipes, an event page, a menu, a CV, a
  short report), or a small personal tool that keeps the viewer's own entries
  (a blood-pressure or habit log, a reading list, a form that collects
  answers). No workspace tools, no AI, no data that several people edit
  together. Follow "Single-file app" below; nothing else in this Skill is
  needed.
- **Full app**: needs React or a build, workspace tools, AI or chat, data several
  people share or edit, app SQL, or several views with their own state.
  Follow "Full apps" below and read only the reference files the app needs.

Build what the person asked for. Offer likely extras (export, notes, editing,
filters, more charts) in one sentence of the reply instead of building them.
An app you can finish in this turn needs no goal.

## Single-file app

The person should have a working link in a minute or two, after a handful of
tool calls.

1. Do not set a goal, start workers, install packages, or set up React, Bun,
   tests, a preview server or a browser build for it.
2. Write one `index.html` with inline CSS and script. Include
   `<meta name="viewport" content="width=device-width, initial-scale=1">`,
   follow "Look" below and let content reflow into one column on a phone.
   Use text, inline SVG or small data-URL images such as icons and logos, so
   nothing else has to load beside the file (draw a chart as inline SVG).
   Photos and video go outside the HTML (see "Keep the page small").
3. To keep entries, load the host client with this exact tag before your own
   script, and use app data:

   ```html
   <script src="/__opengeni/site-tools/client.js"></script>
   <script>
     const entries = createOpenGeniSiteClient().data.collection("entries");
     // await entries.insert({ systolic: 128, diastolic: 82, date: "2026-10-26" });
    // const { records, nextCursor } = await entries.list({ sort: [{ field: "$createdAt", direction: "desc" }], limit: 200 });
    // pass { cursor: nextCursor } to load older entries (a "Show more" button).
     // each record is { id, data, ... }; render record.data with textContent.
   </script>
   ```

   Catch errors and show one friendly line instead of crashing; app data only
   works on the saved app, so a local copy shows that line.
4. At most one quick look at phone width (about 390 px), and only when the
   layout is unusual. Skip desktop sweeps, 200% text passes, screenshots at
   several widths, preview servers and test harnesses; those are for full apps.
5. Save it as in "Publish one immutable version", with `requestedTools: []`
   and no source upload: its HTML is the editable source. If it keeps
   entries, then call `opengeni__app_data_define_collection` with the app
  id, the same collection name and `accessMode`: `per_viewer` for each
  person's own entries (add `privateRecords: true` for health or other
  personal data), `append_only` for a form that collects answers. Skip
  `jsonSchema`; check values in the page.
6. Reply with the link as soon as it is saved, in the person's words: what
   it does and how to use it. The link opens for workspace members only.
   When the person wants others to open it (family, customers, "on their
   phones"), offer to put it on the web and ask before making it public,
   then follow "Publish to the web".

## Look

Every new app, single-file apps included, takes the first look that applies:

1. The person's requested design, or the existing app's.
2. A design system the workspace keeps in Knowledge or Skills, if you find one.
3. For an app about one product (a GitHub tracker, a PostHog dashboard), the
   Opengeni look with that product's accent and logo, or the product's own look.
4. Otherwise the Opengeni look: `<link rel="stylesheet" href="/__opengeni/ui.css">`
   in `<head>`, `og-app` on `<body>`, its classes (`og-page`, `og-title`,
   `og-heading`, `og-card`, `og-button` with `og-button-primary`, `og-input`,
   `og-badge`, `og-table`, `og-muted`) and `--og-*` tokens for anything else.
   It follows `prefers-color-scheme` and loads in the console and on the web,
   so add no font, reset or hard-coded white page.

Keep text readable: prose on a page meant for reading at 1–1.125rem, line
height about 1.6 and about 70ch wide; `rem`/`em` for your own sizes; reflow on
a phone instead of shrinking text; browser zoom and text scaling left working.
Leave embedded components such as `SessionConversation` on their own styles.

A single-file app that follows this needs no more checking than its
one optional phone-width look. For a full app, before publishing, inspect actual
paragraphs, labels, inputs, buttons, table cells and empty/error states at
desktop and narrow mobile widths, then with text enlarged to 200%. Check
computed sizes and look for clipped or overlapping text; fix layout pressure
rather than making the content smaller. A fixture can demonstrate a type
scale, but does not prove every generated app follows it.

## Edit an existing app

- Call `opengeni__artifacts_get_source` first and restore the download URL in
  `downloads.source.url` using curl or Bun, then restore the source bundle
  (`{entrypoint, files: [{path, content}]}`). If source is null, download
  `downloads.html.url` and edit that HTML instead. URLs expire; call the tool
  again to refresh them. The returned current version id is the
  optimistic-concurrency fence for the next publish.
- Treat retained source as the editable truth and the compiled HTML as the
  runtime projection. Never edit only the generated HTML when source exists.
- Keep the path the app already has: a single-file app stays one file unless
  the requested change makes it a full app.

Keep secrets, Opengeni access keys, OAuth tokens, workspace ids, API base
URLs, and signed URLs out of every app's source and HTML.

## Publish one immutable version

1. Call `opengeni__artifacts_prepare_upload` (no hashes or sizes required).
2. Upload the HTML (`index.html` for a single-file app, `dist/index.html` for a
   built app) to `html.putUrl` with HTTP PUT using curl or Bun. Send the
   returned `requiredHeaders` exactly.
3. If editable source exists, save JSON `{entrypoint, files: [{path, content}]}`
   locally and PUT it to `source.putUrl`. Paths must be relative and
   traversal-free. Exclude node_modules, caches, build output, and credentials.
   Source is optional: skip this upload for an HTML-only app.
4. Multi-file build only: PUT the other `dist/` files to `assets.putUrl`
   ("Large apps").
5. Call `opengeni__artifacts_create` with `uploadId`, title, description,
   idempotency key, and exact `requestedTools`. For an edit, call
   `opengeni__artifacts_publish` with the artifact id and
   `expectedCurrentVersionId` from `artifacts_get_source`.

Upload bytes directly from the sandbox, never through tool arguments; no SDK
helper is needed. Finish every intended upload before publishing. For changed
content, prepare a new upload; reusing an old PUT URL changes no published
version.

If an idempotent create or publish reports an uncertain outcome, inspect the
artifact list/source and rerun that same persistent script with the exact same
idempotency key. Never mint a replacement key for the same intended version.

After create or publish, share the returned `artifactReference`. All artifacts
use this link form, with the exact returned ID and a descriptive title:

```md
[Open <app title>](artifact:<artifactId>)
```

Include that link in the completion reply. Never present a sandbox URL, API
content URL, or object-storage URL as the finished destination.
Mention source files, tests or tool names only to
someone who asked about them.

Archive with `opengeni__artifacts_archive` and restore with
`opengeni__artifacts_restore`. Archiving unpublishes the app and keeps its
versions and source; there is no hard delete.

### Keep the page small

Visitors download all of the HTML before anything shows, and the apps gateway
can't serve a page over 256 MB. Keep it under 5 MB; a full app over about 1 MB
builds as several files instead ("Large apps"). For media, resize and compress
images to their shown size (WebP or JPEG), and link video or large images from
where they are hosted. App files (`references/site-data.md`) also hold media:
shared files open for every visitor of the app, signed-out guests of a public
app included. A create or publish result with `warnings` means the page is too
heavy: shrink or move the media and publish again.

## Publish to the web

When the user wants an app outside the console (a public page, a client
portal, a form for people outside the workspace), publish it to its own
address under the deployment's apps domain, such as
`team-crm-4k9x.opengeni.site`. Ask before making an app public; members-only
is the safe default. Use `opengeni__app_hostname_check` for the address,
then `opengeni__app_publication_update` (read with
`opengeni__app_publication_get`), or point the user to **Publish** on the
app page. Publishing is off when the deployment has no apps domain
(`sites_publishing_disabled`), and an Only me app must be shared with the
workspace first.

- Access: `members`, `invited` (members plus listed emails, who sign in first) or `public` (anyone; visitors who don't sign in are guests).
- The same app HTML and app data work there; no rebuild is needed.

After publishing or changing access, read the publication's `warnings`
(`opengeni__app_publication_get` or `_update`): each names what won't work
for whom and what to change. Fix them, or tell the user about warnings you
leave, and suggest **View as visitor** on the Publish page to check the app
as its audience sees it. A `public_sign_in_required` warning means this
deployment asks every visitor to sign in to Opengeni, even on public apps:
that is its setting, not a broken link, so tell the person their visitors
sign in first instead of reporting sharing as broken.

A published app is a public web page. Never put secrets, tokens or private
data in its HTML. Before publishing or sharing an app that keeps data or uses
tools, read `references/publish-to-web.md` and review who sees what.

## Full apps

Full apps follow these two rules and read the references they need (the
Opengeni look in a bundled app: `references/build-and-preview.md`).

### Apps have no server; AI comes from the host

An app never needs its own server, API key, or hosting provider to reach
the workspace. Model access, agent conversations, and workspace tools all come from
the host bridge: `createOpenGeniSiteClient` from `@opengeni/sdk/site`. Use its
`ai.run` helper for inline results, or `@opengeni/react/session-ui` when the app
needs a conversation surface. The parent page owns the
credentials and workspace identity; app code receives neither, so "keep
credentials server-side" is already satisfied by that bridge.

When the user asks for AI, chat, an assistant, "Ask the data", or a "backend"
inside an app, that bridge is the design. Do not propose Vercel, another
server, a tunnel, or a Connected Machine for workspace AI access, do not spawn a
child to build a separate backend, and do not post a Connect card for a
hosting provider the user did not name. Saved data needs no server either:
app data gives every published app persistent collections and files,
and a data sync (`app_sync_save`) refills them with no model run. A separate
server is only
relevant for a genuinely external need: a third-party API that requires a
secret the viewer's browser must not hold, relational queries or volumes app
Data cannot serve, or live server-side compute. If the request seems to need
one of those, or you cannot tell where the user wants the AI to run,
say which designs are possible and ask before building.

### Start from the durable app

- For an existing page the user wants to view and share, consider apps before
  choosing a temporary tunnel or another server. Inspect whether it can be
  packaged as self-contained HTML, preserve its design and behavior, and retain
  editable source when available. A local preview alone is still appropriate
  when that is all the user requests. The app link opens only for workspace
  members; to share it wider, publish it to the web. Workspace AI and tool access are
  never such a backend (see above). If the app genuinely requires server-side
  compute that apps cannot host, explain that constraint and ask how the user
  wants to proceed instead of dropping functionality or choosing a host.
- For a new full app, create a normal project directory with `package.json`,
  `index.html`, TypeScript/React source, styles, tests, and any ordinary build
  configuration the app needs. React is the default, not a requirement.

Read the references the app needs with `skill_read`, for example
`{"skill":"sites","paths":["references/build-and-preview.md"]}`:

| The app | Read |
| --- | --- |
| Every full app: packages, build, local preview with live tools, pages and addresses (`/admin`, `?t=` links), requested tools, the completion gate | `references/build-and-preview.md` |
| Inline AI results, an embedded conversation, Opengeni UI components or the typed client | `references/ai-and-chat.md` |
| Saves or reacts to records or files (app data) | `references/site-data.md` |
| Needs tables, joins, counts or unique keys (app SQL) | `references/site-sql.md` |
| Invited or public, with data, tools or an embedded agent | `references/publish-to-web.md` |
| Moves to another workspace | `references/app-packages.md` |

## Show a visualization or app inside chat

For an inline visualization stored directly in a chat response, read
`visualize`. That path does not require publishing an app.

To embed a published app, use a fenced `opengeni-site` block containing JSON:

```opengeni-site
{"siteId":"<artifact.id>","versionId":"<published version.id>"}
```

Use the actual returned ids. `versionId` is optional: omitted, the embed loads
the current version; included, it keeps that version. The viewer can pick
another version in the embed without publishing or rolling back. The embed
uses the same app renderer, reload/full-screen controls, tool declarations and
viewer permissions as the app page, in the chat's workspace. Keep a normal app
link when it helps the user reopen or share it. Archived or inaccessible apps
show as unavailable.

Use inline HTML for a visualization that belongs in this response. Use an app
for a reusable app or durable page, and embed it when useful. Both can be small;
neither requires a dashboard or full-page layout. React apps still use the
normal build and publish workflow.
