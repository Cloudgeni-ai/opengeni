---
"@opengeni/api-router": patch
"@opengeni/db": patch
---

Agents no longer call a voice nobody has named by an English name the meeting page may not show. The meeting page words an unnamed speaker in its reader's language ("Taler 2" with a Norwegian catalog), but `meeting_read` and `meetings_search` gave the server's English default, "Speaker 2", which an agent repeated as if it were a name. They now give an unnamed voice its number or source in parentheses, such as `(speaker 2)`, `(microphone)`, `(shared audio)` or `(track 3)`, in the speaker list, the transcript lines and search matches, and add one `unnamedSpeakers` note to a response that has any: the page shows these in its reader's language, so the agent words them in the language it writes in. Named speakers read exactly as before. `getRecordingSearchDetails` matches also carry the segment's `speakerLabel`.
