---
"@opengeni/react": patch
---

Keep the session-only React entry provider-free by resolving session hooks through the session context, preserving the exclusion of provider and workbench dependencies.
