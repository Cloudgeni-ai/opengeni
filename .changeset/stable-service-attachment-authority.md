---
"@opengeni/db": patch
---

Preserve shared image attachments on service-triggered turns without human authority by matching the file ACL subject scope. Keep private files and protected Drive files inaccessible without the required authority, and restore the caller's database scope after lookup.
