<!-- docs-refs: record -->

> **Point-in-time design and execution record.** Written against OpenGeni commit
> `65419ef9` plus its uncommitted OPE-18/OPE-22 worktree on 2026-07-13, Codex CLI
> `0.144.3` / upstream tag `rust-v0.144.3` at
> `78ad6e6bfd1d3b6a209acd3ef82172a96b25179c`, and the production fleet then
> serving `21e21cb209b26627a78d7177f01b9793dc1e6001`. Paths and names may move. The
> shipped code and canonical current-tier docs win after this cutover.

# OpenGeni session control-plane clean cutover

Status: accepted implementation plan, pending code review and production proof  
Scope: prompt queue, steer, session/workspace pause, current-inference recovery,
internal updates, goals, compaction, timeline UI, worker deploy continuity, and
removal of superseded runtime paths.

## 1. Required outcome

OpenGeni will have one small, truthful control model:

- **Send** (Enter) adds a prompt to the end of the waiting prompt queue.
- **Steer** (Cmd/Ctrl+Enter) adds a prompt to the front and interrupts the current
  inference, if one is actually running.
- **Pause** is the only session stop-like control. **Resume** is its inverse.
- The visible queue contains only prompts that a person explicitly submitted and
  that have not begun inference.
- Goals, schedules, child-agent results, runtime notices, recovery, and compaction
  never masquerade as queued prompts.
- Recovery resumes the same current inference. Compaction continues the same
  inference. Neither creates a new logical turn or sandbox.
- The queue is rendered once, immediately above the composer, in exactly the order
  persisted by the server. Goal and agent pills remain compact siblings in that
  composer stack, outside the queue.
- Codex compaction uses one portable plaintext implementation derived from the
  official Codex 0.144.3 local compaction path. It works across independently
  authenticated Codex subscriptions without a bridge, account pin, or fallback.
- A production deploy pauses admission, drains current work to durable checkpoints,
  replaces the old runtime in one direction, wakes all claimable work, and proves
  the fate of every session that was live before the drain.
- The release contains no runtime compatibility mode, legacy adapter, dual queue,
  old Temporal branch, or reversible data conversion.

This is a clean refactor and a one-way cutover. Git and database backups remain
ordinary disaster-recovery tools; they do not justify retaining old behavior in the
application.

## 2. Terms used in the product and code

| Term | Exact meaning |
| --- | --- |
| Prompt queue | Human-submitted prompts waiting to start inference. |
| Current inference | The one logical turn that has started, including a temporarily recovering or capacity-waiting attempt. It is not in the queue. |
| Send | Append a prompt to the queue and wake the session if runnable. |
| Steer | Put a prompt first and cancel/supersede the current inference. If none is running, it is simply a front insertion plus wake. |
| Pause | Make the session ineligible to infer and interrupt current model/tool work. Waiting prompts remain waiting. |
| Resume | Make a paused session eligible again and continue its interrupted current inference before claiming queued prompts. |
| Internal update | Durable typed information produced by schedules, subagents, runtime events, or other platform work. It is not a prompt queue entry. |
| Recovery attempt | A new worker attempt for the same current inference after worker death, deploy drain, or infrastructure preemption. |
| Compaction | Model-generated compression of active history inside the same inference loop. |
| Late event | Output from an attempt that no longer owns the inference. It is preserved as inert diagnostic evidence and cannot change live state. |

Do not use `item` as a vague user-facing synonym. Say prompt, current inference,
update, goal, agent, or event.

## 3. Evidence and root causes

### 3.1 Why the broken session repeatedly showed “Sandbox ready”

`apps/worker/src/activities/agent-turn.ts` creates a lazy sandbox provisioner for an
agent-turn activity. The first sandbox operation in that activity emits
`sandbox.operation.started(name=sandbox.provision)` and a completion. The React
timeline projects that completion as “Sandbox ready” when the establishment origin is
missing; it renders more specific “created”, “restored”, or “reattached” labels only
when an origin was supplied.

The event is real activity evidence, not invented UI decoration. A read-only production
query on 2026-07-13 proved the abnormal count was runtime behavior, not projection
duplication. Session `1b5c0ea8-9a24-4352-8b9a-313cfbb303af` contained 260
`sandbox.provision` starts, 258 completions, and two failures. Only one completion said
`origin=resumed`; 257 had no origin. One durable turn,
`712cba9e-c1d0-4b6f-b063-3e6aebd1edc2`, was started 100 times, compacted 99 times,
preempted 99 times, and provisioned 100 times between 09:58 and 11:41 Europe/Stockholm.
Across the session, 119 stored turns produced 292 `turn.started` and 207
`session.context.compacted` events.

The same logical work was dispatched as repeated agent-turn activities around
compaction/requeue/recovery. Every activity obtained its own lazy provisioner and
therefore emitted another provision lifecycle. Compaction should instead remain inside
the existing activity and inference loop, so it should not instantiate another
provisioner or emit another sandbox lifecycle.

