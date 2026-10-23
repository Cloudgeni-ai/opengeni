# Automations, event sources and MCP Events

Status: **Accepted** (2026-10-23). Supersedes the event-automation substrate in
[`docs/automations.md`](../automations.md) and the separate PR Review engine.

## Problem

Agents can act on a schedule, but they cannot react when something happens in
another app. Apps already announce changes through webhooks, and MCP servers can
now announce them through the MCP Events extension (SEP-3415, protocol revision
2026-07-28). Opengeni needs one way for "something happened" to start or wake
an agent reliably, without a second execution engine beside scheduled tasks.

## Concepts

- **Automation.** What runs, where, and when. An automation is today's
  scheduled task: its action (an agent turn), its destination (an existing
  chat, one reusable chat, or a new chat per run), its owner, audience and run
  policy. Its storage name stays `scheduled_tasks`; the product calls it an
  automation. Existing schedules keep working unchanged.
- **Trigger.** When an automation runs. An automation has at most one schedule
  (the existing `schedule` field) and any number of **event triggers**. Manual
  runs remain available on every automation.
- **Event source.** Something that delivers events into a workspace:
  - a **webhook endpoint** a person creates and pastes into another app (Linear,
    Sentry, or any sender that signs with Standard Webhooks);
  - an **app** Opengeni already connects to and receives events from directly
    (GitHub through the platform GitHub App, Slack through the Slack app, Gmail
    through a mailbox watch);
  - an **MCP connection** whose server offers the events extension.
- **Event.** One normalized occurrence: source, type, time, subject, actor,
  a one-line summary and bounded data. Every source produces the same shape.
- **Run.** One execution of an automation: an existing `scheduled_task_runs`
  row. An event run records the trigger and the events it carries.

An event trigger names a source, one or more event types, optional conditions
on event fields, and whether events made by Opengeni's own bots count. For an
MCP source the trigger also holds the subscription arguments the server's
`inputSchema` defines; those filter at the server, before delivery.

## Decisions

1. **Automations are scheduled tasks plus event triggers.** No new run path: an
   event run is a scheduled-task occurrence with `triggerType: "event"` that
   goes through the existing admission, account resolution, chat creation and
   blocker handling. A rename of internal identifiers is not part of this work;
   public routes and SDK methods keep their names and gain fields.
2. **Inheritance by default.** Runs never get a narrower tool, connector or
   access set than an ordinary run of the same automation. An existing-chat
   run uses that chat's settings and the owner's current accounts; a run that
   creates a chat uses the automation's creation settings, which default to the
   workspace defaults. Event triggers add no scoping of their own.
3. **One intake pipeline.** Every source writes a raw **delivery** (verified,
   deduplicated, stored) and then one or more normalized **events**. Receivers
   answer quickly; normalization failures are visible in the delivery log and
   can be replayed after an adapter fix.
4. **Matching happens when the event is stored.** In the same transaction,
   active triggers on that source are evaluated and matches are queued in the
   automation's **event inbox**. A dispatcher turns inbox rows into runs.
5. **Run policy.** Per automation:
   - *Batching*: the dispatcher waits about 3 seconds after the first pending
     event so a burst (a push with many commits, a bulk edit) becomes one run.
     Every pending event goes into that run's occurrence, oldest first.
   - *Overlap* keeps its existing meaning, because an event run is an ordinary
     occurrence: a run into an existing chat with `skip` needs that chat to be
     idle, and otherwise its update waits in the chat for the current turn;
     a new-chat-per-run automation starts a chat per batch.
   - *Storm guard*: at most `maxRunsPerHour` event runs in a rolling hour
     (default 30; schedules and manual runs never count). Further events wait
     in the inbox and arrive together in the next allowed run. The owner is
     told once, in the automation's chat, each time the guard engages.
   - *Once*: an automation can finish after its first run, whichever trigger
     fires first. "Wake me when X, or at 17:00 anyway" is one once-automation
     with an event trigger and a one-time (or manual) schedule. It is then
     exhausted like a spent one-time schedule and pauses itself.
6. **Loop protection.** Adapters mark events made by Opengeni's own identities
   (the GitHub App bot, the Slack bot). Triggers ignore them unless they opt in,
   as GitHub Actions ignores events made by a workflow's own token. Every event
   run records its trigger and events, so chains are visible. A hop limit waits
   for internal events, where causation is fully visible.
