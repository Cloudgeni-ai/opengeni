---
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/react": minor
"@opengeni/sdk": minor
---

Show Pin and Archive on every sidebar row, including spawned chats and Site rows, on hover or keyboard focus with tooltips, and in the right-click and touch menus. Site rows can be pinned and archived as personal sidebar state (`updateSiteSidebarState`); archiving a Site only hides it from your own sidebar and never unpublishes it. Archive on a spawned chat archives its workstream.

Session lists for a signed-in person that include or group Site conversations (`siteConversations: "include"` or `"group"`) now leave out conversations of Sites that person archived; a Site's own conversation list is unchanged.
