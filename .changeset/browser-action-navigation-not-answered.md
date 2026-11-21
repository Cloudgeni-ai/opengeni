---
"@opengeni/browserd": patch
---

A click or other action that opens a page whose website never answers now ends within the navigation deadline: the browser stops loading that page, the tab keeps the page the action ran on, and the action says the website did not answer. Before, Chromium held every read of the tab while it waited, so the action and the next observation timed out and reported the tab as not responding.
