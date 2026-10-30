# Billing origin: app use and API use

Every accepted turn records who pays for it. **App** use is paid from the
monthly plan credit first (then promotional grants and credits, as described
in [subscription-plans.md](subscription-plans.md)). **API** use is paid from
credits only: top-ups and operator credit grants, which already carry the
credit margin (`marginBps`, default 500). Plan credit and promotional credit
never pay for API use.

The origin is a funding decision only. It never grants or narrows access.

## Which work is which

| Origin | Work |
| --- | --- |
| app | A person signed in to Opengeni's web, desktop or mobile apps (canonical managed or local human session, including approved native app credentials). Slack and Teams bots, schedules and automations, published Sites and their viewers, voice. |
| api | Organization and configured API keys, personal API keys, products on the SDK acting for their people (delegated tokens), outside agents over MCP (organization MCP sign-in or keys), external actors, and service initiators. Any person credential that is not a verified Opengeni app session. |

Sub-agents and tools run under an internal `agent_attempt` credential. They
inherit the origin of the chat they run in, never the credential's.

## Where it is decided and stored

- `session_turns.billing_origin` is frozen when a turn is accepted
  (`resolveTurnBillingOrigin` in `packages/core/src/billing-origin.ts`). Order:
  an in-process entry point's explicit origin (Slack, Teams, Sites); an origin
  a trusted dispatcher stamped for the request; the turn an agent attempt runs
  in; the entry point's surface; the credential (`billingOriginForGrant`).
  The column is immutable (`55000` on change).
