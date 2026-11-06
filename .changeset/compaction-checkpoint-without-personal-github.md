---
"@opengeni/worker-bundle": patch
"@opengeni/react": patch
---

A turn that runs without the person's GitHub authority, such as the idle compaction checkpoint after a person's turn, now leaves the personal GitHub tools out instead of failing with "Personal GitHub delegation is unavailable". Other turns that leave them out log a warning, and a malformed or ambiguous delegation still fails. A compaction checkpoint whose turn would otherwise end in the generic failed state now settles as a failed compaction: the chat shows "Couldn’t compact conversation history", returns to idle instead of failed, and consumes the request so it is not claimed again. An automatic compaction's failure (labelled Auto) now reads "Chat history is unchanged." without asking the person to request it again.
