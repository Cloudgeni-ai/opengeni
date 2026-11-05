---
"@opengeni/contracts": patch
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/sdk": patch
"@opengeni/worker-bundle": patch
---

A scheduled task created over the API can now choose the Opengeni tools and permissions of the chats it starts, as on session create: `agentConfig.firstPartyMcpTools` and `agentConfig.firstPartyMcpPermissions` (tools within the deployment's allowed set, permissions the creating credential holds). They are stored as the task's creator selection, set once at creation (an update that names them is refused) and never on an existing-chat task. Before, these fields were dropped and every run got the full default tool list. Tasks that don't name them keep following the defaults. The schedule tools agents use are unchanged: an agent's task keeps its own chat's selection. A run of an ownerless task (created by a key or service, not as a person) is no longer offered `notify_user`, `notification_withdraw`, `inbox_tidy` or `call_user`, since nobody could receive them, and its chat keeps that exact tool list. Owned tasks' runs still notify their owner.
