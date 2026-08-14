---
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Deduplicate scheduled alert deliveries onto one atomic responder session per scheduled task and canonical alert occurrence while preserving separate roots for distinct tasks and reopened occurrences.