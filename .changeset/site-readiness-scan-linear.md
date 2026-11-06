---
"@opengeni/api-router": patch
---

The Site publication readiness scan now runs in time linear in the page size. It collects the variables assigned to collections in one pass and then checks call sites once, instead of rereading the page for every assignment, and identifiers start only at a token boundary, so a page with many assignments or long `$`-separated names no longer makes the scan take seconds or minutes.
