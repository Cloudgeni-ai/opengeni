---
name: sites
description: Build, edit, and publish Sites. Use when the user asks for a site, dashboard, explorable report, landing page, demo, tracker, portal, directory, calculator, form, or custom agent interface, or when a saved interactive page clearly serves a deliverable they asked for. When working on an existing application, follow its established architecture and workflow; consider Sites only when relevant to the requested outcome, not as an automatic conversion. Respect explicit format and platform choices.
---

# Sites

A Site is a saved page or web app in the workspace: one self-contained HTML
file that the console shows, shares and can put on the web, plus optional
editable source. Sites have no server of their own; Opengeni AI, tools and
saved data come from the host.

Do not invent a Site framework, deployment service, App Host, custom domain
setup, provider-specific API wrapper, or platform-only build CLI. Putting a
Site on the web is built in (see "Publish to the web").

## Pick the path first

- **Simple page**: something to read or look at, such as recipes, an event
  page, a menu, a CV, a short report or a static landing page. Plain HTML and
  CSS, with at most a little script for display (tabs, a toggle, a timer).
  No Site Data, no workspace tools, no AI, no forms that save anything.
  Follow "Simple page" below; nothing else in this Skill is needed.
- **App**: anything that saves data, calls workspace tools, uses AI or chat,
  has several views with state, or needs a build. Follow "Apps" below and
  read only the reference files the app needs.

## Simple page

The person should have a link in well under a minute, after a handful of tool
calls.

1. Do not set a goal, start workers, install packages, or set up React, Bun,
   tests or a browser build for it.
2. Write one `index.html` with inline CSS (and inline script only if the page
   needs it). Include
   `<meta name="viewport" content="width=device-width, initial-scale=1">`,
   follow the readable defaults below and let content reflow into one column
   on a phone. Use system fonts, text, inline SVG or data-URL images, so
   nothing has to load beside the file.
3. At most one quick look at phone width (about 390 px), and only when the
   layout is unusual. Skip desktop sweeps, 200% text passes, screenshots at
   several widths and scripted structure tests; those are for apps.
4. Save it as in "Publish one immutable version", with `requestedTools: []`
   and no source upload: its HTML is the editable source.
5. Reply with the Site link. The link opens for workspace members only. When
   the person wants others to open it (family, customers, "on their phones"),
   offer to put it on the web and ask before making it public, then follow
   "Publish to the web".

## Make new Sites readable by default

Choose a clear type scale before building. For new Sites without an explicit
type scale, start main reading text at 16–18px, controls and table content at
14–16px, and reserve smaller text for genuinely secondary metadata, not
descriptions, navigation, labels needed to use a control, or key results.
Use comfortable line heights (about 1.5–1.7 for prose) and reading widths of
roughly 60–75 characters. Check the chosen font at its rendered size: a large
headline does not make small body copy readable.

Use `rem`/`em` for text, keep the browser's root font size, and allow browser
zoom and user text scaling. Do not shrink primary copy on mobile to fit more
columns; reflow the layout, wrap content, or scroll a wide table instead.
Keep form text readable and let controls grow with their labels.

These are authoring defaults, not a mandatory theme or runtime CSS override.
Honor a user's deliberate design, retain an existing app's type system, and
leave embedded components such as `SessionConversation` on their own styles.
Do not inject a blanket font-size rule into existing Sites or use `!important`
to force this scale onto a component library. If `frontend-design` is available,
use it for visual direction alongside these readability defaults.

For a new page, this optional starting point applies only to elements you mark
with these classes; adapt it to the design rather than importing a global reset.
The sizes below assume the usual 16px browser default and scale with it.

```css
.site-copy { font-size: 1.0625rem; line-height: 1.6; max-width: 70ch; }
.site-control { font: inherit; font-size: 1rem; line-height: 1.5; }
.site-table { font-size: 0.9375rem; line-height: 1.5; }
.site-meta { font-size: 0.8125rem; line-height: 1.5; }
```

A simple page that follows these defaults needs no more checking than its one
optional phone-width look. For an app, before publishing, inspect actual
paragraphs, labels, inputs, buttons, table cells and empty/error states at
desktop and narrow mobile widths, then with text enlarged to 200%. Check
computed sizes and look for clipped or overlapping text; fix layout pressure
rather than making the content smaller. A fixture can demonstrate a type
scale, but does not prove every generated Site follows it.

## Edit an existing Site

- Call `opengeni__artifacts_get_source` first and restore the download URL in
  `downloads.source.url` using curl or Bun, then restore the source bundle
  (`{entrypoint, files: [{path, content}]}`). If source is null, download
  `downloads.html.url` and edit that HTML instead. URLs expire; call the tool
  again to refresh them. The returned current version id is the
  optimistic-concurrency fence for the next publish.
