# @opengeni/react

## 0.9.0

### Patch Changes

- 445fb78: First paint of a session is now a single compact fetch (deeper history loads via the scroll sentinel), and the hook exposes `initialLoading` so hosts can suppress genesis fallbacks while the tail window is still fetching — on large sessions the web console painted the session's initial message at the top for the whole fetch.
- Updated dependencies [e513236]
  - @opengeni/sdk@0.9.0

## 0.8.0

### Patch Changes

- 3d708b5: Add compact event replay support for history windows and switch React session-event loading to capped compact pages with coalesced-delta resume cursors.
- Updated dependencies [3d708b5]
  - @opengeni/sdk@0.8.0

## 0.7.0

### Minor Changes

- 5e56bcd: Add tail-first session event loading with reverse durable pagination, older-history loading controls, and timeline props for smooth prepend pagination.

### Patch Changes

- 068c647: A no-op pinned-follow scroll assignment left the programmatic-scroll mark set (no scroll event fires to consume it), which made the reader's next real scroll-up read as programmatic and get eaten — the view snapped back to the bottom and upward backfill could never engage. The mark now self-clears when an assignment doesn't move the scroller.
- d84eef8: Session load and backfill no longer flicker: the timeline stays invisible until its first bottom-anchored frame (a flash of the window top is structurally impossible), rows decide at mount whether they animate so bulk paints never replay entrance animations across the timeline, the scroller disables native browser scroll anchoring (it fought the reader-anchor corrections during backfill), and programmatic scroll echoes can no longer unpin the bottom-follow (which could strand the view just short of the bottom).
- Updated dependencies [15deca0]
- Updated dependencies [5e56bcd]
  - @opengeni/sdk@0.7.0

## 0.6.3

### Patch Changes

- 5962dd0: Republish the closure so published manifests reference `@opengeni/contracts@^0.4.0`. The previous `^0.3.0` ranges exclude 0.4.0 under 0.x caret semantics, causing consumers to nest a stale contracts copy that lacks the current export surface.
- Updated dependencies [5962dd0]
  - @opengeni/sdk@0.6.3

## 0.6.2

### Patch Changes

- a63bc1f: Anchor queued user messages at the turn that actually executes them in the timeline projection, show still-pending queued messages quietly, and ignore cancellation events for queued turns that never started.

## 0.6.1

### Patch Changes

- d935316: The timeline no longer renders queued / running / idle status dividers — they are machinery telemetry the header pill, live shimmer, and turn-chip duration facet already carry. Only attention-worthy statuses (requires_action, failed, cancelled) still earn a divider. Applies retroactively to historical traces since the filter lives in the pure projection.

## 0.6.0

### Minor Changes

