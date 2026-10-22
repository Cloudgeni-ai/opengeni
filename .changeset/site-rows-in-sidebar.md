---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
---

Sites with conversations are rows in the sidebar. Each Site row shows how many conversations it has and their status, sorts by latest activity with other rows and stays in its project. Its conversations are nested under it, collapsed by default, and no longer appear or disappear depending on which session is open. Session lists take a `siteConversations` option: `group` returns complete `siteGroups` for a root page, and `include` lists Site conversations as ordinary rows.
