# Build, preview and finish a Site app

Read this for any Site app (see "Pick the path first" in SKILL.md). A simple
page does not need it.

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
`{"skill":"sites","paths":["package-versions.json"]}` and use the
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

## Plain HTML that calls Opengeni

An HTML-only app needs no browser build. If it calls Opengeni tools or SDK
methods, place this exact optional tag before your own scripts (without async,
defer, or type="module"):

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
publishing instructions in SKILL.md use `dist/index.html`. Inline ordinary styles,
scripts, and assets as usual; the Opengeni client tag is resolved by the host.
An HTML-only Site can be a small widget; it does not require a full-page layout.

## Authoring, preview, and viewer access

Your authoring session's tools let you build, inspect, and publish the Site;
they do not define what a human viewer may do in the published app. A conversation
started inside the Site is a separate agent session with its own tool access.
Its own data tools recheck current audience access on every call: removing an
invitation or narrowing the audience takes effect even if cancellation fails.
Non-member execution is funded in increments ($0.25 by default), with the
session ceiling equal to metered spend plus reserved funding. Further work
must fund its next increment; one provider call can overshoot before metering.

For documents, spreadsheets and presentations, agents use the same native
artifact permissions in Site and console turns. The page's declared tools
govern direct page calls, not the agent's default tool catalog. Authors may
explicitly request narrower ordinary chat settings; restrictions are not added
merely because the chat is embedded in a Site.

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
   normal tool approval rules, but a Site can't ask the viewer to approve a
   call, so a tool set to Ask fails there: show which tool needs Allow. When
   that blocks the person you work for, offer to set it to Allow in the chat
   with the integration's tool approval app action (they confirm it there)
   instead of describing the setting.
5. The host intersects that set with the viewer's
   live workspace, permission, and connection authority on every call. Handle
   missing tools, revoked connections, stale catalogs, and access loss as normal
   user-visible error states.

## Completion gate (apps)

This gate applies to apps. A simple page is done when its saved link is in
the reply (see "Simple page" in SKILL.md).

- Tests and the production browser build pass.
- The compiled runtime is one self-contained HTML document within the published
  size limit.
- Desktop and mobile interactions were exercised in the sandbox-local preview.
- Reading text, controls and tables follow the chosen readable type scale;
  mobile and 200% text scaling do not clip or shrink primary content.
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
