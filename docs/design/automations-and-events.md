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
    (GitHub through the platform GitHub App, Slack through the Slack app), or
    reads changes from (Gmail, through the owner's Gmail connection);
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
     exhausted like a spent one-time schedule and pauses itself. Repeating
     event triggers work the other way round: they keep an automation running
     after its schedule's last run, so "on Friday at 9, and whenever X" still
     listens after Friday (migration 0951). A blocked run's owner notice says
     whether more runs follow by the same rule.
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
  with `X-Hub-Signature-256` and the App webhook secret.
  - A workspace has at most one GitHub source, shared with the workspace. It
    follows the workspace's GitHub connection: its routes, one per bound
    installation, are recomputed whenever a binding changes or the source is
    added again (which repairs lost routes).
  - The route table has no tenant RLS, so a GitHub route keeps no
    installation id: its key is an HMAC-SHA-256 of the installation under a
    route secret derived from the deployment's encryption key. A deployment
    without that key cannot add a GitHub source.
  - A route only names a candidate. Each delivery reaches a workspace only if
    the workspace is still bound to the installation and allowed the
    delivery's repository, the same check that gives its agents repository
    access. Deliveries about no repository are dropped.
  - Adding the source points an App without a webhook URL at this deployment.
    An App that sends its webhooks elsewhere is left alone, and the person is
    told what to change. New Apps get the webhook and their events from the
    manifest.
  - Types are `<X-GitHub-Event>.<action>`, or the event alone when it has no
    action (`push`). Data is a compact shape per event family, not GitHub's
    payload. Event types the App is not subscribed to are listed as
    unavailable, with what to change.
  - Events: issues, issue and review comments, pull requests, reviews, pushes,
    check runs and suites, workflow runs, releases. The logins of the
    deployment's own Apps (`<slug>[bot]`) mark own events.
- **Slack**: the existing Slack events receiver keeps its conversational
  behaviour and additionally records the callback for the workspace the Slack
  team is installed in, when that workspace has a Slack source. The receiver's
  installation routing already names that workspace, so the source needs no
  ingress route.
  - One Slack source per workspace, shared with the workspace like the channels
    the app is in.
  - Types: `message.posted` (messages and thread replies), `message.edited`,
    `message.deleted`, `reaction.added`, `member.joined_channel`,
    `member.left_channel`. Data carries the channel id and type, the Slack user
    id and the bounded text.
  - Direct messages with the app stay private: they and every other callback
    that is not an event are never stored. Mentions start a conversation; the
    message itself is still a `message.posted` event.
  - Own events are read from the callback itself (its `api_app_id` and the
    authorized bot user), so a stored delivery reads the same on replay.
  - Recording never affects the conversation: a failure is logged and the
    callback is handled as before.
- **Gmail**: one person's mailbox, read with the Gmail connection their chats
  use. Gmail only pushes changes through an operator-owned Pub/Sub topic, so
  instead of depending on that setup the source has a **feed**: Opengeni reads
  the mailbox history every minute while an automation listens.
  - A source is private to its owner and one per mailbox in a workspace.
    Adding it reads the Gmail profile to learn the address. Nothing is
    delivered, so it has no ingress route; the address stays on the source
    row, behind workspace RLS.
  - The feed keeps the history id as its cursor. Its first read only learns
    where "now" is. Each read lists `history.list` (new messages, `INBOX`)
    since the cursor and reads each new message's headers and snippet
    (`format=metadata`), never its body. When Gmail no longer has the history
    (about a week), the feed starts from now and marks the gap.
  - Type: `message.received`. Data: mailbox, message and thread ids, From
    (with a lower-case `from_address`), To, Cc, subject, snippet, label ids and
    date. Mail Opengeni's own Gmail tools wrote carries a Message-ID at
    `opengeni.invalid` and marks an own event.
  - The stored delivery body is the headers and snippets read, so a read
    replays the same. A large backlog is read 100 messages at a time.
- **Feeds in general.** A source whose app has no webhook Opengeni can receive
  gets one feed row (`event_source_feeds`): cursor, gap flag, next read, lease
  and failure state. One pump reads due feeds through a per-app adapter (read
  since the cursor, record, say when to read again; classify refusals). A feed
  is read only while a runnable automation listens to its source; otherwise it
  forgets its cursor and idles, and trigger, automation and source changes
  wake it. A refusal a person has to fix (a sign-in, a removed connector)
  blocks the source's triggers with a plain reason and tells each owner once;
  the feed retries every 15 minutes and the first good read unblocks them.
  Other failures back off and block after an hour. Adding another app of this
  kind is one adapter.

### MCP Events

- **Sources.** An MCP event source is one person's connection to an MCP
  server, so it is always private to that person and is created as them (a
  workspace API key alone gets 422). Creating it checks that the server
  advertises `io.modelcontextprotocol/events` under `capabilities.extensions`;
  a server without it, or one not added to the workspace, gets 422. The source
  pins the connection it was created with; without one it uses the first
  connection the owner can use for that server. Servers that sign in through
  the embedding app (host authority) cannot be used, because nobody is there
  to sign in when a subscription runs.
- **Discovery.** Opengeni declares the extension in its client capabilities.
  `events/list` is read in pages (at most 20 pages, 500 types) and cached for
  10 minutes per source. The source's event-types endpoint always reads it
  fresh. The cache is dropped when the server says a type is gone, its schema
  changed, or a delivery mode is not supported.
- **Triggers.** An MCP trigger names exactly one event type and may carry
  arguments, which are validated against the type's `inputSchema` when the
  automation is saved. A type that is missing, or that offers only modes this
  deployment cannot use, is rejected with a plain reason. If the server cannot
  be reached while saving, a trigger is accepted only when the automation
  already listens on the same stream, so edits to other fields still work.
- **Streams and subscriptions.** A stream is an event name plus canonical
  arguments; its key is the SHA-256 of both. Triggers and stored events carry
  their stream key, so an event fires only the triggers of its own stream,
  never one with other arguments. Every distinct stream a source's runnable
  automations ask for is one row in `mcp_event_subscriptions`, shared by every
  trigger that asks for the same thing. The row owns the cursor, the mode, the
  webhook route and secret, the server's subscription id and the failure
  state. Saving, pausing, resuming or deleting an automation syncs the rows and
  wakes them; a row no runnable automation wants is unsubscribed and removed.
- **The pump.** The API runs a pump every 5 seconds that claims due rows with a
  5 minute lease (up to 32 per pass, 8 at a time, more passes while full
  batches come back) and runs one step for each.
- **Mode.** Webhook when the event type offers it and the deployment has a
  public https origin and an encryption key; otherwise poll. If the server
  can't reach the webhook address or refuses webhook delivery, the step falls
  back to polling at once when the type offers it, and polling then sticks.
  Push needs a held-open connection per subscription, which Opengeni does not
  keep; types that offer only push are shown as unavailable.
- **Webhook mode.** The callback URL is the subscription's own ingress route,
  `/v1/webhooks/events/:routeId`, so the receiver selects the secret from the
  path, including for the first `verification` envelope. Opengeni
  generates a `whsec_` secret (32 random bytes), suggests a 24 hour TTL and
  refreshes at 80% of the granted lifetime (at least a minute apart), always
  passing the last persisted cursor and `maxAgeMs` of 6 hours. The
  verification envelope is answered with its challenge, and the subscription
  id in its header is recorded. Deliveries are verified over the raw body,
  deduplicated on `webhook-id` and on `eventId` within the stream, and their
  cursor watermark is persisted. `gap` marks the next stored event as possibly
  preceded by missed ones. `terminated` is logged and wakes the subscription,
  which subscribes again or blocks its triggers if the server refuses. A
  delivery for a subscription Opengeni has ended, or one whose id no longer
  matches, is answered 410, which the spec makes non-retryable. Removing a
  subscription also calls `events/unsubscribe`, and an unrefreshed one lapses at
  its TTL.
- **Poll mode.** A durable loop per subscription calls `events/poll` with the
  cursor and `maxEvents: 50`, drains immediately while `hasMore`, and otherwise
  waits `nextPollMs`, never less than 15 seconds and 60 seconds when the server
  gives none (at most an hour). The first poll has no cursor and only learns
  where "now" is, so an automation never fires on old events. Each page with
  events is one logged delivery, so it can be replayed. `truncated` marks a gap
  the same way a webhook `gap` does.
- **Requests** carry the `Mcp-Name` header with the event name and run as the
  owner through the shared MCP client with the owner's resolved credentials
  (base64 sentinel form for names that are not plain ASCII). A 401 refreshes
  the credential and retries once.
- **Failures.** `Unsupported` with `schema_changed` starts the stream over from
  "now" and marks a gap. Problems a person has to fix block the stream's
  triggers with a plain reason and post one notice to the owner in the chat
  the automation last ran in, like the storm guard's: the type is gone,
  `Forbidden`, rejected arguments, the server no longer offers events, the
  connection needs reconnecting, or the server can't reach the webhook. A
  blocked stream is retried every 15 minutes and unblocks itself (withdrawing
  the notice) once a step succeeds. Other errors retry with backoff from 30
  seconds up to 15 minutes and block only after an hour of failing.
- **Guarantees** are the spec's: at-least-once when the server's cursor is
  durable, per-subscription ordering for poll, best-effort ordering for webhook.
  Opengeni orders an inbox batch by event time and tells the agent when events
  may have been missed.
- **Servers built for ChatGPT** follow the extension's earlier design sketch,
  which ChatGPT implements. They work the same way, over webhooks only. Three
  differences matter to a client:
  - They advertise a top-level `events` capability instead of the
    `extensions` entry. The MCP client keeps only capabilities it knows, so a
    server without the entry is asked `events/list`; one that answers offers
    events.
  - They number their errors -32011 to -32015 instead of -32023 to -32027.
    Both numberings are read the same way.
  - Their `webhook-id` is the event's `eventId`, which deduplication already
    covers.

  Over HTTP an unknown method can come back as a 404 carrying the JSON-RPC
  error. The error in the body decides, so a server that stops offering events
  blocks its triggers instead of retrying quietly.

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
shows what it is waiting for. Such a wait belongs to the chat: archiving the
chat with Pause removes the one-time waits that continue it or its sub-chats
(a run-once event automation that has not run, a one-time run still ahead) in
the same transaction, and Restore does not bring them back. Repeating
automations stay; a run of theirs that meets the paused chat is blocked and
the owner is told. Hide for me changes nothing for the chat's waits.

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
- **Embeddable panel.** `AutomationsPanel` from `@opengeni/react/automations`
  is a drop-in list, page and form for a workspace's automations or one chat's,
  for hosts that embed chats. It takes the host's `OpenGeniClient`. In a chat,
  new automations continue that chat with its settings; otherwise each run
  starts a new chat with the workspace's defaults and the owner's access, so
  nothing is scoped down. `eventServers` offers the host's own MCP servers
  before the person has an event source for them (the source is added on first
  use), and `argumentDefaults` fills subscription arguments such as the
  project the chat belongs to. MCP subscription arguments are edited as fields
  generated from the event's JSON Schema, with JSON as the fallback. The web
  app's form and the panel share the "When" field and the automation model.
- **Agent tools.** Reviewed separately, as one change.

## Old substrate

The `/v1/workspaces/:workspaceId/automations/*` routes, the
`/v1/webhooks/automations/:endpointId` ingress and `@opengeni/sdk/automations`
are deprecated under the API compatibility policy and removed in the next SDK
major. PR Review moves to an automation with a GitHub pull-request trigger.

- **Deprecation.** Those routes and the PR Review management routes
  (`/pr-review/registrations`, `/pr-review/repositories`, `/pr-review/github`)
  are in `DEPRECATED_ROUTES`, deprecated on 2026-10-24 with a Sunset of
  2027-01-25. `@opengeni/sdk/automations` and `@opengeni/sdk/pr-review` are
  marked `@deprecated`. The old behaviour keeps working until removal.
- **PR Review as an automation.** The "Review new pull requests" template
  listens on the GitHub source for `pull_request.opened` and
  `pull_request.ready_for_review`, skips drafts with a `data.pull_request.draft`
  condition, and carries the review instructions as its message. A run opens
  only the repositories added to the message, so the form says so when a
  GitHub trigger has none. The run reviews and posts with the deployment's
  GitHub App, like any chat with those repositories.
- **Existing setups are not migrated.** They used the separate Opengeni Lens
  App, so moving them would need the deployment's GitHub App installed on the
  same repositories, which only the installer can do. Where event triggers are
  on, Plugins offers the automation instead of a new Lens setup and still shows
  an existing setup, with a notice, until it is retired.

## Rollout

- **Flag.** Event triggers stay off until `OPENGENI_EVENT_TRIGGERS_ENABLED` is
  set. Schedules, the Automations pages and the embeddable panel work either
  way; with the flag off, "When" offers only a schedule, and nothing polls,
  subscribes or accepts deliveries for triggers.
- **Database grants.** The runtime calls the dispatcher's security-definer
  functions and writes `event_ingress_routes`. Those grants follow the
  two-release rule in `docs/migrations-expand-contract.md`: 0937 withholds
  them, and 0947 grants them once a release containing 0937 is the previous
  production release. Until 0947 has run, the event paths fail for lack of
  privilege, so turn the flag on only in a deployment whose release includes
  0947 and whose previous release included 0937. The retention pass runs
  regardless of the flag and skips quietly until then.

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
