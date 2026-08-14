---
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Deduplicate scheduled alert deliveries onto one atomic responder session per canonical alert occurrence while preserving separate roots for distinct and reopened occurrences.