---
"@opengeni/runtime": patch
---

`computer_open` accepts an optional `applicationId`. When given, it launches that app in the background (or finds it if it is already running) and returns the app window's observation in the same call, with `includeScreenshot` the app window's screenshot, so a desktop task about one app no longer needs a separate launch request before its first action. A launch that cannot run is reported on the opened computer's result instead of failing the open.
