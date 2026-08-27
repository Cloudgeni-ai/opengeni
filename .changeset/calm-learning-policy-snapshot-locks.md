---
"@opengeni/db": patch
---

Prevent accepted-attempt workspace learning-policy snapshots from deadlocking with ordinary session lifecycle writers. The snapshot function now locks the workspace, session, turn, and attempt explicitly in the canonical order, then revalidates the complete live-attempt and interruption tuple in a fresh statement before deriving the immutable policy snapshot.
