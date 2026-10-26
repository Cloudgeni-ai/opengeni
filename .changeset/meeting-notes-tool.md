---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
---

Agents can write a meeting's notes. The new `meeting_notes_save` tool replaces a meeting's written-up notes (Markdown) as the person the session works for, so it reaches exactly the meetings they can see. It needs `sessions:create` and the revision `meeting_read` gave, so edits made in the meantime are not overwritten. `meeting_read` now also returns the meeting's notepad and its notes with their revision. In the timeline the tool shows as "Saving meeting notes", and it is part of the Meetings capability group.
