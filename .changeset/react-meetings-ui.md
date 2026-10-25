---
"@opengeni/react": minor
---

New `@opengeni/react/meetings` entry: the ready-made Meetings UI the console uses, so products can embed it. It has `MeetingRecorderProvider` (one recorder above the routes, which also carries out the desktop app's call notifications through `onOpenMeetings` and `onOpenMeeting`), `MeetingsListPage`, `MeetingDetailPage`, `MeetingDefaultsView`, and the pieces they are built from (`RecorderPanel`, `MeetingTranscript`, `MeetingPlayer`, `LiveTranscript`). Pages navigate through callbacks, so any router works. `@opengeni/react/testing/meetings` adds an in-memory recordings client for previews and tests.
