---
"@opengeni/browserd": patch
"@opengeni/contracts": patch
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/runtime": patch
---

A managed browser, or an attached Chrome's debugger connection, is no longer stopped as idle while the agent session that created or is using it deliberately waits (`wait_for_input`). When the agent arms a wait, through any MCP route (`ApiRouteDeps.holdBrowsersForWait`), the API tells each running browser's controller the wait's deadline (`POST /v1/browser-sessions/:id/wait-hold`, `BrowserControlClient.holdForWait`), and the idle release keeps the browser, tabs and page state, until that deadline, but never longer than `BROWSER_WAIT_HOLD_MAX_MS` (60 minutes) after the browser's last use, so repeated waits cannot keep a browser nobody uses. The normal idle time then counts from the hold's end, so the turn the wait resumes finds its browser. If the wait ends early, the API sends that end (`endsWaitUntil`) and the hold ends then; a late end never shortens a newer wait. A browser held this way at controller shutdown is handed off and kept by the successor, and a wait armed after a restart holds a handed-off browser the new controller has not adopted yet. A sandbox box holding such a browser is not released as idle under the same rule (migration `0988_browser_wait_hold`). The hold never launches, recovers or counts as a use of a browser and never starts a sandbox; a controller that predates it keeps its plain idle release. Browsers that only observed, and browsers nobody is waiting on, are released as before.
