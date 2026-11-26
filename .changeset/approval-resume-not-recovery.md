---
"@opengeni/db": patch
"@opengeni/react": patch
---

A turn claimed back from an approval or question pause is marked `resumedFromPause: true` on `SessionTurnForExecution`. Its execution generation still advances, but nothing was interrupted, so the worker no longer tells the model an earlier execution stopped mid-step (which made it repeat completed reads to check state). Re-claims after a real interruption keep that note.

A Google Drive connect started from a chat's connection card now finishes in that chat when it returns: the connection is turned on and the chat's card asks to allow the personal account, as with other OAuth returns. Before, the chat ignored the Drive return.
