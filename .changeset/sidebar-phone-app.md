---
"@opengeni/contracts": minor
"@opengeni/react": patch
---

Sidebar links to archived apps are kept when the layout changes, so restoring an app brings them back, unless a change would go over a limit (`SidebarLayoutLimitError`); links to apps that no longer exist are dropped. A person's own link to an app that became someone else's Only me is dropped on their next change. `sidebarLayoutIsOlder` tells a client when an answer is older than the layout it shows, and the `my-` id prefix and placement rules are documented. The embedded Site view keeps the Site's own address as it navigates.
