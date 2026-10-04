---
"@opengeni/db": patch
---

Avoid recursive settlement projections for single leaf-session reads and reuse the same statement's complete root control node instead of recursively walking root ancestry. Child detection and direct summaries share one PostgreSQL statement snapshot; nonleaf summaries, nonroot ancestry and writer fences retain their existing recursive behavior.