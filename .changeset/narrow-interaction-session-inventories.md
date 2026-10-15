---
"@opengeni/sdk": patch
"@opengeni/db": patch
"@opengeni/runtime": patch
---

Browser and computer session list requests accept optional `associatedSessionId` and `includeTerminal` filters, applied in the database. Agent `browser_open`, `computer_open` and `interaction_discover` request only live sessions tied to their own chat instead of the whole workspace history, so opening a browser no longer slows down as a workspace accumulates sessions.
