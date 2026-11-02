---
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/react": patch
"@opengeni/react-native": patch
---

Transcribing a meeting again also writes its notes again when nobody has touched them. Before, the built-in summary only ever wrote a meeting's first notes, so after a re-run the notes still described the transcript the re-run replaced, for example claiming one speaker after the new transcript found two. Now a re-run starts the built-in summary when the notes were last saved by an earlier summary chat of the same meeting in which every turn was the service's; `meetingSummaryCandidate` returns their revision as `replacesRevision`, and `meetingSummaryPrompt` takes it, telling the chat to save over exactly that revision and to keep anyone else's notes. Notes a person edited, an automation wrote, or someone talked to the notes chat about are never replaced. A first summary's message is unchanged. The Transcribe again description says so, under new message keys (`meetings.detailPage.makesANewTranscriptNotesToo`, `native.meetings.meetingView.aNewTranscriptAndNotesToo`) so hosts translate it again.