There is also a presentation ambiguity: a successful `sandbox.provision` event without
an origin cannot tell a newly created sandbox from a reattached existing sandbox. The
fix must improve the event identity and origin, not suppress evidence. Repository clone
and file-download successes are separate idempotent setup noise and can remain folded;
failures remain visible.

Required proof:

1. Give every provisioning lifecycle a durable operation/attempt identifier and always
   record its origin (`created`, `restored`, or `resumed`) on success.
2. Correlate each event to logical turn, dispatch generation, worker attempt, sandbox
   group, lease epoch, and sandbox instance without exposing credentials.
3. Project each real lifecycle exactly once; never synthesize or hide it.
4. A normal multi-call turn that compacts one or more times emits at most the lifecycle
   caused by actual sandbox establishment/reattachment, not one per compaction.
5. A real recovery attempt may show a new reattachment. A real replacement box may show
   restored/created. A stale attempt’s late lifecycle remains under late diagnostics.

### 3.2 Why compaction/requeue could repeat roughly once per minute

The current branch mixes three concepts that must be separate:

- a durable user turn;
- an execution attempt of that turn;
- queue work that has not started.

Compaction and recovery were represented through control/requeue paths that could end
one activity and make the workflow claim work again. Worker/activity retry timing and
the wake/reconciliation loop then made the same logical work appear eligible at regular
intervals. Each re-dispatch rebuilt turn-scoped machinery, including lazy sandbox
provisioning. Compaction did not sufficiently reduce the history on some paths, so the
new activity crossed the threshold again and repeated the cycle. Stale attempts could
also continue publishing because lifecycle settlement and streaming publication did not
share one authoritative attempt fence.

The fix is structural: compaction is an inner-loop operation; recovery owns the existing
turn; only unstarted submitted prompts are queued; and every authoritative mutation is
conditioned on one dispatch generation/attempt ownership check. A timer may retry a
failed transport or wake capacity work, but it can never turn compaction/recovery into a
new prompt or new logical turn.

The exact production loop was:

```text
turn.started
→ sandbox.provision and setup
→ context overflow
→ deterministic fallback compaction
→ session.context.compacted
→ turn.preempted(reason=context_compacted)
→ requeue the same turn
→ workflow claims it again
```

For the 99-cycle turn, the first fallback reported 484,314 estimated tokens before and
23,091 after. Each following attempt again estimated roughly 273k–559k before while the
reported post-compaction size increased by about 87 tokens per cycle, ending at 31,617.
The “resume after compaction” user-role notice and a new activity rebuilt enough input to
overflow again. The in-activity attempt counter reset on every re-dispatch.

Commit `f8592075` (`fix(agent): align Codex compaction and stop recovery churn`) was
created at 11:47 Europe/Stockholm—six minutes after that 99-cycle turn finally ended—and
added a cross-dispatch post-compaction progress guard. That mitigation should stop this
specific increasing-token loop after the next cycle. It does not make the architecture
correct: successful compaction still deliberately emits `turn.preempted`, changes the
session to queued, installs a fake resume trigger, ends the activity, and reclaims the
turn. This clean refactor removes that mechanism instead of relying on the guard.

### 3.3 Why the interrupted screenshot kept producing output

The second investigated production session,
`14cfc256-881e-43fd-8d99-0ec1be89537b`, was not resumed or mutated during this audit. A
new user turn `3cdbe086-f50f-47a8-90f8-178be55c77d9` started at 13:07:36
Europe/Stockholm. Production recorded `user.interrupt` at 13:07:48 and authoritatively
cancelled the turn at 13:07:49. Nevertheless, the old worker kept publishing reasoning,
tool, usage, and message events through 13:08:35—about 46 seconds after cancellation.
The session is now idle with no active or queued turn; the sandbox reaper terminated its
box at 13:38.

So the screenshot captured a real zombie-publish race: the control plane considered the
turn interrupted while a stale attempt could still append apparently live events. The
right fix is not to hide those events. Section 5 makes them durable rejected-late
diagnostics while preventing them from entering authoritative history or live output.

### 3.4 Why the old compaction assumption can lose memory on account rotation

Exact Codex 0.144.3 remote compaction v2 sends structured history plus a
`CompactionTrigger` through the normal Responses stream and receives exactly one
`ResponseItem::Compaction`. That item has encrypted content but no plaintext summary.
The serde alias `compaction_summary` names the item type; it is not a `summary` field.

OpenGeni’s current cross-account sanitizer deletes `encrypted_content` while preserving
a fabricated `summary` field in tests. Against the real protocol this leaves an empty
husk. After remote compaction, assistant/tool/reasoning memory lives only in the opaque
account-bound blob, so rotating to another independently authenticated subscription can
silently remove the compressed memory.

Credential affinity cannot repair this: once the blob exists, the session is effectively
pinned to the account that is most likely to be exhausted. A bridge would require one
more full-context call on that exhausted account, and a plaintext shadow would create a
second compaction truth forever. All are rejected.

### 3.5 Exact Codex 0.144.3 baseline

