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
- `credit_ledger_entries.usage_origin` records the origin each usage debit was
  charged under. The debit writers resolve it from the explicit input, the
  attribution metadata, the turn, then the ambient request scope.

## Balances

`BillingBalance.creditsMicros` is general credit minus this month's
unrestricted plan allowance: what API use may spend. It goes negative when a
running API call settles past it, exactly like general debt today; the next
top-up repays it first.

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

## CloudGeni

CloudGeni embeds Opengeni through organization keys and delegated tokens, so
its turns are API origin and are funded by credits, which operators grant with
`manual_credit_grant` as today. No exemption is needed: its accounts are
funded by credits, not plan or promotional credit, so nothing changes for it.
A product that needs different terms gets operator credit grants, not a code
path. Promotional credit (signup and offers) is app-only from this change.

## Rollout

Migration 1100 is rolling: three nullable columns with `NOT VALID` checks,
two triggers and two same-signature function bodies. The previous release
never writes the columns; null keeps today's behaviour.
