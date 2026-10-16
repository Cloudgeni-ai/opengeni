# Subscription backend

`OPENGENI_SUBSCRIPTION_PLANS_ENABLED` defaults to false. While disabled, the
new subscription endpoints return 404, subscription webhook receipts remain
unprocessed for replay, and no maintenance enrollment/grant job runs. Existing
top-ups remain enabled independently. Migrations enroll nobody, change no
machine-time pricing and configure no Stripe prices. Organizations with no
plan row retain uncapped seats and their existing credit behavior. Activation
enrolls all organizations in Free, including embedded organizations; only actual
verified-signup-trial recipients receive monthly Free credit. Enterprise is
operator-assigned only.

Migration 0793 is **maintenance**, despite adding only new structures: the
preceding binary's closed readiness contract rejects unknown RLS tables and
their runtime SELECT privileges. A rolling deployment would require an earlier
compatibility-binary release. Drain the old API/workers before migrating and
start only the updated binary afterward; do not weaken FORCE RLS to hide this.

## Runtime catalog

`bun run plans:catalog -- --show` reads the current catalog. To change it, use
`--file <catalog.json> --operator <name> --reason <reason>` with
`OPENGENI_MIGRATIONS_DATABASE_URL` or `OPENGENI_DATABASE_ADMIN_URL` pointing to
the migration owner. The runtime role has read-only access and cannot call
`set_subscription_plan_catalog(jsonb, text, text)`. Revisions are immutable,
audited, serialized, and effective without process caches or a redeploy.
Existing keys cannot be removed; existing period grants retain their amount.

Each array entry has `key`, `label`, nullable `stripePriceId`, nullable
`monthlyPriceMicros`, `monthlyCreditMicros`, nullable `seatLimit` (unlimited),
and `freeCredit`. All monetary values are USD micro-units (1 USD = 1,000,000).
Defaults: Free $0/$10 credit/5 seats, Pro $20/$200/10, Max $200/$2,000/unlimited,
Enterprise manual price/0 automatic credit/unlimited. Stripe IDs start null.

## Database and worker contract

`managed_accounts.id` is the organization identity; physical columns continue
the existing `account_id` convention.

- `opengeni_private.subscription_plan_catalog_revisions`: `revision`, `catalog`,
  `operator`, `reason`, `database_role`, `changed_at`.
- `organization_plans`: `account_id` primary key, `plan_key`, `status`, unique
  nullable `stripe_subscription_id`, nullable `current_period_start/end`,
  `cancel_at_period_end`, `created_at`, `updated_at`.
- `plan_credit_periods`: `id`, `account_id`, `plan_key`, `catalog_revision`,
  `stripe_subscription_id`, `period_start/end`, `granted_micros`, `opening_debt_micros`, `grant_entry_id`,
  unique `idempotency_key`, `granted_at`, `expired_at`, `expiry_entry_id`,
  `usage_at_expiry_micros`. There is at most one unexpired period per account;
  ended unexpired periods have a maintenance discovery index.

The two account tables have FORCE RLS and runtime SELECT only. Public-schema
SECURITY DEFINER entry points check the exact current account GUC; wrappers
from `@opengeni/db` establish it. SQL signatures (timestamps are `timestamptz`):

```sql
upsert_organization_plan(uuid, text, text, text, timestamptz, timestamptz, boolean) -> jsonb
grant_plan_credit_period(uuid, text, timestamptz, timestamptz, text DEFAULT NULL) -> jsonb
expire_plan_credit_period(uuid, uuid, boolean DEFAULT false) -> jsonb
expire_ended_plan_credit_periods(uuid) -> integer
begin_plan_credit_settlement(uuid) -> timestamptz
replace_plan_credit_period(uuid, text, timestamptz, timestamptz, text DEFAULT NULL) -> jsonb
free_plan_credit_eligible(uuid) -> boolean
organization_plan_seats_used(uuid) -> integer
read_organization_plan_balance(uuid, timestamptz DEFAULT NULL) -> jsonb
```

