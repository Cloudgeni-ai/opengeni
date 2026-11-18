---
"@opengeni/config": patch
"@opengeni/db": patch
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
---

Plan-less organizations on a deployment without subscription plans are no longer bounded like Free, and turns parked at an organization's running-box limit no longer count as sandbox recoveries.

- **`none` without subscription plans:** with `OPENGENI_SUBSCRIPTION_PLANS_ENABLED` off, no organization ever gets a plan row, so `none` is every organization's ordinary tier. It is no longer unpaid: the default plan limits leave it unbounded (`DEFAULT_SANDBOX_PLAN_LIMITS_WITHOUT_SUBSCRIPTION_PLANS`), and none of the free compute bounds, unpaid fleet limits or unpaid Modal ceilings apply to it. With subscription plans on, `none` is still a self-serve organization waiting for Free enrollment and stays bounded like Free. Promotion decisions (`restricted`, linked restriction, suspension) apply either way. Operators can still bound `none` in `OPENGENI_SANDBOX_PLAN_LIMITS_JSON`. New `sandboxPlanTierUnpaid`; `parseSandboxPlanLimitsJson` takes `{ subscriptionPlansEnabled }`, `settingsForSandboxPlanTier` reads `subscriptionPlansEnabled` from its settings, and `acquireLease` accepts `subscriptionPlansEnabled` (omitted means on).
- **Recovery cause `organization_limit`:** a turn parked because its organization already runs as many boxes as its plan allows counts in `opengeni_turn_recoveries_total` as `cause="organization_limit"` instead of `sandbox`, and `OpenGeniTurnRecoveryRatioHigh` excludes it like `route_change`.
