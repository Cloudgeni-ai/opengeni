---
"@opengeni/react": patch
---

A Site opened from the Artifacts page has a Back to it at the start of the Site's toolbar, returning to the page with its tab, search, sort and scroll; the browser's and the desktop app's Back go there too. A Site shown in a session's workspace panel has one expand, "Expand Site to full window", instead of that and the panel's look-alike Maximize; the other panels keep Maximize.

- `useWorkspacePanelOwnsExpand(owns)`: a `WorkspaceDock` panel showing its own expand control hides the dock's Maximize while it is on screen (a maximized dock still shows Restore).
- `SiteView` and `ArtifactSandbox` take `toolbarStart`, a control drawn first in the Site's toolbar (and above its loading or error state).
- The dock's machine status truncates with an ellipsis instead of being cut off in a narrow panel rail.
