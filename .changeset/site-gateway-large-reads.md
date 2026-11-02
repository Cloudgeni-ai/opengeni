---
"@opengeni/site-gateway": patch
---

Large Sites no longer risk Cloudflare's "Error 1102 Worker exceeded resource limits" from CPU time. The streaming rewrite handled a page in the 4 KB pieces workerd delivers a fetched body in, passing each through several streams, so a 65 MB page cost the gateway 4 to 9 seconds of its 10 second CPU limit on every cache miss. The page is now read in pieces of up to 256 KB and rewritten in a single stage, which cuts that work to a fraction of a second; pages still start as soon as their first bytes arrive.
