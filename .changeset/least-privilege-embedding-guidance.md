---
"@opengeni/core": patch
"@opengeni/contracts": patch
"@opengeni/sdk": patch
---

The `firstPartyMcpPermissions: []` rejection now points to `firstPartyMcpTools: []` for zero reachable first-party authority, and the SDK documents that per-chat `agentLearning` overrides need a human principal.
