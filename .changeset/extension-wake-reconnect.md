---
"@opengeni/browser-extension": patch
"@opengeni/interaction": patch
"@opengeni/browserd": patch
---

The browser extension now reconnects to the local agent after Chrome stops and later restarts its service worker. A periodic wake-up alarm (new `alarms` permission) reopens the native connection when it is down, so an attached Chrome no longer stays disconnected until a tab event happens. Browser and computer controllers also log the class, frame and redacted message of any dispatch error the driver did not classify, so `controller_lost` failures leave a cause in the agent log.
