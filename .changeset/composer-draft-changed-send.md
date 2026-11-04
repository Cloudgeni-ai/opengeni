---
"@opengeni/react": patch
---

Send no longer fails with "The message draft could not be saved before delivery" when the chat's draft changed under it. When the draft save before a Send is refused as "draft changed", the composer re-reads the draft: if it already holds the same text the message is sent, otherwise the person's text is saved at the current revision and sent, once. A tab that fell behind its own writes (a save whose reply was lost, or one that landed after the composer remounted) now catches up silently instead of showing "This draft changed in another tab". A real edit from another tab while typing still offers Keep mine / Use other draft, without the extra "Refresh and try again" line; Keep mine now saves over the other edit even if it changes again meanwhile.
