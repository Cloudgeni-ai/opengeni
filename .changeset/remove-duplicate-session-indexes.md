---
"@opengeni/db": patch
---

Remove two duplicate session and turn identity indexes after verifying that their original unique indexes retain the same definitions and all foreign-key dependencies. This reduces index maintenance on session writes without changing tenant constraints or query behavior.
