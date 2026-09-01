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

The deployed reference demo is intentionally deterministic. It is an SDK
acceptance playground, not a product-shell or live-backend simulator.

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
client. Optional controllers can be excluded explicitly:

```ts
const controllers = createContextSessionControllers(sessionId, { goal: false });
```

Call `destroy()` when the host owns that composition.

## Styled session surface

The native component inventory includes session status/chrome, bounded message
timeline and history controls, composer and attachments, queue/control,
approvals, structured human input, and goal presentation. Host renderers use
Svelte snippets/slots. Shared components emit the same `.og-root`, anatomy,
copy, state attributes, tokens, and responsive grammar as React while retaining
native Svelte lifecycle.

`SessionSurface` is the ready-to-use assembly. Set `showChrome={false}` only
when the host supplies its own session header. Individual components and the
controller stores remain available for customers that want different markup.

The stock composer is itself assembled from the public composer primitives.
Use the same pieces to omit, reorder, wrap, or style controls without forking
submission or attachment behavior:

```svelte
<script lang="ts">
  import {
    ComposerActions,
    ComposerAttachButton,
    ComposerControls,
    ComposerFooter,
    ComposerInput,
    ComposerRoot,
    ComposerSendButton,
    ComposerSurface,
  } from "@opengeni/svelte/composer";
</script>

<ComposerRoot {controller} {attachments} class="customer-composer">
  <ComposerSurface>
    <ComposerInput placeholder="Ask the agent…" />
    <ComposerFooter>
      <ComposerControls><ComposerAttachButton /></ComposerControls>
      <ComposerActions><ComposerSendButton /></ComposerActions>
    </ComposerFooter>
  </ComposerSurface>
</ComposerRoot>
```

Stable `.og-*` classes, `data-og-component`, `data-og-part`, and `--og-*`
tokens are the customization boundary. Tailwind hosts may use those selectors
in their own layers; customers do not need OpenGeni's Tailwind build or source
scanning.

Unknown timeline kinds degrade to bounded readable output. Optional React-only
accounts, realtime, browser/computer, machines, artifact editors,
terminal/files/desktop, and workbench composition are deliberately outside the
Svelte package boundary.

See [`docs/framework-ui.md`](../../docs/framework-ui.md) for ownership and
package guarantees.
