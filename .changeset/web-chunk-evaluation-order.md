---
---

Fix the Artifacts list (the chat side panel and the Artifacts page) replacing the page with an error a few seconds after it opens when documents are listed. Split web chunks that import each other could run in either order, so a module-level icon table could capture an icon before its chunk had run. Icon lookups now happen at render, and the web build fails when one chunk reads another chunk's values while they may still be loading.
