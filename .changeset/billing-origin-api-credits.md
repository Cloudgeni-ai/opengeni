---
"@opengeni/db": minor
"@opengeni/core": minor
"@opengeni/contracts": minor
"@opengeni/config": minor
"@opengeni/sdk": patch
"@opengeni/react": patch
---

App use is paid from monthly plan credit; API use (organization and personal API keys, products on the SDK, outside agents over MCP) is paid from credits only. Each turn freezes its funding origin, sub-agents and tools inherit their chat's, and API work with no credits is refused with `402 api_credits_required` and an Add credits action (`1107_billing_usage_origin`, rolling). See `docs/billing-origin.md`. A schedule an API caller edits or runs by hand, or an automation an API caller's test event or replay fires, is API use from then on, and so is an automation fired by a webhook whose signing secret or custom format an API caller set or received (`event_sources.secret_billing_origin`). A custom webhook format can no longer read its event type or ids from the header its signature is in, so a shared token is never stored in events or the delivery log; one stored before reads that header as absent. The web app shows an API turn refused for lack of credits as a credit stop. Paid tools in the app are paid from plan credit too, the Free plan's included. CloudGeni's host account keeps today's billing through `OPENGENI_BILLING_LEGACY_ACCOUNT_IDS` (listed by default). The SDK keeps the `add_credits` and `upgrade_plan` refusal actions and names the fix in its messages.
