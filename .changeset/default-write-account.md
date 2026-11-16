---
"@opengeni/contracts": patch
"@opengeni/core": patch
"@opengeni/runtime": patch
---

When a chat can use several accounts of one connector or integration, the person's own account is now the default for writes. Its tools come first, every account's tools say which account is the default and why, and the agent asks only when no account is a clear default (several of the person's own, or only shared ones).
