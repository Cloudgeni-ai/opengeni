# Slash-command palette

The chat composer accepts a leading `/` to open a filterable **slash-command
palette** — a popover of SESSION / OPERATOR controls (`/help`, `/clear-view`,
`/goal pause|resume`, `/compact`, `/clear`) with argument hints, keyboard
navigation, permission gating, and a danger-confirm for destructive commands.

The single load-bearing design rule: **slash commands are actions on the
session or the UI — never a new structured way to talk to the agent.** The
human↔agent channel stays plain chat. The palette only recognizes a leading
`/`, runs the command client-side or via the SDK, and never delivers a command
to the model as a message. (`packages/react/src/commands/types.ts:4-17`.)

Code wins over this doc. The canonical sources are:

- `packages/react/src/commands/types.ts` — the `SlashCommand` / `CommandContext`
  / `CommandResult` types (the registry contract).
- `packages/react/src/commands/registry.ts` — the parser (`parseCommandLine`),
  the matchers (`matchCommand`, `filterCommands`, `hasPermission`), the arg-hint
  helpers, and **`defaultCommands`** (the v1 command set).
- `packages/react/src/hooks/use-slash-commands.ts` — the palette state machine:
  open/filter, keyboard nav, autocomplete, exact-match-vs-highlight resolution,
  the danger-confirm bridge, and the command-draft send block.
- `packages/react/src/components/chat-composer.tsx` — the `ChatComposer` that
  wires the hook, renders the palette, the `/help` panel, the notice line, and
  the `ConfirmBar`.
- `packages/react/src/components/command-palette.tsx` — the popover listbox.
- `packages/sdk/src/client.ts` / `packages/sdk/src/types.ts` —
  `clearSessionContext`, `compactSessionContext`, `CompactSessionContextResult`,
  and the `session.context.cleared` event type.
- `apps/api/src/routes/sessions.ts` — the `POST .../context/clear` and
  `POST .../context/compact` endpoints.
- `packages/contracts/src/index.ts` — `ClearSessionContextRequest` and
  `CompactSessionContextRequest`.
- `packages/db/src/index.ts` — `clearSessionContext` (the audited DB clear),
  `requestSessionCompaction` / `consumeSessionCompactionRequest`.
- `packages/db/drizzle/0013_session_compact_requested.sql` — the
  `sessions.compact_requested` column.

This palette lives in the **shared** `@opengeni/react` `ChatComposer`, so both
the OpenGeni web console and the Geni product app get it from one component.

---

## The command model

A command is a single object literal in a registry array. Adding a command is a
few lines; the palette list, the prefix filter, the arg-hint footer, and the
`/help` panel all render from that array. The shape
(`packages/react/src/commands/types.ts:70-88`):

```ts
type SlashCommand = {
  name: string;                       // token after the "/"
  aliases?: readonly string[];        // alternate tokens
  description: string;                // shown in palette + /help
  args?: readonly SlashArg[];         // positional args (with oneOf hints)
  permission?: Permission;            // gate: hidden without it
  danger?: boolean;                   // shows a confirm bar before running
  available?: (ctx) => boolean;       // dynamic visibility (e.g. needs a session)
  run: (args, ctx) => CommandResult | Promise<CommandResult>;
};
```

### Client vs server commands

The kind of a command is just *where its `run` does work* — there is no separate
"client command" type:

- **Client commands** touch only the local UI via the `CommandContext`
  affordances (`openHelp`, `clearView`, `notice`). Example: `/help`,
  `/clear-view`.
- **Server commands** call the API through `ctx.client` (the SDK). Example:
  `/goal`, `/compact`, `/clear`.

`CommandContext` (`types.ts:32-56`) hands `run` everything it can reach: the SDK
client, `workspaceId` / `sessionId` / `status` / `permissions`, and the UI
affordances `notice`, `openHelp`, `clearView`, and `confirm`.

### Permission gating & visibility

- `permission` hides a command from the palette **and** `/help` when the operator
  lacks it. `hasPermission` also treats `workspace:admin` as a superuser
  (`registry.ts:40-48`). A gated command is *never shown disabled* — it is simply
  absent (`filterCommands`, `registry.ts:67-81`).
- `available(ctx)` is a second, dynamic gate — e.g. `hasSession` hides the
  server commands until a session exists (`registry.ts:115`,
  `registry.ts:151,171,187`).

### Danger & confirm

A `danger: true` command shows an inline `ConfirmBar` before running. The confirm
flow is bound to the **specific command being run**, not whatever near-match sits
highlighted: `handlers.confirm(command)` carries the command identity into
`confirmState`, and the bar renders from *that* command
(`chat-composer.tsx:117-126`, `chat-composer.tsx:237-242`;
`use-slash-commands.ts:146-159`). This is what stops the destructive `/clear`
from ever being mislabeled as the harmless `/clear-view`.

### Result & draft handling

