---
"@opengeni/browserd": patch
"@opengeni/runtime": patch
"@opengeni/codemode": patch
---

One oversized or unparseable Chrome DevTools Protocol message no longer ends the browser connection and every tab with it. A command response over the 32 MiB message bound (or not valid JSON) now rejects only its own command with `CdpResponseRefusedError`; an event over the bound is dropped, counted and logged as `cdp_message_dropped`. Very large pages are read within bounds: a document with more than 25,000 elements, or whose whole accessibility tree is too large for one message or one observation, is read node by node within a budget of 8,000 nodes, keeping the page's structure and a window of each long list around what is on screen, so scrolling brings other parts into the outline. Such a snapshot carries `incomplete: { reason: "node_budget", unreadCount }`, the browser agent view gets `unreadNodeCount`, and the outline text adds one line saying it is partial and how to reach the rest.
