---
"@opengeni/browserd": patch
---

A browser session in the user's own Chrome now recovers by itself when its event stream from the extension breaks, for example when a burst of page activity overflows the extension's event history, a poll times out or the local bridge connection drops. Before, every later call in that session failed as temporarily unavailable until a new session was opened. The stream is re-established and its tabs re-attach with fresh page state on their next use. A tab that had input in flight at that moment stays refused, as when Chrome detaches it, and a profile that reconnected to Opengeni now gets a clear, final instruction to open a new browser session.