For the currently selected Codex model metadata:

- raw context window: **272,000 tokens**;
- usable context window: **258,400 tokens** (95%);
- automatic compaction threshold: **244,800 tokens** (90% of raw);
- RemoteCompactionV2: stable and default enabled in stock Codex when the provider
  supports remote compaction;
- official local compaction: shipped Codex path used for providers without that remote
  premise;
- local retained real-user-message budget: **20,000 tokens**, cumulative from newest;
- remote-v2 retained user/developer/system-message budget: 64,000 tokens, plus one
  opaque compaction item.

OpenGeni follows the official local path because cross-subscription portability violates
the premise of remote v2, not because the local algorithm is a preferred custom design.
Model metadata remains versioned/resolved; the 272k/258.4k/244.8k values must be proven
for the configured current Codex model rather than copied blindly to unrelated models.

## 4. Locked product semantics

### 4.1 Prompt queue

The database stores one kind of waiting row: `prompt`. Provenance (user ID, API caller,
schedule-created dedicated session, and so on) may be audit metadata but cannot create
priority lanes or different ordering semantics.

- Enter appends after all waiting prompts.
- Cmd/Ctrl+Enter inserts before all waiting prompts.
- Several steers during cancellation naturally appear newest first because each new
  steer is inserted at the head.
- A steer with no current inference still inserts first and wakes; it does not emit a
  fake interrupt.
- A steer while a previous cancellation is settling inserts first and does not fail just
  because the old cancellation has not acknowledged yet.
- A steer during tool approval cancels/supersedes that current inference. A later
  approval submission against the cancelled inference receives a conflict.
- A paused session accepts Send and Steer, but no inference runs until explicit Resume.
  Send only appends. Steer durably supersedes the old current inference and inserts at
  the head, so Resume runs the steered prompt first.
- Queued prompts can be deleted. They cannot be edited, reprioritized, promoted,
  “sent now” through another endpoint, assigned deadlines, or reordered arbitrarily.
- A delete racing the claim uses queue-version and row-version comparison and reports
  that the prompt already started when the claim won.

One server ordering key is authoritative. Under the locked session row, append advances
the monotonic bigint tail counter and steer advances the monotonic bigint head counter.
There is no renormalization path. SDK and React return/render the server array verbatim;
no client comparator exists.

### 4.2 Current inference and recovery

One session has at most one current inference. Its durable turn can be:

- `running`: a worker attempt owns it;
- `requires_action`: waiting for a tool approval decision;
- `recovering`: no worker owns it, but the same turn is eligible for a bounded recovery
  attempt;
- `waiting_capacity`: the same turn is waiting for a Codex subscription lease/reset;
- terminal: completed, failed, cancelled, or superseded.

`recovering` and `waiting_capacity` are not queue statuses. When runnable, recovery of the
current inference is claimed before a queued prompt. Steer supersedes the current
inference in every nonterminal form—running, requires action, recovering, or waiting for
capacity—whether the session is active or paused. On a paused session supersession is a
durable-only transaction and all work stays inert; Resume then finds no recoverable old
inference and claims the steered prompt first.

`waiting_capacity` keeps the same turn nonterminal. The durable capacity-waiter row and
revisioned wake signal remain the timer/wake mechanism, now fencing this turn instead of
settling it. Steer superseding a capacity-waiting inference clears its waiter in the same
fenced transaction.

Worker shutdown, rollout drain, activity loss, and retry never fabricate a user message.
If interruption occurred during a tool call, the resumed model history closes that call
with a typed interrupted tool result whose side-effect outcome is explicitly unknown.
The raw SDK call is captured at the stream boundary in a turn-lineage durable ledger.
The attempt and execution generation remain evidence of where the call originated,
while the receipt survives a `requires_action` approval boundary and can be settled
by the next fenced attempt of that same logical turn;
it is never reconstructed from `session_events`, because that UI/audit projection is
redacted and lossy. A normal result clears the ledger only after the SDK call/result pair
is durable in conversation history. Pause, Steer, exact worker death, and other
attempt-ending transactions consume remaining ledger rows atomically with their state
transition, while late results remain rejected-attempt evidence. Model-facing payloads
receive only database-safety text repair; event redaction is a separate operation and
must never change replay truth. Other recovery facts enter the model as one
system/developer-role input assembled per attempt. It is never user-role, never persisted
as conversation truth, and excluded from compaction retention. The same facts are
recorded as timeline/audit events. Recovery instructions require the agent to inspect
durable side effects before repeating an operation whose outcome is uncertain.

### 4.3 Session Pause and Resume

The public session control state is exactly `active | paused`.

Pause:

1. changes control state to paused and increments its control generation;
2. records the interrupt intent for a running attempt atomically;
3. cancels active model streaming and tool execution where cancellation is supported;
4. checkpoints durable progress and transitions that running turn to recovering-but-
   ineligible under pause;
5. pauses an active goal for this session;
6. leaves waiting prompts and internal updates untouched and inert.

