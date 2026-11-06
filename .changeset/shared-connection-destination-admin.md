---
"@opengeni/api-router": patch
---

Changing where a workspace-shared connection's credential is sent now needs integration administration (`capabilities:manage`) and a new credential in the same request. A `PATCH` to a shared connection that changes its `providerDomain`, `kind`, or `metadata.mcpUrl`, `metadata.resource` or `metadata.credentialRole` returns 403 for members without integration admin rights, and 400 when no replacement credential is supplied. Other edits to shared connections, and every edit to a member's own personal connections, work as before.
