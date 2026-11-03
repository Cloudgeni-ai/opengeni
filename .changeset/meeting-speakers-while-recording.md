---
"@opengeni/api-router": patch
"@opengeni/core": patch
"@opengeni/worker-bundle": patch
---

A meeting's speakers are told apart while it is still being recorded, so its transcript is ready sooner after it ends. While a meeting records, the worker goes through each audio track's new audio every minute or so (at most five minutes behind in a long meeting) and keeps the voice windows it found beside the audio; when the meeting ends, speaker detection only goes through what came after the last scan. Before, all of it was gone through after the end, which for an hour-long meeting took minutes. Results are the same either way. The kept windows are deleted once the transcript is made, and with the meeting's audio. The workflow client gains an optional `startRecordingSpeakerScan`; without it speakers are told apart only after the meeting ends, as before.
