---
"@opengeni/sdk": patch
"@opengeni/react": patch
---

Make fresh session reads generation-aware, expose authoritative detail and list read revisions plus causal read generations, and keep retained pagination and independently polled pinned projections from overriding newer session channel authority.