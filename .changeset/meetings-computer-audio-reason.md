---
"@opengeni/sdk": minor
"@opengeni/react": patch
---

When the desktop app can't record computer audio, the recorder now says why in the viewer's language instead of showing the desktop app's English sentence under a translated title. The recorder's `error` carries a new optional `reason` (`permission_denied`, `sound_server_unavailable`, `unavailable` or `capture_failed`, the desktop bridge's codes), and `RecorderCaptureError` has the same `reason`. The meetings recorder maps each one to its own message: macOS points to Screen & System Audio Recording in System Settings, Linux says no sound server is running, and the others suggest recording without computer audio. New message keys: `meetings.recorderPanel.computerAudioIsnTAllowed`, `allowThisAppToRecordComputerAudio`, `noSoundServerIsRunning`, `thisComputerCanTRecordItsOwnAudio` and `computerAudioDidnTStart`. The recorder's track labels now size to the longest label, so a longer translation of "Computer audio" is no longer cut off, and the level bars line up.
