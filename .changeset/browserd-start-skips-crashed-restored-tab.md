---
"@opengeni/browserd": patch
---

Starting a managed browser no longer fails when a tab reopened from a restored profile has a crashed renderer. Startup selects the first live tab, or opens a new one when none is live, and keeps the crashed tab in the tab list for the user to close.
