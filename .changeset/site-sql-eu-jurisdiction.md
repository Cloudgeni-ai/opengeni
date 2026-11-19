---
"@opengeni/site-gateway": minor
---

Store Site SQL databases in Cloudflare's EU jurisdiction. Databases created before this move to the EU on first use (or with `scripts/move-site-databases-to-eu.ts`), verified against the original before they switch; a database that cannot move keeps working from its original object, and original objects are never deleted automatically.
