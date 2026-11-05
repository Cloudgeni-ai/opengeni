---
"@opengeni/contracts": patch
"@opengeni/runtime": patch
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
"@opengeni/react": patch
---

A Modal sandbox whose drain snapshots keep failing no longer drains until the provider kills it. After three failed snapshots over at least 15 minutes (or one inside the pre-deadline save window) the drain saves the workspace without rebuildable folders such as `node_modules`, `.next`, `.venv` and caches (`omittedPaths` on the archive descriptor); the chat shows which folders were left out and the next turns' model input carries a note to rebuild them. The drain stops the box itself when that save fails or cannot be stored after an hour of failures or near the box's lifetime limit, or when near that limit it is still running at the end of the wait or cannot be tried at all; the chat then shows "Files changed after {time} couldn't be saved before this chat's workspace machine shut down." A re-armed box's drain failures no longer carry over to its next drain. New counter `opengeni_sandbox_drain_capture_fallback_total{backend,outcome}`.
