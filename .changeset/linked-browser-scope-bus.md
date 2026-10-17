---
"@opengeni/browserd": patch
---

A browser linked to a Linux computer session starts again on hosts with a systemd user manager. The linked browser launches with the computer session's private D-Bus and runtime directory, so its transient-scope request reached a bus with no systemd manager and Chrome exited before DevTools came up (driver_failed). The scope request now always uses the user manager's bus that the launch probe verified, and Chrome still receives the computer session's own bus.
