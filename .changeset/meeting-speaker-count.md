---
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/react": minor
"@opengeni/worker-bundle": patch
---

A meeting's transcript can be told how many people spoke. `transcription.speakers` (1 to 32) on a recording or a transcript re-run makes Opengeni's speaker detection find exactly that many on a recording with one track, and is each track's upper bound when the recording has several. Models with their own diarization get it as their speaker count. The meeting page's "Transcribe again" asks for the "Number of speakers", also for models that rely on Opengeni's speaker detection, and "Wrong number of speakers?" under the speakers list opens it.
