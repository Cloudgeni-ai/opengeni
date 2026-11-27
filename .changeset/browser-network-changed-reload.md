---
"@opengeni/browserd": patch
---

A navigation that the browser cancels because the machine's network changed (`net::ERR_NETWORK_CHANGED`) now loads once more, as the browser's own error page would, instead of leaving the tab on the error page with an unknown outcome. On Linux, Chromium cancels loads that are still connecting whenever any interface gains or loses an address, which includes a container's bridge or veth starting or stopping on the machine. A second network change during the reload still fails the navigation as before.