`upsertOrganizationPlan(db, { accountId, planKey, status, stripeSubscriptionId?,
currentPeriodStart?, currentPeriodEnd?, cancelAtPeriodEnd? })` writes plan state.
Identical state preserves `updated_at`. It does not issue or expire credit.
Statuses are `active`, `trialing`, `past_due`, `canceled`, `unpaid`, `paused`,
`incomplete`, `incomplete_expired`.

`grantPlanCreditPeriod(db, { accountId, planKey, periodStart, periodEnd,
stripeSubscriptionId? })` requires matching active/trialing plan state and exact
period bounds. Paid grants require a subscription identity. The caller must
only invoke them after payment; these functions do not verify a Stripe invoice.
The key is `plan-credit:stripe:<subscription>:<period-start-epoch>:<plan-key>`; Free uses
`plan-credit:free:<account>:<UTC YYYY-MM>`. Duplicate calls return the original
receipt, even after state/catalog changes; different terms for the same key
fail with `23505`. Normal renewal expires an ended old period first. Overlap
requires the explicit replacement function. Late already-ended grants expire
inside the same transaction rather than reviving an allowance.

`expirePlanCreditPeriod(db, { accountId, periodId, force? })` defaults to only
ended periods. `force: true` permits the upgrade/cancellation operator path.
Expiry writes one receipt even when the amount is zero. Subsequent calls return
the frozen receipt and never recompute usage or remove a later top-up.

`replacePlanCreditPeriod` takes the same input as `grantPlanCreditPeriod`.
It expires the old period and grants the full new amount atomically. Retries
check the grant receipt before expiring anything, so a duplicated upgrade
cannot expire its own or a successor period. A failed new grant rolls the
expiry back. A replacement cannot move behind the open period. Use this path
even when Stripe retains the same integer-second anchor: a different plan has
a distinct receipt at that anchor, but repeating that plan/anchor never refills.
This refines the design's subscription/start-only key to reconcile paid
same-second upgrades safely. Use this path
for **every** plan transition, including Free to Pro/Max: unused Free monthly
credit must never stack on top of the paid allowance. The separately issued
signup promotion is not monthly plan credit and remains available.

For a paid renewal or upgrade, update state then grant/replace **in one outer
`withRlsContext` transaction using its `tx` handle**. This keeps membership/org
locking before credit-account locking. Stripe delivery order is the caller's
responsibility: re-read the subscription before synchronization. A downgrade
or cancellation schedules state changes at period end; do not replace credit
early. The Stripe store implements this ordering and re-fetches current provider
state inside the organization fence, rather than trusting event arrival order.

All mutations return period/state JSON using the table's snake_case names.
Wrappers also export `PlanCreditPeriod`, `PlanCreditPeriodInput`, and
`OrganizationPlanStateInput`. `readSubscriptionPlanCatalog` returns
`{ revision, plans }`; `getOrganizationPlanBalance` reads the plan projection.

## Credit accounting

New ledger types are `plan_credit_grant` and `plan_credit_expiry`. Both have
`workspace_id = NULL` and `eligible_model_ids = NULL`; grants are general credit,
not scoped promotions. Expiries therefore do not increment workspace allowance
debit counters. The signup receipt trigger remains the only signup-trial issuer.
Recurring plan funding deliberately does not fire the signup/coupon/manual
`credits.granted` acquisition/lifecycle triggers of migration 0566.

