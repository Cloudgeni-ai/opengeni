---
"@opengeni/api-router": patch
"@opengeni/events": patch
"@opengeni/sdk": patch
"@opengeni/react": patch
---

Workspace control events now reach a reader only for chats that reader can see; a cursor-only frame keeps hidden events from stalling the reader. Session start notices accept machinesEnabled so viewers without machine access never request the machine list.