Pause does not interrupt, cancel, or convert a `requires_action` turn because its worker
activity has already completed; the saved approval state is its suspended form. It stays
`requires_action` and ineligible. An approval decision submitted while paused is durably
accepted and held inert; Resume dispatches it. Steer supersedes an approval-waiting
inference, paused or active, and a later approval decision then receives a conflict.

Resume:

1. is the only operation that changes a paused session back to active;
2. resumes the goal only when this session Pause caused that goal pause;
3. wakes the same recoverable current inference first;
4. then permits normal prompt/update/goal claims.

There is no separate public Stop, Interrupt, Kill, or Abort mode. Cancellation remains an
internal mechanism used to implement Pause and Steer; it is not a second lifecycle the
user must understand.

### 4.4 Workspace Pause with explicit session execution

A workspace has `active | paused` plus a monotonically increasing pause generation.
Sessions do not get mass-rewritten when the workspace changes state.

The one runnable predicate is:

```text
session is active
AND (workspace is active OR session.run_exception_generation == workspace.pause_generation)
AND claimable work exists
```

An operator can explicitly run a chosen active session while the workspace remains
paused. This stamps that session with an exception for the current pause generation. A
new workspace Pause increments the generation and invalidates every old exception with
no fan-out cleanup. Session Pause always wins. Workspace Pause can optionally exclude
specified sessions atomically, so preserving an incident/debug session does not first
interrupt and then restart it.

Workspace Pause applies the same suspend semantics as session Pause to every non-exempt
session with a live attempt: it records per-session interrupt intent, cancels model/tool
streaming, checkpoints, and transitions the current inference to recovering-ineligible.
Delivery is chunked and does not rewrite session control state. Sessions in the atomic
exception list are not interrupted.

Remove `workspace_killed`, `control_state_before_workspace_kill`, global resume gates,
workspace fan-out rewrites of session control state, and kill terminology.

### 4.5 Internal updates, subagents, and schedules

Typed durable update rows hold child-agent completions, scheduled fires for a reusable
session, runtime notices that require model attention, and similar machine-produced
context. They are never prompt queue rows.

- Updates deduplicate by `(workspace, session, dedupe_key)`.
- All pending updates attach transactionally to the next fresh inference as one
  structured bundle and are marked delivered in that same claim.
- If the session is idle and no human prompt is waiting, pending updates may create at
  most one synthesized continuation inference for the entire session, regardless of how
  many updates arrived.
- Additional updates coalesce into the same pending bundle rather than creating twenty
  sequential machine turns.
- Updates wait for the next fresh inference; they are never injected into a live
  inference. Important failure/action-required state is visible in the UI immediately.
- If a human prompt is waiting, that prompt claims first and carries the update bundle.
- Dedicated-session schedules can still create/run their dedicated session under that
  session’s policy. Reusable-session schedule notifications use the update plane.
- Scheduled deadlines and automatic queue promotion are out of scope. FIFO/head-steer
  behavior is sufficient.

### 4.6 Goals

Goal continuation is a reason to start an inference, not a queued prompt. When the
session is active and has no current inference:

1. recover current inference if present;
2. claim the head human prompt if present;
3. otherwise start one update/goal continuation when eligible.

Updates and an eligible goal share one continuation where possible. Goal guards compute
outside the short claim transaction; the transaction revalidates goal version, empty
human queue, no current inference, and update state. A steady flow of human prompts may
delay goal continuation; that is accepted product behavior, not “starvation” machinery
to solve with hidden priority.

The goal pill and agents pill remain compact controls above the composer, outside the
queue.

## 5. Attempt ownership and late-event evidence

Every current inference has a dispatch generation. Every worker attempt has a unique
attempt ID and must present both values when it mutates authoritative state.

- Claim, model output persistence, tool state, approval state, lifecycle settlement,
  compaction replacement, and authoritative event publication all compare ownership.
- Atomic settlement updates the turn, session, generation/fence, and claimability in one
  database transaction.
- A lifecycle settlement that lost ownership is an event-free no-op.
- A streaming write from a superseded attempt is accepted only as
  `turn.event.rejected_late` diagnostic evidence. It includes the original event type,
  turn/attempt/generation identifiers, and rejection reason, but cannot mutate history,
  current inference, queue, goal, session status, sandbox pointer, or live UI state.
- The UI exposes late diagnostics inside the affected turn/attempt’s expandable debug
  details. It never relabels them as authoritative output and never hides them.

This retains the “zombie publish” observability that revealed OPE-22 while removing the
race that allowed zombie output to become truth.

## 6. Compaction algorithm

### 6.1 One implementation

Delete the current `auto/server/client/off` ladder, server `context_management` route,
rendered-transcript summarizer, hard-trim second pass, deterministic non-model fallback,
and any persistence/sanitizer branch that expects a portable remote `compaction` item.

Implement the official Codex 0.144.3 local algorithm as the sole OpenGeni compaction
path for Codex subscriptions, OpenAI API-key models, and registry providers that use
this agent runtime:

