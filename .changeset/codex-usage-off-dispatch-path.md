---
"@opengeni/worker-bundle": patch
---

Codex model requests no longer wait for a usage-limits read before each dispatch. The extra-credit guard now refuses a request only when usage observed this turn, from the headers every Codex response carries, shows an included window fully used and not yet reset, unless credit spending is allowed. Unknown usage admits the request, and connections already known to be exhausted are still not placed.
