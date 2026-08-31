# Framework-neutral session runtime and UI

This document is the canonical package-boundary guide for OpenGeni's
embeddable session experience. It covers the framework-neutral session runtime,
shared semantic UI contract, React compatibility layer, and native Svelte
package. Product-shell routing, authentication, billing, workspace
administration, and optional artifact/machine/workbench islands remain outside
the cross-framework session boundary.

## Package graph

The browser package closure is intentionally one-way:

```text
@opengeni/contracts
        ↓
@opengeni/sdk/session      @opengeni/ui
        ↓                       ↓
@opengeni/react           @opengeni/svelte
        ↓                       ↓
React hosts / apps/web     Svelte hosts
```

- `@opengeni/sdk/session` owns framework-neutral session state, projections,
  network mutation semantics, lifecycle fencing, bounded event history, and
  resource diagnostics.
- `@opengeni/ui` owns semantic anatomy, copy, icon roles, status presentation,
  tokens, responsive rules, and scoped CSS. It imports neither framework nor
  the SDK.
- `@opengeni/react` preserves the existing React API. Session hooks subscribe
  to SDK controllers; React remains responsible for context composition,
  framework lifecycle, focus, measurement, portals, drag/drop, and optional
  React-only islands.
- `@opengeni/svelte` provides native Svelte stores, context, components, and
  snippets over the same SDK controllers and UI contract. It has no React
  runtime dependency.

No package in this closure imports API, worker, database, runtime, or other
server packages. The ordinary `@opengeni/sdk` entry also remains import-safe:
session/browser code is reached through the focused `@opengeni/sdk/session`
subpath.

## Session controller contract

Controllers implement an external-store shape:

```ts
type OpenGeniExternalStore<Snapshot> = {
  getSnapshot(): Snapshot;
  subscribe(listener: () => void): () => void;
  start(): void | Promise<void>;
  destroy(): void;
};
```

The session subpath includes controllers for session detail, bounded events and
history, composer drafts, attachments, queue, control, goals, structured human
input, per-session MCP approval policy, and lineage. Pure timeline, approval,
human-input, parser, tool-name, status, and older-history projections live in
the same framework-neutral boundary.

Controller invariants:

- snapshots are synchronous and deterministic;
- every asynchronous result is fenced by target and generation;
- queue and control snapshots are accepted monotonically;
- outcome-unknown mutations retain the operation key where the protocol
  permits replay;
- event history is ordered, compact-cursor aware, density-bounded, and limited
  to 10,000 events / 8 MiB in the browser;
- hidden pages suspend controller-owned live work after the bounded grace and
  reconcile on return;
- reads, streams, timers, visibility listeners, and object URLs are released
  on final teardown;
- construction and server-side imports do not require DOM capabilities.

Advanced hosts may create and own a controller directly. Shared consumers use
`acquireSessionController(...)` and release only their own ownership handle;
the final owner destroys the controller. Development/test diagnostics expose
counts for subscribers, pending reads, streams, timers, listeners, and object
URLs without exposing tenant data.

## React compatibility

Existing React imports remain the compatibility surface:

```tsx
import {
  useSession,
  useSessionEvents,
  useTurnQueue,
} from "@opengeni/react/session";

const session = useSession(sessionId, { client, workspaceId, events });
const history = useSessionEvents(sessionId, { client, workspaceId });
const queue = useTurnQueue(sessionId, { client, workspaceId, events });
```

The session subpath is headless and CSS-free. Styled session components remain
available from `@opengeni/react/session-ui` and the compatibility root. Import
`@opengeni/react/compiled.css` for the existing complete React stylesheet.
React-only accounts, realtime, interaction, artifacts/editors, machines,
terminal/files/desktop, and workbench composition remain supported but are not
part of Svelte parity.

## Native Svelte

Svelte hosts can use explicit clients or provide context:

```svelte
<script lang="ts">
  import { createSessionEvents } from "@opengeni/svelte/session";
  import { MessageTimeline } from "@opengeni/svelte/session-ui";
  import "@opengeni/svelte/compiled.css";
  import { onDestroy } from "svelte";

  const events = createSessionEvents({ client, workspaceId, sessionId });
  onDestroy(() => events.destroy());
</script>

<div class="og-root" data-og-theme="dark" data-og-density="compact">
  <MessageTimeline controller={events.controller} />
</div>
```

Svelte controller readables publish the controller snapshot directly; they do
not copy it into a second mutable state authority. Owned readables start with
their first browser subscriber and retire after the final subscriber. Pass
`owned: false` when adapting a controller whose lifecycle belongs to the host.
Imports and deterministic rendering remain SSR-safe; browser transports begin
only after subscription/mount.

Actionable `auth-needed` rows accept a host-owned `onReconnect` callback on
`MessageTimeline` and `SessionSurface`. The callback receives the projected
auth item so the host can route to OAuth or credential setup. A pre-minted
authorization URL is used only as a fallback when no callback is supplied.

The fixed native session UI boundary includes session status/chrome, timeline
and history controls, composer and attachments, queue/control, approvals,
structured human input, goals, model/reasoning/latency controls, and tool policy
selection. Host-specific renderers use Svelte snippets rather than React
components. Unknown timeline kinds degrade to bounded readable output.

## Shared semantic CSS

All shared styles are scoped beneath `.og-root` and use `data-og-component`,
`data-og-part`, and closed state attributes. Import one compiled framework
stylesheet, or consume the framework-neutral layers directly:

```ts
import "@opengeni/ui/tokens.css";
import "@opengeni/ui/components.css";
import "@opengeni/ui/responsive.css";
```

Override `--og-*` custom properties on an ancestor. Theme and density use
`data-og-theme` and `data-og-density`. Portalled menus/dialogs must copy the
effective tokens from their source root with
`bridgeOpenGeniPortalTokens(...)`. The CSS is precompiled, deterministic,
framework-source-scan free, and does not install global resets or Tailwind
custom properties.

## Demos and release-shaped consumers

The production web build serves the stock product plus `/react-demo/` and
`/svelte-demo/`. Demo API traffic stays behind the existing same-origin
`/demo-api` allowlist and credential boundary. The Svelte demo defaults to
deterministic fixtures; live mode uses explicit workspace/session identifiers
through that proxy.

Release qualification installs packed SDK/UI/React/Svelte tarballs into clean
React, session-only, realtime-only, and native Svelte consumers. The native
consumer must typecheck, browser-build, SSR-render, and hydrate without falling
through to workspace sources. Closure scans reject server-package dependencies,
React reachable from Svelte, Svelte reachable from React, and eager session or
browser code in the SDK base entry.

## Where to make changes

| Change | Canonical source |
| --- | --- |
| Durable session state or network semantics | `packages/sdk/src/session/` |
| Shared anatomy, copy, tokens, or scoped CSS | `packages/ui/` |
| React lifecycle or compatibility adapter | `packages/react/src/` |
| Native Svelte store/component behavior | `packages/svelte/src/` |
| Product/demo routing and proxy security | `apps/web/` |
| Canonical cross-framework state coverage | `test/fixtures/framework-session/` |

Keep framework DOM behavior in its adapter. Do not move focus, textarea
measurement, drag/drop, or portal mounting into the durable session runtime;
do not reimplement queue, replay, draft, approval, or goal authority in a
framework component.