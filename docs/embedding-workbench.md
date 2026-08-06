# Embedding the OpenGeni workbench (frontend)

This guide is for a host app that wants to drop the OpenGeni **session workspace**
— the Changes / Files / Terminal / Desktop dock, with instant cold paint and the
machine-state chip — into its own UI. It is the frontend companion to the
backend embedding guide in `docs/embedding.md`, and it is the exact surface
`apps/web` itself consumes (see `apps/web/src/components/session/sandbox-workspace.tsx`),
so an external embedder and the first-party app run the same code path.

Shipping that code path is not acceptance by itself. The required live,
performance, accessibility, identity-race, browser/device, and visual evidence
is defined by [`workbench-acceptance.md`](workbench-acceptance.md).

Everything ships from `@opengeni/react`. The whole dock "brain" — capability
negotiation, capture-backed cold reads, tab construction, prewarm, and the
machine chip — lives in `packages/react/src/components/sandbox-workspace.tsx`; you
mount one component.

## 1. Install

```sh
npm install @opengeni/react @opengeni/sdk react react-dom
```

`@opengeni/react` depends only on `@opengeni/sdk` among OpenGeni packages (a
client-clean closure — no server code is pulled in). `react` and `react-dom`
(v18 or v19) are required peers.

### Optional peer dependencies (per surface)

The workbench lazy-loads the heavy surface renderers, so you only install the
peers for the surfaces you actually render. Missing a peer degrades that one
surface to a notice; it never crashes the dock.

| Surface | Install when you want… | Packages |
| --- | --- | --- |
| Terminal | the interactive xterm PTY | `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-web-links` |
| Files editor | in-browser code editing | `@uiw/react-codemirror` + the `@codemirror/lang-*` grammars you need |
| Changes diff | the Pierre diff renderer | `@pierre/diffs` |
| Desktop | the noVNC desktop viewer | `@novnc/novnc` |

The authoritative list is the `peerDependencies` block of the package manifest
(`packages/react/package.json`).

## 2. Provider

Wrap the tree once in `OpenGeniProvider`, giving it an OpenGeni client and the
workspace id. Every hook and component below reads the client from here (there is
no app-context coupling — that is what makes the workbench embeddable).

```tsx
import { OpenGeniProvider } from "@opengeni/react";
import { OpenGeniClient } from "@opengeni/sdk";

const client = new OpenGeniClient({ baseUrl: "https://api.your-host.example", apiKey });

export function Root({ children }: { children: React.ReactNode }) {
  return (
    <OpenGeniProvider client={client} workspaceId={workspaceId}>
      {children}
    </OpenGeniProvider>
  );
}
```

The client is structural (`SessionClientLike`): if you already have your own
transport, any object with the same method surface works. See
`packages/react/src/client.ts`.

## 3. Styles

For the styled workbench, import the ready-to-use stylesheet once from the host
application entry. The host does not need Tailwind or a package source scan:

```tsx
import "@opengeni/react/compiled.css";
```

The artifact omits Preflight, scopes every utility to `.og-root`, and does not
register Tailwind's global `--tw-*` properties. Independent token defaults
inherit without replacing host `--og-*` values; derived defaults use scoped
effective values, so accent, radius, motion, and surface relationships remain
live. Portalled components copy the trigger's effective tokens onto their
standalone roots.

Tailwind v4 hosts may instead keep the additive source bridge:

```css
@import "tailwindcss";
@import "@opengeni/react/styles.css";
@import "@opengeni/react/responsive.css";
@source "../node_modules/@opengeni/react/src";
```

The small `responsive.css` layer is needed only when the source-bridge host uses
`responsiveBasis="container"`; `compiled.css` already contains it. Import one
styling path, not both. Hosts consuming only
`@opengeni/react/session` need no CSS; that headless subpath remains CSS-free.
For token-only use, import `@opengeni/react/tokens.css` directly.

## 4. Mount `<SandboxWorkspace>`

```tsx
import { SandboxWorkspace, useSessionEvents } from "@opengeni/react";

function Workspace({ sessionId }: { sessionId: string }) {
  const { events } = useSessionEvents(sessionId);
  return (
    <SandboxWorkspace
      sessionId={sessionId}
      events={events}
      primary={<YourChatPane sessionId={sessionId} />}
      onNotify={(n) => n.kind === "error" ? toast.error(n.message) : toast(n.message)}
    />
  );
}
```

That is the whole integration. The dock paints instantly from the latest
turn-end capture (no machine round-trip), then reconciles to live data when the
box is warm, with no tab switch or layout shift in between.

Repository discovery walks the workspace filesystem without a fixed nesting
depth, recognizes both ordinary `.git` directories and linked-worktree `.git`
files, and prunes dependency/build residue. The walk is still bounded by a
timeout and repository-count guard. If either guard trips or discovery fails,
OpenGeni persists and announces an explicit degraded revision instead of an
authoritative-looking empty capture; consumers keep live files authoritative.

