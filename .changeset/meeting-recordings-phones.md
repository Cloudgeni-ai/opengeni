---
"@opengeni/react-native": minor
"@opengeni/react": minor
"@opengeni/sdk": minor
"@opengeni/contracts": patch
"@opengeni/worker-bundle": patch
---

Record meetings on phones. `@opengeni/react-native` adds native microphone capture for iOS and Android that keeps recording in the background and writes AAC chunks to the device before they are uploaded, an on-device chunk store, and an Expo config plugin for the microphone permission and background audio. `useRecorder` from `@opengeni/react/recordings` takes a `platform`, so the same hook drives the browser and the phone recorder; the meeting list and transcript view models are shared from `@opengeni/react/recordings`.

The SDK's `RecordingUploader` no longer leaves a recording that captured no audio stuck uploading: it removes it, on the server and on the device, and reports `discarded`. Stopping a recording while a chunk is still being uploaded can no longer be lost. The worker accepts AAC tracks and remuxes them before transcription.
