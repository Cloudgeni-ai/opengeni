---
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/react": patch
---

Removing a repository from a chat with many sub-sessions answers at once: only the sub-sessions that hold the repository are changed one by one, and the rest get their removal record in batches. The Remove button in the confirmation works right away instead of waiting for the unsaved-changes check.
