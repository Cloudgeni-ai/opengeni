---
"opengeni": patch
"@opengeni/sdk": patch
"@opengeni/contracts": patch
---

Console agents as code: `opengeni agents deploy <dir>` deploys `agents/<key>.yaml` files to an organization (`--dry-run`, `--publish`, `--move-running-chats`, `--json`) and `opengeni agents export <key>` writes one back; the package ships the agent file JSON Schema (`schemas/agent.schema.json`). The SDK adds `@opengeni/sdk/organization-agents` (`organizationAgents()`, `defineAgent()`, end-user tool logins), accepts an organization agent in session create (`agent: "<key>"` or `{ ref, ... }`, `agentOverrides`) and reads `Session.orgAgent`. The session proxy drops an organization agent sent by the browser; name it in `createSession`.
