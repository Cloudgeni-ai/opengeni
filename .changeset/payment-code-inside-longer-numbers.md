---
"@opengeni/contracts": patch
"@opengeni/browserd": patch
---

A browser session no longer breaks after it meets a short card security code. Known secret values from a page (such as a prefilled three-digit code) were masked wherever their characters appeared, including inside a longer number in a tab's address (a port like `47731`), which left the tab with an invalid URL: every later observation, tab list and action on that session then failed with a validation error. A remembered number now matches only where no other digit touches it, and in browser and desktop results a text that is a whole address keeps its scheme, host and port while its user info, path, query and fragment are still masked. Standalone codes and card numbers, grouped or percent-encoded, stay hidden as before.
