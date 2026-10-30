---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
---

The session list can select known sessions by id: pass `sessionIds` (up to 200) to `listSessionPage` or `listSessionSummaryPage`. It narrows what the caller can already see and never widens it; search and the other filters still apply. Summary rows now also include `activeTurnId` and `latestTurn` (id, status, start and finish time), so a host can show a chat's state without reading its events.
