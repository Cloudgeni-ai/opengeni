---
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/contracts": minor
---

Shared keys from a vault for API-key tools. A workspace admin can connect a tool that authenticates with a header once for the workspace, with a reference to a workspace or organization vault item; Opengeni stores the reference and reads the value only when it calls the tool, for apps, syncs and agents. App connect card items for such tools carry `sharedKey` (`add` or `ask_admin`), and `siteConnectCardItemActionable` tells whether the viewer can act on one.
