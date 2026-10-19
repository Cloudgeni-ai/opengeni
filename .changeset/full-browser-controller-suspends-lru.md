---
"@opengeni/browserd": patch
"@opengeni/api-router": patch
"@opengeni/db": patch
---

A machine's browser limit now follows its memory instead of a flat 64: half of the machine's memory (or its container's limit) at 300 MiB per browser, never under 8, so a 48 GiB machine runs 81 browsers and an 86 GiB one 147. `OPENGENI_BROWSERD_MAX_SESSIONS` still overrides it. When a new browser would exceed the limit, the least recently used browser that has been idle for at least five minutes is saved and stopped to make room; it resumes from its saved working copy the next time it is opened. Nothing changes below the limit.
