---
"@opengeni/contracts": patch
"@opengeni/core": patch
"@opengeni/sdk": patch
"@opengeni/react": patch
---

Meetings can have a language. A workspace sets the language new meetings are in (`recordings.language`), the recorder picks one per meeting, and both the live transcript and the final transcript use it. The live transcript hears only a few seconds at a time, so detecting the language can drift there, which a named language prevents. In a request, `transcription.language: null` detects the language even when the workspace names one (`RecordingTranscriptionRequest`). ElevenLabs gets Norwegian Bokmål and Nynorsk as Norwegian, the one Norwegian it knows. `useRecorder().start()` also accepts `transcription` for one recording. On a meeting page, a speaker can be named "It's me", which links the name to your account so your own voice can be remembered, and naming yourself offers to remember it. When the workspace doesn't recognize voices, naming someone says once that names won't carry over to later meetings.
