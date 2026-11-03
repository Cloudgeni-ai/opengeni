# Automatic credit top-ups

`OPENGENI_BILLING_AUTO_TOP_UP_ENABLED` defaults to false. It is independent of
subscription-plan enrollment. There is no implicit enrollment or migration-time
charge. Bring-your-own-key fees are unchanged; this feature must not change their
staging or production configuration.

## Owner consent and public contract

- `GET /v1/billing/auto-top-up?accountId=…`
- `PUT /v1/billing/auto-top-up` with `{ accountId?, enabled, thresholdMicros,
  amountMicros, monthlyCapMicros, idempotencyKey }`
- `POST /v1/billing/auto-top-up/setup` with `{ accountId?, idempotencyKey,
  successUrl?, cancelUrl? }`, returning `{ url }`.

SDK methods are `getBillingAutoTopUp`, `updateBillingAutoTopUp`, and
`createBillingAutoTopUpSetupSession`. SDK types are exported from the package root.
Amounts are integer USD micro-units and must be whole cents. Defaults are $10
threshold, $25 purchased credit and $100 monthly charge cap. A package is $5 to
$10,000; its cap must cover at least the pre-tax package. No floating-point USD
conversion is used. The comparison is strictly **below** the threshold, against
`creditsMicros` (purchased/unrestricted credit outside the monthly plan), not
promotional or monthly subscription allowance.

The settings response is `{ accountId, enabled, thresholdMicros, amountMicros,
monthlyCapMicros, spentThisMonthMicros, status, paymentMethod, failureReason }`.
`status` is `off`, `ready`, `payment_method_required`, `payment_failed`,
`cap_reached`, or `processing`. A pending operation remains `processing` even
after the owner disables new charges. `paymentMethod` is `{ brand, last4 }` or
null; provider IDs and issuer error details are never returned.

Only a directly authenticated managed-browser **organization owner** can mutate
settings or start setup. Billing administrators, organization keys, delegated
agents, and a claimed owner subject without the verified cookie cannot consent.
The owner membership is revalidated under the organization fence. `enabled:true`
is the explicit consent action: the UI must explain recurring **off-session**
threshold charges, the pre-tax package amount, applicable tax, UTC monthly cap,
and the ability to turn it off. The persisted mutation binds the actor, exact
terms, UUID and timestamp; replays never overwrite newer settings. A new UUID is
required for different terms. Requests to lower the cap below existing charges
and pending reservations are rejected.

Saving a card is **not enrollment**. Checkout runs in setup mode with a card-only
off-session SetupIntent and required billing address. The completion must match
the active owner-started setup key, Stripe mode, organization customer and saved
card. Superseded/consumed setup keys never re-arm on HTTP replay. An arbitrary
customer default card is not silently adopted. New settings remain off unless an
owner separately enabled them. Return URLs use the existing same-origin billing
validation.

## Durable payment protocol

`billing_auto_top_up_settings`, `billing_auto_top_up_mutations`, and
`billing_auto_top_up_operations` are FORCE-RLS account tables. Mutation receipts
are append-only; payment intents and completed results cannot be rewritten or
deleted by the runtime. The additive migration uses only invoker-rights triggers,
so it adds no unknown callable SECURITY DEFINER capability. Previous-binary
readiness is tested against the pinned production inspector and evaluator.

`billingAutoTopUpStore` requires a **root** database handle. Each `locked` call
is its own committed transaction under the existing
`organization-membership:<account>` advisory fence, before any credit-account
lock. The same fence covers settings, reservations, canonical-ID binding,
confirmation and webhook settlement. A partial unique index allows only one
pending operation per account.

1. Revalidate consent, provider/customer/card and wallet balance. Obtain a Stripe
   Tax calculation with the existing credits product (or Stripe's default tax
   code), USD, and exclusive tax. This moves no money.
2. Reserve its exact **tax-inclusive** charge against the current UTC calendar
   month, committing the immutable customer, saved method, owner, tax calculation,
   credit amount and charge amount before creating a PaymentIntent.
3. Create with `confirm:false`. Recover a lost create response by listing that
   customer's intents and matching the exact operation metadata. Durably bind one
   canonical ID before any confirmation. A stale worker cannot confirm an ID from
   its local create response; every later phase rereads the committed journal.
   Extra unconfirmed objects after cache expiry are harmless orphans, never
   eligible for confirmation. An unexpectedly progressed unbound object blocks
   reconciliation rather than authorizing another charge.
4. Commit confirmation intent. Re-read the exact bound PaymentIntent, recheck
   enablement, owner authority, tax expiry and current cap, then confirm **that
   same ID** off-session. Never use request-key retention as proof of safety.
5. Re-read Stripe after ambiguous outcomes. A matching successful paid charge
   grants one ordinary `credit_topup` receipt under
   `stripe:auto-top-up:<operation UUID>`, atomically with operation settlement.
   Worker death, connection loss, local rollback, duplicate webhooks and retries
   after Stripe's request-key cache expiry retain the same canonical identity.

Pending operations count against the cap and block all new attempts until known
settled or canceled. A reservation spanning midnight/month rollover remains
counted; successful charges also count in their actual charge's UTC month. The
original reservation month remains conservatively counted. Settings changes,
refunds and disputes do not reset this spending history. Disabling after payment
started does not pretend the charge was canceled; late success still grants once.

Card declines and authentication-required payments are canceled before releasing
their reservation, disable automatic retries, and expose an actionable owner
message. Processing/unknown payments remain pending. Retrying a decline requires
the owner to fix the card and explicitly enable again. USD/customer/livemode
mismatches never charge. Expired tax quotes are never silently replaced on an
existing operation; cancel it and obtain new owner authorization instead.

## Tax, receipts, refunds and disputes

