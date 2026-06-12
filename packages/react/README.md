# @opengeni/react

React hooks and styled components for OpenGeni, built on
[`@opengeni/sdk`](../sdk): live session streaming, a chat composer, a message
timeline that renders streaming deltas / tool calls / spawned-worker status,
session status badges, and fleet tiles for workspace overviews.

Design-system-first: every visual decision routes through CSS-variable tokens
(`styles/tokens.css`) — color, typography, radius, shadow, motion. Dark mode is
the first-class default; light is an opt-in via `data-og-theme="light"` on any
ancestor. Components are styled with Tailwind v4 utilities mapped onto the
tokens, Radix primitives for behavior, and Motion for state-communicating
animation. Override the tokens to rebrand everything.

## Install & styles

The package ships TypeScript source plus two CSS entries. In your Tailwind v4
entry CSS:

```css
@import "tailwindcss";
@import "@opengeni/react/styles.css";
@source "../node_modules/@opengeni/react/src";
```

(`@source` lets Tailwind compile the utilities used inside the components.
Consuming only the tokens without Tailwind? Import
`@opengeni/react/tokens.css` and use the `--og-*` variables directly.)

## Quick start

```tsx
import { OpenGeniClient } from "@opengeni/sdk";
import {
  ChatComposer,
  MessageTimeline,
  OpenGeniProvider,
  SessionStatus,
  useComposer,
  useSessionEvents,
} from "@opengeni/react";

const client = new OpenGeniClient({ baseUrl: "/api/opengeni" }); // proxy through your API

function OpsChannel({ sessionId }: { sessionId: string }) {
  const { timeline, sessionStatus } = useSessionEvents(sessionId);
  const composer = useComposer(sessionId);
  return (
    <div className="flex h-full flex-col">
      {sessionStatus ? <SessionStatus status={sessionStatus} /> : null}
      <MessageTimeline items={timeline} status={sessionStatus} className="min-h-0 flex-1" />
      <ChatComposer composer={composer} status={sessionStatus} />
    </div>
  );
}

export function App() {
  return (
    <OpenGeniProvider client={client} workspaceId={workspaceId}>
      <OpsChannel sessionId={sessionId} />
    </OpenGeniProvider>
  );
}
```

## Hooks

- `useSessionEvents(sessionId)` — live stream + replay on the SDK's
  exactly-once/ordered event delivery; returns the raw `events`, the projected
  `timeline`, the latest `sessionStatus`, and the connection state. Updates are
  batched per animation-frame-ish window so long replays stay smooth.
- `useComposer(sessionId)` — draft/send/interrupt state. Drafts survive failed
  sends; each draft reuses one `clientEventId` across retries so the server
  dedupes. Chat is the only human→agent input surface by design — there are no
  approval or decision widgets.
- `useSession(sessionId)` — fetch one session (optional polling).
- `useWorkspaceSessions()` / `useScheduledTasks()` — workspace lists for
  fleet/manager views (optional polling).

All hooks resolve the client/workspace from `<OpenGeniProvider>` or accept
`{ client, workspaceId }` per call. They depend on `SessionClientLike` — a
structural slice of `OpenGeniClient` — so proxy-backed or scripted clients work
unchanged.

## Timeline projection

`buildTimeline(events)` is a pure, tested reducer from the raw event log to
renderable items (user/agent messages with streaming flags, tool calls matched
to outputs, `session_create`/`session_send_message` calls promoted to worker
items, sandbox operations with command output, goal markers, status changes,
notices). `groupTimeline` clusters consecutive activity for collapsed display.
Use them directly if you want custom rendering with the same semantics.

## Components

- `ChatComposer` — auto-growing textarea, Enter-to-send (IME-safe), stop
  control while a turn runs, inline error recovery.
- `MessageTimeline` — the session timeline with stick-to-bottom scrolling, a
  "jump to latest" affordance, streaming caret, collapsible activity clusters,
  and worker cards (wire `onOpenSession` to drill into a worker). Pass
  `renderMessageText` to plug a markdown renderer.
- `SessionStatus` / `StatusDot` — status badges; live states breathe.
- `FleetTile` — one session in a fleet grid: title, status, model, recency.

## Demo harness

`bun run demo` (from this package) serves a harness that drives the real hooks
and components against a scripted mock client — a manager ops-channel narrative
with streaming, tool calls, and a worker spawn, plus fleet and scheduled-task
views and a dark/light toggle. `bun run demo:build` is part of the repo gate.
