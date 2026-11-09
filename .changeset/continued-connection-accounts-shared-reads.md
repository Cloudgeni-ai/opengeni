---
"@opengeni/core": patch
"@opengeni/db": patch
---

A continued turn (a goal continuation, a wake-up, a command or child result) now resolves its connector accounts inside the turn claim with far fewer database round trips. Each fact the resolution needs is read once: workspace membership, the Personal-workspace check, the person's own accounts and the logins turned on in the workspace (now in one scope), and connection metadata (now one read per origin workspace instead of one per connection). The number of scopes and round trips no longer grows with the number of connectors. The checks, transaction, session lock and resulting accounts, delegations and gaps are unchanged.
