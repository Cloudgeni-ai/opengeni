---
"@opengeni/worker-bundle": patch
---

Every `agent.model.usage` event now records why the worker made the call: `purpose` is `main` for the turn's own inference (including the aggregate fallback), `compaction` for the context summarizer and `session-title` for the title call. Source keys, billing, credits and metrics are unchanged. Events written before this release have no `purpose`.
