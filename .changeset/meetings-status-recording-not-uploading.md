---
"@opengeni/react": patch
"@opengeni/react-native": patch
---

Meetings no longer say "Uploading" while a meeting is recorded or after Stop. Audio uploads while it records, so a meeting's page opened from Take notes now shows the recording's clock with Pause and Stop, and after Stop it reads Transcribing on the page and in the list. A meeting still being recorded elsewhere reads In progress; only a lost connection or a refused upload is called out. Adds `meetingHereStatus` to `@opengeni/react/recordings`; the list label for a recording in progress uses the new `meetings.recordings.inProgress` key instead of `meetings.recordings.uploading`, and the meeting page's unused `meetings.detailPage.uploading*` and `stillUploading` keys are removed.
