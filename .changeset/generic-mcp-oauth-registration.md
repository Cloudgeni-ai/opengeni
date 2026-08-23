---
"@opengeni/api-router": patch
---

Prefer OAuth Dynamic Client Registration whenever an MCP authorization server advertises both DCR and Client ID Metadata Documents. This avoids provider authorization failures caused by treating the metadata-document URL as a universally accepted client ID while retaining explicit provider-profile overrides for either registration mechanism.