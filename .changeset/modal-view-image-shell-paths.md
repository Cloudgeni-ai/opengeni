---
"@opengeni/runtime": patch
"@opengeni/observability": patch
---

On Modal sandboxes, `view_image` now reads any file the agent's own shell can read, such as a page `pdftoppm` just rendered to `/tmp`, the same as on Connected Machine and compute sandboxes. Paths resolve the way the shell resolves them (absolute as given, relative from the workspace root) and are read with the box's own file read, which also removes one validation round trip per image. A path the SDK refuses on a caller-addressed file operation is now counted as `outcome="rejected"` in `opengeni_sandbox_operations_total` instead of `failed`, so it no longer trips the sandbox operation failure-ratio alert.
