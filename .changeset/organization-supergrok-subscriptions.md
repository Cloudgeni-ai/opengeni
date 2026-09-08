---
"@opengeni/db": minor
"@opengeni/contracts": minor
"@opengeni/sdk": minor
---

Add organization SuperGrok subscription pools with multiple accounts, active selection, rotation, and shared/Personal workspace inheritance. Preserve the exact subscription scope of accepted work and organization-only management authority. Unify Codex and SuperGrok account rows and connection actions in the web settings.

Maintenance migration 0423 requires draining API and workers before upgrading. Older workers cannot parse the organization subscription scope.
