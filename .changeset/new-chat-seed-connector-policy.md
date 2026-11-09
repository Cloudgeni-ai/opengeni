---
"@opengeni/db": patch
---

Preserve connector exclusions when seeding the next new-chat draft after Send. Restoring a customized draft on another client now keeps following workspace integrations minus the selected exclusions, rather than silently pinning an empty connector list. Deliberately selected tool sets, including an empty set, remain unchanged.
