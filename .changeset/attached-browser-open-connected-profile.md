---
"@opengeni/runtime": patch
---

`browser_open` on the person's own Chrome without a deviceId no longer reuses a BrowserSession on a Chrome profile that has disconnected. It reused any live attached session, so with two profiles running the extension it could return a session whose profile had gone and every call on it failed with "Attached browser is disconnected", while another profile was connected. It now reuses only a session on a connected profile, otherwise opens the only connected profile or the most recently active one, and says plainly that no Chrome profile is connected when none is.
