---
"@opengeni/worker-bundle": patch
"@opengeni/react": patch
---

A turn that runs without the person's GitHub authority, such as the idle compaction checkpoint after a person's turn, now leaves the personal GitHub tools out instead of failing with "Personal GitHub delegation is unavailable". A compaction checkpoint that fails for any other reason now settles as a failed compaction: the chat shows "Couldn’t compact conversation history", returns to idle instead of failed, and consumes the request so it is not claimed again. An automatic checkpoint's failure now reads "Chat history is unchanged." without asking the person to request it again.
