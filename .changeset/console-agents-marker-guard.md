---
"@opengeni/db": minor
"@opengeni/react": minor
"opengeni": minor
---

Marking or unmarking a product-managed workspace now needs an account-level context (migration 1509): Console, a workspace an organization API key creates and the Console test workspace still do it, but runtime code acting inside a workspace can't, since the mark decides organization machine and Sandbox Environment reach, organization agents and stored end-user logins. In the reach dialog, a machine's "All workspaces" and "All product-managed workspaces" options say they include the Console test workspace, where Editors run test chats. `WorkspaceReachFields` takes an optional `allDescription`.
