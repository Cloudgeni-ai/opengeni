---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

The workspace fingerprint, content manifest and size walk on compute and OpenSandbox now leave out leftover top-level `.opengeni-old-*` and `.opengeni-restore-*` restore folders, exactly as those backends' workspace archives always have. A save taken while a failed cleanup had left one behind can now be restored and verified; before, its fingerprint counted files the archive never held, so the restore could never verify. Both sides read one list (`workspaceArchiveExcludedGlobs` on the session), so what the archive skips and what verification covers cannot drift apart again. Saves taken without such a folder keep the same fingerprint.
