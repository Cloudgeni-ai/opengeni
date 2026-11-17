---
"@opengeni/react": patch
"@opengeni/api-router": patch
"@opengeni/runtime": patch
"@opengeni/capabilities": patch
"@opengeni/contracts": patch
"@opengeni/sdk": patch
---

A connected account that needs more access for a tool now shows "Give {provider} more access" with Allow in the chat instead of a connect card, and Allow finds the account even when it is homed in another workspace. Site tool readiness reports `grant` (with the scopes needed) for such tools, and `unavailable` with reason `account` when the account's access is fixed and cannot be extended.
