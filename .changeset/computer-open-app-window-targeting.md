---
"@opengeni/runtime": patch
"@opengeni/browserd": patch
---

`computer_open` with an `applicationId` targets the right window of an app that is already running. The launch is sent through the window the computer was last used in (else the focused window) instead of an arbitrary listed one, and when that window belongs to the app it is the window observed, rather than whichever of the app's windows the platform reports first (which can be one another agent works in). The launch receipt names the app window it observed as its target, so it no longer reads as having acted on an unrelated app's window. A desktop launch that finds no window of the app now observes nothing instead of passing the window it was sent through off as the app's.
