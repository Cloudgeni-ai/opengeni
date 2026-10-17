---
"@opengeni/db": patch
"@opengeni/codemode": patch
---

Codemode calls and other reads of a turn's tool catalog no longer reload and re-verify the whole catalog every time. A catalog can be hundreds of tools and megabytes of JSON, and every Codemode call read it twice, once while holding the turn's admission lock. Verified catalogs are now kept in memory per server process, bounded by size, and each read still checks the stored row first, so access rules are unchanged.
