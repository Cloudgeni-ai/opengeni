---
"@opengeni/db": patch
"@opengeni/react": patch
---

A voice session's handoff now answers in the language the user spoke: the note that carries the remaining transcript to the agent asks it to reply in the transcript's language rather than the note's English. The timeline shows the handoff notice ("Voice session ended…") and the console's "Voice handoff" and "Voice request" labels through the host's messages, so they read in the reader's language.
