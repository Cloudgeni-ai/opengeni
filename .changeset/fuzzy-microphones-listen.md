---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
---

Add a workspace-accepted, provider-agnostic transcription policy and host-adapter contract, plus an accessible composer microphone that keeps partials ephemeral and appends non-empty accepted finals to the editable draft exactly once. Policies explicitly accept automatic language detection and speaker diarization, events can carry strict neutral result metadata, pending starts and cleanup are abortable/bounded, and adapter failures stay behind controlled UI copy with redacted non-UI diagnostics.