- A turn inserted without an origin (continuations, compaction, machine turns,
  writers from the previous release) inherits it in the database: a schedule
  run takes its task's origin; otherwise the chat's latest decided origin; for
  a chat's first turn, the parent chat's. Nothing to inherit stays null, which
  is billed as app (today's behaviour).
- `scheduled_tasks.billing_origin` is the origin of whoever set the task up.
  Once an API caller edits a task, runs it by hand, or fires it with an event
  source's test event or a replayed delivery, it is API from then on
  (`markScheduledTaskApiBilled`, and in the delivery's own transaction for
  events), so a key cannot spend plan credit through a schedule or automation
  set up in the app. The pause endpoints leave it alone (a status change
  through an ordinary update counts as an edit), and a task is never turned
  back into app. A manual run is checked at the edge as API when the caller or
  the task is API (`manualScheduledTaskTriggerBillingOrigin`). If a manual run
  fails to start after the mark commits, the task stays API. The origin is
  billing, not execution: it is excluded from a task's execution digest and
  never advances a personal-resource task's authority revision.
- `event_sources.secret_billing_origin` is `api` once an API caller set or
  received a webhook source's signing secret: created the source with one
  (a standard webhook's generated secret is in the create response), rotated
  it, or pasted one with `PATCH`. A custom webhook's `format`, which says how
  deliveries are verified and read, counts the same: an API caller creating
  or changing it marks the source, and so does an API caller creating a
  Linear, Sentry or Tailscale preset source before its secret is pasted. The
  agent tools `event_sources_create_webhook` and `event_sources_update` resolve
  the caller's origin like the routes: an outside agent, or one in an API
  chat, marks the source; an agent in a chat started in the app doesn't. Every
  signature scheme's secret is set this way, including a `url_token` secret
  (the one the app puts in the address as `?token=<secret>`) and an `ed25519`
  app's public key. A public key can't sign, but whoever pastes it chooses
  which signer the source trusts, so it counts as a secret write. The mark is
  written in the same statement as the secret or format, and never turned
  back, even when a person later rotates or pastes a secret. Whoever holds the
  secret can sign deliveries to the public URL,
  so the intake records every delivery it verifies for such a source as API
  (`receiveEventWebhook`), which marks the automations it fires API use in
  the delivery's own transaction, exactly as an API caller's test event or
  replay does. That covers automations added to the source later and has no
  window between marking and the new secret: the secret and its holder are
  read from one row. A person's own secrets leave the source alone, and
  CloudGeni's legacy account stays app (`fundedBillingOrigin` at intake).
  A custom format can't read its event type, delivery id or an event id part
  from the header its signature is in (compared without case), which would
  put the signature, or a `token` scheme's secret itself, into events and the
  delivery log; create and `PATCH` refuse such a format, and intake reads that
  header as absent for one stored before the refusal.
  A `url_token` secret travels in the address, which no format reads and
  intake never keeps. So that it can't be read back from what is kept either,
  intake drops any header whose value contains the secret (a proxy's copy of
  the address, for example) before the format reads ids from it, replaces
  each copy of the secret in the kept body with `[secret]` (an app echoing
  the address it posts to), and never uses an id holding the secret as the
  delivery's dedupe key. The kept size and digest describe the kept body.
- The same mark covers a workspace MCP source that listens to a server by
  URL (`kind: "mcp"` with `url`): whoever names the URL chooses the server
  that sends its events, so an API caller creating one marks it. Its
  subscriptions read the mark in each delivery's transaction, polled or
  delivered to their callback (`recordMcpEventDelivery`), and the automations
  those events fire are API use, CloudGeni's legacy account excepted.
  Creating a source that already exists returns it unchanged and marks
  nothing.
  The match is on the raw secret, byte for byte, and only for secrets of at
  least 24 characters (every `url_token` secret), so a short HMAC or token
  secret that happens to occur in ordinary values doesn't redact them; an
  escaped or encoded copy of a non-`url_token` secret isn't caught.
- `credit_ledger_entries.usage_origin` records the origin each usage debit was
  charged under. The debit writers resolve it from the explicit input, the
  attribution metadata, the turn, then the ambient request scope.

## Balances

`BillingBalance.creditsMicros` is general credit minus this month's
unrestricted plan allowance: what API use may spend. It goes negative when a
running API call settles past it, exactly like general debt today; the next
top-up repays it first.

Plan credit never repays that API debt. `BillingBalance.apiDebtMicros` is the
negative part of credits, up to what API work has spent; app admission and
plan allocation add it back, so app use keeps the whole allowance. The
database applies the same rule with
`opengeni_private.plan_app_general_balance`: period expiry removes the whole
unused allowance and leaves the API debt as credit debt, and a new period's
opening debt nets only older app debt. Debt is attributed to API use up to the
API's lifetime spend, which can count a later app overrun as API debt when the
account once paid for API use; that errs towards keeping plan credit.

`plan_period_usage` ignores `usage_origin = 'api'` debits (and refunds of
them), so API use never consumes the monthly allowance, and
`expire_refunded_plan_credit` never treats a refunded API debit as unspent
plan credit.

## Enforcement

All admission points take the origin: session create, post-message and retry
(`requireLimit`), the worker's run and between-call checks, model calls,
web search, image and video generation, and schedules. API work with no
credits is refused with HTTP 402, code `api_credits_required`, the message
"API usage uses credits, not your plan credit." and an Add credits action
(`details.action = { type: "add_credits", href: "/billing" }`).

Machine work outside a request takes the origin it is funded under:
goal continuations and Resume read the chat's origin (its latest decided turn,
else the parent chat's), schedule runs their task's, sandbox leases, their
heartbeat fence and knowledge indexing their billing record's. A schedule
that is not visible to its runner is treated as API. Paused goals say "API
usage uses credits, not your plan credit. Add credits before resuming.";
schedule run receipts record such a skip as `insufficient_credits`.

Billing records (`documents.billing_attribution`,
`knowledge_index_jobs.billing_attribution`) may carry `billingOrigin` on a
service attribution, so documents uploaded with an API key are indexed on
credits.

## Limitations

- Schedules created through the API before this change have no stored origin
  and are billed as app; telling them apart afterwards is not reliable.
- Opengeni calling Opengeni over MCP is an outside agent and is billed as API.
- A Site frame's own request header never makes a credential app use; only
  published Sites, which stamp their requests in-process, are app.
- A failed read of a turn's origin fails the request instead of guessing who
  pays; a turn that cannot be found is API.
- Credits that API use may spend are general credit outside the plan. Two
  older kinds of promotional credit are unscoped and so count as credits:
  signup trial credit granted before trial credit was limited to models
  (`eligible_model_ids` null), and 100%-off coupon credit written as a plain
  `grant` when no promotion policy is configured. Both are bounded, already
  issued amounts; new promotional credit is scoped and never pays for API use.
- Only a webhook source's own signing secret, or a workspace MCP source's
  URL, marks its deliveries. Sources whose deliveries are authenticated by
  the deployment (GitHub, Slack, Gmail), and a person's MCP source, which
  listens with that person's own sign-in to a server the workspace already
  connected, are not held by the caller. A person's
  "This workspace" source turns their own workspace activity (recording
  events) into events; activity an API caller causes there, such as a
  product uploading a recording with a person's delegated token, fires the
  person's automations under the automation's own origin. Only that person's
  own automations listen on it, and a workspace key cannot create one.
- Inheriting "the chat's latest decided origin" reads the chat's newest turn
  with an origin; the existing turn indexes serve it. A dedicated partial
  index can follow if that read shows up.

## Paid tools

Web search, dictation and live voice, image and video generation, sandbox
time and knowledge indexing cost credit whatever model the chat uses. App use
pays for them from whatever credit applies, plan credit first, including the
Free plan's monthly credit (its model scope only limits which models it pays
for). API use pays for them from credits only. A failed video refunds what
other credit paid; scoped plan credit it used is not returned, so it never
turns into credits.

## CloudGeni

CloudGeni, our own product that embeds Opengeni, keeps exactly today's
billing. Its host account (Cloudgeni-Embedded) is on legacy billing terms:
`OPENGENI_BILLING_LEGACY_ACCOUNT_IDS` lists such accounts and its built-in
default lists CloudGeni's production host account, so no deployment
configuration is needed (`none` lists no account). For a listed account all
work is funded as app use, which is how every turn was funded before origins
existed: any credit pays any use, in today's order. Later billing changes
(the own-key platform fee, newly metered tools) skip listed accounts too.
Two shared changes do reach it, neither a new block or charge: paid tools may
draw on a Free plan period's model-scoped credit first, and a failed video
does not return the scoped plan credit it used.

Why an account list: CloudGeni already pays cost plus margin from operator
credit grants on that one account, and its people and embedded sessions must
see no new blocks or charges. A list is one switch rather than a code path per
product, and another account (a staging CloudGeni account) is added the same
way. Processes install it at boot (`configureBillingLegacyAccounts`).

## Rollout

Migration 1119 is rolling: four nullable columns with `NOT VALID` checks,
two triggers with their private functions, new private helpers,
same-signature replacements of the plan balance and expiry functions, and two
widened `NOT VALID` billing-record checks. The scheduled-task execution
digest, execution state and personal-resource fence learn to ignore
`billing_origin` through an in-place patch of their exclusion lists, like
1115's `creator_locked`, so whatever earlier migrations put there is kept; the
patch refuses to run if a list it expects is missing and is a no-op when
rerun. The previous release never writes the columns; null keeps today's
behaviour.

During the rolling deploy an old pod neither sets nor reads
`event_sources.secret_billing_origin`: an API caller's secret or format
write handled by an old pod leaves the source unmarked, and an old pod's
intake doesn't mark the automations a delivery fires. Such a source stays app
until its next API secret or format write on a new pod.
