---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Workspace archive spools no longer pile up in TMPDIR when a worker stops while a capture, upload or restore is in flight. Each spool directory now records its owner process, a normal exit removes the live ones, and the next worker start (or its first capture) removes spools whose owner process is gone. Spools of live workers sharing the same TMPDIR are never touched.
