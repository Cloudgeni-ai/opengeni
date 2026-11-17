---
"@opengeni/contracts": patch
"@opengeni/sdk": patch
"@opengeni/runtime": patch
"@opengeni/core": patch
"@opengeni/react": patch
---

When a tool needs access that a fixed-access account (for example one managed through Nango) cannot be given, the chat now shows "{provider} can't do this with the connected account" with no step-up. The `tool.auth_needed` notice keeps the legacy-safe reason `unsupported_auth`, so older clients show the tools as unavailable, and adds `accountReason: "account_scope_fixed"` with the scopes the tool needs.
