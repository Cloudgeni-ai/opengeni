---
"@opengeni/db": minor
"@opengeni/core": minor
"@opengeni/contracts": minor
---

App use is paid from monthly plan credit; API use (organization and personal API keys, products on the SDK, outside agents over MCP) is paid from credits only. Each turn freezes its funding origin, sub-agents and tools inherit their chat's, and API work with no credits is refused with `402 api_credits_required` and an Add credits action (`1100_billing_usage_origin`, rolling). See `docs/billing-origin.md`.
