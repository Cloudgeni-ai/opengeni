---
"@opengeni/contracts": patch
"@opengeni/core": patch
"@opengeni/runtime": patch
---

When a chat can use several accounts of one connector or integration, the person's own account is now the default for writes. When several accounts' copies of a tool match a search equally, the default's copy loads, every account's tools say which account is the default and why, and the agent asks only when no account is a clear default (several of the person's own, or only shared ones).
