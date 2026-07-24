# @opengeni/react

## 0.21.0

### Minor Changes

- d1dee7a: Let embedding hosts read and update an existing session MCP server's approval
  policy through the public API, SDK, and React session hook. Each claimed
  attempt freezes its policy under the session lock, so updates affect the next
  attempt without reinterpreting work already running; model MCP and
  Toolspace/Code Mode consume the same exact snapshot. Toolspace tokens and
  side-effect receipts bind every proxied call to the exact active attempt, so
  Pause, Steer, recovery, and late outputs preserve one authoritative owner.

### Patch Changes

- Updated dependencies [d1dee7a]
  - @opengeni/sdk@0.21.0

## 0.20.0

### Minor Changes

- 9f84cc9: Add durable host-provided per-turn instructions, headless structured-input hooks, host-local queue
  focus, and reusable approval and human-input surfaces for embedded session consumers.

### Patch Changes

- Updated dependencies [9f84cc9]
  - @opengeni/sdk@0.20.0

## 0.19.0

### Minor Changes

- 3aee519: Add a workspace-accepted, provider-agnostic transcription policy and host-adapter contract, plus an accessible composer microphone that keeps partials ephemeral and appends non-empty accepted finals to the editable draft exactly once. Policies explicitly accept automatic language detection and speaker diarization, events can carry strict neutral result metadata, pending starts and cleanup are abortable/bounded, and adapter failures stay behind controlled UI copy with redacted non-UI diagnostics.

### Patch Changes

- 136227e: Add an immutable, versioned curated skill library with explicit workspace selection and inspectable provenance, and preserve WCAG AA contrast for dark-theme primary actions.
- Updated dependencies [136227e]
- Updated dependencies [3aee519]
  - @opengeni/sdk@0.19.0

## 0.18.0

### Minor Changes

- 5547b2f: Let embedders allowlist Changes, Files, Terminal, and Desktop workbench surfaces while keeping disabled surfaces behaviorally dormant.
- 4401ce7: Add a scope-checked host MCP credential resolver to the public embedding port and use it consistently for model-visible MCP tools and Toolspace/Code Mode while preserving the standalone connection broker as the default. Requests carry both the immediate session and its workspace-scoped lineage root so embedded hosts can authorize child sessions through one durable root binding. Provider-neutral bindings now carry a provider family, provider host, opaque host binding id, and exact selected-repository set; successful credentials must echo the complete binding before headers are accepted. Incompatible endpoint authentication and unenforceable resource containment surface as explicit unavailable states instead of starting a duplicate OpenGeni provider connection.
- c389adc: Add a provider-neutral host run-credential port with frozen turn/session lineage,
  off-manifest environment and file generations, proactive renewal, attempt-safe
  cleanup with bounded generation retention, output redaction hints, and structured
  reconnect UI support. Hosts can explicitly opt a frozen target out, and the
  POSIX materializer supports both Linux `flock` and a portable directory-lock
  fallback with cross-platform base64 decoding.
- a11a7fc: Support mixed GitHub, GitLab, and Azure DevOps repositories—including multiple
  accounts or installations for one provider—in a single session through bounded,
  host-opaque credential bindings and optional read/write access intent.

  Validate binding/provider/host echoes before token injection, isolate tokens in
  hashed binding files, select Git credentials by remote path, fail provider CLIs
  closed on ambiguous bindings, and renew each binding independently while keeping
  legacy one-binding-per-provider request and file aliases compatible.

- 2dfd415: Let embedders keep composer drafts in local React state while leaving message, attachment, steer, and control behavior active. Queue checkout is withheld because its atomic API contract necessarily creates a durable composer draft.
- dda6398: Add durable structured human-input tool calls with exact-turn ownership,
  answer/skip/expiry/cancellation outcomes, restart-safe Temporal resumption,
  authorized API and SDK methods, and headless plus styled React embed surfaces.

### Patch Changes

- 4498714: Preserve tool names and arguments when projecting serialized approval items through the session-only React API.
- 51f45a3: Publish the session-only React entry point and typed session control surface in a stable registry release.
- 44ff327: Fence queue, composer, and control hook state to the active workspace and session so target switches cannot expose or accept stale private state.
- Updated dependencies [1fcd83d]
- Updated dependencies [4401ce7]
- Updated dependencies [c389adc]
- Updated dependencies [d249403]
- Updated dependencies [a11a7fc]
- Updated dependencies [51f45a3]
- Updated dependencies [dda6398]
- Updated dependencies [e8ca4f6]
- Updated dependencies [736f4fe]
  - @opengeni/sdk@0.18.0

