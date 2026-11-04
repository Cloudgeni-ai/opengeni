---
"@opengeni/desktop": patch
"@opengeni/sdk": patch
---

Stop recording on the desktop meeting card now stops the recording in the account where it started, even while the window shows another account. Before, the stop could go to the account on screen, which ignored it, and the meeting kept recording. If a recording hasn't stopped a few seconds after Stop, the app shows its account, asks it again and logs this. Meeting detection, system audio and dictation now forget a page only when it really leaves its document (a committed navigation, an error page or a lost renderer), not when a navigation starts and is cancelled, such as a link opened in the browser. With several accounts, the stop card names the account that records and the account menu marks it.

API: `MeetingDetection` and `createMeetingDetection` take optional `revealPage`, `describePage`, `recordingChanged` and `stopConfirmMs`. `MeetingDetection` adds `isRecording()`. The stop prompt has an optional `where`, `MeetingWords` an optional `callEndedIn` and `DesktopAccount` an optional `recording`. Code that declares a `Required<MeetingWords>` object must now include `callEndedIn`.
