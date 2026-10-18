---
"@opengeni/core": patch
"@opengeni/db": patch
---

Read execution-time provider catalog inputs in one scoped transaction instead of repeating serial catalog and connection-list queries. Turn startup and stateless model calls share the same settings-building path. Catalog ordering, retained-model handling, live workspace credential checks and selected model policy remain unchanged; no data is cached across executions.
