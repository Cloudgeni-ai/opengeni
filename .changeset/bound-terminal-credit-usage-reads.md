---
"@opengeni/db": patch
---

Keep terminal turn writes fast as billing history grows by using indexed credit and usage lookups instead of scanning unrelated billing history under runtime row-level security.
