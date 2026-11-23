---
"@opengeni/runtime": patch
---

Restore streamed remote workspace archives that contain symlinks. A save stores the workspace's symlinks, but the streamed restore refused them, so any workspace with one could be saved and never restored. A failed hydration now logs why.
