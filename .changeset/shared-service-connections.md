---
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/contracts": minor
---

Shared keys from a vault for API-key tools. A workspace admin can connect a tool that authenticates with a header once for the workspace, with a reference to a workspace or organization vault item; Opengeni stores the reference and reads the value only when it calls the tool, for apps, syncs and agents. People keep their own Connect for such tools; when an app's shared syncs need one, the connect card adds a separate item with `sharedKey` (`add` or `ask_admin`), and `siteConnectCardItemActionable` tells whether the viewer can act on one.
