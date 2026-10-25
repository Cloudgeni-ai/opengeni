---
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/sdk": minor
---

Meetings get notes. Each recording now has a `notepad` (what people jot down while it is recorded) and `notes` (the written-up summary, decisions and action items, by a person or an agent afterwards), both Markdown. `GET /v1/workspaces/:workspaceId/recordings/:recordingId/notes` reads them and `PUT …/notes/:kind` replaces one, with an optional `expectedRevision` that turns a lost update into a 409 `notes_changed`. Anyone who can see the meeting can read and save them, and they are deleted with it. Saving the notes sends the new `recording.notes.updated` webhook event, which carries the revision and the chat whose agent saved them but never the text. The SDK adds `listRecordingNotes` and `saveRecordingNote`.
