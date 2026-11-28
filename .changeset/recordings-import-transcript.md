---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/react-native": patch
---

Meetings can be imported from a text transcript: `POST /v1/workspaces/:workspaceId/recordings/import-transcript` (`ImportRecordingTranscriptRequest`, and `importRecordingTranscript` on `OpenGeniRecordingsClient`) makes a ready meeting with no audio, its speakers named as given, and the same built-in notes a recorded meeting gets. Its transcript version has `providerId: "import"` and `model: "text"` (`recordingTranscriptImported`); transcribing it again answers 409 `no_audio`. The web and phone meeting pages show "Imported transcript" where the model's name would be, and no player, audio notice or Transcribe again for it.
