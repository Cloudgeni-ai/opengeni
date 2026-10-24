---
"@opengeni/sdk": minor
---

Add meeting recordings: workspace webhooks gain the `recording.started`, `recording.finished`, `recording.transcript.ready`, `recording.transcript.failed`, `recording.transcript.current_changed`, `recording.speakers.updated` and `recording.deleted` event types, and workspace settings gain `recordings` (default visibility and transcription model). Recordings are captured locally, uploaded in chunks straight to storage and transcribed in the background into versioned transcripts.
