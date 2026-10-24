---
"@opengeni/react-native": minor
"@opengeni/react": minor
"@opengeni/sdk": minor
"@opengeni/contracts": minor
"@opengeni/core": patch
"@opengeni/worker-bundle": patch
---

Record meetings on phones. `@opengeni/react-native` adds native microphone capture for iOS and Android that keeps recording in the background and writes AAC chunks to the device before they are uploaded, an on-device chunk store, and an Expo config plugin for the microphone permission and background audio. `useRecorder` from `@opengeni/react/recordings` takes a `platform`, so the same hook drives the browser and the phone recorder; the meeting list and transcript view models are shared from `@opengeni/react/recordings`.

The SDK's `RecordingUploader` no longer leaves a recording that captured no audio stuck uploading: it removes it, on the server and on the device, and reports `discarded`. Stopping a recording while a chunk is still being uploaded can no longer be lost. The worker accepts AAC tracks and remuxes them before transcription.

Speakers nobody named now read the same on the server and in every client: `defaultRecordingSpeakerName` from `@opengeni/contracts` gives "Speaker 2" for a diarized `speaker_1` and "Microphone" or "Shared audio" for a whole-track label, and the API's speaker `name` uses it. A speaker counts as named only when it has an assignment (`source` is set). Transcript versions report BCP 47 language tags, so ElevenLabs' `eng` is now `en`.

An upload refused with 401, 408, 425 or 429 is retried with backoff instead of failing, since a sign-in that loads late or is refreshed, a timeout or rate limiting doesn't make the recording bad. `useRecorder` sends its uploads through the latest client it was given, so a recorder created before the app's sign-in token loaded no longer uploads without it, and only the current recording updates what the hook shows.

`RecordingUploadStatus.created` says when the server has a new recording, so a list can refresh then and show it while it is still being recorded. `languageName` names ISO 639-2 codes such as `eng` on engines that don't canonicalize them, like Hermes.
