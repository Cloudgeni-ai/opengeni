---
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

A meeting's audio is now kept as one compact file per track: Opus at 16 kbit/s mono in MP4, about 7 MB an hour. Before, a meeting kept both its uploaded one-second pieces and a full prepared copy at 30 to 66 kbit/s. Once the compact file is stored, the worker deletes the track's uploaded pieces, and re-runs and speaker matching read the compact file. Models that name no audio formats get the same Opus in WebM. Existing meetings are converted by the retention sweep once a later release grants its new inventory (migration 1239 withholds it for one release). Dictations are unchanged.
