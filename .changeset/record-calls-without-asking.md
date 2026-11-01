---
"@opengeni/desktop": minor
"@opengeni/sdk": minor
---

Desktop meeting detection can record calls without asking. With the new "Record without asking" switch on (off by default), a call in a call app starts recording by itself, a card in the corner says so with a Stop recording button, and the recording stops when the call ends. A meeting in a browser still asks first. `DesktopMeetingDetectionStatus` gains `autoRecord`, `update` accepts it, and `MeetingWords` gains the optional `recordingStarted`, `callRecording` and `ok`, which fall back to English.
