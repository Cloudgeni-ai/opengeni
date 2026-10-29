# Opengeni's own events as automation triggers

Status: **Accepted** (2026-10-29; proposed 2026-10-26). Built in migration
1105. Extends the "This workspace" source in
[Automations, event sources and MCP Events](automations-and-events.md) and
settles the chain (hop) limit that its decision 6 deferred.

## Problem

Automations can react to GitHub, Slack, Gmail, webhooks, MCP servers and
meeting recordings, but not to what happens in Opengeni itself: a chat
finished, failed or is waiting for an approval, or a usage limit was reached.
People and agents want exactly those: "tell me when any of my automations'
chats fails", "when the research chat finishes, continue here", "when usage
passes 80%, post a summary of who used what". Today an agent can only wait for
another chat inside its own turn (`session_wait`, at most 50 seconds) or poll.

Opengeni already publishes these facts to outbound workspace webhooks
(`WORKSPACE_WEBHOOK_EVENT_TYPES`), so the vocabulary exists. What is missing is
a way for them to reach the event intake, rules for who may see them, and a
limit on chains of automations that wake each other.

## Decisions

1. **One vocabulary.** Trigger event types are the outbound webhook types, by
   the same names. A type is added once, to the contract list, and then
   exists for webhooks and triggers alike. The trigger catalog is keyed by that
   list with explicit exclusions, so a new type is a conscious decision.
2. **Same source.** They arrive through the existing "This workspace" source,
   which already reads meeting recording facts for its owner. No new source
   kind, route or setup step.
3. **A small facts table, read by the existing feed.** A database trigger on
   `session_events` copies each fact of an offered type into
   `workspace_activity_events` for workspaces where someone listens; the
   "This workspace" feed reads that table next to `recording_events`.
   Matching, batching, the storm guard and delivery stay exactly as they are.
4. **Visibility is the owner's.** The feed reads as the source's owner, under
   row security that uses the same chat visibility check as everything else, so
   a trigger only ever sees chats and usage its owner may see.
5. **Causation is exact.** Each fact records the automation run that caused
   it, if any. Events caused by automation runs count as Opengeni's own
   (ignored unless a trigger opts in), and every event run gets a chain depth.
   A run deeper than 3 is not started.
6. **No new model-facing instructions.** Agents find the new types through the
   event-type catalog they already read; tool descriptions and the rendering of
   events into the run do not change.

## Event types

| Type | Plain meaning | Offered |
| --- | --- | --- |
| `turn.completed` | A chat finished its work | Yes |
| `turn.failed` | A chat stopped with an error | Yes |
| `turn.cancelled` | Someone stopped a chat | Yes |
| `session.requiresAction` | A chat is waiting for a tool approval | Yes |
| `session.humanInput.requested` | A chat asked a person a question | Yes |
| `session.notification.posted` | An agent sent someone a notification | Yes |
| `session.notification.withdrawn` | An agent withdrew a notification | No: only bookkeeping |
| `session.status.changed` | A chat's status changed | No: too frequent, covered by the turn types |
| `usage.threshold_reached` | Usage passed a configured threshold | Yes |
| `usage.exhausted` | A usage limit was used up | Yes |
| `usage.period_reset` | A new usage period started | Yes |
| `recording.*` | Meeting recording facts | Yes, as today |

`turn.superseded` (a turn handed over to a Steer) is not an outcome, so it is
not offered; the turn that takes over ends with one of the three turn types.

## How events enter the pipeline

```text
session_events insert ──trigger──▶ workspace_activity_events ◀──┐
usage allowance lifecycle ──────▶ workspace_activity_events     │ read every 15 s as the owner
recording lifecycle ────────────▶ recording_events ◀────────────┤
                                                                 │
                         "This workspace" feed (one per person) ─┘
                                   │ normalize, record delivery + events, match
                                   ▼
                     event inbox ─▶ dispatcher ─▶ automation run
```

- **Facts table.** `workspace_activity_events` holds one row per fact:
  account, workspace, the session event id (or usage notice id) as its id,
  type, occurred time, session, turn, the subject the turn ran for, the
  causing automation and run, chain depth, and a bounded `data` (the fields
  below, each cut to its stated length; the table refuses `data` over 8 KB).
  An `AFTER INSERT` trigger on `session_events`, whose `WHEN` clause keeps to
  the offered types and non-duplicate events like the webhook fanout
  triggers, writes it. Usage facts come from an `AFTER INSERT` trigger on the
  usage allowance notices, the rows the usage webhooks are produced from:
  threshold `-1` is `usage.period_reset`; reaching the limit is both
  `usage.exhausted` and `usage.threshold_reached`, as for webhooks. A failure
  to write is a warning and never aborts the transaction that caused it. Both
  triggers and their functions run with the caller's rights.
