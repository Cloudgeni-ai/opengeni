---
"@opengeni/browserd": patch
"@opengeni/runtime": patch
"@opengeni/codemode": patch
---

One oversized or unparseable Chrome DevTools Protocol message no longer ends the browser connection and every tab with it. The connection's socket takes frames of any size a page can produce (Bun's global WebSocket errors the socket above 128 MiB), and a command response over the 32 MiB message bound (or not valid JSON) rejects only its own command with `CdpResponseRefusedError`, matched by its top-level id in any key order; the controller reports it as a plain `invalid_action` that says the reply was too large and what to ask for instead. An event over the bound is dropped, counted and logged as `cdp_message_dropped`, and a recording whose screencast frame was dropped restarts its screencast. Very large pages are read within bounds: a document whose whole accessibility tree is too large for one message or one observation is read again node by node within a budget of 8,000 nodes, keeping the page's structure and a window of each long list around what is on screen (widened to fill the budget), so scrolling brings other parts into the outline. Pages that fit are read whole as before. Such a snapshot carries `incomplete: { reason: "node_budget", unreadCount }`, the browser agent view gets `unreadNodeCount`, and the outline text adds one line saying it is partial and how to reach the rest.
