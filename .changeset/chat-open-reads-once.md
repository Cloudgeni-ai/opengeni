---
"@opengeni/react": patch
---

Opening a chat reads its side panel once: the panel no longer remounts when the history arrives, older history no longer re-reads links and artifacts, the workspace's last machine event no longer re-reads the sandbox status, and the stream's first connect no longer re-reads the usage limit.

The app's first load reads each startup resource once: the rail, home page, composer and credit notices share one read of the inbox, channels, billing summary, capability catalog and connection accounts, and the first API contract check uses the startup config read. Refreshes, polls and changes still read anew.
