---
"@opengeni/react": patch
"@opengeni/react-native": patch
"@opengeni/db": patch
"@opengeni/sdk": patch
"@opengeni/contracts": patch
---

A paused chat no longer says it is working. Its turn row reads "Paused" with the clock stopped where the pause began, and switches back to working on Resume; paused time is not counted as work. This covers a chat's own Pause, a parent's and the workspace's. Sidebar rows mark paused work with a pause icon instead of the spinner, including a parent whose workers are paused, through the new `treeStats.pausedWorkDescendants` count. A sub-chat's descendant counts now also respect its ancestors' pauses. `MessageTimeline` takes the live pause through its new `pause` prop (`timelineLivePause(session.effectiveControl)`).
