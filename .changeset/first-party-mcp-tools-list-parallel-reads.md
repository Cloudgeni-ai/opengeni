---
"@opengeni/api-router": patch
"@opengeni/db": patch
---

A first-party MCP tool listing reads its tool surface (workspace settings, model catalog, Memory selector and admin access) together and alongside the bound-session check, and an agent attempt's learning policy alongside its liveness check. Authorization still decides before anything is disclosed. The listing now waits on two rounds of database reads instead of nine, and no longer reads the workspace's control state and kind.
