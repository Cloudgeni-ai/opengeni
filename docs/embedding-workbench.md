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

Import the stylesheet once in your Tailwind entry CSS, and add the `@source` line
so Tailwind compiles the utility classes used inside the components:

```css
@import "@opengeni/react/styles.css";
@source "../node_modules/@opengeni/react/src";
```

Not using Tailwind? Import `@opengeni/react/tokens.css` instead and the
components still render — they only need the `--og-*` CSS variables to be present.

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

### Props worth knowing

| Prop | Purpose |
| --- | --- |
| `sessionId`, `events` | the session and its live event log (from `useSessionEvents`). |
| `primary` | the pane shown beside the dock (your chat/timeline). |
| `onNotify` | host-routed `{ kind: "error" \| "info"; message }` — the package has no toast dependency, so you decide how errors surface. |
| `leadingTabs` / `trailingTabs` | your own `WorkspaceTab[]` injected before / after the workbench tabs (this is how `apps/web` adds its Run and Debug tabs). |
| `initialTab` | override the default landing tab. Omit it and the workbench decides **Changes when the session has changes, else Files** — pre-paint, from local capture stats, so there is never a post-render switch. |
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
| `--og-radius-sm` … `--og-radius-xl` | corner rounding across the dock. |

Light mode is a first-class opt-in: set `data-og-theme="light"` on any ancestor.
Dark is the default.
