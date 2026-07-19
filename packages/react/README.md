# @opengeni/react

React hooks and styled components for OpenGeni, built on
[`@opengeni/sdk`](../sdk): live session streaming, a chat composer, a message
timeline that renders streaming deltas / tool calls / spawned-worker status,
session status badges, and fleet tiles for workspace overviews. Two opt-in
surfaces layer on top: a **sandbox-surfacing** workbench (files, terminal, diff,
and an optional desktop stream) and, at the
[`@opengeni/react/machines`](#connected-machines-opengenireactmachines) subpath,
the **Connected Machines** dashboard + enrollment flow.

The default root import (`@opengeni/react`) is the clean sandbox-agnostic
surface — the chat/timeline hooks and components plus the sandbox-surfacing
suite. Advanced chat-composer composition lives under
`@opengeni/react/composer`; Connected-Machine UI lives under
`@opengeni/react/machines`. (The root barrel still re-exports the machines
island for back-compat, deprecated per #144.)

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
  QueueSurface,
  SessionStatus,
  useComposer,
  useSessionEvents,
  useTurnQueue,
} from "@opengeni/react";

const client = new OpenGeniClient({ baseUrl: "/api/opengeni" }); // proxy through your API

function OpsChannel({ sessionId }: { sessionId: string }) {
  const { timeline, sessionStatus, hasOlder, loadingOlder, loadOlder } = useSessionEvents(sessionId);
  const queue = useTurnQueue(sessionId);
  const composer = useComposer(sessionId, { effectiveControl: queue.effectiveControl });
  return (
    <div className="flex h-full flex-col">
      {sessionStatus ? <SessionStatus status={sessionStatus} /> : null}
      <MessageTimeline
        items={timeline}
        status={sessionStatus}
        hasOlder={hasOlder}
        loadingOlder={loadingOlder}
        onLoadOlder={() => void loadOlder()}
        className="min-h-0 flex-1"
      />
      <QueueSurface queue={queue} composer={composer} />
      <ChatComposer composer={composer} effectiveControl={queue.effectiveControl} />
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

## Composer customization (`@opengeni/react/composer`)

Use `ChatComposer` for the standard layout and its `controlsStart`, `header`,
and `messages` props for small additions. For a different layout, import the
headless controller and compound primitives as a namespace. The controller is
the one behavior path for keyboard routing, guarded queue/steer submission,
attachments, commands, pause/resume, focus, confirmations, and feedback.

```tsx
import * as Composer from "@opengeni/react/composer";

function InsertTranscript() {
  const composer = Composer.useChatComposer();
  return (
    <button
      type="button"
      onClick={() => {
        const separator = composer.value.trim().length > 0 ? " " : "";
        composer.setValue(`${composer.value}${separator}Transcribed text`);
        composer.focusInput();
      }}
    >
      Insert transcript
    </button>
  );
}

function CustomComposer({ sessionComposer, attachments, effectiveControl }) {
  const controller = Composer.useChatComposerController({
    delivery: sessionComposer,
    draft: sessionComposer,
    control: sessionComposer,
    attachments,
    effectiveControl,
  });

  return (
    <Composer.Root controller={controller}>
      <Composer.Frame>
        <Composer.CommandPalette />
        <Composer.Surface>
          <Composer.PausedState />
          <Composer.RestoredResources />
          <Composer.Attachments />
          <Composer.Input />
          {controller.confirmState ? (
            <Composer.Confirmation />
          ) : (
            <Composer.Footer>
              <Composer.Controls>
                <Composer.AttachButton />
                <InsertTranscript />
              </Composer.Controls>
              <Composer.Actions>
                <Composer.PauseButton />
                <Composer.SendButton />
              </Composer.Actions>
            </Composer.Footer>
          )}
        </Composer.Surface>
      </Composer.Frame>
      <Composer.Help />
      <Composer.Status />
    </Composer.Root>
  );
}
```

For a pre-session or otherwise limited composer, pass only `delivery`; `draft`
and `control` are optional capabilities rather than no-op requirements. Custom
controls should call `controller.submit("queue" | "steer")` (or read it through
`useChatComposer`) instead of calling a delivery adapter directly, so upload,
disabled, in-flight, and slash-command guards stay intact. Accessory-local UI
state remains application-owned; durable draft and session state remain in
`useComposer`.

## Hooks

- `useSessionEvents(sessionId)` — loads a compact, bounded tail window by
  default, then live-streams on the SDK's exactly-once/ordered event delivery.
  Initial replay is capped at three 5000-row raw pages and `loadOlder` at two;
  timeline group density is only an early stop. It returns the raw windowed
  `events`, projected `timeline`, latest `sessionStatus`, connection state, and
  older-history controls (`hasOlder`, `loadingOlder`, `loadOlder`). Pass
  `replay: "full"` to opt back into full replay; a nonzero `after` keeps the
  previous resume semantics.
- `useComposer(sessionId, { sendExtras, effectiveControl })` — revisioned private
  draft, Send, Steer, and workstream Pause/Resume state. `send()` appends in
  visible queue order; `steer()` supersedes the current direction. Drafts
  autosave with optimistic concurrency, survive failed sends, and reuse one
  `clientEventId` across retries so the server dedupes.
  `sendExtras` (object or function evaluated at send time) merges
  resources/tools/model/reasoningEffort into every message. All human input is
  plain chat text by design; approvals flow as control events
  (`useSessionControl`), not bespoke widgets.
- `useTurnQueue(sessionId, { events })` — the one server-authoritative human
  prompt queue with `moveTurn`, crash-safe `editTurn`, identity-preserving
  `steerTurn`, and `removeTurn`. Mutations carry observed revisions and conflicts
  refetch server truth. Live-updates on `turn.*` and `session.queue.*` events — pass the
  `events` log from `useSessionEvents` to reuse its stream, or let it tail the
  session itself.
- `useGoal(sessionId, { events })` — goal state + autonomy counters
  (`autoContinuations`, `noProgressStreak`) with `pause(rationale?)` /
  `resume()`. Goal-less sessions yield `goal: null`. Live-updates on `goal.*`
  events.
- `useSessionControl(sessionId)` — durable `pause(reason?)` / `resume(reason?)`
  workstream controls and `approve`/`reject(approvalId, message?)` for
  `requires_action` approvals. Pause is recursive control state, not lifecycle
  status or queue work; Resume creates no message.
- `useSession(sessionId)` — fetch one session (optional polling) with
  `updateTitle(title)` (rename) and live title-patching on `session.title_set`.
- `useFileAttachments()` — the composer's attach flow: stages files, drives the
  SDK's direct-to-blob upload, and yields the `resources` to send with a message.
- `useAvailableModels()` — the deployment's provider-grouped selectable `models`
  plus the `defaultModel` to preselect (from the client config) for a picker.
- `useCodexAccounts()` — connected Codex (ChatGPT) accounts, the active/next-run
  pointer, and per-session account pinning for multi-account subscriptions.
- `useSlashCommands(...)` — the slash-command palette state (registry + parsing +
  handlers) behind `CommandPalette`.
- `useWorkspaceSessions()` / `useScheduledTasks()` — workspace lists for
  fleet/manager views (optional polling).
- `useVariable sets()` — workspace variable sets with create/update/remove and
  write-only `setVariable`/`deleteVariable` (values never come back on reads).
- `usePacks()` — capability packs + installations with
  register/enable/remove and `installationFor(packId)`.
- `useWorkspaces()` — the caller's workspaces with create/update (client-only;
  not bound to the provider's workspace).
- `useBillingUsage({ accountId?, workspaceId? })` — credit balance + recent
  usage events for billing meters (client-only, optional polling).

All workspace-scoped hooks resolve the client/workspace from
`<OpenGeniProvider>` or accept `{ client, workspaceId }` per call
(`useWorkspaces`/`useBillingUsage` need only the client). They depend on
`SessionClientLike` — a structural slice of `OpenGeniClient` — so proxy-backed
or scripted clients work unchanged.

## Timeline projection

`buildTimeline(events)` is a pure, tested reducer from the raw event log to
renderable items (user/agent messages with streaming flags, tool calls matched
to outputs, `session_create`/`session_send_message` calls promoted to worker
items, sandbox operations with command output, goal markers, status changes,
notices). User messages carry their attached `resources` and requested `tools`
so consumers can render attachment chips. `groupTimeline` clusters consecutive
activity for collapsed display. Use them directly if you want custom rendering
with the same semantics.

### Compatibility

The projection is a tolerant reader over `SessionEvent.payload` because the wire
contract intentionally keeps payloads open. Unknown event types and unknown or
malformed fields are ignored, never fatal. The golden event-grammar suite in
`test/golden` is the compatibility contract for how existing durable logs render;
intentional changes should regenerate those snapshots and review the diff.

## Components

- `ChatComposer` — auto-growing textarea, Enter-to-send (IME-safe), pause/resume
  controls, inline error recovery. Slots for app chrome:
  `controlsStart` (footer controls like model pickers / attach buttons),
  `header` (e.g. attachment chips above the field), and `onPaste`
  (paste-image-to-attach). Its advanced controller and compound primitives are
  exported from `@opengeni/react/composer`.
- `MessageTimeline` — the session timeline with stick-to-bottom scrolling, a
  "jump to latest" affordance, streaming caret, collapsible activity clusters,
  and worker cards (wire `onOpenSession` to drill into a worker). Pass
  `renderMessageText` to plug a markdown renderer.
- `SessionStatus` / `StatusDot` — status badges; live states breathe.
- `FleetTile` — one session in a fleet grid: title, status, model, recency.
- `ModelPicker` — a compact model dropdown for a composer slot, grouping the
  host-exposed models by provider.
- `Markdown` — the timeline's markdown renderer (GFM), also usable standalone.
- `CommandPalette` — the slash-command palette UI over `useSlashCommands`.

The timeline is extensible: `createToolRegistry` / `defaultToolRegistry` plug
per-tool renderers, and the rendering primitives (`ActivityDisclosure`,
`ScreenshotFigure`, `TermBlock`, `LightboxProvider`, …) compose custom rows with
the same semantics.

## Sandbox surfacing

An opt-in workbench that surfaces a session's live sandbox — files, terminal,
diff, and (when available) a desktop pixel stream — driven by a negotiated
capability document so every surface degrades to a reason instead of crashing.

- `useSessionCapabilities(sessionId, { attachDesktop?, attachTerminal?, attachFiles? })`
  — negotiates the per-session capability doc, tracks lease liveness
  (`cold`/`warming`/`warm`), and acquires the viewer holder(s) that keep the box
  warm. Desktop attach is gated behind the un-redacted-pixel acknowledgment.
- `useSandboxFiles` / `useSandboxGit` — the Pierre file tree + git status/diff
  feeds (the synchronous `fs*`/`git*` SDK point queries plus `fs.changed` /
  `git.changed` live notifications).
- `useSandboxTerminal` / `useTerminalStream` — the read-only command-output
  firehose and the real interactive PTY over the minted `pty-ws` cell.
- `useDesktopStream` — the noVNC socket, hot-swapped on box rollover via
  `stream.url.rotated`.
- Components: `WorkspaceDock` (the resizable/collapsible right-hand dock),
  `FileBrowser` / `SandboxFiles`, `DiffView` / `PierreDiff` / `PierreFile`,
  `CodeEditor`, `SandboxTerminal`, and `DesktopViewer`.

These surfaces pull in [optional peer dependencies](#optional-peer-dependencies)
— install only the ones for surfaces you actually mount.

## Connected Machines (`@opengeni/react/machines`)

Bring-your-own-compute UI: the Machines dashboard, per-machine metrics, the
active-sandbox swap, and the enrollment flow. Imported from the
`@opengeni/react/machines` subpath so consumers that never surface machines
never pull it in.

- `useMachines({ sessionId? })` — polls the fleet, exposes `attach(sandboxId)`
  (wired to the SDK's active-sandbox swap when a `sessionId` is in scope),
  `fetchSeries`, and the `activeSandboxId` / `activeEpoch` pointer.
- `MachinesDashboard` / `MachineCard` / `MachineMetrics` — the fleet grid with
  per-machine meters and an attach/swap affordance.
- `MachineDockBar` / `SharedMachineDisclosure` — the backend-aware bar over the
  sandbox dock naming which machine (Modal box or your machine) it is bound to.
- `EnrollmentDeviceFlow` — the in-session device-flow panel (`userCode` +
  `verificationUri`, pending → authorized/denied/expired).
- `EnrollmentConsent` — the loud whole-machine approve page.
- `MachineStatusPill` / `ConnectionStatusPill` / `ConnectionDot` — status chips,
  plus the `MachineView` / `MachineState` / `MetricSample` view-model types.

```tsx
import { MachinesDashboard, useMachines } from "@opengeni/react/machines";

function Fleet({ sessionId }: { sessionId: string }) {
  const { machines, activeSandboxId, attach, attachingSandboxId, refresh } =
    useMachines({ sessionId, pollIntervalMs: 5000 });
  return (
    <MachinesDashboard
      machines={machines}
      activeSandboxId={activeSandboxId}
      attachingSandboxId={attachingSandboxId}
      onAttach={(m) => attach(m.sandboxId)}
      onRefresh={refresh}
    />
  );
}
```

See the [Connected Machines guide](../../docs/connected-machines.md) for the
end-to-end embedder story (create-on-machine, discover, swap, enroll, revoke).

## Optional peer dependencies

The chat/timeline surface has none. The sandbox-surfacing and diff surfaces pull
their heavy libraries from **optional** `peerDependencies`, so you install only
what the surfaces you mount need:

- Terminal (`SandboxTerminal`): `@xterm/xterm`, `@xterm/addon-fit`,
  `@xterm/addon-web-links`.
- Desktop (`DesktopViewer`): `@novnc/novnc`.
- Diff (`DiffView` / `PierreDiff` / `PierreFile`): `@pierre/diffs`.
- Code editor (`CodeEditor`): `@uiw/react-codemirror` + the `@codemirror/lang-*`
  language packs you need (`css`, `html`, `javascript`, `json`, `markdown`,
  `python`).

## Demo harness

`bun run demo` (from this package) serves a harness that drives the real hooks
and components against a scripted mock client — a manager ops-channel narrative
with streaming, tool calls, and a worker spawn, plus fleet and scheduled-task
views and a dark/light toggle. `bun run demo:build` is part of the repo gate.