1. Resolve raw/effective/auto-compact limits from the selected model snapshot.
2. Check before the first model call and after each sampling response.
3. At threshold, send the exact versioned Codex `SUMMARIZATION_PROMPT` as synthesized
   user input through the normal inference transport using the real structured history,
   base instructions, and an empty tool list—not a rendered transcript. Codex local
   compaction constructs this prompt with `Prompt::default()`, whose tools are empty;
   compaction cannot call tools or spend context on tool definitions.
4. If summarization itself exceeds context, remove the oldest history entry and retry as
   Codex does. Normal bounded transport retry and subscription rotation apply.
5. Take the last assistant message as the plaintext summary.
6. Retain newest real user messages up to a cumulative 20,000-token budget, with Codex’s
   boundary truncation semantics.
7. Append one plaintext user history row containing exact `SUMMARY_PREFIX` plus the
   summary.
8. For mid-turn compaction, re-inject canonical initial context before the last real user
   message so the summary remains last, matching Codex’s `BeforeLastUserMessage` shape.
   Pre-turn/manual compaction defers that injection.
9. Continue the same inference loop, turn, dispatch generation, worker activity, sandbox
   provisioner, and usage chain.

The summarization call obtains credentials through the standard Codex allocator. If the
previous account is exhausted, another connected subscription may compact because the
input and output are portable plaintext after foreign reasoning items are stripped.

### 6.2 Persistence

Compaction replacement is one transaction:

- verify attempt/generation ownership when invoked mid-turn;
- verify the replacement strictly shrinks estimated active history;
- mark superseded history rows inactive, never delete them;
- insert retained real-user rows and one plaintext summary row marked
  `opengeni_context_summary=true`;
- update last-input/token estimates;
- append one `session.context.compacted` timeline event;
- record one usage entry for the summarization call.

No `ResponseItem::Compaction` row may be written. A compaction-typed stream item is a loud
reconciliation error. The cutover asserts that no active such rows exist.

### 6.3 Failure behavior

- Transport failures use the same bounded retry/backoff as normal model sampling.
- Subscription capacity/auth failures use existing allocator rotation, quarantine, and
  durable waiters.
- Replacement writes only after successful summarization and strict shrink.
- Permanent failure or no-shrink leaves old history authoritative, records a truthful
  retryable/failure event, and settles the session without creating queue work.
- The next requested inference can retry because the threshold remains exceeded.
- With an active goal, this settlement counts toward the existing goal no-progress
  streak and uses its normal continuation hold/backpressure pacing. Persistent
  compaction failure visibly auto-pauses the goal at that existing limit. Without an
  active goal, the session idles until explicit input.
- There is no deterministic substitute, emergency hard truncation, remote-compaction
  bridge, or hidden account-affinity fallback.

### 6.4 Manual compact

- During an active inference, a durable manual-compact flag forces compaction at the next
  safe sampling boundary inside that inference.
- While idle, manual compact runs as a born-running `source="compaction"` execution on
  the existing turn ledger. It is not a conversational turn and never appears in the
  prompt queue, but the execution row gives allocation, attempt fencing, recovery, and
  settlement one authoritative owner. It records the same event/usage/persistence
  artifacts as active-turn compaction without creating tools or a sandbox.
- If active history is empty or the generated checkpoint is not strictly smaller, the
  exact attempt atomically records `session.context.compaction.skipped` with the reason
  and consumes the operator request without changing history.
- While paused, the request remains pending and inert until Resume.

## 7. Data model and removal list

### 7.1 Target data concepts

- Session control state and control generation.
- Workspace control state and pause generation.
- Per-session workspace run-exception generation.
- Submitted prompt queue row with one server order and versions for delete/claim CAS.
- Current durable turn plus dispatch generation and attempt ownership.
- One durable pending-cancellation intent per session (Steer or Pause), written
  atomically with its control, honored by claim, and cleared only by fenced settlement
  or claim-path reconciliation.
- Pending typed update rows plus one synthesized-continuation uniqueness guard.
- Active/inactive structured history rows, including plaintext context-summary marker.
- Attempt-scoped authoritative and rejected-late events.

One shared runnable-predicate module is used by claim, wake, Send/Steer admission,
workspace Resume/exception wake selection, repair scan, and UI state. Duplicated boolean
implementations are forbidden.

### 7.2 Delete in the same release

- Priority, promoted, deadline, lane, arbitrary reorder, queue edit, and send-now APIs,
  columns, contracts, helpers, tests, and UI.
- Queue kinds/rows for goal continuation, update bundles, schedules, recovery,
  compaction, runtime notices, and other machine work.
- `steer_target_turn_id`, turn-level `delivery_state`, and the settle-blocked-turn plus
  enqueue-one-goal-continuation capacity-return path. Head insertion, turn status, and
  the fenced current inference replace them.
- Old `/turns/:id` queue mutation adapters and old queue endpoint aliases.
- Separate public Stop/Interrupt/Kill operations and UI labels.
- `workspace_killed`, previous-control-state restoration, and global resume-gate logic.
- `runAgentSegment` and any workflow/activity path superseded by the single current-
  inference loop.
