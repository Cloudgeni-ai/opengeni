---
"@opengeni/react": patch
"@opengeni/react-native": patch
---

Meetings say less, more plainly. Explanations of how things work inside (versions, model words, where audio is kept, "pieces of audio") are gone; each state says the one thing that matters and what to do. While recording in the desktop app the panel just says what it records, and an unnamed meeting started on the web is named after when it starts ("Meeting, Oct 26, 12:15") instead of getting the server's "Recording 2026-10-26 11:15 UTC".

Form dialogs, confirm dialogs and detail sheets read their default Cancel, Close, Loading and Working… text from the host's messages (`formDialog.*`), so a translated product no longer shows them in English.
