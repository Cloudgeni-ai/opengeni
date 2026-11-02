---
"@opengeni/contracts": patch
"@opengeni/browserd": patch
---

A browser session no longer breaks after it meets a short card security code. Known secret values from a page (such as a prefilled three-digit code) are masked wherever their characters appear, which also hit a tab's address when its port contained them (for example `47731` with the code `731`). The tab was then left with an invalid URL, and every later observation, tab list and action on that session failed with a validation error. In browser and desktop results, a text that is a whole address now keeps its scheme, host and port while its user info, path, query and fragment are still masked. Codes and card numbers stay hidden everywhere else, including where other digits touch them.