An automatic top-up adds the selected pre-tax amount as **paid general credit**;
tax increases the charge, never credit. The cap includes tax. Stripe Tax's
PaymentIntent calculation hook is used so the successful payment and tax
calculation are linked. Missing/invalid tax data does not fall back to untaxed
charging.

Automatic top-ups are direct PaymentIntent payments and request a Stripe payment
receipt when the customer has an email. They **do not create Checkout invoices**.
Existing manual top-up Checkout, automatic tax and invoice creation remain
unchanged. Deployments requiring a tax invoice for every automatic payment must
not activate this version until a reviewed invoice-issuance path is added; a
receipt is not represented as an invoice. Do not bolt on an automatically
collecting invoice after a successful PaymentIntent: that would authorize a
second payment.

PaymentIntent metadata retains `opengeni_account_id`, `opengeni_credit_micros`
and `opengeni_credit_idempotency_key`. The existing refund/dispute handlers accept
`stripe_auto_top_up` receipts in addition to Checkout receipts and proportionally
reverse the credit part of the original tax-inclusive settled payment. They
continue to require that original receipt (an out-of-order refund is retryable),
use existing adjustment keys, and preserve dispute hold/release replay semantics.
Neither an adjustment nor a local error makes another PI chargeable for the same
operation.

## Lifecycle and notifications

`StripeAutoTopUps` in `apps/api/src/billing-auto-top-up.ts` exports `process(accountId)`
for a bounded maintenance pass, `settings`, `handlePaymentIntent`, and `handleSetup`.
`createBillingAutoTopUpService(deps, stripe?, notifications?)` is the API factory.
The billing webhook already routes tagged setup/payment events through these
handlers even when fresh charging is disabled, preserving recovery.
`apps/api/src/billing-auto-top-up-maintenance.ts` starts with the API, immediately
and every 60 seconds. It discovers one keyset page of at most 50 organization IDs
per pass and calls `process` sequentially. Discovery is advisory, not authority.
A failed organization does not starve the page; overlapping ticks do not overlap
within a process, and database fences arbitrate replicas. The cursor resets after
the final page so earlier failed accounts are retried. One stoppable timer is
registered per root database handle. This does not change the control worker loop.

Maintenance requires Stripe billing mode and a configured Stripe key, but does
**not** require the fresh-charge activation flag: disabled deployments still
reconcile previously reserved payments and enqueue outstanding terminal outcomes.
Removing Stripe configuration stops that automatic recovery and therefore must
not substitute for disabling fresh charges while payments remain unresolved.

The API factory defaults to `enqueueBillingAutoTopUpNotification` from
`@opengeni/db`, in both maintenance and webhook construction. This adapter uses
the shared billing outbox; delivery uses its existing managed-email transport and
billing-authorized inbox. `AutoTopUpNotificationPort(tx, event)` remains injectable
for explicit integrations: enqueue under the passed transaction, **do not send
email inline**. Events contain `accountId`, `kind`
(`topup_success`, `topup_failed`, `cap_reached`), a stable `operationKey`,
`amountMicros`, `chargeMicros`, and optional sanitized `failureReason`. Deduplicate
by account/kind/key. Success/failure keys identify the immutable payment operation;
pre-payment failure uses settings revision; cap uses UTC month plus settings
revision. Terminal payment delivery checkpoints commit with the outbox enqueue;
`process` replays undelivered terminal notifications, including operations settled
by a previous binary without an injected port. The adapter snapshots canonical
general credit availability and the pre-tax credit amount. Repeated cap events
reuse their committed snapshot even when the wallet changes; changed kind or
credit amount under the same key is rejected. No second notification outbox is
introduced. Success copy identifies credits added, not the tax-inclusive card
charge or an invoice. Failure copy tells the owner to review their card and
explicitly enable again; cap copy says no next payment was started. These events
retain one billing action and use the shared recipient authority checks.

## Verification and rollout

Focused suites: `apps/api/test/billing-auto-top-up.test.ts`,
`packages/db/test/billing-auto-top-up-postgres.test.ts`, and
`packages/sdk/test/billing-auto-top-up.test.ts`, plus
`apps/api/test/billing-auto-top-up-maintenance.test.ts` and
`apps/api/test/billing-auto-top-up-integration-postgres.test.ts`. Run real PostgreSQL tests with
the restricted runtime and a non-public schema, plus
`packages/db/test/runtime-posture-compatibility-postgres.test.ts`. Provider proof
must use a verified `sk_test_`/`rk_test_` key and objects with `livemode:false`,
never a live card or key. Keep deployment activation off until independent review,
exact-head CI, test-mode recovery proof, notification/lifecycle integration and
the deployment's receipt-versus-invoice requirement are satisfied.

`apps/api/test/billing-auto-top-up.stripe-proof.ts` exports an explicit,
non-discovered `runStripeAutoTopUpProof` utility. It requires a verified test key
and dedicated test organization/owner IDs; it must never run in ordinary CI or
against live Stripe. When using shared staging credentials, create a dedicated
staging organization first so existing customer-mirroring webhooks have a valid
foreign-key target. The utility migrates an isolated restricted-role local
PostgreSQL fixture, creates off-session SetupIntents and a Checkout setup session,
injects lost create/confirmation responses plus local settlement rollback, proves
one canonical charge/credit receipt, then tests decline, explicit card replacement
and retry, and the monthly cap. Recovery races the API factory's disabled-charge
maintenance pass against the real webhook handler. Notification assertions use
the shared transactional billing outbox and its owner delivery rows, not a second
fixture outbox or side-effectful in-memory callbacks. It expires its unused
Checkout session and deletes the test customer; immutable test payment history
remains at Stripe. This is provider integration proof, not proof that the new
backend is deployed or that a person completed the browser setup flow.
