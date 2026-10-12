---
---

Canary publishing: receipt verification now waits up to 10 minutes for npm to serve each new version, and its read budget scales with the number of packages. A few versions that stay unreadable for several minutes after a successful write no longer fail a publication that actually succeeded.
