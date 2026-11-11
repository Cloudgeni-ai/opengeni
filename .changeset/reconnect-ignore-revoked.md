---
"@opengeni/react": patch
---

Removed personal connections no longer block connecting or reconnecting. The in-chat connect card ignores removed accounts when it looks for the personal account to reauthorize, so it no longer reports that more than one account matches, and a capability whose only personal accounts were removed offers a fresh connection instead of a reconnect to the removed account.
