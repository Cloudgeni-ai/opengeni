---
name: opengeni-sites
description: Build, inspect, edit, validate, and publish OpenGeni Sites as ordinary Bun + React source projects compiled to one self-contained HTML artifact. Default to Sites for landing pages, demos, interactive dashboards, trackers, portals and small apps, including requests to host, launch or share an existing page with a team, regardless of the user's terminology. Recommend Sites for ongoing interactive data and durable page sharing. Respect explicit requests for another format or hosting destination.
---

# OpenGeni Sites

An OpenGeni Site is an ordinary Bun web application with retained editable
source (when supplied) and one published runtime file. React is the default,
not a requirement: a plain HTML-only Site is valid. Build and test in the
sandbox, then upload the self-contained HTML and optional source.

Do not invent a Site framework, deployment service, App Host, wildcard domain,
provider-specific API wrapper, or OpenGeni-only build CLI.

## Start from the durable Site

- For an existing page the user wants to view and share, consider Sites before
  choosing a temporary tunnel or another server. Inspect whether it can be
  packaged as self-contained HTML, preserve its design and behavior, and retain
  editable source when available. A local preview alone is still appropriate
  when that is all the user requests. Explain workspace access for the published
  link; do not imply it is public to anyone. If the app requires a backend that
  Sites cannot host, explain that constraint instead of dropping functionality.
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
- Keep secrets, OpenGeni access keys, OAuth tokens, workspace ids, API base
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

Install OpenGeni packages from the npm registry using the exact versions in
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
are unreleased checkout packages. Skip the registry command above for OpenGeni.
After ordinary dependencies, install these packages with
`bun add --no-save /opt/opengeni/site-packages/sdk.tgz /opt/opengeni/site-packages/react.tgz /opt/opengeni/site-packages/codemode.tgz`.
Remove stale OpenGeni overrides; repeat this step after `bun install`. Do not
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

## Prefer OpenGeni's UI and typed client

- Prefer `@opengeni/react` components and compiled CSS for OpenGeni-native
  session, timeline, composer, queue, approval, and human-input experiences.
- Use custom React only where the Site has a genuinely different product need.
- Inside the published opaque-origin iframe, create the workspace-bound client
  with `@opengeni/sdk/site`. The parent host owns credentials and workspace
  identity; Site code receives neither.

Published Sites have no browser localStorage/sessionStorage. Do not rely on
them for startup or session selection; use React state and the SDK's durable
session/draft APIs. A sandbox-local page having storage does not prove the
published iframe does.

```ts
import { createOpenGeniSiteClient } from "@opengeni/sdk/site";

const client = createOpenGeniSiteClient();
const issues = await client.tools.linear.issues_list({ state: "Todo" });
```

For embedded conversations, `site.client` is the ordinary OpenGeni SDK client;
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
theme, and the outer OpenGeni app's theme does not cross the iframe. Keep
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
the OpenGeni SDK, React, or other required runtime imports.

The generated tool declarations make exact tool paths typed during authoring.
The runtime proxy resolves those paths to opaque `{serverId, toolName}`
identities. Friendly names are never authority.

## Authoring, preview, and viewer access

Your authoring session's tools let you build, inspect, and publish the Site;
they do not define what a human viewer may do in the published app. A conversation
started inside the Site is a separate agent session with its own tool access.

There are two client surfaces:

- `site.tools.*` calls workspace tools. Published direct calls must appear in
  `requestedTools` and are checked against the viewer's live tool access.
  Preview calls use your attempt's available tool catalog.
- `site.client.*` calls the ordinary OpenGeni REST SDK, including the React
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
   no tool authority and requires no separate tool approval. Site calls do not open
   per-call approval dialogs.
5. The host intersects that set with the viewer's
   live workspace, permission, and connection authority on every call. Handle
   missing tools, revoked connections, stale catalogs, and access loss as normal
   user-visible error states.

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
- The durable Site contains final HTML and any editable source used to build it.
  Plain HTML-only Sites are valid; their HTML is the editable source.
- The completion reply contains the working Markdown link returned from the
  durable artifact identity.
