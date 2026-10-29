---
"@opengeni/browserd": patch
"@opengeni/browser-extension": patch
"@opengeni/runtime": patch
---

Agents can now set camera, microphone, geolocation and notifications permissions in the person's own Chrome, for the exact top-level origin (scheme, host and port) of a tab the session opened and no other session is using; the person's own tabs are refused. The first such action opens a page in the extension where the person allows it once; until then the action fails with a short message saying so. The extension records every change and lists it in its popup with Remove, Chrome shows the settings as set by an extension in its normal site settings, and setting a permission back to prompt clears it. Other permission types, and extensions without this support, fail with a clear message. The browser_act description no longer says permission actions only work in managed browsers.
