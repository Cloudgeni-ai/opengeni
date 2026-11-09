---
"@opengeni/contracts": minor
"@opengeni/db": patch
"@opengeni/react": minor
"@opengeni/react-native": patch
---

A meeting transcript now says where a track recorded nothing, such as "No microphone audio from 17:39 to the end". Before, a microphone that was unplugged or tab sharing that ended left a voice missing with no explanation, so the transcript looked like it had skipped speech. Each track's new `unrecorded` field lists those stretches. The server works them out from the chunks' start times when a recording is finalized (migration 1353 adds the column). Older meetings get them the next time they are transcribed. Stretches under two seconds are ignored. The web and phone transcripts show a quiet line where each one starts. `@opengeni/react/recordings` exports `transcriptUnrecordedMarks`, `interleaveUnrecordedMarks` and `unrecordedMarkText` for embedders that render their own transcript.
