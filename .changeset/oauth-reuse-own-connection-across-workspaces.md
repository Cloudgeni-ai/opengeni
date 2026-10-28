---
"@opengeni/core": patch
"@opengeni/api-router": patch
---

Connecting a personal account again from another workspace reuses the account you already connected instead of adding a second connection for the same mailbox or login. Personal accounts are available in every workspace you belong to, but the duplicate check only looked at the workspace you connected from. Each reconnect from elsewhere added a copy without your saved tool approvals, and the agent could pick that copy and ask before every action again. Turning on a connector with your own account also accepts an account you connected in another of your workspaces.
