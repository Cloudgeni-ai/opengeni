---
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/db": patch
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/react-native": patch
---

The sidebar is edited in place: drag rows to reorder (or drop an app from the Sessions list), **+** on a group adds an app, and row menus rename, set an icon, set how many apps a list shows, and remove. A project app's menu has **Add to sidebar**. Apps, links and groups take an optional `icon` from a curated set of lucide names (`SIDEBAR_ITEM_ICONS`); outside links without one show the site's icon through `GET /v1/workspaces/:workspaceId/sidebar-layout/link-icon` (`client.getSidebarLinkIcon`). The phone app shows item icons and site icons, and leaves out hidden built-in entries (Automations in the side menu; Artifacts, Meetings or Inbox in the tab bar). Layouts gain `options` (the `options` change): `sessionsShowApps`, `hiddenNavEntries` and `settingsMore`, set as the workspace default or per person; unset keeps today's behaviour. While a deploy rolls out, a write from an older API replica can drop saved `options`; set them again afterwards. Recent apps now count opens and the last 90 days of edits (read through a new index on app versions by author), and no longer come back empty: the read ran without the person's identity, so row-level security hid every open.