- Temporal `patched()` compatibility branches and old activity aliases after the drained
  workflows are terminated.
- Remote compaction mode selection, encrypted-compaction sanitizer preservation, fake
  compaction summary tests, rendered transcript compaction, hard trim, and deterministic
  fallback.
- Queue copies in the right Run rail, timeline queued-turn pills, and client sorting.
- Fake resume user messages and fake compaction/requeue notices.
- Private-ops `legacy|durable_v1` manifests, reverse conversion, rollback job, staging
  gate for this release, and any runtime switch that can re-enable old semantics.
- Stale Codex client version `0.144.1`; pin/update to exact latest stable `0.144.3` with
  source provenance and tests.

Before deletion, inspect every caller and migrate it to the target concept. “Delete” does
not mean drop useful behavior such as durable queue order, atomic settlement, capacity
waiters, audit rows, sandbox lifecycle evidence, or goal guards.

## 8. UI/UX end state

Immediately above the composer, render one compact vertical control stack:

1. collapsible prompt queue, only when nonempty;
2. compact goal pill, when a goal exists;
3. compact agent pill, when child agents exist;
4. composer.

The collapsed queue shows count and a short head preview. Expanded rows show prompt text,
submitted time/provenance when useful, and Delete. They do not show priority, machine
kind, promotion, model override, or duplicate lifecycle controls. The queue component
uses server order without sorting.

The composer has Send/Steer affordances and one Pause/Resume button:

- Enter = Send;
- Cmd/Ctrl+Enter = Steer;
- paused state changes the control to Resume and clearly marks queued prompts inert;
- workspace-paused state explains why the session will not run and offers explicit
  “Run this session” only to callers already allowed to control that workspace;
- no Stop vs Interrupt terminology choice is exposed.

The right rail may show current inference/attempt diagnostics and finished-turn history,
but never another queue. The timeline may show the submitted user message when it begins
and real session/sandbox/recovery events, but never a waiting-queue duplicate.

“Sandbox ready” is replaced by precise created/restored/reattached wording when the event
provides origin. Unknown origin is displayed honestly as “Sandbox available (origin
unknown)” with debug detail; it is not hidden. Repeated real recoveries remain visible.

## 9. Claim and control ordering

For an active, workspace-eligible session, one transaction chooses work in this order:

1. recover the nonterminal current inference;
2. claim the first submitted prompt;
3. start one combined update/goal continuation if eligible;
4. otherwise remain idle.

Pause eligibility is checked before all four. A pending control cancellation must settle
or be reconciled by the claim path before a new attempt owns the same current inference.
No deadline, machine lane, role lane, or invisible promotion can reorder the visible
prompt queue.

## 10. Clean production cutover

The user explicitly requires production-only deployment validation for this release.
Staging is not deployed or used. Local deterministic tests and read-only production
inspection remain mandatory. Model calls use only already-connected Codex subscriptions;
Azure infrastructure access is allowed, but Azure model-token use is prohibited.

### 10.1 Preflight

1. Reconcile the implementation branch with current public `main` and preserve unrelated
   user work.
2. Make public and private ops trees clean; no untracked cutover scripts.
3. Pass all static, unit, integration, migration, contract, UI, and release-workflow tests.
4. Run UBS and targeted manual review of ownership, SQL locking, migrations, history
   compaction, and secret handling.
5. Complete at least one more serialized Fable plan review and one implementation review
   using the existing durable Fable session.
6. Merge the reviewed public implementation to `main`; pin the exact public revision in
   the private production workflow.
7. Produce a preflight report with image digests, migration checksum, expected schema,
   production namespace/context, and proof that no Azure model endpoint is configured for
   the validation calls.
8. Assert that the `@openai/agents` SDK serialization version is identical before and
   after the cutover. Saved `requires_action` RunState is version-bound; an SDK upgrade is
   not part of this release, and a mismatch aborts before maintenance rather than adding
   a compatibility path.

### 10.2 Capture the continuity baseline

In one consistent production snapshot, record nonsecret identifiers and versions for:

- every session currently running, requiring action, recovering/preempted,
  waiting-capacity, or containing queued prompts;
- current turn ID, dispatch generation, attempt, queue order, control state, goal state,
  update count, and workspace pause generation/exception;
- worker/activity ownership and Temporal workflow/run identifiers;
- active history digest/count and last authoritative event;
- sandbox group/lease/instance identity and lifecycle origin;
- connected Codex credential IDs and allocator state without tokens.

Store the report durably in the private release evidence location. Do not print secrets.

### 10.3 Maintenance cutover sequence

1. Enable a single production maintenance/admission gate that rejects new Send/Steer/
   Resume/manual-compact/goal-start claims with a truthful retry response while leaving
   reads available.