Remaining allowance is granted minus opening general-credit debt absorbed by
the grant and net settled usage, floored at zero. `opening_debt_micros` records
that already-consumed funding, so a later purchased top-up cannot be mistaken
for unspent plan credit at expiry.
Usage excludes `credit_topup`, `grant`, `manual_credit_grant`,
`plan_credit_grant`, `plan_credit_expiry`, `credit_refund`,
`credit_dispute_hold`, `credit_dispute_release`. Every other type counts;
positive `video_generation_refund` reduces usage only when its original debit
(same account/source identity) belongs to the same period. A reversal of a
pre-plan or older-period debit returns general credit, never inflating the new
period's refundable allowance. For refunds of an expired period's video debits,
a ledger trigger computes the cumulative increase in unspent allowance from
the frozen net usage and all late refunds, subtracting prior refund-expiry
receipts. It uses the same fungible accounting as normal expiry, including
interleaved reversals, rather than attributing funding to individual debits.
That increase expires immediately with workspace-less `plan_credit_expiry`
receipts. Purchased portions survive. Video
admission is prepaid, so video debits cannot create the opening debt repaid by
a later grant. Promotional allocations are
subtracted. Monthly plan credit pays **first**, before any other funding; only
usage beyond the remaining monthly allowance allocates eligible promotional
grants, then other general credit/top-ups. This overrides the original design's
promotional-first order following Bendik's updated product decision. A single
request can exhaust the plan and allocate only its excess to promotions. When
pre-existing general debt has already absorbed the allowance, prepaid
admission cannot recreate it by repeatedly preserving promotional balances.
All ledger helper writers and both video debit/refund paths share the account
advisory lock and settle ended periods before new ledger writes, independently
of maintenance timing. `beginPlanCreditSettlement` captures one server timestamp
after that lock; expiry selection, plan allocation and ledger `created_at` all
use that same timestamp, even when driver latency crosses the boundary before
the INSERT. Provider/backdated `occurred_at` and transaction-start defaults do
not determine funding. Usage is
bounded by actual grant time and period end/early expiry. No charge settled
before the grant is retroactively paid by it; no queued charge can enter an
already-expired period because its transaction began earlier.

Expiry removes the smaller of remaining allowance and positive **general**
balance. This deliberately refines the design's total-balance wording: totals
include unspent model-scoped promotions, which must not be expired to cover
pre-existing general-credit debt. Separately purchased top-ups never have their
own expiry and survive plan expiry. Running use can still overdraw general
credit; new top-ups repay debt first.

## Free eligibility and seats

`freePlanCreditEligible` requires the organization's actual verified-signup
trial grant (`source_type = verified_signup_trial`, canonical human idempotency
key). Merely verifying an email or creating additional organizations is not
enough. No historical eligibility backfill is executed by this migration.
Any production backfill requires a separately authorized, one-human/one-org
eligibility decision; the maintenance caller must not infer eligibility.
Disabling the separate signup-trial issuer at activation would make new users
ineligible under this receipt-based rule; changing that eligibility source needs
an explicit follow-up design. This PR does not disable the issuer.

Seats count active/provisioning `user:` subjects plus pending, unexpired
invitations. A bound invitation reserves the same seat as its matching member,
not a second seat during acceptance. `external_user:` and service subjects do
not count. Triggers cover inserts, reactivations and invitation creation/renewal
under the existing `organization-membership:<account>` advisory lock. Existing
over-limit people remain; new additions fail. Previously reserved invitations
may still be accepted without increasing seat usage. Unlimited and no-row
organizations are uncapped.

SQLSTATE `P0S01` maps through `rethrowMembershipError` to HTTP 402:
`{ error: "seat_limit_reached", message, action: { type: "upgrade", href:
"/billing" } }`.

## Billing/UI contract

`BillingBalance.plan` is optional/nullable. It is null for unenrolled accounts;
otherwise it contains `key`, `label`, `status`, `creditGrantedMicros`,
`creditRemainingMicros`, `creditPendingExpiryMicros`, nullable `periodResetAt`, nullable `seatLimit`,
`seatsUsed`, `cancelAtPeriodEnd`. Existing balance/general/promotional fields
exclude an ended, unavailable allowance even before its physical expiry row
is written; `creditPendingExpiryMicros` shows that ledger/projection difference.
Reads remain lock-free. The next ledger writer settles it under the account
lock before admitting or recording fresh funding/usage, so late post-use
charges cannot spend it or hide debt. The existing billing routes return this shared
snapshot, and the SDK re-exports `BillingPlanBalance`, `SubscriptionPlan`, and
`SubscriptionPlanCatalog` alongside `BillingBalance`.

New endpoints use the existing selected-organization permissions and require
Stripe billing plus the deployment switch:

