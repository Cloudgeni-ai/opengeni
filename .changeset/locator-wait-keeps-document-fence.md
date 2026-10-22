---
"@opengeni/browserd": patch
---

A browser action whose locator is waiting for its element no longer follows the page to a new document unless it is a later step of a batch without fenceEachAction. A fenced batch, a single action or a batch's first action now stops with document_stale before sending input when the page navigates during the wait, instead of typing into or clicking on a page the caller never observed.
