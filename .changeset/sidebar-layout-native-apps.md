---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/codemode": patch
---

Customizable sidebar: a workspace default of groups, App links (optionally to an App page), https links and live lists (pinned or recent Apps) that admins set, with each person's own changes on top (add, hide, reorder, reset). New `GET`/`PATCH /v1/workspaces/:workspaceId/sidebar-layout`, `client.getSidebarLayout` and `client.updateSidebarLayout`, and the `sidebar_layout_get`/`sidebar_layout_update` agent tools. Apps opened from the sidebar are pages: they fill the main area with their address in the URL, follow Opengeni's light or dark theme, and stay open when you switch away. Apps can opt into Opengeni's look with `<link rel="stylesheet" href="/__opengeni/ui.css">` (`@opengeni/sdk/site-ui`). Older clients ignore item types they don't know.