7. **MCP Events follows SEP-3415.** Details below. Opengeni is the client and
   the webhook receiver, like a gateway in the spec's forward-proxy topology.
8. **Ownership and visibility.** A webhook endpoint belongs to the person who
   created it and is private unless shared with the workspace. App sources
   follow the app connection: GitHub and Slack installations are workspace
   sources, a Gmail mailbox belongs to its owner. MCP subscriptions belong to
   the trigger's automation owner and use that owner's connection. A trigger can
   only use sources its automation owner can see.
9. **Retention.** Raw delivery bodies are kept 7 days, normalized events 30
   days, mainly so Opengeni does not keep copies of people's messages longer
   than debugging needs. A run keeps the bounded event summaries it delivered.
10. **Gating.** A deployment can turn event triggers off entirely. The agent
    tools and their bundled Skill are first-party tools, so embedders include or
    exclude them per session like every other first-party tool. Nothing about
    automations is added to the base system prompt.

## Intake

### Webhook endpoints

Every source that receives HTTP deliveries has an opaque, random ingress route
id, and its URL is `POST /v1/webhooks/events/:routeId`. The route table holds no
credentials; it selects the source, whose adapter and encrypted secret are read
before the body is parsed. Unknown routes, and every route while the deployment
has event triggers off, answer 404.

| Adapter | Verification | Event type | Dedupe key |
| --- | --- | --- | --- |
| `standard` | Standard Webhooks (`webhook-id`, `webhook-timestamp`, `webhook-signature` v1 HMAC, 5 minute window) | body `type` | `webhook-id` |
| `linear` | `Linear-Signature` hex HMAC-SHA256 of the raw body; `webhookTimestamp` within 60 s | `<type>.<action>` (for example `Issue.create`) | `Linear-Delivery` |
| `sentry` | `Sentry-Hook-Signature` hex HMAC-SHA256 with the client secret | `<Sentry-Hook-Resource>.<action>` | `Request-ID`, else body digest |

The secret is generated by Opengeni and shown once (Standard Webhooks), or
pasted from the provider (Linear, Sentry). Bodies over 1 MiB are rejected with
413. A delivery is acknowledged with 2xx only after it is stored. Rejected
deliveries (bad signature, stale timestamp) are logged without their body and
answer 401; a body the adapter cannot read is stored as `failed` and answers
400, so it can be replayed after an adapter fix. A disabled source stores the
delivery as `ignored`.

### Apps

- **GitHub**: `POST /v1/webhooks/github` for the platform GitHub App, verified
  with `X-Hub-Signature-256` and the App webhook secret, routed by installation
  to every workspace bound to it. Events: issues, issue and review comments,
  pull requests, reviews, pushes, check runs and suites, workflow runs,
  releases. The App's bot login marks own events.
- **Slack**: the existing Slack events receiver keeps its conversational
  behaviour and additionally records message, reaction and channel events for
  the bound workspace. The bot id marks own events.
- **Gmail**: a Pub/Sub push endpoint verified by Google's OIDC token. A mailbox
  with an active trigger keeps a `users.watch` (renewed daily); each
  notification reads `history.list` with the owner's connection and emits
  `message.received` events.

### MCP Events

- **Discovery.** A server supports events when `server/discover` advertises
  `io.modelcontextprotocol/events` under `capabilities.extensions` (the draft)
  or as a top-level `events` capability (an earlier shape some servers use).
  Opengeni declares the extension in its client capabilities. `events/list`
  results are cached per connection and refreshed when a trigger is edited and
  on every subscription refresh.
- **Subscriptions.** One subscription per (owner, connection, event name,
  canonical arguments), shared by every trigger that asks for the same thing.
  Each has its own row id, cursor, mode and status.
- **Mode.** Webhook when the event type offers it and the deployment has a
  public https origin; otherwise poll. Push is not used yet; event types that
  offer only push are shown as unavailable.
