---
"@opengeni/agent-host": minor
"@opengeni/desktop": patch
---

Turning on computer use in a workspace that uses a connection made in another workspace now reconnects it when the server stopped accepting its sign-in, as it already did for a connection made in the same workspace. The computer is connected again where it was made, since the server keeps one live connection of a personal computer, and every workspace that used it keeps using it. If the person can no longer set computers up there, it is set up in this workspace instead. The menu bar now says the computer needs reconnecting, with **Reconnect This Computer…**, instead of "connecting…" forever. `ThisComputer.summary()` gains `needsReconnect`.
