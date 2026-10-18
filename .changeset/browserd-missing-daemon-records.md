---
"@opengeni/browserd": patch
---

A live managed browser whose agent-browser socket and pid-record directory was removed (for example by a temp-directory cleanup) can be recovered again. Recovery treated the missing directory as an internal error (`ENOENT`, reported as `driver_failed`), so the browser could neither be resumed nor ended. A removed record directory now counts as holding no records, exactly like an empty one, and the proven browser is adopted and retired on its own, as it already was when its launcher had exited.
