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
  an internal (legacy) account stays app (`fundedBillingOrigin` at intake).
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
  those events fire are API use, internal (legacy) accounts excepted.
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

Plan credit never repays that API debt, nor own-key fee debt (see below).
Negative credits up to what API work (other than own-key fees) has spent plus
own-key fee debt still owed (fees' `unfundedMicros` less `feeDebtRepaidMicros`)
are never repaid from plan credit; of that, own-key fee debt
(`BillingBalance.byokFeeDebtMicros`) is owed first and the rest is
`BillingBalance.apiDebtMicros`. Fees paid in full never raise the cap, so an
ordinary app overdraft of an account that once paid fees is still netted
from the next period. App admission and plan allocation add both
back, so app use keeps the whole allowance. The database applies the same
cap with `opengeni_private.plan_app_general_balance`: period expiry removes
the whole unused allowance and leaves that debt as credit debt, and a new
period's opening debt nets only older app debt. The app's read and the
database use the same figure, so a renewal never nets debt the app does not
show. Debt is attributed to API use up to that lifetime spend, which can count
a later app overrun as API debt when the account once paid for API use; that
errs towards keeping plan credit.

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

## Internal accounts (CloudGeni and our team)

Our internal accounts keep exactly today's billing: CloudGeni's host account
(Cloudgeni-Embedded; CloudGeni is our own product that embeds Opengeni) and
our own team's organizations in production and staging, whose work uses the
team's own Claude and Codex subscriptions heavily. They are on legacy billing
terms: `OPENGENI_BILLING_LEGACY_ACCOUNT_IDS` lists such accounts and its
built-in default (`DEFAULT_BILLING_LEGACY_ACCOUNT_IDS` in `packages/config`)
lists these internal accounts, so no deployment configuration is needed
(setting it replaces the list; `none` lists no account). For a listed account
all work is funded as app use, which is how every turn was funded before
origins existed: any credit pays any use, in today's order. Later billing
changes (the own-key platform fee, newly metered tools) skip listed accounts
too. Two shared changes do reach them, neither a new block or charge: paid
tools may draw on a Free plan period's model-scoped credit first, and a failed
video does not return the scoped plan credit it used.

Why an account list: CloudGeni already pays cost plus margin from operator
credit grants on its one account, and its people and embedded sessions must
see no new blocks or charges; our team's own work must not pay us a fee
either. A list is one switch rather than a code path per product, and another
internal account is added the same way. Processes install it at boot
(`configureBillingLegacyAccounts`).

## Platform fee on your own keys

A call served by the person's own provider key (workspace or organization
keys, workspace Gateway, organization Azure OpenAI and similar) or their own
Claude, Codex or SuperGrok subscription costs Opengeni nothing upstream. It
pays a platform fee instead, in the app and over the API alike:
`byokPlatformFeeBps` (`OPENGENI_BYOK_PLATFORM_FEE_BPS`, default 500 = 5%) of
the call's list-price equivalent, rounded up to the micro-dollar. The fee is
charged only with Stripe billing (`OPENGENI_BILLING_MODE=stripe`), where people
can buy the credit it needs; `0` turns it off. An account on legacy billing
terms (CloudGeni, above) is skipped. A host that binds its own entitlements
is not special: its own-key calls are admitted, charged and refused by the
same rule everywhere (session and run admission, model calls, limits and
settlement).