| Endpoint | Request → response |
| --- | --- |
| GET `/v1/billing/subscription/plans` | Optional `accountId` query → `BillingSubscriptionCatalog` |
| POST `/v1/billing/subscription/checkout` | `CreateSubscriptionCheckoutRequest` → `CreateSubscriptionCheckoutResponse` |
| POST `/v1/billing/subscription/upgrade` | `ChangeBillingSubscriptionRequest` → `BillingSubscriptionChange` |
| POST `/v1/billing/subscription/change` | `ChangeBillingSubscriptionRequest` → `BillingSubscriptionChange` |
| POST `/v1/billing/subscription/cancel` | `CancelBillingSubscriptionRequest` → `BillingSubscriptionChange` |
| POST `/v1/billing/subscription/portal` | `CreateBillingPortalRequest` → `CreateBillingPortalResponse` |

Checkout/change requests require `planKey` and a UUID `idempotencyKey`;
cancellation requires the UUID. `accountId` is optional. Checkout also accepts
optional `successUrl`/`cancelUrl`. Reuse a UUID for retries of the same action,
not for a different action. The catalog returns `accountId`, `revision`, plans
with `selfService` availability and the current balance `plan`. Checkout returns
`checkoutSessionId` and `url`; changes return `subscriptionId`, `planKey`,
`effectiveAt` and `cancelAtPeriodEnd`. SDK methods mirror these routes.

Subscription Checkout reuses the serialized Stripe customer and automatic tax.
Organization metadata lives on the subscription, not a PaymentIntent, so
subscription payments do not enter existing top-up refund/dispute handlers.
`customer.subscription.created/updated/deleted`, `invoice.paid` and
`invoice.payment_failed` re-fetch current Stripe state. Only a paid invoice
whose line matches the current item, price and period can grant/replace credit.
Stripe v22 periods come from subscription items; invoice subscription identity
comes from `invoice.parent.subscription_details.subscription`.

Upgrade uses `billing_cycle_anchor=now`, `proration_behavior=always_invoice`
and `payment_behavior=error_if_incomplete`, then synchronizes the paid invoice.
Downgrade uses a period-end schedule; cancellation sets `cancel_at_period_end`.
Duplicate subscriptions are marked, canceled and their duplicate-period paid
charges refunded idempotently. Historical legitimate invoices are excluded.
Stripe products/prices, webhook activation and period-end portal configuration
are operator prerequisites; ordinary subscription refunds/disputes are manual.

## Maintenance

When enabled, `subscription-plan-maintenance` runs at startup and every 60
seconds. Each pass handles 50 account IDs (validated maximum 100), expires ended
periods and enrolls missing Free state. Only actual trial recipients get grants.
Free periods follow the organization's original creation day/time in UTC,
clamping short months without drift (January 31 → February 28 → March 31).
Only the current period is granted; there is no catch-up/backfill. The original
Free receipt prevents regranting after a paid→Free transition in the same interval.
Ended canceled/unpaid/incomplete_expired Pro/Max state may return to Free;
active/retrying paid plans, unended paid periods and Enterprise are preserved.

`@opengeni/db` exports `listSubscriptionPlanMaintenanceAccounts(db, limit?)`,
`subscriptionPlanMaintenanceDue(db)` and `maintainSubscriptionPlans(db,
{batchSize?, onError?})`. The result reports `examinedAccounts`, `expiredPeriods`,
`enrolledFreeAccounts`, `grantedFreePeriods` and `failedAccounts`. Each account
uses its own transaction, organization fence before credit lock. Repeated or
concurrent passes converge on immutable grant/expiry receipts. Discovery uses
an explicitly inventoried, owner-bound read-only RLS capability:

```sql
opengeni_private.list_subscription_plan_maintenance_accounts(integer) -> SETOF record(account_id uuid)
opengeni_private.subscription_plan_free_anniversary(timestamptz, timestamptz)
  -> TABLE(period_start timestamptz, period_end timestamptz)
```

The per-account helpers are trusted backend primitives; the deployment switch
is enforced at the API and worker scheduling boundaries, not by database env
configuration. Migration 0794 adds the inventory capability after maintenance
migration 0793; deploy both together with the compatible binary.
