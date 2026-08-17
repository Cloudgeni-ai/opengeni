---
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/react": patch
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Reduce turn-start overhead without reducing admitted history, rig variables, or
user-visible content. Active history loads in one admitted query, automatic
compaction skips duplicate history work below threshold, unchanged Codex
credential pointers avoid redundant session-activity writes, rig defaults
load at bounded concurrency for admitted worker attempts, and the attempt-scoped
MCP wrapper no longer reuses a broader process-global tool list.

Improve large-session interaction by measuring rich-message disclosure without
a second React commit, showing truthful pending queue actions immediately, and
replacing the false zero-step placeholder with the session's real lifecycle.
