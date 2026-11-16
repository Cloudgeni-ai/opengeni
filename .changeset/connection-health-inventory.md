---
"@opengeni/react": patch
---

Connection health now reads the same account inventory the tool runtime resolves: shared accounts here plus your own accounts from every workspace, each saying whether it is turned on here. A personal account connected in another workspace and turned on with "Use it here" reads Connected everywhere. "Needs attention" names its reason (signed out, connection failed, account removed, no account connected, off in this workspace), and the list row and the connector's page offer the same one repair (Reconnect, Connect, or Turn on here). A failed inventory read still leaves health unverified.