- Treat retained source as the editable truth and the compiled HTML as the
  runtime projection. Never edit only the generated HTML when source exists.
- Keep the path the Site already has: a simple page stays a simple page unless
  the requested change makes it an app.

Keep secrets, Opengeni access keys, OAuth tokens, workspace ids, API base
URLs, and signed URLs out of every Site's source and HTML.

## Publish one immutable version

1. Call `opengeni__artifacts_prepare_upload` (no hashes or sizes required).
2. Upload the HTML (`index.html` for a simple page, `dist/index.html` for a
   built app) to `html.putUrl` with HTTP PUT using curl or Bun. Send the
   returned `requiredHeaders` exactly.
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

- Access: `members`, `invited` (members plus listed emails, who sign in first) or `public` (anyone; visitors who don't sign in are guests).
- The same Site HTML and Site Data work there; no rebuild is needed.

After publishing or changing access, read the publication's `warnings`
(`opengeni__site_publication_get` or `_update`): each names what won't work
for whom and what to change. Fix them, or tell the user about warnings you
leave, and suggest **View as visitor** on the Publish page to check the Site
as its audience sees it. A `public_sign_in_required` warning means this
deployment asks every visitor to sign in to Opengeni, even on public Sites:
that is its setting, not a broken link, so tell the person their visitors
sign in first instead of reporting sharing as broken.

A published Site is a public web page. Never put secrets, tokens or private
data in its HTML. An invited or public app that uses Site Data, Site SQL,
workspace tools or an embedded agent also needs
`references/publish-to-web.md`.

## Apps

Apps follow these two rules and read the references they need.

### Sites have no server; AI comes from the host

A Site never needs its own server, API key, or hosting provider to reach
the workspace. Model access, agent conversations, and workspace tools all come from
the host bridge: `createOpenGeniSiteClient` from `@opengeni/sdk/site`. Use its
`ai.run` helper for inline results, or `@opengeni/react/session-ui` when the app
needs a conversation surface. The parent page owns the
credentials and workspace identity; Site code receives neither, so "keep
credentials server-side" is already satisfied by that bridge.

When the user asks for AI, chat, an assistant, "Ask the data", or a "backend"
inside a Site, that bridge is the design. Do not propose Vercel, another
server, a tunnel, or a Connected Machine for workspace AI access, do not spawn a
child to build a separate backend, and do not post a Connect card for a
hosting provider the user did not name. Saved data needs no server either:
Site Data gives every published Site persistent collections and files,
and scheduled tasks feed them through agent tools. A separate server is only
relevant for a genuinely external need: a third-party API that requires a
secret the viewer's browser must not hold, relational queries or volumes Site
Data cannot serve, or live server-side compute. If the request seems to need
one of those, or you cannot tell where the user wants the AI to run,
say which designs are possible and ask before building.

### Start from the durable Site

- For an existing page the user wants to view and share, consider Sites before
  choosing a temporary tunnel or another server. Inspect whether it can be
  packaged as self-contained HTML, preserve its design and behavior, and retain
  editable source when available. A local preview alone is still appropriate
  when that is all the user requests. The Site link opens only for workspace
  members; to share it wider, publish it to the web. Workspace AI and tool access are
  never such a backend (see above). If the app genuinely requires server-side
  compute that Sites cannot host, explain that constraint and ask how the user
  wants to proceed instead of dropping functionality or choosing a host.
- For a new app, create a normal project directory with `package.json`,
  `index.html`, TypeScript/React source, styles, tests, and any ordinary build
  configuration the app needs. React is the default, not a requirement.

Read the references the app needs with `skill_read`, for example
`{"skill":"sites","paths":["references/build-and-preview.md"]}`:

| The app | Read |
| --- | --- |
| Every app: packages, build, local preview with live tools, requested tools, the completion gate | `references/build-and-preview.md` |
| Inline AI results, an embedded conversation, Opengeni UI components or the typed client | `references/ai-and-chat.md` |
| Saves records or files (Site Data) | `references/site-data.md` |
| Needs tables, joins, counts or unique keys (Site SQL) | `references/site-sql.md` |
| Invited or public, with data, tools or an embedded agent | `references/publish-to-web.md` |

## Show a visualization or Site inside chat

For an inline visualization stored directly in a chat response, read
`visualize`. That path does not require publishing a Site.

To embed a published Site, use a fenced `opengeni-site` block containing JSON:

```opengeni-site
{"siteId":"<artifact.id>","versionId":"<published version.id>"}
```

Use the actual returned ids. `versionId` is optional; omitting it loads the
current version when the embed opens. Including it preserves the intended
version. The embed uses the same Site renderer, tool declarations and viewer
permissions as the Site page, and resolves in the chat's workspace. Keep a
normal Site link when it helps the user reopen or share it.
