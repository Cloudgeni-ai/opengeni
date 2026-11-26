---
"@opengeni/react": patch
"opengeni-web": patch
---

Opening a chat reads its side panel once: the panel no longer remounts when the history arrives, older history no longer re-reads links and artifacts, the workspace's last machine event no longer re-reads the sandbox status, and the stream's first connect no longer re-reads the usage limit.