- **Webhook mode.** The callback URL is the subscription's own ingress route,
  `/v1/webhooks/events/:routeId`, so the receiver selects the secret from the
  path, including for the first `verification` envelope. Opengeni
  generates a `whsec_` secret (32 random bytes), suggests a 24 hour TTL and
  refreshes at 80% of the granted lifetime, always passing the last persisted
  cursor and `maxAgeMs` of 6 hours. Deliveries are verified over the raw body,
  deduplicated on `webhook-id` and on `eventId` within the subscription, and
  their cursor watermark is persisted. `gap` marks possible missed events;
  `terminated` ends the subscription. A delivery for a subscription Opengeni
  has ended answers 410, which the spec makes non-retryable; deleting a
  subscription also calls `events/unsubscribe`, and an unrefreshed one lapses at
  its TTL.
- **Poll mode.** A durable loop per subscription calls `events/poll` with the
  cursor and `maxEvents: 50`, drains immediately while `hasMore`, and otherwise
  waits `nextPollMs`, never less than 15 seconds and 60 seconds when the server
  gives none.
- **Requests** carry the `Mcp-Name` header with the event name and run as the
  owner through the shared MCP client with the owner's resolved credentials.
- **Termination.** `NotFound` or `Unsupported` with `schema_changed` re-lists
  and resubscribes when the event type still exists. `Forbidden` and failed
  credential resolution block the trigger and notify the owner, through the
  same blocker path schedules use.
- **Guarantees** are the spec's: at-least-once when the server's cursor is
  durable, per-subscription ordering for poll, best-effort ordering for webhook.
  Opengeni orders an inbox batch by event time and tells the agent when events
  may have been missed.

## Delivering events to the agent

An event run is a scheduled-task run with `triggerType: "event"` and producer
key `scheduled-task-event:<occurrenceId>`, started as the same Temporal fire
workflow with that key as its workflow id, so a retried start is one run. It
acts with the automation's own authority, like a scheduled fire.

Its `scheduled_occurrence` chat update carries an `events` field: the
occurrence id, how many events the batch accounts for, whether events may have
been missed before it, and the events themselves, oldest first. Each event keeps
its summary (type, time, subject, one-line summary, link, actor) and a data
excerpt of at most 2 KB; the whole field stays under 12 KB and under what is
left of the update's own bound. Events beyond that stay countable through
`eventCount` and readable through the API. An event whose stored copy already
expired is carried as its summary alone.

The database proves every scheduled occurrence update against its accepted
run. For event runs that proof also covers `events`: it must name the run's
own occurrence, with its count and gap flag, and each carried event must be the
occurrence's stored summary at the same position. Only the data excerpts beside
the summaries come from the worker.

How the update is rendered for the model, and the agent tools, are reviewed
separately as one change. The rendering is appended as a new input, never by
changing earlier context, so prompt caching is unaffected.

An agent can create automations for itself. "Wake me when X" from a chat is a
once-automation whose destination is that chat. While one is active, the chat
shows what it is waiting for.

## Surfaces

- **HTTP and SDK.** Scheduled task create and update take `events:
  { triggers, maxRunsPerHour?, once? }`; tasks return `events` with trigger
  status and the guard state, and runs return `eventOccurrence`. Event source
  routes under `/v1/workspaces/:workspaceId/event-sources` create, list, read,
  update, delete (refused while in use), rotate a secret, send a test event,
  list deliveries and replay one, list recent events, and list the event types a
  source offers. `clientConfig.eventTriggers.enabled` tells clients whether the
  deployment has them on (`OPENGENI_EVENT_TRIGGERS_ENABLED`, default off).
- **UI.** Schedules become Automations. The editor has a "When" section with a
  schedule and event triggers; each run shows the events that caused it.
  Event sources have a page with their endpoint, status and delivery log. Chats
  show when they are waiting for an event or a schedule.
- **Agent tools.** Reviewed separately, as one change.

## Old substrate

The `/v1/workspaces/:workspaceId/automations/*` routes, the
`/v1/webhooks/automations/:endpointId` ingress and `@opengeni/sdk/automations`
are deprecated under the API compatibility policy and removed in the next SDK
major. PR Review moves to an automation with a GitHub pull-request trigger.

## Delivery

1. This design.
2. Core: event sources, deliveries, events, triggers, inbox, dispatcher, run
   policy, API and SDK. Standard Webhooks, Linear and Sentry adapters.
3. MCP Events client, tested against a fake server that covers duplicates,
   ordering, expiry, gaps and termination.
4. GitHub, Slack and Gmail sources.
5. UI and the waiting state.
6. Agent tools and event rendering (model-facing, reviewed as one draft PR).
7. PR Review on automations; old substrate deprecated.
