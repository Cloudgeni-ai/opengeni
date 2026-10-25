---
"@opengeni/sdk": minor
"@opengeni/desktop": minor
---

The desktop app notices calls. When Zoom, Teams, Slack, Webex, FaceTime, Discord or a meeting in a browser starts using the microphone, a notification offers to record it; when the recorded call ends, another offers to stop. The bundled audio helper reports which processes use a microphone (`--watch-microphone`) on macOS 14 and later, Windows and Linux with PipeWire or PulseAudio, without asking for any permission. Pages get the new `meetingDetection` capability: `status()`, `update({ enabled })`, `setRecording()`, `onRequest()` and `onChange()`. The switch is on by default and stored per computer.
