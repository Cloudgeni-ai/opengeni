---
"@opengeni/browserd": patch
---

An element reference still acts on its element after the page redraws it in the same document (an inbox or list re-rendering its rows), when exactly one element with the same role, name and frame existed when the reference was read and exists now, and no input was sent in between. Repeated or renamed elements, and pages that changed after the caller's own input, still report the reference as stale.
