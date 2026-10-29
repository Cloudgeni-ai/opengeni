---
"@opengeni/worker-bundle": patch
---

A dictation's text no longer waits for the worker to store its prepared audio. That copy was only ever used for meeting playback and re-runs, and a dictation is deleted soon after, so writing it put a slow or busy object store between the person and their text. The worker now builds the dictation's audio from its uploaded chunks and transcribes it straight away. Meetings still store their prepared audio as before.
