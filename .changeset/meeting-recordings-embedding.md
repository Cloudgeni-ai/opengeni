---
"@opengeni/sdk": minor
"@opengeni/react": minor
---

Embed meeting recording. `@opengeni/sdk/recordings` adds `OpenGeniRecordingsClient` for the recordings API, a local-first `RecordingUploader` that stores chunks on the device before uploading them straight to storage and finishes recordings left behind by an earlier page, IndexedDB and in-memory chunk stores, and `createBrowserRecorder` for microphone plus shared tab or system audio as separate tracks. `@opengeni/react/recordings` adds `useRecorder`, `useRecordings`, `useRecording`, `useTranscript`, `useRecordingPeople` and `useRecordingModels`. Recording response shapes are now published contract schemas.