- **List-price equivalent:** the reviewed list price of the served model, even
  on a Gateway route; else a positive cost the provider or Gateway reported (a
  Gateway can report $0 on the person's own upstream key). A response with
  incomplete token counts uses the fallback rate. A custom endpoint with no list
  price uses the fallback rate `BYOK_FALLBACK_LIST_RATE`: $1.25 per million
  input tokens (cached and cache-write tokens count as input) and $10 per
  million output tokens, a mid-tier frontier rate, so an unpriced model is
  never fee-free and never priced like the most expensive one.
- **Charge:** settlement writes one `byok_platform_fee` ledger debit per
  response (`credit:byok_platform_fee:<sourceId>`, idempotent), with
  `listEquivalentMicros`, `listEquivalentSource`, `feeBps`, and how it was
  funded (`planPaidMicros`, `creditPaidMicros`, `unfundedMicros`).
- **Paid credit only:** the fee may draw on an active paid plan's credit (Pro,
  Max) for app use, then on paid credits (`BillingBalance.paidPlanCreditMicros`,
  `paidCreditsMicros`). A plan that is not `active` (past due, unpaid) pays no
  fee, and `plan_period_usage` counts only the fee's `planPaidMicros` against
  the allowance, so a fee is never charged to both the plan and credits, and a
  leftover unrestricted Free period never pays one. The Free plan's monthly
  credit, signup credit and promotional credit never pay it: the fee is a
  general debit and never draws on model-scoped grants. API-origin fees come
  from credits only, like all API use.
- **Fee debt:** admission only checks that paid credit is above zero, so
  parallel calls can settle past it. The excess (`unfundedMicros`) is fee debt
  (`BillingBalance.byokFeeDebtMicros`): what fees left unfunded less what
  paid-for credit repaid since (`feeDebtRepaidMicros` receipts), so a later
  shortfall such as a dispute clawback is never fee debt. It never draws plan
  or promotional credit (spendable figures add it back) and plan credit never
  repays it, not at period expiry and not in a new period's opening debt. No
  own-key call is admitted on paid credits while it is owed (app use may still
  run on a paid plan's remaining credit). The next paid-for credit (a top-up,
  operator credit grant or won dispute) repays fee debt first, then API debt.
  A response that reports no tokens has no list-price equivalent and pays no
  fee.
- **Refusal:** with no paid credit an own-key call is refused before it runs:
  HTTP 402, code `byok_paid_credit_required`, with one action. On the Free
  plan in the app, "Upgrade to Pro to use your own key." and the
  `upgrade_plan` action; otherwise "Add credits to use your own key." and the
  Add credits action. The worker re-checks between model calls; scheduled
  runs skip the occurrence as out of credits and goals pause on credits.

The fee is not a model charge: it never consumes scoped promotional grants,
and a deployment-funded free model (`cost: "free"`, Opengeni pays upstream)
pays neither credits nor the fee. Paid tools (sandbox time, web search,
voice, image and video) keep their own credit charges with or without an own
key.

### Paid credit

Paid credit is credit the person paid for and has not spent:

- **Paid for:** `credit_topup` net of a coupon's discount (the top-up's paid
  share is `stripeAmountTotalCents / (stripeAmountTotalCents +
  stripeDiscountCents)`; the discount is unpaid credit arriving with the
  top-up), `manual_credit_grant` (operators should use `grant` for goodwill
  credit that must not pay fees) and `credit_dispute_release` (as much as its
  hold took from paid credit). `credit_refund` and `credit_dispute_hold` take
  paid credit back first.
- **Unpaid:** any other positive unscoped credit: coupon and other `grant`
  rows, usage refunds, a top-up's discount.
- **Spent:** own-key fees (`creditPaidMicros`), and ordinary spending that ran
  past unpaid credit. Ordinary spending draws unpaid credit first, so paid
  credit that was spent stays spent and a later promotional grant never pays
  a fee. App use an unrestricted paid plan allowance covers never touches
  credits, so it never spends paid credit, and a refund of it (which returns
  plan credit) never adds any.

There is no ledger walk. Each write that changes paid credit other than by
plain spending records a receipt on its own row under the account lock
(`packages/db/src/paid-credit.ts`): the paid credit it adds or removes
(`paidCreditMicros`), fee debt it repays (`feeDebtRepaidMicros`), and a mark,
the paid credits and paid funding just before it (`paidCreditsBeforeMicros`,
`paidFundingBeforeMicros`, and `paidRestoredMicros` for a usage refund) and
the unpaid credit just after it (`unpaidCreditsAfterMicros`). Paid credit is
then

    min(paid funding + min(0, lowest mark), credits + fee debt)