2. Pause Temporal Schedules and signal workers to gracefully preempt active inferences.
   Stop new claims. Permit each activity up to the existing 120-second termination grace
   to checkpoint and release ownership. The migration's fail-closed unknown-row check
   catches anything written during the drain window.
3. Verify no activity still owns a current inference. Any non-acknowledging attempt is
   marked recovering under its generation fence; its late writes remain diagnostic only.
4. Terminate the drained old `session-*` Temporal workflow executions. Postgres durable
   state is the recovery truth; no old workflow history may require removed activity or
   `patched()` code. This is also the hard history boundary for replacing the prior
   queue-named Temporal activity type with `claimNextSessionExecution`: activity type
   strings are recorded in workflow history, so the new worker registers only the new
   name after every history containing the prior name is terminated. No alias, dual
   registration, or compatibility branch is shipped.
5. Scale the old worker fleet to zero and prove no old public revision remains able to
   claim work.
6. Apply one-way schema/data migration:
   - convert legitimate unstarted human queue rows to the single prompt queue/order;
   - convert active/requeued execution attempts to current inference + recovering state;
   - move pending machine queue data to typed update rows or goal state;
   - preserve order, IDs, events, inactive history, attempts, approvals, and audit data;
   - establish workspace pause generations/exceptions;
   - assert no active remote-compaction rows and no unclassified legacy queue row;
   - drop old columns, constraints, enums, and tables after the assertions pass.
7. Deploy API/web/worker code containing only the new semantics and exact public revision.
8. Start fresh Temporal workflows from Postgres truth and run one generalized wake-repair
   scan covering current recoveries, queued prompts, pending updates, active goals, and
   capacity waiters.
9. Remove maintenance admission and resume Temporal Schedules only after health, schema,
   version, and claim-invariant checks pass.

There is no automated reverse migration. If a catastrophic infrastructure problem occurs
before destructive migration, stop before step 6. After step 6, restore the reviewed
database backup and matching Git/image revision as a disaster recovery action; do not
ship dormant old runtime behavior “just in case.”

### 10.4 Production verification

Use a bounded canary workspace/session backed by the existing connected Codex
subscriptions. Do not connect a new subscription and do not call an Azure model.

Verify:

- Enter appends in server/UI order.
- Cmd/Ctrl+Enter head-inserts and interrupts current inference.
- repeated steer during cancellation is accepted and newest-first.
- Pause interrupts and prevents every claim source. Send while paused stays inert and
  Resume continues the same inference before the appended prompt. Steer while paused
  durably supersedes that inference and stays inert; Resume runs the steered prompt first.
- workspace Pause blocks sessions; explicit run exception works; another workspace Pause
  invalidates it; session Pause still wins.
- queue is visible exactly once above composer; goal/agents are compact and separate.
- child/schedule/runtime updates coalesce into one delivery and never appear as queue rows.
- active goal plus pending updates uses one continuation after human prompts.
- compaction triggers at the expected model threshold, shrinks history, stays in the same
  turn/activity/sandbox, and creates no queue row or fake message.
- plaintext compaction survives rotation from connected account A to B and recalls a
  unique canary fact.
- foreign account-bound reasoning is stripped as a whole; no encrypted compaction husk
  survives.
- one bounded negative control documents rejection of foreign encrypted reasoning; an
  optional one-time remote-compaction blob replay may document account binding but is not
  a product dependency.
- worker restart/deploy recovery continues the same durable current inference and closes
  interrupted tool calls truthfully.
- stale-attempt output appears only as rejected-late diagnostics.
- real sandbox lifecycle events have operation identity/origin and no compaction-induced
  duplicates.

Finally join the pre-cutover baseline to post-cutover truth. Every previously live
session must be exactly one of:

- resumed and now running;
- completed/failed/cancelled after an authoritative post-cutover attempt;
- idle after preserving completed checkpoint state;
- still paused because it was paused before cutover;
- truthfully waiting for approval, capacity, or explicit user input;
- queued in exactly its prior relative order.

No session may disappear, duplicate its current inference, lose queued prompts, acquire a
new fake user message, regress its goal, or remain owned by the old revision.

## 11. Verification matrix before production

### Database and concurrency

- Queue purity/schema constraints and one server order.
- Append/head-insert/delete/claim races under session-row lock.
- Steer + atomic cancellation; second steer while fence open.
- Steer supersedes recovering and capacity-waiting current inference, including atomic
  capacity-waiter cleanup.
- Pause vs claim, Resume vs claim, approval vs steer, delete vs claim.
- Pause during `requires_action` preserves the approval state and holds a submitted
  decision inert until Resume.
- Workspace generation exceptions, new-pause invalidation, and interruption of a live
  non-exempt session attempt.
- Exactly one current inference and one owning attempt.
- Atomic settlement and late-event non-authority.
- Exactly-once update delivery and at-most-one update continuation.
- Goal/update co-claim and human-first ordering.
- One-way legacy data classification with fail-closed unknown rows.

### Compaction

- Golden tests against Codex 0.144.3 local history construction, prompt/prefix constants,
  20k retention, boundary truncation, initial-context placement, and overflow retry.
