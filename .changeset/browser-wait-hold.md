---
"@opengeni/browserd": patch
"@opengeni/contracts": patch
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/runtime": patch
---

A managed browser, or an attached Chrome's debugger connection, is no longer stopped as idle while the agent session that created or is using it is still working (a turn queued, running, recovering, waiting for capacity or waiting on a person) or deliberately waits (`wait_for_input`). When the agent uses such a browser, and when it arms a wait through any MCP route (`ApiRouteDeps.holdBrowsersForWait`), the API watches the session and tells each running browser's controller how long to keep it (`POST /v1/browser-sessions/:id/wait-hold`, `BrowserControlClient.holdForWait`): a far time while the session works, the wait's deadline while it waits. The idle release keeps the browser, tabs and page state, until then, but never longer than `BROWSER_WAIT_HOLD_MAX_MS` (60 minutes) after the browser's last use, so a long turn or repeated waits cannot keep a browser nobody uses. When the session neither works nor waits, the API sends that end (`endsWaitUntil`) and the normal idle time counts from that moment; a late end never shortens a newer hold. A browser held this way at controller shutdown is handed off and kept by the successor, and a hold sent after a restart keeps a handed-off browser the new controller has not adopted yet. A sandbox box holding such a browser is not released as idle under the same rule (migration `0988_browser_wait_hold`). The hold never launches, recovers or counts as a use of a browser and never starts a sandbox; a controller that predates it keeps its plain idle release. Browsers that only observed, and browsers no working or waiting session holds, are released as before.
