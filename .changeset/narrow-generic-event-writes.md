---
"@opengeni/db": patch
---

Avoid fetching frozen prompts, tool catalogs and session configuration when generic event appends and identity-only attempt mutations only need their existing narrow write fence. Locks, transaction boundaries, event payloads and authorization checks are unchanged; full-row callback contracts remain available.
