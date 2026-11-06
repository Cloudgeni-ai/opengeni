---
"@opengeni/db": patch
"@opengeni/react": patch
"@opengeni/worker-bundle": patch
---

A command waiting for a workspace machine that is being saved, replaced or moved now settles as not started instead of "side-effect outcome unknown". This covers, for example, a Modal box replaced because it could not start programs. The model and the person both see "The command was not started because the workspace machine was not ready. Nothing ran, so it is safe to run it again." A command that had already reached the machine keeps the unknown-outcome receipt. The command row in the timeline now shows such a receipt as its sentence instead of raw JSON.
