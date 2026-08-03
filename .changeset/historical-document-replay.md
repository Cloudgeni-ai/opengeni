---
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Replay historical three-field document indexing workflows by resolving the immutable stored authority tuple under exact account and workspace RLS before parser, embedding, status, or chunk writes.