`run` returns `{ status, message?, keepDraft? }` (`types.ts:58-68`). On `ok` the
draft is cleared unless `keepDraft` is set — used when canceling `/clear`'s
confirm bar so the operator who backed out doesn't silently lose their typed
`/clear` (`registry.ts:190-195`, `use-slash-commands.ts:161-180`).

---

## The v1 command set (live)

From `defaultCommands` (`packages/react/src/commands/registry.ts:122-204`):

| Command | Args | Permission | Danger | Kind | Action |
| --- | --- | --- | --- | --- | --- |
| `/help` (alias `/?`) | — | — | — | client | Opens the in-composer `/help` panel, rendered from the registry. |
| `/clear-view` | — | — | — | client | Resets the **local** timeline view on this device only; no server change. Honest no-op error when the host wired no `onClearView`. |
| `/goal` | `<pause\|resume>` | `sessions:control` | — | server | `PATCH …/goal {status}` — pause/resume the session's goal loop. |
| `/compact` | — | `sessions:control` | — | server | Triggers conversation compaction now (a trigger only — see below). |
| `/clear` | — | `sessions:control` | yes | server | Clears the conversation context. Destructive, confirm-gated, audit-preserving. |

The `/goal` and `/clear`/`/compact` commands are hidden until a session exists
(`available: hasSession`) and require `sessions:control` (or `workspace:admin`).

### Keyboard & interaction

Implemented in `use-slash-commands.ts:292-344`:

- Type `/` → palette opens, filtering by prefix on name/alias.
- `ArrowUp` / `ArrowDown` → move the highlight (wraps); marks the draft as
  explicitly navigated.
- `Tab` → autocomplete the highlighted command name + a trailing space.
- `Enter` → run. **Exact-match wins over highlight** when the operator has not
  arrow-navigated: typing `/clear`+Enter runs the destructive `clear` even
  though the longer `clear-view` sorts first in the filtered list
  (`use-slash-commands.ts:241-271`). Once the operator has arrow-navigated, Enter
  runs the *highlighted* row (so `/clear-view` is reachable via
  ArrowDown+Enter). Matching is case-insensitive.
- Click a row → runs *that* row explicitly via `runAt` (bypasses the exact-match
  override, so clicking `/clear-view` while `/clear` is typed runs clear-view,
  not the destructive clear) (`chat-composer.tsx:196-203`,
  `use-slash-commands.ts:273-287`).
- `Escape` → closes the popover but keeps the draft; any further edit re-opens
  it.
- A `/command` draft can **never** be sent to the agent as chat. While the draft
  matches a command, the send path (Enter and the send button) is blocked even
  after Escape — the operator is nudged to run it from the list or edit the line
  (`use-slash-commands.ts:134-139`; `chat-composer.tsx:149-171,284`).

The palette is **purely additive**: with no `commandContext` prop the
`ChatComposer` behaves exactly as before (`chat-composer.tsx:30-43,147`).

---

## `/clear` semantics & safety

`/clear` is the one destructive command. It replaces the active model-facing
history with an explicit neutral boundary while preserving the prior rows for
audit.

**Confirm-gated, twice.** The palette shows a `ConfirmBar`; the SDK then sends
`{ confirm: true }` on the wire, and the API rejects any POST whose body isn't
literally `{ confirm: true }` with a 400. An empty/accidental POST cannot wipe
context (`registry.ts:188-202`; `client.ts` `clearSessionContext`;
`apps/api/src/routes/sessions.ts:152-158`;
`ClearSessionContextRequest = z.object({ confirm: z.literal(true) })`,
`contracts/src/index.ts:616-618`).

**Permission-gated & mid-turn-refused.** Requires `sessions:control`. The
database locks workspace then session and rejects the clear while an active turn
or unsettled Pause exists, so a racing inference cannot start between an API
precheck and the history rewrite. The client instructs the operator to Pause and
wait for settlement before retrying.

**Audit-preserving — nothing is deleted.** `clearSessionContext`
(`packages/db/src/index.ts:2305-2366`) runs one transaction that:

1. **Supersedes** every active history row (`active: true → false`) — the full
   transcript survives as an audit trail (same pattern as compaction).
2. Inserts **one neutral boundary marker** (`[context cleared]`, a sanitizer-
   clean user message) at `max(position)+1`.
3. Resets `last_input_tokens` to 0 so the next turn's compaction trigger starts
   fresh.

It is idempotent, and the API emits a `session.context.cleared` event carrying
`{ clearedBy, supersededItems, markerPosition }` (`sessions.ts:166-175`;
`session.context.cleared` added to `SESSION_EVENT_TYPES`,
`packages/sdk/src/types.ts`).

Ordinary inference reads only `session_history_items`; it cannot fall through to
an SDK `RunState` blob and resurrect pre-clear conversation. `agent_run_states`
is reserved for a human approval paused mid-turn, and context clear is forbidden
while that state can be live.

---

## `/compact` semantics

`/compact` requests the single durable portable compaction path. It is a
session control action, never a user prompt and never a visible queue row.

