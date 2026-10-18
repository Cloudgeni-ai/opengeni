---
"@opengeni/browserd": patch
---

A managed browser that was running during a macOS agent update is reattached afterwards instead of being lost: its daemon is identified by the path it was started from, which the update has removed. A reattach that fails, or that a controller restart cuts short, no longer leaves the browser permanently refused; once the browser is proven to be the same live process (or gone with its profile unused), the receipt it started from is reinstated so it can be continued or ended. On macOS, a browser whose version cannot be read launches with its own User-Agent, as on Linux.
