---
"@opengeni/sdk": patch
"@opengeni/contracts": patch
"@opengeni/config": patch
"@opengeni/core": patch
"@opengeni/runtime": patch
---

Agent configuration is always on. The `OPENGENI_AGENT_CONFIG_ADMISSION_ENABLED` and `OPENGENI_AGENT_CONFIG_DEFAULT_FOR_NEW_SESSIONS` settings are removed: `agent` is admitted on every surface, and a top-level session that omits it resolves to the workspace default or `{ capabilities: "all" }`. The client config still reports `agentConfig.enabled` and `defaultForNewSessions` (deprecated, always `true`).
