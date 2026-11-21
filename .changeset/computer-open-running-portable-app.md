---
"@opengeni/browserd": patch
"@opengeni/runtime": patch
---

`computer_open` with `applicationId` now works for a macOS app run from a folder macOS doesn't know, such as a downloaded app opened in place.

- When macOS can't find such an app to launch, the launch fails definitely instead of reporting an unknown outcome, since nothing ran.
- If the app is already running, the open then observes its listed window.
- When no window of the named app was observed, the screenshot shows only a screen, never another app's window. When there is no screen, it says why no screenshot was taken.
