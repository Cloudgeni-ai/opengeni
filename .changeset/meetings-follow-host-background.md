---
"@opengeni/react": patch
---

Meetings components now take light or dark and their surfaces from the page they sit on, as the embedded chat already does. Before, a meeting page embedded in a host whose background differs from Opengeni's page grey showed grey boxes behind its sticky player and its "Ask about this meeting" bar, and its cards kept Opengeni's greys. The outermost meetings component now resolves the host theme on its root (`data-og-host-theme`), so those bars, the page background and the cards follow the host's own background in dark and light. Inside Opengeni's app, or under another embed root, nothing changes.
