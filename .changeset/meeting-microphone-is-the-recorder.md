---
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/react": minor
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
---

A meeting recorded with computer or tab audio now names its microphone after the person recording. Each new transcript version gives the microphone speaker the owner's person in the speaker directory, added for them if they have none, as "It's me" does, with `source: "track"` and no confidence, so it doesn't read as a voice suggestion. A name someone gave that speaker carries over through every later version instead (before, one that had already carried over once could be replaced), and a microphone alone stays diarized as Speaker 1, 2…. The naming enrolls nobody's voice: it gives no agreement, and an unconfirmed `track` speaker never teaches a voiceprint. Starting such a recording adds the owner to the directory, so the live preview shows the microphone under the owner's name to everyone watching (the person recording sees their own) and the computer or tab audio as "Others". New exports: `recordingMicrophoneIsOwner` (contracts), `ownerLiveLaneName` (react), `workspaceMemberDisplayName` and the `TrackSpeaker` type (db); `MeetingsListPage` and `RecorderPanel` take an optional `viewerName`, and `createRecording` an optional `ownerName`.