An embedder can expose only the surfaces that belong in its product. For
example, this mounts review, file, and terminal capabilities without Desktop:

```tsx
<SandboxWorkspace
  sessionId={sessionId}
  events={events}
  primary={<YourChatPane sessionId={sessionId} />}
  surfaces={["changes", "files", "terminal"]}
/>
```

This is a behavioral allowlist, not just tab filtering. A surface outside the
list does not attach a stream or viewer, request its data, initiate a warm
intent, become the source-driven default, or receive cross-surface navigation.
Omit `surfaces` to retain the full standalone workbench. An empty list is valid
when a host wants only its own `leadingTabs` or `trailingTabs`; in that mode the
built-in machine-state chip is also omitted because no workbench capability is
being observed.

### Props worth knowing

| Prop | Purpose |
| --- | --- |
| `sessionId`, `events` | the session and its live event log (from `useSessionEvents`). |
| `primary` | the pane shown beside the dock (your chat/timeline). |
| `surfaces` | built-in surface allowlist: `"changes"`, `"files"`, `"terminal"`, `"desktop"`. Omit for all four. |
| `onNotify` | host-routed `{ kind: "error" \| "info"; message }` — the package has no toast dependency, so you decide how errors surface. |
| `leadingTabs` / `trailingTabs` | your own `WorkspaceTab[]` injected before / after the workbench tabs (this is how `apps/web` adds its Run and Debug tabs). |
| `initialTab` | override the default landing tab. A built-in tab excluded by `surfaces` is ignored. Omit it and the workbench decides **Changes when the session has changes, else Files** from the authoritative source: instant capture stats while cold/offline, live Git while warm. The choice latches before real content paints, so later edits never steal the current tab. |
| `collapsed` / `onCollapsedChange` | drive the dock open/closed from your own toolbar. |

The machine-state chip (live / waking… / offline — as of `<time>`) is rendered in
the dock header automatically; its popover carries the machine identity, the
shared-session disclosure, and a retry when the fleet fails to resolve.

## 5. Theming

Every visual decision routes through `--og-*` CSS variables
(`packages/react/styles/tokens.css`). Override any of them under a scope you
control (`:root`, a wrapper element, or `[data-og-theme="light"]`) to rebrand the
whole workbench. The high-value tokens:

| Token | Controls |
| --- | --- |
| `--og-color-bg` | the dock background. |
| `--og-color-surface-1` / `--og-color-surface-2` | raised panels, tab-strip and popover surfaces. |
| `--og-color-fg` / `--og-color-fg-muted` / `--og-color-fg-subtle` | primary / secondary / tertiary text. |
| `--og-color-border` / `--og-color-border-strong` | dividers and the dock frame. |
| `--og-color-accent` / `--og-color-accent-soft` | the active tab and selection accents. |
| `--og-color-status-running` / `--og-color-status-idle` / `--og-color-danger` | the machine chip dot, diff add/remove, and error text. |
| `--og-color-diff-add-bg` / `--og-color-diff-del-bg` | the Changes diff add/remove backgrounds. |
| `--og-font-sans` / `--og-font-mono` | UI vs. code/terminal typography. |
| `--og-font-size-xs` … `--og-font-size-md` | the compact SDK text ramp. Matching `--og-line-height-*` tokens control rhythm. |
| `--og-font-size-control` / `--og-font-size-menu` | compact chrome vs. dropdown/menu labels. |
| `--og-font-size-composer` / `--og-font-size-composer-wide` | composer text on the narrow and wide responsive basis. |
| `--og-model-picker-*` | picker trigger height, menu width/padding, row padding, and effort-row height. |
| `--og-realtime-menu-width` | realtime model menu width before viewport/container collision bounds. |
| `--og-radius-sm` … `--og-radius-xl` | corner rounding across the dock. |

Light mode is a first-class opt-in: set `data-og-theme="light"` on any ancestor.
Dark is the default. Set `data-og-density="compact"` (or
`class="og-density-compact"`) on an SDK ancestor for the supported embedded
sidebar preset. The defaults stay render-compatible with the web app's
current type sizes and control geometry. Portalled SDK surfaces copy all
effective `--og-*` values from their trigger, so locally scoped theme and
density overrides remain intact outside the ancestor DOM subtree.

Composer layout remains viewport-responsive by default for same-major render
compatibility. In a sidebar, split pane, or resizable card inside a wider page,
pass `responsiveBasis="container"` to `ChatComposer` or `Composer.Root`. The
root becomes an inline-size query container; nested model, realtime,
transcription, paused, and command controls follow its actual width. Portalled
model/realtime menus observe that same root and are bounded to it while retaining
the copied theme/density tokens. Pointer modality remains independent: container
width chooses information density, while coarse pointers choose 44px targets.
Source-bridge hosts import `@opengeni/react/responsive.css`; the compiled entry
already contains this layout layer.
