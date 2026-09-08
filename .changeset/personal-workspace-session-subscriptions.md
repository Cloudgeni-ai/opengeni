---
"@opengeni/db": patch
"@opengeni/api-router": patch
---

Allow Personal workspaces to inherit their organization's Codex subscription pool and select an explicit source while retaining organization-only credential management. Keep Personal session creation available when optional Only-me session tenancy is unavailable.

Activate inheritance through maintenance migration 0422 after draining old API and worker processes. Include Personal workspaces in organization Codex source-change protection and capacity wakeups.