## 0.17.0

### Minor Changes

- 717a7ef: Add a headless chat-composer controller, compound composer primitives, and typed message overrides while preserving `ChatComposer` as the default preset.
- dbb6232: Support linking an existing GitHub App installation to multiple OpenGeni workspaces with independent repository allowlists.

  - Discover installations through GitHub App user OAuth, require repository-level administrator permission, and configure the OAuth callback in generated App manifests.
  - Persist workspace-scoped installation bindings and repository selections while retaining legacy `all` bindings for compatibility.
  - Enforce the current binding during repository listing, session admission, MCP token minting, and GitHub-authenticated worker turn startup.
  - Add SDK and web controls to link, rescope, and unlink a workspace without uninstalling the GitHub App or affecting another workspace.

### Patch Changes

- bb09be8: Add a session-only React entrypoint and mirror MCP approval policy in
  the public SDK type.
- Bound model-facing tool output, complete input accounting, compact session discovery,
  event and realtime projections, authorized evidence retrieval, and compaction failure
  convergence with explicit truncation and loss metadata throughout the output lifecycle.
  Session event `latest` lookups are now class-exclusive across REST, MCP, and SDK clients.
  Updated-order session discovery now uses a transactional workspace activity-revision fence,
  and the workspace-control bounds migration rewrites only historical cap violations.
- Updated dependencies [bb09be8]
- Updated dependencies
- Updated dependencies [dbb6232]
  - @opengeni/sdk@0.17.0

## 0.16.1

### Patch Changes

- 4e9c48c: Preserve the exact autosaved composer text when sending or steering so trailing whitespace cannot trip the draft consistency fence.
- 9a7dec2: Keep captured workspace files and diffs usable when the live sandbox provider is temporarily unavailable, surface a truthful retryable degraded state, and distinguish provider failures from invalid workspace paths.

## 0.16.0

### Minor Changes

- ec0697a: Ship the production-hardened captured workspace workbench, physically verified Steer/Pause cancellation across cloud, local, and self-hosted model tools, pre-model preparation, sandbox provisioning, and lifecycle/setup commands, durable quiescence admission fencing, cancellation-aware SDK reads and turn cleanup, single-round-trip pruned workspace indexing, truthful shutdown states, a responsive and accessible review dock, Unicode coverage, and package-safe CSS/SSR integration.

### Patch Changes

- 14ce2e3: Bound model-facing textual tool output with Codex-compatible, replay-idempotent semantics, account
  for complete current model input, make compaction failure/progress transitions
  durable and convergent, and replace recursive session discovery with a compact
  paginated projection.
- Updated dependencies [ec0697a]
  - @opengeni/sdk@0.16.0

## 0.15.0

### Minor Changes

- f42cd4a: Replace the old queue and interruption surface with one revisioned prompt queue, durable composer drafts, atomic Steer, recursive Pause/Resume, workspace control invalidation, stale-client contract fencing, and a shared accessible queue UI for first- and third-party consumers. Remove the obsolete passive child-notification setting so every child terminal result follows the one bounded, coalescible internal-update contract.
- 0399277: Add a per-machine telemetry detail view and upgrade the machine cards. The card now leads with a fused health verdict (connection + resource pressure + sample freshness), previews a CPU trend, and shows live freshness; opening a card reveals full metric history (CPU, memory, disk, load, GPU) over 15m/1h/6h/24h with threshold guides and a hover crosshair — rendering the downsampled series the API already served but nothing consumed. Resource meters now read as a coherent green/amber/red traffic-light aligned with the health verdict, and load average renders neutral (it is not core-normalized) with the run queue carrying the real saturation signal.

### Patch Changes

- 215d01d: Render normalized persisted MCP text outputs in custom timeline tool cards.
- Updated dependencies [f42cd4a]
  - @opengeni/sdk@0.15.0

## 0.14.0

### Minor Changes

- dc79905: Harden the workspace dock with persistent tab state, authoritative live-versus-capture defaults, accessible mobile navigation, guarded-file routing, and deterministic browser acceptance coverage.

## 0.13.0

### Patch Changes

