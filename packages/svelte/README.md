# `@opengeni/svelte`

Native Svelte 5 stores and semantic session components for OpenGeni.

The package depends on `@opengeni/sdk` and `@opengeni/ui`, not React. It
supports Svelte `>=5.46.4 <6`, server-side imports, deterministic SSR, and
browser hydration.

```svelte
<script lang="ts">
  import { createSessionEvents, MessageTimeline } from "@opengeni/svelte";
  import "@opengeni/svelte/compiled.css";
  import { onDestroy } from "svelte";

  const events = createSessionEvents({ client, workspaceId, sessionId });
  onDestroy(() => events.destroy());
</script>

<div class="og-root">
  <MessageTimeline controller={events.controller} />
</div>
```

Controller readables subscribe directly to `@opengeni/sdk/session` snapshots. Set `owned: false` when adapting a host-owned controller; an owned readable starts on its first browser subscriber and destroys on final teardown. Server rendering is import-safe and does not start browser transports.

Pass `onReconnect` to `MessageTimeline` or `SessionSurface` when the host owns
connection setup. The typed callback receives the projected auth-needed item;
pre-minted authorization URLs remain a fallback for hosts without a callback.

The deployed reference demo defaults to deterministic data. `?mode=live&workspace=<id>&session=<id>` uses the same controllers through the server-owned `/demo-api` proxy.

## Entry points

- `@opengeni/svelte` — native session stores, context, and components;
- `@opengeni/svelte/session` — headless stores and framework-neutral
  projections;
- `@opengeni/svelte/session-ui` — semantic session components;
- `@opengeni/svelte/composer` — composer-focused components;
- `@opengeni/svelte/compiled.css` — complete scoped session stylesheet.

## Context or explicit clients

Use `setOpenGeniContext(...)` for a component subtree, or construct every
controller with explicit `{ client, workspaceId, sessionId }` options. Context
contains only clients, workspace identity, and optional controller factories;
it does not duplicate session state.

`createContextSessionControllers(sessionId)` composes the ordinary session
resource, event, composer, attachment, queue, and control controllers plus
optional goal, human-input, and lineage controllers supported by the supplied
client. Call its `destroy()` method when the host owns that composition.

## Styled session surface

The native component inventory includes session status/chrome, bounded message
timeline and history controls, composer and attachments, queue/control,
approvals, structured human input, and goal presentation. Host renderers use
Svelte snippets/slots. Shared components emit the same `.og-root`, anatomy,
copy, state attributes, tokens, and responsive grammar as React while retaining
native Svelte lifecycle.

Unknown timeline kinds degrade to bounded readable output. Optional React-only
accounts, realtime, browser/computer, machines, artifact editors,
terminal/files/desktop, and workbench composition are deliberately outside the
Svelte package boundary.

See [`docs/framework-ui.md`](../../docs/framework-ui.md) for ownership and
package guarantees.