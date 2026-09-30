---
"@opengeni/db": patch
---

Lock the workspace before validating usage-event execution identities, preventing accounting inserts from deadlocking against session lifecycle writers. The rolling migration preserves execution validation, runtime authority, and retained usage history.
