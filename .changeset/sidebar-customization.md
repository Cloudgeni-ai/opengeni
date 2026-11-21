---
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/db": patch
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/react-native": patch
---

The sidebar is edited in place: drag rows to reorder (or drop an app from the Sessions list), **+** on a group adds an app, and row menus rename, set an icon, set how many apps a list shows, and remove. A project app's menu has **Add to sidebar**. Apps, links and groups take an optional `icon` from a curated set of lucide names (`SIDEBAR_ITEM_ICONS`); outside links without one show the site's icon through `GET /v1/workspaces/:workspaceId/sidebar-layout/link-icon` (`client.getSidebarLinkIcon`). Layouts gain `options` (the `options` change): `sessionsShowApps`, `hiddenNavEntries` and `settingsShown`, set as the workspace default or per person; unset keeps today's behaviour. Recent apps now count edits as well as opens, and no longer come back empty: the read ran without the person's identity, so row-level security hid every open.