- **Written once someone listens.** A chat fact is written only while the
  workspace has an active "This workspace" source; otherwise the function
  stops after one indexed lookup. Nothing is lost by this: a new source's
  first read only learns where "now" is, so no fact from before it existed
  would ever be delivered. Rows are kept 24 hours by the event intake
  retention pass (the feed looks back 10 minutes; the normalized copies
  follow the usual 30-day event retention). Usage facts, a handful per
  period, are always written. A deployment with event triggers off has no
  "This workspace" sources, so it writes no chat facts; one that turns them
  off later keeps writing for existing sources, removed after 24 hours.
- **Cost.** The `WHEN` clause is the whole cost for every other event type:
  no measurable difference on streamed events. A turn end pays about 9 µs
  for the source lookup, and about 0.17 ms when a fact is written, on top of
  about 0.86 ms the existing triggers already take
  (`packages/db/test/workspace-activity-events.benchmark.md`).
- **The feed.** The existing "This workspace" feed reads both fact tables in
  one step, every 15 seconds while an automation listens, looking back 10
  minutes and skipping facts it already stored, exactly as it does for
  recordings today. One read with new facts is one delivery whose body is the
  facts read (`{ recordingEvents, activityEvents }`, each activity fact with
  the chat title, automation name, member label and chat address the owner
  saw), so a replay produces the same events, chain depth included. Each
  table is read up to 100 facts a step; when either is full, the next step
  continues from the earlier of the two last facts read.

## Who may see them

The feed reads as the source's owner, and row security on
`workspace_activity_events` decides what that person sees:

- **Chat events:** visible when the owner may see the chat
  (`session_reference_visible`, the check chat history and search already
  use): their own chats and chats shared with the workspace. Another person's
  private chat never reaches their triggers.
- **Usage events:** a workspace-wide threshold is visible to workspace
  administrators; a member's own threshold is visible to that member.
- **Recordings:** unchanged.

As before, a trigger can only use sources its automation's owner can see, and
a run acts with the automation's own authority. Seeing an event grants
nothing: a run that reads the chat behind it uses the ordinary chat tools with
the ordinary checks.

## What counts as Opengeni's own

Decision 6 of the main design ignores events made by Opengeni's own
identities unless a trigger opts in. For internal events Opengeni knows the
cause exactly, so the rule is precise:

- An event is Opengeni's own (`actor.kind: "opengeni"`, `actor.name`: the
  automation's name) when an automation run caused it: the turn is an
  automation run, or the chat was started by an agent inside an automation
  run's turn (followed through `sessions.parent_turn_id`, at most eight chats
  up). A later turn Opengeni itself started in an automation's chat (not a
  person's message there) belongs to that automation too, through the run the
  chat was created for. An event without a turn is a notice Opengeni posted
  itself, so it is Opengeni's own with depth 0.
- Everything a person started, including chats their agent started for them
  during their own turn, is theirs (`actor.kind: "person"`, their name).
- Usage events have no actor (`actor.kind: "unknown"`).

