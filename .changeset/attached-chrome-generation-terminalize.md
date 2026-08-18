---
"@opengeni/db": patch
"@opengeni/react": patch
"@opengeni/browserd": patch
---

Terminalize attached Chrome Browser/Computer sessions when the device connection generation changes, stop Reconnect from retrying the stale placement, and physically stop ScreenCaptureKit helpers so replayd cannot accumulate.
