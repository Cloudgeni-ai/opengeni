---
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/contracts": minor
---

Meetings no longer stay stuck. Finishing a recording that can't be paid for ends capture and fails its transcript with the reason, or, when nobody picked a model, transcribes it with one that needs no credits; a transcript that runs past its time budget (half an hour plus three times the audio, at most twelve hours) fails as `timed_out`. The meeting page names the fix for a refused transcript (transcribe with a model that needs no credits, add credits, or connect a model) and offers Transcribe again; says when this device is still uploading a meeting's audio, with Try again after a failure (`RecordingUploader.retry`, `useRecorder().retryUpload`); and no longer promises "a minute or two" for long meetings. A signed-in person's own Only me meetings now appear in the normal Meetings list of every workspace of their organization they belong to, their Personal workspace included, labelled with the workspace that stores them (`Recording.sourceWorkspace`), and open in place there for them and their agents when the request has the same access in the storing workspace; shared meetings, other people's and an app's own users' meetings stay in their workspace, and nothing crosses organizations.
