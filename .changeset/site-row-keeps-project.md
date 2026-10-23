---
"@opengeni/db": patch
---

A Site stays in its chat's project when people use it. New Site conversations started from the console are now filed in the Site's project: the API's "no project" (`null`) used to skip that rule and file them in Default. And a Site keeps its row in its own project even when its conversations sit in another one.
