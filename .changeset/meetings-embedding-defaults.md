---
"@opengeni/contracts": minor
"@opengeni/react": minor
"@opengeni/react-native": minor
---

Products that embed meetings get the workspace's own choices without extra wiring, and a meetings-only phone app no longer gets call setup.

- The recorder on `MeetingsListPage` (web) and `MeetingsList` (React Native) starts with the live transcript on when the workspace's `recordings.liveTranscript` setting says so. `GET /v1/workspaces/:workspaceId/recording-models` now returns `liveTranscript`, and `useRecordingModels` returns it too (undefined until the server answers, or from an older server). A host's own `liveTranscriptDefault` still wins; before, a host that passed none always started with it off, and a phone app had no way to follow the setting at all.
- The Expo config plugin sets up calls only when asked: `["@opengeni/react-native", { "recording": true }]` now adds just the background recording setup, without the `voip` background mode, the `INStartCallIntent` activity or the generated Siri and Shortcuts intent. Add `call` to set up calls as well, or pass `"call": false` to leave them out of any entry. The plugin without options still sets up calls, as before.
- On phones, "No sound is reaching the microphone" no longer appears during ordinary pauses. It now shows only when a recording has delivered digital silence since it started or resumed, which is what a muted, blocked or broken microphone delivers; a microphone that has picked up any sound is working, however long the pause.
