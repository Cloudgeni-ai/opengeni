---
"@opengeni/db": patch
---

Take the workspace identity lock before Codex lease session and turn locks, preventing allocation deadlocks with queued workspace writers while preserving exact attempt and credential authority.