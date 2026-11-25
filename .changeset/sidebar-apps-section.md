---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
---

The sidebar layout's options add `appsPlacement`: apps as rows in the Sessions list (`sessions`, the default), in an Apps section of their own above Sessions (`section`), or hidden (`hidden`). `sessionsShowApps` stays and follows it (`false` is `hidden`), so saved layouts and existing callers keep working; a `tab` a preview saved reads as `section`. With `SessionShellSlots.appsPlacement` `section`, the Sessions list draws an Apps section above its own header, with the same header style, showing the first five apps and Show more for the rest; its view menu offers the choice when the surface passes `onAppsPlacementChange`. The agent page's Can use lists tools by readable name (the tool's own title, a curated GitHub name, or its code name in words); one GitHub action is one row covering Opengeni's built-in name and GitHub MCP's, so a choice there sets both.
