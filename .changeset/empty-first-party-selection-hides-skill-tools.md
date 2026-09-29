---
"@opengeni/worker-bundle": patch
"@opengeni/contracts": patch
"@opengeni/sdk": patch
---

A session whose effective first-party tool selection is empty (for example `firstPartyMcpTools: []`) no longer receives the in-process Skill-management tools (`skill_search`, `skill_install`, `skill_save`, `skill_publish`, `skill_remove`, `skill_checkout`). Read-only `skill_read` remains so selected Skills still load. Non-empty selections are unchanged.
