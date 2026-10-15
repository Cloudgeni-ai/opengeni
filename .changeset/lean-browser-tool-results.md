---
"@opengeni/codemode": patch
---

Browser observe, act, tab and attached-browser discovery results default to a lean shape: empty, zero and default fields are omitted, and tab targets carry only identity, page, selection and fences. Pass `view: "full"` (or use `observeFull()`) for the complete contract objects.