- 7a7126d: Fence session events, workspace capture, file tree, git state, warm intents, and tab latches by session identity; bound signed-manifest fetches; refresh same-shape diffs when hunk content changes; and clear stale file metadata during reconciliation.
- ad4502a: Make the workbench and console dependency-safe, keep list identities stable, preserve caught error causes, isolate desktop consent tests from real transports, and enforce warning-free repository lint plus aggregate React tests in CI.
- 04d7595: Discover repositories at any workspace nesting depth, including linked worktrees whose `.git` marker is a file, while pruning dependency/build residue and enforcing timeout and repository-count bounds. An incomplete discovery now persists an epoch-fenced degraded capture revision, announces its typed reason, and makes clients prefer live workspace data instead of presenting a misleading empty capture.
- 0805620: Make active-sandbox pointer swaps establishment-safe. A swap or create-time seed to a target no turn can establish (a non-group Modal sibling, or an unknown backend kind) is now rejected before the epoch-fenced pointer commit with a typed rejection `code`, leaving the pointer and epoch untouched. At turn start a persisted pointer whose target is structurally unestablishable (a deleted sandbox row, a Modal sibling, or an enrollment-less selfhosted row) is reset to the session home under the epoch fence and announced with a new `session.route.reconciled` event, honoring a concurrent higher-epoch swap rather than clobbering it. A null pointer resolves to the session home backend, and the routing proxy's per-op cache is keyed on the full `(activeEpoch, activeSandboxId)` tuple so a clear-to-null re-lands the next op on home rather than a stale swapped-to session. Adds the optional `SwapActiveSandboxResponse.code` discriminant and the `session.route.reconciled` session event type to the public contracts and SDK wire types.
- fbf029c: Make the workspace dock usable on narrow and touch surfaces: replace the cramped two-column diff with an identity-stable changed-file picker, preserve selection across reordered captures, provide accessible target sizes for dock and file controls, and raise text/diff contrast to WCAG 2.2 AA.
- b804fd4: Add provider-neutral git credential contracts and runtime sandbox token-file seeding for GitHub, GitLab, and Azure DevOps. Sandboxes now provision `gh`, `glab`, and `az` wrappers that read current token files at invocation time without storing token values in manifests.
- e4d3569: Add per-member workspace session pins with stable pinned-first listing, subject-scoped FORCE-RLS persistence, snapshot-backed activity pagination, optimistic OCC-safe pin/unpin updates, and accessible responsive web controls.
- 810542f: Commit workspace capture announcements atomically with their revision rows and keep harmless late capture bookkeeping out of the user timeline.
- 5942493: Repair missing file-upload usage records on idempotent finalize retries, reclaim abandoned direct-upload objects through a fenced Temporal cleanup schedule, and preserve accessible provider-backed image previews across reloads.
- a5f58f9: Make "stop" mean stop, and stop the child-completion flood from outrunning it.

  - **Stop drains the queue.** A non-steer interrupt now cancels the active turn AND all queued turns, emitting one `turn.queue_drained` summary event. Steer still promotes exactly one steered message.
  - **A user-paused goal is sacred.** A machine child-completion turn can no longer re-activate a goal the user paused (`goal_set` is refused for such callers), and the wake text drops the "resume it now" nudge when the manager's own goal is user-paused. The caller is classified by its own signed turn identity (a new `turnId` claim on the first-party MCP token), not the session's live active pointer — so the guard cannot be raced into refusing a legitimate human `goal_set`.
  - **Child-completion notifications coalesce.** N spawned workers reaching terminal states now fold into ONE queued digest turn (one model run) instead of N turns, so the flood can no longer outrun a human's stop button. Each worker still gets its own result card.
  - **Human messages preempt machine notifications.** A person's message jumps ahead of any queued child-completion notification turns (behind the running turn and earlier human turns) — it never waits behind a flood of "worker FAILED" notices.
  - **Child-completion suppression opt-in.** A new first-party `set_child_notifications_mode` tool lets a manager switch spawned-worker completions to `passive`: they appear as timeline cards only and never queue a turn or a model run. `digest` remains the default.
  - **Honest steering copy.** The composer no longer claims steer "injects this message now"; it cancels the current step and runs the message next while the goal continues, and the stop button says it clears queued messages and pauses the goal.

