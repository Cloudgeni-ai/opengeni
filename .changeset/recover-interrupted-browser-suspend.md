---
"@opengeni/browserd": patch
---

A managed browser whose browser process was killed while its controller was stopping relaunches on the same profile on next use instead of staying refused. The unfinished shutdown suspension is completed once the recorded process has provably exited and no process uses the profile; a browser that may still be live stays refused.
