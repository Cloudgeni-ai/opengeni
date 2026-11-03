---
"@opengeni/desktop": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
---

A meeting being recorded shows in the desktop app's menu bar (the tray on Windows and Linux). While one records, the icon becomes a recording badge (a dictation under way still shows its own icon first), and the menu starts with the meeting: whether it records or is paused, for how long, its name (or when it started), and the account it records in when the window shows another. "Open Live Transcript" brings that account up and opens the meeting; "Stop Recording" stops it. Nothing about meetings shows while none records. `DesktopMeetingDetection.setRecording()` takes an optional `DesktopRecordingMeeting` (title, recorded time, paused), and `DesktopMeetingRequest` adds `{ kind: "open" }`, sent only to a page that described its recording. The meeting recorder in `@opengeni/react` describes its recording and opens it on `open`. `MeetingDetection` adds `recording()`, `onRecording()`, `openRecording()` and `stopRecording()`.
