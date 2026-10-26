---
"@opengeni/react": minor
"@opengeni/react-native": patch
---

A meeting recording no longer stops when the person switches to another workspace. The recorder stays with the workspace the recording started in until it stops, then moves to the workspace shown. On the web and in the desktop app the recorder is also kept through a dropped connection or an update. After Stop, a recording made in another workspace opens in its own workspace. `MeetingRecorderProvider`'s `onOpenMeeting` now also receives the meeting's workspace ID. `useMeetingRecorder()` returns the recorder's `workspaceId` and `openMeeting`, and `createMeetingRecorderStore` takes an optional second argument that opens a meeting in its workspace. `MeetingRecorderProvider` takes an optional `scope`, such as the signed-in person's id, for a host that mounts it above sign-in: a new value ends a recording at once, and null means nobody is signed in, so nothing records and a desktop "Record" request is not kept for whoever signs in next. The console passes the signed-in person, so signing out or another person signing in ends a recording at once. `MeetingRecorderStore`'s new `workspaceId` and `openMeeting` members are optional, so stores made by hand still type-check.

A transcript that failed because its model's provider has no key now names the model and that provider ("Scribe v2 needs ElevenLabs, which isn't connected…") and suggests trying another model, instead of saying that no transcription provider is connected. `transcriptErrorText` takes an optional third argument with the model's and provider's names.
