---
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/core": patch
"@opengeni/sdk": patch
"@opengeni/react": patch
"@opengeni/worker-bundle": patch
"@opengeni/api-router": patch
---

Meetings can recognize people by voice. It is off by default. When a workspace turns on `settings.recordings.voiceprints`, each diarized speaker's voice vector is kept with the transcript. People who agreed to be remembered get a voiceprint learned from the speakers named as them, and new transcripts suggest them by name with a confidence. The new routes are `PUT` and `DELETE /v1/workspaces/:workspaceId/recording-people/:personId/voice`. A member agrees with `self` consent, and someone from outside the workspace with `attested` consent. Turning the setting off forgets every voice. `PATCH …/speakers` takes `rejectSuggestions` to turn a suggestion down. The SDK adds `rememberRecordingPersonVoice` and `forgetRecordingPersonVoice`, `useRecordingPeople` adds `rememberVoice` and `forgetVoice`, and `useTranscript` adds `rejectSuggestion`.