So "wake me when the chat my agent started finishes" works without opting in,
while an automation that reacts to other automations' chats opts in with the
existing "Also run for what Opengeni does" switch, and the chain limit below
applies. The form shows that switch only for GitHub and Slack today; it is
shown for "This workspace" too (recording events already mark an agent's
saved notes as Opengeni's own, but the form gives no way to opt in).

## Chain limit

- An event has a **chain depth**: the depth of the automation run that caused
  it, or 0 when no run did. Events from other apps are 0, since causation
  through GitHub or Slack cannot be traced; their loops are already covered by
  the bot rule and the storm guard.
- A run's depth is one more than the deepest event it carries. Scheduled and
  manual runs are depth 1. A `BEFORE INSERT` trigger on event runs fills it
  from the events their occurrence carries.
- **Limit: 3**, the same three levels GitHub allows for chained
  `workflow_run` workflows. When the dispatcher builds a run, events that would
  make it deeper than 3 are left out of it, before the storm guard counts
  anything, and marked `skipped` in the inbox; if none remain, no run starts.
  The run history shows a skipped run with reason `chain_limit` (an admission
  refusal, retryable, never started), so a loop is visible rather than
  silent; blocker review leaves these runs out, since the automation itself
  is fine. The owner is told once per automation each time the limit engages
  (when the automation's latest run is not already such a skipped run),
  through the same notice path as the storm guard, in the automation's chat.
- `inbound_events` and `scheduled_task_runs` each gain a `chain_depth`
  column (small integer, default 0 and 1). Nothing else changes for external
  sources.

The limit is a deployment setting (`OPENGENI_AUTOMATION_MAX_CHAIN_DEPTH`,
default 3, 1 to 100), not a per-automation option: it exists to stop
accidents, not to be tuned.

## What an automation receives

The same normalized event every source produces, rendered exactly as today.
For chat events:

- `subject`: the chat's title. `summary`: for example `Chat finished: Weekly
  report`, `Chat failed: Weekly report`, `Waiting for approval: Weekly report`.
- `url`: the chat's address in the console.
- `actor`: as described above.
- `data.sessionId`, `data.turnId`, `data.chatTitle`.
- `data.startedByYou`: true when the turn ran for the source's owner (their
  own message, their agent, or their own automation), like `recordedByYou`
  for meetings, so two people using one template each follow their own chats.
- `data.automationId` and `data.automationRunId` when a run caused it.
- Per type: `turn.completed` carries `data.answerExcerpt` (the first 1,000
  characters of the final answer); `turn.failed` carries `data.error` (code
  and a short message); `turn.cancelled` carries `data.reason`;
  `session.requiresAction` carries `data.tools` (names waiting for approval,
  at most 10); `session.humanInput.requested` carries `data.questions` (at
  most 5 prompts, 300 characters each); `session.notification.posted` carries
  `data.title`, `data.bodyExcerpt` and `data.forYou`.

For usage events: `data.scope` (`workspace` or `member`), `data.forYou`,
`data.threshold`, `data.usedCredits`, `data.limitCredits`, `data.period` and
`data.periodEnd`; the summary names whose limit ("Usage reached 80% of the
workspace's limit").

An agent reads more with the tools it already has: the chat's history with
`session_events`, usage with the usage tools.

## Model-facing parts and prompt caching

No tool description, schema or system prompt changes. Agents see the new types
in the event-type catalog that `event_sources_list` and the automation tools
already return, and events arrive in the run's scheduled occurrence update,
rendered by the existing pure function after earlier context. Nothing already
sent changes, so prompt caching is unaffected. The catalog's new descriptions
and the new template's instructions are model-visible text, so they are
reviewed with the implementation before merging. The catalog keeps the
recording entries' text and order; the new types come before them, in the
webhook list's order.

## Surfaces and templates

- The trigger picker groups the "This workspace" types under Chats, Usage and
  Meetings, with the plain meanings above.
- One new built-in template, **When an automation fails**: listens for
  `turn.failed` with Opengeni's own events included, `data.automationRunId`
  present and `data.startedByYou` true, and asks the agent to read the failed
  chat, say what went wrong in two sentences and notify the owner.
- "Wake me when" from a chat (a once-automation that continues the chat) can
  now name another chat: `turn.completed` or `turn.failed` where
  `data.sessionId` is that chat. This needs no new surface: it is an ordinary
  condition on the event's data.

## Alternatives considered

- **Reading `session_events` directly in the feed.** It would need a new
  workspace-wide index on the largest and busiest table, and visibility and
  causation would be recomputed on every read. Rejected.
- **Writing facts whether or not anyone listens.** Proposed first, to spare a
  lookup. Measured, the lookup costs about 9 µs once per turn end and nothing
  for other events, while always writing costs a row per turn end in every
  workspace. A source's first read only learns where "now" is, so writing
  only while someone listens loses nothing. Replaced by the listening rule.
- **Feeding the intake straight from the database trigger.** Matching lives in
  TypeScript; duplicating it in SQL would split one rule set in two. Rejected.
- **Looping back through outbound workspace webhooks.** Needs a public
  address and signing for a call to itself, and loses visibility and
  causation. Rejected.

## Rollout and tests

One PR: the migration (facts table with row security, the `session_events`
trigger, usage facts, the two `chain_depth` columns), the feed and normalizer,
the catalog, depth propagation and the limit in the dispatcher, the notice,
the picker grouping, the template, and docs.

PostgreSQL tests prove: a person's private chat never reaches another
person's trigger while a shared chat does; an automation's own chat events
are ignored unless the trigger opts in; a chat an agent started during a
person's turn counts as the person's; depth propagates through two
automations and the third hop past the limit is skipped with one notice;
usage facts reach administrators for workspace limits and only the member for
their own; replaying a delivery produces the same events; nothing is written
while nobody listens, and a fact that can't be written never fails the
chat's event; facts go after 24 hours.

## Later

- Goal events (`goal.completed`, `goal.paused`) and an `automation.run.blocked`
  type, added to the contract list for webhooks and triggers together.
- Outbound webhooks could read the same facts table instead of their own
  per-endpoint triggers, making it the one internal event log.
- A database notification could wake the feed instead of the 15-second read
  when lower latency matters.
