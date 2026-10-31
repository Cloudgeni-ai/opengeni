---
"@opengeni/config": minor
"@opengeni/contracts": minor
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/react": patch
"@opengeni/runtime": patch
"@opengeni/subscriptions": minor
---

Claude subscription models no longer disappear from a workspace when the Claude accounts serving it are not managed by that workspace. The catalog, model admission and cross-provider failover now count every Claude account that serves the workspace, the same accounts placement already used, for both the `workspace-claude-subscription/` and `organization-claude-subscription/` model ids. Readers also accept the upcoming canonical `claude/<model>` ids (provider `claude-subscription`), which a later release starts writing; the two legacy ids stay accepted as aliases.
