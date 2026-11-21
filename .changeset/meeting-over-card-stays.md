---
"@opengeni/desktop": patch
---

When a recorded call ends, the desktop app's "Meeting over?" card, which stays until answered, now also posts a system notification saying the recording continues. Clicking it shows the recording. The notification goes away when the card is answered or the recording stops. If nobody answers for 10 minutes while no call uses the microphone and the microphone can be watched, the recording stops by itself, and the card and a notification say "Recording stopped". Pressing OK on that card also removes its notification. If a call takes the microphone again for a few seconds while the card is up (a rejoin, not a blip), the card goes away and is shown again when that call ends. Keep recording still keeps the recording going, and recordings started without asking still stop when their call ends.

When a meeting tab keeps the microphone after the meeting, the call never seems to end. If the recording is of a meeting on the active account's calendar (calendar reminders on), the same card asks once, 5 minutes after that meeting's scheduled end. A meeting joined from its reminder counts as the recorded one even while the previous meeting still runs. This card doesn't stop the recording by itself while a call still holds the microphone, since the meeting may be running over, and it gives way to the next meeting's reminder.

API additions: `MeetingDetectionOptions` takes optional `notify` and `words`. `createMeetingDetection` posts Electron notifications through the new `postMeetingNotice`, unless it is given `notify: false`. `MeetingWords` adds the optional `calendarEnded`, `autoStopped` and `autoStoppedReason` (with `{minutes}`). `STOP_UNANSWERED_MS`, `CALENDAR_OVERRUN_MS` and `UnansweredStop` are exported, and `CalendarReminders.meetingRecorded()` is new.

`MeetingPrompt` has a new `"stopped"` kind, and the stop prompt has an optional `calendar` flag. Code that maps every kind exhaustively needs a `"stopped"` entry. A custom `MeetingPromptView` gets an empty `action` for it and should show only the dismiss button.
