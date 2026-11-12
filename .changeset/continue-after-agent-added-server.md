---
"@opengeni/db": patch
"@opengeni/api-router": patch
---

The agent now continues on its own after a person connects a server the agent asked to add (`custom_mcp_setup_request`, including Microsoft Dynamics environments), as it already does for catalog connect cards. That card is posted before the capability exists, so the continuation now also finds it by the capability's MCP endpoint.
