---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

The workspace fingerprint, content manifest and size walk on compute and OpenSandbox now leave out leftover top-level `.opengeni-old-*` and `.opengeni-restore-*` restore folders, exactly as those backends' workspace archives always have. A save taken from now on while a failed cleanup has left one behind can be restored and verified; before, its fingerprint counted files the archive never held, so the restore could never verify. Saves already recorded beside such a folder still can't verify. The archive and the verification read one list of these folders and apply one check to it, so what the archive skips and what verification covers cannot drift apart again. Saves taken without such a folder keep the same fingerprint.
