---
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/worker-bundle": patch
---

A meeting recorded with computer or tab audio now tells apart the people in the room with the person recording. Before, its microphone was never diarized and every word on it was named after the owner, so someone sitting next to them disappeared into the owner's speaker. Now every track is diarized. One voice on the microphone is still the owner. With several, the owner's voice is the one matching their remembered voice when the workspace recognizes voices, else the one that spoke the most, and the others become `Speaker 1`, `Speaker 2`…. Echo removal runs first, so the call's echo never counts as the owner. The owner's voice vector is now kept under `track-N` too. Diarized labels are numbered across the whole recording (`speaker_0`, `speaker_1`, …) instead of per track with a `t1_` prefix, so two tracks no longer both show a "Speaker 1". `RecordingTrackPlan` now has `recorderLabel` instead of `fixedLabel` and `diarize`, `RecordingTrackWords` has `recorder` instead of `fixedLabel`, and `withRecorderVoice` (core) plus `memberVoiceprints`, `voiceMatchingVoiceprints` and the `KnownVoice` type (db) are new exports. Re-run a transcript to apply this to an earlier meeting.
