---
"@opengeni/db": patch
"@opengeni/core": patch
---

Issue canonical secret permissions in default workspace grants, managed personal-workspace projections, new chat and schedule settings and new MCP OAuth grants instead of the retired Variable Set aliases. OAuth exchanges and refresh rotation canonicalize successor tokens, and live permission intersections compare equivalent names. Personal-resource discovery and grant gates require canonical secret permissions, retaining support for equivalent historical grants without rewriting them. Effective secret access is unchanged; explicit empty lists stay empty. Existing accepted turn, schedule and token snapshots retain their original authority and bytes.
