---
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
"@opengeni/sdk": patch
---

A workspace can now say how long it keeps meetings. `settings.recordings.retention` takes `transcriptDays`, after which a meeting is deleted with its audio and transcript, and `audioDays`, after which only its audio is deleted (0 deletes it as soon as the transcript is ready). Both count from when the meeting was recorded and apply to meetings recorded earlier too; audio can't be kept longer than the meeting. The worker applies them every few minutes. A meeting whose audio was deleted says when in `audioDeletedAt`, keeps its transcript and speakers, and can't be played or transcribed again (409 `audio_deleted`). The web settings have Keep meetings and Keep audio, with a confirmation before a change deletes anything sooner. Migration 0946 adds the column and the sweep's inventory, whose runtime EXECUTE grant follows in a later release.
