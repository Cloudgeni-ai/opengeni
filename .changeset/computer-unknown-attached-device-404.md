---
"@opengeni/api-router": patch
---

Opening a computer with an attached-device placement whose ID is not an attached device now returns a 404 that points to the connected-machine placement, instead of an unclassified 500. The computer route now handles the "attached browser not found" error the way the browser route already did.
