---
"@opengeni/react": patch
---

The first-party tool picker options are built on first use instead of when the module loads, so the web build's chunk evaluation check no longer fails when other changes shift which chunk owns the tool name list.