- a4f370f: Carve the connected-machine UI into a dedicated `@opengeni/react/machines` subpath, and add `workingDir` to the SDK create-session request.

  - **`@opengeni/react`**: the bring-your-own-compute surface (`useMachines`, `MachinesDashboard`, `MachineCard`, `MachineDockBar`, `SharedMachineDisclosure`, `MachineStatusPill`, `ConnectionStatusPill`, `ConnectionDot`, `MachineMetrics`, `EnrollmentDeviceFlow`, `EnrollmentConsent`, `connectionStatusForState`, and the `MachineView` / `MachineState` / `MachineKind` / `MachinesResponse` / `MetricSample` view-model types) now lives at `@opengeni/react/machines`. The root keeps re-exporting it for backwards compatibility — **non-breaking** — but the root re-export is **deprecated** and will move in a future major. Import from `@opengeni/react/machines` going forward.
  - **`@opengeni/sdk`**: `CreateSessionRequest` gains an optional `workingDir?: string` field — the host working directory for a connected-machine target (the agent runs there; defaults to the machine's launch dir). Ignored for managed sandboxes.

- d9d7743: Render the self-hosted desktop stream: a PNG-frame canvas client for `transport: "relay-frames"`.

  Self-hosted machines stream their desktop as PNG-per-frame protobuf datagrams over the relay (not RFB), so the noVNC/RFB viewer could never render them — the desktop went "warm" but the live stream never came up. This adds `useRelayFrameStream`, a view-only canvas renderer that opens the relay channel, decodes each PNG frame, and paints it (latest-wins backpressure so a slow decode never queues). `useDesktopStream` now dispatches on `DesktopStream.transport`: `"vnc-ws"` → noVNC (Modal boxes), `"relay-frames"` → the frame renderer (self-hosted machines). The `DesktopStream.transport` / `client` unions gain `"relay-frames"` / `"frames"`. View-only in v1 (matches the machine's read-only mode); interactive input is a follow-up.

- d718d37: Render `session_interrupt` as a distinct worker action in the timeline. When a manager agent stops or steers a session it spawned (the new first-party `session_interrupt` MCP tool), the projection now emits a dedicated `interrupt` worker item carrying the target `workerSessionId` and the `mode` (`"stop"` | `"steer"`), and the activity rail titles it accordingly ("Stopping worker" / "Steering worker" / "Worker stopped" / "Worker steered") instead of a generic tool-call row — matching the existing `spawn` / `message` worker rendering.
- ccebacd: Completed, failed, and cancelled turns now fold their activity behind a TurnSummary chip in MessageTimeline, with failed turns starting expanded so their failure text remains visible.
- 5a289d0: Settled turns now collapse the entire turn span behind one summary chip, leaving only the final agent message visible until expanded. Expanding the chip reveals mid-turn narration and nested per-cluster activity summaries.

### Patch Changes

- Updated dependencies [a4f370f]
- Updated dependencies [d9d7743]
  - @opengeni/sdk@0.6.0

## 0.5.0

### Minor Changes

- 48c0d2e: Add session titles. A session now has a short display title that the agent generates itself: on the genesis turn a hidden, non-persisted directive asks the agent to call the new `set_session_title` tool, so the session is named on its own model with no extra LLM call. Users (and agents with `sessions:control`, via `set_other_session_title`) can rename; a user-set title is permanent and is never clobbered by agent writes.

  - `@opengeni/contracts`: `Session.title` / `Session.titleSource`, `UpdateSessionRequest`, and the `session.title_set` event.
  - `@opengeni/sdk`: `client.updateSession(workspaceId, sessionId, { title })`.
  - `@opengeni/react`: `useSession().updateTitle(...)`, live `session.title_set` handling, and `sessionDisplayTitle` now prefers `session.title`.

### Patch Changes

- Updated dependencies [48c0d2e]
  - @opengeni/sdk@0.5.0

## 0.4.0

### Minor Changes

- a1c82c5: Add the world-class timeline tool-call renderer module and the sandbox-surfacing client surface to `@opengeni/react`.

  - **Timeline renderers**: per-tool disclosure cards (full-row toggle, keyboard-accessible), screenshots → lightbox, theme-aware Pierre diffs, turn-collapse summary chips, sub-agent worker/goal landmarks, a consumer-extensible tool registry, and complete state handling (running / complete / failed / cancelled), each with its own affordance.
  - **Sandbox surfacing**: file/terminal/git/desktop hooks and components (`useSandboxFiles`, `useSandboxTerminal`, `useSandboxGit`, `useDesktopStream`, `useTerminalStream`, `useSessionCapabilities`, `SandboxFiles`, `SandboxTerminal`, `DesktopViewer`, `WorkspaceDock`, Pierre diff/file views, `CodeEditor`).

  All additive; `MessageTimeline`'s `items` contract is unchanged. The internal `compactPayloadPreview` helper was removed from the public surface.

### Patch Changes

- Updated dependencies [2989163]
- Updated dependencies [a1c82c5]
  - @opengeni/sdk@0.4.0

## 0.3.1

### Patch Changes

- Updated dependencies [a78a09b]
  - @opengeni/sdk@0.3.1

## 0.3.0

### Minor Changes

- daaffd7: Chat `MessageTimeline` now renders message bodies as **markdown by default** (react-markdown + remark-gfm, themed to the `og-*` design tokens — headings, lists, GFM task lists, inline/fenced code, blockquotes, tables, links). The `renderMessageText` prop still overrides the default renderer.

## 0.2.0

### Minor Changes

- 21c1535: Initial public release of the OpenGeni client packages.

  - `@opengeni/contracts`: shared zod wire-contract schemas and types.
  - `@opengeni/sdk`: zero-dependency, framework-agnostic TypeScript client with typed API, session lifecycle, and SSE streaming (reconnect + replay-by-sequence).
  - `@opengeni/react`: React hooks and styled components built on `@opengeni/sdk`.

  All three now ship ESM + `.d.ts` builds via tsup and are published to npm with provenance.

### Patch Changes

- Updated dependencies [21c1535]
  - @opengeni/sdk@0.2.0