- 272k raw / 258.4k effective / 244.8k auto threshold resolution for current Codex model.
- pre-turn, mid-turn, repeated multi-call, manual active, and manual idle cases.
- strict-shrink transaction, no mutation on failure, usage/event persistence.
- persistent compaction failure under an active goal obeys no-progress pacing and
  visibly auto-pauses at the existing limit.
- active-turn compaction creates no new turn, activity, sandbox, or queue/control side
  effect; idle manual compaction creates exactly one born-running non-conversational
  execution ledger row, no prompt row, and no tools or sandbox.
- rejection of remote `compaction` items at every write path.
- cross-account history sanitizer drops foreign reasoning whole and preserves plaintext
  summary/user history.

### Worker and deployment

- graceful preemption within termination grace and same-turn redispatch.
- tool-call interrupted result and uncertain-side-effect recovery context.
- generalized wake repair for every claim source.
- old Temporal workflows cannot execute after code deletion.
- private workflow enforces one public revision, one migration checksum, maintenance
  ordering, baseline/final reconciliation, and Azure-model-token prohibition.
- no `legacy`, `durable_v1`, reverse-conversion, or staging-evidence branch remains.

### UI

- one queue render site and no client sort.
- keyboard behavior, paused behavior, delete race, compact/expanded accessibility.
- goal/agent stack layout and no right-rail/timeline queue duplicates.
- current/recovering/approval/capacity states are not rendered as queued.
- sandbox origin/attempt details and visible rejected-late diagnostics.

## 12. Implementation work packages

Each package ends with tests and deletion of the superseded code; no package introduces a
temporary runtime fallback.

1. **Reconcile branch and preserve good OPE-22 foundations**: merge current `main`, audit
   dirty queue-removal work, retain atomic settlement/generation/capacity/audit fixes.
2. **Schema and state model**: new prompt/current/update/workspace-generation concepts,
   shared runnable predicate, one-way migration, removal of legacy schema.
3. **Send/Steer/Pause/Resume APIs**: one transaction per control, delete-only queue,
   remove aliases and alternate mutation APIs.
4. **Worker claim loop**: rename the complete domain/activity operation to
   `claimNextSessionExecution`; current inference recovery first, then prompt, then combined
   update/goal continuation; no machine queue work.
5. **Attempt ownership and recovery**: generation/attempt fences, interrupted tool result,
   rejected-late diagnostics, graceful deploy checkpoint.
6. **Codex 0.144.3 compaction**: official local semantics, allocator integration,
   transactional history replacement, removal of all alternate paths.
7. **Workspace control**: pause generation, explicit per-session run, removal of kill and
   fan-out state rewriting.
8. **React/SDK cleanup**: one composer queue, exact server order, compact goal/agents,
   one Pause control, precise sandbox lifecycle UI.
9. **Private ops clean cutover**: replace the dirty legacy rollback workflow/scripts with
   maintenance drain, baseline, one-way migration, wake repair, and final reconciliation.
10. **Review and production proof**: Fable implementation review, UBS, complete local
    matrix, merge, production cutover, bounded subscription canary, all-session audit.
11. **Canonical docs and cleanup**: update current-tier lifecycle, deployment, SDK, and
    rotation docs; archive incident evidence; verify no obsolete symbol/string/path remains.

## 13. Linear reconciliation

Update existing OpenGeni issues rather than creating duplicates:

- **OPE-18** becomes the umbrella for this accepted queue/control/update architecture;
  remove old priority, typed machine queue, and staging-first requirements.
- **OPE-9** tracks the single composer queue UI and delete-only prompt interaction; remove
  edit/reorder/send-now requirements.
- **OPE-21** tracks portable official-local compaction and subscription-rotation proof.
- **OPE-25** tracks the production-only one-way maintenance cutover and full session
  continuity reconciliation; remove permanent expand/contract/rollback and staging gate.
- **OPE-6** tracks compact goal presentation and continuation outside the queue.
- Link archived **OPE-22** as the incident/evidence source for zombie settlement and retain
  its atomic settlement fixes.

Later user decisions in this record supersede contradictory older issue descriptions.

## 14. Definition of done

The work is not finished until all of the following are true:

- target semantics and constraints are implemented in public main;
- superseded runtime/schema/API/UI/Temporal/private-ops paths are deleted;
- local deterministic verification passes with no skipped relevant suite;
- repeated serialized Fable review reports no unresolved correctness issue;
- existing Linear issues describe the accepted end state;
- the exact reviewed revision is deployed to production with no staging deployment;
- no Azure model tokens were used;
- production canary verifies queue, steer, pause, workspace exception, updates/goals,
  recovery, compaction, rotation, UI, sandbox evidence, and late diagnostics;
- every pre-cutover live session has a reconciled post-cutover fate;
- all production workloads are healthy and only the new revision can claim work;
- canonical current-tier docs match the shipped system;
- repository and ops worktrees are clean and no legacy identifiers remain in runtime
  searches.
