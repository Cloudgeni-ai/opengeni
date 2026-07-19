# Durable waits and one-shot background jobs

OpenGeni agents can stop consuming inference while an existing session waits for
human input, a timestamp, an authenticated event, or a one-shot asynchronous
command. PostgreSQL owns each wait and job transition. Temporal provides durable
timers and replaceable wake/controller execution, while NATS is best-effort live
fanout only.

This document is the canonical maintainer guide for these primitives. The wire
schemas live in `packages/contracts/src/index.ts`; the PostgreSQL state machines
live in `packages/db/src/index.ts`; and the session and background-job workflows
live under `apps/worker/src/workflows/`.

## Choose the right primitive

| Need | Primitive | How the session continues |
| --- | --- | --- |
| Structured human input inside the current tool call | `ask_user` | Resumes the same saved SDK `RunState` exactly once; the tool returns the private answer/cancel/timeout result. |
| One absolute time on the current session | `wait_until` | Resolves a passive wait and adds one typed internal update for a new system turn. |
| One authorized external/internal event | `wait_for_event` | Resolves a passive wait and adds one typed internal update for a new system turn. |
| One asynchronous command | `start_background_job` | A dedicated provider controller observes the command; its terminal state adds one typed internal update for a new system turn. |
| Recurring or operator-managed automation | Scheduled tasks | Use the scheduled-task definition/run system, not an existing-session wait or background job. |
| Codex subscription capacity | Capacity waits | Owned separately by the subscription allocator; see [`codex-subscription-rotation.md`](codex-subscription-rotation.md). |
| Generic active-goal wake | Goal continuation | Owned by the goal loop; see [`goals.md`](goals.md). |

`wait_until` is deliberately not a one-entry scheduled task. It has no recurring
definition, run mode, overlap policy, or independent agent configuration: it is
one suspension already bound to one signed turn attempt and one existing
session. A background job is also one-shot and bound to its origin session; it
does not create a reusable scheduled-task definition.

## Shared architecture and invariants

### PostgreSQL is authoritative

The `durable_waits` row records the origin turn, execution generation, exact
attempt UUID, request key, request shape, deadline/reminder state, and terminal
outcome. Background work additionally uses `background_jobs`,
`background_job_attempts`, `background_job_dispatches`,
`background_job_log_chunks`, and `background_job_artifacts`. Every table is
workspace-scoped with FORCE RLS.

The canonical transactional lock order is:

```text
workspace -> session -> turn -> wait -> job/observer attempt
```

Creation requires the signed running turn's generation and attempt fence.
Terminal settlement updates the source wait/job state and creates the session
wake in one transaction. A late or superseded attempt cannot create, resolve,
or resume work.

Temporal signals are wake hints, not work records. The session workflow peeks
PostgreSQL after startup, restart, signal delivery, and `continueAsNew`; it
reconstructs the nearest deadline or reminder timer from stored timestamps.
Transactions that make a session runnable increment the revisioned
`session_workflow_wake_outbox`. Direct signaling is only the fast path; the
bounded control-worker repair sweep redelivers unacknowledged revisions.

NATS publication happens after durable commit and is best effort. A NATS outage
can delay live UI updates, but it cannot undo a wait/job terminal transition or
cause provider work to rerun. API SSE replay fills gaps from PostgreSQL.

### Human-only prompt queue and closed internal updates

Waits and jobs never manufacture user messages or visible prompt-queue rows.
The prompt queue remains human/API input only. Passive wait and job terminals
reuse the existing closed `SessionSystemUpdateKind` union:

```text
scheduled_occurrence
goal_continuation
agent_message
agent_steer_instruction
child_terminal_result
```

No new top-level internal-update kind was added. Passive wait terminals are a
`scheduled_occurrence` whose nested occurrence is `durable_wait`; background
job terminals use nested `background_job_terminal`. Stable dedupe keys make
duplicate timers, event deliveries, controller retries, and wake-repair passes
produce at most one runnable system update.

Workspace/session pause, recursive branch pause, cancellation, Steer, current
attempt fences, and human-input priority still govern admission. Resolving a
wait can make work durable, but cannot bypass those controls.

### Request replay and conflict

