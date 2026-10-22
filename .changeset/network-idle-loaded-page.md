---
"@opengeni/browserd": patch
---

A network idle wait on a page that has finished loading but keeps a long poll or other request open now completes when its time runs out instead of failing, so a navigate with `waitUntil: "network_idle"` on such a page no longer reports an uncertain outcome.
