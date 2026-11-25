---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
---

The sidebar layout's options add `appsPlacement`: apps as rows in the Sessions list (`sessions`, the default), in an Apps section of their own below the Sessions list (`section`), or hidden (`hidden`). `sessionsShowApps` stays and follows it (`false` is `hidden`), so saved layouts and existing callers keep working; `tab`, an earlier name of `section`, is taken in changes and read from saved layouts as `section`. With `SessionShellSlots.appsPlacement` `section`, the Sessions list draws an Apps section with its own header into the rail's slot below the list (at most 40% of the rail's height, scrolling on its own, collapsible), and its view menu offers the choice when the surface passes `onAppsPlacementChange`. The agent page's Can use lists tools by readable name (the tool's own title, a curated GitHub name, or its code name in words); one GitHub action is one row covering Opengeni's built-in name and GitHub MCP's, so a choice there sets both.
