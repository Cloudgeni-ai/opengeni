---
"@opengeni/db": patch
"@opengeni/runtime": patch
---

Batch ordinary agent messages with compatible pending results when their originating turns have the same human and frozen access settings. Preserve each update's lineage and separate different access, unresolved origins, and Steer commands. Clarify that a child session's final answer is automatically delivered to its parent.
