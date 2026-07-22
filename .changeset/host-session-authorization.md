---
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/api-router": minor
---

Add a host-owned session authorization port for embedded deployments. The port
receives server-resolved root lineage and live agent-attempt authority, scopes
session listing inside database queries, distinguishes exact from whole-tree
projection access, gates HTTP/core/first-party MCP/Toolspace surfaces, and
periodically reauthorizes idle SSE streams while standalone deployments retain
their existing behavior when the port is unset.