Agent-created waits use a caller-supplied `requestKey`, unique within the
session. Repeating the exact request from the exact signed attempt returns the
existing row. Reusing the key with different content, kind, origin, generation,
or attempt is a conflict. Background jobs apply the same rule and persist a
stable fire key.

This replay rule prevents an escaped transport retry from registering a second
wait or launching a second provider command.

## `ask_user`: private same-turn continuation

`ask_user` accepts one to twenty typed questions (`text`, `single_select`, or
`multi_select`), optional title/description, an optional absolute timeout, and
an optional reminder interval. It is indefinite when `timeoutAt` is omitted.

The agent runtime treats `ask_user` as an SDK approval interruption:

1. The running attempt persists its serialized `RunState`, approval ID, exact
   generation/attempt fence, and one `durable_waits` row.
2. The session enters `requires_action`; no model call runs while it waits.
3. A viewer answers or cancels with an idempotent `clientEventId`, or the durable
   timer settles a configured timeout.
4. One transaction validates the question answers, resolves the wait, consumes
   that pending approval, and enqueues the workflow-wake revision.
5. The saved logical turn resumes once. Re-executing the signed `ask_user` tool
   reads the terminal resolution for that turn and request key.

Answer content stays in the private wait resolution. The public session event
contains only the approval/wait identifiers and terminal outcome needed for
RunState replay; answers are not copied into the visible event timeline or a
synthetic user message.

Reminders append `session.wait.reminder` audit/UI events and publish live when
possible. They never create a prompt, internal update, workflow-wake outbox
revision, or inference. After downtime, reconciliation emits at most one due
reminder and advances directly to the first future interval, avoiding catch-up
storms. A due timeout wins over a reminder.

## `wait_until`: one durable timer

`wait_until` records one absolute RFC 3339 timestamp on the existing session.
The current model run stops after registering the wait. Temporal sleeps until
the stored deadline or a wake/control signal, then reconciles the row in
PostgreSQL. At most one `time_reached` occurrence becomes a runnable internal
update. Browser closure, worker replacement, workflow restart, and
`continueAsNew` do not change the deadline or require model polling.

## `wait_for_event`: authenticated idempotent ingress

`wait_for_event` matches:

- authenticated source identity;
- event `type`;
- `correlationKey`;
- optional `subject`.

Source identity is derived from the authenticated caller and stored on the
wait; neither the agent nor ingress JSON may impersonate another source. Event
ingress requires the workspace `events:ingest` permission and accepts the
versioned `DurableIngressEvent` contract.

Ingress deduplicates on `(workspace, authenticated source identity, eventId)`.
Replaying the same ID and canonical content returns the original result.
Reusing the ID with changed content returns HTTP 409. The first matching
waiting row is terminally settled with `event_received`; concurrent/duplicate
delivery cannot produce another internal update. An optional `timeoutAt`
settles `timed_out` through the same durable timer path. Without it, the wait is
indefinite.

## One-shot background jobs

`start_background_job` accepts a command, argument vector, optional working
directory, optional timeout, up to 32 artifact paths, metadata, and a request
key. Creation atomically writes the job, its linked durable wait, and an outbox
dispatch. The model run stops; no agent turn polls the command.

One stable Temporal workflow controls each job. Its activity may retry because
it observes an already-fenced provider command rather than replaying an agent
turn. The PostgreSQL start transition permits `startCount` to move from zero to
one only once:

- before provider creation, a controller may claim `start`;
- after the provider instance ID is durably attached, replacement controllers
  `reattach` and continue observing that same instance;
- if a job claims to be running but its durable provider reference is missing,
  or the provider reports that the instance disappeared, the terminal outcome
  is `lost`; OpenGeni never silently reruns it.

The current execution provider is Modal. It launches a durable supervisor as
the main process of a dedicated tagged Modal sandbox and persists the sandbox
ID before observation. The supervisor starts the user command exactly once in
a separate process group when supported, writes append-only stdout/stderr and
an atomic terminal-result manifest inside the sandbox, and remains alive after
the command exits. Replacement controllers reattach by sandbox ID and replay
deterministic log chunks from provider byte offsets without restarting the user
command. They collect declared artifacts while the supervisor is still live,
settle the database and object-store work, and only then terminate the provider.
An in-sandbox watchdog enforces the command timeout even while no controller is
attached. The data model and worker interface are provider-neutral, but no
non-Modal provider is currently supported.

