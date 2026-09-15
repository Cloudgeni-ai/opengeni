---
"@opengeni/db": patch
"@opengeni/runtime": patch
---

Retain background command outcomes without starting a new agent turn unless the session is explicitly waiting for input. Let compatible command notices accompany later input without blocking messages behind a command backlog. Coalesce different originating turns only when their resolved human and complete inherited execution authority match, retaining original lineage and existing batch limits.