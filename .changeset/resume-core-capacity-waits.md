---
"@opengeni/db": patch
---

Resume now wakes sessions waiting on shared subscription capacity. Session and workspace Resume registered a wake only for legacy Codex waiters, so a session paused while waiting on capacity stayed `waiting_capacity` after Resume until an unrelated capacity change happened to wake it. Paused waiters also no longer start a workflow run on every capacity change, and a rolling migration wakes unblocked waits that were already resumed without a wake.
