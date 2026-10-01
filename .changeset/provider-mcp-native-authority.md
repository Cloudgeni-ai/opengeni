---
"@opengeni/runtime": patch
---

Exclude connection-backed MCP servers from credential-provider targeting and
header application, including historical turns without account-binding snapshots.
Native connection authentication and attribution cannot be replaced by provider
credentials, and native-denied targets are not disclosed to the provider.