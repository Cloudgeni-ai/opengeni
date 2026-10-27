---
"@opengeni/runtime": patch
"@opengeni/browserd": patch
---

A browser session in the person's own Chrome that ended because that Chrome reconnected (Chrome or its extension restarted) no longer answers every later call with "Only a suspended BrowserSession can be resumed". Such a session has no saved working copy, so the tools no longer try to resume it. `browser_observe`, `browser_act` and `browser_tabs` say it ended and that `browser_open` with its ID continues, and `browser_open` with its ID continues in the same Chrome profile: it reuses the chat's live session there or opens one, and its result names the new session ID.

In the person's Chrome, the empty tab a session opened now closes as soon as the session moves to another tab, instead of staying until the session is released or ends. Tabs the session did not open, tabs showing a page and tabs another session uses are never closed.
