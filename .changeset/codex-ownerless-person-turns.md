---
"@opengeni/db": patch
---

Scheduled runs that open a new session per run work again on Codex subscriptions. Such a session has no owner, but its turn records the person it runs for, and the shared subscription core refused that combination. The turn was cancelled before its first model request and then reported as lost worker ownership. These turns now place on shared capacity only, like any ownerless turn, and never use a personal subscription.
