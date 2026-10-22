---
"@opengeni/core": patch
---

Resolve each distinct retained model once per catalog request. Session pages with repeated Claude models no longer repeat the same scoped database read for every row; catalog contents, first-seen ordering and fresh reads on later requests are unchanged.
