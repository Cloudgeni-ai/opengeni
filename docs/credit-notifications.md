# Organization credit notifications

The control worker evaluates organization credit alerts through the existing
maintenance cadence. The API drains their email receipts using the existing
managed-email transport. Neither path charges money, changes pricing, or changes
the BYOK fee. UI rendering and automatic top-up orchestration are separate work.

## Balance and spend rules

- Default low threshold: **$10**, in USD micro-units (10,000,000). Configurable
  per organization, inclusive at the threshold. Zero disables a positive low
  warning but not the exhausted warning.
- The balance is `generalAvailableCreditMicros(await getBillingBalance(...))`:
  the canonical app-general availability, including available unrestricted plan
  allowance, excluding held general credit and pending plan expiry. The canonical
  debt split preserves app plan funding that API/own-key-fee debt cannot consume.
  This is not a raw ledger sum or an API-only spending limit.
- Model-scoped promotions and scoped Free-plan funding are **separate**. Zero
  general availability does not say every model/tool has stopped. Every email
  makes that distinction. Accounts without a positive unrestricted top-up, grant,
  operator grant or plan grant stay silent for balance alerts.
- A first eligible observation below the threshold counts as a crossing. Each
  condition rearms after an observed recovery above its boundary. A jump straight
  to zero emits only `exhausted`; a subsequent zero after a low warning emits the
  exhausted warning. Settings changes apply at the next sample, without discarding
  crossing state.
- Unusual spend: gross settled negative usage in the last hour is at least $10
  **and** at least 5 times the hourly average in the preceding seven days,
  excluding the current hour. At least 24 hours of preceding ledger history is
  required (25 hours including the current hour). Shorter-than-seven-day history
  uses its actual duration, with zero-spend hours included. Funding, plan expiry,
  refunds, and dispute holds/releases are excluded, even if negative. Refunds do
  not cancel the fact that usage occurred. This is an explainable spending alert,
  not fraud detection.
- Unusual spend sends once per sustained incident. It must recover below the rule
  and at least 24 hours must pass since the last notice before another can send.
  A new incident beginning during the cooldown becomes eligible when it ends.

Each deployment replica walks a keyset page of 50 organizations per minute.
The account/credit fences plus persisted sample time make concurrent evaluations
converge; each organization is sampled no more than once per minute. Large
inventories take multiple ticks for a full sweep. Crossings/recoveries entirely
between samples are not observed. There is no new ledger hot-path trigger.

## Receipts, recipients and delivery

Migration `1241_billing_credit_notifications.sql` adds:

- `billing_credit_alert_settings`: configuration and durable crossing state.
- `billing_credit_notifications`: organization-scoped stable operation receipt
  and immutable-by-application kind/details; an event ID is the receipt ID.
- `billing_credit_notification_deliveries`: one recipient inbox/email obligation
  per receipt, with claim UUID, lease, immutable email payload, provider namespace,
  retry deadline, status and acknowledgement.
- `billing_credit_notification_recipients`: read-only runtime projection of
  current active human organization owners/admins. An **invoker** membership
  trigger maintains it inside the existing membership lifecycle transaction.
  Backfill uses the migration owner's existing lifecycle read, not a new runtime
  SECURITY DEFINER capability. FORCE RLS and account scope apply to all four tables.

Enqueue resolves recipients at the original operation, not on replay. Ordinary
members, external actors, workspace-only admins and organization API keys are not
email recipients. Email requires a verified real address; passkey-only people
still receive an inbox projection. Removed/suspended/demoted recipients immediately
lose the inbox projection, and claims recheck live membership and email. Dispatch
holds the existing organization membership fence through a bounded provider call;
revocation committed before that fence prevents sending. No workspace or chat
authority is inferred. Each message has one **Manage billing** action, using the
recipient's same-organization Personal workspace when available.

Claims commit **before** external I/O. Concurrent senders claim disjoint rows.
Retries use `billing-credit:<delivery UUID>` and the exact frozen payload and
provider namespace. A lost reply, timeout, crash or lost database acknowledgement
does not manufacture a success or a fresh key. Stale claim acknowledgements cannot
settle a newer claim. Failed/unknown sends retry after five minutes, within the
provider's declared retention (capped at 24 hours, with a 30-second safety margin).
Expired ambiguity stays durably recorded and is **not automatically resent**.
Changed provider namespace, sender or email suppresses replay. A provider without
idempotency retention receives at most the initial attempt. Exactly-once refers
to durable logical receipts and provider-keyed delivery; guaranteed email arrival
after an indefinitely unknown external outcome is not possible. Operators must
reconcile expired failures against provider evidence, never clear/rekey blindly.

## API, SDK and top-up integration

- `GET /v1/billing/alerts?accountId=<uuid>` requires existing `billing:read`.
- `PUT /v1/billing/alerts` requires `billing:manage`, with
  `{ accountId, lowBalanceThresholdMicros }`; returns those current settings.
- `GET /v1/billing/notifications?accountId=<uuid>` returns
  `{ notifications: BillingCreditNotification[] }`, newest 100 for the current
  authorized human recipient. `POST /v1/billing/notifications/:notificationId/read`
  (same account query) marks that person's notice read.
- Existing `GET /v1/inbox` adds optional `billingNotifications`; these are not
  fabricated chat items. Workspace-filtered reads omit organization notices.
  Existing chat unread/needs-you counts keep their historical meaning.
- SDK: `getBillingAlertSettings`, `updateBillingAlertSettings`,
  `listBillingCreditNotifications`, `markBillingCreditNotificationRead`.
- Contracts are root-exported and available at
  `@opengeni/contracts/billing-credit-notifications`; the SDK exports the types.

`enqueueBillingCreditNotification(dbOrTx, { accountId, operationKey, kind, details })`
is exported from `@opengeni/db` and `@opengeni/core` and returns the durable UUID.
It accepts an outer transaction so a top-up result and its notification can commit
together. Caller-owned stable keys must describe one logical operation, e.g.
`topup:<operation UUID>:success`, never a new UUID/timestamp on retry. Reusing a key
with different kind/details fails. Kinds are `low_balance`, `exhausted`,
`unusual_spend`, `topup_success`, `topup_failed`, `cap_reached`. Details require
`availableBalanceMicros`, with optional `amountMicros`,
`lowBalanceThresholdMicros`, `lastHourSpendMicros`, `baselineHourlySpendMicros`.
All amounts use USD micro-units; no card/provider-error payload is accepted.

Events have names `billing.credits.<kind>` and the same stable ID/details as the
notification. They are retained and exposed through the billing-authorized
notification/inbox APIs only. PR #6661's **This workspace** feed is not an
organization-billing authority: workspace admins can lack billing access, and
automation delivery freezes event content. Therefore these events are deliberately
not offered in `WORKSPACE_WEBHOOK_EVENT_TYPES` or workspace automation feeds.
An organization-authorized source with delivery-time revocation is separate work;
copying billing data into workspace events is not a compatible integration.

## Rollout and checks

This is additive/rolling: no new runtime-callable definer, and the previous pinned
binary's real PostgreSQL inspector/evaluator must accept the resulting schema.
The restricted-role tests run all migrations with a non-superuser owner in a
non-public schema and verify tenant isolation, recipient writes, concurrent
crossings/claims, recovery, expiry, ambiguous sends, and live revocation.
Live staging email/UI verification requires this backend to be released there;
merging alone does not deploy it.
