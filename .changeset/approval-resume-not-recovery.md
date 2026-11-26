---
"@opengeni/db": patch
---

A turn claimed back from an approval or question pause is marked `resumedFromPause: true` on `SessionTurnForExecution`. Its execution generation still advances, but nothing was interrupted, so the worker no longer tells the model an earlier execution stopped mid-step (which made it repeat completed reads to check state). Re-claims after a real interruption keep that note.
