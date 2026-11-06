---
"@opengeni/db": patch
---

Repeating an organization invitation accept with the same operation id now returns the stored result without granting the invitation's initial shared workspaces again, so a member an administrator removed from one of those workspaces stays removed. Only the call that performs the acceptance grants them.
