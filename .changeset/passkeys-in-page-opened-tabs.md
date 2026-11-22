---
"@opengeni/browserd": patch
---

A tab a page opens itself (a link to a new tab, `window.open`) now gets the managed browser's passkey authenticator and passkey autofill withdrawal, like every other tab. Such a tab waits for its debugger and answers page commands only once it runs, but the controller waited for those answers before letting it run: they timed out after five seconds and the tab was left with no authenticator. A passkey request there then showed the browser's own passkey dialog, which holds the tab's input and cannot be reached through page actions. The controller now sends the page commands before the tab runs and checks their answers afterwards, and removes the authenticator again from a tab that could not take the withdrawal.
