---
name: opengeni-sites
description: Build, inspect, edit, validate, and publish OpenGeni Sites as ordinary Bun + React source projects compiled to one self-contained HTML artifact. Use for interactive pages, dashboards, visualizations, workflows, and focused apps that may call workspace tools through the typed Site bridge.
---

# OpenGeni Sites

An OpenGeni Site is an ordinary Bun web application with retained editable
source and one published runtime file. Build the app normally, validate it in
the sandbox, compile it to a self-contained HTML document, and publish both the
source bundle and compiled HTML through the workspace artifact tools.

Do not invent a Site framework, deployment service, App Host, wildcard domain,
provider-specific API wrapper, or OpenGeni-only build CLI.

## Start from the durable Site

- For a new Site, create a normal project directory with `package.json`,
  `index.html`, TypeScript/React source, styles, tests, and any ordinary build
  configuration the app needs.
- For an edit, call `opengeni__artifacts_get_source` first and restore the
  returned source bundle exactly. The returned current version id is the
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

The HTML entrypoint may import `.tsx`, CSS, and ordinary browser assets. The
standalone browser build must produce one self-contained HTML document; inspect
the output directory and fail if runtime JS, CSS, or local asset files are still
required beside it.

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

```ts
import { createOpenGeniSiteClient } from "@opengeni/sdk/site";

const client = createOpenGeniSiteClient();
const issues = await client.tools.linear.issues_list({ state: "Todo" });
```

The generated tool declarations make exact tool paths typed during authoring.
The runtime proxy resolves those paths to opaque `{serverId, toolName}`
identities. Friendly names are never authority.

## Request the smallest tool set

1. Inspect the current attempt catalog with `ogtool list` and generate local
   declarations with `ogtool declarations <path>` when the Site needs tools.
2. Use the same catalog paths while authoring and record each exact canonical
   identity in the Site's `requestedTools` publish field.
3. Do not request tools the Site does not call. A Site with no direct workspace
   operations should publish `requestedTools: []`.
4. Publishing the immutable version with those requested identities is the
   authorization for that version to call them directly. Site calls do not open
   per-call approval dialogs. Agent-authored versions may request only tools
   classified `approval: none` in the exact attempt catalog; tell the user when
   a current human must publish a version that activates another approval class.
5. The parent still intersects the immutable requested set with the viewer's
   live workspace, permission, and connection authority on every call. Handle
   missing tools, revoked connections, stale catalogs, and access loss as normal
   user-visible error states.

## Publish one immutable version

Read the compiled HTML as text and include every retained project file using a
relative, traversal-free path. Exclude dependency directories, build caches,
coverage, screenshots, credentials, `.env` files, and other generated or secret
material.

For a new Site, call `opengeni__artifacts_create` with:

- a clear title, description, and idempotency key;
- the complete self-contained HTML;
- `source.entrypoint` and the retained source files; and
- the exact `requestedTools` identities.

For an existing Site, call `opengeni__artifacts_publish` with the same complete
payload plus the current version id returned by `artifacts_get_source`. Never
force a stale publish; re-read and reconcile concurrent changes.

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
- No credential or hidden runtime authority exists in source or HTML.
- The requested tool list is exact and minimal, and unavailable/access-loss
  states are understandable.
- The durable Site contains both the final HTML and the source needed for the
  next `Edit with Geni` iteration.
- The completion reply contains the working Markdown link returned from the
  durable artifact identity.
