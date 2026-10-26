---
"@opengeni/contracts": patch
---

Knowledge lists without search text now return the most recently updated entries first, and collections by their latest change inside them. `KnowledgeEntrySummary` gains an optional `lastChangedAt` with that time. Search keeps relevance order, and a `createdSince` window orders by creation time.
