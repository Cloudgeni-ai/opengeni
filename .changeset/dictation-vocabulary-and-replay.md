---
"@opengeni/api-router": minor
"@opengeni/core": minor
"@opengeni/worker-bundle": minor
"@opengeni/desktop": minor
"@opengeni/react": minor
"@opengeni/sdk": minor
"@opengeni/agent-host": patch
---

Dictation listens for a vocabulary, and dictation from anywhere keeps each dictation's speech to play and transcribe again.

- A dictation recording's `transcription` takes `keyterms` as well as `language`. The worker passes them to the voice input model when it takes keyterms: ElevenLabs Scribe and Azure Speech as keyterms, OpenAI and Azure OpenAI as the prompt (their text models now report `keyterms: true`, so meetings on them listen for keyterms too).
- `useVoiceInput` takes `keyterms` and `onAudio`, which hands over each dictation's microphone audio with its text, and returns `transcribe(blob)` to transcribe audio kept earlier as a new dictation.
- `@opengeni/sdk/recordings`: `uploadRecordingAudio()` uploads finished audio as a one-track recording.
- `@opengeni/desktop/dictation`: settings gain `vocabulary`, `retryShortcut` (transcribes the last dictation again and types it) and `cancelShortcut`; the status reports `actionShortcutErrors`. The history keeps each dictation's speech on the computer (private to the person, deleted with the history), and `historyAudio(id)` and `transcribeAgain(id)` play and re-transcribe it. While dictation is on, the app opens at login.
- `DesktopDictationSettings` offers the vocabulary, the retry and cancel shortcuts, and Play and Transcribe again on each recent dictation.
