---
"@opengeni/browserd": patch
---

Computer use on a Mac no longer refuses with "Another user's session is on this Mac's screen" while this user's session is on screen and a second user is logged in in the background. The console check took the owner of `/dev/console` as the user on screen, but that device belongs to whoever last logged in at the console. It now reads whose session is on the console from the IORegistry's `IOConsoleUsers` (and that session's lock, with `IOConsoleLocked`), falling back to `/dev/console` only when the registry cannot be read. A switch to another user, a locked screen and the login window are refused as before.
