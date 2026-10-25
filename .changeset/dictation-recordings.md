---
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/core": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/react-native": minor
---

Composer dictation is now a recording with `purpose: "dictation"`, recorded, uploaded and kept by the same local-first pipeline as meetings, so a closed tab, a killed phone app, a dropped connection or a failed transcription never loses what was said. A dictation has one microphone track, is always private, is transcribed and billed as voice input, sends no webhook events, never appears with meetings, and is deleted a day after it is heard. `GET …/recordings?purpose=dictation` (and `listRecordings({ purpose })`) lists the caller's own kept dictations, so the next composer offers text an earlier page left behind.

`useVoiceInput` records through the recordings API when the client can and the deployment advertises `voiceInput.resumable`, inserts the text once (taking it deletes the dictation first, so two tabs never insert it twice), keeps anything longer than three seconds on Cancel or Escape, and hears a failed dictation again on Retry. It is also exported from `@opengeni/react/recordings`, and `useNativeDictation` in `@opengeni/react-native/recordings` brings the same dictation to phones on the native recorder. A client with only `transcribeAudio` records in memory and sends one request, as before. `ComposerTranscriptionControl` accepts `recordings` and `platform`; `createRecordingStore` and `createOwnerId` are deprecated and ignored.

The `transcription-recordings` routes and their SDK methods are deprecated, answer with `Deprecation` and `Sunset` headers, and are kept until January 26, 2027. See https://docs.opengeni.ai/integrate/meetings#moving-from-transcription-recordings.
