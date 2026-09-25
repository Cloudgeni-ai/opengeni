---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

A model tool call to `knowledge_search` (first-party and Docs MCP) or `knowledge_prepare_save` now receives a compact copy of the result: the same JSON without timestamps, rank score, revision lineage, session and review-batch IDs, default-valued flags, a collection descriptor's `revisionId`, or a `revision.preview` whose complete text already appears in the title or an excerpt. Every entry and collection ID, `version`, `revision.id`, scope, publication status, title, kind, group and parent ID, description, excerpt, index status and cursor is kept, and a preview with unique text is kept in full. Codemode scripts and every other programmatic caller still receive the exact result. The projection runs at the existing per-caller seam (`projectAttemptToolResultForCaller`, which gains an optional tool identity) before the 1 MiB model cap, affects only new tool outputs, and passes any result that does not strictly match the contract through unchanged. On fixtures sized to staging medians a search result shrinks by 44% and a save preparation by 35%.
