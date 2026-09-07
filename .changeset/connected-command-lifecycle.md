---
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Retire background-command tracking after a connected agent instance is replaced, explicitly stopped, or revoked. Preserve historical records without waking old sessions, drain cleanup batches promptly, and scope session stopping counts to the requested trees.
