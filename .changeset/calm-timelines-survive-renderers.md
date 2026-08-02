---
"@opengeni/react": patch
---

Keep a malformed or unavailable timeline renderer from crashing the entire conversation by isolating each timeline group behind a visible fallback, then retry the row when its renderer inputs change.