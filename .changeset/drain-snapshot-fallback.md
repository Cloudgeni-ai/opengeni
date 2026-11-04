---
"@opengeni/contracts": patch
"@opengeni/runtime": patch
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
"@opengeni/react": patch
---

A Modal sandbox whose drain snapshots keep failing no longer drains until the provider kills it. After three failed snapshots (or one inside the pre-deadline save window) the drain saves the workspace without rebuildable folders such as `node_modules`, `.next`, `.venv` and caches (`omittedPaths` on the archive descriptor); the chat shows which folders were left out and the next turns' model input carries a note to rebuild them. If that save fails too near the box's lifetime limit or after an hour of failures, the drain stops the box itself and the chat shows "Files changed after {time} couldn't be saved before this chat's workspace machine shut down." New counter `opengeni_sandbox_drain_capture_fallback_total{backend,outcome}`.
