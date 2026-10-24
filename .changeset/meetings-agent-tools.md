---
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/api-router": patch
"@opengeni/sdk": patch
"@opengeni/react": patch
"@opengeni/observability": patch
---

Agents can find and read recorded meetings with two new first-party tools. `meetings_search` finds the meetings the person can see by words said or in the title, a named speaker, a start-time range or a product's reference, newest first, with each meeting's speakers and the transcript lines that matched. `meeting_read` reads one meeting's details and its transcript as speaker-named, timestamped lines with names and corrections applied, in parts or for a stretch such as 12:00 to 15:00, and reads the live preview while a meeting is still being recorded. Both are searchable (deferred) tools in the knowledge group and need `sessions:read`. The recordings list in the API and SDK also gains `person`, `startedFrom` and `startedTo` filters.
