---
"@opengeni/tool-gateway": patch
---

A connected tool server whose input schema uses a regex `pattern` that is valid ECMAScript but not valid in Unicode mode (for example `\-` or `\#` outside a character class) no longer fails every turn in the workspace. Such patterns are enforced with ordinary ECMAScript semantics, and a pattern no regex syntax accepts is skipped rather than breaking the tool catalog.