where paid funding is the receipts' paid credit less fees paid from it and
fee debt repaid, and a mark is paid credits before it (plus what it restores)
less paid funding before it. Between receipts plain spending only lowers
credits, so the lowest point is either now or a mark.

Each receipt also carries running totals over every row up to and including
its own (`paidCreditTotals`): the sums of paid parts, fee debt repaid, fees'
unfunded shares and paid inflows, the lowest mark, a receipt count, and this
month's fees. Writes that change paid credit take the account lock, and a
receipt row is stamped at the settlement time but strictly after every row
that can carry a receipt, so the latest receipt's totals cover every row
before it even if the database clock steps back (a failover to a host
slightly behind). The balance read sums the balance and API spending in one pass
over the ledger, exactly as without the fee, and takes the paid-credit
figures from the latest receipt (through the partial index
`credit_ledger_receipt_rows_idx`) plus any rows that can carry a receipt
written after it, which is normally none. Ordinary debits' metadata is never
read, and the read does not grow with the number of fees, top-ups or grants:
an account that only uses its own keys, where every row is a fee, reads its
balance as fast as an account without fees. Fee admission and settlement
cost the same as a plain balance read, and settling a fee reads the balance
once. `plan_app_general_balance` reads fee debt the same way.

A video refund returns as paid credit what its debit drew from paid credit
(`paidDrawnMicros` on the debit); other usage refunds return unpaid credit,
which can understate paid credit but never overstate it. Rows without a
receipt (written before this release, or by the previous release during a
rolling deploy) are bounded conservatively, never above what receipts
recorded: an unrecorded unpaid inflow after the latest receipt is taken to
arrive when paid credit was zero, and paid credit is also at least credits
less the unpaid credit the latest receipt left (none before the first) less
the unrecorded unpaid inflows since, whichever bound is larger. So an older
release's top-up and grant written after a receipt keep the paid credit
before them. An unrecorded top-up after the latest receipt repays fee debt
first, and the next receipt records it and folds those rows into its totals.

Workspace and member allowances count fee debits like any other debit, so an
allowance that also counts unbilled usage at list price sees an own-key call
at 105% of list.

## Rollout

Migration 1128 is rolling: four nullable columns with `NOT VALID` checks,
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

Migration 1108 is rolling: same-signature replacements of
`opengeni_private.plan_period_usage` (an own-key fee counts only its
`planPaidMicros`) and `opengeni_private.plan_app_general_balance` (the debt
cap adds own-key fee debt still owed). The previous release never writes
`byok_platform_fee` rows, so its results are unchanged. Paid-credit receipts
are plain row metadata; rows the previous release writes during the rollout
are read conservatively (see Paid credit).

Two accepted residuals if the database clock steps back:

- **During the rollout only:** a row the previous release writes after a
  receipt stamped ahead of the clock sorts before that receipt and is never
  folded into paid credit. An old-release promotional grant can then count as
  paid, and an old-release top-up can be missed until reconciled. A full fix
  would need an insertion marker the previous release does not write.
- **Plan usage:** receipts written during the skew are stamped in the future
  (after the latest receipt), so `plan_period_usage` can undercount for the
  length of the skew, milliseconds in practice.

Migration 1109 builds `credit_ledger_receipt_rows_idx` concurrently (a
non-unique partial index, so it may land after traffic returns). Reads are
correct without it; until it exists the read finds the latest receipt through
the account's `(account_id, created_at)` index, walking back over the spending
since that receipt.

The fee's default (500) turns it on wherever Stripe billing is active once
deployed; set `OPENGENI_BYOK_PLATFORM_FEE_BPS=0` to deploy it switched off.
