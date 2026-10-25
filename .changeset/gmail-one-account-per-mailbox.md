---
"@opengeni/core": patch
---

A Gmail mailbox connected more than once, for example from two workspaces, now counts as one account for event sources. The ready-to-use list offers it once instead of once per connection, and stops offering it once the person receives that mailbox through any of its connections. Adding a Gmail source without naming a connection no longer asks which account to use when every connection is the same mailbox; it uses this workspace's connection when there is one.
