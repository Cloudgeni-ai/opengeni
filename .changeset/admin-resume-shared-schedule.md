---
"@opengeni/core": patch
"@opengeni/api-router": patch
---

A workspace admin who can turn off someone else's Workspace schedule or agent trigger can now turn it back on. Before, pausing worked but resuming was refused as owner-only. Resuming changes nothing else, so it runs as its owner again; changing or running it still belongs to its owner.
