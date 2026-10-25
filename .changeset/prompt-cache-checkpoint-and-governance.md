---
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Fewer prompt-cache misses. Claude portable checkpoints and Codex remote compaction now send the exact ordinary request withheld at the compaction boundary, so they extend the cached request instead of re-projecting history that diverged at the first tool disclosure. Workspace governance moves from the system prompt to a durable history item written before the turn that first sees a new value, and Codex cache affinity is keyed by the session scope subject, so recovery attempts, steers and turns by other people no longer rewrite the start of every request. Each model call fact now records a request fingerprint, Claude's dropped-thinking counts and a warm-miss class in `prompt_cache_diagnostics`, with matching worker metrics.
