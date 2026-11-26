---
"@opengeni/db": patch
"@opengeni/react": minor
"opengeni-web": patch
---

Apps in the sidebar follow one rule: a pinned app sits in the person's own sidebar links, never in both places.

- With apps in a section of their own, an app row's Pin adds the app to the person's sidebar (as Customize does), and the Apps section leaves out apps that are already there. Removing the link (now "Unpin" on an app link) brings it back to the Apps section. Only that person's sidebar changes; workspace defaults and other people's sidebars stay as they were.
- An app link in the sidebar has Archive in its menu. This is the same personal archive as the app's row in the Sessions list, with Undo.
- An app a person archived from their sidebar no longer shows among their sidebar links or live lists (`readSidebarApps` leaves it out for them). The saved link stays, so restoring the app brings it back in place.

New export from `@opengeni/react`: `withoutSidebarApps(nodes, inSidebar)`. The Chrome setup card now shows the Google Chrome mark.
