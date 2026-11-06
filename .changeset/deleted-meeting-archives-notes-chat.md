---
"@opengeni/worker-bundle": patch
---

Deleting a meeting archives its built-in notes chat and stops any work still waiting in it, so a notes chat that was waiting for model capacity no longer wakes up later to a meeting that is gone and ends asking someone to check access. A notes chat someone wrote in is theirs and stays as it is.
