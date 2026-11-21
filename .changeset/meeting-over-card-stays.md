---
"@opengeni/desktop": patch
---

When a recorded call ends, the desktop app's "Meeting over?" card now also posts a system notification saying the recording continues. Clicking it shows the recording. The notification goes away when the card is answered or the recording stops. The card stays until it is answered. If nobody answers for 10 minutes and no call is using the microphone, the recording stops by itself, and the card and a notification say "Recording stopped". If a call takes the microphone again while the card is up (a rejoin), the card goes away and is shown again when that call ends. Keep recording still keeps the recording going, and recordings started without asking still stop when their call ends.

When a meeting tab keeps the microphone after the meeting, the call never seems to end. If the recording is of a meeting on the active account's calendar, the same card now asks 5 minutes after the meeting's scheduled end. It doesn't stop the recording by itself while a call still holds the microphone, since the meeting may be running over.

`MeetingDetectionOptions` takes optional `notify` and `words`. `createMeetingDetection` posts Electron notifications through the new `postMeetingNotice`. `MeetingPrompt` has a new `"stopped"` kind, and the stop prompt has an optional `calendar` flag. `MeetingWords` adds the optional `calendarEnded`, `autoStopped` and `autoStoppedReason`. `STOP_UNANSWERED_MS` and `CALENDAR_OVERRUN_MS` are exported.
