---
"@opengeni/db": patch
"@opengeni/core": patch
---

Two workspaces can now add the same Microsoft Dynamics environment. A workspace's Dynamics entry no longer stores its address in the catalog's `mcp_url` column, which is unique across workspaces, so adding an environment another workspace already uses no longer fails with an internal error. Reads still return the address as `mcpUrl`.