- Updated dependencies [ad4502a]
- Updated dependencies [04d7595]
- Updated dependencies [0805620]
- Updated dependencies [faf1487]
- Updated dependencies [b804fd4]
- Updated dependencies [4a25bfc]
- Updated dependencies [3148404]
- Updated dependencies [e4d3569]
- Updated dependencies [a5f58f9]
  - @opengeni/sdk@0.13.0

## 0.12.0

### Minor Changes

- f0ce46c: Credit exhaustion renders as a first-class failure with a top-up CTA (was: silent idle). A budget-exhausted `turn.completed` (`segmentLimit: "budget_exhausted"` / `detail: "insufficient OpenGeni credits"`) now projects as a failed turn-end plus a failed notice instead of a clean completed turn, and `turn.failed` credit errors collapse to one canonical sentence via `humanizeFailureReason`. New exports: `isCreditExhaustion`, `creditExhaustedFromEvents`, and `CREDIT_EXHAUSTION_MESSAGE`. The web console (unversioned app) rides along: a credit-specific banner with an "Add credits" link to organization settings — shown also on idle sessions whose last turn died of budget exhaustion — replacing the "send a message to revive" copy that cannot work without credits.

## 0.11.0

### Patch Changes

- 602db89: Add Toolspace programmatic tool access for sandboxes.

  The new `toolspace:call` permission is an explicit, session-bound delegated grant for sandbox code. When `OPENGENI_TOOLSPACE_ENABLED=true`, worker turns mint a narrow `ogd_` token to a sandbox token file and expose `OPENGENI_TOOLSPACE_URL`; the first-party MCP route uses that token to compose the session's safe first-party, capability-backed, and per-session MCP tools, with approval-required tools denied as MCP `isError` results.

- Updated dependencies [602db89]
  - @opengeni/sdk@0.11.0

## 0.10.0

### Minor Changes

- 7bfe593: Surface the desktop-capture-blocked reason as server-visible enrollment state.

  A machine can have a display it cannot CAPTURE (macOS Screen Recording / TCC not granted). The agent's connect Hello already withholds the desktop cell in that case; this persists a human, actionable reason alongside it so the Machines dashboard / VM picker can render "display: capture not granted" instead of a bare `display_unavailable`.

  - **Contracts / SDK**: `MachineView` (and `EnrollmentSummary`) gain an additive, nullable `desktopUnavailableReason`. Non-null only when a display exists but capture is blocked; `null` == capture permitted OR genuinely headless. Absent/`null` ⇒ byte-identical to today's shape for existing consumers.
  - **DB**: new nullable `enrollments.desktop_unavailable_reason` column (no backfill — `NULL` preserves the existing "capture-permitted or headless" semantics). The display-cursor writer now persists `has_display` AND the reason together, change-guarded on either field, and self-heals to `null` on the next Hello once the grant is restored.

- 351665b: Completed activity clusters of a still-running turn now fold behind neutral chips (facets + a quiet pulse dot; no verdict glyph — the turn has none yet), keeping only the live tail expanded. This bounds the DOM of very long autonomous turns the same way settled folding bounds history; on settle, everything collapses into the single turn fold as before. TurnSummary's `outcome` prop is now optional (absent = in-progress cluster).

### Patch Changes

- 550b055: Fresh-eyes review fixes: sandbox command output uses its canonical `chunk` wire field end-to-end — the projection and the compact coalescer previously read only legacy `text`/`output`, so compact history windows dropped terminal output entirely (and the resume cursor skipped the raw events that carried it); coalesced sandbox runs now also break on stream and commandId so stdout/stderr never merge. Live-cluster folding is re-based on the true invariants: a cluster with running/streaming items never folds, and folding happens only when the NEXT group is agent progress (activity/turn/narration) — so a pending queued message or an approval pause no longer folds the work the reader needs in view.
- Updated dependencies [7bfe593]
  - @opengeni/sdk@0.10.0

## 0.9.1

### Patch Changes

- ea8757a: The timeline projection's event-grammar contract is now pinned by a golden fixture suite (8 realistic event-log fixtures → committed projection snapshots, including compact/raw equivalence and legacy/malformed tolerance). Intentional grammar changes regenerate snapshots so the diff is reviewed; unintentional ones fail CI.
  - @opengeni/sdk@0.9.0

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

- a1c82c5: Add the world-class timeline tool-call renderer module and the sandbox workspace client surface to `@opengeni/react`.

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
