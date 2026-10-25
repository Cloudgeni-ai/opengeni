---
"@opengeni/browserd": patch
---

A CSS, test id or placeholder locator whose page navigates while it is being looked up no longer reports a valid selector as invalid; the lookup reads the new document, so a fenced action reports `document_stale` and a later batch action follows the page.
