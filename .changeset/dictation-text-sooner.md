---
"@opengeni/api-router": patch
"@opengeni/sdk": patch
"@opengeni/react": patch
"@opengeni/worker-bundle": patch
---

Dictated text arrives sooner after you stop. `GET /recordings/:id/transcripts` takes `waitSeconds` (at most 25) and an optional `waitFor` version, and answers the moment that version (or the newest) is complete or failed instead of at once; `listRecordingTranscriptVersions` passes them, and `useVoiceInput` waits this way instead of checking every second. The worker also downloads a track's uploaded pieces 16 at a time when preparing its audio, instead of one after another. A dictation longer than 25 seconds is cut at the speaker's pauses into pieces of about 15 seconds (never more than 50), found in its decoded 16 kHz audio, and all pieces are heard at once, at most 8 together, so a long dictation is ready about as soon as a short one. Before, it was cut every 50 seconds wherever that fell, and the pieces were heard one after another.