Log chunks are idempotent by stream/provider offset and content hash. Observer
supersession is fenced by the latest background-job attempt. Declared artifacts
are hashed (SHA-256), stored through configured object storage, and exposed by
short-lived download URLs. If artifacts are produced without object storage,
or exceed its single-put limit, the job fails rather than claiming complete
output.

Cancellation is a durable request. The observer sees it, terminates the provider
instance, and settles `cancelled`. Timeout terminates the provider instance and
settles `failed` with a timeout error. For every terminal outcome—`completed`,
`failed`, `cancelled`, or `lost`—the source job/wait transition and one nested
`background_job_terminal` internal update commit atomically. Provider cleanup
runs after durable settlement.

## Public surfaces

### First-party MCP tools

The session-scoped first-party MCP server exposes:

- `ask_user`
- `wait_until`
- `wait_for_event`
- `start_background_job`

These creation tools require the signed agent command context for the current
turn. There is intentionally no unauthenticated or detached HTTP endpoint that
can forge a wait on behalf of a running attempt.

### HTTP API and SDK

The Hono route adapter is `apps/api/src/routes/durable-waits.ts`; matching SDK
methods live in `packages/sdk/src/client.ts`.

| Operation | Permission | HTTP route | SDK method |
| --- | --- | --- | --- |
| List/get session waits | `sessions:read` | `GET .../sessions/:sessionId/durable-waits[/:waitId]` | `listDurableWaits`, `getDurableWait` |
| Answer/cancel `ask_user` | `sessions:control` | `POST .../sessions/:sessionId/durable-waits/:waitId/resolve` | `resolveAskUser` |
| Ingest an event | `events:ingest` | `POST .../durable-events` | `ingestDurableEvent` |
| List/get jobs and logs/artifacts | `sessions:read` | `GET .../background-jobs/...` | `listBackgroundJobs`, `getBackgroundJob`, `listBackgroundJobLogs`, `listBackgroundJobArtifacts` |
| Create artifact download URL | `sessions:read` | `POST .../background-jobs/:jobId/artifacts/:artifactId/download-url` | `createBackgroundJobArtifactDownloadUrl` |
| Request job cancellation | `sessions:control` | `POST .../background-jobs/:jobId/cancel` | `cancelBackgroundJob` |

Session and job visibility is checked against the authenticated subject; an
invisible or cross-workspace object returns 404 rather than leaking existence.

### Web and React surfaces

`apps/web/src/components/session/durable-actions.tsx` renders durable state from
server reads and session-event refreshes. It provides typed question fields,
answer/cancel controls, passive wait status, background-job state and cancel,
focusable logs, and artifact download controls. The layout is responsive and
uses native labels/fieldsets, live status, alert roles, and keyboard-operable
buttons. Reloading reconstructs the surface from PostgreSQL-backed API reads;
browser state is never authoritative.

The client closure remains `contracts -> sdk -> react`; server implementation
types must not leak into published client packages.

## Tests and change checklist

When changing these primitives, preserve coverage for:

- exact request replay and changed-content conflict;
- generation/attempt fences and paused-branch controls;
- duplicate terminal signals and exactly one inference;
- timer/reminder reconstruction after restart and `continueAsNew`;
- authenticated event source isolation and duplicate-event replay;
- provider start once, reattach after observer/worker replacement, and `lost`
  without rerun when the provider disappears;
- cancel, timeout, byte-exact log cursors, artifacts, and terminal settlement;
- commit/signal and NATS-outage repair through the wake outbox;
- real PostgreSQL, Temporal, NATS, and provider execution in the appropriate
  integration/live tier;
- desktop/mobile, light/dark, keyboard-only, and accessibility browser evidence.

Canonical focused suites include:

- `packages/db/test/durable-waits-background-jobs.test.ts`
- `apps/worker/test/durable-waits.test.ts`
- `apps/worker/test/background-jobs.test.ts`
- `apps/api/test/durable-waits-mcp.test.ts`
- `apps/web/src/components/session/durable-actions.test.tsx`
- `test/integration/temporal-workflow.integration.ts`
- `test/integration/durable-queue-control.integration.ts`
