---
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/contracts": minor
---

Meetings no longer stay stuck. Finishing a recording that can't be paid for ends capture and fails its transcript with the reason, or, when nobody picked a model, transcribes it with one that needs no credits; a transcript that runs past its time budget (half an hour plus three times the audio, at most twelve hours) fails as `timed_out`. The meeting page names the fix for a refused transcript (transcribe with a model that needs no credits, add credits, or connect a model) and offers Transcribe again; says when this device is still uploading a meeting's audio, with Try again after a failure (`RecordingUploader.retry`, `useRecorder().retryUpload`); and no longer promises "a minute or two" for long meetings. `GET /v1/recordings/own`, `OpenGeniRecordingsClient.listOwnRecordings` and `useOwnRecordingsElsewhere` list the person's own Only me meetings from their other workspaces, which the Meetings page shows under From other workspaces when the host passes `meetingHrefIn` and `onOpenIn`.
