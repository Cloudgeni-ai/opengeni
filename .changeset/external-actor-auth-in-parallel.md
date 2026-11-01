---
"@opengeni/core": patch
"@opengeni/db": patch
---

Requests that an organization key makes for its external users no longer authenticate one at a time. Authentication held an organization-wide lock exclusively, so a page that loads many chats in parallel waited for each request in turn (dozens of reads could take over ten seconds). A known user is now read under that lock held shared, which still waits for membership changes and revocations; only a user's first request provisions it under the exclusive lock.
