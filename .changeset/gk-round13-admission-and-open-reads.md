---
"@opengeni/db": patch
"@opengeni/react": patch
---

Admitting a scheduled agent run reads only the target chat's recent turns. Since the effective-settings check (1567) it walked every turn start after the settings boundary and probed each one through all of the chat's turns: 10M buffers and 3.5 s per admission on a chat that runs every 10 minutes. It now walks the latest starts first, as the app's own check does, with the same answer.

Settling a lost or ended sandbox finds the sessions to lock through the request's attempt or its process owner as two exact lookups, instead of one join on either that read every attempt of the workspace through its row policies (184k buffers per call). A partial index serves a lease's open requests.

Opening a chat reads its lineage and the inbox once: the session rail and the mobile header take the chat page's lineage read from moments ago, and marking the chat's replies read on opening uses the rail's inbox list from moments ago. Refreshes, polls and leaving the chat still read anew.
