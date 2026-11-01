---
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/react-native": minor
---

Meetings from audio recorded elsewhere, such as a phone call recorded with the phone's own record button or a voice memo. Share it to the app, or pick it with the phone Meetings list's new Import a recording button, and it becomes a meeting with a transcript and notes. It is saved on the phone first and uploaded in the background.

- `useRecorder().importAudio(...)` (React) makes a meeting from a file.
- `@opengeni/react-native/meetings` adds `useSharedAudioImport`, `sharedAudioRedirect` for expo-router's `+native-intent`, `importAudioFile`, and the config plugin option `audioImport: true`. With that option, iOS accepts audio documents and Android shows the app under "Open with" for audio.
- `uploadRecordingAudio` reads an M4A file's length and recording date from its header when they aren't given (`audioFileDurationMilliseconds`, `audioFileCreatedAt`), and its recording now ends after the audio's length rather than when the upload started.
