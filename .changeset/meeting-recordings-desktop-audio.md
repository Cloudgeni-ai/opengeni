---
"@opengeni/desktop": minor
"@opengeni/sdk": minor
"@opengeni/react": patch
---

Record other apps' audio in desktop meeting recordings. The desktop app ships a small native helper that captures what the computer plays, apart from the app's own sounds: a Core Audio process tap on macOS 14.2 and later, WASAPI process loopback on Windows 10 2004 and later, and the PulseAudio or PipeWire default monitor on Linux. `@opengeni/desktop` runs it per page and streams its samples over the new `systemAudio` bridge capability, and stops it when the page navigates away, closes or the app quits.

`@opengeni/sdk` adds `desktopSystemAudioSource`, which turns those samples into a `MediaStreamTrack` the recorder records as its own track, `displaySystemAudioSource` for the browser's shared tab or screen audio, and `defaultSystemAudioSource`, which picks the desktop helper when the app offers it. `RecorderOptions.systemAudioSource` overrides the choice, `RecorderPlatform.systemAudioKind` says which one a recorder uses, and capture failures are reported as the exported `RecorderCaptureError`. `useRecorder` from `@opengeni/react/recordings` exposes `systemAudioKind`.
