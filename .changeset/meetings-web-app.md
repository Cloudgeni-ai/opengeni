---
"@opengeni/react": minor
---

The web app has a Meetings page. Record a meeting from the browser (microphone, optionally with a tab's audio), keep working elsewhere in the workspace while it records and uploads, then read the transcript, play the audio, name who spoke, correct a turn, and transcribe again with another model.

`@opengeni/react/recordings` exports `useRecordingsClient`, which returns the recordings client the hooks use, for calls no hook wraps.
