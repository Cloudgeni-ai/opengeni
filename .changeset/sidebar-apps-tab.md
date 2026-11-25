---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
---

The sidebar layout's options add `appsPlacement`: apps as rows in the Sessions list (`sessions`, the default), in an Apps tab beside Sessions (`tab`), or hidden (`hidden`). `sessionsShowApps` stays and follows it (`false` is `hidden`), so saved layouts and existing callers keep working. The Sessions list shows Sessions and Apps tabs when `SessionShellSlots.appsPlacement` is `tab`, each keeping its own scroll position, and its view menu offers the choice when the surface passes `onAppsPlacementChange`.
