# Subscription plan foundation

The catalog and accounting are inert until a trusted billing/operator caller
creates an `organization_plans` row. This migration enrolls nobody, enables no
jobs, changes no machine-time pricing and does not configure Stripe prices.
Self-hosted and embedded organizations with no plan row retain uncapped seats
and their existing credit behavior.

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
  `stripe_subscription_id`, `period_start/end`, `granted_micros`, `grant_entry_id`,
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
replace_plan_credit_period(uuid, text, timestamptz, timestamptz, text DEFAULT NULL) -> jsonb
free_plan_credit_eligible(uuid) -> boolean
organization_plan_seats_used(uuid) -> integer
read_organization_plan_balance(uuid) -> jsonb
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
The key is `plan-credit:stripe:<subscription>:<period-start-epoch>`; Free uses
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
expiry back. A replacement cannot move behind the open period.

For a paid renewal or upgrade, update state then grant/replace **in one outer
`withRlsContext` transaction using its `tx` handle**. This keeps membership/org
locking before credit-account locking. Stripe delivery order is the caller's
responsibility: re-read the subscription before synchronization. A downgrade
or cancellation schedules state changes at period end; do not replace credit
early. The maintenance scheduler/global discovery and Stripe handlers are later
work; this foundation supplies per-account grant/expiry/eligibility seams only.

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

Remaining allowance is granted minus net settled usage, floored at zero.
Usage excludes `credit_topup`, `grant`, `manual_credit_grant`,
`plan_credit_grant`, `plan_credit_expiry`, `credit_refund`,
`credit_dispute_hold`, `credit_dispute_release`. Every other type counts;
positive `video_generation_refund` reduces usage. Promotional allocations are
subtracted, so eligible promotional credit pays first, then plan, then top-up.
All ledger helper writers and both video debit/refund paths share the account
advisory lock. Settlement `created_at` is stamped after that lock, rather than
using provider/backdated `occurred_at` or a transaction-start default. Usage is
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
`creditRemainingMicros`, nullable `periodResetAt`, nullable `seatLimit`,
`seatsUsed`, `cancelAtPeriodEnd`. Existing balance/general/promotional fields
retain their meanings. Expired allowance projects zero remaining even before
maintenance writes its expiry. The existing billing routes return this shared
snapshot, and the SDK re-exports `BillingPlanBalance`, `SubscriptionPlan`, and
`SubscriptionPlanCatalog` alongside `BillingBalance`.
