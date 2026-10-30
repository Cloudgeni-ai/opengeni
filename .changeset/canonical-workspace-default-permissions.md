---
"@opengeni/db": patch
---

Issue canonical secret permissions in default workspace grants, managed personal-workspace projections and new MCP OAuth grants instead of the retired Variable Set aliases. OAuth exchanges and refresh rotation canonicalize successor tokens, and live permission intersections compare equivalent names. Effective secret access is unchanged. Existing accepted turn, schedule and token snapshots retain their original authority and bytes.
