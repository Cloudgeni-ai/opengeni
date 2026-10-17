---
"@opengeni/browserd": patch
---

A managed browser relaunched on its existing profile now gets its tabs back after the previous browser was killed, lost with its host, or copied while running (working-copy adoption). Chromium skips `--restore-last-session` when the profile's last run did not exit cleanly, so these relaunches opened a single blank tab. The supervisor now records that last run as a normal exit before such a relaunch, and Chromium restores the last session.
