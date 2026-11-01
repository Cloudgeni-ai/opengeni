---
"@opengeni/browserd": patch
---

A browser click whose press never reached the page (Chrome sent it, but something outside the page took it) now says so instead of the generic "could not be confirmed": the error names the likely causes, a browser prompt holding the tab's input such as a passkey or permission request, or a frame over the element, and that clicking again will not help while a prompt stays open. It is still reported as `outcome_unknown`.
