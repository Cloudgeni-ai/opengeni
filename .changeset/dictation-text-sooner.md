---
"@opengeni/api-router": patch
"@opengeni/sdk": patch
"@opengeni/react": patch
"@opengeni/worker-bundle": patch
---

Dictated text arrives sooner after you stop. `GET /recordings/:id/transcripts` takes `waitSeconds` (at most 25) and an optional `waitFor` version, and answers the moment that version (or the newest) is complete or failed instead of at once; `listRecordingTranscriptVersions` passes them, and `useVoiceInput` waits this way instead of checking every second. The worker also downloads a track's uploaded pieces 16 at a time when preparing its audio, instead of one after another.