The API sets the idempotent `sessions.compact_requested` flag and returns
`{ status: "pending", message }`. A model-facing turn observes the flag without
consuming it, forces the normal Codex-local compaction transition, and clears the
flag only in the same attempt-fenced transaction that installs replacement
history. A failed or superseded summarizer therefore cannot lose the request.

The resulting `session.context.compacted` event carries
`trigger: "operator"`, and the composer surfaces the API message verbatim.

---

## Adding a new command end-to-end

### A client-only command (UI / no API)

One object literal in `defaultCommands` (or in an app's own array passed to the
`ChatComposer` `commands` prop):

```ts
{
  name: "theme",
  description: "Toggle the composer theme.",
  run: (_args, ctx) => {
    ctx.notice({ tone: "ok", message: "Theme toggled." });
    return { status: "ok" };
  },
}
```

That's it — the palette, filter, arg-hint footer, and `/help` all pick it up.

### A server command (new API surface)

When a command needs the backend, add the surface in three layers, then one
registry entry:

1. **API** — a route in `apps/api/src/routes/sessions.ts`, gated with
   `requireAccessGrant(c, deps, workspaceId, "<permission>")`. Validate the body
   with a Zod schema in `packages/contracts/src/index.ts`. Emit a session event
   if it changes session state.
2. **SDK** — a method on `OpenGeniClient` (`packages/sdk/src/client.ts`) plus its
   request/response types (`packages/sdk/src/types.ts`). Use `requestJson` /
   `requestVoid`.
3. **Registry** — a `SlashCommand` whose `run` calls `ctx.client.<method>(…)`,
   sets `permission` (and `danger` if destructive), and `available: hasSession`
   if it needs a live session. Map API status codes to operator-friendly
   messages (see `goalErrorMessage` / `clearErrorMessage`,
   `registry.ts:220-236`).

Apps extend the set by concatenating their own commands onto `defaultCommands`
and passing the result as the `commands` prop — no fork of the shared component.

---

## How it's verified

Shipped in PR **#66** (merged to `main` at **`5762d58`**); the Geni app
re-vendored `@opengeni/{sdk,react}` at `5762d58` via PR **#22** (merged at
`1c7528a`).

**Tests (all in the merge commit, full local gate green before merge):**

- Component / hook (`@opengeni/react`): `slash-commands.test.ts` (registry: parse
  / match / filter / permission / arg-hint), `slash-commands-hook.test.tsx`
  (palette state machine: open/filter, keyboard nav, autocomplete, exact-match
  resolution, draft-send block, confirm bridge), and
  `chat-composer-palette.test.tsx` (end-to-end composer UX incl. the
  click-dispatch and ArrowDown+Enter cases).
- Contracts: `packages/contracts/test/contracts.test.ts` covers
  `ClearSessionContextRequest` and the `isClearedRunStateBlob` sentinel.
- SDK: `packages/sdk/test/client.test.ts` covers `clearSessionContext` /
  `compactSessionContext` (path, body, confirm).
- Runtime: `runtime.test.ts` + `context-compaction.test.ts` cover the cleared-
  sentinel read paths and `force` compaction.
- Real-database / live integration: `test/integration/db.integration.ts` (the
  audited clear + both resurrection paths + compact-request flag),
  `test/integration/api.integration.ts` (the two endpoints, auth + 400/409
  guards), and `test/integration/worker-activity.integration.ts` (the worker
  consuming a forced compaction).

**Live readback (production, hostnames redacted):**

- `GET /healthz` `deploymentRevision == 5762d58` on staging, production, and the
  public base URL (all HTTP 200, identical digests).
- `POST …/context/clear` → **401** (route present, auth-gated);
  `POST …/context/compact` → **401**; a bogus
  `POST …/context/nonexistent` → **404** (control, confirming the 401s are real
  auth-gating, not a catch-all). The two new endpoints are live and access-gated
  in production.

---

## Residual gaps / honest caveats

- **`/clear-view` is a no-op in the OpenGeni console.** The console surface wires
  no `onClearView`, so `/clear-view` returns the honest error
  "This view can't be cleared here (no local timeline to reset)." rather than a
  false success (`chat-composer.tsx:106-112`, `registry.ts:135-145`). This is the
  round-1 review finding's chosen resolution (report honestly rather than fake a
  clear); wiring an actual local-timeline reset in the console is follow-up work,
  not a regression. Hosts that pass `onClearView` (or that adopt one later) get a
  working `/clear-view` with no registry change.
- **`/compact` server-mode and off-mode are no-ops by design** — only the Azure
  client path performs a forced compaction. Correct for how we run today (Azure),
  but the `server` "compact now" synchronous entry point is still the documented
  integration seam, not yet wired (`sessions.ts:188-192`). When the compaction
  work exposes it, switch the route to call it directly.
- **No unconverged review findings.** Both round-1 majors (the `/clear-view`
  false-success and the run_state-mode resurrection) were fixed before merge; CI
  + Bugbot were green at merge.
